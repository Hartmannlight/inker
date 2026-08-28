import { describe, expect, test } from 'bun:test';
import { format } from 'winston';
import { inspect } from 'node:util';
import type { JsonValue } from '@inker/contracts';
import { validateIsolatedRequest } from '../isolation/isolation-contract';
import { LOG_REDACTION_LIMITS, redactLogMetadata, redactLogValue, redactSecretText } from './secret-redaction';

describe('secret redaction', () => {
  test('redacts device header and pairing aliases while preserving public identity fields', () => {
    for (const key of ['X-Device-Key', 'x_device_key', 'http-id', 'pairingCode', 'enrollment_code', 'oneTimeCode', 'short-code']) {
      expect(redactLogValue({ [key]: 'synthetic-alias-secret' })).toEqual({ [key]: '[REDACTED]' });
      expect(redactSecretText(`${key}=synthetic-alias-secret`).includes('synthetic-alias-secret')).toBe(false);
    }
    expect(redactLogValue({ credentialId: 'public-id', keyId: 'public-key', code: 'domain-data' }))
      .toEqual({ credentialId: 'public-id', keyId: 'public-key', code: 'domain-data' });
  });

  test('strict logger metadata masks raw headers, provider data and unclassified codes without reading children', () => {
    let calls = 0;
    const input = new Proxy({}, { get() { calls++; throw new Error('not called'); }, ownKeys() { calls++; throw new Error('not called'); } });
    for (const key of ['headers', 'rawHeaders', 'body', 'request', 'response', 'config', 'configuration', 'settings', 'data', 'payload', 'secretReferences', 'ciphertext', 'error', 'exception', 'code']) {
      expect(redactLogMetadata({ [key]: input })).toEqual({ [key]: '[REDACTED]' });
    }
    expect(calls).toBe(0);
  });

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

  test('redacts standalone Federation share credentials in paths and prose', () => {
    const token = `sp_share_${'a'.repeat(64)}`;
    expect(redactSecretText(`/api/federation/${token}/feed failed ${token}`))
      .toBe('/api/federation/[REDACTED]/feed failed [REDACTED]');
    expect(redactLogValue({ message: token, credentialId: 'public-identity' }))
      .toEqual({ message: '[REDACTED]', credentialId: 'public-identity' });
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

describe('bounded detached log projection', () => {
  const hidden = '[REDACTED]';
  const level = Symbol.for('level');
  const message = Symbol.for('message');
  const splat = Symbol.for('splat');

  test('never invokes ordinary or array getters, including hidden and sensitive fields', () => {
    let calls = 0;
    const getter = () => { calls++; throw new Error('synthetic-getter-secret'); };
    const input = Object.defineProperties({ safe: 'ready' }, {
      value: { get: getter, enumerable: true },
      password: { get: getter, enumerable: true },
      hidden: { get: getter },
    });
    const array = Object.defineProperty(['initial'], '0', { get: getter });
    expect(redactLogValue(input)).toEqual({ safe: 'ready', value: hidden, password: hidden, hidden });
    expect(redactLogValue(array)).toEqual([hidden]);
    expect(calls).toBe(0);
  });

  test('rejects live, nested and revoked proxies before any trap', () => {
    let calls = 0;
    const trap = () => { calls++; throw new Error('synthetic-proxy-secret'); };
    const handler = { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap };
    for (const target of [{}, [], new Error('synthetic-error')]) {
      const proxy = new Proxy(target, handler);
      expect(redactLogValue(proxy)).toBe(hidden);
      expect(redactLogValue({ nested: proxy })).toEqual({ nested: hidden });
      const revoked = Proxy.revocable(target, handler);
      revoked.revoke();
      expect(redactLogValue(revoked.proxy)).toBe(hidden);
    }
    expect(calls).toBe(0);
  });

  test('breaks cycles and detaches repeated references without mutating caller data', () => {
    const child = { status: 'ready', token: 'synthetic-token' };
    const input: Record<string, unknown> = { a: child, b: child };
    input.self = input;
    const output = redactLogValue(input) as Record<string, any>;
    expect(output).toEqual({ a: { status: 'ready', token: hidden }, b: { status: 'ready', token: hidden }, self: hidden });
    expect(output.a).not.toBe(output.b);
    output.a.status = 'changed';
    expect(output.b.status).toBe('ready');
    expect(child).toEqual({ status: 'ready', token: 'synthetic-token' });
    expect(input.self).toBe(input);
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  test('drops serialization, coercion and inspection hooks and unknown symbols', () => {
    let calls = 0;
    const hook = () => { calls++; throw new Error('synthetic-hook-secret'); };
    const input = { safe: 'ready', toJSON: hook, toString: hook, valueOf: hook,
      [Symbol.toPrimitive]: hook, [inspect.custom]: hook, [Symbol('synthetic-symbol-secret')]: 'synthetic-value' };
    const output = redactLogValue(input);
    expect(output).toEqual({ safe: 'ready' });
    expect(JSON.stringify(output)).toBe('{"safe":"ready"}');
    expect(String(output)).toBe('[object Object]');
    expect(inspect(output)).not.toContain('synthetic');
    expect(calls).toBe(0);
  });

  test('native errors preserve data diagnostics without reading lazy stack hooks', () => {
    let calls = 0;
    const input = new Error('api_key=synthetic-error-key');
    Object.defineProperty(input, 'stack', { get: () => { calls++; throw new Error('synthetic-stack'); } });
    Object.defineProperty(input, 'code', { value: 'SOURCE_TIMEOUT' });
    Object.defineProperty(input, 'cause', { value: input });
    const output = redactLogValue(input) as Record<string, unknown>;
    expect(output.message).toBe('api_key=[REDACTED]');
    expect(output.stack).toBe(hidden);
    expect(output.code).toBe('SOURCE_TIMEOUT');
    expect(output.cause).toBe(hidden);
    expect(JSON.stringify(output)).not.toContain('synthetic');
    expect(calls).toBe(0);
  });

  test('rejects exotic prototypes and non-JSON values without executing conversion', () => {
    let calls = 0;
    const custom = Object.create({ toJSON() { calls++; return 'synthetic-secret'; } });
    for (const input of [custom, new Date(), new Map(), new Set(), new WeakMap(), /secret/,
      new URL('https://example.invalid'), Buffer.from('synthetic-secret'), Promise.resolve('secret'),
      () => { calls++; }, 1n, Symbol('synthetic-secret'), NaN, Infinity, -Infinity]) {
      expect(redactLogValue(input)).toBe(hidden);
    }
    expect(calls).toBe(0);
    expect(redactLogValue({ zero: -0, yes: true, no: false, nil: null })).toEqual({ zero: 0, yes: true, no: false, nil: null });
  });

  test('does not create prototype setters and redacts credentials embedded in property names', () => {
    const token = `sp_share_${'b'.repeat(64)}`;
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"safe":1}');
    input[token] = 'status';
    const output = redactLogValue(input) as Record<string, unknown>;
    expect(output).toEqual({ safe: 1, '[REDACTED]': 'status' });
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(JSON.stringify(output)).not.toContain(token);
  });

  test('bounds nesting, array length and per-object keys before traversing children', () => {
    let nested: unknown = { token: 'synthetic-deep-secret' };
    for (let index = 0; index < LOG_REDACTION_LIMITS.depth + 5; index++) nested = { nested };
    const output = redactLogValue(nested);
    expect(JSON.stringify(output)).not.toContain('synthetic');
    expect(JSON.stringify(output)).toContain(hidden);
    const hugeArray = new Array(LOG_REDACTION_LIMITS.arrayItems + 1);
    Object.defineProperty(hugeArray, '0', { get: () => { throw new Error('must not run'); } });
    expect(redactLogValue(hugeArray)).toBe(hidden);
    const manyKeys = Object.fromEntries(Array.from({ length: LOG_REDACTION_LIMITS.keys + 1 }, (_, index) => [`k${index}`, 0]));
    expect(redactLogValue(manyKeys)).toBe(hidden);
  });

  test('bounds total nodes, UTF-8 text, key bytes and complete serialized output', () => {
    expect(redactLogValue(Array.from({ length: 4 }, () => Array(8192).fill(0)))).toBe(hidden);
    // Holes/accessors produce a marker node too; they cannot bypass the global budget.
    expect(redactLogValue([Array(32_765).fill(0), new Array(1000)])).toBe(hidden);
    expect(redactLogValue('a'.repeat(LOG_REDACTION_LIMITS.textBytes + 1))).toBe(hidden);
    expect(redactLogValue('😀'.repeat(LOG_REDACTION_LIMITS.textBytes / 4 + 1))).toBe(hidden);
    expect(redactLogValue({ ['a'.repeat(LOG_REDACTION_LIMITS.keyBytes + 1)]: 'safe' })).toBe(hidden);
    expect(redactLogValue({ ['😀'.repeat(LOG_REDACTION_LIMITS.keyBytes / 4 + 1)]: 'safe' })).toBe(hidden);
    expect(redactLogValue(['a'.repeat(100_000), 'b'.repeat(100_000), 'c'.repeat(100_000)])).toBe(hidden);
    expect(redactLogValue('\u0000'.repeat(100_000))).toBe(hidden);
  });

  test('keeps maximum valid guest JSON and plain splat data intact', () => {
    const fixtures: JsonValue[] = [Array(32_767).fill(0), { label: 'a'.repeat(65_500) },
      Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`k${index}`, 0])), { splat: [1, 'public'] }];
    for (const data of fixtures) {
      expect(validateIsolatedRequest({ version: 1, kind: 'javascript', code: 'return $;', data }).data).toEqual(data);
    }
    let data: JsonValue = 'leaf';
    for (let index = 0; index < 16; index++) data = { nested: data };
    expect(validateIsolatedRequest({ version: 1, kind: 'javascript', code: 'return $;', data }).data).toEqual(data);
  });

  test('keeps Winston levels but drops cached message, splat and unknown symbols without reading them', () => {
    let calls = 0;
    const input = { level: 'info', message: 'password=%s', splat: ['synthetic-plain-splat'], [level]: 'info',
      [message]: 'synthetic-cached-message', [splat]: ['synthetic-symbol-splat'], [Symbol('unknown')]: 'synthetic-unknown' };
    Object.defineProperty(input, Symbol('getter'), { get: () => { calls++; throw new Error('secret'); } });
    const output = redactLogValue(input) as Record<PropertyKey, unknown>;
    expect(output).toEqual({ level: 'info', message: 'password=[REDACTED]', [level]: 'info' });
    expect(Reflect.ownKeys(output).filter(key => typeof key === 'symbol')).toEqual([level]);
    expect(inspect(output)).not.toContain('synthetic');
    expect(input[splat]).toEqual(['synthetic-symbol-splat']);
    expect(calls).toBe(0);
  });

  test('normalizes invalid or accessor Winston levels without retaining raw level secrets', () => {
    let calls = 0;
    const input = { level: 'synthetic-level-secret', message: 'ready', [level]: 'synthetic-level-secret' };
    expect(redactLogValue(input)).toEqual({ level: 'warn', message: 'ready', [level]: 'warn' });
    Object.defineProperty(input, level, { get: () => { calls++; throw new Error('secret'); } });
    expect(redactLogValue(input)).toEqual({ level: 'warn', message: 'ready', [level]: 'warn' });
    expect(calls).toBe(0);
    for (const safeLevel of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']) {
      expect((redactLogValue({ level: safeLevel, message: 'ready', [level]: safeLevel }) as any)[level]).toBe(safeLevel);
    }
  });

  test('real Winston JSON and simple pipelines rebuild safe messages and preserve routing', () => {
    for (const formatter of [format.json(), format.simple()]) {
      const pipeline = format.combine(format(info => redactLogValue(info) as typeof info)(), format.splat(), formatter);
      const input = { level: 'info', message: 'api_key=%s', [level]: 'info',
        [splat]: ['synthetic-interpolated-secret'], [message]: 'synthetic-cached-secret', authorization: 'synthetic-auth-secret' };
      const output = pipeline.transform(input, pipeline.options) as Record<PropertyKey, unknown>;
      expect(output[level]).toBe('info');
      expect(typeof output[message]).toBe('string');
      expect(output[message]).toContain(hidden);
      expect(output[message]).not.toContain('synthetic');
    }
  });

  test('budget exhaustion retains a bounded Winston message and never original error text', () => {
    const input = { level: 'error', message: 'synthetic-secret', [level]: 'error',
      data: ['a'.repeat(100_000), 'b'.repeat(100_000), 'c'.repeat(100_000)] };
    const output = redactLogValue(input) as Record<PropertyKey, unknown>;
    expect(output).toEqual({ level: 'error', message: hidden, [level]: 'error' });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(LOG_REDACTION_LIMITS.outputBytes);
    expect(() => format.json().transform(output as any, {})).not.toThrow();
    expect(output[message]).not.toContain('synthetic');
  });

  test('does not coerce an invalid optional key', () => {
    let calls = 0;
    const key = { toString() { calls++; return 'token'; }, toLowerCase() { calls++; return 'token'; } };
    expect(redactLogValue('synthetic-secret', key as any)).toBe(hidden);
    expect(redactLogValue('synthetic-secret', 'x'.repeat(LOG_REDACTION_LIMITS.keyBytes + 1))).toBe(hidden);
    expect(calls).toBe(0);
  });
});
