import { describe, expect, test } from 'bun:test';
import { createCorrelationContext, currentCorrelation, runWithCorrelation } from '../observability/correlation-context';
import { intentCorrelationId, outboxCorrelation } from './outbox-correlation';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
describe('durable outbox correlation boundary', () => {
  test('persists the request context and generates independent worker intents', () => {
    const request = createCorrelationContext();
    expect(runWithCorrelation(request, intentCorrelationId)).toBe(request.correlationId);
    const one = intentCorrelationId(), two = intentCorrelationId();
    expect(one).toMatch(uuid); expect(two).toMatch(uuid); expect(one).not.toBe(two);
  });
  test('legacy event identities reconstruct stable UUIDs without mutating input', () => {
    for (const eventId of ['legacy-cuid', 'maintenance-v1-123', 'remote-' + 'a'.repeat(64), 'a'.repeat(64)]) {
      const input = Object.freeze({ eventId, correlationId: null });
      const first = outboxCorrelation(input);
      expect(first.correlationId).toMatch(uuid);
      expect(first.correlationId).not.toBe(eventId);
      expect(first).toEqual(outboxCorrelation({ eventId }));
      expect(first.correlationId).not.toBe(outboxCorrelation({ eventId: eventId + 'b' }).correlationId);
      expect(input.correlationId).toBeNull();
    }
  });
  test('persisted context wins over the current worker request and rejects invalid metadata without echo', () => {
    const request = createCorrelationContext(), persisted = createCorrelationContext();
    expect(runWithCorrelation(request, () => outboxCorrelation({ eventId: 'event', ...persisted })))
      .toEqual({ ...persisted, eventId: 'event' });
    expect(() => outboxCorrelation({ eventId: 'event', correlationId: 'secret-not-a-uuid' })).toThrow('OBSERVABILITY_INVALID_CONTEXT');
  });
  test('parallel child events inherit only their own durable job context', async () => {
    const contexts = Array.from({ length: 20 }, (_, index) => outboxCorrelation({ eventId: `event-${index}` }));
    await Promise.all(contexts.map(context => runWithCorrelation(context, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(intentCorrelationId()).toBe(context.correlationId);
      expect(currentCorrelation()?.eventId).toBe(context.eventId);
    })));
    expect(currentCorrelation()).toBeUndefined();
  });
});
