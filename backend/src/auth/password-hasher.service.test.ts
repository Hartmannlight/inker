import { describe, expect, test } from 'bun:test';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  const service = new PasswordHasherService();

  test('stores only a versioned adaptive scrypt hash with explicit parameters', async () => {
    const hash = await service.hash('correct horse battery staple');

    expect(hash).toMatch(
      /^scrypt\$v=1\$N=32768,r=8,p=2,keylen=32\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/,
    );
    expect(hash).not.toContain('correct horse battery staple');
  });

  test('accepts the correct password and rejects a different one', async () => {
    const hash = await service.hash('installation-specific password');

    expect(await service.verify('installation-specific password', hash)).toBe(true);
    expect(await service.verify('different password', hash)).toBe(false);
  });

  test('rejects malformed and unsupported hashes without exposing details', async () => {
    expect(await service.verify('password', 'not-a-password-hash')).toBe(false);
    expect(await service.verify('password', 'scrypt$v=99$N=1,r=1,p=1,keylen=1$x$y')).toBe(false);
  });
});
