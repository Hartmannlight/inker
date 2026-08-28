import { describe, it, expect } from 'bun:test';
import { ScriptExecutorService } from './script-executor.service';
import { ISOLATION_ERROR_CODES, ISOLATION_LIMITS } from '../../isolation/isolation-contract';

describe('ScriptExecutorService isolated execution', () => {
  const executor = new ScriptExecutorService();

  const values: Array<[string, unknown, unknown]> = [
    ['return 42;', {}, 42],
    ['return "hello";', {}, 'hello'],
    ['return $.price;', { price: 100 }, 100],
    ['return $.rates[0].mid;', { rates: [{ mid: 4.25 }] }, 4.25],
    ['return $.price * 1000;', { price: 3.5 }, 3500],
    ['return Math.floor($.value);', { value: 3.7 }, 3],
    ['var obj = JSON.parse(JSON.stringify($)); return obj.x;', { x: 42 }, 42],
    ['return parseInt("42") + parseFloat("0.5");', {}, 42.5],
    ['return $.name.toUpperCase();', { name: 'hello' }, 'HELLO'],
    ['return $.items.length;', { items: [1, 2, 3] }, 3],
    ['return $ === null;', null, true],
    ['return $ === null;', undefined, true],
  ];
  for (const [code, data, value] of values) {
    it(`preserves value-mode behavior: ${code}`, async () => {
      expect(await executor.execute(code, data, 'value')).toEqual({ success: true, value });
    });
  }

  it('collects declared template variables, preserving the legacy result shape', async () => {
    const result = await executor.execute(
      'var greeting = "hello"; let total = $.price * $.quantity; const done = true; var __internal = 7;',
      { price: 10, quantity: 3 }, 'template',
    );
    expect(result).toEqual({ success: true, variables: { greeting: 'hello', total: 30, done: true } });
  });

  it('returns only fixed error codes for syntax and runtime failures', async () => {
    for (const code of ['return {{{;', 'return $.foo.bar.baz;', 'throw new Error("private-code-secret");']) {
      const result = await executor.execute(code, {}, 'value');
      expect(result.success).toBe(false);
      expect(ISOLATION_ERROR_CODES.some(code => code === result.error)).toBe(true);
      expect(result.value).toBeUndefined();
      expect(result.variables).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-code-secret');
    }
  });

  it('has no process, require, network, filesystem or Bun bindings in the actual guest', async () => {
    const result = await executor.execute(
      'return [typeof process, typeof require, typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof Bun].join(",");',
      {}, 'value',
    );
    expect(result).toEqual({ success: true, value: 'undefined,undefined,undefined,undefined,undefined,undefined' });
    const escape = await executor.execute('return [].filter.constructor("return process.env")();', {}, 'value');
    expect(escape.success).toBe(false);
    expect(ISOLATION_ERROR_CODES.some(code => code === escape.error)).toBe(true);
  });

  it('does not use keyword bans as a substitute for the guest boundary', async () => {
    expect(await executor.execute('return Function("return 6 * 7")();', {}, 'value'))
      .toEqual({ success: true, value: 42 });
    expect(await executor.execute('return eval("1 + 2");', {}, 'value'))
      .toEqual({ success: true, value: 3 });
  });

  it('keeps the caller event loop available while terminating an infinite loop', async () => {
    const started = performance.now();
    const pending = executor.execute('while (true) {}', {}, 'value');
    expect(pending).toBeInstanceOf(Promise);
    expect(performance.now() - started).toBeLessThan(250);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(performance.now() - started).toBeLessThan(500);
    const result = await pending;
    expect(result).toMatchObject({ success: false, error: 'ISOLATION_TIMEOUT' });
    expect(await executor.execute('return 7;', {}, 'value')).toEqual({ success: true, value: 7 });
  }, 7000);

  it('forwards already-aborted and in-flight aborts to the process boundary', async () => {
    const already = new AbortController();
    already.abort();
    expect(await executor.execute('return 1;', {}, 'value', already.signal))
      .toMatchObject({ success: false, error: 'ISOLATION_ABORTED' });
    const active = new AbortController();
    const pending = executor.execute('while (true) {}', {}, 'value', active.signal);
    active.abort();
    expect(await pending).toMatchObject({ success: false, error: 'ISOLATION_ABORTED' });
    expect(await executor.execute('return 2;', {}, 'value')).toEqual({ success: true, value: 2 });
  }, 7000);

  it('never invokes caller getters, proxy traps or JSON hooks during validation', async () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
    const hook = { toJSON() { calls++; return { value: 1 }; } };
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
    for (const data of [getter, hook, proxy]) {
      expect(await executor.execute('return 1;', data, 'value'))
        .toMatchObject({ success: false, error: 'ISOLATION_INVALID_INPUT' });
    }
    expect(calls).toBe(0);
  });

  it('does not return executable guest objects or excessive output', async () => {
    for (const code of [
      'return {get value(){while(true){}}};',
      'return {toJSON(){throw new Error("private-output-secret")}};',
      'return function(){};',
      'return "x".repeat(100000);',
    ]) {
      const result = await executor.execute(code, {}, 'value');
      expect(result.success).toBe(false);
      expect(ISOLATION_ERROR_CODES.some(code => code === result.error)).toBe(true);
      expect(result.value).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-output-secret');
    }
  }, 7000);

  it('redacts credential-shaped fields before the guest can inspect them', async () => {
    const result = await executor.execute('return JSON.stringify($);', {
      publicValue: 'safe', access_token: 'private-token', nested: { password: 'private-password' },
    }, 'value');
    expect(result.success).toBe(true);
    expect(result.value).toContain('safe');
    expect(result.value).not.toContain('private-token');
    expect(result.value).not.toContain('private-password');
  });

  it('rejects oversized scripts and non-JSON input with stable codes', async () => {
    expect(await executor.execute(' '.repeat(ISOLATION_LIMITS.codeChars + 1), {}, 'value'))
      .toMatchObject({ success: false, error: 'ISOLATION_INVALID_INPUT' });
    expect(await executor.execute('return 1;', { value: new Date() }, 'value'))
      .toMatchObject({ success: false, error: 'ISOLATION_INVALID_INPUT' });
  });
});
