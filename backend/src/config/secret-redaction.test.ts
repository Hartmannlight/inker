import { describe, expect, test } from 'bun:test';
import { redactLogValue, redactSecretText } from './secret-redaction';

describe('secret redaction', () => {
  test('redacts sensitive structured fields at any nesting depth', () => {
    const redacted = redactLogValue({
      message: 'startup failed',
      adminPin: '4321',
      nested: {
        encryption_key: 'base64-secret',
        credential: 'device-credential',
        refreshToken: 'oauth-refresh-token',
        apiKey: 'provider-api-key',
        clientSecret: 'oauth-client-secret',
        keyId: 'safe-rotation-id',
      },
    });

    expect(redacted).toEqual({
      message: 'startup failed',
      adminPin: '[REDACTED]',
      nested: {
        encryption_key: '[REDACTED]',
        credential: '[REDACTED]',
        refreshToken: '[REDACTED]',
        apiKey: '[REDACTED]',
        clientSecret: '[REDACTED]',
        keyId: 'safe-rotation-id',
      },
    });
  });

  test('redacts secrets embedded in error and authorization text', () => {
    const text = redactSecretText(
      'ADMIN_PIN=4321 ENCRYPTION_KEY: base64-secret Authorization: Bearer abc.def credential=device-token',
    );

    expect(text).not.toContain('4321');
    expect(text).not.toContain('base64-secret');
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('device-token');
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
