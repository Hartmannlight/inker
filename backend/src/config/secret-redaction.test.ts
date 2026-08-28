import { describe, expect, test } from 'bun:test';
import { redactLogValue, redactSecretText } from './secret-redaction';

describe('secret redaction', () => {
  test('long non-secret tokens cannot cause quadratic redaction before an isolation deadline', () => {
    const token = 'a'.repeat(65_500);
    const started = performance.now();
    expect(redactSecretText(token)).toBe(token);
    expect(redactSecretText(`prefix ${token}api_key=synthetic-value`)).toBe(`prefix ${token}api_key=[REDACTED]`);
    expect(redactSecretText(JSON.stringify({ label: token, apiKey: 'synthetic-value' })))
      .toBe(JSON.stringify({ label: token, apiKey: '[REDACTED]' }));
    expect(performance.now() - started).toBeLessThan(250);
  });
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

  test('redacts API keys and credential aliases in free-form text', () => {
    for (const key of ['api_key', 'apiKey', 'X-API-Key', 'private_key', 'http_id', 'access-token']) {
      expect(redactSecretText(`request failed: ${key}=synthetic-marker`)).toBe(
        `request failed: ${key}=[REDACTED]`,
      );
    }
  });

  test('redacts quoted JSON values without losing adjacent diagnostic fields', () => {
    const document = {
      password: 'synthetic marker with spaces, a comma; and an escaped "quote"',
      nested: {
        apiKey: 'synthetic-api-key',
        authorization: 'Basic synthetic-basic-credential',
        cookie: 'session=synthetic-cookie; other=synthetic-other-cookie',
        http_id: 'synthetic-device-key',
        keyId: 'public-key-id',
        status: 'failed',
      },
    };
    expect(JSON.parse(redactSecretText(JSON.stringify(document)))).toEqual({
      password: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        http_id: '[REDACTED]',
        keyId: 'public-key-id',
        status: 'failed',
      },
    });
    expect(redactSecretText("provider failed: {'clientSecret': 'synthetic secret with spaces'}"))
      .toBe("provider failed: {'clientSecret': '[REDACTED]'}");
  });

  test('redacts complete authorization and cookie header lines including non-Bearer schemes', () => {
    const text = redactSecretText([
      'Authorization: Basic synthetic-basic-credential',
      'Proxy-Authorization: Digest username="synthetic-user", response="synthetic-response"',
      'Cookie: session=synthetic-cookie; refresh=synthetic-refresh',
      'Set-Cookie: session=synthetic-cookie; HttpOnly; Secure',
      'X-Request-ID: public-request-id',
    ].join('\r\n'));
    expect(text).not.toContain('synthetic');
    expect(text).toContain('X-Request-ID: public-request-id');
    expect(text.match(/\[REDACTED\]/g)).toHaveLength(4);
    expect(redactSecretText('request failed Authorization: Basic synthetic-credential'))
      .toBe('request failed Authorization: [REDACTED]');
    expect(redactSecretText('request failed Authorization: Digest username="synthetic-user", response="synthetic-response"'))
      .toBe('request failed Authorization: [REDACTED]');
  });

  test('redacts serialized error messages and legacy credential fields in structured logs', () => {
    expect(redactLogValue({
      message: 'provider rejected {"password":"synthetic-password","status":401}',
      http_id: 'synthetic-device-key',
      'proxy-authorization': 'Basic synthetic-proxy-key',
      keyId: 'public-key-id',
    })).toEqual({
      message: 'provider rejected {"password":"[REDACTED]","status":401}',
      http_id: '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
      keyId: 'public-key-id',
    });
  });
});
