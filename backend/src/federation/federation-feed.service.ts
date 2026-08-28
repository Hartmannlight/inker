import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  FEDERATION_LIMITS, parseFederationCapabilities, parseFederationPublicationFeed,
  type FederationCapabilities, type FederationPublicationFeed,
} from '@inker/contracts';
import type { PublicationRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalJson, publicationArtifacts, sha256, type PublishedArtifact } from '../publications/publication-content';
import { FederationIdentityService } from './federation-identity.service';

const PUBLICATION_ID = /^[A-Za-z0-9-]{1,100}$/;
const ARTIFACT_HASH = /^[a-f0-9]{64}$/;
const unavailable = () => new ServiceUnavailableException('FEDERATION_PUBLICATION_UNAVAILABLE');

/** Projects immutable publication bytes only. No device, draft, source or renderer dependency. */
@Injectable()
export class FederationFeedService {
  constructor(private readonly prisma: PrismaService, private readonly identity: FederationIdentityService) {}

  async capabilities(): Promise<{ body: FederationCapabilities; etag: string }> {
    const candidate = {
      protocolVersion: '1.0', serverId: await this.identity.serverId().catch(() => { throw unavailable(); }), readOnly: true,
      features: ['publication-feed', 'immutable-artifacts'],
      limits: {
        manifestBytes: FEDERATION_LIMITS.manifestBytes,
        artifactBytes: FEDERATION_LIMITS.artifactBytes,
        artifacts: FEDERATION_LIMITS.artifacts,
      },
    };
    const parsed = parseFederationCapabilities(candidate);
    if (!parsed.success) throw unavailable();
    return { body: parsed.data, etag: this.etag(parsed.data) };
  }

  async read(publicationId: string): Promise<{ body: FederationPublicationFeed; etag: string }> {
    this.validatePublicationId(publicationId);
    const revision = await this.prisma.publicationRevision.findFirst({
      where: { publicationId }, orderBy: { revision: 'desc' },
    }).catch(() => { throw unavailable(); });
    if (!revision) throw new NotFoundException('FEDERATION_PUBLICATION_NOT_FOUND');
    const artifacts = this.verifiedArtifacts(revision);
    return this.project(revision, artifacts);
  }

  private async project(revision: PublicationRevision, artifacts: PublishedArtifact[]): Promise<{
    body: FederationPublicationFeed; etag: string;
  }> {
    try {
      const body = {
        protocolVersion: '1.0', serverId: await this.identity.serverId(),
        publicationId: revision.publicationId,
        publicationRevisionId: revision.publicationRevisionId,
        revision: revision.revision, publishedAt: revision.publishedAt.toISOString(),
        artifacts: artifacts.map(artifact => ({
          artifactId: artifact.sha256, sha256: artifact.sha256,
          mimeType: artifact.mimeType, format: artifact.format,
          width: artifact.width, height: artifact.height,
          colorSpace: artifact.colorSpace, bitDepth: artifact.bitDepth,
          rotation: artifact.rotation, sizeBytes: artifact.bytes.length,
          url: `/api/federation/v1/publications/${revision.publicationId}/revisions/${revision.revision}/artifacts/${artifact.sha256}`,
        })),
      };
      const parsed = parseFederationPublicationFeed(body);
      if (!parsed.success) throw unavailable();
      return { body: parsed.data, etag: this.etag(parsed.data) };
    } catch { throw unavailable(); }
  }

  async artifact(publicationId: string, revisionValue: string, hash: string): Promise<{
    bytes: Buffer; mimeType: string; etag: string;
  }> {
    this.validatePublicationId(publicationId);
    if (!/^[1-9][0-9]{0,9}$/.test(revisionValue) || Number(revisionValue) > FEDERATION_LIMITS.maxRevision
      || !ARTIFACT_HASH.test(hash)) throw new NotFoundException('FEDERATION_ARTIFACT_NOT_FOUND');
    // Retained revisions survive a concurrent publish. The compound key also
    // prevents a credential from reaching another publication's bytes.
    const revision = await this.prisma.publicationRevision.findUnique({
      where: { publicationId_revision: { publicationId, revision: Number(revisionValue) } },
    }).catch(() => { throw unavailable(); });
    if (!revision) throw new NotFoundException('FEDERATION_ARTIFACT_NOT_FOUND');
    const artifacts = this.verifiedArtifacts(revision);
    await this.project(revision, artifacts);
    const artifact = artifacts.find(value => value.sha256 === hash);
    if (!artifact) throw new NotFoundException('FEDERATION_ARTIFACT_NOT_FOUND');
    return { bytes: Buffer.from(artifact.bytes), mimeType: artifact.mimeType, etag: `"${artifact.sha256}"` };
  }

  private verifiedArtifacts(revision: PublicationRevision): PublishedArtifact[] {
    try {
      // Federation does not inherit the legacy device fixture checksum exemption.
      if (sha256(canonicalJson(revision.content)) !== revision.contentHash) throw unavailable();
      const artifacts = publicationArtifacts(revision);
      if (!artifacts.length || artifacts.length > FEDERATION_LIMITS.artifacts
        || artifacts.some(artifact => artifact.bytes.length === 0
          || artifact.bytes.length > FEDERATION_LIMITS.artifactBytes || sha256(artifact.bytes) !== artifact.sha256)
        || artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0) > FEDERATION_LIMITS.totalArtifactBytes) throw unavailable();
      return artifacts;
    } catch { throw unavailable(); }
  }

  private validatePublicationId(publicationId: string): void {
    if (!PUBLICATION_ID.test(publicationId)) throw new NotFoundException('FEDERATION_PUBLICATION_NOT_FOUND');
  }

  private etag(body: FederationCapabilities | FederationPublicationFeed): string {
    return `"${sha256(canonicalJson(body))}"`;
  }
}
