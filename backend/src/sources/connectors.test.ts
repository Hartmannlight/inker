import { describe, expect, spyOn, test } from 'bun:test';
import { isJsonValue, type JsonValue } from '@inker/contracts';
import {
  MAX_CONNECTOR_DATA_BYTES, MAX_CONNECTOR_DATA_DEPTH, runConnector,
  validateConnectorConfiguration, validateConnectorResult, type ConnectorType,
} from './connectors';

const context = (attempt = 1) => ({ signal: new AbortController().signal, attempt });
const validResult = () => ({ data: { value: 7 }, connectorVersion: 'builtin-fixture-v1' });

describe('built-in connector validation and copied data', () => {
  test('returns only versioned JSON data and never changes caller-owned objects', async () => {
    const input = { data: { label: 'fixture', nested: [{ value: 1 }], enabled: true, absent: null } };
    const normalized = validateConnectorConfiguration('fixture', input);
    expect(normalized).toEqual(input);
    expect(normalized.data).not.toBe(input.data);
    const result = await runConnector('fixture', input, context());
    expect(isJsonValue(result.data)).toBe(true);
    expect(result).toEqual({ data: input.data, connectorVersion: 'builtin-fixture-v1' });
    expect(result).not.toHaveProperty('sourceTimestamp');
    (result.data as typeof input.data).nested[0].value = 9;
    expect(input.data.nested[0].value).toBe(1);
    expect((normalized.data as typeof input.data).nested[0].value).toBe(1);
  });

  test('snapshots slow configuration before awaiting and cleans up its completed timer', async () => {
    const input = { data: { reading: 1 }, delayMs: 10 };
    const controller = new AbortController();
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    const remove = spyOn(controller.signal, 'removeEventListener');
    try {
      const pending = runConnector('slow', input, { signal: controller.signal, attempt: 1 });
      const handle = timer.mock.results[0].value;
      input.data.reading = 99;
      expect(await pending).toEqual({ data: { reading: 1 }, connectorVersion: 'builtin-slow-v1' });
      expect(clear).toHaveBeenCalledWith(handle);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0][0]).toBe('abort');
    } finally { timer.mockRestore(); clear.mockRestore(); remove.mockRestore(); }
  });

  test('accepts exactly 64 KiB of compact UTF-8 JSON and rejects byte/escape overflow', () => {
    const maximum = 'a'.repeat(MAX_CONNECTOR_DATA_BYTES - 2);
    expect(validateConnectorConfiguration('fixture', { data: maximum }).data).toBe(maximum);
    for (const data of ['a'.repeat(MAX_CONNECTOR_DATA_BYTES - 1), '€'.repeat(22_000), '\u0000'.repeat(11_000), Array(33_000).fill(0)]) {
      expect(() => validateConnectorConfiguration('fixture', { data })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    }
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`key-${index}`, 'v'.repeat(400)]));
    expect(() => validateConnectorConfiguration('fixture', { data: wide })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
  });

  test('permits 16 nested containers, rejects deeper or cyclic inputs, and copies shared branches', () => {
    let nested: JsonValue = 1;
    for (let index = 0; index < MAX_CONNECTOR_DATA_DEPTH; index++) nested = { child: nested };
    expect(validateConnectorConfiguration('fixture', { data: nested }).data).toEqual(nested);
    expect(() => validateConnectorConfiguration('fixture', { data: { child: nested } })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    const cycle: Record<string, unknown> = {}; cycle.child = cycle;
    expect(() => validateConnectorConfiguration('fixture', { data: cycle })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    const shared = { value: 1 };
    const copy = validateConnectorConfiguration('fixture', { data: { left: shared, right: shared } }).data as { left: JsonValue; right: JsonValue };
    expect(copy.left).toEqual(copy.right);
    expect(copy.left).not.toBe(copy.right);
  });

  test('rejects values JSON would silently omit or coerce', () => {
    class Untrusted { value = 1; }
    const arrayWithProperty = Object.assign([1], { extra: true });
    for (const data of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1,
      new Date(), new Map(), new Set(), new Untrusted(), new Number(1), new Uint8Array([1]),
      [undefined], Array(2), arrayWithProperty, { nested: undefined }, Object.assign({}, { [Symbol('x')]: 1 }),
      Object.defineProperty({}, 'hidden', { value: 1 })]) {
      expect(() => validateConnectorConfiguration('fixture', { data })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    }
    expect(validateConnectorConfiguration('fixture', { data: Object.assign(Object.create(null), { value: -0 }) }).data).toEqual({ value: 0 });
  });

  test('never executes getters, serialization hooks, inherited behavior or Proxy traps', () => {
    let invoked = 0;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => { invoked++; throw new Error('sensitive-value'); } });
    const proxy = new Proxy({}, { getPrototypeOf: () => { invoked++; throw new Error('sensitive-value'); } });
    const toJSON = { toJSON: () => { invoked++; return 'sensitive-value'; } };
    const inherited = Object.create({ inherited: 'sensitive-value' });
    for (const data of [getter, proxy, toJSON, inherited]) {
      expect(() => validateConnectorConfiguration('fixture', { data })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    }
    const configGetter = Object.defineProperty({}, 'data', { enumerable: true, get: () => { invoked++; return null; } });
    expect(() => validateConnectorConfiguration('fixture', configGetter)).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    expect(invoked).toBe(0);
  });

  test('blocks sensitive and prototype-related fields at every nesting depth', () => {
    for (const key of ['password', 'adminPIN', 'accessToken', 'provider_secret', 'api-key', 'Authorization', 'cookie',
      'credentials', 'private_key', 'encryptionKey', 'http_id', '__proto__', 'prototype', 'constructor', 'toString']) {
      const data = { rows: [Object.fromEntries([[key, 'sensitive-value']])] };
      expect(() => validateConnectorConfiguration('fixture', { data })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    }
    expect(validateConnectorConfiguration('fixture', { data: { shipping: 'allowed' } }).data).toEqual({ shipping: 'allowed' });
  });

  test('validates only the configuration fields supported by the selected connector', () => {
    const invalid: [ConnectorType, unknown][] = [
      ['fixture', null], ['fixture', {}], ['fixture', { data: 1, delayMs: 1 }],
      ['slow', { data: 1, delayMs: null }], ['slow', { data: 1, delayMs: undefined }],
      ['slow', { data: 1, delayMs: -1 }], ['slow', { data: 1, delayMs: 60_001 }],
      ['slow', { data: 1, delayMs: 0.1 }], ['slow', { data: 1, delayMs: NaN }],
      ['failure', { data: 1, failuresBeforeSuccess: -1 }], ['failure', { data: 1, failuresBeforeSuccess: 101 }],
      ['failure', { data: 1, failuresBeforeSuccess: 1.5 }], ['failure', { data: 1, failuresBeforeSuccess: '1' }],
      ['fixture', { data: 1, secret: 'sensitive-value' }], ['remote' as ConnectorType, { data: 1 }],
    ];
    for (const [type, config] of invalid) expect(() => validateConnectorConfiguration(type, config)).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    expect(validateConnectorConfiguration('slow', { data: null })).toEqual({ data: null, delayMs: 60_000 });
    expect(validateConnectorConfiguration('failure', { data: null })).toEqual({ data: null });
  });
});

