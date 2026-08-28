import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import request from 'supertest';
import { OPERATIONS_LIMITS, OPERATIONS_QUEUE_NAMES, parseOperationsStatus } from '@inker/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { OperationsService } from '../src/observability/operations.service';
import { OperationsController } from '../src/observability/operations.controller';
import { MetricsRegistry } from '../src/observability/metrics-registry';
import { parseWorkerMetricSample, workerMetricSample, workerSampleFresh, type WorkerMetricReading } from '../src/observability/worker-metrics';
import { observeRequest } from '../src/observability/runtime-observability';
import { OutboxRedisService } from '../src/events/outbox-redis.service';
import { WebDisplayGateway } from '../src/device-platform/web-display.gateway';
import { PullDeviceAuthService } from '../src/device-platform/pull-device-auth.service';
import { AdminSessionService } from '../src/auth/admin-session.service';
import { PinAuthGuard } from '../src/auth/guards/pin-auth.guard';
import { ADMIN_SESSION_COOKIE } from '../src/auth/session-cookie';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

const root = resolve(import.meta.dir, '..');
const marker = 'synthetic-operations-secret-never-output';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
const eventTypes = ['source.refresh.due', 'render.requested', 'device.publication.desired', 'timer.completion.due', 'maintenance.cleanup.due', 'remote.sync.due'];

