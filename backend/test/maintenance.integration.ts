import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { PrismaClient, type OutboxEvent, type Prisma } from '@prisma/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { OutboxStore } from '../src/events/outbox.store';
import { MAINTENANCE_DUE, MaintenanceService } from '../src/jobs/maintenance.service';
import { LogCleanupService, MAINTENANCE_BATCH_SIZE } from '../src/jobs/services/log-cleanup.service';
import { PublicationCleanupService } from '../src/publications/publication-cleanup.service';
import { sqliteWrite } from '../src/common/utils/sqlite-write.util';

const root = resolve(import.meta.dir, '..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('WP-20 durable, fenced maintenance', () => {
  let directory: string;
  let prisma: PrismaClient;
  let other: PrismaClient;
  let service: MaintenanceService;
  let second: MaintenanceService;
  let store: OutboxStore;
  let now: Date;
  let deviceId: number;

  function createService(client: PrismaClient, logs?: LogCleanupService) {
    const db = client as PrismaService;
    return new MaintenanceService(db, logs ?? new LogCleanupService(db), new PublicationCleanupService(db));
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-maintenance-'));
    const url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const migration = spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    other = new PrismaClient({ datasources: { db: { url } } });
    await Promise.all([prisma.$connect(), other.$connect()]);
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await other.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    service = createService(prisma);
    second = createService(other);
    store = new OutboxStore(prisma as PrismaService);
    now = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    deviceId = (await prisma.device.create({ data: {
      name: 'Maintenance fixture', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser',
    } })).id;
  }, 30_000);

  afterEach(async () => {
    await Promise.all([prisma?.$disconnect(), other?.$disconnect()]);
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-maintenance-')) {
        throw new Error('Unsafe test cleanup target');
      }
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function claim(at = now): Promise<OutboxEvent> {
    await service.schedule(at);
    const event = await store.claim('maintenance-test');
    if (!event || event.eventType !== MAINTENANCE_DUE) throw new Error('Expected maintenance claim');
    return event;
  }

  async function log(createdAt = new Date(now.getTime() - 31 * DAY)) {
    return prisma.deviceLog.create({ data: { deviceId, level: 'info', message: 'isolated fixture', createdAt } });
  }

  test('two worker clients schedule one immutable UTC-hour event and recover it after restart', async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? service : second).schedule(new Date(now.getTime() + index * 1000))));
    expect(new Set(attempts.map(event => event!.eventId)).size).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    const event = attempts[0]!;
    expect(event.payload).toEqual({ scheduledAt: now.getTime() });
    expect(event.aggregateRevision).toBe(String(now.getTime() / HOUR));
    expect(event.eventId).toBe(`maintenance-v1-${now.getTime() / HOUR}`);
    const claimed = await store.claim('first-worker');
    expect(claimed).not.toBeNull();
    await other.$disconnect(); await other.$connect();
    const restarted = createService(other);
    expect(await restarted.schedule(new Date(now.getTime() + HOUR - 1))).toEqual(claimed);
    expect(await service.schedule(new Date(now.getTime() + HOUR))).not.toEqual(event);
    expect(await prisma.outboxEvent.count()).toBe(2);
  });

  test('both workers execute the same claim once, and a crash before ack cannot repeat cleanup', async () => {
    await log();
    const event = await claim();
    const results = await Promise.all([service.execute(event), second.execute(event)]);
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect(results.reduce((total, result) => total + result.deviceLogs, 0)).toBe(1);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status).toBe('processing');
    const late = await log();
    await other.$disconnect(); await other.$connect();
    expect((await createService(other).execute(event)).duplicate).toBe(true);
    expect(await prisma.deviceLog.findUnique({ where: { id: late.id } })).not.toBeNull();
    expect(await store.ack(event)).toBe(true);
    await new PublicationCleanupService(prisma as PrismaService).cleanup(new Date(now.getTime() + 31 * DAY));
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: event.eventId } })).toBeNull();
    expect(await service.schedule(now)).toBeNull();
    expect(await prisma.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
  });

  test('uses the original hourly cutoff even when the job executes a day late', async () => {
    const scheduledAt = new Date(now.getTime() - DAY);
    const before = await log(new Date(scheduledAt.getTime() - 30 * DAY - 1));
    const boundary = await log(new Date(scheduledAt.getTime() - 30 * DAY));
    const between = await log(new Date(scheduledAt.getTime() - 30 * DAY + HOUR));
    const result = await service.execute(await claim(scheduledAt));
    expect(result.deviceLogs).toBe(1);
    expect(await prisma.deviceLog.findUnique({ where: { id: before.id } })).toBeNull();
    expect((await prisma.deviceLog.findMany()).map(entry => entry.id).sort()).toEqual([boundary.id, between.id]);
  });

  test('retains pending work, current publications and every referenced revision', async () => {
    const event = await claim();
    const old = new Date(now.getTime() - 100 * DAY);
    await prisma.publication.create({ data: { publicationId: 'maintenance-publication', publicationKey: 'maintenance' } });
    for (let revision = 1; revision <= 7; revision++) {
      await prisma.publicationRevision.create({ data: {
        publicationRevisionId: `maintenance-revision-${revision}`, publicationId: 'maintenance-publication', revision,
        protocolVersion: '1.0', content: {}, contentHash: `hash-${revision}`,
        publishedAt: revision === 6 ? new Date(now.getTime() - 89 * DAY) : old,
      } });
    }
    await prisma.devicePublicationState.create({ data: {
      deviceId, desiredPublicationRevisionId: 'maintenance-revision-1',
      acknowledgedPublicationRevisionId: 'maintenance-revision-2',
    } });
    await prisma.publishedPlaylist.create({ data: {
      id: 'maintenance-playlist', playlistId: 1, revision: 1, contentHash: 'hash',
      entries: { create: { ordinal: 0, itemId: 1, publicationRevisionId: 'maintenance-revision-3' } },
    } });
    await prisma.renderRequest.create({ data: {
      key: 'a'.repeat(64), publicationRevisionId: 'maintenance-revision-4', target: {}, rendererVersion: 'test-v1',
    } });
    for (const status of ['pending', 'processing', 'delivered', 'dead-letter']) {
      await prisma.outboxEvent.create({ data: {
        eventId: `retention-${status}`, eventType: 'test.retention', aggregateType: 'Test', aggregateId: status,
        payload: {}, status, occurredAt: old, processedAt: ['delivered', 'dead-letter'].includes(status) ? old : null,
      } });
    }
    await log();
    const result = await service.execute(event);
    expect(result).toEqual({ duplicate: false, deviceLogs: 1, deliveredOutboxEvents: 1,
      deadLetterOutboxEvents: 1, publicationRevisions: 1 });
    expect((await prisma.publicationRevision.findMany({ orderBy: { revision: 'asc' } })).map(row => row.revision))
      .toEqual([1, 2, 3, 4, 6, 7]);
    expect(await prisma.publication.count()).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventId: { in: ['retention-pending', 'retention-processing'] } } })).toBe(2);
  });

  test('drains retention in bounded transactions before completing its receipt', async () => {
    const event = await claim();
    const old = new Date(now.getTime() - 100 * DAY);
    await prisma.deviceLog.createMany({ data: Array.from({ length: MAINTENANCE_BATCH_SIZE + 1 }, () => ({
      deviceId, level: 'info', message: 'bounded-maintenance-fixture', createdAt: old,
    })) });
    await prisma.outboxEvent.createMany({ data: Array.from({ length: MAINTENANCE_BATCH_SIZE + 1 }, (_, index) => ({
      eventId: `bounded-delivered-${index}`, eventType: 'test.retention', aggregateType: 'Test',
      aggregateId: String(index), payload: {}, status: 'delivered', occurredAt: old, processedAt: old,
    })) });
    let logBatches = 0, publicationBatches = 0, firstBatch!: () => void;
    const firstBatchStarted = new Promise<void>(resolve => { firstBatch = resolve; });
    class CountingLogs extends LogCleanupService {
      override async cleanupBatch(at: Date, transaction: Prisma.TransactionClient) {
        logBatches++;
        const result = await super.cleanupBatch(at, transaction);
        if (logBatches === 1) firstBatch();
        return result;
      }
    }
    class CountingPublications extends PublicationCleanupService {
      override async cleanupBatch(at: Date, transaction: Prisma.TransactionClient, cursor?: string) {
        publicationBatches++;
        return super.cleanupBatch(at, transaction, cursor);
      }
    }
    const bounded = new MaintenanceService(prisma as PrismaService,
      new CountingLogs(prisma as PrismaService), new CountingPublications(prisma as PrismaService));
    const execution = bounded.execute(event);
    await firstBatchStarted;
    await sqliteWrite(prisma, () => prisma.setting.upsert({ where: { key: 'maintenance-interleave' },
      create: { key: 'maintenance-interleave', value: 'committed-between-batches' },
      update: { value: 'committed-between-batches' } }));
    expect(await execution).toEqual({
      duplicate: false, deviceLogs: MAINTENANCE_BATCH_SIZE + 1,
      deliveredOutboxEvents: MAINTENANCE_BATCH_SIZE + 1,
      deadLetterOutboxEvents: 0, publicationRevisions: 0,
    });
    expect(logBatches).toBeGreaterThanOrEqual(2);
    expect(publicationBatches).toBeGreaterThanOrEqual(2);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'maintenance-interleave' } })).value)
      .toBe('committed-between-batches');
    expect((await prisma.outboxEffect.findUniqueOrThrow({ where: { eventId: event.eventId } })).completedAt)
      .not.toBeNull();
  });

  test('persists its revision checkpoint and probes stragglers behind it before the receipt', async () => {
    const event = await claim(), old = new Date(now.getTime() - 100 * DAY);
    await prisma.publication.create({ data: {
      publicationId: 'checkpoint-publication', publicationKey: 'checkpoint',
    } });
    for (let index = 0; index < MAINTENANCE_BATCH_SIZE + 2; index++)
      await prisma.publicationRevision.create({ data: {
        publicationRevisionId: `checkpoint-${String(index).padStart(3, '0')}`,
        publicationId: 'checkpoint-publication', revision: index + 1,
        protocolVersion: '1.0', content: {}, contentHash: `checkpoint-hash-${index}`,
        publishedAt: old,
      } });
    let batches = 0;
    class InterruptedPublications extends PublicationCleanupService {
      override async cleanupBatch(at: Date, transaction: Prisma.TransactionClient, cursor?: string) {
        if (++batches === 2) throw new Error('CONTROLLED_CHECKPOINT_CRASH');
        return super.cleanupBatch(at, transaction, cursor);
      }
    }
    const interrupted = new MaintenanceService(prisma as PrismaService,
      new LogCleanupService(prisma as PrismaService), new InterruptedPublications(prisma as PrismaService));
    await expect(interrupted.execute(event)).rejects.toThrow('CONTROLLED_CHECKPOINT_CRASH');
    const checkpoint = await prisma.outboxEffect.findUniqueOrThrow({ where: { eventId: event.eventId } });
    expect(checkpoint.progressCursor).toBe(`checkpoint-${String(MAINTENANCE_BATCH_SIZE - 1).padStart(3, '0')}`);
    expect(checkpoint.completedAt).toBeNull();
    await other.publication.create({ data: {
      publicationId: '000-checkpoint-late-publication', publicationKey: 'checkpoint-late',
    } });
    await other.publicationRevision.createMany({ data: [{
      publicationRevisionId: '000-checkpoint-straggler', publicationId: '000-checkpoint-late-publication',
      revision: 1, protocolVersion: '1.0', content: {}, contentHash: 'checkpoint-straggler-hash', publishedAt: old,
    }, {
      publicationRevisionId: '000-checkpoint-latest', publicationId: '000-checkpoint-late-publication',
      revision: 2, protocolVersion: '1.0', content: {}, contentHash: 'checkpoint-latest-hash', publishedAt: old,
    }] });
    expect(await prisma.publicationRevision.count()).toBe(4);

    await prisma.$disconnect(); await prisma.$connect();
    await createService(prisma).execute(event);
    expect((await prisma.publicationRevision.findMany({
      select: { publicationRevisionId: true }, orderBy: { publicationRevisionId: 'asc' },
    }))).toEqual([
      { publicationRevisionId: '000-checkpoint-latest' },
      { publicationRevisionId: `checkpoint-${String(MAINTENANCE_BATCH_SIZE + 1).padStart(3, '0')}` },
    ]);
    expect(await prisma.outboxEffect.findUniqueOrThrow({ where: { eventId: event.eventId } }))
      .toMatchObject({ completedAt: expect.any(Date), progressCursor: null });
  });

  test('rolls back logs, retention and receipt together when a later delete fails', async () => {
    const event = await claim();
    await log();
    await prisma.outboxEvent.create({ data: {
      eventId: 'rollback-delivered', eventType: 'test', aggregateType: 'Test', aggregateId: 'rollback',
      payload: {}, status: 'delivered', processedAt: new Date(now.getTime() - 31 * DAY),
    } });
    await prisma.$executeRawUnsafe("CREATE TRIGGER maintenance_failure BEFORE DELETE ON outbox_events WHEN OLD.event_id = 'rollback-delivered' BEGIN SELECT RAISE(ABORT, 'forced maintenance failure'); END");
    await expect(service.execute(event)).rejects.toThrow();
    expect(await prisma.deviceLog.count()).toBe(1);
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: 'rollback-delivered' } })).not.toBeNull();
    expect(await prisma.outboxEffect.count()).toBe(0);
    await prisma.$executeRawUnsafe('DROP TRIGGER maintenance_failure');
    expect((await service.execute(event)).deviceLogs).toBe(1);
  });

  test('rejects malformed payloads and stale owners/tokens before retention writes', async () => {
    const event = await claim();
    await log();
    const malformed: Partial<OutboxEvent>[] = [
      { payloadVersion: 2 }, { aggregateType: 'Other' }, { aggregateId: 'other' }, { aggregateRevision: '0' },
      { eventType: 'other' }, { eventId: 'forged' }, { payload: null },
      { payload: { scheduledAt: now.getTime(), secret: 'sensitive-fixture' } },
      { payload: { scheduledAt: now.getTime() + 1 } }, { payload: { scheduledAt: 'secret' } },
    ];
    for (const patch of malformed) {
      await expect(service.execute({ ...event, ...patch })).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    }
    await expect(service.execute({ ...event, claimOwner: 'other-worker' })).rejects.toThrow('MAINTENANCE_STALE_CLAIM');
    await expect(service.execute({ ...event, claimToken: randomUUID() })).rejects.toThrow('MAINTENANCE_STALE_CLAIM');
    await prisma.outboxEvent.update({ where: { eventId: event.eventId }, data: { payload: { scheduledAt: 'tampered' } } });
    await expect(service.execute(event)).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    await prisma.outboxEvent.update({ where: { eventId: event.eventId }, data: { payload: event.payload as Prisma.InputJsonValue } });
    await prisma.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(0) } });
    await expect(service.execute(event)).rejects.toThrow('MAINTENANCE_STALE_CLAIM');
    expect(await prisma.deviceLog.count()).toBe(1);
    expect(await prisma.outboxEffect.count()).toBe(0);
  });

  test('aborts before work and rolls back an abort between cleanup stages without leaking its reason', async () => {
    const event = await claim();
    await log();
    const controller = new AbortController();
    controller.abort('sensitive-abort-reason');
    await expect(service.execute(event, controller.signal)).rejects.toThrow('MAINTENANCE_ABORTED');
    expect(await prisma.outboxEffect.count()).toBe(0);
    const midWork = new AbortController();
    class AbortingLogs extends LogCleanupService {
      override async cleanupBatch(at: Date, transaction: Prisma.TransactionClient) {
        const result = await super.cleanupBatch(at, transaction);
        midWork.abort('sensitive-abort-reason');
        return result;
      }
    }
    const interrupted = createService(prisma, new AbortingLogs(prisma as PrismaService));
    await expect(interrupted.execute(event, midWork.signal)).rejects.toThrow('MAINTENANCE_ABORTED');
    expect(await prisma.deviceLog.count()).toBe(1);
    expect(await prisma.outboxEffect.count()).toBe(0);
  });

  test('rechecks the lease before commit and rolls back expired in-flight work', async () => {
    const event = await claim();
    await log();
    class ExpiringLogs extends LogCleanupService {
      override async cleanupBatch(at: Date, transaction: Prisma.TransactionClient) {
        const result = await super.cleanupBatch(at, transaction);
        await transaction.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(0) } });
        return result;
      }
    }
    const expiring = createService(prisma, new ExpiringLogs(prisma as PrismaService));
    await expect(expiring.execute(event)).rejects.toThrow('MAINTENANCE_STALE_CLAIM');
    expect(await prisma.deviceLog.count()).toBe(1);
    expect(await prisma.outboxEffect.count()).toBe(0);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).claimUntil).toEqual(event.claimUntil);
  });

  test('preserves standalone cleanup entrypoints and rejects invalid scheduling timestamps', async () => {
    await log();
    expect(await new LogCleanupService(prisma as PrismaService).cleanup(now)).toEqual({ deleted: 1 });
    expect(await new PublicationCleanupService(prisma as PrismaService).cleanup(now))
      .toEqual({ deliveredOutboxEvents: 0, deadLetterOutboxEvents: 0, publicationRevisions: 0 });
    await expect(service.schedule(new Date(NaN))).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    await expect(service.schedule(new Date(-1))).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});
