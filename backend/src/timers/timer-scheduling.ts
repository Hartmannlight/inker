import { createHash } from 'node:crypto';
import type { Prisma, Timer } from '@prisma/client';
import type { EventInput } from '../events/outbox.types';
import { intentCorrelationId } from '../events/outbox-correlation';

export const TIMER_DUE = 'timer.completion.due';
export function timerCompletionId(timerId: string, version: number, dueAt: number): string {
  return createHash('sha256').update(JSON.stringify([TIMER_DUE, timerId, version, dueAt])).digest('hex');
}
export function parseTimerDue(event: EventInput) {
  const p = event.payload as Record<string, unknown> | null;
  if (event.eventType !== TIMER_DUE || event.aggregateType !== 'Timer' || event.payloadVersion !== 1
    || !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'dueAt,timerId,version'
    || typeof p.timerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.timerId)
    || !Number.isInteger(p.version) || Number(p.version) < 1 || Number(p.version) > 2_147_483_647
    || !Number.isSafeInteger(p.dueAt) || Number(p.dueAt) < 0 || Number(p.dueAt) > 253_402_300_799_999
    || event.aggregateId !== p.timerId || event.aggregateRevision !== String(p.version)
    || event.eventId !== timerCompletionId(p.timerId, Number(p.version), Number(p.dueAt))) throw new Error('OUTBOX_INVALID_PAYLOAD');
  return { timerId: p.timerId, version: Number(p.version), dueAt: Number(p.dueAt) };
}

/** Called in the domain transaction. A deadline belongs to exactly one version. */
export async function scheduleTimer(tx: Prisma.TransactionClient, row: Timer, recoverDeadLetters = false, correlationId?: string) {
  const eventId = row.status === 'running' && row.endsAt
    ? timerCompletionId(row.timerId, row.version, row.endsAt.getTime()) : null;
  await tx.outboxEvent.updateMany({ where: { eventType: TIMER_DUE, aggregateId: row.timerId,
    status: 'pending', ...(eventId ? { eventId: { not: eventId } } : {}) },
    data: { status: 'delivered', processedAt: row.evaluatedAt } });
  if (!eventId || !row.endsAt) return;
  const data = { eventType: TIMER_DUE, aggregateType: 'Timer', aggregateId: row.timerId,
    aggregateRevision: String(row.version), payloadVersion: 1,
    payload: { timerId: row.timerId, version: row.version, dueAt: row.endsAt.getTime() },
    occurredAt: row.evaluatedAt, availableAt: row.endsAt };
  await tx.outboxEvent.upsert({ where: { eventId }, create: { eventId, ...data, correlationId: correlationId ?? intentCorrelationId() }, update: {} });
  // Only a worker startup explicitly re-arms exhausted, still-current deadlines.
  // Ordinary reconciliation never creates an unbounded poison-job retry loop.
  if (recoverDeadLetters) await tx.outboxEvent.updateMany({ where: { eventId, status: 'dead-letter' },
    data: { ...data, status: 'pending', attempts: 0, processedAt: null, lastError: null,
      claimOwner: null, claimToken: null, claimUntil: null } });
}
