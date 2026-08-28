import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { currentCorrelation } from './correlation-context';
import { observeRequest, requestRoute, runtimeMetrics } from './runtime-observability';

describe('request observation boundary', () => {
  const records: unknown[] = [];
  let logs: ReturnType<typeof spyOn>, warnings: ReturnType<typeof spyOn>;
  afterEach(() => { logs?.mockRestore(); warnings?.mockRestore(); records.length = 0; });
  function response() {
    logs ??= spyOn(Logger.prototype, 'log').mockImplementation(value => { records.push(value); });
    warnings ??= spyOn(Logger.prototype, 'warn').mockImplementation(value => { records.push(value); });
    const headers: Record<string, string> = {};
    return Object.assign(new EventEmitter(), { headers, statusCode: 200, writableFinished: false,
      setHeader: (key: string, value: string) => { headers[key] = value; } });
  }
  test('generates server UUIDs, isolates parallel async contexts and excludes headers/URLs/body', async () => {
    logs = spyOn(Logger.prototype, 'log').mockImplementation(value => { records.push(value); });
    warnings = spyOn(Logger.prototype, 'warn').mockImplementation(value => { records.push(value); });
    const run = async (index: number) => {
      const res = response();
      let context: string | undefined;
      let complete!: () => void;
      const done = new Promise<void>(resolve => { complete = resolve; });
      const req = { url: '/api/device-enrollments/exchange?token=synthetic-hidden-token', method: 'POST',
        headers: { 'x-correlation-id': 'caller-chosen-secret' }, body: { code: 'short-secret' } } as unknown as Request;
      observeRequest(req, res as unknown as Response, () => {
        void Promise.resolve().then(() => { context = currentCorrelation()?.correlationId;
          res.statusCode = index ? 400 : 200; res.writableFinished = true; res.emit('finish'); res.emit('close'); complete(); });
      });
      await done;
      expect(context).toBe(res.headers['X-Correlation-ID']);
      expect(context).toMatch(/^[a-f0-9-]{36}$/);
      return context;
    };
    const identifiers = await Promise.all([run(0), run(1)]);
    expect(new Set(identifiers).size).toBe(2);
    expect(currentCorrelation()).toBeUndefined();
    expect(records).toHaveLength(2);
    expect(records.every(row => (row as { route: string }).route === 'pairing')).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/synthetic-hidden|caller-chosen|short-secret|headers|body|exchange/);
  });
  test('records one aborted request as 499 and uses only fixed route groups', () => {
    logs = spyOn(Logger.prototype, 'log').mockImplementation(value => { records.push(value); });
    warnings = spyOn(Logger.prototype, 'warn').mockImplementation(value => { records.push(value); });
    const res = response(), before = runtimeMetrics.snapshot().requests.find(row => row.route === 'other' && row.statusClass === '4xx')?.count ?? 0;
    observeRequest({ url: '/arbitrary-credential/path', method: 'SECRET' } as Request, res as unknown as Response, () => undefined);
    res.emit('close'); res.emit('close');
    expect(runtimeMetrics.snapshot().requests.find(row => row.route === 'other' && row.statusClass === '4xx')?.count).toBe(before + 1);
    expect(records[0]).toMatchObject({ statusCode: 499, method: 'OTHER', route: 'other' });
    expect(requestRoute('/api/devices/42/enrollments')).toBe('pairing');
    expect(requestRoute('/api/v1/device-content')).toBe('display');
    expect(requestRoute('/api/operations/metrics')).toBe('operations');
  });
});
