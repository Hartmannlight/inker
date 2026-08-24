import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PublicationCleanupService } from "../src/publications/publication-cleanup.service";
import { PublicationPersistenceService } from "../src/publications/publication-persistence.service";
import { PUBLICATION_EVENT_TYPES } from "../src/publications/publication-persistence.types";

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
});
