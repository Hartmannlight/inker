import { describe, expect, it, mock } from 'bun:test';
import type { OutboxEvent } from '@prisma/client';
import { REMOTE_SYNC } from '../federation/remote-job';
import { MAINTENANCE_DUE } from '../jobs/maintenance.service';
import { PLAYBACK_DUE } from '../playback/playback.events';
import { RENDER_REQUESTED } from '../render-cache/render-cache.service';
import { SOURCE_REFRESH } from '../sources/source-job';
import { TIMER_DUE } from '../timers/timer-scheduling';
import { createOutboxDomainHandlers } from './outbox-domain-handlers';

const event = { eventId: 'event' } as OutboxEvent;
const signal = new AbortController().signal;

function setup() {
  const calls = {
    playback: mock(async () => undefined),
    renderCache: mock(async () => undefined),
    maintenance: mock(async () => undefined),
    sources: mock(async () => 'complete' as const),
    timers: mock(async () => undefined),
    remotes: mock(async () => 'complete' as const),
  };
  return {
    calls,
    handlers: createOutboxDomainHandlers({
      playback: { advanceDue: calls.playback },
      renderCache: { render: calls.renderCache },
      maintenance: { execute: calls.maintenance },
      sources: { execute: calls.sources },
      timers: { completeDue: calls.timers },
      remotes: { execute: calls.remotes },
    }),
  };
}

describe('outbox domain handler registry', () => {
  it('registers every domain event exactly once and invokes its service', async () => {
    const { handlers, calls } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      MAINTENANCE_DUE, PLAYBACK_DUE, REMOTE_SYNC, RENDER_REQUESTED, SOURCE_REFRESH, TIMER_DUE,
    ].sort());

    for (const type of handlers.keys()) expect(await handlers.get(type)!(event, signal)).toBe('complete');
    for (const call of Object.values(calls)) expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves terminal worker failures without acknowledging them', async () => {
    const { handlers, calls } = setup();
    calls.sources.mockResolvedValue('failed');
    calls.remotes.mockResolvedValue('failed');
    expect(await handlers.get(SOURCE_REFRESH)!(event, signal)).toBe('failed');
    expect(await handlers.get(REMOTE_SYNC)!(event, signal)).toBe('failed');
  });

  it('checks cancellation after a domain operation finishes', async () => {
    const abort = new AbortController();
    const { handlers } = setup();
    abort.abort();
    await expect(handlers.get(TIMER_DUE)!(event, abort.signal)).rejects.toThrow();
  });
});
