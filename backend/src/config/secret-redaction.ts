const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = '(?:pin|password|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|encryption[_-]?key|http_id)';
const SENSITIVE_KEY = new RegExp(`${SENSITIVE_KEY_PATTERN}$`, 'i');
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

export function redactLogValue(value: unknown, key?: string): unknown {
  if (key && key.toLowerCase() !== 'keyid' && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry));
  if (value && typeof value === 'object') {
    const redacted: Record<PropertyKey, unknown> = {};
    for (const ownKey of Reflect.ownKeys(value)) {
      const property = (value as Record<PropertyKey, unknown>)[ownKey];
      redacted[ownKey] = typeof ownKey === 'string'
        ? redactLogValue(property, ownKey)
        : property;
    }
    return redacted;
  }
  return value;
}
