import { describe, expect, test } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstanceSecrets } from '../../config/instance-secrets';
import { EncryptionService } from './encryption.service';

function createService(): { service: EncryptionService; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'inker-encryption-service-'));
  const secretPath = join(directory, 'secrets', 'instance.json');
  initializeInstanceSecrets({ secretPath, databasePath: join(directory, 'inker.db') });
  const config = new ConfigService({ encryption: { secretPath } });
  return { service: new EncryptionService(config), directory };
}

describe('EncryptionService instance key handling', () => {
  test('writes key version and id and decrypts the resulting ciphertext', () => {
    const { service, directory } = createService();
    try {
      const ciphertext = service.encrypt('provider-secret');

      expect(ciphertext).toMatch(/^v1:[0-9a-f-]{36}:/);
      expect(ciphertext).not.toContain('provider-secret');
      expect(service.decrypt(ciphertext)).toBe('provider-secret');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not decrypt a copied ciphertext with another installation key', () => {
    const first = createService();
    const second = createService();
    try {
      const ciphertext = first.service.encrypt('database-only-is-insufficient');

      expect(() => second.service.decrypt(ciphertext)).toThrow('encryption key is unavailable');
    } finally {
      rmSync(first.directory, { recursive: true, force: true });
      rmSync(second.directory, { recursive: true, force: true });
    }
  });

  test('rejects unknown key versions without leaking ciphertext', () => {
    const { service, directory } = createService();
    try {
      expect(() => service.decrypt('v9:sensitive-key-id:data')).toThrow('unsupported encrypted value');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps reading legacy ciphertext whose IV happens to start with v', () => {
    const { service, directory } = createService();
    try {
      const key = (service as unknown as { key: Buffer }).key;
      const iv = Buffer.alloc(16);
      iv[0] = 188;
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update('legacy-provider-secret', 'utf8'), cipher.final()]);
      const legacy = [
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        encrypted.toString('base64'),
      ].join(':');

      expect(legacy.startsWith('v')).toBe(true);
      expect(service.decrypt(legacy)).toBe('legacy-provider-secret');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