describe('WP-28 isolated operations metadata and HTTP boundaries', () => {
  let directory: string, p: PrismaClient, extra: PrismaClient | undefined, app: INestApplication | undefined;
  let writes: string[], queries: string[], logs: unknown[], now: number;
  let background: { status: string; redis: string; workers: number | null };
  let samples: WorkerMetricReading[] | null, connected: Set<number>, gatewayFailed: boolean, sampleReads: number;
  let logSpy: ReturnType<typeof spyOn>, warnSpy: ReturnType<typeof spyOn>;
  const freshService = (database: PrismaClient = p) => new OperationsService(database as PrismaService, {
    backgroundStatus: async () => background,
    workerMetricSamples: async () => { sampleReads++; return samples; },
  } as unknown as OutboxRedisService, {
    isConnected: (id: number) => connected.has(id),
    metrics: () => {
      if (gatewayFailed) throw new Error(marker);
      return { connections: 2, authenticatedConnections: 1, devices: 1,
        accepted: 5, authenticated: 3, authRejected: 1, protocolRejected: 0, rateLimited: 0,
        livenessTimeouts: 2, operationErrors: 0, closed: 3, pongs: 8, telemetryMessages: 4 };
    },
  } as unknown as WebDisplayGateway);

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-operations-'));
    const url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const migration = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    writes = []; queries = []; logs = []; now = Date.now(); extra = undefined; app = undefined;
    p.$on('query' as never, (event: { query: string }) => {
      queries.push(event.query);
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
    });
    await p.$connect();
    await p.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await p.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    background = { status: 'ready', redis: 'ready', workers: 1 };
    const registry = new MetricsRegistry(); registry.recordRender('hit'); registry.recordJob('render', 'success', 125);
    const sample = parseWorkerMetricSample(workerMetricSample(registry.snapshot(), now), now);
    expect(sample).not.toBeNull(); samples = [{ owner: 'operations-test-worker', sample: sample! }];
    connected = new Set(); gatewayFailed = false; sampleReads = 0;
    logSpy = spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => { logs.push(args); });
    warnSpy = spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => { logs.push(args); });
  }, 30_000);

  afterEach(async () => {
    await app?.close();
    await Promise.all([p?.$disconnect(), extra?.$disconnect()]);
    logSpy?.mockRestore(); warnSpy?.mockRestore();
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-operations-')) throw new Error('Unsafe operations cleanup');
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function digest(excludeSessions = false) {
    const tables = await p.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const result = createHash('sha256');
    for (const { name } of tables) {
      if (excludeSessions && name === 'admin_sessions') continue;
      if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Unexpected fixture table');
      const rows = await p.$queryRawUnsafe(`SELECT * FROM "${name}"`);
      result.update(name).update(stringify(rows));
    }
    return result.digest('hex');
  }
  async function event(eventType: string, overrides: Partial<Prisma.OutboxEventUncheckedCreateInput> = {}) {
    return p.outboxEvent.create({ data: { eventType, aggregateType: 'Fixture', aggregateId: randomUUID(),
      payload: { privateData: marker }, occurredAt: new Date(now), availableAt: new Date(now), ...overrides } });
  }
  async function device(overrides: Partial<Prisma.DeviceUncheckedCreateInput> = {}) {
    return p.device.create({ data: { name: marker, externalId: randomUUID(), deviceType: 'web-display', transport: 'websocket',
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser', ...overrides } });
  }
  async function publication() {
    const publication = await p.publication.create({ data: { publicationKey: randomUUID() } });
    const content = { schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-png'] };
    const revision = await p.publicationRevision.create({ data: { publicationId: publication.publicationId,
      revision: 1, protocolVersion: '1.0', content, contentHash: hash(stringify(content)) } });
    return { publication, revision };
  }
  async function source(overrides: Partial<Prisma.SourceDefinitionUncheckedCreateInput> = {}) {
    return p.sourceDefinition.create({ data: { name: marker, connectorType: 'fixture', schemaVersion: '1.0',
      configuration: { privateData: marker }, transformationCode: marker, refreshIntervalSeconds: 60,
      timeoutMs: 500, concurrencyGroup: 'fixture', nextRefreshAt: new Date(now + 60_000), ...overrides } });
  }
  async function remote(overrides: Partial<Prisma.RemoteSubscriptionUncheckedCreateInput> = {}) {
    const { publication: pub, revision } = await publication();
    const server = await p.remoteServer.create({ data: { baseUrl: `https://${randomUUID()}.invalid`, serverId: randomUUID(), trusted: true } });
    const credential = await p.remoteCredential.create({ data: { ciphertext: marker } });
    const subscription = await p.remoteSubscription.create({ data: { name: marker, remoteServerId: server.remoteServerId,
      remotePublicationId: randomUUID(), credentialId: credential.credentialId, localPublicationId: pub.publicationId,
      nextSyncAt: new Date(now + 60_000), latestLocalRevisionId: revision.publicationRevisionId, ...overrides } });
    return subscription;
  }

  test('all six queues distinguish due, delayed, processing, expired and dead jobs with real elapsed ages', async () => {
    for (const type of eventTypes) {
      await event(type, { availableAt: new Date(now - 120_000) });
      await event(type, { availableAt: new Date(now - 10_000) });
      await event(type, { availableAt: new Date(now + 120_000) });
      await event(type, { status: 'processing', lastAttemptAt: new Date(now - 20_000), claimUntil: new Date(now + 30_000), attempts: 1 });
      await event(type, { status: 'processing', lastAttemptAt: new Date(now - 45_000), claimUntil: new Date(now - 1000), attempts: 2 });
      await event(type, { status: 'dead-letter', processedAt: new Date(now), lastError: 'OUTBOX_ATTEMPTS_EXHAUSTED', attempts: 5 });
      await event(type, { status: 'delivered', processedAt: new Date(now), availableAt: new Date(now - 10_000_000) });
    }
    const service = freshService(), before = await digest(); writes.length = 0;
    const status = await service.status(), sampled = Date.parse(status.generatedAt);
    expect(parseOperationsStatus(status).success).toBe(true);
    expect(status.queues.map(row => row.queue)).toEqual([...OPERATIONS_QUEUE_NAMES]);
    for (const queue of status.queues) {
      expect(queue).toMatchObject({ pending: 2, delayed: 1, processing: 2, expiredClaims: 1, deadLetters: 1 });
      expect(queue.oldestDueAgeSeconds).toBe((sampled - now + 120_000) / 1000);
      expect(queue.oldestProcessingAgeSeconds).toBe((sampled - now + 45_000) / 1000);
    }
    expect(status.reasons).toContain('QUEUE_BACKLOG'); expect(status.reasons).toContain('DEAD_LETTERS');
    const text = await service.metrics();
    expect(text).toContain('statuspanel_worker_sample_available 1');
    expect(text.includes(marker)).toBe(false); expect(stringify(status).includes(marker)).toBe(false);
    expect(writes).toEqual([]); expect(await digest()).toBe(before);
  });

  test('source, device and remote activity derives from persisted last-good state without exposing data or credentials', async () => {
    const good = new Date(now - 120_000), attempt = new Date(now - 1000);
    const old = await source({ lastAttemptAt: attempt, lastSuccessAt: good });
    const snapshot = await p.sourceSnapshot.create({ data: { sourceDefinitionId: old.sourceDefinitionId,
      definitionVersion: 1, revision: 1, schemaVersion: '1.0', connectorVersion: 'fixture-v1',
      validDataCreatedAt: good, freshnessState: 'fresh', staleAfterSeconds: 60, data: { privateData: marker },
      contentHash: hash(marker), refreshEventId: randomUUID(), attempt: 1 } });
    await p.sourceDefinition.update({ where: { sourceDefinitionId: old.sourceDefinitionId }, data: { latestSnapshotId: snapshot.snapshotId } });
    const missing = await source();
    const failed = await source({ consecutiveFailures: 1, lastAttemptAt: attempt });
    const failureSnapshot = await p.sourceSnapshot.create({ data: { sourceDefinitionId: failed.sourceDefinitionId,
      definitionVersion: 1, revision: 1, schemaVersion: '1.0', connectorVersion: 'fixture-v1',
      freshnessState: 'error', staleAfterSeconds: 60, data: Prisma.JsonNull, contentHash: hash('null'),
      errorCode: 'SOURCE_TIMEOUT', retryable: true, refreshEventId: randomUUID(), attempt: 1 } });
    await p.sourceDefinition.update({ where: { sourceDefinitionId: failed.sourceDefinitionId }, data: { latestSnapshotId: failureSnapshot.snapshotId } });
    const browser = await device({ lastSeenAt: new Date(now - 3_700_000), lastConnectedAt: good });
    const unseen = await device({ deviceType: 'trmnl', profileId: 'trmnl-byod-7.5-mono', deliveryPolicyId: 'reference-responsive-pull' });
    const current = await device({ lastSeenAt: attempt }); connected.add(current.id);
    const { revision } = await publication();
    await p.devicePublicationState.create({ data: { deviceId: current.id, desiredPublicationRevisionId: revision.publicationRevisionId,
      acknowledgedPublicationRevisionId: revision.publicationRevisionId, acknowledgedAt: attempt } });
    const revoked = await remote({ lastAttemptAt: attempt, lastSuccessAt: good, lastErrorCode: 'REMOTE_UNAUTHORIZED' });
    const pending = await remote({ latestLocalRevisionId: null });
    const disabled = await remote({ enabled: false, lastErrorCode: marker });
    const before = await digest(); writes.length = 0;
    const status = await freshService().status();
    expect(status.sources.items.find(row => row.sourceDefinitionId === old.sourceDefinitionId)).toMatchObject({ freshness: 'stale', lastSuccessAt: good.toISOString() });
    expect(status.sources.items.find(row => row.sourceDefinitionId === missing.sourceDefinitionId)).toMatchObject({ freshness: 'missing', ageSeconds: null, lastSuccessAt: null });
    expect(status.sources.items.find(row => row.sourceDefinitionId === failed.sourceDefinitionId)).toMatchObject({ freshness: 'error', errorCode: 'SOURCE_TIMEOUT', ageSeconds: null });
    expect(status.devices.items.find(row => row.deviceId === browser.id)).toMatchObject({ state: 'stale', connection: 'disconnected' });
    expect(status.devices.items.find(row => row.deviceId === unseen.id)).toMatchObject({ state: 'unseen', connection: 'not-applicable', ageSeconds: null });
    expect(status.devices.items.find(row => row.deviceId === current.id)).toMatchObject({ state: 'active', connection: 'connected', publicationState: 'current', acknowledgedAt: attempt.toISOString() });
    expect(status.remotes.items.find(row => row.subscriptionId === revoked.subscriptionId)).toMatchObject({ status: 'stale', errorCode: 'REMOTE_UNAUTHORIZED' });
    expect(status.remotes.items.find(row => row.subscriptionId === pending.subscriptionId)).toMatchObject({ status: 'pending', ageSeconds: null });
    expect(status.remotes.items.find(row => row.subscriptionId === disabled.subscriptionId)).toMatchObject({ status: 'disabled', errorCode: 'UNKNOWN_FAILURE' });
    expect(status.reasons).toContain('REMOTE_ERRORS'); expect(status.reasons).toContain('STALE_DEVICES'); expect(status.reasons).toContain('SOURCE_ERRORS');
    const serialized = stringify(status);
    expect(serialized.includes(marker)).toBe(false); expect(serialized).not.toMatch(/https:|configuration|ciphertext|transformationCode|privateData/);
    expect(writes).toEqual([]); expect(await digest()).toBe(before);
  });

  test('100-row pages retain real totals and complete device metric gauges beyond the visible page', async () => {
    await p.device.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ name: marker, externalId: `ops-${index}`,
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser',
      lastSeenAt: index < 100 ? new Date(now) : new Date(now - 7_200_000) })) });
    await p.sourceDefinition.createMany({ data: Array.from({ length: 105 }, () => ({ sourceDefinitionId: randomUUID(), name: marker,
      connectorType: 'fixture', schemaVersion: '1.0', configuration: {}, refreshIntervalSeconds: 60,
      timeoutMs: 500, concurrencyGroup: 'fixture', nextRefreshAt: new Date(now) })) });
    await p.outboxEvent.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ eventId: `dead-${index}`,
      eventType: 'render.requested', aggregateType: 'Fixture', aggregateId: String(index), payload: { marker },
      status: 'dead-letter', processedAt: new Date(now), lastError: 'RENDER_FAILED', attempts: 5 })) });
    const service = freshService(); const status = await service.status();
    for (const collection of [status.devices, status.sources, status.deadLetters]) {
      expect(collection.items).toHaveLength(100); expect(collection.total).toBe(105); expect(collection.truncated).toBe(true);
    }
    expect(status.devices.items.every(row => row.state === 'active')).toBe(true);
    expect(status.reasons).toContain('STALE_DEVICES');
    expect(status.queues.find(row => row.queue === 'render')?.deadLetters).toBe(105);
    expect(Buffer.byteLength(stringify(status))).toBeLessThanOrEqual(OPERATIONS_LIMITS.bytes);
    const metrics = await service.metrics();
    expect(metrics).toMatch(/statuspanel_device_active\{mode="connected"\} 105/);
    expect(metrics).toMatch(/statuspanel_device_stale\{mode="connected"\} 5/);
    expect(metrics.includes(marker)).toBe(false);
  });

  test('dead letters retain fixed codes and correlation IDs from structured stored failures, never raw errors', async () => {
    const correlationId = randomUUID();
    const structured = await event('render.requested', { status: 'dead-letter', processedAt: new Date(now), correlationId,
      lastError: stringify({ code: 'RENDER_FAILED', correlationId, message: marker }), attempts: 5 });
    const unknown = await event('remote.sync.due', { status: 'dead-letter', processedAt: new Date(now), lastError: marker, attempts: 5 });
    const status = await freshService().status();
    expect(status.deadLetters.items.find(row => row.eventId === structured.eventId)).toMatchObject({ correlationId, errorCode: 'RENDER_FAILED' });
    expect(status.deadLetters.items.find(row => row.eventId === unknown.eventId)).toMatchObject({ correlationId: null, errorCode: 'UNKNOWN_FAILURE' });
    expect(stringify(status).includes(marker)).toBe(false); expect(stringify(logs).includes(marker)).toBe(false);
  });

  test('unknown worker metrics differ from measured zero while durable queue state remains available during Redis loss', async () => {
    background = { status: 'degraded', redis: 'unavailable', workers: null }; samples = null;
    const service = freshService(), status = await service.status();
    expect(status.status).toBe('degraded'); expect(status.health.apiReady).toBe(true);
    expect(status.health.workers).toEqual({ status: 'unknown', count: null, sampledAt: null });
    expect(status.queues.every(row => row.pending === 0 && row.sampledAt !== null)).toBe(true);
    expect(status.sources).toMatchObject({ total: 0, items: [], truncated: false });
    expect(status.renderCache).toMatchObject({ sampledAt: null, hits: null, misses: null });
    const metrics = await service.metrics();
    expect(metrics).toContain('statuspanel_worker_sample_available 0');
    expect(metrics).not.toMatch(/^statuspanel_render_cache_total\{/m);
    expect(metrics).not.toMatch(/^statuspanel_job_duration_seconds_/m);
    background = { status: 'degraded', redis: 'ready', workers: 0 }; samples = [];
    const stopped = await freshService().status();
    expect(stopped.health.workers).toMatchObject({ status: 'unavailable', count: 0 });
    expect(stopped.reasons).toContain('WORKER_UNAVAILABLE');
    background.workers = 1; samples = null;
    const absent = await freshService().status();
    expect(absent.health.workers.status).toBe('ready'); expect(absent.renderCache.hits).toBeNull();
    expect(absent.reasons).toContain('METRICS_UNAVAILABLE');
  });

  test('a worker sample that expires during actual SQLite metadata reads becomes unknown after I/O', async () => {
    let clock = now, advancedDuringRead = false, observeReads = true;
    samples![0].sample.sampledAt = clock - 7900;
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    p.$on('query' as never, (event: { query: string }) => {
      if (observeReads && !advancedDuringRead && /^\s*SELECT\b/i.test(event.query) && event.query.includes('source_definitions')) {
        advancedDuringRead = true; clock += 200;
      }
    });
    try {
      expect(workerSampleFresh(samples![0].sample)).toBe(true);
      const service = freshService(), status = await service.status();
      expect(advancedDuringRead).toBe(true);
      expect(status.health.apiReady).toBe(true);
      expect(status.sources.total).toBe(0);
      expect(status.queues.every(row => row.pending === 0)).toBe(true);
      expect(status.renderCache).toEqual({ sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null });
      expect(status.reasons).toContain('METRICS_UNAVAILABLE');
      const metrics = await service.metrics();
      expect(metrics).toContain('statuspanel_worker_sample_available 0');
      expect(metrics).not.toMatch(/^statuspanel_render_cache_total\{/m);
      expect(metrics).not.toMatch(/^statuspanel_job_duration_seconds_/m);
    } finally { observeReads = false; time.mockRestore(); }
  });

  test('the status cache expires with its oldest worker sample before the normal cache lifetime', async () => {
    let clock = now;
    samples![0].sample.sampledAt = clock - 7900;
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const service = freshService(), first = await service.status();
      expect(first.status).toBe('healthy');
      expect(first.renderCache.hits).toBe(1);
      expect(sampleReads).toBe(1);
      clock += 200;
      const expired = await service.status();
      expect(sampleReads).toBe(2);
      expect(expired.status).toBe('degraded');
      expect(expired.renderCache).toEqual({ sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null });
      expect(expired.reasons).toContain('METRICS_UNAVAILABLE');
      const metrics = await service.metrics();
      expect(metrics).toContain('statuspanel_worker_sample_available 0');
      expect(metrics).not.toMatch(/^statuspanel_render_cache_total\{/m);
      expect(metrics).not.toMatch(/^statuspanel_job_duration_seconds_/m);
    } finally { time.mockRestore(); }
  });

  test('an actually unavailable SQLite database is distinct from a failed metadata query with a healthy SELECT 1 probe', async () => {
    extra = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'missing-parent', 'unavailable.db').replaceAll('\\', '/')}` } } });
    const unavailable = await freshService(extra).status();
    expect(unavailable.status).toBe('unavailable'); expect(unavailable.health).toMatchObject({ apiReady: false, database: 'unavailable' });
    expect(unavailable.devices).toEqual({ sampledAt: null, total: null, items: [], truncated: false });
    expect(unavailable.queues.every(row => row.pending === null)).toBe(true);
    // Real schema fault in this test's own migrated database, not an ORM proxy mock.
    await p.$executeRawUnsafe('ALTER TABLE source_definitions RENAME TO operations_unavailable_sources');
    try {
      const status = await freshService().status();
      expect(status.status).toBe('degraded'); expect(status.health).toMatchObject({ apiReady: true, database: 'ready' });
      expect(status.reasons).toContain('METRICS_UNAVAILABLE'); expect(status.reasons).not.toContain('API_DATABASE_UNAVAILABLE');
      expect(status.sources.total).toBeNull(); expect(stringify(status).includes(marker)).toBe(false);
    } finally { await p.$executeRawUnsafe('ALTER TABLE operations_unavailable_sources RENAME TO source_definitions'); }
  });

  test('coalesces simultaneous scrapes, returns detached metadata and recovers gateway sample failure', async () => {
    gatewayFailed = true; const unavailable = await freshService().status();
    expect(unavailable.websocket).toMatchObject({ sampledAt: null, authenticatedConnections: null });
    expect(unavailable.reasons).toContain('METRICS_UNAVAILABLE');
    gatewayFailed = false; sampleReads = 0; const service = freshService();
    const before = await digest(); writes.length = 0; queries.length = 0;
    const responses = await Promise.all(Array.from({ length: 20 }, () => service.status()));
    expect(sampleReads).toBe(1);
    const queryCount = queries.length;
    responses[0].queues[0].pending = 999;
    expect(responses[1].queues[0].pending).toBe(0);
    const metrics = await service.metrics();
    expect(queries.length).toBe(queryCount); expect(metrics).toContain('statuspanel_worker_sample_available 1');
    expect(responses[1].websocket).toMatchObject({ authenticatedConnections: 1, pendingConnections: 1, livenessTimeouts: 2 });
    expect(queries.some(sql => /^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i.test(sql))).toBe(false);
    expect(writes).toEqual([]); expect(await digest()).toBe(before);
  });

  test('real HTTP uses the admin guard, wrapped bounded JSON and private metrics without domain writes or inbound correlation leakage', async () => {
    const browser = await device({ lastSeenAt: new Date(now) }); connected.add(browser.id);
    const deviceToken = randomUUID();
    await p.deviceCredential.create({ data: { deviceId: browser.id, tokenHash: hash(deviceToken), kind: 'device' } });
    expect((await new PullDeviceAuthService(p as PrismaService).authenticate({ authorization: `Bearer ${deviceToken}` })).id).toBe(browser.id);
    await p.adminAccount.create({ data: { adminId: 'operations-admin' } });
    const sessions = new AdminSessionService(p as PrismaService), session = await sessions.create('operations-admin', {});
    const service = freshService();
    const module = await Test.createTestingModule({ controllers: [OperationsController], providers: [{ provide: OperationsService, useValue: service }] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.use(observeRequest);
    app.useGlobalGuards(new PinAuthGuard(new Reflector(), sessions)); app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    for (const path of ['/api/operations', '/api/operations/metrics']) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
      expect((await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${deviceToken}`)).status).toBe(401);
    }
    const before = await digest(true); writes.length = 0;
    const untrusted = randomUUID();
    const response = await request(app.getHttpServer()).get(`/api/operations?token=${marker}`)
      .set('Cookie', `${ADMIN_SESSION_COOKIE}=${session.token}`).set('X-Correlation-ID', untrusted).set('X-Private-Test', marker);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/); expect(response.headers['x-correlation-id']).not.toBe(untrusted);
    expect(Object.keys(response.body)).toEqual(['data']); expect(parseOperationsStatus(response.body.data).success).toBe(true);
    expect(Buffer.byteLength(stringify(response.body.data))).toBeLessThanOrEqual(OPERATIONS_LIMITS.bytes);
    const metrics = await request(app.getHttpServer()).get('/api/operations/metrics').set('Cookie', `${ADMIN_SESSION_COOKIE}=${session.token}`);
    expect(metrics.status).toBe(200); expect(metrics.headers['cache-control']).toBe('no-store');
    expect(metrics.headers['content-type']).toContain('text/plain'); expect(metrics.headers['content-type']).toContain('version=0.0.4');
    expect(metrics.text).toMatch(/statuspanel_request_duration_seconds_count\{route="operations",status_class="[245]xx"\}/);
    for (const secret of [marker, session.token, session.csrfToken, deviceToken, untrusted]) {
      expect(stringify(response.body).includes(secret)).toBe(false); expect(metrics.text.includes(secret)).toBe(false); expect(stringify(logs).includes(secret)).toBe(false);
    }
    // Existing session authentication updates technical lastSeenAt; domain tables never change.
    expect(writes.every(sql => /^\s*UPDATE\s+[`"]?(?:main[`"]?\.)?[`"]?admin_sessions\b/i.test(sql))).toBe(true);
    expect(await digest(true)).toBe(before);
    await sessions.revoke(session.sessionId, 'operations-admin');
    expect((await request(app.getHttpServer()).get('/api/operations').set('Cookie', `${ADMIN_SESSION_COOKIE}=${session.token}`)).status).toBe(401);
  }, 30_000);
});
