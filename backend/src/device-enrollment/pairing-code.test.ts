import { describe, expect, it } from 'bun:test';
import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_ENTROPY_BITS,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from './pairing-code';

describe('pairing codes', () => {
  it('generates ten independent Crockford Base32 symbols (50 bits)', () => {
    const bytes = Buffer.from([0, 1, 31, 32, 33, 63, 64, 65, 95, 255]);
    const code = generatePairingCode((length) => {
      expect(length).toBe(10);
      return bytes;
    });

    expect(code).toBe('01Z01Z01ZZ');
    expect(code).toHaveLength(10);
    expect(PAIRING_CODE_ENTROPY_BITS).toBe(50);
    expect([...code].every((character) => CROCKFORD_ALPHABET.includes(character))).toBe(true);
  });

  it('uses cryptographic randomness and produces collision-free samples', () => {
    const codes = new Set(Array.from({ length: 10_000 }, () => generatePairingCode()));

    expect(codes.size).toBe(10_000);
    expect([...codes].every((code) => /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code))).toBe(true);
  });

  it('normalizes case, separators and Crockford aliases', () => {
    expect(normalizePairingCode(' 7k4m-9q2d-xp ')).toBe('7K4M9Q2DXP');
    expect(normalizePairingCode('o1il-2345-67')).toBe('0111234567');
    expect(formatPairingCode('7K4M9Q2DXP')).toBe('7K4M-9Q2D-XP');
  });

  it('rejects malformed codes instead of silently dropping punctuation', () => {
    expect(normalizePairingCode('7K4M_9Q2D_XP')).toBeNull();
    expect(normalizePairingCode('7K4M-9Q2D')).toBeNull();
    expect(normalizePairingCode('7K4M-9Q2D-XP!')).toBeNull();
  });
});
