import { describe, expect, test } from 'bun:test';
import { createCorrelationContext, currentCorrelation, runWithCorrelation } from './correlation-context';

const id = '8f57dc36-9426-4432-847d-e40c81bda602';
describe('persistable correlation context', () => {
  test('generates stable server IDs and copies only bounded metadata', () => {
    const first = createCorrelationContext(), second = createCorrelationContext();
    expect(first.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.correlationId).not.toBe(second.correlationId);
    const input = { correlationId: id, eventId: 'event-1', deviceId: 7, sourceDefinitionId: id, deliveryId: 'delivery-1' };
    const context = createCorrelationContext(input);
    input.deviceId = 9;
    expect(context.deviceId).toBe(7);
    expect(Object.isFrozen(context)).toBe(true);
    expect(createCorrelationContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
  });

  test('keeps parallel asynchronous and nested work separate, including failure', async () => {
    expect(currentCorrelation()).toBeUndefined();
    const contexts = Array.from({ length: 30 }, (_, index) => createCorrelationContext({ deviceId: index + 1 }));
    await Promise.all(contexts.map(context => runWithCorrelation(context, async () => {
      await new Promise(resolve => setTimeout(resolve, context.deviceId! % 4));
      expect(currentCorrelation()).toEqual(context);
      const child = createCorrelationContext({ ...context, eventId: 'child' });
      expect(() => runWithCorrelation(child, () => {
        expect(currentCorrelation()?.eventId).toBe('child');
        throw new Error('controlled-test-failure');
      })).toThrow('controlled-test-failure');
      expect(currentCorrelation()).toEqual(context);
      await Promise.resolve();
      expect(currentCorrelation()).toEqual(context);
    })));
    expect(currentCorrelation()).toBeUndefined();
  });

  test('rejects unknown fields and malformed IDs without reporting their values', () => {
    for (const input of [
      { correlationId: 'synthetic-secret' }, { correlationId: id.toUpperCase() }, { correlationId: id + '\n' },
      { eventId: 'x'.repeat(101) }, { deliveryId: 'https://secret.invalid' }, { sourceDefinitionId: 'secret' },
      { deviceId: 0 }, { deviceId: 1.5 }, { deviceId: Number.MAX_SAFE_INTEGER + 1 },
      { payload: { token: 'synthetic-secret' } }, { headers: { Cookie: 'synthetic-secret' } },
      { 'synthetic-secret-key': 'synthetic-secret' }, new Date(), [], null,
    ]) {
      expect(() => createCorrelationContext(input)).toThrow('OBSERVABILITY_INVALID_CONTEXT');
      try { createCorrelationContext(input); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
    }
    expect(createCorrelationContext({ eventId: 'x'.repeat(100) }).eventId).toHaveLength(100);
  });

  test('does not invoke getters, proxy traps or conversion hooks', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'correlationId', { enumerable: true, get() { calls++; return id; } });
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; }, getPrototypeOf() { calls++; return Object.prototype; } });
    const hook = { toJSON() { calls++; return {}; } };
    const value = { correlationId: { toString() { calls++; return id; } } };
    for (const input of [getter, proxy, hook, value]) expect(() => createCorrelationContext(input)).toThrow('OBSERVABILITY_INVALID_CONTEXT');
    expect(calls).toBe(0);
  });
});
