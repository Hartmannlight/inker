import type { Prisma, SourceDefinition } from '@prisma/client';
import { sha256 } from '../publications/publication-content';
import { intentCorrelationId } from '../events/outbox-correlation';

export const SOURCE_REFRESH = 'source.refresh.due';
export const SOURCE_LIMITS = Object.freeze({ global: 4, provider: 2, connector: 2, source: 1, circuitFailures: 3, circuitCooldownMs: 30_000 });

/** Caller holds SQLite's write lock; intention and queue metadata commit together. */
export async function scheduleSource(tx: Prisma.TransactionClient, source: SourceDefinition, now: Date, force = false) {
  if (!source.enabled || (!force && source.nextRefreshAt > now)) return null;
  const active = await tx.sourceRefreshJob.findFirst({ where: { sourceDefinitionId: source.sourceDefinitionId,
    definitionVersion: source.definitionVersion, completedAt: null, event: { status: { in: ['pending', 'processing'] } } } });
  if (active) return active.eventId;
  const due = new Date(Math.max(force ? now.getTime() : source.nextRefreshAt.getTime(), source.circuitOpenUntil?.getTime() ?? 0));
  const eventId = `source-${sha256(`${source.sourceDefinitionId}:${source.definitionVersion}:${due.getTime()}`)}`;
  // Permanent receipt prevents reconstruction of a completed identity after retention.
  if (await tx.outboxEffect.findUnique({ where: { eventId } })) return null;
  await tx.outboxEvent.upsert({ where: { eventId }, update: {}, create: {
    correlationId: intentCorrelationId(),
    eventId, eventType: SOURCE_REFRESH, aggregateType: 'SourceDefinition', aggregateId: source.sourceDefinitionId,
    aggregateRevision: String(source.definitionVersion), payloadVersion: 1,
    payload: { sourceDefinitionId: source.sourceDefinitionId, definitionVersion: source.definitionVersion, scheduledAt: due.getTime() },
    availableAt: due, occurredAt: now,
  } });
  await tx.sourceRefreshJob.upsert({ where: { eventId }, update: {}, create: {
    eventId, sourceDefinitionId: source.sourceDefinitionId, definitionVersion: source.definitionVersion,
    connectorType: source.connectorType, concurrencyGroup: source.concurrencyGroup, scheduledAt: due,
  } });
  // Advance the durable schedule with the intent, not only after connector
  // execution. Transport-only exhausted attempts must not pin a source forever
  // to the same terminal event identity after Redis recovers.
  await tx.sourceDefinition.update({ where: { sourceDefinitionId: source.sourceDefinitionId },
    data: { nextRefreshAt: new Date(due.getTime() + source.refreshIntervalSeconds * 1000) } });
  return eventId;
}
