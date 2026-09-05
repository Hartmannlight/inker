import type { OutboxEvent } from '@prisma/client';
import { REMOTE_SYNC } from '../federation/remote-job';
import { MAINTENANCE_DUE } from '../jobs/maintenance.service';
import { PLAYBACK_DUE } from '../playback/playback.events';
import { RENDER_REQUESTED } from '../render-cache/render-cache.service';
import { SOURCE_REFRESH } from '../sources/source-job';
import { TIMER_DUE } from '../timers/timer-scheduling';

export type OutboxDomainResult = 'complete' | 'failed';
export type OutboxDomainHandler = (
  event: OutboxEvent,
  signal: AbortSignal,
) => Promise<OutboxDomainResult>;

export interface OutboxDomainServices {
  playback: { advanceDue(event: OutboxEvent, signal: AbortSignal): Promise<unknown> };
  renderCache: { render(event: OutboxEvent, input: undefined, signal: AbortSignal): Promise<unknown> };
  maintenance: { execute(event: OutboxEvent, signal: AbortSignal): Promise<unknown> };
  sources: { execute(event: OutboxEvent, signal: AbortSignal): Promise<'failed' | unknown> };
  timers: { completeDue(event: OutboxEvent, signal: AbortSignal): Promise<unknown> };
  remotes: { execute(event: OutboxEvent, signal: AbortSignal): Promise<'failed' | unknown> };
}

const complete = async (work: Promise<unknown>, signal: AbortSignal): Promise<OutboxDomainResult> => {
  await work;
  signal.throwIfAborted();
  return 'complete';
};

/**
 * Explicit domain-handler registry. Transport, retry and acknowledgement remain
 * in OutboxDispatcher; domain services own only execution of their event type.
 */
export function createOutboxDomainHandlers(
  services: OutboxDomainServices,
): ReadonlyMap<string, OutboxDomainHandler> {
  return new Map<string, OutboxDomainHandler>([
    [REMOTE_SYNC, async (event, signal) =>
      await services.remotes.execute(event, signal) === 'failed' ? 'failed' : 'complete'],
    [SOURCE_REFRESH, async (event, signal) =>
      await services.sources.execute(event, signal) === 'failed' ? 'failed' : 'complete'],
    [TIMER_DUE, (event, signal) => complete(services.timers.completeDue(event, signal), signal)],
    [RENDER_REQUESTED, (event, signal) => complete(services.renderCache.render(event, undefined, signal), signal)],
    [MAINTENANCE_DUE, (event, signal) => complete(services.maintenance.execute(event, signal), signal)],
    [PLAYBACK_DUE, (event, signal) => complete(services.playback.advanceDue(event, signal), signal)],
  ]);
}