describe('connector runtime failure and cancellation', () => {
  test('permanent and transient failures use the same stable non-secret error', async () => {
    for (const attempt of [1, 2, 1000]) {
      let failure: unknown;
      try { await runConnector('failure', { data: 'unreturned-data' }, { ...context(attempt), secret: 'sensitive-value' }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('SOURCE_CONNECTOR_FAILURE');
      expect((failure as Error).cause).toBeUndefined();
    }
    const config = { data: { recovered: true }, failuresBeforeSuccess: 2 };
    for (const attempt of [1, 2]) await expect(runConnector('failure', config, context(attempt))).rejects.toThrow('SOURCE_CONNECTOR_FAILURE');
    expect(await runConnector('failure', config, context(3))).toEqual({ data: { recovered: true }, connectorVersion: 'builtin-failure-v1' });
    expect((await runConnector('failure', { data: 0, failuresBeforeSuccess: 0 }, context())).data).toBe(0);
  });

  test('an already aborted signal creates no delay timer and does not expose its reason', async () => {
    const controller = new AbortController(); controller.abort(new Error('sensitive-abort-reason'));
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      await expect(runConnector('slow', { data: 1 }, { signal: controller.signal, attempt: 1 })).rejects.toThrow('SOURCE_CONNECTOR_ABORTED');
      expect(timer).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
  });

  test('a real in-flight timeout cancels the 60-second wait and removes its timer/listener', async () => {
    const controller = new AbortController();
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    const remove = spyOn(controller.signal, 'removeEventListener');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runConnector('slow', { data: 1 }, { signal: controller.signal, attempt: 1 });
      const handle = timer.mock.results[0].value;
      deadline = setTimeout(() => controller.abort('sensitive-abort-reason'), 10);
      await expect(pending).rejects.toThrow('SOURCE_CONNECTOR_ABORTED');
      expect(clear).toHaveBeenCalledWith(handle);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0][0]).toBe('abort');
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      timer.mockRestore(); clear.mockRestore(); remove.mockRestore();
    }
  });

  test('never echoes a supplied secret, including preexisting data strings, keys or numbers', async () => {
    const secret = 'synthetic-provider-value';
    expect(await runConnector('fixture', { data: { reading: 7 } }, { ...context(), secret }))
      .toEqual({ data: { reading: 7 }, connectorVersion: 'builtin-fixture-v1' });
    for (const data of [secret, { label: `prefix:${secret}` }, { [secret]: 1 }]) {
      await expect(runConnector('fixture', { data }, { ...context(), secret })).rejects.toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
    }
    await expect(runConnector('fixture', { data: 424242 }, { ...context(), secret: '424242' })).rejects.toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
    for (const attempt of [0, -1, 1.5, NaN, Infinity]) {
      await expect(runConnector('fixture', { data: 1 }, context(attempt))).rejects.toThrow('SOURCE_CONNECTOR_INVALID_CONTEXT');
    }
  });

  test('pins the secret boundary before waiting even if the caller mutates its context', async () => {
    const mutable = { ...context(), secret: 'synthetic-provider-value' as string | undefined };
    const pending = runConnector('slow', { data: { label: mutable.secret }, delayMs: 5 }, mutable);
    mutable.secret = undefined;
    await expect(pending).rejects.toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
  });
});

