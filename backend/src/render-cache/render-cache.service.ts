import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type OutboxEvent, type PublicationRevision, type RenderRequest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveDeviceConfiguration } from '../device-platform/device-configuration';
import type { PublishedArtifact } from '../publications/publication-content';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
import { ArtifactStore } from './artifact-store';
import { RENDERER_VERSION, renderKey, targetFor, type RenderTarget } from './render-input';
import { renderSnapshot, validateRenderedArtifact } from './snapshot-renderer';
import { intentCorrelationId, outboxCorrelation } from '../events/outbox-correlation';
import { observeRender, emitStructuredEvent } from '../observability/runtime-observability';
import { sqliteWrite } from '../common/utils/sqlite-write.util';

export const RENDER_REQUESTED = 'render.requested';
export const RENDER_READY = 'render.artifact.ready';
type Database = Prisma.TransactionClient;
type TargetDevice = Prisma.DeviceGetPayload<{ include: { profile: true; deliveryPolicy: true } }>;
const RENDER_PROMOTION_BATCH = 64;

@Injectable()
export class RenderCacheService {
  private readonly logger = new Logger(RenderCacheService.name);
  private readonly counts = { hits: 0, misses: 0, fallbacks: 0, rendered: 0, failures: 0 };
  private requestTail: Promise<unknown> = Promise.resolve();
  private pendingRequests = 0;
  private readonly rendering = new Map<string, Promise<void>>();
  constructor(private readonly prisma: PrismaService, private readonly files: ArtifactStore) {}
  metrics() { return { ...this.counts }; }

  /** Called by commands/reconciliation, never by a manifest or artifact GET. */
  async request(deviceId: number) {
    if (this.pendingRequests >= 1024) throw new Error('RENDER_REQUEST_CAPACITY');
    this.pendingRequests++;
    // Backpressure for SQLite's single writer, not the source of deduplication.
    // Across processes the unique key + writer transaction still enforce identity.
    const run = this.requestTail.then(() => this.requestOnce(deviceId))
      .finally(() => { this.pendingRequests--; });
    this.requestTail = run.catch(() => undefined);
    return run;
  }

