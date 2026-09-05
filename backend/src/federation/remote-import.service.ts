import { Injectable } from '@nestjs/common';
import type { Prisma, RemoteSubscription } from '@prisma/client';
import { FEDERATION_LIMITS, parseFederationPublicationFeed, type FederationPublicationFeed } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { PublicationPersistenceService } from '../publications/publication-persistence.service';
import { publicationArtifacts } from '../publications/publication-content';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
import { sharp } from '../common/utils/sharp.util';

const fail = (code: string): never => { throw new Error(code); };

/** Immutable SQLite publication content is the durable, atomic remote cache. */
@Injectable()
export class RemoteImportService {
  constructor(private readonly prisma: PrismaService, private readonly publications: PublicationPersistenceService) {}

  private checked(feed: FederationPublicationFeed, artifacts: Buffer[]) {
    const parsed = parseFederationPublicationFeed(feed);
    if (!parsed.success || !Array.isArray(artifacts) || artifacts.length !== parsed.data.artifacts.length) return fail('REMOTE_RESPONSE_INVALID');
    let total = 0;
    parsed.data.artifacts.forEach((meta, index) => {
      const bytes = artifacts[index];
      if (!Buffer.isBuffer(bytes) || bytes.length !== meta.sizeBytes || sha256(bytes) !== meta.sha256) fail('REMOTE_HASH_MISMATCH');
      total += bytes.length;
      if (total > FEDERATION_LIMITS.totalArtifactBytes) fail('REMOTE_RESPONSE_TOO_LARGE');
    });
    return parsed.data;
  }

