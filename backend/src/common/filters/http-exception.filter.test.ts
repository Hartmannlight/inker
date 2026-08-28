import { describe, expect, test } from 'bun:test';
import { BadRequestException, Controller, Get, HttpException, Module, Param, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpExceptionFilter } from './http-exception.filter';
import { runWithCorrelation } from '../../observability/correlation-context';

function harness(exception: unknown, loggerThrows = false) {
  const events: unknown[] = [];
  let status = 0, body: any;
  const headers: Record<string, unknown> = {};
  const response = { headersSent: false,
    setHeader(name: string, value: string) { headers[name] = value; },
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  };
  const request = { method: 'POST', url: '/private/ABCDE-FGHJK?token=synthetic-query',
    headers: { 'x-device-key': 'synthetic-header' }, route: { path: '/api/test/:id' } };
  const log = (value: unknown) => { if (loggerThrows) throw new Error('synthetic-logger'); events.push(value); };
  const filter = new HttpExceptionFilter({ error: log, warn: log });
  filter.catch(exception, { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as any);
  return { status, body, events, headers };
}

describe('HTTP exception safe boundary', () => {
  test('unknown, primitive and cyclic exceptions always produce a constant 500 response', () => {
    const cycle: any = {}; cycle.self = cycle;
    for (const value of [undefined, null, 42, 1n, Symbol('synthetic'), 'synthetic-raw-error', cycle, new Error('synthetic-error')]) {
      const result = harness(value);
      expect(result.status).toBe(500);
      expect(result.body.message).toBe('Internal server error');
      expect(result.body.path).toBe('/api/test/:id');
      expect(result.body.method).toBe('POST');
      expect(result.headers['X-Correlation-ID']).toBe(result.body.correlationId);
      expect(JSON.stringify(result).includes('synthetic')).toBe(false);
      expect(JSON.stringify(result).includes('ABCDE-FGHJK')).toBe(false);
    }
  });

  test('getter, overridden exception method and revoked proxy traps never execute', () => {
    let calls = 0;
    const trap = () => { calls++; throw new Error('SYNTHETIC_ACCESSOR'); };
    const error = new Error('safe');
    Object.defineProperty(error, 'stack', { get: trap });
    Object.defineProperty(error, 'message', { get: trap });
    const live = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const known = new BadRequestException('safe');
    Object.defineProperty(known, 'response', { get: trap });
    Object.defineProperty(known, 'getStatus', { value: trap });
    Object.defineProperty(known, 'getResponse', { value: trap });
    const proxyPrototype = new Error('safe');
    Object.setPrototypeOf(proxyPrototype, new Proxy(Error.prototype, { getPrototypeOf: trap }));
    for (const value of [error, live, revoked.proxy, known, proxyPrototype]) expect(() => harness(value)).not.toThrow();
    expect(harness(known).status).toBe(400);
    Object.defineProperty(known, 'status', { get: trap });
    expect(harness(known).status).toBe(500);
    expect(calls).toBe(0);
  });

  test('retains normal validation arrays, explicit Source errors and TRMNL problem details', () => {
    const validation = harness(new BadRequestException(['name must be a string', 'code must be a string']));
    expect(validation.status).toBe(400);
    expect(validation.body.message).toEqual(['name must be a string', 'code must be a string']);
    expect(validation.body.error).toBe('Bad Request');
    const unavailable = harness(new ServiceUnavailableException({ statusCode: 503, code: 'SOURCE_SNAPSHOT_UNAVAILABLE',
      error: 'Service Unavailable', message: 'SOURCE_SNAPSHOT_UNAVAILABLE' }));
    expect(unavailable.body.code).toBe('SOURCE_SNAPSHOT_UNAVAILABLE');
    expect(unavailable.body.message).toBe('SOURCE_SNAPSHOT_UNAVAILABLE');
    const legacy = harness(new HttpException({ type: '/problem_details#device_id', status: 'unprocessable_content',
      detail: 'Invalid device ID.', instance: '/api/display', extensions: { errors: { device: ['is missing'] } } }, 422));
    expect(legacy.body.type).toBe('/problem_details#device_id');
    expect(legacy.body.status).toBe('unprocessable_content');
    expect(legacy.body.extensions).toEqual({ errors: { device: ['is missing'] } });
  });

  test('projects response fields, bounds text and rejects transport-field overrides and secret bodies', () => {
    const exception = new HttpException('initial', 400);
    const response: any = { message: 'X-Device-Key: synthetic-response', code: 'ABCDE-FGHJK',
      statusCode: 200, method: 'DELETE', path: '/synthetic-secret', correlationId: 'synthetic-correlation',
      headers: { token: 'synthetic-secret' }, data: { apiKey: 'synthetic-secret' }, payload: 'synthetic-secret' };
    response.self = response;
    Object.defineProperty(exception, 'response', { value: response });
    const result = harness(exception);
    expect(result.status).toBe(400);
    expect(result.body.statusCode).toBe(400);
    expect(result.body.method).toBe('POST');
    expect(result.body.path).toBe('/api/test/:id');
    expect(result.body.code).toBe('[REDACTED]');
    expect(JSON.stringify(result).includes('synthetic')).toBe(false);
    expect(JSON.stringify(result).includes('ABCDE-FGHJK')).toBe(false);
    expect(Object.keys(result.body).some(key => ['headers', 'data', 'payload', 'self'].includes(key))).toBe(false);
    const huge = harness(new BadRequestException('x'.repeat(100_000)));
    expect(huge.body.message).toBe('Request failed');
    expect(Buffer.byteLength(JSON.stringify(huge.body))).toBeLessThan(1024);
  });

  test('a logger failure cannot suppress the response and request correlation remains authoritative', () => {
    const correlationId = '12345678-1234-1234-1234-123456789012';
    const result = runWithCorrelation({ correlationId }, () => harness(new BadRequestException('safe'), true));
    expect(result.status).toBe(400);
    expect(result.body.correlationId).toBe(correlationId);
    expect(result.headers['X-Correlation-ID']).toBe(correlationId);
  });

  test('actual Nest HTTP requests survive hostile errors without leaked output', async () => {
    const cases = new Map<string, unknown>();
    const cycle: any = {}; cycle.self = cycle;
    let calls = 0;
    const error = new Error('synthetic-http');
    Object.defineProperty(error, 'stack', { get() { calls++; throw new Error('synthetic-stack'); } });
    cases.set('cycle', cycle);
    cases.set('getter', error);
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); cases.set('proxy', revoked.proxy);
    cases.set('validation', new BadRequestException(['code must be a string']));
    cases.set('unavailable', new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE'));
    @Controller('review')
    class ReviewController {
      @Get(':kind')
      failure(@Param('kind') kind: string) { throw cases.get(kind); }
    }
    @Module({ controllers: [ReviewController] })
    class ReviewModule {}
    const events: unknown[] = [];
    const application = await NestFactory.create(ReviewModule, { logger: false });
    application.useGlobalFilters(new HttpExceptionFilter({ error: event => events.push(event), warn: event => events.push(event) }));
    try {
      await application.listen(0, '127.0.0.1');
      const port = application.getHttpServer().address().port;
      for (const [kind, expected] of [['cycle', 500], ['getter', 500], ['proxy', 500], ['validation', 400], ['unavailable', 503]] as const) {
        const response = await fetch('http://127.0.0.1:' + port + '/review/' + kind + '?token=synthetic-query', {
          headers: { 'X-Device-Key': 'synthetic-header' },
        });
        expect(response.status).toBe(expected);
        const body = await response.json() as any;
        expect(body.path).toBe('/review/:kind');
        expect(body.correlationId).toBe(response.headers.get('X-Correlation-ID'));
        expect(JSON.stringify(body).includes('synthetic')).toBe(false);
      }
      expect(events.length).toBe(5);
      expect(JSON.stringify(events).includes('synthetic')).toBe(false);
      expect(calls).toBe(0);
    } finally { await application.close(); }
  });
});
