import { describe, expect, mock, test } from 'bun:test';
import type { Prisma, RemoteSubscription } from '@prisma/client';
import { REMOTE_SYNC, scheduleRemote } from './remote-job';

function setup() {
  const subscription = {
    subscriptionId: 'subscription-one', version: 1, remoteServerId: 'remote-one',
    enabled: true, nextSyncAt: new Date('2026-08-28T12:00:00Z'),
    refreshIntervalSeconds: 60, circuitOpenUntil: null,
  } as RemoteSubscription;
  const active = mock(async (_args: unknown): Promise<{ eventId: string } | null> => null);
  const effect = mock(async (_args: unknown): Promise<object | null> => null);
  const eventUpsert = mock(async (_args: unknown) => ({}));
  const jobUpsert = mock(async (_args: unknown) => ({}));
  const update = mock(async (args: { data: { nextSyncAt: Date } }) => {
    subscription.nextSyncAt = args.data.nextSyncAt;
    return subscription;
  });
  const tx = { remoteSyncJob: { findFirst: active, upsert: jobUpsert }, outboxEffect: { findUnique: effect },
    outboxEvent: { upsert: eventUpsert }, remoteSubscription: { update } } as unknown as Prisma.TransactionClient;
  return { subscription, active, effect, eventUpsert, jobUpsert, update, tx };
}

describe('scheduleRemote', () => {
  test('durable event, job and next period share one deterministic identity', async () => {
    const h = setup(), now = new Date('2026-08-28T12:00:00Z');
    const eventId = await scheduleRemote(h.tx, h.subscription, now);
    expect(eventId).toMatch(/^remote-[a-f0-9]{64}$/);
    expect(h.eventUpsert).toHaveBeenCalledWith({
      where: { eventId }, update: {}, create: {
        eventId, eventType: REMOTE_SYNC, aggregateType: 'RemoteSubscription', aggregateId: 'subscription-one',
        aggregateRevision: '1', payloadVersion: 1,
        payload: { subscriptionId: 'subscription-one', subscriptionVersion: 1, scheduledAt: now.getTime() },
        availableAt: now, occurredAt: now,
      },
    });
    expect(h.jobUpsert).toHaveBeenCalledWith({ where: { eventId }, update: {}, create: {
      eventId, subscriptionId: 'subscription-one', subscriptionVersion: 1, remoteServerId: 'remote-one', scheduledAt: now,
    } });
    expect(h.subscription.nextSyncAt.getTime()).toBe(now.getTime() + 60_000);
  });

  test('disabled/not due subscriptions never enqueue', async () => {
    const h = setup();
    expect(await scheduleRemote(h.tx, h.subscription, new Date('2026-08-28T11:00:00Z'))).toBeNull();
    h.subscription.enabled = false;
    expect(await scheduleRemote(h.tx, h.subscription, new Date('2026-08-28T13:00:00Z'), true)).toBeNull();
    expect(h.eventUpsert).not.toHaveBeenCalled();
  });

  test('manual refresh deduplicates the active current version and honors the circuit', async () => {
    const h = setup(), now = new Date('2026-08-28T12:00:00Z');
    h.active.mockResolvedValue({ eventId: 'existing' });
    expect(await scheduleRemote(h.tx, h.subscription, now, true)).toBe('existing');
    expect(h.eventUpsert).not.toHaveBeenCalled();
    h.active.mockResolvedValue(null);
    h.subscription.circuitOpenUntil = new Date(now.getTime() + 30_000);
    await scheduleRemote(h.tx, h.subscription, now, true);
    expect(h.subscription.nextSyncAt.getTime()).toBe(now.getTime() + 90_000);
    expect(h.active).toHaveBeenLastCalledWith({ where: {
      subscriptionId: 'subscription-one', subscriptionVersion: 1, completedAt: null,
      event: { status: { in: ['pending', 'processing'] } },
    } });
  });

  test('completed receipt cannot be recreated after retention', async () => {
    const h = setup();
    h.effect.mockResolvedValue({ key: 'durable' });
    expect(await scheduleRemote(h.tx, h.subscription, h.subscription.nextSyncAt)).toBeNull();
    expect(h.eventUpsert).not.toHaveBeenCalled();
    expect(h.jobUpsert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  test('transport-only terminal failure does not reuse the previous period identity', async () => {
    const h = setup();
    const first = await scheduleRemote(h.tx, h.subscription, h.subscription.nextSyncAt);
    const second = await scheduleRemote(h.tx, h.subscription, h.subscription.nextSyncAt);
    expect(second).not.toBe(first);
    expect(h.eventUpsert).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
  });
});