  private async requestOnce(deviceId: number) {
    const existingDevice = await this.prisma.device.findUnique({ where: { id: deviceId },
      include: { profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } } } });
    if (!existingDevice?.isActive || !existingDevice.publicationState?.desiredRevision) return;
    const target = targetFor(resolveDeviceConfiguration(existingDevice.profile, existingDevice.deliveryPolicy, existingDevice.capabilitiesOverride));
    const variant = sha256(canonicalJson(target));
    const key = renderKey(existingDevice.publicationState.desiredRevision, target);
    const previous = await this.prisma.renderBinding.findUnique({ where: { deviceId_variant: { deviceId, variant } } });
    if (previous?.desiredKey === key) {
      if (previous.readyKey === key) return key;
      const requested = await this.prisma.renderRequest.findUnique({ where: { key } });
      // Completion may have skipped an inactive/unassigned device. On return,
      // promote the shared completed request so it becomes this device's durable
      // last-good fallback and produces its own ordered ready notification.
      if (!requested?.completedAt) return key;
    }
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE devices SET id = id WHERE id = ${deviceId}`;
      const device = await tx.device.findUnique({ where: { id: deviceId }, include: {
        profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
      } });
      if (!device?.isActive || !device.publicationState?.desiredRevision) return;
      const currentTarget = targetFor(resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride));
      if (canonicalJson(currentTarget) !== canonicalJson(target) || renderKey(device.publicationState.desiredRevision, currentTarget) !== key) return;
      let request = await tx.renderRequest.findUnique({ where: { key } });
      if (!request) {
        request = await tx.renderRequest.create({ data: { key, publicationRevisionId: device.publicationState.desiredRevision.publicationRevisionId,
          target: target as unknown as Prisma.InputJsonValue, rendererVersion: RENDERER_VERSION } });
        await tx.outboxEvent.create({ data: { correlationId: intentCorrelationId(), eventType: RENDER_REQUESTED, aggregateType: 'RenderRequest',
          aggregateId: key, aggregateRevision: '1', payloadVersion: 1, payload: { renderKey: key } } });
      }
      const binding = await tx.renderBinding.findUnique({ where: { deviceId_variant: { deviceId, variant } } });
      await tx.renderBinding.upsert({ where: { deviceId_variant: { deviceId, variant } },
        create: { deviceId, variant, desiredKey: key, readyKey: request.completedAt ? key : null },
        update: { desiredKey: key, ...(request.completedAt && binding?.readyKey !== key ? {
          previousKey: binding?.readyKey, readyKey: key,
        } : {}) } });
      if (request.completedAt && binding?.readyKey !== key) {
        const updated = await tx.device.update({ where: { id: deviceId }, data: { renderRevision: { increment: 1 } } });
        await tx.outboxEvent.create({ data: { correlationId: intentCorrelationId(), eventType: RENDER_READY, aggregateType: 'RenderRequest',
          aggregateId: key, aggregateRevision: `${deviceId}-${updated.renderRevision}`, payloadVersion: 1,
          payload: { renderKey: key, deviceIds: [deviceId] } } });
      }
      return key;
    }));
  }

  /** Recovery derives intent from durable desired state, also after a missed wakeup. */
  async reconcile() {
    const devices = await this.prisma.device.findMany({ where: { isActive: true, publicationState: { desiredPublicationRevisionId: { not: null } } }, select: { id: true } });
    for (const device of devices) {
      try { await this.request(device.id); }
      catch { this.counts.failures++; observeRender('failed'); } // Unsupported profile does not starve unrelated devices.
    }
  }

  /** Outbox lease fences both side effects and completion after process/queue loss. */
  async render(event: OutboxEvent, renderer = renderSnapshot, signal?: AbortSignal) {
    const existing = this.rendering.get(event.eventId);
    if (existing) return existing;
    const run = this.renderOnce(event, renderer, signal).catch(error => {
      this.logger.warn({ code: error instanceof Prisma.PrismaClientKnownRequestError ? `RENDER_DB_${error.code}` : 'RENDER_DISPATCH_FAILED', renderKey: event.aggregateId });
      throw error;
    }).finally(() => { this.rendering.delete(event.eventId); });
    this.rendering.set(event.eventId, run);
    return run;
  }

  private async renderOnce(event: OutboxEvent, renderer: typeof renderSnapshot, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (event.eventType !== RENDER_REQUESTED || event.aggregateType !== 'RenderRequest' || event.aggregateRevision !== '1' || event.payloadVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(event.aggregateId) || canonicalJson(event.payload) !== canonicalJson({ renderKey: event.aggregateId }))
      throw new Error('OUTBOX_INVALID_PAYLOAD');
    const request = await this.prisma.renderRequest.findUniqueOrThrow({ where: { key: event.aggregateId }, include: { revision: true } });
    if (!await this.current(this.prisma, event)) throw new Error('RENDER_STALE_CLAIM');
    const target = request.target as unknown as RenderTarget;
    if (request.rendererVersion !== RENDERER_VERSION || renderKey(request.revision, target) !== request.key) throw new Error('OUTBOX_INVALID_PAYLOAD');
    if (request.completedAt && !await this.prisma.renderBinding.findFirst({ where: {
      desiredKey: request.key,
      OR: [{ readyKey: null }, { readyKey: { not: request.key } }],
      device: { is: { isActive: true, publicationState: { is: {
        desiredPublicationRevisionId: request.publicationRevisionId,
      } } } },
    }, select: { deviceId: true } })) {
      // request() promotes a newly active/assigned binding for an already
      // completed artifact. A duplicate delivery with no remaining binding is
      // therefore a read-only idempotency hit and need not take SQLite's writer.
      return;
    }
    let artifact: PublishedArtifact | undefined;
    let renderedPixels = false;
    if (!request.completedAt) {
      let stage = 'RENDER_PIXELS_FAILED';
      try {
        artifact = await renderer(request.revision, target, signal);
        signal?.throwIfAborted();
        stage = 'RENDER_VALIDATION_FAILED';
        await validateRenderedArtifact(artifact, target);
        signal?.throwIfAborted();
        stage = 'RENDER_STALE_CLAIM';
        if (!await this.current(this.prisma, event)) throw new Error('RENDER_STALE_CLAIM');
        stage = 'RENDER_STORAGE_FAILED';
        await this.files.publish(artifact);
        renderedPixels = true;
      } catch {
        this.counts.failures++;
        observeRender('failed');
        emitStructuredEvent('RENDER_FAILED', { ...outboxCorrelation(event), role: 'worker', queue: 'render', outcome: 'failure' });
        this.logger.warn({ code: stage, renderKey: request.key });
        throw new Error('RENDER_FAILED');
      }
    }
    for (;;) {
      const promoted = await this.persistRenderBatch(event, request, artifact, signal);
      artifact = undefined;
      if (promoted < RENDER_PROMOTION_BATCH) break;
    }
    if (renderedPixels) {
      this.counts.rendered++;
      observeRender('rendered');
      emitStructuredEvent('RENDER_SUCCEEDED', { ...outboxCorrelation(event), role: 'worker', queue: 'render', outcome: 'success' });
    }
  }

  private persistRenderBatch(event: OutboxEvent, request: RenderRequest & { revision: PublicationRevision },
    artifact: PublishedArtifact | undefined, signal?: AbortSignal) {
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      signal?.throwIfAborted();
      await tx.$executeRaw`UPDATE outbox_events SET event_id = event_id WHERE event_id = ${event.eventId}`;
      if (!await this.current(tx, event)) throw new Error('RENDER_STALE_CLAIM');
      const current = await tx.renderRequest.findUniqueOrThrow({ where: { key: request.key } });
      if (!current.completedAt) {
        if (!artifact) throw new Error('RENDER_STORAGE_FAILED');
        await tx.renderRequest.update({ where: { key: request.key }, data: { artifactHash: artifact.sha256,
          mimeType: artifact.mimeType, sizeBytes: artifact.bytes.length, completedAt: new Date() } });
      }
      const bindings = await tx.renderBinding.findMany({ where: {
        desiredKey: request.key,
        OR: [{ readyKey: null }, { readyKey: { not: request.key } }],
        device: { is: { isActive: true, publicationState: { is: {
          desiredPublicationRevisionId: request.publicationRevisionId,
        } } } },
      }, orderBy: [{ deviceId: 'asc' }, { variant: 'asc' }], take: RENDER_PROMOTION_BATCH,
      include: { device: { include: { publicationState: true } } } });
      const deviceIds: number[] = [];
      for (const binding of bindings) {
        signal?.throwIfAborted();
        await tx.renderBinding.update({ where: { deviceId_variant: { deviceId: binding.deviceId, variant: binding.variant } },
          data: { readyKey: request.key, previousKey: binding.readyKey } });
        await tx.device.update({ where: { id: binding.deviceId }, data: { renderRevision: { increment: 1 } } });
        deviceIds.push(binding.deviceId);
      }
      const promotionRevision = sha256(canonicalJson(bindings.map(binding => [binding.deviceId, binding.variant])));
      if (deviceIds.length) await tx.outboxEvent.create({ data: { correlationId: outboxCorrelation(event).correlationId, eventType: RENDER_READY, aggregateType: 'RenderRequest',
        aggregateId: request.key, aggregateRevision: promotionRevision,
        payloadVersion: 1, payload: { renderKey: request.key, deviceIds } } });
      if (!await this.current(tx, event)) throw new Error('RENDER_STALE_CLAIM');
      signal?.throwIfAborted();
      return deviceIds.length;
    }));
  }

  private current(db: Database, event: OutboxEvent) {
    if (!event.claimToken || !event.claimOwner) return null;
    return db.outboxEvent.findFirst({ where: { eventId: event.eventId, status: 'processing', claimToken: event.claimToken,
      claimOwner: event.claimOwner, claimUntil: { gt: new Date() } } });
  }

  /** No SQL writes or rendering here, including misses and corrupt/missing files. */
  async read(device: TargetDevice, desired: PublicationRevision, db: Database = this.prisma, observe = true) {
    const target = targetFor(resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride));
    const key = renderKey(desired, target), variant = sha256(canonicalJson(target));
    const current = await db.renderRequest.findUnique({ where: { key }, include: { revision: true } });
    const binding = await db.renderBinding.findUnique({ where: { deviceId_variant: { deviceId: device.id, variant } },
      include: { ready: { include: { revision: true } }, previous: { include: { revision: true } } } });
    for (const candidate of [current, binding?.ready, binding?.previous]) {
      if (!candidate?.completedAt || !candidate.artifactHash || !candidate.mimeType || !candidate.sizeBytes) continue;
      if (canonicalJson(candidate.target) !== canonicalJson(target)) continue;
      try {
        const artifact = await this.artifact(candidate, target);
        const fallback = candidate.key !== key;
        if (observe) {
          if (fallback) this.counts.fallbacks++; else this.counts.hits++;
          observeRender(fallback ? 'fallback' : 'hit');
        }
        return { artifact, revision: candidate.revision, fallback, rendererVersion: candidate.rendererVersion };
      } catch { /* Never replace last-known-good metadata due to an unreadable file. */ }
    }
    if (observe) { this.counts.misses++; observeRender('miss'); }
    return null;
  }

  private async artifact(request: RenderRequest, target: RenderTarget): Promise<PublishedArtifact> {
    return { format: target.format, mimeType: request.mimeType!, width: target.width, height: target.height,
      colorSpace: target.colorSpace, bitDepth: target.bitDepth, rotation: target.rotation,
      sha256: request.artifactHash!, bytes: await this.files.read(request.artifactHash!, request.sizeBytes!) };
  }
}
