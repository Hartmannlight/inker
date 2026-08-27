import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type OutboxEvent, type PlaybackState } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PublicationPersistenceService } from "../publications/publication-persistence.service";
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
    return this.command(
      { kind: "publish", playlistId, ...input, bindings },
      async (tx) => {
        const draft = await this.draft(playlistId, tx);
        if (draft.draftHash !== input.expectedDraftHash)
          throw new ConflictException("Playlist draft changed");
        const latest = await tx.publishedPlaylist.findFirst({
          where: { playlistId },
          orderBy: { revision: "desc" },
        });
        if ((latest?.revision ?? 0) !== input.expectedRevision)
          throw new ConflictException("Playlist publication revision conflict");
        if (
          bindings.length !== draft.items.length ||
          draft.items.some((i) => !bindings.some((b) => b.itemId === i.itemId))
        )
          throw new BadRequestException(
            "Every playlist item requires an explicit publication revision",
          );
        const entries = draft.items.map((i) => ({
          itemId: i.itemId,
          durationMs: i.duration === null ? null : i.duration * 1000,
          publicationRevisionId: bindings.find((b) => b.itemId === i.itemId)!
            .publicationRevisionId,
        }));
        try {
          validateEntries(entries);
        } catch {
          throw new BadRequestException(
            "Playlist duration must be null or 1..86400 seconds",
          );
        }
        await this.requirePublications(tx, entries);
        const contentHash = sha256(canonicalJson(entries));
        const published = await tx.publishedPlaylist.create({
          data: {
            playlistId,
            revision: Number(input.expectedRevision) + 1,
            contentHash,
            publishedAt: new Date(this.clock.now()),
            entries: {
              create: entries.map((e, ordinal) => ({ ...e, ordinal })),
            },
          },
        });
        return {
          playlistRevisionId: published.id,
          revision: published.revision,
          contentHash,
        };
      },
    );
  }

  async execute(deviceId: number, body: unknown) {
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
    return this.command(
      { kind: "playback", deviceId, ...input },
      async (tx) => {
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
      },
    );
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
  async advanceDue(event: OutboxEvent) {
    const parsed = parsePlaybackEvent(event);
    const key = effectKey(
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      String(parsed.version),
    );
    if (event.eventType !== PLAYBACK_DUE)
      throw new Error("OUTBOX_INVALID_PAYLOAD");
    return this.prisma.$transaction(
      async (tx) => {
        const now = this.clock.now();
        // First statement takes the writer lock and fences all domain writes.
        if (
          !(
            await tx.outboxEvent.updateMany({
              where: {
                eventId: event.eventId,
                status: "processing",
                claimOwner: event.claimOwner,
                claimToken: event.claimToken,
                claimUntil: { gt: new Date(now) },
              },
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
        await tx.outboxEffect.create({
          data: { key, eventId: event.eventId, completedAt: new Date(now) },
        });
      },
      { timeout: 10_000 },
    );
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

  private async command(
    input: Record<string, unknown>,
    operation: (tx: Tx) => Promise<Prisma.InputJsonValue>,
  ) {
    if (
      input.version !== 1 ||
      typeof input.idempotencyKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    )
      throw new BadRequestException("Invalid playback command version or key");
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
