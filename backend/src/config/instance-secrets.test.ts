import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeInstanceSecrets,
  loadInstanceSecrets,
  resolveSqlitePath,
  validateAdminPin,
} from './instance-secrets';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'inker-instance-secret-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('instance secret lifecycle', () => {
  test('creates unique versioned keys with restrictive permissions for fresh installs', () => {
    const firstDirectory = temporaryDirectory();
    const secondDirectory = temporaryDirectory();
    const firstPath = join(firstDirectory, 'secrets', 'instance.json');
    const secondPath = join(secondDirectory, 'secrets', 'instance.json');

    const first = initializeInstanceSecrets({
      secretPath: firstPath,
      databasePath: join(firstDirectory, 'inker.db'),
    });
    const second = initializeInstanceSecrets({
      secretPath: secondPath,
      databasePath: join(secondDirectory, 'inker.db'),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.secrets.version).toBe(1);
    expect(first.secrets.keyId).not.toBe(second.secrets.keyId);
    expect(first.secrets.encryptionKey).not.toBe(second.secrets.encryptionKey);
    expect(Buffer.from(first.secrets.encryptionKey, 'base64')).toHaveLength(32);
    if (process.platform !== 'win32') {
      expect(statSync(firstPath).mode & 0o777).toBe(0o600);
    }
  });

  test('reuses the same key on restart without rewriting the secret file', () => {
    const directory = temporaryDirectory();
    const secretPath = join(directory, 'secrets', 'instance.json');
    const databasePath = join(directory, 'inker.db');
    const first = initializeInstanceSecrets({ secretPath, databasePath });
    const original = readFileSync(secretPath, 'utf8');
    writeFileSync(databasePath, 'existing database');

    const restarted = initializeInstanceSecrets({ secretPath, databasePath });

    expect(restarted.created).toBe(false);
    expect(restarted.secrets).toEqual(first.secrets);
    expect(readFileSync(secretPath, 'utf8')).toBe(original);
  });

  test('refuses to replace a missing secret when a database already exists', () => {
    const directory = temporaryDirectory();
    const secretPath = join(directory, 'secrets', 'instance.json');
    const databasePath = join(directory, 'inker.db');
    writeFileSync(databasePath, 'copied database');

    expect(() => initializeInstanceSecrets({ secretPath, databasePath })).toThrow(
      'instance secret is missing for an existing database',
    );
    expect(existsSync(secretPath)).toBe(false);
  });

  test('rejects malformed, weak and overly permissive secret files', () => {
    const directory = temporaryDirectory();
    const secretPath = join(directory, 'instance.json');
    writeFileSync(secretPath, JSON.stringify({
      version: 1,
      keyId: 'known',
      encryptionKey: Buffer.alloc(32).toString('base64'),
    }));
    if (process.platform !== 'win32') chmodSync(secretPath, 0o600);

    expect(() => loadInstanceSecrets(secretPath)).toThrow('invalid instance secret');

    writeFileSync(secretPath, JSON.stringify({
      version: 1,
      keyId: '8c833a88-545f-44f3-9b11-22c27c3b78ba',
      encryptionKey: Buffer.alloc(32, 1).toString('base64'),
    }));
    if (process.platform !== 'win32') {
      chmodSync(secretPath, 0o644);
      expect(() => loadInstanceSecrets(secretPath)).toThrow('permissions');
    }
  });

  test('requires a non-default explicit admin pin', () => {
    expect(() => validateAdminPin(undefined)).toThrow('ADMIN_PIN is required');
    expect(() => validateAdminPin('1111')).toThrow('ADMIN_PIN must not use a known default');
    expect(() => validateAdminPin('')).toThrow('ADMIN_PIN is required');
    expect(() => validateAdminPin('   ')).toThrow('ADMIN_PIN is required');
    expect(() => validateAdminPin('123')).toThrow('ADMIN_PIN must contain between 4 and 128 characters');
    expect(validateAdminPin('a safer admin passphrase')).toBe('a safer admin passphrase');
  });

  test('resolves SQLite file URLs without exposing database contents', () => {
    expect(resolveSqlitePath('file:/app/uploads/inker.db', '/app')).toBe('/app/uploads/inker.db');
    expect(resolveSqlitePath('file:./uploads/inker.db', '/app')).toBe('/app/uploads/inker.db');
    expect(() => resolveSqlitePath('postgresql://localhost/inker', '/app')).toThrow(
      'SQLite file DATABASE_URL',
    );
  });
});
