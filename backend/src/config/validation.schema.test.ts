import { describe, expect, test } from 'bun:test';
import { validationSchema } from './validation.schema';

const secureEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'file:./uploads/inker.db',
  ADMIN_PIN: 'installation-specific-pin',
};

describe('startup configuration validation', () => {
  test('accepts explicit secure instance configuration', () => {
    const result = validationSchema.validate(secureEnvironment);

    expect(result.error).toBeUndefined();
    expect(result.value.INKER_INSTANCE_SECRET_PATH).toBe('./secrets/instance.json');
  });

  test('rejects missing and known default admin pins', () => {
    const missing = validationSchema.validate({
      NODE_ENV: 'test',
      DATABASE_URL: secureEnvironment.DATABASE_URL,
    });
    const knownDefault = validationSchema.validate({
      ...secureEnvironment,
      ADMIN_PIN: '1111',
    });

    expect(missing.error?.message).toContain('ADMIN_PIN is required');
    expect(knownDefault.error?.message).toContain('ADMIN_PIN must not use a known default');
  });

  test('Federation defaults to no trusted proxies and only permits bounded IP literals', () => {
    expect(validationSchema.validate(secureEnvironment).value.FEDERATION_TRUSTED_PROXIES).toBe('');
    expect(validationSchema.validate({ ...secureEnvironment, FEDERATION_TRUSTED_PROXIES: '127.0.0.1, ::1' }).error).toBeUndefined();
    for (const value of ['*', 'localhost', '127.0.0.0/8', '127.0.0.1,', Array(33).fill('127.0.0.1').join(',')])
      expect(validationSchema.validate({ ...secureEnvironment, FEDERATION_TRUSTED_PROXIES: value }).error).toBeDefined();
  });

  test('rejects the removed environment-key path instead of silently ignoring it', () => {
    const result = validationSchema.validate({
      ...secureEnvironment,
      ENCRYPTION_KEY: 'must-not-be-used',
    });

    expect(result.error?.message).toContain(
      'ENCRYPTION_KEY is no longer accepted; use the instance secret file',
    );
    expect(result.error?.message).not.toContain('must-not-be-used');
  });
});
