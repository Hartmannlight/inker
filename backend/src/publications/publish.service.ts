import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import * as sharpModule from 'sharp';
import type sharpFactory from 'sharp';
const sharp = ((sharpModule as unknown as { default?: typeof sharpFactory }).default ?? sharpModule) as typeof sharpFactory;
import { PrismaService } from '../prisma/prisma.service';
import { PublicationPersistenceService } from './publication-persistence.service';
import { canonicalJson, fixtureIds, publicationArtifacts, sha256, type PublicationContent } from './publication-content';

type Draft = { fixtureArtifacts: string[] } | { screenId: number; expectedUpdatedAt: string };
type PublishInput = { idempotencyKey: string; expectedRevision: number; draft: Draft; deviceIds: number[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid publication command');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BadRequestException('Unknown publication command field');
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

@Injectable()
export class PublishService {
  constructor(private readonly prisma: PrismaService, private readonly persistence: PublicationPersistenceService) {}

  async publish(publicationKey: string, body: unknown) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(publicationKey)) throw new BadRequestException('Invalid publication key');
    const input = this.parse(body);
    const keyHash = sha256(input.idempotencyKey);
    const requestHash = sha256(canonicalJson({ publicationKey, expectedRevision: input.expectedRevision, draft: input.draft, deviceIds: input.deviceIds }));
    // Replay precedes draft lookup: deletion/edit after success cannot change a retry.
    const previous = await this.prisma.publicationCommand.findUnique({ where: { keyHash } });
    if (previous) return this.replay(previous, requestHash);
    const prepared = await this.snapshot(input.draft);
    try {
      return await this.prisma.$transaction(async tx => {
        // First statement acquires the SQLite writer lock, including commands
        // with different keys. No read-to-write lock upgrade or process-local mutex.
        await tx.$executeRaw`INSERT INTO publication_commands (key_hash, request_hash) VALUES (${keyHash}, ${requestHash}) ON CONFLICT (key_hash) DO NOTHING`;
        const receipt = await tx.publicationCommand.findUniqueOrThrow({ where: { keyHash } });
        if (receipt.result || receipt.requestHash !== requestHash) return this.replay(receipt, requestHash);
        const publication = await tx.publication.findUnique({ where: { publicationKey }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } });
        if ((publication?.revisions[0]?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Publication revision conflict');
        if ('screenId' in input.draft) {
          const screen = await tx.screen.findUnique({ where: { id: input.draft.screenId } });
          if (!screen || screen.updatedAt.toISOString() !== input.draft.expectedUpdatedAt || screen.imageUrl !== prepared.imageUrl) throw new ConflictException('Draft changed; reload before publishing');
        }
        if (await tx.device.count({ where: { id: { in: input.deviceIds }, isActive: true } }) !== input.deviceIds.length) throw new NotFoundException('Target device not found');
        const contentHash = sha256(canonicalJson(prepared.content));
        const data = { protocolVersion: '1.0', content: prepared.content as Prisma.InputJsonValue, contentHash };
        const revision = publication
          ? await this.persistence.appendRevision({ ...data, publicationId: publication.publicationId }, tx)
          : (await this.persistence.createPublication({ ...data, publicationKey }, tx)).revision;
        for (const id of input.deviceIds) await this.persistence.setDesiredRevision(id, revision.publicationRevisionId, tx);
        const result = { publicationId: revision.publicationId, publicationRevisionId: revision.publicationRevisionId,
          revision: revision.revision, contentHash, deviceIds: input.deviceIds };
        await tx.publicationCommand.update({ where: { keyHash }, data: { result } });
        return result;
      }, { timeout: 10_000 });
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

  private replay(receipt: { requestHash: string; result: Prisma.JsonValue }, requestHash: string) {
    if (receipt.requestHash !== requestHash) throw new ConflictException('Idempotency key already used for a different command');
    if (!receipt.result) throw new ServiceUnavailableException('Publication command incomplete');
    return receipt.result;
  }

  private parse(body: unknown): PublishInput {
    const input = object(body);
    keys(input, ['idempotencyKey', 'expectedRevision', 'draft', 'deviceIds']);
    if (typeof input.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !Array.isArray(input.deviceIds) ||
      input.deviceIds.length > 100 || !input.deviceIds.every(positive)) throw new BadRequestException('Invalid publication command');
    const draft = object(input.draft);
    let parsed: Draft;
    if ('fixtureArtifacts' in draft) {
      keys(draft, ['fixtureArtifacts']);
      const ids = fixtureIds(draft.fixtureArtifacts);
      if (!ids) throw new BadRequestException('Invalid fixture draft');
      parsed = { fixtureArtifacts: ids };
    } else {
      keys(draft, ['screenId', 'expectedUpdatedAt']);
      if (!positive(draft.screenId) || typeof draft.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(draft.expectedUpdatedAt) || !Number.isFinite(Date.parse(draft.expectedUpdatedAt))) throw new BadRequestException('Only fixture or uploaded screen drafts are publishable');
      parsed = { screenId: draft.screenId, expectedUpdatedAt: draft.expectedUpdatedAt };
    }
    return { idempotencyKey: input.idempotencyKey.toLowerCase(), expectedRevision: Number(input.expectedRevision), draft: parsed, deviceIds: [...new Set(input.deviceIds as number[])].sort((a, b) => a - b) };
  }

  private async snapshot(draft: Draft): Promise<{ content: PublicationContent; imageUrl?: string }> {
    if ('fixtureArtifacts' in draft) return { content: { schemaVersion: 1, fixtureArtifacts: draft.fixtureArtifacts } };
    const screen = await this.prisma.screen.findUnique({ where: { id: draft.screenId } });
    if (!screen) throw new NotFoundException('Draft screen not found');
    if (screen.updatedAt.toISOString() !== draft.expectedUpdatedAt) throw new ConflictException('Draft changed; reload before publishing');
    // No URLs, providers, live design/plugin renders or arbitrary filesystem reads.
    if (!/^\/uploads\/screens\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|bmp)$/i.test(screen.imageUrl)) throw new BadRequestException('Only local uploaded images can be published');
    try {
      const root = await realpath(resolve(process.cwd(), 'uploads', 'screens'));
      const path = await realpath(resolve(root, screen.imageUrl.split('/').pop()!));
      if (!path.startsWith(root + sep) || (await stat(path)).size > 8 * 1024 * 1024) throw new Error();
      const bytes = await readFile(path);
      // Decode and strip metadata; store bounded, self-contained image pixels.
      const { data, info } = await sharp(bytes, { limitInputPixels: 16_777_216, animated: false }).rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
      if (data.length > 2 * 1024 * 1024) throw new Error();
      return { imageUrl: screen.imageUrl, content: { schemaVersion: 1, image: { png: data.toString('base64'), width: info.width, height: info.height, sha256: sha256(data) } } };
    } catch { throw new BadRequestException('Draft image unavailable or unsupported'); }
  }
}
