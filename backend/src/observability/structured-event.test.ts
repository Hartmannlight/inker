import { describe, expect, test } from 'bun:test';
import { createCorrelationContext, runWithCorrelation } from './correlation-context';
import { structuredEvent, STRUCTURED_EVENT_CODES, type StructuredEventFields, type StructuredEventCode } from './structured-event';

describe('structured operations events', () => {
  test('propagates a copied correlation context and emits a stable flat schema', () => {
    const context = createCorrelationContext({ eventId: 'event-1', deviceId: 7 });
    const event = runWithCorrelation(context, () => structuredEvent('JOB_COMPLETED', {
      role: 'worker', queue: 'render', durationMs: 12.5, attempt: 2, outcome: 'success',
    }, new Date('2026-08-28T12:00:00.000Z')));
    expect(event).toEqual({ protocolVersion: '1.0', timestamp: '2026-08-28T12:00:00.000Z',
      code: 'JOB_COMPLETED', level: 'info', ...context, role: 'worker', queue: 'render', durationMs: 12.5, attempt: 2, outcome: 'success' });
    expect(Object.isFrozen(event)).toBe(true);
  });

  test('permits only enumerated event codes and request route groups', () => {
    for (const code of STRUCTURED_EVENT_CODES) expect(structuredEvent(code, { role: 'api' }).code).toBe(code);
    const event = structuredEvent('REQUEST_FAILED', { role: 'api', route: 'auth', method: 'POST', statusCode: 401 });
    expect(event.level).toBe('warn');
    expect(event.route).toBe('auth');
    expect(() => structuredEvent('synthetic-secret' as StructuredEventCode, { role: 'api' })).toThrow('OBSERVABILITY_INVALID_EVENT');
  });

  test('rejects raw HTTP/exception data and invalid scalar limits without echoing them', () => {
    for (const extra of [
      { headers: { cookie: 'synthetic-secret' } }, { payload: 'synthetic-secret' }, { message: 'synthetic-secret' },
      { error: new Error('synthetic-secret') }, { route: '/api/pair?code=synthetic-secret' },
      { method: 'synthetic-secret' }, { queue: 'synthetic-secret' }, { outcome: 'synthetic-secret' },
      { durationMs: Infinity }, { durationMs: -1 }, { durationMs: 86_400_001 }, { statusCode: 600 },
      { attempt: 6 }, { deviceId: 0 }, { correlationId: 'synthetic-secret' },
    ]) {
      const input = { role: 'api', ...extra } as StructuredEventFields;
      expect(() => structuredEvent('REQUEST_FAILED', input)).toThrow('OBSERVABILITY_INVALID_EVENT');
      try { structuredEvent('REQUEST_FAILED', input); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
    }
    expect(() => structuredEvent('REQUEST_COMPLETED', { role: 'api' }, new Date(NaN))).toThrow('OBSERVABILITY_INVALID_EVENT');
  });

  test('does not execute accessors or proxy traps in metadata', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'role', { enumerable: true, get() { calls++; return 'api'; } });
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
    for (const input of [getter, proxy]) expect(() => structuredEvent('REQUEST_COMPLETED', input as StructuredEventFields)).toThrow('OBSERVABILITY_INVALID_EVENT');
    expect(calls).toBe(0);
  });
});
