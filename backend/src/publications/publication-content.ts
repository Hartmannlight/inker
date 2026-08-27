import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseProtocolVersion, type RenderFormat } from '@inker/contracts';
import type { PublicationRevision } from '@prisma/client';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';

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

export type PublicationContent =
  | { schemaVersion: 1; fixtureArtifacts: string[] }
  | { schemaVersion: 1; image: { png: string; width: number; height: number; sha256: string } };

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

/** Reads only immutable snapshot data and the fixed WP-14 fixture catalog. */
export function publicationArtifacts(revision: PublicationRevision): PublishedArtifact[] {
  const unavailable = () => { throw new ServiceUnavailableException('Published artifacts unavailable'); };
  const content = revision.content;
  if (!parseProtocolVersion(revision.protocolVersion).success || !content || typeof content !== 'object' || Array.isArray(content)) return unavailable();
  if (content.schemaVersion !== undefined) {
    if (content.schemaVersion !== 1 || sha256(canonicalJson(content)) !== revision.contentHash) return unavailable();
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
    format: 'png', mimeType: 'image/png', colorSpace: 'rgb', bitDepth: 8, rotation: 0 }];
}
