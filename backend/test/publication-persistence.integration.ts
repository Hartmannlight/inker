import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
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

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "inker-publication-test-"));
    createdDirectories.push(directory);
    path = join(directory, "inker.db");
    await migrate(path);
    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl(path) } },
    });
    await prisma.$connect();
    persistence = new PublicationPersistenceService(prisma as any);
    cleanup = new PublicationCleanupService(prisma as any);
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    for (const directory of createdDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
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
      expect(await prisma.$queryRawUnsafe('SELECT writes FROM pull_write_count')).toEqual([{ writes: 1 }]);
      expect(await prisma.outboxEvent.count()).toBe(beforeEvents);
      expect(await persistence.getDevicePublicationState(device.id)).toEqual(beforeState);

      await prisma.$disconnect();
      await prisma.$connect();
      module = await createModule();
      expect((await read()).etag).toBe(result.etag);
      expect(await prisma.$queryRawUnsafe('SELECT writes FROM pull_write_count')).toEqual([{ writes: 1 }]);
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
