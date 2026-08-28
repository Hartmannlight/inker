import type { EventInput } from '../events/outbox.types';

export const TIMER_CHANGED = 'timer.state.changed';
export const TIMER_REASONS = ['created', 'paused', 'resumed', 'cancelled', 'completed', 'acknowledged'] as const;
export function parseTimerEvent(event: EventInput) {
  const p = event.payload as Record<string, unknown> | null;
  if (event.eventType !== TIMER_CHANGED || event.payloadVersion !== 1 || event.aggregateType !== 'Timer'
    || !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'reason,timerId,version'
    || typeof p.timerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.timerId)
    || !Number.isInteger(p.version) || Number(p.version) < 1 || Number(p.version) > 2_147_483_647
    || !TIMER_REASONS.includes(p.reason as typeof TIMER_REASONS[number])
    || event.aggregateId !== p.timerId || event.aggregateRevision !== String(p.version)) throw new Error('OUTBOX_INVALID_PAYLOAD');
  return { timerId: p.timerId, version: Number(p.version), reason: p.reason as typeof TIMER_REASONS[number] };
}
