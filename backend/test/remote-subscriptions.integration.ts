import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, type DevicePublicationState, type OutboxEvent, type PlaybackState, type Prisma, type RemoteSubscription } from '@prisma/client';
import type { FederationPublicationFeed } from '@inker/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { EncryptionService } from '../src/common/services/encryption.service';
import { initializeInstanceSecrets } from '../src/config/instance-secrets';
import { OutboxStore } from '../src/events/outbox.store';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PUBLICATION_EVENT_TYPES } from '../src/publications/publication-persistence.types';
import { canonicalJson, publicationArtifacts, sha256 } from '../src/publications/publication-content';
import { PULL_FIXTURE_ARTIFACTS } from '../src/device-platform/pull-fixture-artifacts';
import { PlaybackService } from '../src/playback/playback.service';
import { RemoteSubscriptionsService } from '../src/federation/remote-subscriptions.service';
import { RemoteImportService } from '../src/federation/remote-import.service';
import { RemoteWorkerService } from '../src/federation/remote-worker.service';
import { RemoteTransport } from '../src/federation/remote-transport';
import { REMOTE_SYNC } from '../src/federation/remote-job';

const root = resolve(import.meta.dir, '..');
const origins = ['https://remote-a.example', 'https://remote-b.example', 'https://remote-c.example'];
const servers = ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
const token = 'sp_share_' + 'a'.repeat(64);
const signal = () => new AbortController().signal;
type Packet = { feed: FederationPublicationFeed; artifacts: Buffer[] };

function packet(revision = 1, publicationId = 'publication-one', serverId = servers[0]): Packet {
  const artifacts = [PULL_FIXTURE_ARTIFACTS[revision % 2 ? 0 : 1], PULL_FIXTURE_ARTIFACTS[2]];
  return { artifacts: artifacts.map(item => Buffer.from(item.bytes)), feed: {
    protocolVersion: '1.0', serverId, publicationId, publicationRevisionId: `remote-revision-${revision}`, revision,
    publishedAt: '2026-08-28T12:00:00.000Z', artifacts: artifacts.map(item => {
      if ((item.format !== 'png' && item.format !== 'bmp1') || (item.mimeType !== 'image/png' && item.mimeType !== 'image/bmp'))
        throw new Error('Expected supported federation fixture artifact');
      return { artifactId: item.sha256, sha256: item.sha256, mimeType: item.mimeType, format: item.format,
        width: item.width, height: item.height, colorSpace: item.colorSpace, bitDepth: item.bitDepth, rotation: item.rotation,
        sizeBytes: item.bytes.length, url: `/api/federation/v1/publications/${publicationId}/revisions/${revision}/artifacts/${item.sha256}` };
    }),
  } };
}

/** Only the remote network is replaced. Parsing, decoding, hashing and all SQLite I/O are real. */
class FixtureTransport extends RemoteTransport {
  value = packet();
  requests = 0;
  beforeResponse?: (path: string) => Promise<void>;
  constructor() { super({ allowedOrigins: origins }); }
  override async get(...args: Parameters<RemoteTransport['get']>): Promise<Awaited<ReturnType<RemoteTransport['get']>>> {
    const [, path, options] = args;
    this.requests++;
    options.signal.throwIfAborted();
    await this.beforeResponse?.(path);
    options.signal.throwIfAborted();
    const feed = this.value.feed;
    const index = feed.artifacts.findIndex(item => item.url === path);
    if (index >= 0) return { status: 200, etag: null, contentType: feed.artifacts[index].mimeType, bytes: this.value.artifacts[index] };
    const body = path.endsWith('/capabilities') ? {
      protocolVersion: '1.0', serverId: feed.serverId, readOnly: true,
      features: ['publication-feed', 'immutable-artifacts'], limits: { manifestBytes: 65536, artifactBytes: 2097152, artifacts: 8 },
    } : feed;
    return { status: 200, etag: `"fixture-${feed.revision}"`, contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body)) };
  }
}

class FixtureWorker extends RemoteWorkerService {
  transport = new FixtureTransport();
  protected override createTransport() { return this.transport; }
}

