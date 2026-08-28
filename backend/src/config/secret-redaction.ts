import { types } from 'node:util';

const REDACTED = '[REDACTED]';
/** Preserve the complete 64 KiB/16-level JSON envelope used by the guest boundary. */
export const LOG_REDACTION_LIMITS = Object.freeze({
  depth: 16, nodes: 32_769, keys: 32_768, arrayItems: 32_768,
  keyBytes: 64 * 1024, textBytes: 128 * 1024, outputBytes: 256 * 1024,
});
const WINSTON_LEVEL = Symbol.for('level');
const WINSTON_LEVELS = new Set(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly',
  'log', 'fatal', 'emerg', 'alert', 'crit', 'warning', 'notice']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toJSON', 'toString', 'valueOf']);
const SENSITIVE_KEY_PATTERN = '(?:pin|password|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|device[_-]?key|private[_-]?key|encryption[_-]?key|http[_-]?id|pairing[_-]?code|enrollment[_-]?code|one[_-]?time[_-]?code|short[_-]?code)';
const SENSITIVE_KEY = new RegExp(`${SENSITIVE_KEY_PATTERN}$`, 'i');
const OPAQUE_LOG_FIELDS = new Set(['headers', 'rawheaders', 'body', 'request', 'response', 'config', 'configuration',
  'settings', 'data', 'payload', 'secrets', 'secretreferences', 'ciphertext', 'error', 'exception']);
// Match sensitive keys directly so an enclosing non-secret JSON object cannot
// consume nested fields before the scanner reaches their sensitive assignments.
// Start only at a key boundary: retrying the greedy prefix at every character
// makes an otherwise harmless long alphanumeric value quadratic.
const TEXT_SECRET_ASSIGNMENT = new RegExp(
  `(?<![a-z0-9_-])((["']?)[a-z0-9_-]*${SENSITIVE_KEY_PATTERN}\\2\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;{}]+)`,
  'gi',
);

