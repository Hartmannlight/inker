import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type OutboxEvent, type PlaybackState } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { intentCorrelationId } from '../events/outbox-correlation';
import { PublicationPersistenceService } from "../publications/publication-persistence.service";
import { PublishService } from "../publications/publish.service";
import {
  canonicalJson,
  publicationArtifacts,
  sha256,
} from "../publications/publication-content";
import {
  position,
  transition,
  validateEntries,
  type PlaybackAction,
  type PlaybackAnchor,
  type PlaybackEntry,
  type PlaybackStatus,
} from "./playback.machine";
import {
  parsePlaybackEvent,
  PLAYBACK_CHANGED,
  PLAYBACK_DUE,
} from "./playback.events";
import { effectKey } from "../events/outbox.types";
import { QUEUE_POLICIES } from "../jobs/queue-policy";
import { sqliteWrite } from '../common/utils/sqlite-write.util';

type Tx = Prisma.TransactionClient;
const positive = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0;
const nonnegative = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(v);
function object(value: unknown, allowed: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new BadRequestException("Invalid playback command");
  return value as Record<string, unknown>;
}
function anchor(state: PlaybackState): PlaybackAnchor {
  return {
    status: state.status as PlaybackStatus,
    anchorIndex: state.anchorIndex,
    anchorAt: state.anchorAt.getTime(),
    elapsedMs: state.elapsedMs,
    evaluatedAt: state.evaluatedAt.getTime(),
  };
}

@Injectable()
export class PlaybackClock {
  now() {
    return Date.now();
  }
}