class HookedImporter extends RemoteImportService {
  afterPersist?: (tx: Prisma.TransactionClient) => Promise<void>;
  persisted = 0;
  override async persist(...args: Parameters<RemoteImportService['persist']>) {
    const result = await super.persist(...args);
    this.persisted++;
    await this.afterPersist?.(args[0]);
    return result;
  }
}

// Kept inline so a subprocess executes production services without importing bun:test,
// sharing a Prisma engine/client, or requiring a second fixture file. No transaction mocks.
const childProgram = `
import { PrismaClient } from '@prisma/client';
import { RemoteWorkerService } from './src/federation/remote-worker.service';
import { RemoteTransport } from './src/federation/remote-transport';
import { RemoteImportService } from './src/federation/remote-import.service';
import { PublicationPersistenceService } from './src/publications/publication-persistence.service';
import { OutboxStore } from './src/events/outbox.store';
const input = JSON.parse(await Bun.stdin.text());
const p = new PrismaClient({ datasources: { db: { url: input.url } } });
await p.$connect();
await p.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
let requests = 0;
class Transport extends RemoteTransport {
  async get(baseUrl, path, options) {
    requests++; options.signal.throwIfAborted();
    if (!input.packet) throw new Error('Unexpected replay network request');
    const feed = input.packet.feed, index = feed.artifacts.findIndex(item => item.url === path);
    if (index >= 0) return { status: 200, etag: null, contentType: feed.artifacts[index].mimeType,
      bytes: Buffer.from(input.packet.artifacts[index], 'base64') };
    const body = path.endsWith('/capabilities') ? { protocolVersion: '1.0', serverId: feed.serverId,
      readOnly: true, features: ['publication-feed', 'immutable-artifacts'],
      limits: { manifestBytes: 65536, artifactBytes: 2097152, artifacts: 8 } } : feed;
    return { status: 200, etag: '"fixture-' + feed.revision + '"', contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body)) };
  }
}
class Worker extends RemoteWorkerService { createTransport() { return new Transport(); } }
const store = new OutboxStore(p), worker = new Worker(p, store, new RemoteImportService(p, new PublicationPersistenceService(p)));
try {
  const event = await worker.claim(input.owner);
  if (!event) console.log(JSON.stringify({ claimed: false, requests }));
  else if (input.operation === 'claim') console.log(JSON.stringify({ claimed: true, eventId: event.eventId, aggregateId: event.aggregateId, requests }));
  else {
    const result = await worker.execute(event, new AbortController().signal);
    if (input.crash) {
      if (result !== 'completed') throw new Error('Expected committed import');
      console.log(JSON.stringify({ claimed: true, eventId: event.eventId, result, requests }));
      process.exit(73); // Deliberately no ack and no graceful DB/worker shutdown.
    }
    console.log(JSON.stringify({ claimed: true, eventId: event.eventId, result, requests, acknowledged: await store.ack(event) }));
  }
} finally { await p.$disconnect(); }
`;

