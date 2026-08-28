import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeIsolated, isolationDiagnostics, IsolatedExecutionError } from './isolated-executor';
import { ISOLATION_LIMITS, type IsolatedRequest } from './isolation-contract';

const script = (code: string, data: IsolatedRequest['data'] = null): IsolatedRequest => ({ version: 1, kind: 'javascript', mode: 'value', code, data });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Replace only the trusted entry point; retain real processes, options and pipes. */
async function executeFaultChild(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'inker-isolation-fault-'));
  const entry = join(directory, 'fault.ts');
  writeFileSync(entry, source, 'utf8');
  const realSpawn = childProcess.spawn;
  const pids: number[] = [];
  let replacements = 0;
  const before = isolationDiagnostics();
  const replaceEntry = ((command: string, args: readonly string[] | childProcess.SpawnOptions = [], options: childProcess.SpawnOptions = {}) => {
    if (!Array.isArray(args)) return realSpawn(command, args as childProcess.SpawnOptions);
    if (args[args.length - 1] === join(__dirname, 'isolation-child.ts')) {
      replacements++;
      const child = realSpawn(command, [...args.slice(0, -1), entry], options);
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    }
    return realSpawn(command, args, options);
  }) as typeof childProcess.spawn;
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(replaceEntry);
  try {
    let error: unknown;
    try { await executeIsolated(script('return "must not execute the normal guest";')); }
    catch (caught) { error = caught; }
    expect(replacements).toBe(1);
    expect(pids).toHaveLength(1);
    expect(error).toBeInstanceOf(IsolatedExecutionError);
    expect(isolationDiagnostics().active).toBe(0);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    return { error: error as IsolatedExecutionError, killed: isolationDiagnostics().killed - before.killed };
  } finally {
    spawn.mockRestore();
    // Delete only the two exact paths this test created; no recursive cleanup.
    unlinkSync(entry);
    rmdirSync(directory);
  }
}

async function activePid() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [pid] = isolationDiagnostics().pids;
    if (pid) return pid;
    await wait(10);
  }
  throw new Error('Expected our isolated child process');
}
afterEach(() => {
  expect(isolationDiagnostics().active).toBe(0);
  expect(isolationDiagnostics().pending).toBe(0);
});

