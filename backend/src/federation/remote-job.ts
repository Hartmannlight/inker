import type { Prisma, RemoteSubscription } from '@prisma/client';
import { sha256 } from '../publications/publication-content';

export const REMOTE_SYNC = 'remote.sync.due';
export const REMOTE_LIMITS = Object.freeze({
  global: 2, remote: 1, subscription: 1, networkMs: 15_000,
  circuitFailures: 3, circuitCooldownMs: 30_000,
});

/** Caller owns SQLite's writer lock; durable intent and next due time commit together. */
export async function scheduleRemote(tx: Prisma.TransactionClient, subscription: RemoteSubscription, now: Date, force = false) {
  if (!subscription.enabled || (!force && subscription.nextSyncAt > now)) return null;
  const active = await tx.remoteSyncJob.findFirst({ where: {
    subscriptionId: subscription.subscriptionId, subscriptionVersion: subscription.version,
    completedAt: null, event: { status: { in: ['pending', 'processing'] } },
  } });
  if (active) return active.eventId;
  const due = new Date(Math.max(force ? now.getTime() : subscription.nextSyncAt.getTime(), subscription.circuitOpenUntil?.getTime() ?? 0));
  const identity = [subscription.subscriptionId, subscription.version, due.getTime()].join(':');
  const eventId = 'remote-' + sha256(identity);
  if (await tx.outboxEffect.findUnique({ where: { eventId } })) return null;
  await tx.outboxEvent.upsert({ where: { eventId }, update: {}, create: {
    eventId, eventType: REMOTE_SYNC, aggregateType: 'RemoteSubscription', aggregateId: subscription.subscriptionId,
    aggregateRevision: String(subscription.version), payloadVersion: 1,
    payload: { subscriptionId: subscription.subscriptionId, subscriptionVersion: subscription.version, scheduledAt: due.getTime() },
    availableAt: due, occurredAt: now,
  } });
  await tx.remoteSyncJob.upsert({ where: { eventId }, update: {}, create: {
    eventId, subscriptionId: subscription.subscriptionId, subscriptionVersion: subscription.version,
    remoteServerId: subscription.remoteServerId, scheduledAt: due,
  } });
  // Transport exhaustion must not pin future periods to a dead event identity.
  await tx.remoteSubscription.update({ where: { subscriptionId: subscription.subscriptionId }, data: {
    nextSyncAt: new Date(due.getTime() + subscription.refreshIntervalSeconds * 1000),
  } });
  return eventId;
}
