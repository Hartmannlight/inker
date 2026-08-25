const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:pin|password|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|encryption[_-]?key)$/i;

export function redactSecretText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:admin[_-]?pin|encryption[_-]?key|secret|password|passphrase|token|credential)\s*[:=]\s*)[^\s,;]+/gi,
      `$1${REDACTED}`,
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
