import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service';
import { DeviceUpdateCoordinator } from '../device-platform/device-update-coordinator.service';
import { TIMER_CHANGED } from '../timers/timer.events';
import { OutboxStore } from './outbox.store';

describe('WP-25 timer outbox recipient authorization', () => {
  let directory: string, prisma: PrismaClient, store: OutboxStore;
  const root = resolve(import.meta.dir, '../..');
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-timer-push-'));
    const url = 'file:' + join(directory, 'test.db').replaceAll('\\', '/');
    const child = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    store = new OutboxStore(prisma as PrismaService);
    for (let id = 1; id <= 4; id++) await prisma.device.create({ data: {
      id, name: 'timer-device-' + id, externalId: 'external-' + id, isActive: id !== 3,
      profileId: 'browser-hd-1920x1080',
      deliveryPolicyId: id === 4 ? 'reference-sleepy' : 'reference-connected-browser',
    } });
  }, 30_000);
  afterEach(async () => {
    await prisma?.$disconnect();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-timer-push-'))
      throw new Error('Unsafe timer fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  });
  async function timer(visibility: 'private' | 'shared') {
    const now = Date.now();
    return prisma.timer.create({ data: { creatorDeviceId: 1, creatorExternalId: 'external-1', visibility,
      status: 'running', durationMs: 2000, startedAt: new Date(now - 1000), evaluatedAt: new Date(now), endsAt: new Date(now + 1000) } });
  }
  async function claim(timerId: string, version = 1) {
    const row = await prisma.outboxEvent.create({ data: { eventId: randomUUID(), eventType: TIMER_CHANGED,
      aggregateType: 'Timer', aggregateId: timerId, aggregateRevision: String(version), payloadVersion: 1,
      payload: { timerId, version, reason: 'created' } } });
    const event = await store.claim('timer-push-fixture', new Date(), { eventId: row.eventId });
    expect(event).not.toBeNull();
    return event!;
  }
  const recipients = async (key: string) => (await prisma.outboxDelivery.findMany({
    where: { effectKey: key }, orderBy: { deviceId: 'asc' },
  })).map(row => row.deviceId);

  test('private targets only its creator; shared targets every active device without rendering or state mutation', async () => {
    await store.register('consumer');
    const privateTimer = await timer('private'), sharedTimer = await timer('shared');
    const devices = await prisma.device.findMany({ orderBy: { id: 'asc' } });
    const timers = await prisma.timer.findMany({ orderBy: { timerId: 'asc' } });
    const privateEffect = await store.prepare(await claim(privateTimer.timerId));
    const sharedEffect = await store.prepare(await claim(sharedTimer.timerId));
    expect(await recipients(privateEffect.key)).toEqual([1]);
    expect(await recipients(sharedEffect.key)).toEqual([1, 2, 4]);
    expect(await prisma.outboxTarget.count()).toBe(2);
    expect((await prisma.outboxDelivery.findMany()).every(row => row.presentation === null)).toBe(true);
    expect(await prisma.device.findMany({ orderBy: { id: 'asc' } })).toEqual(devices);
    expect(await prisma.timer.findMany({ orderBy: { timerId: 'asc' } })).toEqual(timers);
    expect(await prisma.renderRequest.count()).toBe(0);
  });

  test('recipient lookup uses current activity and preserves private isolation after creator deletion', async () => {
    const privateTimer = await timer('private'), sharedTimer = await timer('shared');
    const privateEvent = await claim(privateTimer.timerId), sharedEvent = await claim(sharedTimer.timerId);
    await prisma.device.delete({ where: { id: 1 } });
    await prisma.device.update({ where: { id: 2 }, data: { isActive: false } });
    expect(await recipients((await store.prepare(privateEvent)).key)).toEqual([]);
    expect(await recipients((await store.prepare(sharedEvent)).key)).toEqual([4]);
    expect(await prisma.timer.findUnique({ where: { timerId: sharedTimer.timerId } }))
      .toMatchObject({ creatorDeviceId: null, creatorExternalId: 'external-1' });
    expect(await recipients((await store.prepare(await claim(randomUUID()))).key)).toEqual([]);
  });

  test('retry reuses the original recipient set and one effect; a new revision resolves current recipients', async () => {
    const row = await timer('shared');
    await store.register('consumer');
    const first = await claim(row.timerId), prepared = await store.prepare(first);
    const deliveries = await prisma.outboxDelivery.findMany({ where: { effectKey: prepared.key }, orderBy: { deviceId: 'asc' } });
    await prisma.device.update({ where: { id: 3 }, data: { isActive: true } });
    expect((await store.prepare(first)).duplicate).toBe(false);
    const duplicate = await store.prepare(await claim(row.timerId));
    expect(duplicate.key).toBe(prepared.key);
    expect(duplicate.duplicate).toBe(true);
    expect(await prisma.outboxEffect.count()).toBe(1);
    expect(await prisma.outboxTarget.count()).toBe(1);
    expect(await prisma.outboxDelivery.findMany({ where: { effectKey: prepared.key }, orderBy: { deviceId: 'asc' } })).toEqual(deliveries);
    expect(await recipients((await store.prepare(await claim(row.timerId, 2))).key)).toEqual([1, 2, 3, 4]);
  });

  test('effect, authorized deliveries and consumer targets roll back together on a late SQL failure', async () => {
    const row = await timer('shared');
    await store.register('consumer');
    const event = await claim(row.timerId);
    await prisma.$executeRawUnsafe("CREATE TRIGGER fail_timer_target BEFORE INSERT ON outbox_targets BEGIN SELECT RAISE(ABORT, 'controlled fixture failure'); END");
    try {
      await expect(store.prepare(event)).rejects.toThrow();
      expect(await prisma.outboxEffect.count()).toBe(0);
      expect(await prisma.outboxDelivery.count()).toBe(0);
      expect(await prisma.outboxTarget.count()).toBe(0);
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER fail_timer_target'); }
    expect(await recipients((await store.prepare(event)).key)).toEqual([1, 2, 4]);
    expect(await prisma.outboxEvent.count({ where: { status: 'dead-letter' } })).toBe(0);
  });

  test('dispatch rechecks deactivation and deletion after preparation and sends only stateTopic', async () => {
    const row = await timer('shared');
    const dispatchRefresh = mock(async (_id: number, _context: unknown) => {});
    const coordinator = new DeviceUpdateCoordinator({ emit: mock(() => {}) } as never, prisma as PrismaService,
      { resolvePersisted: () => ({ deliveryPolicy: { mode: 'connected' }, capabilities: {} }) } as never,
      { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'websocket' }) } as never,
      { list: () => [], get: () => ({ dispatchRefresh }) } as never, store);
    await store.register(coordinator.consumerId);
    const prepared = await store.prepare(await claim(row.timerId));
    expect(await recipients(prepared.key)).toEqual([1, 2, 4]);
    await prisma.device.update({ where: { id: 1 }, data: { isActive: false } });
    await prisma.device.delete({ where: { id: 2 } });
    (coordinator as unknown as { active: boolean }).active = true;
    await coordinator.poll();
    expect(dispatchRefresh).toHaveBeenCalledTimes(1);
    expect(dispatchRefresh.mock.calls[0][0]).toBe(4);
    expect(dispatchRefresh.mock.calls[0][1]).toMatchObject({ stateTopic: 'timers' });
    expect(await store.targetsComplete(prepared.key)).toBe(true);
    expect(await prisma.renderRequest.count()).toBe(0);
  });
});
