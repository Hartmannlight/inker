import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, normalize, posix, resolve } from 'node:path';

export const INSTANCE_SECRET_VERSION = 1 as const;
export const INSTANCE_SECRET_KEY_BYTES = 32;
export const DEFAULT_INSTANCE_SECRET_PATH = './secrets/instance.json';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InstanceSecrets {
  version: typeof INSTANCE_SECRET_VERSION;
  keyId: string;
  encryptionKey: string;
}

export interface InitializeInstanceSecretsOptions {
  secretPath: string;
  databasePath: string;
  allowExistingDatabase?: boolean;
}

export interface InitializedInstanceSecrets {
  created: boolean;
  secrets: InstanceSecrets;
}

export class InstanceSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceSecretError';
  }
}

export function validateAdminPin(pin: string | undefined): string {
  if (!pin?.trim()) {
    throw new InstanceSecretError('ADMIN_PIN is required for startup');
  }
  if (pin === '1111') {
    throw new InstanceSecretError('ADMIN_PIN must not use a known default');
  }
  if (pin.length < 4 || pin.length > 128) {
    throw new InstanceSecretError('ADMIN_PIN must contain between 4 and 128 characters');
  }
  return pin;
}

export function resolveSqlitePath(databaseUrl: string | undefined, cwd = process.cwd()): string {
  if (!databaseUrl?.startsWith('file:')) {
    throw new InstanceSecretError('A SQLite file DATABASE_URL is required for instance setup');
  }

  const filePath = decodeURIComponent(databaseUrl.slice('file:'.length));
  if (!filePath) {
    throw new InstanceSecretError('A SQLite file DATABASE_URL is required for instance setup');
  }
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) {
    return normalize(filePath);
  }
  if (filePath.startsWith('/')) {
    return posix.normalize(filePath);
  }
  if (cwd.startsWith('/')) {
    return posix.resolve(cwd, filePath);
  }
  return isAbsolute(filePath) ? normalize(filePath) : resolve(cwd, filePath);
}

function assertRestrictedPermissions(secretPath: string): void {
  if (process.platform === 'win32') return;
  const permissions = statSync(secretPath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new InstanceSecretError(
      'Instance secret file permissions are too broad; require owner read/write only (0600)',
    );
  }
}

function parseInstanceSecrets(serialized: string): InstanceSecrets {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    throw new InstanceSecretError('The instance secret file contains invalid JSON');
  }

  if (!candidate || typeof candidate !== 'object') {
    throw new InstanceSecretError('The instance secret file contains an invalid instance secret');
  }
  const document = candidate as Partial<InstanceSecrets>;
  const decodedKey = typeof document.encryptionKey === 'string'
    ? Buffer.from(document.encryptionKey, 'base64')
    : Buffer.alloc(0);
  if (
    document.version !== INSTANCE_SECRET_VERSION
    || typeof document.keyId !== 'string'
    || !UUID_PATTERN.test(document.keyId)
    || decodedKey.length !== INSTANCE_SECRET_KEY_BYTES
    || decodedKey.toString('base64') !== document.encryptionKey
    || decodedKey.every((byte) => byte === 0)
  ) {
    throw new InstanceSecretError('The instance secret file contains an invalid instance secret');
  }

  return {
    version: INSTANCE_SECRET_VERSION,
    keyId: document.keyId,
    encryptionKey: document.encryptionKey as string,
  };
}

export function loadInstanceSecrets(secretPath: string): InstanceSecrets {
  if (!existsSync(secretPath)) {
    throw new InstanceSecretError('The instance secret file is missing');
  }
  const stats = statSync(secretPath);
  if (!stats.isFile()) {
    throw new InstanceSecretError('The instance secret path is not a regular file');
  }
  assertRestrictedPermissions(secretPath);
  return parseInstanceSecrets(readFileSync(secretPath, 'utf8'));
}

export function initializeInstanceSecrets(
  options: InitializeInstanceSecretsOptions,
): InitializedInstanceSecrets {
  if (existsSync(options.secretPath)) {
    return { created: false, secrets: loadInstanceSecrets(options.secretPath) };
  }
  if (existsSync(options.databasePath) && !options.allowExistingDatabase) {
    throw new InstanceSecretError(
      'The instance secret is missing for an existing database; restore the matching secret backup',
    );
  }

  const secretDirectory = dirname(options.secretPath);
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(secretDirectory, 0o700);

  const secrets: InstanceSecrets = {
    version: INSTANCE_SECRET_VERSION,
    keyId: randomUUID(),
    encryptionKey: randomBytes(INSTANCE_SECRET_KEY_BYTES).toString('base64'),
  };
  const temporaryPath = `${options.secretPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    // A hard-link publish is atomic and fails instead of replacing a key created
    // concurrently by another startup process on the same secret volume.
    linkSync(temporaryPath, options.secretPath);
    if (process.platform !== 'win32') chmodSync(options.secretPath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }

  return { created: true, secrets: loadInstanceSecrets(options.secretPath) };
}
