import { randomBytes } from 'crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_CODE_ENTROPY_BITS = PAIRING_CODE_LENGTH * 5;

type RandomBytes = (length: number) => Buffer;

/** Generate ten unbiased Base32 symbols from a cryptographic random source. */
export function generatePairingCode(random: RandomBytes = randomBytes): string {
  const bytes = random(PAIRING_CODE_LENGTH);
  if (bytes.length !== PAIRING_CODE_LENGTH) {
    throw new Error('Pairing-code random source returned an invalid byte count');
  }
  return [...bytes]
    .map((byte) => CROCKFORD_ALPHABET[byte & 31])
    .join('');
}

/**
 * Accept manual-entry separators, case differences, and Crockford's O/I/L
 * aliases while returning one canonical ten-character value.
 */
export function normalizePairingCode(value: string): string | null {
  const compact = value.trim().replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{10}$/.test(compact)) return null;
  const canonical = compact.replaceAll('O', '0').replace(/[IL]/g, '1');
  return [...canonical].every((character) => CROCKFORD_ALPHABET.includes(character))
    ? canonical
    : null;
}

export function formatPairingCode(canonical: string): string {
  if (!new RegExp(`^[${CROCKFORD_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`).test(canonical)) {
    throw new Error('Cannot format an invalid pairing code');
  }
  return `${canonical.slice(0, 4)}-${canonical.slice(4, 8)}-${canonical.slice(8)}`;
}