describe('connector result persistence boundary', () => {
  test('copies valid result data and accepts canonical source time only when supplied', () => {
    const input = { ...validResult(), sourceTimestamp: '2026-08-28T12:34:56.000Z' };
    const result = validateConnectorResult(input);
    expect(result).toEqual(input);
    expect(result.data).not.toBe(input.data);
    expect(validateConnectorResult(validResult())).not.toHaveProperty('sourceTimestamp');
  });

  test('rejects untrusted versions, fields, invalid data and malformed source timestamps', () => {
    for (const patch of [
      { connectorVersion: 'unknown' }, { connectorVersion: 'sensitive-value' }, { data: undefined },
      { data: { token: 'sensitive-value' } }, { extra: 'sensitive-value' },
      { sourceTimestamp: '2026-08-28T12:34:56' }, { sourceTimestamp: '2026-02-30T12:34:56.000Z' },
      { sourceTimestamp: 'not-a-date' }, { sourceTimestamp: undefined },
    ]) expect(() => validateConnectorResult({ ...validResult(), ...patch })).toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
    expect(() => validateConnectorResult({ ...validResult(), data: 'a'.repeat(MAX_CONNECTOR_DATA_BYTES) })).toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
    expect(() => validateConnectorResult({ ...validResult(), sourceTimestamp: '2026-08-28T12:34:56.000Z' }, '12:34:56')).toThrow('SOURCE_CONNECTOR_INVALID_RESULT');
  });
});
