import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { createCorrelationContext, currentCorrelation, runWithCorrelation } from '../src/observability/correlation-context';
import { outboxCorrelation } from '../src/events/outbox-correlation';
import { OutboxStore } from '../src/events/outbox.store';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import { EventsService } from '../src/events/events.service';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { TimerService } from '../src/timers/timer.service';
import { TimerWorkerService } from '../src/timers/timer-worker.service';
import { TIMER_CHANGED } from '../src/timers/timer.events';
import { TIMER_DUE } from '../src/timers/timer-scheduling';
import { MaintenanceService } from '../src/jobs/maintenance.service';
import { scheduleSource, SOURCE_REFRESH } from '../src/sources/source-job';
import { scheduleRemote, REMOTE_SYNC } from '../src/federation/remote-job';
import { PlaybackService } from '../src/playback/playback.service';
import { DeviceUpdateCoordinator } from '../src/device-platform/device-update-coordinator.service';

const root = resolve(import.meta.dir, '..');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

describe('WP-28 durable API/outbox/worker/delivery correlation', () => {
  let directory: string, url: string, p: PrismaClient, store: OutboxStore, timers: TimerService;
  let device: { deviceId: number; externalId: string }, now: number, writes: string[];
  let logs: ReturnType<typeof spyOn>, warnings: ReturnType<typeof spyOn>;
  const clock = { now: () => now };
  async function connect() {
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    p.$on('query' as never, (event: { query: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
    });
    await p.$connect();
    store = new OutboxStore(p as PrismaService);
    timers = new TimerService(p as PrismaService, clock);
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-correlation-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const child = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stdout + stderr).toBe(0);
    writes = []; now = Date.now(); await connect();
    const row = await p.device.create({ data: { name: 'correlation fixture', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    device = { deviceId: row.id, externalId: row.externalId! };
    logs = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warnings = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  }, 30_000);
  afterEach(async () => {
    logs?.mockRestore(); warnings?.mockRestore(); await p?.$disconnect();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-correlation-'))
      throw new Error('Unsafe correlation fixture cleanup path');
    rmSync(target, { recursive: true, force: true });
  });
  const publisher = () => new PublishService(p as PrismaService, new PublicationPersistenceService(p as PrismaService));
  const createTimer = () => p.$transaction(tx => timers.executeInTransaction(tx, device, 'create',
    { version: 1, visibility: 'private', durationMs: 1000 }));
  function dispatcher() {
    const worker = new TimerWorkerService(p as PrismaService, timers, clock);
    const result = new OutboxDispatcher(p as PrismaService, store, {} as never, {} as never, {} as never,
      {} as never, {} as never, worker, {} as never);
    (result as unknown as { stopped: boolean }).stopped = true;
    return result;
  }

  test('publication intent is atomic, request scoped and stable on command replay', async () => {
    const context = createCorrelationContext(), command = { idempotencyKey: randomUUID(), expectedRevision: 0,
      deviceIds: [device.deviceId], draft: { fixtureArtifacts: ['mono-800x480-white-png'] } };
    const first = await runWithCorrelation(context, () => publisher().publish('request-publication', command));
    const rows = await p.outboxEvent.findMany();
    expect(rows.length).toBe(2);
    expect(rows.every(row => row.correlationId === context.correlationId)).toBe(true);
    const second = await runWithCorrelation(createCorrelationContext(), () => publisher().publish('request-publication', command));
    expect(second).toEqual(first); expect(await p.outboxEvent.findMany()).toEqual(rows);
    await runWithCorrelation(createCorrelationContext(), () => publisher().publish('independent', { ...command,
      idempotencyKey: randomUUID(), deviceIds: [] }));
    const later = await p.outboxEvent.findMany({ where: { eventId: { notIn: rows.map(row => row.eventId) } } });
    expect(later[0].correlationId).toMatch(uuid); expect(later[0].correlationId).not.toBe(context.correlationId);
  });

  test('timer state, changed event and delayed intent roll back together', async () => {
    await expect(runWithCorrelation(createCorrelationContext(), () => p.$transaction(async tx => {
      await timers.executeInTransaction(tx, device, 'create', { version: 1, visibility: 'private', durationMs: 1000 });
      throw new Error('late transaction failure');
    }))).rejects.toThrow('late transaction failure');
    expect(await p.timer.count()).toBe(0); expect(await p.outboxEvent.count()).toBe(0);
    const timer = await createTimer();
    const events = await p.outboxEvent.findMany({ where: { aggregateId: timer.timerId } });
    expect(events).toHaveLength(2); expect(events[0].correlationId).toMatch(uuid);
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test('a restarted worker restores the database UUID and descendants inherit it despite queue metadata', async () => {
    const context = createCorrelationContext(), timer = await runWithCorrelation(context, createTimer);
    await p.$disconnect(); await connect(); now += 1001;
    const event = await store.claim('restarted-worker', new Date(now), { eventType: TIMER_DUE });
    expect(event).not.toBeNull(); expect(event!.correlationId).toBe(context.correlationId);
    const job = { version: 1 as const, eventId: event!.eventId, claimToken: event!.claimToken!, correlationId: randomUUID() };
    await runWithCorrelation(createCorrelationContext(), () => dispatcher().dispatch(job, undefined, 'timer'));
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).status).toBe('completed');
    const child = await p.outboxEvent.findFirstOrThrow({ where: { aggregateId: timer.timerId, eventType: TIMER_CHANGED, aggregateRevision: '2' } });
    expect(child.correlationId).toBe(context.correlationId);
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event!.eventId } })).status).toBe('delivered');
    expect(logs.mock.calls.some(call => call[0].code === 'JOB_COMPLETED' && call[0].correlationId === context.correlationId)).toBe(true);
    expect(currentCorrelation()).toBeUndefined();
  });

  test('late outbox failure rolls back a correlated timer completion without a partial follow-up event', async () => {
    const timer = await runWithCorrelation(createCorrelationContext(), createTimer);
    await p.$executeRawUnsafe("CREATE TRIGGER fail_correlated_completion BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'timer.state.changed' AND NEW.aggregate_revision = '2' BEGIN SELECT RAISE(ABORT, 'FIXTURE_FAILURE'); END");
    now += 1001;
    const event = await store.claim('worker', new Date(now), { eventType: TIMER_DUE });
    await dispatcher().dispatch({ version: 1, eventId: event!.eventId, claimToken: event!.claimToken! }, undefined, 'timer');
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).status).toBe('running');
    expect(await p.outboxEvent.count({ where: { aggregateRevision: '2' } })).toBe(0);
    expect(await p.outboxEffect.count()).toBe(0);
    const failed = await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event!.eventId } });
    expect(failed.status).toBe('pending');
    expect(JSON.parse(failed.lastError!)).toMatchObject({ correlationId: event!.correlationId, eventId: event!.eventId });
  });

  test('delivery reloads durable context and preserves correlation plus delivery identity over retry', async () => {
    const context = createCorrelationContext(); await runWithCorrelation(context, createTimer);
    const seen: Array<{ context: unknown; metadata: unknown }> = [];
    let fail = true;
    const coordinator = new DeviceUpdateCoordinator(new EventsService(p as PrismaService), p as PrismaService,
      { resolvePersisted: () => ({ capabilities: {}, deliveryPolicy: { mode: 'connected' } }) } as never,
      { get: () => ({ dispatchOnRefresh: true, selectTransport: () => 'websocket' }) } as never,
      { list: () => [], get: () => ({ dispatchRefresh: async (_deviceId: number, metadata: unknown) => {
        seen.push({ context: currentCorrelation(), metadata });
        if (fail) throw new Error('private-adapter-secret');
      } }) } as never, store);
    Object.assign(coordinator, { active: true, leaseUntil: Date.now() + 60_000, renewAt: Date.now() + 60_000 });
    await store.register(coordinator.consumerId);
    const first = (await store.claim('delivery-worker', new Date(), { eventType: TIMER_CHANGED }))!;
    await store.prepare(first); await coordinator.poll();
    expect(await store.fail(first, 'OUTBOX_TRANSPORT_FAILED')).toBe(true);
    fail = false;
    const retry = (await store.claim('delivery-retry', new Date(Date.now() + 10_000), { eventId: first.eventId }))!;
    expect(retry.claimToken).not.toBe(first.claimToken);
    await coordinator.poll();
    expect(seen).toHaveLength(2);
    expect(seen[1].context).toEqual(seen[0].context);
    expect(seen[0].context).toMatchObject({ correlationId: context.correlationId, eventId: first.eventId, deviceId: device.deviceId });
    expect(seen[0].metadata).toMatchObject({ correlationId: context.correlationId, eventId: first.eventId, stateTopic: 'timers' });
    expect((await p.outboxTarget.findFirstOrThrow()).delivered).toBe(true);
    expect(await store.ack(first)).toBe(false); expect(await store.ack(retry)).toBe(true);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-adapter-secret');
    // An adapter's successful no-op is not evidence that bytes reached a socket.
    expect(logs.mock.calls.some(call => call[0].code === 'DEVICE_DELIVERED')).toBe(false);
    expect(currentCorrelation()).toBeUndefined();
  });

  test('legacy fallback is identical across processes and reads never backfill old rows', async () => {
    const event = await p.outboxEvent.create({ data: { eventId: 'legacy-event-without-uuid', eventType: 'device:refresh',
      aggregateType: 'Device', aggregateId: String(device.deviceId), aggregateRevision: '1', payloadVersion: 1,
      payload: { deviceIds: [device.deviceId], timestamp: Date.now() } } });
    const expected = outboxCorrelation(event);
    writes = [];
    for (let index = 0; index < 3; index++) expect(outboxCorrelation(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } }))).toEqual(expected);
    expect(writes).toEqual([]);
    const program = "import { PrismaClient } from '@prisma/client'; import { outboxCorrelation } from './src/events/outbox-correlation.ts'; const p = new PrismaClient(); try { const e = await p.outboxEvent.findUniqueOrThrow({ where: { eventId: process.env.EVENT_ID } }); process.stdout.write(JSON.stringify(outboxCorrelation(e))); } finally { await p.$disconnect(); }";
    const child = Bun.spawn([process.execPath, '-e', program], { cwd: root,
      env: { ...process.env, DATABASE_URL: url, EVENT_ID: event.eventId }, stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual(expected);
    } finally { clearTimeout(timeout); }
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).correlationId).toBeNull();
    const claimed = (await store.claim('worker', new Date(), { eventId: event.eventId }))!;
    await store.fail(claimed, 'OUTBOX_TRANSPORT_FAILED');
    const row = await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
    expect(row.correlationId).toBeNull(); expect(JSON.parse(row.lastError!)).toMatchObject(expected);
  });

  test('SQL validates canonical UUIDs and neither active nor legacy identity can be relabelled', async () => {
    const context = createCorrelationContext(); await runWithCorrelation(context, createTimer);
    const row = await p.outboxEvent.findFirstOrThrow();
    for (const correlationId of ['not-a-uuid', context.correlationId.toUpperCase(), '-'.repeat(36)]) {
      await expect(Promise.resolve(p.outboxEvent.create({ data: { eventType: 'fixture', aggregateType: 'Fixture', aggregateId: 'fixture', payload: {}, correlationId } }))).rejects.toThrow();
    }
    await expect(Promise.resolve(p.outboxEvent.update({ where: { eventId: row.eventId }, data: { correlationId: randomUUID() } }))).rejects.toThrow();
    await expect(Promise.resolve(p.outboxEvent.update({ where: { eventId: row.eventId }, data: { correlationId: null } }))).rejects.toThrow();
    const legacy = await p.outboxEvent.create({ data: { eventType: 'fixture', aggregateType: 'Fixture', aggregateId: 'legacy', payload: {} } });
    await expect(Promise.resolve(p.outboxEvent.update({ where: { eventId: legacy.eventId }, data: { correlationId: randomUUID() } }))).rejects.toThrow();
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: row.eventId } })).correlationId).toBe(context.correlationId);
  });

  test('source, remote, legacy refresh and maintenance producers persist context without rewriting deduplicated intents', async () => {
    const source = await p.sourceDefinition.create({ data: { name: 'source', connectorType: 'fixture', schemaVersion: '1',
      configuration: { data: {} }, refreshIntervalSeconds: 60, timeoutMs: 1000, concurrencyGroup: 'fixture', nextRefreshAt: new Date(now) } });
    const server = await p.remoteServer.create({ data: { serverId: randomUUID(), baseUrl: 'https://remote.example', trusted: true } });
    const credential = await p.remoteCredential.create({ data: { ciphertext: 'fixture-encrypted-credential' } });
    const publication = await p.publication.create({ data: { publicationKey: 'remote-fixture' } });
    const remote = await p.remoteSubscription.create({ data: { name: 'remote', remoteServerId: server.remoteServerId,
      remotePublicationId: 'remote-publication', credentialId: credential.credentialId, localPublicationId: publication.publicationId, nextSyncAt: new Date(now) } });
    const maintenance = new MaintenanceService(p as PrismaService, {} as never, {} as never);
    const context = createCorrelationContext();
    await runWithCorrelation(context, async () => {
      await p.$transaction(tx => scheduleSource(tx, source, new Date(now)));
      await p.$transaction(tx => scheduleRemote(tx, remote, new Date(now)));
      await new EventsService(p as PrismaService).notifyDevicesRefresh([device.deviceId]);
      await maintenance.schedule(new Date(now));
    });
    const rows = await p.outboxEvent.findMany(); expect(rows).toHaveLength(4);
    expect(rows.every(row => row.correlationId === context.correlationId && row.eventId !== row.correlationId)).toBe(true);
    expect(rows.map(row => row.eventType)).toEqual(expect.arrayContaining([SOURCE_REFRESH, REMOTE_SYNC, 'device:refresh', 'maintenance.cleanup.due']));
    await runWithCorrelation(createCorrelationContext(), async () => {
      await p.$transaction(tx => scheduleSource(tx, source, new Date(now), true));
      await p.$transaction(tx => scheduleRemote(tx, remote, new Date(now), true));
      writes = []; await maintenance.schedule(new Date(now)); expect(writes).toEqual([]);
    });
    expect(await p.outboxEvent.findMany()).toEqual(rows);
  });

  test('playback changed, next deadline and desired publication inherit one API intent', async () => {
    const published = await publisher().publish('playback-publication', { idempotencyKey: randomUUID(), expectedRevision: 0,
      deviceIds: [], draft: { fixtureArtifacts: ['mono-800x480-white-png'] } }) as { publicationRevisionId: string };
    const playlist = await p.playlist.create({ data: { name: 'playlist', items: { create: [
      { duration: 10, order: 0 }, { duration: 20, order: 1 },
    ] } }, include: { items: { orderBy: { order: 'asc' } } } });
    const playback = new PlaybackService(p as PrismaService, new PublicationPersistenceService(p as PrismaService), clock);
    const release = await playback.publish(playlist.id, { version: 1, idempotencyKey: randomUUID(), expectedRevision: 0,
      expectedDraftHash: (await playback.draft(playlist.id)).draftHash,
      bindings: playlist.items.map(item => ({ itemId: item.id, publicationRevisionId: published.publicationRevisionId })) }) as { playlistRevisionId: string };
    const before = (await p.outboxEvent.findMany()).map(row => row.eventId), context = createCorrelationContext();
    await runWithCorrelation(context, () => playback.execute(device.deviceId, { version: 1, idempotencyKey: randomUUID(),
      action: 'start', expectedVersion: 0, expectedDesiredSequence: 0, playlistRevisionId: release.playlistRevisionId }));
    const events = await p.outboxEvent.findMany({ where: { eventId: { notIn: before } } });
    expect(events).toHaveLength(3); expect(events.every(row => row.correlationId === context.correlationId)).toBe(true);
  });
});
