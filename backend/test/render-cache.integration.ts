import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { PrismaClient, type OutboxEvent, type Prisma } from '@prisma/client';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Test, type TestingModule } from '@nestjs/testing';
import { DiscoveryModule } from '@nestjs/core';
import { parsePresentationManifest } from '@inker/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { sha256 } from '../src/publications/publication-content';
import { ArtifactStore } from '../src/render-cache/artifact-store';
import { RenderCacheService, RENDER_READY, RENDER_REQUESTED } from '../src/render-cache/render-cache.service';
import { RENDERER_VERSION } from '../src/render-cache/render-input';
import { renderSnapshot } from '../src/render-cache/snapshot-renderer';
import { OutboxStore } from '../src/events/outbox.store';
import { PresentationService } from '../src/device-platform/presentation.service';
import { PullContentService } from '../src/device-platform/pull-content.service';
import { ProfileResolverService } from '../src/device-platform/profile-resolver.service';
import { DeviceConfigurationService } from '../src/device-platform/device-configuration.service';
import { DeliveryPolicyRegistry } from '../src/device-platform/delivery-policy.registry';
import { SleepyDeliveryPolicy, ResponsivePullDeliveryPolicy } from '../src/device-platform/delivery-policies';
import { TransportAdapterRegistry } from '../src/device-platform/transport-adapter.registry';
import { HttpPullTransportAdapter } from '../src/device-platform/http-pull.transport-adapter';
import { PullLastSeenService } from '../src/device-platform/pull-last-seen.service';

const root = resolve(import.meta.dir, '..');
type TargetDevice = Prisma.DeviceGetPayload<{ include: { profile: true; deliveryPolicy: true; publicationState: { include: { desiredRevision: true } } } }>;

