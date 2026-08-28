import { describe, expect, test } from 'bun:test';
import { Logger as NestLogger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as winston from 'winston';
import { createLoggerConfig, LOG_FILE_POLICY } from './logger.config';
import { SafeLogger, safeLogRecord, SAFE_LOG_LIMITS } from './safe-logger';
import { structuredEvent } from '../observability/structured-event';
import { runWithCorrelation } from '../observability/correlation-context';

function memory(role: 'api' | 'worker' = 'api', simple = false) {
  const previous = { env: process.env.NODE_ENV, format: process.env.LOG_FORMAT };
  process.env.NODE_ENV = 'test';
  process.env.LOG_FORMAT = simple ? 'simple' : 'json';
  const configuration = createLoggerConfig(role);
  if (previous.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.env;
  if (previous.format === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = previous.format;
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, next) { lines.push(String(chunk)); next(); } });
  const transport = new winston.transports.Stream({ stream: output, format: (configuration.transports as any[])[0].format });
  const sink = winston.createLogger({ level: 'silly', transports: [transport], exitOnError: false });
  return { logger: new SafeLogger(sink, role), lines, sink,
    finish: () => new Promise<void>(resolve => sink.end(resolve)) };
}

describe('safe Nest/Winston logging', () => {
  test('default stdout formatter emits flat JSON with context and current correlation', async () => {
    const capture = memory('worker');
    const correlationId = '12345678-1234-1234-1234-123456789012';
    runWithCorrelation({ correlationId, eventId: 'remote-job-1' }, () => capture.logger.log(structuredEvent('JOB_FAILED', {
      role: 'worker', queue: 'remote-sync', outcome: 'failure', durationMs: 1500,
    }), 'RemoteWorkerService'));
    await capture.finish();
    const row = JSON.parse(capture.lines.join(''));
    expect(row.level).toBe('warn');
    expect(row.role).toBe('worker');
    expect(row.code).toBe('JOB_FAILED');
    expect(row.queue).toBe('remote-sync');
    expect(row.correlationId).toBe(correlationId);
    expect(row.eventId).toBe('remote-job-1');
    expect(row.context).toBe('RemoteWorkerService');
    expect(row.durationMs).toBe(1500);
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('the actual Nest Logger delegates before getters, proxy traps or conversion hooks can execute', async () => {
    const capture = memory();
    const previous = (NestLogger as any).staticInstanceRef;
    let calls = 0;
    const trap = () => { calls++; throw new Error('SYNTHETIC_TRAP'); };
    try {
      NestLogger.overrideLogger(capture.logger);
      const nest = new NestLogger('SyntheticService');
      const input = Object.defineProperties({ code: 'REQUEST_FAILED' }, {
        message: { get: trap, enumerable: true }, codeGetter: { get: trap, enumerable: true },
      });
      nest.log(input);
      nest.warn(new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }));
      const revoked = Proxy.revocable({}, {}); revoked.revoke(); nest.error(revoked.proxy);
      const error = new Error('SYNTHETIC_NATIVE_ERROR');
      Object.defineProperty(error, 'stack', { get: trap });
      Object.defineProperty(error, 'message', { get: trap });
      nest.error(error);
      nest.error('safe', new Proxy({}, { get: trap }));
      nest.log({ message: { toString: trap, toJSON: trap }, [Symbol.for('message')]: trap, [Symbol.for('splat')]: [trap] });
    } finally { NestLogger.overrideLogger(previous ?? false); }
    await capture.finish();
    expect(calls).toBe(0);
    expect(capture.lines.length).toBe(6);
    expect(capture.lines.every(line => !line.includes('SYNTHETIC_NATIVE_ERROR') && !line.includes('SYNTHETIC_TRAP'))).toBe(true);
    expect(capture.lines.every(line => JSON.parse(line).context === 'SyntheticService')).toBe(true);
  });

  test('fixed event codes survive while pairing codes, header bodies and Source secrets cannot enter output', async () => {
    const capture = memory();
    const marker = 'synthetic-secret-marker';
    capture.logger.log({ code: 'SOURCE_TIMEOUT', message: 'safe', headers: { 'X-Device-Key': marker },
      configuration: { apiKey: marker }, data: { value: marker }, payload: marker, body: { code: marker },
      nested: { cookie: marker }, [Symbol.for('message')]: marker, [Symbol.for('splat')]: [marker] });
    capture.logger.warn({ code: 'ABCDE-FGHJK', message: 'ABCDE-FGHJK' });
    capture.logger.log('pairing code ABCDE-FGHJK');
    capture.logger.log('ABCDE-FGHJK');
    capture.logger.log('ABCDEFGHJK');
    capture.logger.log(`X-Device-Key: ${marker} Cookie: session=${marker}`);
    capture.logger.log(`{"code":"${marker}"}`);
    capture.logger.error('safe', marker);
    await capture.finish();
    const output = capture.lines.join('');
    expect([marker, 'ABCDE-FGHJK', 'ABCDEFGHJK'].some(value => output.includes(value))).toBe(false);
    expect(JSON.parse(capture.lines[0]).code).toBe('SOURCE_TIMEOUT');
    expect(JSON.parse(capture.lines[1]).code).toBe('LOG_REDACTED');
    expect(Object.keys(JSON.parse(capture.lines[0])).some(key => ['headers', 'data', 'body', 'configuration', 'payload'].includes(key))).toBe(false);
  });

  test('cycles, huge inputs and broken transports cannot throw out of the logger', async () => {
    const capture = memory();
    const cycle: any = { message: 'safe' }; cycle.self = cycle;
    capture.logger.log(cycle);
    capture.logger.log('x'.repeat(1_000_000));
    capture.logger.log({ message: 'x'.repeat(8192), code: 'REQUEST_FAILED', source: cycle });
    capture.logger.log(Object.create({ get toJSON() { throw new Error('not called'); } }));
    await capture.finish();
    expect(capture.lines.length).toBe(4);
    expect(capture.lines.every(line => Buffer.byteLength(line) <= SAFE_LOG_LIMITS.recordBytes + 1)).toBe(true);
    const broken = new SafeLogger({ log() { throw new Error('synthetic-sink'); } } as any);
    expect(() => broken.error(new Error('synthetic-error'))).not.toThrow();
  });

  test('simple formatting is explicit and uses the same redacted boundary', async () => {
    const capture = memory('api', true);
    capture.logger.log('api_key=synthetic-simple-secret');
    await capture.finish();
    expect(capture.lines[0].startsWith('info:')).toBe(true);
    expect(capture.lines[0].includes('synthetic-simple-secret')).toBe(false);
    expect(capture.lines[0].includes('[REDACTED]')).toBe(true);
  });

  test('startup fallback writes only a fixed bounded JSON line before immediate exit', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
      'import {logStartupFailure} from "./src/config/logger.config"; let calls=0; const e=new Proxy({}, {get(){calls++;throw 1},getPrototypeOf(){calls++;throw 1}});logStartupFailure("worker",e);if(calls)process.exit(3);process.exit(1);'],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(out).toBe('');
    const row = JSON.parse(err);
    expect(row.code).toBe('WORKER_START_FAILED');
    expect(row.role).toBe('worker');
    expect(Buffer.byteLength(err)).toBeLessThan(512);
  });

  test('log levels are bounded and records never carry untrusted routing symbols', async () => {
    const capture = memory();
    capture.logger.setLogLevels(['error']);
    capture.logger.log('not emitted');
    capture.logger.error('emitted');
    await capture.finish();
    expect(capture.lines.length).toBe(1);
    expect(JSON.parse(capture.lines[0]).level).toBe('error');
    const record = safeLogRecord({ code: 'REQUEST_FAILED', level: 'unknown-secret', [Symbol.for('level')]: 'unknown-secret' });
    expect(record[Symbol.for('level')]).toBe('warn');
  });
});

