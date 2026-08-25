import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const VERSION = 1;
const N = 32768;
const R = 8;
const P = 2;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, {
      N,
      r: R,
      p: P,
      maxmem: MAX_MEMORY,
    }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

@Injectable()
export class PasswordHasherService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(password, salt);
    return `scrypt$v=${VERSION}$N=${N},r=${R},p=${P},keylen=${KEY_LENGTH}$${encode(salt)}$${encode(derived)}`;
  }

  async verify(password: string, serialized: string): Promise<boolean> {
    try {
      const [algorithm, versionPart, parameterPart, saltPart, hashPart, extra] = serialized.split('$');
      if (extra !== undefined || algorithm !== 'scrypt' || versionPart !== `v=${VERSION}`) return false;
      if (parameterPart !== `N=${N},r=${R},p=${P},keylen=${KEY_LENGTH}`) return false;
      const salt = decode(saltPart);
      const expected = decode(hashPart);
      if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
      const actual = await derive(password, salt);
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