describe('WP-19 persistent render cache', () => {
  let directory: string;
  let url: string;
  let previousCachePath: string | undefined;
  let prisma: PrismaClient;
  let files: ArtifactStore;
  let cache: RenderCacheService;
  let publisher: PublishService;
  let outbox: OutboxStore;
  let device: TargetDevice;
  let writes: string[];
  let pullModule: TestingModule | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-render-cache-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    previousCachePath = process.env.INKER_RENDER_CACHE_PATH;
    process.env.INKER_RENDER_CACHE_PATH = join(directory, 'artifacts');
    const migration = spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited,
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
    prisma = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    writes = [];
    prisma.$on('query' as never, (event: { query: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
    });
    await prisma.$connect();
    files = new ArtifactStore();
    cache = new RenderCacheService(prisma as PrismaService, files);
    publisher = new PublishService(prisma as PrismaService, new PublicationPersistenceService(prisma as PrismaService));
    outbox = new OutboxStore(prisma as PrismaService);
    const created = await prisma.device.create({ data: {
      name: 'render-browser', externalId: randomUUID(), profileId: 'browser-hd-1920x1080',
      deliveryPolicyId: 'reference-connected-browser', lastSeenAt: new Date(),
    } });
    await publish([created.id]);
    device = await reload(created.id);
  }, 30_000);

  afterEach(async () => {
    await pullModule?.close();
    pullModule = undefined;
    await prisma?.$disconnect();
    if (previousCachePath === undefined) delete process.env.INKER_RENDER_CACHE_PATH;
    else process.env.INKER_RENDER_CACHE_PATH = previousCachePath;
    // Only this test's mkdtemp directory; no shared uploads, database or service.
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  async function reload(id = device.id): Promise<TargetDevice> {
    return prisma.device.findUniqueOrThrow({ where: { id }, include: {
      profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
    } });
  }

  async function publish(deviceIds: number[], expectedRevision = 0, black = false) {
    return publisher.publish('render-integration', {
      idempotencyKey: randomUUID(), expectedRevision, deviceIds,
      draft: { fixtureArtifacts: [black ? 'mono-800x480-black-bmp' : 'mono-800x480-white-png'] },
    });
  }

  async function claimRender(key: string, owner = 'render-integration'): Promise<OutboxEvent> {
    // Fixture publish/assignment events are acknowledged without transports;
    // the render event itself is always claimed through the real CAS/lease store.
    for (let i = 0; i < 100; i++) {
      const event = await outbox.claim(owner);
      if (!event) throw new Error('Expected a pending render event');
      if (event.eventType === RENDER_REQUESTED && event.aggregateId === key) return event;
      if (event.eventType === RENDER_REQUESTED) throw new Error('Unexpected render request in fixture');
      expect(await outbox.ack(event)).toBe(true);
    }
    throw new Error('Render event was not reached');
  }

  async function requestAndRender() {
    const key = await cache.request(device.id);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    const event = await claimRender(key!);
    await cache.render(event);
    expect(await outbox.ack(event)).toBe(true);
    return { key: key!, event };
  }

  async function read() {
    device = await reload();
    return cache.read(device, device.publicationState!.desiredRevision!);
  }

  async function processRun(input: Record<string, unknown>) {
    const child = spawn(['node', join(root, 'test/fixtures/render-process.cjs'), url, files.root], {
      cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ deviceId: device.id, ...input }));
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect([0, 73], stderr + stdout).toContain(exit);
    return { exit, ...(stdout ? JSON.parse(stdout) : {}) };
  }

  test('20 simultaneous identical display requests persist one render job and 20 bindings', async () => {
    const others = await Promise.all(Array.from({ length: 19 }, (_, index) =>
      prisma.device.create({ data: { name: `render-peer-${index}`, externalId: randomUUID(),
        profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser', lastSeenAt: new Date() } })));
    const deviceIds = [device.id, ...others.map(peer => peer.id)];
    for (const id of deviceIds.slice(1)) await publisher.assign(id, {
      publicationRevisionId: device.publicationState!.desiredRevision!.publicationRevisionId, expectedDesiredRevisionId: null,
    });
    const requests = await Promise.allSettled(deviceIds.map(id => cache.request(id)));
    const failures = requests.filter(result => result.status === 'rejected');
    expect(failures).toEqual([]);
    const keys = requests.map(result => result.status === 'fulfilled' ? result.value : undefined);
    expect(new Set(keys).size).toBe(1);
    expect(await prisma.renderRequest.count()).toBe(1);
    expect(await prisma.renderBinding.count()).toBe(20);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_REQUESTED } })).toBe(1);
    const event = await claimRender(keys[0]!);
    let renders = 0;
    await cache.render(event, async (...args) => { renders++; return renderSnapshot(...args); });
    expect(renders).toBe(1);
    expect(await prisma.renderBinding.count({ where: { readyKey: keys[0] } })).toBe(20);
    const stored = await prisma.renderRequest.findUniqueOrThrow({ where: { key: keys[0] } });
    expect(stored.rendererVersion).toBe(RENDERER_VERSION);
    expect(stored.completedAt).toBeInstanceOf(Date);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.mimeType).toBe('image/png');
    const bytes = await files.read(stored.artifactHash!, stored.sizeBytes!);
    expect(sha256(bytes)).toBe(stored.artifactHash!);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 1920, height: 1080 });
    expect(readdirSync(files.root)).toEqual([stored.artifactHash!]);
  }, 30_000);

  test('two independent processes deduplicate the same request and a restart reads persisted bytes', async () => {
    const processes = await Promise.allSettled([processRun({ operation: 'request' }), processRun({ operation: 'request' })]);
    expect(processes.filter(result => result.status === 'rejected')).toEqual([]);
    const results = processes.map(result => result.status === 'fulfilled' ? result.value : undefined);
    expect(results[0].result).toBe(results[1].result);
    expect(await prisma.renderRequest.count()).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_REQUESTED } })).toBe(1);
    const event = await claimRender(results[0].result);
    const worker = await processRun({ operation: 'render', eventId: event.eventId });
    expect(worker.result.rendered).toBe(1);
    const first = await read();
    const restarted = await processRun({ operation: 'read' });
    expect(restarted.result).toEqual({ hash: first!.artifact.sha256, sizeBytes: first!.artifact.bytes.length,
      revision: first!.revision.revision, fallback: false });
  }, 30_000);

  test('cache hits and browser manifest/artifact reads perform zero SQL writes and no rerender', async () => {
    await requestAndRender();
    const first = await read();
    const presentations = new PresentationService(prisma as PrismaService, cache);
    writes.length = 0;
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.read(device, device.publicationState!.desiredRevision!)));
    const manifests = await Promise.all(Array.from({ length: 20 }, () => presentations.getForDevice(device.id)));
    const artifact = await presentations.artifact(device.id, first!.artifact.sha256);
    expect(results.every(result => result?.artifact.sha256 === first!.artifact.sha256 && !result.fallback)).toBe(true);
    expect(manifests.every(manifest => JSON.stringify(manifest) === JSON.stringify(manifests[0]))).toBe(true);
    expect(artifact.bytes).toEqual(first!.artifact.bytes);
    expect(writes).toEqual([]);
    expect(cache.metrics().rendered).toBe(1);
  }, 30_000);

  test('a failed second render preserves compatible last-good bytes and manifest across restart', async () => {
    await requestAndRender();
    const previous = await read();
    await publish([device.id], 1, true);
    const key = await cache.request(device.id);
    const event = await claimRender(key!);
    await expect(cache.render(event, async () => { throw new Error('synthetic-renderer-failure'); })).rejects.toThrow('RENDER_FAILED');
    const fallback = await read();
    expect(fallback?.fallback).toBe(true);
    expect(fallback?.artifact.bytes).toEqual(previous!.artifact.bytes);
    expect(fallback?.revision.publicationRevisionId).toBe(previous!.revision.publicationRevisionId);
    expect((await prisma.renderRequest.findUniqueOrThrow({ where: { key } })).completedAt).toBeNull();
    const restarted = await processRun({ operation: 'read' });
    expect(restarted.result).toMatchObject({ hash: previous!.artifact.sha256, fallback: true, revision: 1 });
    expect(await new PresentationService(prisma as PrismaService, cache).artifact(device.id, previous!.artifact.sha256))
      .toMatchObject({ sha256: previous!.artifact.sha256 });
  }, 30_000);

  test('E-Ink pull uses cached BMP bytes, retains read-only fallback and does not rerender a policy change', async () => {
    await prisma.device.update({ where: { id: device.id }, data: {
      profileId: 'trmnl-byod-7.5-mono', deliveryPolicyId: 'reference-sleepy',
    } });
    device = await reload();
    const { key } = await requestAndRender();
    pullModule = await Test.createTestingModule({ imports: [DiscoveryModule], providers: [
      { provide: PrismaService, useValue: prisma }, { provide: RenderCacheService, useValue: cache },
      { provide: DeliveryPolicyRegistry, useValue: new DeliveryPolicyRegistry([
        new SleepyDeliveryPolicy(), new ResponsivePullDeliveryPolicy(),
      ]) },
      ProfileResolverService, DeviceConfigurationService, TransportAdapterRegistry,
      HttpPullTransportAdapter, PullLastSeenService, PullContentService,
    ] }).compile();
    await pullModule.init();
    const pull = pullModule.get(PullContentService);
    writes.length = 0;
    const first = await pull.read(device);
    expect(parsePresentationManifest(first.manifest).success).toBe(true);
    expect(first.artifact).toMatchObject({ format: 'bmp1', mimeType: 'image/bmp', width: 800, height: 480, bitDepth: 1 });
    expect(first.artifact.bytes.readUInt16LE(28)).toBe(1);
    expect(first.manifest.metadata).toMatchObject({ rendererVersion: RENDERER_VERSION, eInk: { fullRefreshRequired: true } });
    expect(first.hints.refreshAfterSeconds).toBe(900);
    expect(writes).toEqual([]);

    await prisma.device.update({ where: { id: device.id }, data: { deliveryPolicyId: 'reference-responsive-pull' } });
    device = await reload();
    expect(await cache.request(device.id)).toBe(key);
    expect(await prisma.renderRequest.count()).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_REQUESTED } })).toBe(1);
    const responsive = await pull.read(device);
    expect(responsive.etag).toBe(first.etag);
    expect(responsive.hints.refreshAfterSeconds).toBe(60);

    await publish([device.id], 1, true);
    const nextKey = await cache.request(device.id);
    const failed = await claimRender(nextKey!);
    await expect(cache.render(failed, async () => { throw new Error('synthetic failure'); })).rejects.toThrow('RENDER_FAILED');
    device = await reload();
    writes.length = 0;
    const fallback = await pull.read(device);
    expect(fallback.artifact.bytes).toEqual(first.artifact.bytes);
    expect(fallback.etag).toBe(first.etag);
    expect(fallback.manifest.fallbackRevision).toBe('1');
    expect(fallback.manifest.metadata).toMatchObject({ desiredRevision: '2', fallback: true });
    expect(parsePresentationManifest(fallback.manifest).success).toBe(true);
    expect(writes).toEqual([]);
  }, 30_000);

  test('a profile variant change cannot reuse an incompatible fallback and does not write on miss', async () => {
    await requestAndRender();
    await prisma.device.update({ where: { id: device.id }, data: { capabilitiesOverride: { display: { width: 1280, height: 720 } } } });
    device = await reload();
    writes.length = 0;
    expect(await cache.read(device, device.publicationState!.desiredRevision!)).toBeNull();
    expect(writes).toEqual([]);
    const key = await cache.request(device.id);
    expect(await prisma.renderRequest.count()).toBe(2);
    const event = await claimRender(key!);
    await cache.render(event);
    expect((await read())?.artifact).toMatchObject({ width: 1280, height: 720 });
  }, 30_000);

  test('completed duplicate delivery never invokes the renderer or changes artifact metadata', async () => {
    const { key, event } = await requestAndRender();
    const stored = await prisma.renderRequest.findUniqueOrThrow({ where: { key } });
    writes.length = 0;
    await cache.render(event, async () => { throw new Error('completed work must not rerender'); });
    expect(writes).toEqual([]);
    expect(await prisma.renderRequest.findUniqueOrThrow({ where: { key } })).toEqual(stored);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(1);
    expect(await cache.request(device.id)).toBe(key);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_REQUESTED } })).toBe(1);
  });

  test('reactivation promotes a render completed while inactive and preserves it as the next fallback', async () => {
    const key = await cache.request(device.id);
    const event = await claimRender(key!);
    await prisma.device.update({ where: { id: device.id }, data: { isActive: false } });
    await cache.render(event);
    expect(await outbox.ack(event)).toBe(true);
    expect((await prisma.renderRequest.findUniqueOrThrow({ where: { key } })).completedAt).not.toBeNull();
    const pending = await prisma.renderBinding.findFirstOrThrow({ where: { deviceId: device.id } });
    expect(pending.desiredKey).toBe(key!);
    expect(pending.readyKey).toBeNull();
    expect((await reload()).renderRevision).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(0);

    await prisma.device.update({ where: { id: device.id }, data: { isActive: true } });
    await cache.reconcile();
    const promoted = await prisma.renderBinding.findFirstOrThrow({ where: { deviceId: device.id } });
    expect(promoted.readyKey).toBe(key!);
    expect((await reload()).renderRevision).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_REQUESTED } })).toBe(1);
    const ready = await read();
    expect(ready?.fallback).toBe(false);
    await cache.reconcile();
    expect((await reload()).renderRevision).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(1);

    await publish([device.id], 1, true);
    const nextKey = await cache.request(device.id);
    const nextEvent = await claimRender(nextKey!);
    await expect(cache.render(nextEvent, async () => { throw new Error('synthetic renderer failure'); }))
      .rejects.toThrow('RENDER_FAILED');
    const fallback = await read();
    expect(fallback?.fallback).toBe(true);
    expect(fallback?.artifact.bytes).toEqual(ready!.artifact.bytes);
    expect(fallback?.revision.publicationRevisionId).toBe(ready!.revision.publicationRevisionId);
  }, 30_000);

  test('a real process crash after atomic file publication leaves no ready metadata and recovers through a new lease', async () => {
    const key = await cache.request(device.id);
    const event = await claimRender(key!, 'crashed-worker');
    const crashed = await processRun({ operation: 'render', eventId: event.eventId, crashAfterPublish: true });
    expect(crashed.exit).toBe(73);
    expect(crashed.phase).toBe('file-published');
    expect(readdirSync(files.root)).toEqual([crashed.hash]);
    expect(sha256(readFileSync(join(files.root, crashed.hash)))).toBe(crashed.hash);
    expect((await prisma.renderRequest.findUniqueOrThrow({ where: { key } })).completedAt).toBeNull();
    expect(await prisma.renderBinding.count({ where: { readyKey: { not: null } } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(0);
    expect(await read()).toBeNull();
    // Expire only the isolated test's durable lease, then exercise the real
    // OutboxStore CAS takeover rather than constructing a pretend claim token.
    await prisma.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(Date.now() - 1) } });
    const recovered = await claimRender(key!, 'recovery-worker');
    expect(recovered.claimToken).not.toBe(event.claimToken);
    expect(recovered.attempts).toBe(2);
    await expect(cache.render(event)).rejects.toThrow('RENDER_STALE_CLAIM');
    expect((await processRun({ operation: 'render', eventId: recovered.eventId })).result.rendered).toBe(1);
    expect(await outbox.ack(recovered)).toBe(true);
    const result = await read();
    expect(result?.artifact.sha256).toBe(crashed.hash);
    expect(result?.fallback).toBe(false);
    expect(await prisma.outboxEvent.count({ where: { eventType: RENDER_READY } })).toBe(1);
    expect(readdirSync(files.root)).toEqual([crashed.hash]);
  }, 30_000);

  test('invalid rendered bytes are never published and corrupt current files fall back without writes', async () => {
    const first = await requestAndRender();
    const previous = await read();
    await publish([device.id], 1, true);
    const key = await cache.request(device.id);
    const event = await claimRender(key!);
    await expect(cache.render(event, async (...args) => {
      const artifact = await renderSnapshot(...args);
      return { ...artifact, bytes: Buffer.from('not-an-image') };
    })).rejects.toThrow('RENDER_FAILED');
    expect(readdirSync(files.root)).toEqual([previous!.artifact.sha256]);
    await cache.render(event);
    const current = await read();
    expect(current?.artifact.sha256).not.toBe(previous!.artifact.sha256);
    writeFileSync(join(files.root, current!.artifact.sha256), 'damaged isolated test artifact');
    writes.length = 0;
    const fallback = await read();
    expect(fallback?.artifact.sha256).toBe(previous!.artifact.sha256);
    expect(fallback?.fallback).toBe(true);
    expect(writes).toEqual([]);
    expect((await prisma.renderRequest.findUniqueOrThrow({ where: { key: first.key } })).completedAt).not.toBeNull();
  }, 30_000);
});
