import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PublicationCleanupService } from "../src/publications/publication-cleanup.service";
import { PublicationPersistenceService } from "../src/publications/publication-persistence.service";
import { PUBLICATION_EVENT_TYPES } from "../src/publications/publication-persistence.types";
import { Test } from '@nestjs/testing';
import { DiscoveryModule } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { PullContentService } from '../src/device-platform/pull-content.service';
import { PullDeviceAuthService } from '../src/device-platform/pull-device-auth.service';
import { PullLastSeenService } from '../src/device-platform/pull-last-seen.service';
import { ProfileResolverService } from '../src/device-platform/profile-resolver.service';
import { DeviceConfigurationService } from '../src/device-platform/device-configuration.service';
import { DeliveryPolicyRegistry } from '../src/device-platform/delivery-policy.registry';
import { SleepyDeliveryPolicy, ResponsivePullDeliveryPolicy } from '../src/device-platform/delivery-policies';
import { HttpPullTransportAdapter } from '../src/device-platform/http-pull.transport-adapter';
import { TransportAdapterRegistry } from '../src/device-platform/transport-adapter.registry';
import { hashToken } from '../src/common/utils/crypto.util';
import { randomUUID } from 'node:crypto';
import { PublishService } from '../src/publications/publish.service';
import { PresentationService } from '../src/device-platform/presentation.service';
import { canonicalJson, sha256 } from '../src/publications/publication-content';
import { PULL_FIXTURE_ARTIFACTS } from '../src/device-platform/pull-fixture-artifacts';
import { OutboxStore } from '../src/events/outbox.store';
import { parseOutboxEvent } from '../src/events/outbox.types';
import { DevicePlatformModule } from '../src/device-platform/device-platform.module';
import { PublicationsModule } from '../src/publications/publications.module';
import { EventsModule } from '../src/events/events.module';
import { APP_GUARD } from '@nestjs/core';
import { PinAuthGuard } from '../src/auth/guards/pin-auth.guard';
import { AdminSessionService } from '../src/auth/admin-session.service';
import request from 'supertest';

const backendRoot = resolve(import.meta.dir, "..");
const migrationScript = join(backendRoot, "scripts", "migrate-database.ts");
const createdDirectories: string[] = [];

function databaseUrl(path: string) {
  return `file:${path.replaceAll("\\", "/")}`;
}

async function migrate(path: string) {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, migrationScript],
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl(path) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}