@Injectable()
export class PlaybackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publications: PublicationPersistenceService,
    private readonly clock: PlaybackClock,
    private readonly publisher: PublishService,
  ) {}

  /** Read-only, explicit projection; no draft names, URLs, settings or secrets. */
  async draft(playlistId: number, tx: Tx = this.prisma) {
    const playlist = await tx.playlist.findUnique({
      where: { id: playlistId },
      include: { items: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
    });
    if (!playlist) throw new NotFoundException("Playlist draft not found");
    const items = playlist.items.map((i) => ({
      itemId: i.id,
      order: i.order,
      duration: i.duration,
      screenId: i.screenId,
      screenDesignId: i.screenDesignId,
      pluginInstanceId: i.pluginInstanceId,
    }));
    const content = { playlistId, items };
    return { ...content, draftHash: sha256(canonicalJson(content)) };
  }

  async publish(playlistId: number, body: unknown) {
    const input = object(body, [
      "version",
      "idempotencyKey",
      "expectedRevision",
      "expectedDraftHash",
      "bindings",
    ]);
    if (
      !positive(playlistId) ||
      !nonnegative(input.expectedRevision) ||
      typeof input.expectedDraftHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedDraftHash) ||
      !Array.isArray(input.bindings) ||
      input.bindings.length > 100
    )
      throw new BadRequestException("Invalid playlist publication command");
    const bindings = input.bindings
      .map((value) => {
        const b = object(value, ["itemId", "publicationRevisionId"]);
        if (!positive(b.itemId) || !identifier(b.publicationRevisionId))
          throw new BadRequestException("Invalid publication binding");
        return {
          itemId: b.itemId,
          publicationRevisionId: b.publicationRevisionId,
        };
      })
      .sort((a, b) => a.itemId - b.itemId);
    if (new Set(bindings.map((b) => b.itemId)).size !== bindings.length)
      throw new BadRequestException("Duplicate publication binding");
    const expectedDraftHash = input.expectedDraftHash as string;
    return this.command(
      { kind: "publish", playlistId, ...input, bindings },
      (tx) => this.publishPlaylistInTransaction(tx, playlistId, Number(input.expectedRevision), expectedDraftHash, bindings),
    );
  }

  /** Publish every uploaded or designer screen draft to an explicit immutable revision,
   * then publish the playlist binding. Failed publication never starts or
   * changes playback, so the last desired image remains in place. */
  async publishFromDraft(playlistId: number, body: unknown) {
    const input = object(body, ["version", "idempotencyKey", "expectedDraftHash"]);
    this.validateCommandIdentity(input);
    if (!positive(playlistId) || typeof input.expectedDraftHash !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDraftHash))
      throw new BadRequestException("Invalid playlist draft publication command");
    const expectedDraftHash = input.expectedDraftHash;
    const keyHash = sha256(input.idempotencyKey.toLowerCase());
    const requestHash = sha256(canonicalJson({ playlistId, expectedDraftHash }));
    const replay = (receipt: { requestHash: string; result: Prisma.JsonValue | null }) => {
      if (receipt.requestHash !== requestHash) throw new ConflictException("Playlist draft publication idempotency key conflict");
      if (!receipt.result) throw new ServiceUnavailableException("Playlist draft publication incomplete; retry the same command");
      return receipt.result;
    };
    // Replay precedes any draft lookup: a successful operation stays replayable
    // even when the administrator subsequently edits or deletes the draft.
    const previous = await this.prisma.playlistDraftPublishCommand.findUnique({ where: { keyHash } });
    if (previous) return replay(previous);
    const draft = await this.draft(playlistId);
    if (draft.draftHash !== expectedDraftHash) throw new ConflictException("Playlist draft changed");
    if (!draft.items.length || draft.items.some(item => item.pluginInstanceId || Number(Boolean(item.screenId)) + Number(Boolean(item.screenDesignId)) !== 1))
      throw new BadRequestException('Only uploaded-screen or designer-screen playlist items can be published from this picker');
    const prepared = await Promise.all(draft.items.map(async item => {
      const screen = item.screenDesignId
        ? await this.prisma.screenDesign.findUnique({ where: { id: item.screenDesignId }, select: { updatedAt: true } })
        : await this.prisma.screen.findUnique({ where: { id: item.screenId! }, select: { updatedAt: true } });
      if (!screen) throw new NotFoundException('Playlist screen not found');
      const screenDraft = item.screenDesignId
        ? { screenDesignId: item.screenDesignId, expectedUpdatedAt: screen.updatedAt.toISOString() }
        : { screenId: item.screenId!, expectedUpdatedAt: screen.updatedAt.toISOString() };
      return { item, screenDraft, prepared: await this.publisher.snapshotDraft(screenDraft) };
    }));
    try {
      return await sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO playlist_draft_publish_commands (key_hash, request_hash) VALUES (${keyHash}, ${requestHash}) ON CONFLICT (key_hash) DO NOTHING`;
        const receipt = await tx.playlistDraftPublishCommand.findUniqueOrThrow({ where: { keyHash } });
        if (receipt.result || receipt.requestHash !== requestHash) return replay(receipt);
        const current = await this.draft(playlistId, tx);
        if (current.draftHash !== expectedDraftHash) throw new ConflictException("Playlist draft changed");
        const bindings = await Promise.all(prepared.map(async ({ item, screenDraft, prepared }) => ({
          itemId: item.itemId,
          publicationRevisionId: (await this.publisher.publishScreenDraftInTransaction(tx, screenDraft, prepared)).publicationRevisionId,
        })));
        const latest = await tx.publishedPlaylist.findFirst({ where: { playlistId }, orderBy: { revision: 'desc' } });
        const result = await this.publishPlaylistInTransaction(tx, playlistId, latest?.revision ?? 0, current.draftHash, bindings);
        await tx.playlistDraftPublishCommand.update({ where: { keyHash }, data: { result } });
        return result;
      }, { timeout: 10_000 }), 'Playlist publication busy; retry the same command');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P1008", "P2028", "P2034"].includes(error.code))
        throw new ServiceUnavailableException("Playlist publication busy; retry the same command");
      throw error;
    }
  }

  private async publishPlaylistInTransaction(
    tx: Tx,
    playlistId: number,
    expectedRevision: number,
    expectedDraftHash: string,
    bindings: { itemId: number; publicationRevisionId: string }[],
  ) {
    const draft = await this.draft(playlistId, tx);
    if (draft.draftHash !== expectedDraftHash) throw new ConflictException("Playlist draft changed");
    const latest = await tx.publishedPlaylist.findFirst({ where: { playlistId }, orderBy: { revision: "desc" } });
    if ((latest?.revision ?? 0) !== expectedRevision) throw new ConflictException("Playlist publication revision conflict");
    if (bindings.length !== draft.items.length || draft.items.some((i) => !bindings.some((b) => b.itemId === i.itemId)))
      throw new BadRequestException("Every playlist item requires an explicit publication revision");
    const entries = draft.items.map((i) => ({ itemId: i.itemId, durationMs: i.duration === null ? null : i.duration * 1000,
      publicationRevisionId: bindings.find((b) => b.itemId === i.itemId)!.publicationRevisionId }));
    try { validateEntries(entries); } catch { throw new BadRequestException("Playlist duration must be null or 1..86400 seconds"); }
    await this.requirePublications(tx, entries);
    const contentHash = sha256(canonicalJson(entries));
    const published = await tx.publishedPlaylist.create({ data: { playlistId, revision: expectedRevision + 1, contentHash,
      publishedAt: new Date(this.clock.now()), entries: { create: entries.map((e, ordinal) => ({ ...e, ordinal })) } } });
    return { playlistRevisionId: published.id, revision: published.revision, contentHash };
  }

  async execute(deviceId: number, body: unknown) {
    const { input } = this.executionInput(deviceId, body);
    return this.command(
      { kind: "playback", deviceId, ...input },
      (tx) => this.executeInTransaction(tx, deviceId, input),
    );
  }

  /**
   * Apply a validated command in the caller's transaction. The caller owns
   * idempotency, serialization and commit; no PlaybackCommand receipt is used.
   * Keep the complete version-1 command shape, including a valid UUID key.
   */
  async executeInTransaction(tx: Prisma.TransactionClient, deviceId: number, body: unknown) {
    const { input, action, replace } = this.executionInput(deviceId, body);
    this.validateCommandIdentity(input);
    const device = await tx.device.findFirst({
      where: { id: deviceId, isActive: true },
      include: { publicationState: true },
    });
    if (!device) throw new NotFoundException("Target device not found");
    const previous = await tx.playbackState.findUnique({
      where: { deviceId },
    });
    if (
      (previous?.version ?? 0) !== input.expectedVersion ||
      (device.publicationState?.desiredSequence ??
        device.presentationRevision) !== input.expectedDesiredSequence
    )
      throw new ConflictException("Playback or desired sequence conflict");
    const oldEntries = previous
      ? await this.entries(tx, previous.playlistRevisionId)
      : [];
    const revisionId = replace
      ? String(input.playlistRevisionId)
      : previous?.playlistRevisionId;
    if (!revisionId) throw new ConflictException("Playback not started");
    const entries = replace
      ? await this.entries(tx, revisionId)
      : oldEntries;
    const now = this.clock.now();
    let next: PlaybackAnchor;
    try {
      next = transition(
        previous ? anchor(previous) : null,
        oldEntries,
        action,
        now,
        entries,
      );
    } catch {
      throw new ConflictException("Invalid playback transition");
    }
    // Restart/recovery before a boundary is a no-op, including paused/stopped playback.
    const due =
      previous?.nextTransitionAt &&
      now >= previous.nextTransitionAt.getTime();
    if (
      previous &&
      ((action === "restart" && !due) ||
        (revisionId === previous.playlistRevisionId &&
          canonicalJson(next) === canonicalJson(anchor(previous))))
    )
      return this.result(
        previous,
        device.publicationState?.desiredSequence ??
          device.presentationRevision,
      );
    return this.persist(
      tx,
      deviceId,
      previous,
      revisionId,
      next,
      entries,
      action,
    );
  }

  private executionInput(deviceId: number, body: unknown) {
    const input = object(body, [
      "version",
      "idempotencyKey",
      "expectedVersion",
      "expectedDesiredSequence",
      "action",
      "playlistRevisionId",
    ]);
    const actions: PlaybackAction[] = [
      "start",
      "advance",
      "change",
      "pause",
      "resume",
      "restart",
      "stop",
    ];
    if (
      !positive(deviceId) ||
      !nonnegative(input.expectedVersion) ||
      !nonnegative(input.expectedDesiredSequence) ||
      !actions.includes(input.action as PlaybackAction)
    )
      throw new BadRequestException("Invalid playback command");
    const action = input.action as PlaybackAction;
    const replace = action === "start" || action === "change";
    if (
      replace
        ? !identifier(input.playlistRevisionId)
        : input.playlistRevisionId !== undefined
    )
      throw new BadRequestException(
        "Playlist revision required only for start/change",
      );
    return { input, action, replace };
  }

  async read(deviceId: number, now = this.clock.now()) {
    const state = await this.prisma.playbackState.findUnique({
      where: { deviceId },
    });
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        presentationRevision: true,
        publicationState: { select: { desiredSequence: true } },
      },
    });
    if (!device) throw new NotFoundException("Target device not found");
    const desiredSequence =
      device.publicationState?.desiredSequence ?? device.presentationRevision;
    if (!state) return { version: 0, state: null, desiredSequence };
    const entries = await this.entries(this.prisma, state.playlistRevisionId);
    // This is a projection for admin/debug; manifests still read the committed desired pointer.
    return {
      version: state.version,
      state,
      desiredSequence,
      projected: position(anchor(state), entries, now),
    };
  }

  /** Existing WP-16 claims/retries transport this persisted due event. No per-device timers. */
  async advanceDue(event: OutboxEvent, signal?: AbortSignal) {
    const checkAbort = () => {
      if (signal?.aborted) throw new Error("PLAYBACK_ABORTED");
    };
    checkAbort();
    const parsed = parsePlaybackEvent(event);
    const key = effectKey(
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      String(parsed.version),
    );
    if (event.eventType !== PLAYBACK_DUE)
      throw new Error("OUTBOX_INVALID_PAYLOAD");
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(
      async (tx) => {
        checkAbort();
        const now = this.clock.now();
        const fence = () => ({
          eventId: event.eventId,
          status: "processing" as const,
          claimOwner: event.claimOwner,
          claimToken: event.claimToken,
          claimUntil: { gt: new Date() },
        });
        // First statement takes the writer lock and fences all domain writes.
        if (
          !(
            await tx.outboxEvent.updateMany({
              where: fence(),
              data: { claimOwner: event.claimOwner },
            })
          ).count
        )
          throw new Error("OUTBOX_CLAIM_EXPIRED");
        if (await tx.outboxEffect.findUnique({ where: { key } })) return;
        const state = await tx.playbackState.findUnique({
          where: { id: parsed.playbackId },
        });
        if (
          state &&
          state.version === parsed.version &&
          state.status === "running" &&
          state.nextTransitionAt?.getTime() === parsed.dueAt
        ) {
          if (now < parsed.dueAt!) throw new Error("PLAYBACK_NOT_DUE");
          const device = await tx.device.findUniqueOrThrow({
            where: { id: state.deviceId },
          });
          const entries = await this.entries(tx, state.playlistRevisionId);
          const next = transition(
            anchor(state),
            entries,
            device.isActive ? "restart" : "stop",
            now,
          );
          checkAbort();
          await this.persist(
            tx,
            state.deviceId,
            state,
            state.playlistRevisionId,
            next,
            entries,
            device.isActive ? "restart" : "stop",
          );
        }
        checkAbort();
        await tx.outboxEffect.create({
          data: { key, eventId: event.eventId, completedAt: new Date(now) },
        });
        checkAbort();
        if (!(await tx.outboxEvent.updateMany({
          where: fence(), data: { claimOwner: event.claimOwner },
        })).count) throw new Error("OUTBOX_CLAIM_EXPIRED");
      },
      { timeout: QUEUE_POLICIES.timer.timeoutMs },
    ));
  }

  private async entries(tx: Tx, id: string): Promise<PlaybackEntry[]> {
    const revision = await tx.publishedPlaylist.findUnique({
      where: { id },
      include: { entries: { orderBy: { ordinal: "asc" } } },
    });
    if (!revision) throw new NotFoundException("Published playlist not found");
    const entries = revision.entries.map((e) => ({
      itemId: e.itemId,
      publicationRevisionId: e.publicationRevisionId,
      durationMs: e.durationMs,
    }));
    try {
      validateEntries(entries);
      if (sha256(canonicalJson(entries)) !== revision.contentHash)
        throw new Error();
    } catch {
      throw new ServiceUnavailableException("Published playlist invalid");
    }
    return entries;
  }

  private async requirePublications(tx: Tx, entries: readonly PlaybackEntry[]) {
    const ids = [...new Set(entries.map((e) => e.publicationRevisionId))];
    const revisions = await tx.publicationRevision.findMany({
      where: { publicationRevisionId: { in: ids } },
    });
    if (revisions.length !== ids.length)
      throw new NotFoundException("Publication revision not found");
    for (const revision of revisions) publicationArtifacts(revision);
  }

  private async persist(
    tx: Tx,
    deviceId: number,
    previous: PlaybackState | null,
    playlistRevisionId: string,
    next: PlaybackAnchor,
    entries: readonly PlaybackEntry[],
    action: PlaybackAction,
  ) {
    const current = position(next, entries, next.evaluatedAt);
    if (next.status === "running" || next.status === "paused")
      await this.requirePublications(tx, entries);
    const data = {
      playlistRevisionId,
      version: (previous?.version ?? 0) + 1,
      status: next.status,
      anchorIndex: next.anchorIndex,
      anchorAt: new Date(next.anchorAt),
      elapsedMs: next.elapsedMs,
      evaluatedAt: new Date(next.evaluatedAt),
      currentItemId: current.itemId,
      nextTransitionAt:
        current.nextTransitionAt === null
          ? null
          : new Date(current.nextTransitionAt),
    };
    const state = previous
      ? await tx.playbackState.update({
          where: { id: previous.id, version: previous.version },
          data,
        })
      : await tx.playbackState.create({ data: { ...data, deviceId } });
    // Empty/stop keep the last valid desired publication; they never invent a fallback artifact.
    if (
      current.publicationRevisionId &&
      action !== "stop" &&
      next.status !== "stopped"
    )
      await this.publications.setDesiredRevision(
        deviceId,
        current.publicationRevisionId,
        tx,
        state.id,
      );
    const occurredAt = new Date(next.evaluatedAt);
    // Superseded pending schedules are terminal, never deleted; running jobs are version-fenced.
    await tx.outboxEvent.updateMany({
      where: {
        eventType: PLAYBACK_DUE,
        aggregateId: state.id,
        status: "pending",
      },
      data: { status: "delivered", processedAt: occurredAt },
    });
    const common = {
      correlationId: intentCorrelationId(),
      aggregateType: "PlaybackState",
      aggregateId: state.id,
      aggregateRevision: String(state.version),
      payloadVersion: 1,
      occurredAt,
    };
    await tx.outboxEvent.create({
      data: {
        ...common,
        eventType: PLAYBACK_CHANGED,
        availableAt: occurredAt,
        payload: { playbackId: state.id, version: state.version },
      },
    });
    if (state.nextTransitionAt)
      await tx.outboxEvent.create({
        data: {
          ...common,
          eventType: PLAYBACK_DUE,
          availableAt: state.nextTransitionAt,
          payload: {
            playbackId: state.id,
            version: state.version,
            dueAt: state.nextTransitionAt.getTime(),
          },
        },
      });
    const desired = await tx.devicePublicationState.findUnique({
      where: { deviceId },
    });
    const device = await tx.device.findUniqueOrThrow({
      where: { id: deviceId },
      select: { presentationRevision: true },
    });
    return this.result(
      state,
      desired?.desiredSequence ?? device.presentationRevision,
    );
  }

  private result(state: PlaybackState, desiredSequence: number) {
    return {
      playbackId: state.id,
      version: state.version,
      playlistRevisionId: state.playlistRevisionId,
      status: state.status,
      currentItemId: state.currentItemId,
      nextTransitionAt: state.nextTransitionAt?.toISOString() ?? null,
      desiredSequence,
    };
  }

  private validateCommandIdentity(input: Record<string, unknown>): asserts input is Record<string, unknown> & { version: 1; idempotencyKey: string } {
    if (
      input.version !== 1 ||
      typeof input.idempotencyKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    )
      throw new BadRequestException("Invalid playback command version or key");
  }

  private async command(
    input: Record<string, unknown>,
    operation: (tx: Tx) => Promise<Prisma.InputJsonValue>,
  ) {
    this.validateCommandIdentity(input);
    const { idempotencyKey, ...request } = input;
    const keyHash = sha256(idempotencyKey.toLowerCase()),
      requestHash = sha256(canonicalJson(request));
    const replay = (receipt: {
      requestHash: string;
      result: Prisma.JsonValue;
    }) => {
      if (receipt.requestHash !== requestHash)
        throw new ConflictException("Playback idempotency key conflict");
      if (!receipt.result)
        throw new ServiceUnavailableException("Playback command incomplete");
      return receipt.result;
    };
    const previous = await this.prisma.playbackCommand.findUnique({
      where: { keyHash },
    });
    if (previous) return replay(previous);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO playback_commands (key_hash, request_hash) VALUES (${keyHash}, ${requestHash}) ON CONFLICT (key_hash) DO NOTHING`;
          const receipt = await tx.playbackCommand.findUniqueOrThrow({
            where: { keyHash },
          });
          if (receipt.result || receipt.requestHash !== requestHash)
            return replay(receipt);
          const result = await operation(tx);
          await tx.playbackCommand.update({
            where: { keyHash },
            data: { result },
          });
          return result;
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P1008", "P2028", "P2034"].includes(error.code)
      )
        throw new ServiceUnavailableException(
          "Playback busy; retry the same command",
        );
      throw error;
    }
  }
}
