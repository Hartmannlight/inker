import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Generate a random API key
 */
export function generateApiKey(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a random token
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('base64url');
}

/** Hash a high-entropy token before persistence. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for a presented token and a stored SHA-256 hash. */
export function verifyToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
