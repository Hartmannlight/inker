import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FEDERATION_LIMITS, parseFederationPublicationFeed, parseProtocolVersion, type AllowedAction, type FederationPublicationFeed, type RenderFormat } from '@inker/contracts';
import type { PublicationRevision } from '@prisma/client';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { normalizePublicationActions } from './publication-actions';

export interface PublishedArtifact {
  format: RenderFormat;
  mimeType: string;
  width: number;
  height: number;
  colorSpace: 'monochrome' | 'grayscale' | 'rgb';
  bitDepth: number;
  rotation: number;
  bytes: Buffer;
  sha256: string;
}

export type PublishedSourceReference = {
  sourceId: string;
  snapshotId: string;
  revision: number;
  contentHash: string;
  connectorVersion: string;
};

export type PublicationContent = (
  | { schemaVersion: 1; fixtureArtifacts: string[] }
  | { schemaVersion: 1; image: { png: string; width: number; height: number; sha256: string } }
  | { schemaVersion: 2; feed: FederationPublicationFeed; artifactBytes: string[] }
) & { sourceSnapshot?: PublishedSourceReference; allowedActions?: AllowedAction[] };

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Stable JSON for command identity and content checksums, independent of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fixtureIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > PULL_FIXTURE_ARTIFACTS.length ||
    value.some(id => typeof id !== 'string' || !PULL_FIXTURE_ARTIFACTS.some(a => a.fixtureId === id)) || new Set(value).size !== value.length) return null;
  return [...value].sort();
}

/** Rights originate only in verified, immutable publication content. */
export function publicationAllowedActions(revision: PublicationRevision): AllowedAction[] {
  try {
    const content = revision.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)
      || content.schemaVersion !== 1 || content.allowedActions === undefined
      || sha256(canonicalJson(content)) !== revision.contentHash) return [];
    publicationArtifacts(revision);
    return normalizePublicationActions(content.allowedActions);
  } catch { return []; }
}

/** Reads only immutable snapshot data and the fixed WP-14 fixture catalog. */
export function publicationArtifacts(revision: PublicationRevision): PublishedArtifact[] {
  const unavailable = () => { throw new ServiceUnavailableException('Published artifacts unavailable'); };
  const content = revision.content;
  if (!parseProtocolVersion(revision.protocolVersion).success || !content || typeof content !== 'object' || Array.isArray(content)) return unavailable();
  if (content.schemaVersion !== undefined) {
    if (![1, 2].includes(Number(content.schemaVersion)) || sha256(canonicalJson(content)) !== revision.contentHash) return unavailable();
  }
  if (content.schemaVersion === 2) {
    const feed = parseFederationPublicationFeed(content.feed);
    const encoded = content.artifactBytes;
    if (!feed.success || !Array.isArray(encoded) || encoded.length !== feed.data.artifacts.length
      || Object.keys(content).some(key => !['schemaVersion', 'feed', 'artifactBytes'].includes(key))) return unavailable();
    let total = 0;
    return feed.data.artifacts.map((artifact, index) => {
      const text = encoded[index];
      if (typeof text !== 'string' || text.length > Math.ceil(FEDERATION_LIMITS.artifactBytes / 3) * 4) return unavailable();
      const bytes = Buffer.from(text, 'base64');
      total += bytes.length;
      if (total > FEDERATION_LIMITS.totalArtifactBytes || bytes.length !== artifact.sizeBytes
        || bytes.toString('base64') !== text || sha256(bytes) !== artifact.sha256) return unavailable();
      const { format, mimeType, width, height, colorSpace, bitDepth, rotation } = artifact;
      return { format, mimeType, width, height, colorSpace, bitDepth, rotation, bytes, sha256: artifact.sha256 };
    });
  }
  // Read compatibility for already persisted WP-14 fixture publications. Never
  // rewrite those immutable rows or adopt arbitrary legacy snapshot fields.
  const ids = fixtureIds(content.fixtureArtifacts);
  if (ids) return PULL_FIXTURE_ARTIFACTS.filter(a => ids.includes(a.fixtureId));
  const image = content.image;
  if (content.schemaVersion !== 1 || !image || typeof image !== 'object' || Array.isArray(image) ||
    typeof image.png !== 'string' || image.png.length > 2_800_000 || typeof image.sha256 !== 'string' ||
    !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || Number(image.width) < 1 || Number(image.height) < 1) return unavailable();
  const bytes = Buffer.from(image.png, 'base64');
  if (sha256(bytes) !== image.sha256) return unavailable();
  return [{ bytes, sha256: image.sha256, width: Number(image.width), height: Number(image.height),
    format: 'png', mimeType: 'image/png', colorSpace: 'rgb', bitDepth: 24, rotation: 0 }];
}