describe('isolated process execution boundary', () => {
  test('starts the real Bun child with an empty environment and automatic env files disabled', async () => {
    const spawn = spyOn(childProcess, 'spawn');
    try {
      expect(await executeIsolated(script('return 42;'))).toBe(42);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawn.mock.calls[0];
      expect(command).toBe(process.execPath);
      expect(args).toEqual(['--no-env-file', join(__dirname, 'isolation-child.ts')]);
      expect(options).toMatchObject({ env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      expect(Object.keys(options!.env!)).toEqual([]);
    } finally { spawn.mockRestore(); }
  });
  test('copies bounded JSON without executing input accessors, proxies or serialization hooks', async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'label', { enumerable: true, get() { calls++; throw new Error('must not run'); } });
    const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('must not run'); } });
    const values = [accessor, proxy, { toJSON() { calls++; return 'bad'; } }, Object.create({ inherited: true }),
      JSON.parse('{"__proto__":{"polluted":true}}'), { value: Infinity }, { value: undefined }];
    const before = isolationDiagnostics().started;
    for (const data of values) await expect(executeIsolated(script('return $;', data))).rejects.toMatchObject({ code: 'ISOLATION_INVALID_INPUT' });
    expect(calls).toBe(0);
    expect(isolationDiagnostics().started).toBe(before);
    await expect(executeIsolated(script('return $;', 'x'.repeat(ISOLATION_LIMITS.dataBytes)))).rejects.toMatchObject({ code: 'ISOLATION_INVALID_INPUT' });
    await expect(executeIsolated(script(' '.repeat(ISOLATION_LIMITS.codeChars + 1)))).rejects.toMatchObject({ code: 'ISOLATION_INVALID_INPUT' });
  });

  test('runs real child JS and template values and never sends credential fields', async () => {
    expect(await executeIsolated(script('return { twice: $.value * 2, nested: $.nested };', { value: 21, nested: ['ok'] }))).toEqual({ twice: 42, nested: ['ok'] });
    expect(await executeIsolated({ ...script('const label = $.label.toUpperCase(); let count = 3;', { label: 'safe' }), mode: 'template' })).toEqual({ label: 'SAFE', count: 3 });
    const output = await executeIsolated(script('return $;', { access_token: 'synthetic-provider-token', nested: { apiKey: 'synthetic-api-key', safe: 'kept' } }));
    expect(output).toEqual({ access_token: '[REDACTED]', nested: { apiKey: '[REDACTED]', safe: 'kept' } });
    expect(isolationDiagnostics().started).toBeGreaterThan(0);
  });

  test('a maximum-size harmless string cannot block the parent before its deadline starts', async () => {
    const value = 'a'.repeat(65_500);
    const started = performance.now();
    const result = executeIsolated(script('return $.length;', value));
    expect(performance.now() - started).toBeLessThan(100);
    expect(await result).toBe(value.length);
  });

  test('guest cannot see parent environment, filesystem, process, network or module loaders', async () => {
    const previous = process.env.INKER_ISOLATION_TEST_TOKEN;
    process.env.INKER_ISOLATION_TEST_TOKEN = 'synthetic-parent-only-secret';
    try {
      expect(await executeIsolated(script('return [typeof process, typeof require, typeof Bun, typeof fetch, typeof XMLHttpRequest, typeof WebSocket];')))
        .toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
      await expect(executeIsolated(script('return globalThis["pro"+"cess"].env.INKER_ISOLATION_TEST_TOKEN;'))).rejects.toBeInstanceOf(IsolatedExecutionError);
      await expect(executeIsolated(script('return import("node:fs");'))).rejects.toBeInstanceOf(IsolatedExecutionError);
      await expect(executeIsolated(script('throw new Error("synthetic-parent-only-secret");'))).rejects.toMatchObject({ message: 'ISOLATION_FAILED' });
    } finally {
      if (previous === undefined) delete process.env.INKER_ISOLATION_TEST_TOKEN;
      else process.env.INKER_ISOLATION_TEST_TOKEN = previous;
    }
  });

  test('terminates infinite computation, heap growth and hostile serialization and recovers', async () => {
    for (const code of ['while (true) {}', 'const a = []; while (true) a.push(new Array(100000).fill(123));',
      'return { toString(){ while(true){} } };', 'return { toJSON(){ while(true){} } };',
      'return Object.defineProperty({}, "x", { enumerable:true, get(){ while(true){} } });']) {
      const start = performance.now();
      await expect(executeIsolated(script(code))).rejects.toBeInstanceOf(IsolatedExecutionError);
      expect(performance.now() - start).toBeLessThan(ISOLATION_LIMITS.wallMs + 1000);
      expect(isolationDiagnostics().active).toBe(0);
      expect(await executeIsolated(script('return 42;'))).toBe(42);
    }
  }, 20_000);

  test('actually kills on parent abort and awaits closure before rejecting', async () => {
    const controller = new AbortController();
    const promise = executeIsolated(script('while(true){}'), controller.signal);
    const settled = promise.then(() => 'unexpected-success', error => error.code);
    const pid = await activePid(); controller.abort('must-not-appear');
    expect(await settled).toBe('ISOLATION_ABORTED');
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(executeIsolated(script('return 1;'), controller.signal)).rejects.toMatchObject({ code: 'ISOLATION_ABORTED' });
    expect(await executeIsolated(script('return 2;'))).toBe(2);
  });

  test('aborting a queued request removes it without spawning another child', async () => {
    const before = isolationDiagnostics().started;
    const controllers = Array.from({ length: ISOLATION_LIMITS.concurrency }, () => new AbortController());
    const running = controllers.map(controller => executeIsolated(script('while(true){}'), controller.signal)
      .then(() => 'unexpected-success', error => error.code));
    const queuedController = new AbortController();
    const queued = executeIsolated(script('return "must not run";'), queuedController.signal)
      .then(() => 'unexpected-success', error => error.code);
    try {
      expect(isolationDiagnostics().active).toBe(ISOLATION_LIMITS.concurrency);
      expect(isolationDiagnostics().pending).toBe(1);
      queuedController.abort('synthetic-private-abort-reason');
      expect(await queued).toBe('ISOLATION_ABORTED');
      expect(isolationDiagnostics().pending).toBe(0);
      expect(isolationDiagnostics().started - before).toBe(ISOLATION_LIMITS.concurrency);
    } finally {
      queuedController.abort();
      for (const controller of controllers) controller.abort();
      await Promise.all([...running, queued]);
    }
    expect(await executeIsolated(script('return "queue recovered";'))).toBe('queue recovered');
  });

  test('shutdown drains active and queued work in a separate process without closing this executor', async () => {
    const fixture = join(__dirname, '../../test/fixtures/isolation-shutdown.ts');
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(process.execPath, ['--no-env-file', fixture], {
        env: {}, windowsHide: true, timeout: ISOLATION_LIMITS.wallMs * 3, maxBuffer: 16 * 1024,
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.before.active).toBe(ISOLATION_LIMITS.concurrency);
    expect(report.before.pending).toBe(2);
    expect(report.codes).toEqual(Array(ISOLATION_LIMITS.concurrency + 2).fill('ISOLATION_ABORTED'));
    expect(report.after).toMatchObject({ active: 0, pending: 0, killed: ISOLATION_LIMITS.concurrency });
    expect(report.after.started).toBe(report.before.started);
    expect(report.after.pids).toEqual([]);
    expect(report.afterCloseCode).toBe('ISOLATION_ABORTED');
    expect(report.before.pids).toHaveLength(ISOLATION_LIMITS.concurrency);
    for (const pid of report.before.pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(await executeIsolated(script('return "test process still open";'))).toBe('test process still open');
  }, 10_000);

  test('rejects malformed and invalid IPC from real child pipes without exposing their text', async () => {
    const responses = [
      'synthetic-private-child-text',
      JSON.stringify({ version: 2, ok: true, value: null }),
      JSON.stringify({ version: 1, ok: true, value: null, extra: true }),
      JSON.stringify({ version: 1, ok: false, code: 'synthetic-private-child-error' }),
      '{"version":1,"ok":true,"value":null}\n{"version":1,"ok":true,"value":42}',
    ];
    for (const response of responses) {
      const { error } = await executeFaultChild(
        'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(' + JSON.stringify(response) + '));',
      );
      expect(error.code).toBe('ISOLATION_INVALID_OUTPUT');
      expect(error.message).toBe('ISOLATION_INVALID_OUTPUT');
    }
    expect(await executeIsolated(script('return "IPC recovered";'))).toBe('IPC recovered');
  });

  for (const [stream, bytes] of [['stdout', ISOLATION_LIMITS.responseBytes + 1], ['stderr', 8193]] as const) {
    test(`kills a real child exceeding the ${stream} byte limit and recovers`, async () => {
      const started = performance.now();
      const { error, killed } = await executeFaultChild(
        'process.stdin.resume(); process.stdin.on("end", () => { '
        + `process.${stream}.write(Buffer.alloc(${bytes}, 120)); `
        + `setTimeout(() => process.exit(2), ${ISOLATION_LIMITS.wallMs * 2}); });`,
      );
      expect(error.code).toBe('ISOLATION_OUTPUT_LIMIT');
      expect(error.message).toBe('ISOLATION_OUTPUT_LIMIT');
      expect(killed).toBe(1);
      expect(performance.now() - started).toBeLessThan(ISOLATION_LIMITS.wallMs + 1000);
      expect(await executeIsolated(script('return "pipe recovered";'))).toBe('pipe recovered');
    });
  }

  test('a real child crash cannot poison the next process or create a late success', async () => {
    const promise = executeIsolated(script('while(true){}'));
    const settled = promise.then(() => 'unexpected-success', error => error.code);
    const pid = await activePid(); process.kill(pid, 'SIGKILL');
    expect(await settled).toBe('ISOLATION_CRASH');
    expect(await executeIsolated(script('return typeof globalThis.previous;'))).toBe('undefined');
  });

  test('bounds active processes, queued memory and total request deadlines under a burst', async () => {
    let peak = 0;
    const monitor = setInterval(() => { peak = Math.max(peak, isolationDiagnostics().active); }, 5);
    try {
      const settled = await Promise.all(Array.from({ length: 24 }, () => executeIsolated(script('while(true){}'))
        .then(() => 'unexpected-success', error => error.code)));
      expect(peak).toBeLessThanOrEqual(ISOLATION_LIMITS.concurrency);
      expect(peak).toBeGreaterThan(0);
      expect(settled).not.toContain('unexpected-success');
      expect(settled).toContain('ISOLATION_BUSY');
      expect(settled).toContain('ISOLATION_TIMEOUT');
    } finally { clearInterval(monitor); }
    expect(await executeIsolated(script('return "recovered";'))).toBe('recovered');
  }, 10_000);
});
