import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { outboxCorrelation } from './outbox-correlation';
import { createCorrelationContext, currentCorrelation, runWithCorrelation } from '../observability/correlation-context';
import { runtimeMetrics } from '../observability/runtime-observability';
import { TIMER_DUE } from '../timers/timer-scheduling';
import { SOURCE_REFRESH } from '../sources/source-job';

describe('OutboxDispatcher durable observability', () => {
  let logs: ReturnType<typeof spyOn>, warnings: ReturnType<typeof spyOn>;
  beforeEach(() => { logs = spyOn(Logger.prototype, 'log').mockImplementation(() => {}); warnings = spyOn(Logger.prototype, 'warn').mockImplementation(() => {}); });
  afterEach(() => { logs.mockRestore(); warnings.mockRestore(); });
  function setup(operation: () => Promise<void>, correlationId: string | null = createCorrelationContext().correlationId) {
    const event = { eventId: 'timer-due-event', eventType: TIMER_DUE, aggregateId: 'timer', correlationId,
      claimToken: 'claim', claimOwner: 'worker', attempts: 1 } as OutboxEvent;
    const store = { current: mock(async () => event), ack: mock(async () => true), fail: mock(async () => true) };
    const timer = { completeDue: mock(operation), deferEarly: mock(async () => true) };
    const dispatcher = new OutboxDispatcher({ outboxEvent: { findUnique: async () => event } } as never, store as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, timer as never, {} as never);
    (dispatcher as unknown as { stopped: boolean }).stopped = true;
    return { event, store, timer, dispatcher, job: { version: 1 as const, eventId: event.eventId, claimToken: 'claim' } };
  }
  test('restores persisted context before domain I/O and keeps it through ack and bounded logs', async () => {
    const seen: unknown[] = [], h = setup(async () => { seen.push(currentCorrelation()); });
    h.store.ack.mockImplementation(async () => { seen.push(currentCorrelation()); return true; });
    await runWithCorrelation(createCorrelationContext(), () => h.dispatcher.dispatch(h.job, undefined, 'timer'));
    expect(seen).toEqual([outboxCorrelation(h.event), outboxCorrelation(h.event)]);
    const values = logs.mock.calls.map(call => call[0]);
    expect(values).toContainEqual(expect.objectContaining({ code: 'JOB_STARTED', correlationId: h.event.correlationId, eventId: h.event.eventId }));
    expect(values).toContainEqual(expect.objectContaining({ code: 'JOB_COMPLETED', outcome: 'success', queue: 'timer' }));
    expect(h.store.fail).not.toHaveBeenCalled(); expect(currentCorrelation()).toBeUndefined();
  });
  test('legacy retries reconstruct the same context and failures keep secrets out of logs', async () => {
    const seen: unknown[] = [], h = setup(async () => { seen.push(currentCorrelation()); throw new Error('bearer-secret-from-provider'); }, null);
    await h.dispatcher.dispatch(h.job, undefined, 'timer'); await h.dispatcher.dispatch(h.job, undefined, 'timer');
    expect(seen).toEqual([outboxCorrelation(h.event), outboxCorrelation(h.event)]);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('bearer-secret-from-provider');
    expect(warnings.mock.calls.some(call => call[0].code === 'JOB_FAILED')).toBe(true);
    expect(h.store.ack).not.toHaveBeenCalled(); expect(h.store.fail).toHaveBeenCalledTimes(2);
  });
  test('a stale ack is observable without reporting successful delivery', async () => {
    const h = setup(async () => {}); h.store.ack.mockResolvedValue(false);
    await h.dispatcher.dispatch(h.job, undefined, 'timer');
    expect(warnings.mock.calls.some(call => call[0].code === 'JOB_STALE')).toBe(true);
    expect(logs.mock.calls.some(call => call[0].code === 'JOB_COMPLETED')).toBe(false);
  });
  test('wrong queue and pre-abort never invoke the domain handler', async () => {
    const h = setup(async () => {});
    await h.dispatcher.dispatch(h.job, undefined, 'render');
    const abort = new AbortController(); abort.abort();
    await h.dispatcher.dispatch(h.job, abort.signal, 'timer');
    expect(h.timer.completeDue).not.toHaveBeenCalled(); expect(h.store.ack).not.toHaveBeenCalled();
    expect(warnings.mock.calls.some(call => call[0].outcome === 'aborted')).toBe(true);
  });
  test('metric exhaustion does not turn a committed acknowledgement into a retry', async () => {
    const metric = spyOn(runtimeMetrics, 'recordJob').mockImplementation(() => { throw new Error('metric limit'); });
    try {
      const h = setup(async () => {}); await h.dispatcher.dispatch(h.job, undefined, 'timer');
      expect(h.store.ack).toHaveBeenCalledTimes(1); expect(h.store.fail).not.toHaveBeenCalled();
    } finally { metric.mockRestore(); }
  });
  test('malformed optional source metadata still reaches the bounded domain rejection path', async () => {
    const h = setup(async () => {});
    h.event.eventType = SOURCE_REFRESH;
    h.event.aggregateId = 'malformed-source-id';
    const execute = mock(async () => { throw new Error('OUTBOX_INVALID_PAYLOAD'); });
    (h.dispatcher as unknown as {
      domainHandlers: Map<string, (event: OutboxEvent, signal: AbortSignal) => Promise<'complete'>>;
    }).domainHandlers.set(SOURCE_REFRESH, async (event, signal) => {
      await execute(event, signal);
      return 'complete';
    });
    await h.dispatcher.dispatch(h.job, undefined, 'source-refresh');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.store.fail).toHaveBeenCalledWith(h.event, 'OUTBOX_INVALID_PAYLOAD');
    expect(h.store.ack).not.toHaveBeenCalled();
    expect(warnings.mock.calls.some(call => call[0].code === 'JOB_FAILED')).toBe(true);
  });
  test('a scheduler refill starts a fresh context instead of inheriting an unrelated completed job', async () => {
    const h = setup(async () => {});
    let refill: ReturnType<typeof currentCorrelation>;
    const tick = spyOn(h.dispatcher, 'tick').mockImplementation(async () => { refill = currentCorrelation(); });
    (h.dispatcher as unknown as { stopped: boolean }).stopped = false;
    try {
      await h.dispatcher.dispatch(h.job, undefined, 'timer');
      expect(tick).toHaveBeenCalledTimes(1);
      expect(refill).toEqual({ correlationId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) });
      expect(refill?.correlationId).not.toBe(h.event.correlationId);
      expect(currentCorrelation()).toBeUndefined();
    } finally { tick.mockRestore(); }
  });
});
