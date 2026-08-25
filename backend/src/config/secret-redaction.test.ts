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
        sessionToken: 'admin-session-token',
        csrfSecret: 'server-csrf-secret',
        cookie: 'inker_admin_session=cookie-secret',
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
        sessionToken: '[REDACTED]',
        csrfSecret: '[REDACTED]',
        cookie: '[REDACTED]',
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

  test('redacts session, CSRF and Cookie header material from text errors', () => {
    const text = redactSecretText(
      'sessionToken=admin-token csrf_secret=csrf-value Cookie: inker_admin_session=cookie-value',
    );
    expect(text).not.toContain('admin-token');
    expect(text).not.toContain('csrf-value');
    expect(text).not.toContain('cookie-value');
  });
});