describe('WP-27 real SQLite remote intent, import and worker fences', () => {
  let directory: string, url: string;
  let p: PrismaClient, other: PrismaClient;
  let service: RemoteSubscriptionsService, secondService: RemoteSubscriptionsService;
  let publications: PublicationPersistenceService, importer: HookedImporter, worker: FixtureWorker, second: FixtureWorker;
  let store: OutboxStore, secondStore: OutboxStore, encryption: EncryptionService;
  let previousEnv: Record<string, string | undefined>, writes: string[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-remote-sql-'));
    const databasePath = join(directory, 'test.db'), secretPath = join(directory, 'secrets', 'instance.json');
    url = `file:${databasePath.replaceAll('\\', '/')}`;
    previousEnv = Object.fromEntries(['INKER_INSTANCE_SECRET_PATH', 'FEDERATION_ALLOWED_ORIGINS', 'FEDERATION_PRIVATE_ORIGINS'].map(key => [key, process.env[key]]));
    initializeInstanceSecrets({ secretPath, databasePath });
    process.env.INKER_INSTANCE_SECRET_PATH = secretPath;
    process.env.FEDERATION_ALLOWED_ORIGINS = origins.join(',');
    process.env.FEDERATION_PRIVATE_ORIGINS = '';
    const migration = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => migration.kill(), 20_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited]);
      expect(code, stdout + stderr).toBe(0);
    } finally { clearTimeout(timeout); migration.kill(); }
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    other = new PrismaClient({ datasources: { db: { url } } });
    writes = [];
    p.$on('query' as never, (event: { query: string }) => { if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query); });
    await Promise.all([p.$connect(), other.$connect()]);
    await p.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await p.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await other.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    encryption = new EncryptionService(new ConfigService({ encryption: { secretPath } }));
    publications = new PublicationPersistenceService(p as PrismaService);
    service = new RemoteSubscriptionsService(p as PrismaService, encryption, publications);
    secondService = new RemoteSubscriptionsService(other as PrismaService, encryption, new PublicationPersistenceService(other as PrismaService));
    store = new OutboxStore(p as PrismaService); secondStore = new OutboxStore(other as PrismaService);
    importer = new HookedImporter(p as PrismaService, publications);
    worker = new FixtureWorker(p as PrismaService, store, importer);
    second = new FixtureWorker(other as PrismaService, secondStore,
      new RemoteImportService(other as PrismaService, new PublicationPersistenceService(other as PrismaService)));
  }, 30_000);

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv ?? {})) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await Promise.all([p?.$disconnect(), other?.$disconnect()]);
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-remote-sql-')) throw new Error('Unsafe remote fixture cleanup target');
      rmSync(target, { recursive: true, force: true });
    }
  });

  const command = (publicationId = 'publication-one', origin = 0) => ({ name: 'SQLite remote fixture', baseUrl: origins[origin],
    serverId: servers[origin], publicationId, token, trust: true, refreshIntervalSeconds: 60 });
  const create = async (publicationId = 'publication-one', origin = 0) => service.create(command(publicationId, origin));
  const row = (id: string) => p.remoteSubscription.findUniqueOrThrow({ where: { subscriptionId: id } });
  async function claim(id: string, owner = 'fixture-owner'): Promise<OutboxEvent> {
    const event = await store.claim(owner, new Date(), { eventType: REMOTE_SYNC, aggregateId: id });
    if (!event) throw new Error('Expected remote claim');
    return event;
  }
  async function importFirst() {
    const created = await create(), event = await claim(created.subscriptionId);
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(await store.ack(event)).toBe(true);
    return { created, event, saved: await row(created.subscriptionId) };
  }
  async function next(id: string) {
    expect(await service.sync(id, {})).toEqual({ scheduled: true });
    worker.transport.value = packet(2);
    return claim(id);
  }
  async function device(id: string) {
    const result = await p.device.create({ data: { name: 'remote fixture', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    await service.assign(id, result.id, {});
    return result;
  }
  const successState = (value: RemoteSubscription) => ({ latestLocalRevisionId: value.latestLocalRevisionId,
    remoteRevision: value.remoteRevision, remoteRevisionId: value.remoteRevisionId, feedHash: value.feedHash,
    etag: value.etag, lastSuccessAt: value.lastSuccessAt });
  async function domainSnapshot() {
    return { publications: await p.publication.findMany({ orderBy: { publicationId: 'asc' } }),
      revisions: await p.publicationRevision.findMany({ orderBy: { publicationRevisionId: 'asc' } }),
      devices: await p.device.findMany({ orderBy: { id: 'asc' } }),
      desired: await p.devicePublicationState.findMany({ orderBy: { deviceId: 'asc' } }),
      playback: await p.playbackState.findMany({ orderBy: { deviceId: 'asc' } }),
      events: await p.outboxEvent.findMany({ where: { eventType: { not: REMOTE_SYNC } }, orderBy: { eventId: 'asc' } }),
      jobs: await p.remoteSyncJob.findMany({ orderBy: { eventId: 'asc' } }),
      effects: await p.outboxEffect.findMany({ orderBy: { eventId: 'asc' } }) };
  }
  async function snapshot() {
    return { ...await domainSnapshot(), servers: await p.remoteServer.findMany({ orderBy: { remoteServerId: 'asc' } }),
      credentials: await p.remoteCredential.findMany({ orderBy: { credentialId: 'asc' } }),
      subscriptions: await p.remoteSubscription.findMany({ orderBy: { subscriptionId: 'asc' } }),
      allEvents: await p.outboxEvent.findMany({ orderBy: { eventId: 'asc' } }) };
  }
  async function child(operation: 'claim' | 'execute', value?: Packet, crash = false) {
    const processChild = Bun.spawn([process.execPath, '--no-env-file', '--eval', childProgram], {
      cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => processChild.kill(), 20_000);
    try {
      processChild.stdin.write(JSON.stringify({ operation, url, owner: randomUUID(), crash,
        ...(value ? { packet: { feed: value.feed, artifacts: value.artifacts.map(bytes => bytes.toString('base64')) } } : {}) }));
      await processChild.stdin.flush(); processChild.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([new Response(processChild.stdout).text(), new Response(processChild.stderr).text(), processChild.exited]);
      expect(exit, stderr).toBe(crash ? 73 : 0);
      expect(stdout.length).toBeLessThan(1024);
      return JSON.parse(stdout) as { claimed: boolean; eventId?: string; aggregateId?: string; requests: number; result?: string; acknowledged?: boolean };
    } finally { clearTimeout(timeout); processChild.kill(); }
  }
  async function expectFailurePreservesCache(id: string, before: Awaited<ReturnType<typeof domainSnapshot>>, success: ReturnType<typeof successState>, event: OutboxEvent, code: string) {
    expect(await domainSnapshot()).toEqual(before);
    const saved = await row(id);
    expect(successState(saved)).toEqual(success);
    expect(saved).toMatchObject({ lastErrorCode: code, consecutiveFailures: 1 });
    expect(saved.lastAttemptAt).not.toBeNull();
    expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).toMatchObject({
      status: 'pending', claimOwner: null, claimToken: null, claimUntil: null,
    });
    expect(await store.ack(event)).toBe(false);
  }

  test('late job-insert fault rolls back creation, encrypted credential, publication, event and scheduling cursor', async () => {
    const before = await snapshot();
    await p.$executeRawUnsafe(`CREATE TRIGGER reject_remote_job BEFORE INSERT ON remote_sync_jobs
      BEGIN SELECT RAISE(ABORT, 'REMOTE_FIXTURE_JOB_FAILURE'); END`);
    writes.length = 0;
    await expect(create()).rejects.toMatchObject({ message: 'REMOTE_UNAVAILABLE' });
    expect(writes.some(sql => /INSERT INTO .*remote_credentials/.test(sql))).toBe(true);
    expect(writes.some(sql => /INSERT INTO .*outbox_events/.test(sql))).toBe(true);
    expect(await snapshot()).toEqual(before);
    await p.$executeRawUnsafe('DROP TRIGGER reject_remote_job');
    const created = await create(), saved = await row(created.subscriptionId);
    const credential = await p.remoteCredential.findUniqueOrThrow({ where: { credentialId: saved.credentialId } });
    expect(encryption.decrypt(credential.ciphertext) === token).toBe(true);
    expect(credential.ciphertext.includes(token)).toBe(false);
    expect(await p.remoteServer.count()).toBe(1);
    expect(await p.remoteSyncJob.count()).toBe(1);
    expect(await p.outboxEvent.count()).toBe(1);
    expect(JSON.stringify([created, await service.list(), await p.outboxEvent.findMany()]).includes(token)).toBe(false);
  });

  test('late scheduling failure rolls back manual sync and credential rotation including version and nextSyncAt', async () => {
    const { created } = await importFirst(), before = await snapshot();
    await p.$executeRawUnsafe(`CREATE TRIGGER reject_remote_job BEFORE INSERT ON remote_sync_jobs
      BEGIN SELECT RAISE(ABORT, 'REMOTE_FIXTURE_JOB_FAILURE'); END`);
    await expect(service.sync(created.subscriptionId, {})).rejects.toMatchObject({ message: 'REMOTE_UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);
    await expect(service.update(created.subscriptionId, { token: 'sp_share_' + 'b'.repeat(64) })).rejects.toMatchObject({ message: 'REMOTE_UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);
  });

  test('competing creates of one remote publication leave exactly one complete intent and no credential/publication orphans', async () => {
    const results = await Promise.allSettled([service.create(command()), secondService.create(command())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toBe('REMOTE_ALREADY_EXISTS');
    expect(await p.remoteServer.count()).toBe(1);
    expect(await p.remoteCredential.count()).toBe(1);
    expect(await p.publication.count()).toBe(1);
    expect(await p.remoteSubscription.count()).toBe(1);
    expect(await p.remoteSyncJob.count()).toBe(1);
    expect(await p.outboxEvent.count()).toBe(1);
  });

  test('two clients racing manual refresh and scheduler produce one active durable job and one cursor advance', async () => {
    const { created } = await importFirst();
    await p.remoteSubscription.update({ where: { subscriptionId: created.subscriptionId }, data: { nextSyncAt: new Date(Date.now() - 1000) } });
    await Promise.all([service.sync(created.subscriptionId, {}), secondService.sync(created.subscriptionId, {}), worker.schedule(), second.schedule()]);
    const jobs = await p.remoteSyncJob.findMany({ where: { subscriptionId: created.subscriptionId, completedAt: null }, include: { event: true } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event.status).toBe('pending');
    expect((await row(created.subscriptionId)).nextSyncAt).toEqual(new Date(jobs[0].scheduledAt.getTime() + 60_000));
    const before = await snapshot();
    await Promise.all([service.sync(created.subscriptionId, {}), secondService.sync(created.subscriptionId, {}), worker.schedule(), second.schedule()]);
    expect(await snapshot()).toEqual(before);
  });

  test('four independent processes enforce global two, one per remote and one per subscription claim budgets', async () => {
    await create('publication-one'); await create('publication-two');
    await create('publication-three', 1); await create('publication-four', 2);
    const results = await Promise.all(Array.from({ length: 4 }, () => child('claim')));
    expect(results.filter(result => result.claimed)).toHaveLength(2);
    const active = await p.remoteSyncJob.findMany({ where: { event: { status: 'processing' } }, include: { event: true } });
    expect(active).toHaveLength(2);
    expect(new Set(active.map(job => job.remoteServerId)).size).toBe(2);
    expect(new Set(active.map(job => job.subscriptionId)).size).toBe(2);
    expect(new Set(active.map(job => job.event.claimToken)).size).toBe(2);
    expect((await child('claim')).claimed).toBe(false);
    const sameRemote = await p.remoteSyncJob.findMany({ where: { remoteServerId: active[0].remoteServerId } });
    expect(sameRemote.filter(job => active.some(item => item.eventId === job.eventId))).toHaveLength(1);
    expect(await p.outboxEvent.count({ where: { eventType: REMOTE_SYNC, status: 'pending' } })).toBe(2);
  }, 30_000);

  test('successful import commits exact artifact bytes, cache pointer, desired sequence, follow-up events and completion receipt together', async () => {
    const { created, saved } = await importFirst(), assigned = await device(created.subscriptionId);
    const previous = await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
    const event = await next(created.subscriptionId), value = worker.transport.value;
    expect(await worker.execute(event, signal())).toBe('completed');
    const current = await row(created.subscriptionId);
    expect(current.remoteRevision).toBe(2);
    expect(current.latestLocalRevisionId).not.toBe(saved.latestLocalRevisionId);
    expect(current.feedHash).toBe(sha256(canonicalJson(value.feed)));
    expect(current).toMatchObject({ lastErrorCode: null, consecutiveFailures: 0 });
    const revision = await p.publicationRevision.findUniqueOrThrow({ where: { publicationRevisionId: current.latestLocalRevisionId! } });
    expect(revision.revision).toBe(2);
    const artifacts = publicationArtifacts(revision);
    expect(artifacts.map(item => item.bytes)).toEqual(value.artifacts);
    expect(await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } })).toMatchObject({
      desiredPublicationRevisionId: revision.publicationRevisionId, desiredSequence: previous.desiredSequence + 1,
    });
    expect(await p.outboxEvent.count({ where: { eventType: PUBLICATION_EVENT_TYPES.revisionCreated, aggregateId: revision.publicationRevisionId } })).toBe(1);
    expect(await p.outboxEvent.count({ where: { eventType: PUBLICATION_EVENT_TYPES.desiredRevisionChanged,
      aggregateId: String(assigned.id), aggregateRevision: String(previous.desiredSequence + 1) } })).toBe(1);
    expect((await p.remoteSyncJob.findUniqueOrThrow({ where: { eventId: event.eventId } })).completedAt).not.toBeNull();
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status).toBe('processing');
    expect(await store.ack(event)).toBe(true);
  });

  for (const fault of ['desired-event', 'completion-receipt'] as const) test(`SQL ${fault} failure rolls back actual import and preserves the complete last-good state`, async () => {
    const { created, saved } = await importFirst(); await device(created.subscriptionId);
    const event = await next(created.subscriptionId), before = await domainSnapshot();
    const trigger = fault === 'desired-event'
      ? `CREATE TRIGGER reject_import BEFORE INSERT ON outbox_events WHEN NEW.event_type = '${PUBLICATION_EVENT_TYPES.desiredRevisionChanged}'
          BEGIN SELECT RAISE(ABORT, 'REMOTE_FIXTURE_IMPORT_FAILURE'); END`
      : `CREATE TRIGGER reject_import BEFORE INSERT ON outbox_effects BEGIN SELECT RAISE(ABORT, 'REMOTE_FIXTURE_IMPORT_FAILURE'); END`;
    await p.$executeRawUnsafe(trigger);
    writes.length = 0;
    expect(await worker.execute(event, signal())).toBe('failed');
    expect(writes.some(sql => /INSERT INTO .*publication_revisions/.test(sql))).toBe(true);
    expect(writes.some(sql => /UPDATE .*devices/.test(sql))).toBe(true);
    if (fault === 'completion-receipt') {
      expect(writes.some(sql => /UPDATE .*remote_subscriptions/.test(sql))).toBe(true);
      expect(writes.some(sql => /UPDATE .*remote_sync_jobs/.test(sql))).toBe(true);
    }
    await expectFailurePreservesCache(created.subscriptionId, before, successState(saved), event, 'REMOTE_SYNC_FAILED');
    await p.$executeRawUnsafe('DROP TRIGGER reject_import');
    await p.outboxEvent.update({ where: { eventId: event.eventId }, data: { availableAt: new Date() } });
    const retry = await claim(created.subscriptionId);
    expect(await worker.execute(retry, signal())).toBe('completed');
    expect(await store.ack(retry)).toBe(true);
    expect(await p.publicationRevision.count({ where: { publicationId: saved.localPublicationId } })).toBe(2);
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
  });

  for (const mutation of ['rotate', 'disable', 'trust'] as const) test(`committed ${mutation} during download fences the stale response against real persisted state`, async () => {
    const { created, saved } = await importFirst(); await device(created.subscriptionId);
    const event = await next(created.subscriptionId);
    const revisions = await p.publicationRevision.findMany(), desired = await p.devicePublicationState.findMany();
    let changed = false;
    worker.transport.beforeResponse = async path => {
      if (!path.includes('/artifacts/') || changed) return;
      changed = true;
      if (mutation === 'trust') await other.remoteServer.update({ where: { remoteServerId: saved.remoteServerId }, data: { trusted: false } });
      else await secondService.update(created.subscriptionId, mutation === 'rotate' ? { token: 'sp_share_' + 'b'.repeat(64) } : { enabled: false });
    };
    expect(await worker.execute(event, signal())).toBe(mutation === 'trust' ? 'failed' : 'completed');
    expect(changed).toBe(true);
    expect(await p.publicationRevision.findMany()).toEqual(revisions);
    expect(await p.devicePublicationState.findMany()).toEqual(desired);
    const current = await row(created.subscriptionId);
    expect(successState(current)).toEqual(successState(saved));
    if (mutation === 'trust') {
      expect(current).toMatchObject({ version: 1, lastErrorCode: 'REMOTE_ORIGIN_DENIED' });
      expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status).toBe('dead-letter');
    } else {
      expect(current.version).toBe(2);
      expect(current.enabled).toBe(mutation === 'rotate');
      expect(current.lastAttemptAt).toEqual(saved.lastAttemptAt);
      expect(await store.ack(event)).toBe(true);
      if (mutation === 'rotate') {
        const secret = await p.remoteCredential.findUniqueOrThrow({ where: { credentialId: current.credentialId } });
        expect(encryption.decrypt(secret.ciphertext) === 'sp_share_' + 'b'.repeat(64)).toBe(true);
      }
    }
  });

  test('manual assignment committed by another client during fetch is never overwritten by a later remote import', async () => {
    const { created } = await importFirst(), assigned = await device(created.subscriptionId);
    const local = await publications.createPublication({ publicationKey: 'manual', protocolVersion: '1.0', content: { fixture: true }, contentHash: sha256('manual') });
    const event = await next(created.subscriptionId);
    let desired: DevicePublicationState | undefined;
    worker.transport.beforeResponse = async path => {
      if (!path.includes('/artifacts/') || desired) return;
      desired = await new PublicationPersistenceService(other as PrismaService).setDesiredRevision(assigned.id, local.revision.publicationRevisionId);
    };
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(desired).toBeDefined();
    expect(await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } })).toEqual(desired!);
    expect((await row(created.subscriptionId)).remoteRevision).toBe(2);
  });

  for (const status of ['running', 'paused'] as const) test(`a ${status} immutable playlist started during fetch retains its assignment and sequence`, async () => {
    const { created, saved } = await importFirst(), assigned = await device(created.subscriptionId);
    const playback = new PlaybackService(other as PrismaService, new PublicationPersistenceService(other as PrismaService), { now: () => Date.now() });
    const draft = await other.playlist.create({ data: { name: 'remote playlist fence', items: { create: [{ duration: 60, order: 0 }] } }, include: { items: true } });
    const published = await playback.publish(draft.id, { version: 1, idempotencyKey: randomUUID(), expectedRevision: 0,
      expectedDraftHash: (await playback.draft(draft.id)).draftHash,
      bindings: [{ itemId: draft.items[0].id, publicationRevisionId: saved.latestLocalRevisionId! }] });
    const event = await next(created.subscriptionId);
    let desired: DevicePublicationState | undefined, playbackBefore: PlaybackState | undefined;
    worker.transport.beforeResponse = async path => {
      if (!path.includes('/artifacts/') || desired) return;
      const before = await other.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
      await playback.execute(assigned.id, { version: 1, idempotencyKey: randomUUID(), action: 'start', expectedVersion: 0,
        expectedDesiredSequence: before.desiredSequence, playlistRevisionId: (published as { playlistRevisionId: string }).playlistRevisionId });
      if (status === 'paused') {
        const state = await other.playbackState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
        const pointer = await other.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
        await playback.execute(assigned.id, { version: 1, idempotencyKey: randomUUID(), action: 'pause', expectedVersion: state.version, expectedDesiredSequence: pointer.desiredSequence });
      }
      desired = await other.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
      playbackBefore = await other.playbackState.findUniqueOrThrow({ where: { deviceId: assigned.id } });
    };
    expect(await worker.execute(event, signal())).toBe('completed');
    expect(playbackBefore).toMatchObject({ status });
    expect(await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: assigned.id } })).toEqual(desired!);
    expect(await p.playbackState.findUniqueOrThrow({ where: { deviceId: assigned.id } })).toEqual(playbackBefore!);
    expect((await row(created.subscriptionId)).remoteRevision).toBe(2);
  });

  test('abort after real import writes rolls them all back before recording a bounded failed attempt', async () => {
    const { created, saved } = await importFirst(); await device(created.subscriptionId);
    const event = await next(created.subscriptionId), before = await domainSnapshot(), abort = new AbortController();
    importer.afterPersist = async () => { abort.abort(); };
    writes.length = 0;
    expect(await worker.execute(event, abort.signal)).toBe('failed');
    expect(writes.some(sql => /INSERT INTO .*publication_revisions/.test(sql))).toBe(true);
    expect(writes.some(sql => /UPDATE .*devices/.test(sql))).toBe(true);
    await expectFailurePreservesCache(created.subscriptionId, before, successState(saved), event, 'REMOTE_ABORTED');
  });

  test('a real lease deadline passing after domain writes rolls back revision, assignment, success and completion receipt', async () => {
    const { created } = await importFirst(); await device(created.subscriptionId);
    const event = await next(created.subscriptionId), deadline = Date.now() + 2000;
    await p.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(deadline) } });
    importer.afterPersist = async tx => {
      // Prove the uncommitted writes exist, then let the real wall-clock lease expire.
      expect(await tx.publicationRevision.count()).toBe(2);
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise(resolve => setTimeout(resolve, deadline - Date.now() + 25));
    };
    const before = await snapshot(); writes.length = 0;
    await expect(worker.execute(event, signal())).rejects.toThrow('REMOTE_STALE_CLAIM');
    expect(writes.some(sql => /UPDATE .*remote_sync_jobs/.test(sql))).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await store.current(event)).toBeNull();
    expect(await store.ack(event)).toBe(false);
    expect(await second.claim('lease-recovery')).not.toBeNull();
  });

  test('another client replacing an expired claim during download prevents the old worker from importing or acknowledging', async () => {
    const { created } = await importFirst(), event = await next(created.subscriptionId);
    let replacement: OutboxEvent | null = null;
    worker.transport.beforeResponse = async path => {
      if (!path.includes('/artifacts/') || replacement) return;
      await other.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(Date.now() - 1) } });
      replacement = await second.claim('replacement-owner');
      expect(replacement).not.toBeNull();
    };
    const before = await domainSnapshot(), saved = await row(created.subscriptionId);
    await expect(worker.execute(event, signal())).rejects.toThrow('REMOTE_STALE_CLAIM');
    expect(await domainSnapshot()).toEqual(before);
    expect(await row(created.subscriptionId)).toEqual(saved);
    expect(await store.ack(event)).toBe(false);
    expect(await store.fail(event, 'OUTBOX_TRANSPORT_FAILED')).toBe(false);
    expect(await secondStore.current(replacement!)).not.toBeNull();
    second.transport.value = packet(2);
    expect(await second.execute(replacement!, signal())).toBe('completed');
    expect(await secondStore.ack(replacement!)).toBe(true);
    expect(await p.publicationRevision.count()).toBe(2);
  });

  test('actual process crash after import commit but before ack replays without network, duplicate revision or follow-up event', async () => {
    const created = await create();
    const crash = await child('execute', packet(), true);
    expect(crash).toMatchObject({ claimed: true, result: 'completed', requests: 4 });
    const saved = await row(created.subscriptionId), event = await p.outboxEvent.findUniqueOrThrow({ where: { eventId: crash.eventId! } });
    expect(saved.remoteRevision).toBe(1);
    expect(event.status).toBe('processing');
    expect((await p.remoteSyncJob.findUniqueOrThrow({ where: { eventId: event.eventId } })).completedAt).not.toBeNull();
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    const revisions = await p.publicationRevision.findMany(), followups = await p.outboxEvent.findMany({ where: { eventType: { not: REMOTE_SYNC } } });
    const completed = await p.remoteSyncJob.findUniqueOrThrow({ where: { eventId: event.eventId } });
    await p.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(Date.now() - 1) } });
    const replay = await child('execute');
    expect(replay).toMatchObject({ claimed: true, eventId: event.eventId, result: 'completed', requests: 0, acknowledged: true });
    expect(await row(created.subscriptionId)).toEqual(saved);
    expect(await p.publicationRevision.findMany()).toEqual(revisions);
    expect(await p.outboxEvent.findMany({ where: { eventType: { not: REMOTE_SYNC } } })).toEqual(followups);
    expect(await p.remoteSyncJob.findUniqueOrThrow({ where: { eventId: event.eventId } })).toEqual(completed);
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(await store.ack(event)).toBe(false);
  }, 30_000);
});
