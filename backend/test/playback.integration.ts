import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrismaClient, type OutboxEvent } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { PlaybackService } from "../src/playback/playback.service";
import { PublicationPersistenceService } from "../src/publications/publication-persistence.service";
import { PublishService } from "../src/publications/publish.service";
import { PublicationCleanupService } from "../src/publications/publication-cleanup.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { OutboxStore } from "../src/events/outbox.store";
import {
  PLAYBACK_DUE,
  parsePlaybackEvent,
} from "../src/playback/playback.events";
import { DevicePlatformModule } from "../src/device-platform/device-platform.module";
import { EventsModule } from "../src/events/events.module";
import { PresentationService } from "../src/device-platform/presentation.service";
import { PullContentService } from "../src/device-platform/pull-content.service";

const root = resolve(import.meta.dir, "..");
type Result = {
  playlistRevisionId: string;
  version: number;
  desiredSequence: number;
  currentItemId: number;
  nextTransitionAt: string | null;
};
describe("WP-18 persistent playback", () => {
  let directory: string,
    url: string,
    p: PrismaClient,
    playback: PlaybackService,
    publisher: PublishService,
    persistence: PublicationPersistenceService;
  let now: number,
    deviceId: number,
    playlistId: number,
    itemIds: number[],
    revisionIds: string[],
    release: Result,
    writes: string[];
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "inker-playback-"));
    url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
    const child = Bun.spawn(
      [process.execPath, join(root, "scripts/migrate-database.ts")],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, out + err).toBe(0);
    p = new PrismaClient({
      datasources: { db: { url } },
      log: [{ level: "query", emit: "event" }],
    });
    writes = [];
    p.$on("query" as never, (e: { query: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(e.query))
        writes.push(e.query);
    });
    persistence = new PublicationPersistenceService(p as PrismaService);
    publisher = new PublishService(p as PrismaService, persistence);
    now = Date.parse("2026-08-27T12:00:00.000Z");
    playback = new PlaybackService(p as PrismaService, persistence, {
      now: () => now,
    });
    const device = await p.device.create({
      data: {
        name: "playback",
        externalId: "playback",
        profileId: "browser-hd-1920x1080",
        deliveryPolicyId: "reference-connected-browser",
        lastSeenAt: new Date(),
      },
    });
    deviceId = device.id;
    revisionIds = [];
    for (let i = 0; i < 3; i++) {
      const r = (await publisher.publish(`entry-${i}`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        deviceIds: [],
        draft: {
          fixtureArtifacts: [
            "mono-800x480-white-bmp",
            "mono-800x480-white-png",
          ],
        },
      })) as { publicationRevisionId: string };
      revisionIds.push(r.publicationRevisionId);
    }
    const playlist = await p.playlist.create({
      data: {
        name: "draft",
        items: {
          create: [10, 20, 30].map((duration, order) => ({ duration, order })),
        },
      },
      include: { items: { orderBy: { order: "asc" } } },
    });
    playlistId = playlist.id;
    itemIds = playlist.items.map((i) => i.id);
    release = await publish();
  }, 30_000);
  afterEach(async () => {
    await p?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function publish(
    expectedRevision = 0,
    ids = itemIds,
    refs = revisionIds,
  ) {
    return (await playback.publish(playlistId, {
      version: 1,
      idempotencyKey: randomUUID(),
      expectedRevision,
      expectedDraftHash: (await playback.draft(playlistId)).draftHash,
      bindings: ids.map((itemId, i) => ({
        itemId,
        publicationRevisionId: refs[i],
      })),
    })) as unknown as Result;
  }
  function body(action = "start", version = 0, desiredSequence = 0) {
    return {
      version: 1,
      idempotencyKey: randomUUID(),
      action,
      expectedVersion: version,
      expectedDesiredSequence: desiredSequence,
      ...(["start", "change"].includes(action)
        ? { playlistRevisionId: release.playlistRevisionId }
        : {}),
    };
  }
  async function execute(action = "start", version = 0, desiredSequence = 0) {
    return (await playback.execute(
      deviceId,
      body(action, version, desiredSequence),
    )) as unknown as Result;
  }
  async function due(): Promise<OutboxEvent> {
    const event = await p.outboxEvent.findFirstOrThrow({
      where: { eventType: PLAYBACK_DUE, status: "pending" },
    });
    // Claim this specific persisted schedule with the same WP-16 fence shape.
    return p.outboxEvent.update({
      where: { eventId: event.eventId },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        claimOwner: "playback-test",
        claimToken: randomUUID(),
        claimUntil: new Date(now + 30_000),
      },
    });
  }
  async function processRun(input: Record<string, unknown>) {
    const child = Bun.spawn(
      ["node", join(root, "test/fixtures/playback-process.cjs"), url],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(JSON.stringify({ now, deviceId, ...input }));
    child.stdin.end();
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect([0, 73], err).toContain(exit);
    return { exit, ...(out ? JSON.parse(out) : {}) };
  }

  test("explicit publication freezes order, durations and references; draft mutation/deletion has no delivery effect", async () => {
    const started = await execute();
    const manifest = await new PresentationService(
      p as PrismaService,
    ).getForDevice(deviceId);
    await p.playlistItem.update({
      where: { id: itemIds[0] },
      data: { duration: 1, order: 99 },
    });
    await p.playlist.delete({ where: { id: playlistId } });
    expect(
      await new PresentationService(p as PrismaService).getForDevice(deviceId),
    ).toEqual(manifest);
    now += 15_000;
    await playback.advanceDue(await due());
    const state = await playback.read(deviceId);
    expect(state.state?.currentItemId).toBe(itemIds[1]);
    expect(state.version).toBe(started.version + 1);
    await expect(
      Promise.resolve(
        p.publishedPlaylist.update({
          where: { id: release.playlistRevisionId },
          data: { contentHash: "mutated" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        p.publishedPlaylistEntry.update({
          where: {
            playlistRevisionId_ordinal: {
              playlistRevisionId: release.playlistRevisionId,
              ordinal: 0,
            },
          },
          data: { durationMs: 1 },
        }),
      ),
    ).rejects.toThrow();
  });
  test("two real processes project identically; killed process restarts at the correct item after long downtime", async () => {
    await execute();
    now += 6_000_035_000;
    const [a, b] = await Promise.all([
      processRun({ operation: "read" }),
      processRun({ operation: "read" }),
    ]);
    expect(a.result).toEqual(b.result);
    expect(a.result.projected.itemId).toBe(itemIds[2]);
    const event = await due();
    expect(
      (
        await processRun({
          operation: "due",
          eventId: event.eventId,
          crashAfterCommit: true,
        })
      ).exit,
    ).toBe(73);
    const restarted = await processRun({ operation: "read" });
    expect(restarted.result.state.currentItemId).toBe(itemIds[2]);
    expect(restarted.result.state.anchorAt).toBe(a.result.state.anchorAt);
    expect(restarted.result.state.nextTransitionAt).toBe(
      new Date(now + 25_000).toISOString(),
    );
    expect(
      await p.outboxEvent.count({
        where: { eventType: PLAYBACK_DUE, status: "pending" },
      }),
    ).toBe(1);
  }, 30_000);
  test("concurrent commands in independent processes have one winner; exact duplicate receipt replays without writes", async () => {
    const command = body();
    const same = await Promise.all([
      processRun({ operation: "command", body: command }),
      processRun({ operation: "command", body: command }),
    ]);
    expect(same[0].result).toEqual(same[1].result);
    expect(same[0].result.version).toBe(1);
    writes.length = 0;
    await playback.execute(deviceId, command);
    expect(writes).toEqual([]);
    const results = await Promise.all([
      processRun({ operation: "command", body: body("advance", 1, 1) }),
      processRun({ operation: "command", body: body("pause", 1, 1) }),
    ]);
    expect(results.filter((r) => r.result)).toHaveLength(1);
    expect(results.filter((r) => r.error === 409)).toHaveLength(1);
  }, 30_000);
  test("duplicate jobs, stale state versions and expired claim tokens cannot advance twice", async () => {
    await execute();
    now += 10_000;
    const event = await due();
    await Promise.all([
      processRun({ operation: "due", eventId: event.eventId }),
      processRun({ operation: "due", eventId: event.eventId }),
    ]);
    expect((await playback.read(deviceId)).version).toBe(2);
    const duplicate = await p.outboxEvent.create({
      data: {
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateRevision: event.aggregateRevision,
        payload: event.payload!,
        payloadVersion: 1,
        status: "processing",
        claimOwner: "duplicate",
        claimToken: randomUUID(),
        claimUntil: new Date(now + 30_000),
      },
    });
    await playback.advanceDue(duplicate);
    expect((await playback.read(deviceId)).version).toBe(2);
    const next = await due();
    await execute("pause", 2, 2);
    now += 20_000;
    await playback.advanceDue(next); // valid claim, superseded state version
    expect((await playback.read(deviceId)).state?.status).toBe("paused");
    await p.outboxEvent.update({
      where: { eventId: event.eventId },
      data: { claimToken: "new-owner-token" },
    });
    await expect(playback.advanceDue(event)).rejects.toThrow(
      "OUTBOX_CLAIM_EXPIRED",
    );
  }, 30_000);
  test("rollback restores playback, desired sequence, receipt and both outbox event types", async () => {
    await p.$executeRawUnsafe(
      `CREATE TRIGGER fail_playback_event BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'playback.transition.due' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
    );
    const before = await p.outboxEvent.count();
    await expect(execute()).rejects.toThrow();
    expect(await p.playbackState.count()).toBe(0);
    expect(await p.devicePublicationState.count()).toBe(0);
    expect(
      (await p.device.findUniqueOrThrow({ where: { id: deviceId } }))
        .presentationRevision,
    ).toBe(0);
    expect(await p.outboxEvent.count()).toBe(before);
    expect(await p.playbackCommand.count()).toBe(1); // publication receipt only
    await p.$executeRawUnsafe("DROP TRIGGER fail_playback_event");
    await execute();
    now += 10_000;
    const event = await due();
    await p.$executeRawUnsafe(
      `CREATE TRIGGER fail_desired_event BEFORE INSERT ON outbox_events WHEN NEW.event_type = 'device.publication.desired-revision.changed' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
    );
    await expect(playback.advanceDue(event)).rejects.toThrow();
    expect((await playback.read(deviceId)).version).toBe(1);
    expect(
      (
        await p.devicePublicationState.findUniqueOrThrow({
          where: { deviceId },
        })
      ).desiredSequence,
    ).toBe(1);
    expect(await p.outboxEffect.count()).toBe(0);
    await p.$executeRawUnsafe("DROP TRIGGER fail_desired_event");
    await playback.advanceDue(event);
    expect((await playback.read(deviceId)).version).toBe(2);
  });
  test("WP-20 timer abort inside an open transaction rolls back playback, desired state and outbox", async () => {
    await execute();
    now += 10_000;
    const event = await due();
    const snapshot = () => Promise.all([
      p.playbackState.findMany({ orderBy: { id: 'asc' } }),
      p.devicePublicationState.findMany({ orderBy: { deviceId: 'asc' } }),
      p.device.findMany({ orderBy: { id: 'asc' } }),
      p.outboxEvent.findMany({ orderBy: { eventId: 'asc' } }),
      p.outboxEffect.findMany({ orderBy: { key: 'asc' } }),
    ]);
    const before = await snapshot();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort('sensitive-test-reason');
    writes.length = 0;
    await expect(playback.advanceDue(event, alreadyAborted.signal)).rejects.toThrow('PLAYBACK_ABORTED');
    expect(writes).toEqual([]);

    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    class HeldPublicationPersistence extends PublicationPersistenceService {
      override async setDesiredRevision(...args: Parameters<PublicationPersistenceService['setDesiredRevision']>) {
        // Execute real writes first, then keep the same real SQLite transaction open.
        const result = await super.setDesiredRevision(...args);
        entered();
        await held;
        return result;
      }
    }
    const delayed = new PlaybackService(p as PrismaService, new HeldPublicationPersistence(p as PrismaService), { now: () => now });
    const controller = new AbortController();
    const pending = delayed.advanceDue(event, controller.signal);
    try {
      await inside;
      expect(writes.some(query => query.includes('device_publication_states'))).toBe(true);
      // A real timer cancels work after domain writes, before commit. No production fail switch.
      const timer = setTimeout(() => { controller.abort('sensitive-test-reason'); release(); }, 25);
      try { await expect(pending).rejects.toThrow('PLAYBACK_ABORTED'); }
      finally { clearTimeout(timer); }
    } finally { release(); }
    expect(await snapshot()).toEqual(before);
    // The durable claim remains retryable after rollback.
    await playback.advanceDue(event);
    expect((await playback.read(deviceId)).version).toBe(2);
  });
  test("crash-before-dispatch and crash-after-commit recover through WP-16 leases and persistent effects", async () => {
    await execute();
    now += 10_000;
    const event = await due();
    const store = new OutboxStore(p as PrismaService);
    // Domain state survives before dispatch; only the lease expires.
    now += 30_001;
    await p.outboxEvent.updateMany({
      where: { eventId: { not: event.eventId }, status: "pending" },
      data: { availableAt: new Date(now + 100_000) },
    });
    const recovered = await store.claim("restarted", new Date(now));
    expect(recovered?.eventId).toBe(event.eventId);
    await expect(playback.advanceDue(event)).rejects.toThrow(
      "OUTBOX_CLAIM_EXPIRED",
    );
    await playback.advanceDue(recovered!);
    const state = await playback.read(deviceId);
    await playback.advanceDue(recovered!); // lost ack
    expect((await playback.read(deviceId)).state).toEqual(state.state);
    expect(await store.ack(event, new Date(now))).toBe(false);
    expect(await store.ack(recovered!, new Date(now))).toBe(true);
  });
  test("A to B to A is monotonic, while playback version and publication revision remain distinct", async () => {
    const a = await execute();
    const b = await execute("advance", a.version, a.desiredSequence);
    const c = await execute("advance", b.version, b.desiredSequence);
    const again = await execute("advance", c.version, c.desiredSequence);
    expect(again.desiredSequence).toBe(4);
    const desired = await p.devicePublicationState.findUniqueOrThrow({
      where: { deviceId },
      include: { desiredRevision: true },
    });
    expect(desired.desiredPublicationRevisionId).toBe(revisionIds[0]);
    expect(desired.desiredRevision?.revision).toBe(1);
    await expect(
      publisher.assign(deviceId, {
        publicationRevisionId: revisionIds[1],
        expectedDesiredRevisionId: revisionIds[0],
      }),
    ).rejects.toThrow("Stop playback");
    const paused = await execute("pause", again.version, again.desiredSequence);
    expect(paused.desiredSequence).toBe(again.desiredSequence);
    const stopped = await execute(
      "stop",
      paused.version,
      paused.desiredSequence,
    );
    await publisher.assign(deviceId, {
      publicationRevisionId: revisionIds[1],
      expectedDesiredRevisionId: revisionIds[0],
    });
    await expect(
      execute("start", stopped.version, stopped.desiredSequence),
    ).rejects.toThrow("sequence conflict");
  });
  test("pause/resume, backwards clock, explicit change/removal and empty release survive persistence", async () => {
    const a = await execute();
    now += 15_000;
    const pause = await execute("pause", a.version, a.desiredSequence);
    expect(pause.currentItemId).toBe(itemIds[1]);
    now -= 100_000;
    const resume = await execute(
      "resume",
      pause.version,
      pause.desiredSequence,
    );
    expect(resume.nextTransitionAt).toBe(
      new Date(Date.parse("2026-08-27T12:00:30Z")).toISOString(),
    );
    await p.playlistItem.delete({ where: { id: itemIds[1] } });
    release = await publish(
      1,
      [itemIds[0], itemIds[2]],
      [revisionIds[0], revisionIds[2]],
    );
    const changed = await execute(
      "change",
      resume.version,
      resume.desiredSequence,
    );
    expect(changed.currentItemId).toBe(itemIds[0]);
    await p.playlistItem.deleteMany({ where: { playlistId } });
    release = await publish(2, [], []);
    const empty = await execute(
      "change",
      changed.version,
      changed.desiredSequence,
    );
    expect(empty.nextTransitionAt).toBeNull();
    expect(empty.desiredSequence).toBe(changed.desiredSequence);
    expect(
      await p.outboxEvent.count({
        where: { eventType: PLAYBACK_DUE, status: "pending" },
      }),
    ).toBe(0);
  });
  test("missing publications, changed drafts, invalid commands and invalid event payloads fail closed", async () => {
    await expect(
      publish(1, itemIds, ["missing", ...revisionIds.slice(1)]),
    ).rejects.toThrow("Publication revision not found");
    await expect(
      playback.execute(deviceId, { ...body(), token: "do-not-store" }),
    ).rejects.toThrow("Invalid playback command");
    const draft = await playback.draft(playlistId);
    await p.playlistItem.update({
      where: { id: itemIds[0] },
      data: { duration: 0 },
    });
    await expect(
      playback.publish(playlistId, {
        version: 1,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        expectedDraftHash: draft.draftHash,
        bindings: itemIds.map((itemId, i) => ({
          itemId,
          publicationRevisionId: revisionIds[i],
        })),
      }),
    ).rejects.toThrow("draft changed");
    await expect(publish(1)).rejects.toThrow("duration");
    await execute();
    now += 10_000;
    const event = await due();
    expect(() =>
      parsePlaybackEvent({
        ...event,
        payload: { ...(event.payload as object), token: "do-not-store" },
      }),
    ).toThrow("OUTBOX_INVALID_PAYLOAD");
    expect(JSON.stringify(await p.outboxEvent.findMany())).not.toContain(
      "do-not-store",
    );
  });
  test("retention protects every pinned playlist publication; terminal event cleanup cannot replay a command", async () => {
    const command = body();
    await playback.execute(deviceId, command);
    await publisher.publish("entry-1", {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      deviceIds: [],
      draft: { fixtureArtifacts: ["mono-800x480-black-bmp"] },
    });
    await new PublicationCleanupService(p as PrismaService).cleanup(
      new Date("2030-01-01"),
    );
    expect(
      await p.publicationRevision.findUnique({
        where: { publicationRevisionId: revisionIds[1] },
      }),
    ).not.toBeNull();
    await execute("advance", 1, 1);
    writes.length = 0;
    await playback.execute(deviceId, command);
    expect(writes).toEqual([]);
    expect((await playback.read(deviceId)).version).toBe(2);
  });
  test("100 sequential and 100 parallel browser and pull reads never advance even past a due boundary", async () => {
    await execute();
    const pull = await p.device.create({
      data: {
        name: "pull",
        profileId: "trmnl-byod-7.5-mono",
        deliveryPolicyId: "reference-sleepy",
        lastSeenAt: new Date(),
      },
      include: { profile: true, deliveryPolicy: true },
    });
    await playback.execute(pull.id, body());
    const module = await Test.createTestingModule({
      imports: [DevicePlatformModule, EventsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(p)
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const read = async () => [
        await module.get(PresentationService).getForDevice(deviceId),
        (await module.get(PullContentService).read(pull)).manifest,
      ];
      const before = await read();
      now += 1_000_000;
      const count = await p.outboxEvent.count();
      writes.length = 0;
      for (let i = 0; i < 100; i++) expect(await read()).toEqual(before);
      for (const value of await Promise.all(Array.from({ length: 100 }, read)))
        expect(value).toEqual(before);
      expect(writes).toEqual([]);
      expect(await p.outboxEvent.count()).toBe(count);
      expect(before[0]).toHaveProperty("nextTransitionAt", null);
      expect(before[1]).toHaveProperty("revision", "1");
      expect((await playback.read(deviceId)).version).toBe(1);
    } finally {
      await app.close();
    }
  }, 30_000);

  test("null duration and singleton releases never create a repeated automatic schedule", async () => {
    await p.playlistItem.update({
      where: { id: itemIds[1] },
      data: { duration: null },
    });
    release = await publish(1);
    await execute();
    now += 100_000;
    await playback.advanceDue(await due());
    expect((await playback.read(deviceId)).state).toMatchObject({
      currentItemId: itemIds[1],
      nextTransitionAt: null,
    });
    expect(
      await p.outboxEvent.count({
        where: { eventType: PLAYBACK_DUE, status: "pending" },
      }),
    ).toBe(0);
    await p.playlistItem.deleteMany({
      where: { id: { in: itemIds.slice(1) } },
    });
    release = await publish(2, [itemIds[0]], [revisionIds[0]]);
    const state = await execute("change", 2, 2);
    expect(state.nextTransitionAt).toBeNull();
    const count = await p.outboxEvent.count();
    now += 1_000_000;
    const restart = await execute(
      "restart",
      state.version,
      state.desiredSequence,
    );
    expect(restart.version).toBe(state.version);
    expect(await p.outboxEvent.count()).toBe(count);
  });
  test("five exhausted transition attempts stay dead-letter until an explicit restart command", async () => {
    await execute();
    now += 10_000;
    const event = await due();
    const store = new OutboxStore(p as PrismaService);
    await p.outboxEvent.update({
      where: { eventId: event.eventId },
      data: { attempts: 5 },
    });
    await store.fail(
      { ...event, attempts: 5 },
      "OUTBOX_TRANSPORT_FAILED",
      new Date(now),
      () => 0,
    );
    expect(
      (
        await p.outboxEvent.findUniqueOrThrow({
          where: { eventId: event.eventId },
        })
      ).status,
    ).toBe("dead-letter");
    const restarted = await execute("restart", 1, 1);
    expect(restarted.currentItemId).toBe(itemIds[1]);
    expect(restarted.version).toBe(2);
    expect(
      (
        await p.outboxEvent.findUniqueOrThrow({
          where: { eventId: event.eventId },
        })
      ).status,
    ).toBe("dead-letter");
    expect(
      await p.outboxEvent.count({
        where: { eventType: PLAYBACK_DUE, status: "pending" },
      }),
    ).toBe(1);
  });
  test("a replacement release is committed even when its anchor and the fake clock have not changed", async () => {
    await execute();
    await p.playlistItem.update({
      where: { id: itemIds[1] },
      data: { duration: 40 },
    });
    release = await publish(1);
    const changed = await execute("change", 1, 1);
    expect(changed.playlistRevisionId).toBe(release.playlistRevisionId);
    expect(changed.version).toBe(2);
    expect(changed.desiredSequence).toBe(1);
    now += 10_000;
    await playback.advanceDue(await due());
    expect(
      (await playback.read(deviceId)).state?.nextTransitionAt?.getTime(),
    ).toBe(now + 40_000);
  });
  test("moving between two entries bound to the same publication changes playback only", async () => {
    release = await publish(1, itemIds, [
      revisionIds[0],
      revisionIds[0],
      revisionIds[2],
    ]);
    await execute();
    now += 10_000;
    const before = await new PresentationService(
      p as PrismaService,
    ).getForDevice(deviceId);
    await playback.advanceDue(await due());
    const state = await playback.read(deviceId);
    expect(state.state?.currentItemId).toBe(itemIds[1]);
    expect(state.version).toBe(2);
    expect(state.desiredSequence).toBe(1);
    expect(
      await new PresentationService(p as PrismaService).getForDevice(deviceId),
    ).toEqual(before);
    expect(
      await p.outboxEvent.count({
        where: { eventType: "device.publication.desired-revision.changed" },
      }),
    ).toBe(1);
  });
});
