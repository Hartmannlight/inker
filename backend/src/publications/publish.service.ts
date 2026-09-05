import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { AllowedAction } from '@inker/contracts';
import { sharp } from '../common/utils/sharp.util';
import { PrismaService } from '../prisma/prisma.service';
import { sqliteWrite } from '../common/utils/sqlite-write.util';
import { PublicationPersistenceService } from './publication-persistence.service';
import { canonicalJson, fixtureIds, publicationArtifacts, sha256, type PublicationContent, type PublishedDesignSnapshot } from './publication-content';
import { normalizePublicationActions } from './publication-actions';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';
import { RecipesService } from '../recipes/recipes.service';

export type PublicationDraft = { fixtureArtifacts: string[] } | { screenId: number; expectedUpdatedAt: string } | { screenDesignId: number; expectedUpdatedAt: string } | { recipeBindingId: string; expectedUpdatedAt: string } | { sourceSnapshotId: string };
type PublishInput = { idempotencyKey: string; expectedRevision: number; draft: PublicationDraft; deviceIds: number[]; allowedActions: AllowedAction[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid publication command');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BadRequestException('Unknown publication command field');
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }

@Injectable()
export class PublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly persistence: PublicationPersistenceService,
    private readonly screenRenderer: ScreenRendererService,
    private readonly recipes: RecipesService,
  ) {}

  async publish(publicationKey: string, body: unknown) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(publicationKey)) throw new BadRequestException('Invalid publication key');
    const input = this.parse(body);
    const keyHash = sha256(input.idempotencyKey);
    // Empty/absent rights preserve the pre-WP23 command identity byte for byte.
    const actions = input.allowedActions.length ? { allowedActions: input.allowedActions } : {};
    const requestHash = sha256(canonicalJson({ publicationKey, expectedRevision: input.expectedRevision, draft: input.draft, deviceIds: input.deviceIds, ...actions }));
    // Replay precedes draft lookup: deletion/edit after success cannot change a retry.
    const previous = await this.prisma.publicationCommand.findUnique({ where: { keyHash } });
    if (previous) return this.replay(previous, requestHash);
    const prepared = await this.snapshotDraft(input.draft);
    try {
      return await sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
        // First statement acquires the SQLite writer lock, including commands
        // with different keys. No read-to-write lock upgrade or process-local mutex.
        await tx.$executeRaw`INSERT INTO publication_commands (key_hash, request_hash) VALUES (${keyHash}, ${requestHash}) ON CONFLICT (key_hash) DO NOTHING`;
        const receipt = await tx.publicationCommand.findUniqueOrThrow({ where: { keyHash } });
        if (receipt.result || receipt.requestHash !== requestHash) return this.replay(receipt, requestHash);
          const publication = await tx.publication.findUnique({ where: { publicationKey }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } });
          if (publication && await tx.remoteSubscription.findUnique({ where: { localPublicationId: publication.publicationId }, select: { subscriptionId: true } }))
            throw new ConflictException('Remote publications are read-only');
        if ((publication?.revisions[0]?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Publication revision conflict');
        if ('screenId' in input.draft) {
          const screen = await tx.screen.findUnique({ where: { id: input.draft.screenId } });
          if (!screen || screen.updatedAt.toISOString() !== input.draft.expectedUpdatedAt || screen.imageUrl !== prepared.imageUrl) throw new ConflictException('Draft changed; reload before publishing');
        }
        if ('screenDesignId' in input.draft) {
          const design = await tx.screenDesign.findUnique({ where: { id: input.draft.screenDesignId } });
          if (!design || design.updatedAt.toISOString() !== input.draft.expectedUpdatedAt) throw new ConflictException('Draft changed; reload before publishing');
        }
        if ('recipeBindingId' in input.draft) {
          const binding = await tx.recipeBinding.findUnique({ where: { recipeBindingId: input.draft.recipeBindingId } });
          if (!binding || binding.updatedAt.toISOString() !== input.draft.expectedUpdatedAt) throw new ConflictException('Draft changed; reload before publishing');
        }
        if (await tx.device.count({ where: { id: { in: input.deviceIds }, isActive: true } }) !== input.deviceIds.length) throw new NotFoundException('Target device not found');
        const content = { ...prepared.content, ...actions };
        const contentHash = sha256(canonicalJson(content));
        const data = { protocolVersion: '1.0', content: content as unknown as Prisma.InputJsonValue, contentHash };
        const revision = publication
          ? await this.persistence.appendRevision({ ...data, publicationId: publication.publicationId }, tx)
          : (await this.persistence.createPublication({ ...data, publicationKey }, tx)).revision;
        for (const id of input.deviceIds) await this.persistence.setDesiredRevision(id, revision.publicationRevisionId, tx);
        const result = { publicationId: revision.publicationId, publicationRevisionId: revision.publicationRevisionId,
          revision: revision.revision, contentHash, deviceIds: input.deviceIds };
        await tx.publicationCommand.update({ where: { keyHash }, data: { result } });
        return result;
      }, { timeout: 10_000 }), 'Publication busy; retry the same command');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1008', 'P2028', 'P2034'].includes(error.code)) {
        throw new ServiceUnavailableException('Publication busy; retry the same command');
      }
      throw error;
    }
  }

  async assign(deviceId: number, body: unknown) {
    const input = object(body);
    keys(input, ['publicationRevisionId', 'expectedDesiredRevisionId']);
    if (!positive(deviceId) || typeof input.publicationRevisionId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.publicationRevisionId) ||
      !(input.expectedDesiredRevisionId === null || typeof input.expectedDesiredRevisionId === 'string')) throw new BadRequestException('Invalid assignment command');
    const revisionId = input.publicationRevisionId;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE devices SET id = id WHERE id = ${deviceId}`;
      if (!await tx.device.findFirst({ where: { id: deviceId, isActive: true } })) throw new NotFoundException('Target device not found');
      const playback = await tx.playbackState.findUnique({ where: { deviceId } });
      if (playback && ['running', 'paused'].includes(playback.status)) throw new ConflictException('Stop playback before assigning a publication');
      const current = await tx.devicePublicationState.findUnique({ where: { deviceId } });
      if (current?.desiredPublicationRevisionId === revisionId) return { deviceId, publicationRevisionId: revisionId };
      if ((current?.desiredPublicationRevisionId ?? null) !== input.expectedDesiredRevisionId) throw new ConflictException('Device publication conflict');
      const revision = await tx.publicationRevision.findUnique({ where: { publicationRevisionId: revisionId } });
      if (!revision) throw new NotFoundException('Publication revision not found');
      publicationArtifacts(revision); // Fail without replacing the previous desired revision.
      await this.persistence.setDesiredRevision(deviceId, revisionId, tx);
      return { deviceId, publicationRevisionId: revisionId };
    });
  }

  /** Internal orchestration helper for a local uploaded screen. It never reads a
   * live URL and reuses an identical immutable snapshot when possible. */
  async publishUploadedScreen(screenId: number, expectedUpdatedAt: string) {
    const prepared = await this.snapshotDraft({ screenId, expectedUpdatedAt });
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      return this.publishUploadedScreenInTransaction(tx, screenId, expectedUpdatedAt, prepared);
    }));
  }

  /** The caller owns the enclosing transaction. This is used by the playlist
   * picker so its screen snapshots and playlist revision commit together. */
  async publishUploadedScreenInTransaction(
    tx: Prisma.TransactionClient,
    screenId: number,
    expectedUpdatedAt: string,
    prepared: { content: PublicationContent; imageUrl?: string },
  ) {
    return this.publishScreenDraftInTransaction(tx, { screenId, expectedUpdatedAt }, prepared);
  }

  /** Publishes either an uploaded image or a designer screen from the immutable
   * bytes prepared before the SQLite writer transaction begins. */
  async publishScreenDraftInTransaction(
    tx: Prisma.TransactionClient,
    draft: { screenId: number; expectedUpdatedAt: string } | { screenDesignId: number; expectedUpdatedAt: string },
    prepared: { content: PublicationContent; imageUrl?: string },
  ) {
    const contentHash = sha256(canonicalJson(prepared.content));
    const isDesign = 'screenDesignId' in draft;
    const screen = isDesign
      ? await tx.screenDesign.findUnique({ where: { id: draft.screenDesignId }, select: { updatedAt: true } })
      : await tx.screen.findUnique({ where: { id: draft.screenId }, select: { updatedAt: true, imageUrl: true } });
    if (!screen) throw new NotFoundException(isDesign ? 'Draft screen design not found' : 'Draft screen not found');
    if (screen.updatedAt.toISOString() !== draft.expectedUpdatedAt || (!isDesign && 'imageUrl' in screen && screen.imageUrl !== prepared.imageUrl))
      throw new ConflictException('Draft changed; reload before publishing');
    const existing = await tx.publicationRevision.findFirst({ where: { contentHash }, orderBy: { publishedAt: 'desc' } });
    if (existing) return existing;
    return (await this.persistence.createPublication({
      publicationKey: `screen-assignment-${randomUUID()}`,
      protocolVersion: '1.0',
      content: prepared.content as unknown as Prisma.InputJsonValue,
      contentHash,
    }, tx)).revision;
  }

  async publishRecipeDraftInTransaction(
    tx: Prisma.TransactionClient,
    draft: { recipeBindingId: string; expectedUpdatedAt: string },
    prepared: { content: PublicationContent },
  ) {
    const binding = await tx.recipeBinding.findUnique({ where: { recipeBindingId: draft.recipeBindingId } });
    if (!binding) throw new NotFoundException('Recipe binding not found');
    if (binding.updatedAt.toISOString() !== draft.expectedUpdatedAt) throw new ConflictException('Draft changed; reload before publishing');
    const contentHash = sha256(canonicalJson(prepared.content));
    const existing = await tx.publicationRevision.findFirst({ where: { contentHash }, orderBy: { publishedAt: 'desc' } });
    if (existing) return existing;
    return (await this.persistence.createPublication({
      publicationKey: `recipe-assignment-${randomUUID()}`, protocolVersion: '1.0',
      content: prepared.content as unknown as Prisma.InputJsonValue, contentHash,
    }, tx)).revision;
  }

  private replay(receipt: { requestHash: string; result: Prisma.JsonValue }, requestHash: string) {
    if (receipt.requestHash !== requestHash) throw new ConflictException('Idempotency key already used for a different command');
    if (!receipt.result) throw new ServiceUnavailableException('Publication command incomplete');
    return receipt.result;
  }

  private parse(body: unknown): PublishInput {
    const input = object(body);
    keys(input, ['idempotencyKey', 'expectedRevision', 'draft', 'deviceIds', 'allowedActions']);
    let allowedActions: AllowedAction[];
    try { allowedActions = normalizePublicationActions(input.allowedActions); }
    catch { throw new BadRequestException('Invalid publication actions'); }
    if (typeof input.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !Array.isArray(input.deviceIds) ||
      input.deviceIds.length > 100 || !input.deviceIds.every(positive)) throw new BadRequestException('Invalid publication command');
    const draft = object(input.draft);
    let parsed: PublicationDraft;
    if ('fixtureArtifacts' in draft) {
      keys(draft, ['fixtureArtifacts']);
      const ids = fixtureIds(draft.fixtureArtifacts);
      if (!ids) throw new BadRequestException('Invalid fixture draft');
      parsed = { fixtureArtifacts: ids };
    } else if ('sourceSnapshotId' in draft) {
      keys(draft, ['sourceSnapshotId']);
      if (typeof draft.sourceSnapshotId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(draft.sourceSnapshotId)) throw new BadRequestException('Invalid source snapshot reference');
      parsed = { sourceSnapshotId: draft.sourceSnapshotId };
    } else if ('recipeBindingId' in draft) {
      keys(draft, ['recipeBindingId', 'expectedUpdatedAt']);
      if (!identifier(draft.recipeBindingId) || typeof draft.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(draft.expectedUpdatedAt)
        || !Number.isFinite(Date.parse(draft.expectedUpdatedAt))) throw new BadRequestException('Invalid recipe binding draft');
      parsed = { recipeBindingId: draft.recipeBindingId, expectedUpdatedAt: draft.expectedUpdatedAt };
    } else if ('screenId' in draft) {
      keys(draft, ['screenId', 'expectedUpdatedAt']);
      if (!positive(draft.screenId) || typeof draft.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(draft.expectedUpdatedAt) || !Number.isFinite(Date.parse(draft.expectedUpdatedAt))) throw new BadRequestException('Only fixture or uploaded screen drafts are publishable');
      parsed = { screenId: draft.screenId, expectedUpdatedAt: draft.expectedUpdatedAt };
    } else {
      keys(draft, ['screenDesignId', 'expectedUpdatedAt']);
      if (!positive(draft.screenDesignId) || typeof draft.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(draft.expectedUpdatedAt) || !Number.isFinite(Date.parse(draft.expectedUpdatedAt))) throw new BadRequestException('Only fixture, uploaded screen, or captured design drafts are publishable');
      parsed = { screenDesignId: draft.screenDesignId, expectedUpdatedAt: draft.expectedUpdatedAt };
    }
    return { idempotencyKey: input.idempotencyKey.toLowerCase(), expectedRevision: Number(input.expectedRevision), draft: parsed, deviceIds: [...new Set(input.deviceIds as number[])].sort((a, b) => a - b), allowedActions };
  }

  /**
   * Produces the same bounded immutable snapshot used by the public publish
   * command. Callers must revalidate the draft inside their write transaction.
   */
  async snapshotDraft(draft: PublicationDraft): Promise<{ content: PublicationContent; imageUrl?: string }> {
    if ('fixtureArtifacts' in draft) return { content: { schemaVersion: 1, fixtureArtifacts: draft.fixtureArtifacts } };
    if ('sourceSnapshotId' in draft) {
      const row = await this.prisma.sourceSnapshot.findUnique({ where: { snapshotId: draft.sourceSnapshotId } });
      if (!row || !row.validDataCreatedAt || !['fresh', 'stale'].includes(row.freshnessState)
        || row.schemaVersion !== '1' || sha256(canonicalJson(row.data)) !== row.contentHash) throw new BadRequestException('Source snapshot unavailable');
      // Foundation proof uses the existing fixture pixels, not a new widget or
      // live source lookup. Every byte-producing input comes from this SQL row.
      const data = row.data;
      const ids = data && typeof data === 'object' && !Array.isArray(data)
        && Object.keys(data).length === 1 ? fixtureIds(data.fixtureArtifacts) : null;
      const sourceSnapshot = {
        sourceId: row.sourceDefinitionId, snapshotId: row.snapshotId, revision: row.revision,
        contentHash: row.contentHash, connectorVersion: row.connectorVersion,
      };
      if (ids) return { content: { schemaVersion: 1, fixtureArtifacts: ids, sourceSnapshot } };
      const panel = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1
        ? (data as Record<string, unknown>).grafanaPanel : null;
      if (!panel || typeof panel !== 'object' || Array.isArray(panel)) throw new BadRequestException('Source snapshot has no supported artifact schema');
      const image = panel as Record<string, unknown>;
      const width = image.width as number, height = image.height as number;
      if (typeof image.png !== 'string' || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
        || width < 1 || height < 1 || width * height > 4_194_304
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.png) || image.png.length > 3_000_000) throw new BadRequestException('Grafana image snapshot invalid');
      try {
        const bytes = Buffer.from(image.png, 'base64');
        const normalized = await sharp(bytes, { limitInputPixels: 4_194_304, animated: false }).rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
        if (normalized.data.length > 2 * 1024 * 1024 || normalized.info.width !== width || normalized.info.height !== height) throw new Error();
        return { content: { schemaVersion: 1, image: { png: normalized.data.toString('base64'), width: normalized.info.width, height: normalized.info.height,
          sha256: sha256(normalized.data) }, sourceSnapshot } };
      } catch { throw new BadRequestException('Grafana image snapshot invalid'); }
    }
    if ('recipeBindingId' in draft) {
      const rendered = await this.recipes.snapshotBinding(draft.recipeBindingId, draft.expectedUpdatedAt);
      try {
        const normalized = await sharp(rendered.bytes, { limitInputPixels: 4_194_304, animated: false })
          .rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
        if (normalized.info.width !== rendered.width || normalized.info.height !== rendered.height || normalized.data.length > 2 * 1024 * 1024) throw new Error();
        return { content: { schemaVersion: 1, image: { png: normalized.data.toString('base64'), width: normalized.info.width,
          height: normalized.info.height, sha256: sha256(normalized.data) }, ...(rendered.sourceSnapshot ? { sourceSnapshot: rendered.sourceSnapshot } : {}) } };
      } catch { throw new BadRequestException('Recipe capture unavailable or unsupported'); }
    }
    const isDesign = 'screenDesignId' in draft;
    const id = isDesign ? draft.screenDesignId : draft.screenId;
    const expectedUpdatedAt = draft.expectedUpdatedAt;
    const design = isDesign
      ? await this.prisma.screenDesign.findUnique({
        where: { id },
        select: {
          id: true, name: true, width: true, height: true, background: true, updatedAt: true,
          widgets: {
            select: {
              id: true, screenDesignId: true, templateId: true, x: true, y: true, width: true, height: true,
              rotation: true, config: true, zIndex: true, template: { select: { name: true, label: true } },
            },
            orderBy: { zIndex: 'asc' },
          },
        },
      })
      : null;
    const uploaded = isDesign
      ? null
      : await this.prisma.screen.findUnique({ where: { id }, select: { imageUrl: true, updatedAt: true } });
    const screen = design ?? uploaded;
    if (!screen) throw new NotFoundException(isDesign ? 'Draft screen design not found' : 'Draft screen not found');
    if (screen.updatedAt.toISOString() !== expectedUpdatedAt) throw new ConflictException('Draft changed; reload before publishing');
    // No URLs, providers, live design/plugin renders or arbitrary filesystem reads.
    const imageUrl = uploaded?.imageUrl;
    if (!isDesign && !/^\/uploads\/screens\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|bmp)$/i.test(imageUrl!)) throw new BadRequestException('Only local uploaded images can be published');
    try {
      let bytes: Buffer;
      if (isDesign) {
        // Always render a fresh RGB source. Older capture files may have been
        // irreversibly converted to grayscale by pre-LCD versions.
        bytes = await this.screenRenderer.renderScreenDesign(id, undefined, 'preview');
      } else {
        const root = await realpath(resolve(process.cwd(), 'uploads', 'screens'));
        const path = await realpath(resolve(root, imageUrl!.split('/').pop()!));
        if (!path.startsWith(root + sep) || (await stat(path)).size > 8 * 1024 * 1024) throw new Error();
        bytes = await readFile(path);
      }
      // Decode and strip metadata; store bounded, self-contained image pixels.
      const { data, info } = await sharp(bytes, { limitInputPixels: 16_777_216, animated: false }).rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
      if (data.length > 2 * 1024 * 1024) throw new Error();
      const designMetadata = isDesign && design ? {
        dynamicDesign: { screenDesignId: id, expectedUpdatedAt, refreshSeconds: 60 },
        designSnapshot: {
          version: 1 as const,
          id: design.id,
          name: design.name,
          width: design.width,
          height: design.height,
          background: design.background,
          widgets: design.widgets,
        } satisfies PublishedDesignSnapshot,
      } : {};
      return { ...(imageUrl ? { imageUrl } : {}), content: { schemaVersion: 1, image: { png: data.toString('base64'), width: info.width, height: info.height, sha256: sha256(data) }, ...designMetadata } };
    } catch { throw new BadRequestException(isDesign ? 'Design capture unavailable or unsupported' : 'Draft image unavailable or unsupported'); }
  }
}
