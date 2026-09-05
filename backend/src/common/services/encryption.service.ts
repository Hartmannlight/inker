import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  DEFAULT_INSTANCE_SECRET_PATH,
  loadInstanceSecrets,
} from '../../config/instance-secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const CIPHERTEXT_VERSION = 'v1';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(private readonly config: ConfigService) {
    const secretPath = config.get<string>('encryption.secretPath', DEFAULT_INSTANCE_SECRET_PATH);
    const secrets = loadInstanceSecrets(secretPath);
    this.key = Buffer.from(secrets.encryptionKey, 'base64');
    this.keyId = secrets.keyId;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      CIPHERTEXT_VERSION,
      this.keyId,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (/^v\d+$/.test(parts[0] || '') && parts[0] !== CIPHERTEXT_VERSION) {
      throw new Error('The encrypted value uses an unsupported encrypted value version');
    }
    if (parts.length === 5 && parts[0] === CIPHERTEXT_VERSION && parts[1] !== this.keyId) {
      throw new Error('The encrypted value encryption key is unavailable');
    }

    const payload = parts.length === 5 && parts[0] === CIPHERTEXT_VERSION
      ? parts.slice(2)
      : parts;
    if (payload.length !== 3) throw new Error('Invalid encrypted value format');

    const [ivB64, authTagB64, encryptedB64] = payload;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(encryptedB64, 'base64');
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted) + decipher.final('utf8');
    } catch {
      throw new Error('Unable to decrypt encrypted value');
    }
  }

  encryptObject(obj: Record<string, unknown>): Record<string, string> {
    const encrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined && value !== null) {
        encrypted[key] = this.encrypt(String(value));
      }
    }
    return encrypted;
  }

  decryptObject(obj: Record<string, unknown>): Record<string, string> {
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      try {
        decrypted[key] = this.decrypt(String(value));
      } catch {
        this.logger.warn(`Failed to decrypt field "${key}"`);
        decrypted[key] = '';
      }
    }
    return decrypted;
  }
}