export function redactSecretText(text: string): string {
  return text
    // Shares have a distinct namespace, so even an accidental URL/path or
    // free-form diagnostic must not retain their bearer material.
    .replace(/sp_share_[A-Za-z0-9_-]{64}/g, REDACTED)
    // Digest and Cookie headers can contain several comma/semicolon-separated
    // values. A complete header line is sensitive, regardless of auth scheme.
    .replace(/^([ \t]*(?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*)[^\r\n]*/gim, `$1${REDACTED}`)
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(authorization\s*[:=]\s*)Digest\s+[^\r\n]*/gi, `$1${REDACTED}`)
    .replace(/(authorization\s*[:=]\s*)(?:[a-z][a-z0-9_-]*\s+)?[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(
      TEXT_SECRET_ASSIGNMENT,
      (_match, prefix: string, _keyQuote: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        return `${prefix}${quote}${REDACTED}${quote}`;
      },
    );
}

/** Bounded detached data only; never invoke accessors, proxies or conversion hooks. */
function projectLogValue(value: unknown, key?: string, logging = false): unknown {
  let bytes = 0, nodes = 0;
  let loggerLevel: string | undefined;
  const ancestors = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > LOG_REDACTION_LIMITS.outputBytes) throw new Error('LOG_REDACTION_LIMIT');
  };
  const string = (input: string): string => { add(Buffer.byteLength(JSON.stringify(input))); return input; };
  const hidden = (): string => string(REDACTED);
  const node = () => { if (++nodes > LOG_REDACTION_LIMITS.nodes) throw new Error('LOG_REDACTION_LIMIT'); };
  const hiddenLeaf = (): string => { node(); return hidden(); };
  const sensitive = (name: string) => (name.toLowerCase() !== 'keyid' && SENSITIVE_KEY.test(name))
    || (logging && (name.toLowerCase() === 'code' || OPAQUE_LOG_FIELDS.has(name.toLowerCase().replace(/[_-]/g, ''))));
  const copy = (input: unknown, depth: number, name?: string): unknown => {
    node();
    if (name !== undefined && sensitive(name)) return hidden();
    if (input === null) { add(4); return null; }
    if (typeof input === 'string') {
      if (input.length > LOG_REDACTION_LIMITS.textBytes || Buffer.byteLength(input) > LOG_REDACTION_LIMITS.textBytes) return hidden();
      return string(redactSecretText(input));
    }
    if (typeof input === 'boolean') { add(input ? 4 : 5); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { add(String(input).length); return input === 0 ? 0 : input; }
    if (typeof input === 'undefined') { add(4); return undefined; }
    // Check proxies before even Array.isArray: revoked proxies must not throw,
    // and no get/ownKeys/getPrototypeOf/descriptor trap may run in the logger.
    if (!input || typeof input !== 'object' || types.isProxy(input)) return hidden();
    if (depth >= LOG_REDACTION_LIMITS.depth || ancestors.has(input)) return hidden();
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    const nativeError = types.isNativeError(input);
    if (array ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null && !nativeError) return hidden();
    ancestors.add(input);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > LOG_REDACTION_LIMITS.arrayItems) return hidden();
        add(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          result.push(property && 'value' in property ? copy(property.value, depth + 1) : hiddenLeaf());
        }
        return result;
      }
      // Winston routing uses only LEVEL. Discard cached MESSAGE, SPLAT and
      // unknown symbols: preformatted/interpolated secrets cannot be recovered
      // safely from their field context. Subsequent formats rebuild MESSAGE.
      if (depth === 0) {
        const level = Object.getOwnPropertyDescriptor(input, WINSTON_LEVEL);
        if (level) loggerLevel = 'value' in level && typeof level.value === 'string' && WINSTON_LEVELS.has(level.value)
          ? level.value : 'warn';
      }
      const keys = Reflect.ownKeys(input);
      if (keys.length > LOG_REDACTION_LIMITS.keys) return hidden();
      const result: Record<PropertyKey, unknown> = {};
      add(2);
      for (const ownKey of keys) {
        if (typeof ownKey !== 'string' || UNSAFE_KEYS.has(ownKey) || (loggerLevel && depth === 0 && ownKey === 'splat')) continue;
        if (ownKey.length > LOG_REDACTION_LIMITS.keyBytes || Buffer.byteLength(ownKey) > LOG_REDACTION_LIMITS.keyBytes) return hidden();
        const safeKey = string(redactSecretText(ownKey));
        add(2); // Colon and a conservative comma allowance.
        // Some runtimes materialize a native Error stack while retrieving its
        // descriptor, invoking Error.prepareStackTrace. Do not request it.
        const property = nativeError && ownKey === 'stack' ? undefined : Object.getOwnPropertyDescriptor(input, ownKey);
        const copied = property && 'value' in property ? copy(property.value, depth + 1, ownKey) : hiddenLeaf();
        Object.defineProperty(result, safeKey, { value: copied, enumerable: true, writable: true, configurable: true });
      }
      if (loggerLevel && depth === 0) {
        // Normalize the printable level as well as Winston's routing symbol.
        if (!Object.prototype.hasOwnProperty.call(result, 'level')) { string('level'); add(2); }
        result.level = string(loggerLevel);
        result[WINSTON_LEVEL] = loggerLevel;
      }
      return result;
    } finally { ancestors.delete(input); }
  };
  try {
    if (key !== undefined && (typeof key !== 'string' || key.length > LOG_REDACTION_LIMITS.keyBytes)) return REDACTED;
    const result = copy(value, 0, key);
    if (loggerLevel && (result === null || typeof result !== 'object')) {
      return { level: loggerLevel, message: REDACTED, [WINSTON_LEVEL]: loggerLevel };
    }
    return result;
  } catch {
    // No arbitrary exception text or original object may escape this boundary.
    return loggerLevel ? { level: loggerLevel, message: REDACTED, [WINSTON_LEVEL]: loggerLevel } : REDACTED;
  }
}

/** Shared JSON redaction also used for guest inputs; ordinary domain code fields remain data. */
export function redactLogValue(value: unknown, key?: string): unknown {
  return projectLogValue(value, key);
}

/** Logger-only boundary: no opaque request/provider containers or unclassified codes. */
export function redactLogMetadata(value: unknown): unknown {
  return projectLogValue(value, undefined, true);
}