  /** Decoding occurs in the worker before its short cache transaction. */
  async validateArtifacts(feed: FederationPublicationFeed, artifacts: Buffer[]): Promise<void> {
    const value = this.checked(feed, artifacts);
    for (let index = 0; index < artifacts.length; index++) {
      const bytes = artifacts[index], meta = value.artifacts[index];
      try {
        if (meta.format === 'bmp1') {
          const stride = Math.ceil(meta.width / 32) * 4;
          if (bytes.length < 62 || bytes.toString('ascii', 0, 2) !== 'BM' || bytes.readUInt32LE(2) !== bytes.length
            || bytes.readUInt32LE(10) !== 62 || bytes.readUInt32LE(14) !== 40 || bytes.readInt32LE(18) !== meta.width
            || bytes.readInt32LE(22) !== meta.height || bytes.readUInt16LE(26) !== 1 || bytes.readUInt16LE(28) !== 1
            || bytes.readUInt32LE(30) !== 0 || bytes.readUInt32LE(34) !== stride * meta.height || bytes.length !== 62 + stride * meta.height
            || !bytes.subarray(54, 62).equals(Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]))) fail('REMOTE_RESPONSE_INVALID');
        } else {
          if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('REMOTE_RESPONSE_INVALID');
          const pipeline = sharp(bytes, { limitInputPixels: FEDERATION_LIMITS.maxPixels, animated: false, failOn: 'warning' }).timeout({ seconds: 3 });
          const metadata = await pipeline.metadata();
          if (metadata.format !== 'png' || metadata.width !== meta.width || metadata.height !== meta.height
            || (metadata.pages ?? 1) !== 1 || metadata.orientation !== undefined) fail('REMOTE_RESPONSE_INVALID');
          const pixels = await pipeline.flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer();
          const level = (value: number, bits: number) => Math.round(Math.round(value * (2 ** bits - 1) / 255) * 255 / (2 ** bits - 1));
          for (let pixel = 0; pixel < pixels.length; pixel += 3) {
            if (meta.colorSpace !== 'rgb') {
              if (pixels[pixel] !== pixels[pixel + 1] || pixels[pixel] !== pixels[pixel + 2]
                || pixels[pixel] !== level(pixels[pixel], meta.bitDepth)) fail('REMOTE_RESPONSE_INVALID');
            } else if (meta.bitDepth < 24) {
              const bits = meta.bitDepth === 16 ? [5, 6, 5] : [3, 3, 2];
              for (let channel = 0; channel < 3; channel++)
                if (pixels[pixel + channel] !== level(pixels[pixel + channel], bits[channel])) fail('REMOTE_RESPONSE_INVALID');
            }
          }
        }
      } catch { fail('REMOTE_RESPONSE_INVALID'); }
    }
  }

  async verifyCached(subscription: RemoteSubscription): Promise<void> {
    try {
      if (!subscription.latestLocalRevisionId || !subscription.feedHash) fail('REMOTE_CACHE_INVALID');
      const revision = await this.prisma.publicationRevision.findUniqueOrThrow({ where: { publicationRevisionId: subscription.latestLocalRevisionId! } });
      if (revision.publicationId !== subscription.localPublicationId) fail('REMOTE_CACHE_INVALID');
      publicationArtifacts(revision);
      const content = revision.content as unknown as { schemaVersion: number; feed: FederationPublicationFeed };
      if (content.schemaVersion !== 2 || sha256(canonicalJson(content.feed)) !== subscription.feedHash
        || content.feed.publicationId !== subscription.remotePublicationId || content.feed.revision !== subscription.remoteRevision
        || content.feed.publicationRevisionId !== subscription.remoteRevisionId) fail('REMOTE_CACHE_INVALID');
    } catch { fail('REMOTE_CACHE_INVALID'); }
  }

  async persist(tx: Prisma.TransactionClient, subscription: RemoteSubscription, feed: FederationPublicationFeed, artifacts: Buffer[]) {
    const value = this.checked(feed, artifacts), hash = sha256(canonicalJson(value));
    const server = await tx.remoteServer.findUniqueOrThrow({ where: { remoteServerId: subscription.remoteServerId } });
    if (!server.trusted || value.serverId !== server.serverId) fail('REMOTE_IDENTITY_MISMATCH');
    if (value.publicationId !== subscription.remotePublicationId) fail('REMOTE_PUBLICATION_MISMATCH');
    if (subscription.remoteRevision !== null && (value.revision < subscription.remoteRevision ||
      (value.revision === subscription.remoteRevision && (subscription.feedHash !== hash || subscription.remoteRevisionId !== value.publicationRevisionId))))
      fail('REMOTE_REVISION_CONFLICT');
    const content = { schemaVersion: 2, feed: value, artifactBytes: artifacts.map(bytes => bytes.toString('base64')) };
    const contentHash = sha256(canonicalJson(content));
    if (subscription.latestLocalRevisionId && hash === subscription.feedHash) {
      const cached = await tx.publicationRevision.findUnique({ where: { publicationRevisionId: subscription.latestLocalRevisionId } });
      if (cached && cached.publicationId === subscription.localPublicationId && cached.contentHash === contentHash) {
        try { publicationArtifacts(cached); return { publicationRevisionId: cached.publicationRevisionId, revision: cached.revision }; }
        catch { /* An intact refetch may repair a corrupted cached revision via a new immutable row. */ }
      }
    }
    const revision = await this.publications.appendRevision({ publicationId: subscription.localPublicationId,
      protocolVersion: '1.0', content: content as unknown as Prisma.InputJsonValue, contentHash }, tx);
    // Follow only devices still assigned to this publication. Manual switches
    // and immutable playlist snapshots must not be overwritten by remote sync.
    const assigned = await tx.devicePublicationState.findMany({ where: { desiredRevision: { publicationId: subscription.localPublicationId },
      device: { isActive: true, OR: [{ playbackState: null }, { playbackState: { status: { notIn: ['running', 'paused'] } } }] } }, select: { deviceId: true } });
    for (const { deviceId } of assigned) await this.publications.setDesiredRevision(deviceId, revision.publicationRevisionId, tx);
    return { publicationRevisionId: revision.publicationRevisionId, revision: revision.revision };
  }
}