describe("publication persistence boundary", () => {
  let prisma: PrismaClient;
  let persistence: PublicationPersistenceService;
  let cleanup: PublicationCleanupService;
  let path: string;
  let writes: string[];
  let publisher: PublishService;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "inker-publication-test-"));
    createdDirectories.push(directory);
    path = join(directory, "inker.db");
    await migrate(path);
    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl(path) } },
      log: [{ level: 'query', emit: 'event' }],
    });
    writes = [];
    prisma.$on('query' as never, (event: { query: string }) => { if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query); });
    await prisma.$connect();
    persistence = new PublicationPersistenceService(prisma as any);
    cleanup = new PublicationCleanupService(prisma as any);
    publisher = new PublishService(prisma as any, persistence);
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    for (const directory of createdDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function target(name = 'browser', pull = false) {
    return prisma.device.create({ data: { name, externalId: name, lastSeenAt: new Date(),
      profileId: pull ? 'trmnl-byod-7.5-mono' : 'browser-hd-1920x1080',
      deliveryPolicyId: pull ? 'reference-sleepy' : 'reference-connected-browser' } });
  }
  function command(deviceIds: number[] = [], expectedRevision = 0) {
    return { idempotencyKey: randomUUID(), expectedRevision, deviceIds,
      draft: { fixtureArtifacts: ['mono-800x480-white-bmp', 'mono-800x480-white-png'] } };
  }

  test('WP-17 explicit publish validates input, hashes canonical content and atomically assigns with two events', async () => {
    const d = await target();
    const input = command([d.id]);
    const result = await publisher.publish('main', input) as any;
    const revision = await prisma.publicationRevision.findUniqueOrThrow({ where: { publicationRevisionId: result.publicationRevisionId } });
    expect(revision.contentHash).toBe(sha256(canonicalJson(revision.content)));
    expect(await prisma.outboxEvent.count()).toBe(2);
    expect((await persistence.getDevicePublicationState(d.id))?.desiredPublicationRevisionId).toBe(revision.publicationRevisionId);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision).toBe(1);
    const before = await prisma.devicePublicationState.findUnique({ where: { deviceId: d.id } });
    writes.length = 0;
    expect(await publisher.publish('main', input)).toEqual(result);
    expect(writes).toEqual([]);
    expect(await prisma.devicePublicationState.findUnique({ where: { deviceId: d.id } })).toEqual(before);
    await expect(publisher.publish('main', { ...input, expectedRevision: 1 })).rejects.toThrow('Idempotency key');
    await expect(publisher.publish('main', command([], 0))).rejects.toThrow('revision conflict');
    await expect(publisher.publish('main', { ...command(), draft: { fixtureArtifacts: ['unknown'], credential: 'secret' } })).rejects.toThrow();
    expect(await prisma.publicationRevision.count()).toBe(1);
    expect(await prisma.publicationCommand.count()).toBe(1);
  });

  test('WP-17 100 sequential and 100 parallel browser/pull reads perform zero SQL writes', async () => {
    const browser = await target(), pull = await target('pull', true);
    await publisher.publish('stable', command([browser.id, pull.id]));
    const module = await Test.createTestingModule({ imports: [DevicePlatformModule, EventsModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    const app = module.createNestApplication(); await app.init();
    try {
      const d = await prisma.device.findUniqueOrThrow({ where: { id: pull.id }, include: { profile: true, deliveryPolicy: true } });
      const read = async () => [await module.get(PresentationService).getForDevice(browser.id), (await module.get(PullContentService).read(d)).manifest];
      const before = await prisma.device.findMany();
      const reference = await read();
      writes.length = 0;
      for (let i = 0; i < 100; i++) expect(await read()).toEqual(reference);
      const parallel = await Promise.all(Array.from({ length: 100 }, read));
      for (const value of parallel) expect(value).toEqual(reference);
      expect(writes).toEqual([]);
      expect(await prisma.device.findMany()).toEqual(before);
    } finally { await app.close(); }
  }, 30_000);

  test('WP-17 simultaneous publishers across separate clients: same key replays, different keys conflict', async () => {
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl(path) } } });
    const second = new PublishService(other as any, new PublicationPersistenceService(other as any));
    const input = command();
    try {
      const same = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? publisher : second).publish('race', input)));
      for (const result of same) expect(result).toEqual(same[0]);
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? publisher : second).publish('race', command([], 1))));
      expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
      for (const attempt of attempts) if (attempt.status === 'rejected') expect(attempt.reason.getStatus()).toBe(409);
      expect(await prisma.publicationRevision.count()).toBe(2);
      expect(await prisma.outboxEvent.count()).toBe(2);
    } finally { await other.$disconnect(); }
  }, 30_000);

  test('WP-17 publication, receipt, desired state, sequence and outbox roll back on assignment-event failure', async () => {
    const d = await target();
    const initial = await publisher.publish('rollback', command([d.id])) as any;
    const before = await prisma.device.findUnique({ where: { id: d.id } });
    await prisma.$executeRawUnsafe("CREATE TRIGGER fail_wp17 BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'device.publication.desired-revision.changed' BEGIN SELECT RAISE(ABORT, 'forced'); END");
    const input = command([d.id], 1);
    await expect(publisher.publish('rollback', input)).rejects.toThrow();
    expect(await prisma.publicationRevision.count()).toBe(1);
    expect(await prisma.publicationCommand.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(2);
    expect(await prisma.device.findUnique({ where: { id: d.id } })).toEqual(before);
    expect((await persistence.getDevicePublicationState(d.id))?.desiredPublicationRevisionId).toBe(initial.publicationRevisionId);
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_wp17');
    expect((await publisher.publish('rollback', input) as any).revision).toBe(2);
  });

  test('WP-17 uploaded draft pixels survive edits, deletion and restart; replay never rereads the draft', async () => {
    const directory = join(backendRoot, 'uploads', 'screens');
    mkdirSync(directory, { recursive: true });
    const filename = `${randomUUID()}.png`, file = join(directory, filename);
    writeFileSync(file, PULL_FIXTURE_ARTIFACTS[2].bytes);
    try {
      const d = await target();
      const screen = await prisma.screen.create({ data: { name: 'secret-metadata-not-copied', imageUrl: `/uploads/screens/${filename}` } });
      const input = { ...command([d.id]), draft: { screenId: screen.id, expectedUpdatedAt: screen.updatedAt.toISOString() } };
      const result = await publisher.publish('upload', input) as any;
      const service = new PresentationService(prisma as any);
      const manifest = await service.getForDevice(d.id);
      const hash = manifest.content.url.split('/').pop()!;
      const artifact = await service.artifact(d.id, hash);
      expect(sha256(artifact.bytes)).toBe(hash);
      await prisma.screen.update({ where: { id: screen.id }, data: { imageUrl: '/uploads/changed.png' } });
      await expect(publisher.publish('upload', { ...input, idempotencyKey: randomUUID(), expectedRevision: 1 })).rejects.toThrow('Draft changed');
      await prisma.screen.delete({ where: { id: screen.id } });
      writeFileSync(file, 'unavailable');
      await prisma.$disconnect(); await prisma.$connect();
      expect(await publisher.publish('upload', input)).toEqual(result);
      expect(await service.getForDevice(d.id)).toEqual(manifest);
      expect((await service.artifact(d.id, hash)).bytes).toEqual(artifact.bytes);
      expect(JSON.stringify(await prisma.publicationRevision.findMany())).not.toContain('secret-metadata');
      expect(JSON.stringify(await prisma.outboxEvent.findMany())).not.toContain(filename);
    } finally { unlinkSync(file); }
  });

  test('WP-17 retry snapshots never mint revisions and preserve their original content after a new publish', async () => {
    const d = await target();
    await publisher.publish('delivery', command([d.id]));
    const store = new OutboxStore(prisma as any);
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'device.publication.desired-revision.changed' } });
    const key = parseOutboxEvent(events[0]).key;
    await prisma.outboxEffect.create({ data: { key, eventId: events[0].eventId } });
    const delivery = await prisma.outboxDelivery.create({ data: { effectKey: key, deviceId: d.id } });
    const context = { deliveryId: delivery.deliveryId, signal: new AbortController().signal };
    const service = new PresentationService(prisma as any);
    const before = await prisma.device.findUnique({ where: { id: d.id } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl(path) } } });
    let first: Awaited<ReturnType<PresentationService['getForDevice']>>;
    try {
      const competing = new PresentationService(other as any);
      const initial = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? service : competing).getForDevice(d.id, context)));
      first = initial[0];
      for (const manifest of initial) expect(manifest).toEqual(first);
    } finally { await other.$disconnect(); }
    for (const retry of await Promise.all(Array.from({ length: 10 }, () => service.getForDevice(d.id, context)))) expect(retry).toEqual(first);
    expect(await prisma.device.findUnique({ where: { id: d.id } })).toEqual(before);
    await publisher.publish('delivery', command([d.id], 1));
    expect(await service.getForDevice(d.id, context)).toEqual(first);
    expect((await service.getForDevice(d.id)).revision).toBe(first.revision + 1);
    expect(await prisma.publicationRevision.count()).toBe(2);
    expect(await store.claim('still-durable')).not.toBeNull();
  });

  test('WP-17 reassignment is idempotent, conflicts are explicit, and A-B-A has distinct durable effects', async () => {
    const d = await target();
    const a = await publisher.publish('a', command([d.id])) as any;
    const b = await publisher.publish('b', command()) as any;
    await publisher.assign(d.id, { publicationRevisionId: b.publicationRevisionId, expectedDesiredRevisionId: a.publicationRevisionId });
    await publisher.assign(d.id, { publicationRevisionId: b.publicationRevisionId, expectedDesiredRevisionId: a.publicationRevisionId });
    expect((await prisma.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision).toBe(2);
    await expect(publisher.assign(d.id, { publicationRevisionId: a.publicationRevisionId, expectedDesiredRevisionId: null })).rejects.toThrow('conflict');
    await publisher.assign(d.id, { publicationRevisionId: a.publicationRevisionId, expectedDesiredRevisionId: b.publicationRevisionId });
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'device.publication.desired-revision.changed' } });
    expect(new Set(events.map(e => parseOutboxEvent(e).key)).size).toBe(3);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision).toBe(3);
  });

  test('WP-17 APIs preserve admin/CSRF, device auth before 304 and isolated read-only manifests', async () => {
    const module = await Test.createTestingModule({ imports: [DevicePlatformModule, PublicationsModule, EventsModule], providers: [
      { provide: APP_GUARD, useClass: PinAuthGuard },
      { provide: AdminSessionService, useValue: { validate: async (token: string) => token === 'test-session' ? { sessionId: 'session', adminId: 'admin' } : null, verifyCsrf: async (_id: string, token: string) => token === 'test-csrf' } },
    ] }).overrideProvider(PrismaService).useValue(prisma).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    try {
      const d = await target(), pull = await target('api-pull', true);
      const browserToken = 'browser-token-012345678901234567890123456789';
      const browserAuthorization = `Bearer ${browserToken}`;
      await prisma.deviceCredential.create({ data: { deviceId: d.id, tokenHash: hashToken(browserToken), kind: 'web-display' } });
      await prisma.deviceCredential.create({ data: { deviceId: pull.id, tokenHash: hashToken('pull-token') } });
      const input = command([d.id, pull.id]);
      await request(app.getHttpServer()).post('/api/publications/api/publish').send(input).expect(401);
      await request(app.getHttpServer()).post('/api/publications/api/publish').set('Cookie', 'inker_admin_session=test-session').send(input).expect(403);
      const published = await request(app.getHttpServer()).post('/api/publications/api/publish').set('Cookie', 'inker_admin_session=test-session').set('X-CSRF-Token', 'test-csrf').send(input).expect(201);
      expect(published.body.revision).toBe(1);
      const webUrl = `/api/web-displays/${d.externalId}/presentation`;
      const first = await request(app.getHttpServer()).get(webUrl).set('Authorization', browserAuthorization).expect(200);
      writes.length = 0;
      for (let i = 0; i < 100; i++) expect((await request(app.getHttpServer()).get(webUrl).set('Authorization', browserAuthorization).expect(200)).body).toEqual(first.body);
      await Promise.all(Array.from({ length: 100 }, async () => expect((await request(app.getHttpServer()).get(webUrl).set('Authorization', browserAuthorization).expect(200)).body).toEqual(first.body)));
      expect(writes).toEqual([]);
      const artifact = await request(app.getHttpServer()).get(first.body.content.url).set('Authorization', browserAuthorization).expect(200);
      const unchanged = await request(app.getHttpServer()).get(first.body.content.url).set('Authorization', browserAuthorization).set('If-None-Match', artifact.headers.etag).expect(304);
      expect(unchanged.text).toBe('');
      await request(app.getHttpServer()).get(first.body.content.url).set('If-None-Match', artifact.headers.etag).expect(401);
      const pullFirst = await request(app.getHttpServer()).get('/api/v1/device-content').set('Authorization', 'Bearer pull-token').expect(200);
      writes.length = 0;
      for (let i = 0; i < 100; i++) await request(app.getHttpServer()).get('/api/v1/device-content').set('Authorization', 'Bearer pull-token').set('If-None-Match', pullFirst.headers.etag).expect(304).expect(r => expect(r.text).toBe(''));
      await Promise.all(Array.from({ length: 100 }, () => request(app.getHttpServer()).get('/api/v1/device-content').set('Authorization', 'Bearer pull-token').expect(200).expect(r => expect(r.body).toEqual(pullFirst.body))));
      expect(writes).toEqual([]);
      await prisma.deviceCredential.updateMany({ where: { deviceId: d.id }, data: { revokedAt: new Date() } });
      await request(app.getHttpServer()).get(first.body.content.url).set('Authorization', browserAuthorization).set('If-None-Match', artifact.headers.etag).expect(401);
    } finally { await app.close(); }
  }, 30_000);

  test('WP-17 concurrent publish and 100 reads never mix an assignment sequence with another snapshot', async () => {
    const d = await target();
    await publisher.publish('interleaved', command([d.id]));
    const service = new PresentationService(prisma as any);
    const first = await service.getForDevice(d.id);
    const reads = Array.from({ length: 100 }, () => service.getForDevice(d.id));
    const write = publisher.publish('interleaved', command([d.id], 1));
    const results = await Promise.all(reads);
    await write;
    const second = await service.getForDevice(d.id);
    for (const manifest of results) expect(manifest).toEqual(manifest.revision === 1 ? first : second);
    expect(second.revision).toBe(2);
  });

  test('WP-17 missing/corrupt publications fail without replacing valid desired content or using a draft', async () => {
    const d = await target();
    const service = new PresentationService(prisma as any);
    expect((await service.getForDevice(d.id)).content.url).toBe('/assets/publication-unassigned.svg');
    const valid = await publisher.publish('valid', command([d.id])) as any;
    const broken = await persistence.createPublication({ publicationKey: 'broken', protocolVersion: '1.0',
      content: { schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-png'] }, contentHash: 'wrong-checksum' });
    await expect(publisher.assign(d.id, { publicationRevisionId: broken.revision.publicationRevisionId, expectedDesiredRevisionId: valid.publicationRevisionId })).rejects.toThrow('unavailable');
    await expect(publisher.assign(d.id, { publicationRevisionId: 'missing', expectedDesiredRevisionId: valid.publicationRevisionId })).rejects.toThrow('not found');
    expect((await persistence.getDevicePublicationState(d.id))?.desiredPublicationRevisionId).toBe(valid.publicationRevisionId);
    await persistence.setDesiredRevision(d.id, broken.revision.publicationRevisionId);
    writes.length = 0;
    await expect(service.getForDevice(d.id)).rejects.toThrow('unavailable');
    expect(writes).toEqual([]);
  });

  test('WP-17 completed idempotency receipts survive revision retention and cannot reassign on replay', async () => {
    const d = await target();
    const input = command([d.id]);
    const first = await publisher.publish('retained-command', input) as any;
    const second = await publisher.publish('retained-command', command([d.id], 1)) as any;
    const result = await cleanup.cleanup(new Date(Date.now() + 100 * 86400_000));
    expect(result.publicationRevisions).toBe(1);
    expect(await publisher.publish('retained-command', input)).toEqual(first);
    expect((await persistence.getDevicePublicationState(d.id))?.desiredPublicationRevisionId).toBe(second.publicationRevisionId);
    await expect(Promise.resolve(prisma.publicationCommand.updateMany({ data: { result: {} } }))).rejects.toThrow();
    expect(await prisma.outboxEvent.count({ where: { status: 'pending' } })).toBe(4);
  });

  test("stores an immutable revision and its versioned outbox event atomically", async () => {
    const result = await persistence.createPublication({
      publicationKey: "admin-dashboard",
      protocolVersion: "1.0",
      content: { draftId: 17, snapshotIds: ["snapshot-1"] },
      contentHash: "sha256:first",
    });

    const events = await persistence.listOutboxEvents();
    expect(result.revision.revision).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PUBLICATION_EVENT_TYPES.revisionCreated,
      aggregateId: result.revision.publicationRevisionId,
      payloadVersion: 1,
      status: "pending",
      attempts: 0,
    });
    expect(events[0].availableAt).toBeInstanceOf(Date);
    expect(events[0].occurredAt).toBeInstanceOf(Date);
    expect(
      (await persistence.getPublication("admin-dashboard"))?.revisions,
    ).toHaveLength(1);
    expect(await persistence.getOutboxStatusCounts()).toEqual({
      pending: 1,
      processing: 0,
      delivered: 0,
      "dead-letter": 0,
    });
    await expect(
      Promise.resolve(
        prisma.publication.update({
          where: { publicationId: result.publication.publicationId },
          data: { publicationKey: "mutated" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        prisma.publicationRevision.update({
          where: {
            publicationRevisionId: result.revision.publicationRevisionId,
          },
          data: { contentHash: "sha256:mutated" },
        }),
      ),
    ).rejects.toThrow();
  });

  test("rolls the domain row back when the outbox insert fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_wp07_outbox_insert
      BEFORE INSERT ON outbox_events
      BEGIN
        SELECT RAISE(ABORT, 'forced outbox failure');
      END;
    `);

    await expect(
      persistence.createPublication({
        publicationKey: "must-rollback",
        protocolVersion: "1.0",
        content: { value: 1 },
        contentHash: "sha256:rollback",
      }),
    ).rejects.toThrow();
    expect(await prisma.publication.count()).toBe(0);
    expect(await prisma.publicationRevision.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  test("persists desired and acknowledged revisions independently", async () => {
    const first = await persistence.createPublication({
      publicationKey: "device-feed",
      protocolVersion: "1.0",
      content: { value: 1 },
      contentHash: "sha256:one",
    });
    const second = await persistence.appendRevision({
      publicationId: first.publication.publicationId,
      protocolVersion: "1.0",
      content: { value: 2 },
      contentHash: "sha256:two",
    });
    const device = await prisma.device.create({
      data: {
        name: "Publication test device",
        externalId: "publication-test-device",
        profileId: "browser-hd-1920x1080",
        deliveryPolicyId: "reference-connected-browser",
      },
    });

    await persistence.setDesiredRevision(
      device.id,
      second.publicationRevisionId,
    );
    await persistence.acknowledgeRevision(
      device.id,
      first.revision.publicationRevisionId,
    );

    const state = await persistence.getDevicePublicationState(device.id);
    expect(state?.desiredPublicationRevisionId).toBe(
      second.publicationRevisionId,
    );
    expect(state?.acknowledgedPublicationRevisionId).toBe(
      first.revision.publicationRevisionId,
    );
    expect(
      await prisma.outboxEvent.count({
        where: {
          eventType: {
            in: [
              PUBLICATION_EVENT_TYPES.desiredRevisionChanged,
              PUBLICATION_EVENT_TYPES.revisionAcknowledged,
            ],
          },
        },
      }),
    ).toBe(2);
  });

  test("retains pending events, referenced and latest revisions while cleaning old terminal data", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const old = new Date("2026-04-01T12:00:00.000Z");
    const first = await persistence.createPublication({
      publicationKey: "retention-feed",
      protocolVersion: "1.0",
      content: { value: 1 },
      contentHash: "sha256:retained-reference",
      publishedAt: old,
    });
    const removable = await persistence.appendRevision({
      publicationId: first.publication.publicationId,
      protocolVersion: "1.0",
      content: { value: 2 },
      contentHash: "sha256:removable",
      publishedAt: old,
    });
    const latest = await persistence.appendRevision({
      publicationId: first.publication.publicationId,
      protocolVersion: "1.0",
      content: { value: 3 },
      contentHash: "sha256:latest",
      publishedAt: old,
    });
    const device = await prisma.device.create({
      data: {
        name: "Retention test device",
        externalId: "retention-test-device",
        profileId: "browser-hd-1920x1080",
        deliveryPolicyId: "reference-connected-browser",
      },
    });
    await persistence.setDesiredRevision(
      device.id,
      first.revision.publicationRevisionId,
    );
    await prisma.outboxEvent.createMany({
      data: [
        {
          eventType: "debug.delivered",
          aggregateType: "Debug",
          aggregateId: "delivered",
          payload: {},
          status: "delivered",
          processedAt: old,
        },
        {
          eventType: "debug.dead-letter",
          aggregateType: "Debug",
          aggregateId: "dead-letter",
          payload: {},
          status: "dead-letter",
          processedAt: old,
        },
      ],
    });

    const result = await cleanup.cleanup(now);

    expect(result).toEqual({
      deliveredOutboxEvents: 1,
      deadLetterOutboxEvents: 1,
      publicationRevisions: 1,
    });
    expect(
      await prisma.publicationRevision.findUnique({
        where: { publicationRevisionId: removable.publicationRevisionId },
      }),
    ).toBeNull();
    expect(
      await prisma.publicationRevision.count({
        where: {
          publicationRevisionId: {
            in: [
              first.revision.publicationRevisionId,
              latest.publicationRevisionId,
            ],
          },
        },
      }),
    ).toBe(2);
    expect(
      await prisma.outboxEvent.count({ where: { status: "pending" } }),
    ).toBe(4);
  });

  test("keeps a pending outbox event across a client restart", async () => {
    await persistence.createPublication({
      publicationKey: "restart-feed",
      protocolVersion: "1.0",
      content: { value: "restart" },
      contentHash: "sha256:restart",
    });
    await prisma.$disconnect();

    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl(path) } },
    });
    await prisma.$connect();
    persistence = new PublicationPersistenceService(prisma as any);

    const events = await persistence.listOutboxEvents({ status: "pending" });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(PUBLICATION_EVENT_TYPES.revisionCreated);
  });

  test('pull reads only the desired immutable revision, survives restart and throttles real SQLite writes', async () => {
    const device = await prisma.device.create({ data: {
      name: 'Pull fixture', externalId: 'pull-fixture', profileId: 'trmnl-byod-7.5-mono',
      deliveryPolicyId: 'reference-sleepy', apiKey: 'legacy-pull-fixture-secret',
    } });
    const token = 'pull-fixture-credential-secret';
    await prisma.deviceCredential.create({ data: { deviceId: device.id, tokenHash: hashToken(token) } });
    const first = await persistence.createPublication({ publicationKey: 'pull-test', protocolVersion: '1.0',
      content: { fixtureArtifacts: ['mono-800x480-white-bmp'] }, contentHash: 'fixture-white' });
    const second = await persistence.appendRevision({ publicationId: first.publication.publicationId, protocolVersion: '1.0',
      content: { fixtureArtifacts: ['mono-800x480-black-bmp'] }, contentHash: 'fixture-black' });
    await persistence.setDesiredRevision(device.id, first.revision.publicationRevisionId);
    await prisma.$executeRawUnsafe('CREATE TABLE pull_write_count (writes INTEGER NOT NULL)');
    await prisma.$executeRawUnsafe('INSERT INTO pull_write_count VALUES (0)');
    await prisma.$executeRawUnsafe('CREATE TRIGGER count_pull_seen AFTER UPDATE OF last_seen_at ON devices BEGIN UPDATE pull_write_count SET writes = writes + 1; END');
    const beforeEvents = await prisma.outboxEvent.count();
    const beforeState = await persistence.getDevicePublicationState(device.id);

    const createModule = async () => {
      const module = await Test.createTestingModule({ imports: [DiscoveryModule], providers: [
        PullContentService, PullDeviceAuthService, PullLastSeenService, ProfileResolverService,
        DeviceConfigurationService, HttpPullTransportAdapter, TransportAdapterRegistry,
        { provide: PrismaService, useValue: prisma },
        { provide: DeliveryPolicyRegistry, useValue: new DeliveryPolicyRegistry([new SleepyDeliveryPolicy(), new ResponsivePullDeliveryPolicy()]) },
      ] }).compile();
      await module.init();
      return module;
    };
    let module = await createModule();
    const read = async () => module.get(PullContentService).read(await module.get(PullDeviceAuthService).authenticate({ authorization: `Bearer ${token}` }));
    try {
      const result = await read();
      expect(result.manifest.revision).toBe('1'); // Latest revision is deliberately NOT desired.
      for (let i = 0; i < 20; i++) expect((await read()).etag).toBe(result.etag);
      await module.close();
      expect(await prisma.$queryRawUnsafe<{ writes: number }[]>('SELECT writes FROM pull_write_count')).toEqual([{ writes: 1 }]);
      expect(await prisma.outboxEvent.count()).toBe(beforeEvents);
      expect(await persistence.getDevicePublicationState(device.id)).toEqual(beforeState);

      await prisma.$disconnect();
      await prisma.$connect();
      module = await createModule();
      expect((await read()).etag).toBe(result.etag);
      expect(await prisma.$queryRawUnsafe<{ writes: number }[]>('SELECT writes FROM pull_write_count')).toEqual([{ writes: 1 }]);
      const changed = await prisma.device.update({ where: { id: device.id }, data: { deliveryPolicyId: 'reference-responsive-pull' } });
      const responsive = await read();
      expect(responsive.etag).toBe(result.etag);
      expect(responsive.hints.refreshAfterSeconds).toBe(60);
      expect([changed.id, changed.externalId, changed.profileId, changed.playlistId, changed.apiKey]).toEqual([device.id, device.externalId, device.profileId, device.playlistId, device.apiKey]);
      await persistence.setDesiredRevision(device.id, second.publicationRevisionId);
      expect((await read()).etag).not.toBe(result.etag);
      await prisma.deviceCredential.updateMany({ where: { deviceId: device.id }, data: { revokedAt: new Date() } });
      await expect(read()).rejects.toThrow('Invalid device credentials');
    } finally { await module.close(); }
  }, 30_000);

  test('pull credentials cannot read another device publication', async () => {
    const owner = await prisma.device.create({ data: { name: 'Owner', profileId: 'trmnl-byod-7.5-mono', deliveryPolicyId: 'reference-sleepy' } });
    const other = await prisma.device.create({ data: { name: 'Other', profileId: 'trmnl-byod-7.5-mono', deliveryPolicyId: 'reference-sleepy' } });
    await prisma.deviceCredential.create({ data: { deviceId: other.id, tokenHash: hashToken('other-device-token') } });
    const publication = await persistence.createPublication({ publicationKey: 'owner', protocolVersion: '1.0', content: { fixtureArtifacts: ['mono-800x480-white-bmp'] }, contentHash: 'fixture' });
    await persistence.setDesiredRevision(owner.id, publication.revision.publicationRevisionId);
    const auth = new PullDeviceAuthService(prisma as any);
    const authenticated = await auth.authenticate({ authorization: 'Bearer other-device-token' });
    expect(authenticated.id).toBe(other.id);
    expect(await persistence.getDevicePublicationState(authenticated.id)).toBeNull();
  });
});