describe('bounded rotating file configuration', () => {
  test('API and worker use separate private files with fixed retention and real rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inker-log-rotation-'));
    const previous = process.env.NODE_ENV;
    const sinks: winston.Logger[] = [];
    try {
      process.env.NODE_ENV = 'production';
      for (const role of ['api', 'worker'] as const) {
        const configuration = createLoggerConfig(role, directory);
        const transports = configuration.transports as any[];
        const files = transports.slice(1) as winston.transports.FileTransportInstance[];
        expect(files.length).toBe(2);
        for (const file of files) {
          expect((file as any).maxsize).toBe(LOG_FILE_POLICY.maxBytes);
          expect((file as any).maxFiles).toBe(LOG_FILE_POLICY.filesPerStream);
          expect((file as any).tailable).toBe(true);
          expect((file as any).options.mode).toBe(0o600);
          expect((file as any).filename.startsWith(`${role}-`)).toBe(true);
          // Exercise the production transport's rotation with smaller isolated files.
          (file as any).maxsize = 1024;
        }
        const sink = winston.createLogger({ ...configuration, transports: files });
        sinks.push(sink);
        const logger = new SafeLogger(sink, role);
        for (let index = 0; index < 50; index++) {
          logger.error({ code: 'SOURCE_TIMEOUT', message: `entry ${index} ${'x'.repeat(200)}` });
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('LOG_DRAIN_TIMEOUT')), 3000);
          sink.end(() => { clearTimeout(timeout); resolve(); });
        });
      }
      const names = await readdir(directory);
      for (const role of ['api', 'worker']) for (const kind of ['error', 'combined']) {
        const retained = names.filter(name => name.startsWith(`${role}-${kind}`));
        expect(retained.length).toBeGreaterThan(1);
        expect(retained.length).toBeLessThanOrEqual(LOG_FILE_POLICY.filesPerStream);
        for (const name of retained) {
          const contents = await readFile(join(directory, name), 'utf8');
          expect(contents.trim().split(/\r?\n/).every(line => JSON.parse(line).role === role)).toBe(true);
          expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(1024 + SAFE_LOG_LIMITS.recordBytes);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
      for (const sink of sinks) sink.close();
      if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
