import { ServiceUnavailableException } from '@nestjs/common';
import { FEDERATION_LIMITS, parseFederationPublicationFeed, parseProtocolVersion, type AllowedAction, type FederationPublicationFeed, type RenderFormat } from '@inker/contracts';
import type { Prisma, PublicationRevision } from '@prisma/client';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { normalizePublicationActions } from './publication-actions';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
export { canonicalJson, sha256 } from '../common/utils/content-hash.util';

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

export type PublishedDesignWidget = {
  id: number;
  screenDesignId: number;
  templateId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  config: Prisma.JsonValue;
  zIndex: number;
  template: { name: string; label: string };
};

/**
 * Immutable render recipe captured alongside a design publication. It contains
 * only the fields consumed by the renderer; mutable draft timestamps and
 * relations deliberately stay outside the publication boundary.
 */
export type PublishedDesignSnapshot = {
  version: 1;
  id: number;
  name: string;
  width: number;
  height: number;
  background: string;
  widgets: PublishedDesignWidget[];
};

export type PublicationContent = (
  | { schemaVersion: 1; fixtureArtifacts: string[] }
  | { schemaVersion: 1; image: { png: string; width: number; height: number; sha256: string } }
  | { schemaVersion: 2; feed: FederationPublicationFeed; artifactBytes: string[] }
) & {
  sourceSnapshot?: PublishedSourceReference;
  allowedActions?: AllowedAction[];
  clientOverlay?: { kind: 'clock'; timezone: string }; // read compatibility for the short-lived ESP overlay revision
  dynamicDesign?: { screenDesignId: number; expectedUpdatedAt: string; refreshSeconds: number };
  designSnapshot?: PublishedDesignSnapshot;
};

export function publicationDesignSnapshot(revision: PublicationRevision): PublishedDesignSnapshot | undefined {
  const content = revision.content;
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
    sha256(canonicalJson(content)) !== revision.contentHash) return undefined;
  const value = content.designSnapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value).length > 262_144 ||
    Object.keys(value).some(key => !['version', 'id', 'name', 'width', 'height', 'background', 'widgets'].includes(key)) ||
    value.version !== 1 || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || typeof value.name !== 'string' || value.name.length > 200 ||
    !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || Number(value.width) < 1 || Number(value.height) < 1 ||
    Number(value.width) * Number(value.height) > 16_777_216 || typeof value.background !== 'string' || value.background.length > 64 ||
    !Array.isArray(value.widgets) || value.widgets.length > 128) return undefined;
  const widgets: PublishedDesignWidget[] = [];
  for (const entry of value.widgets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).some(key => !['id', 'screenDesignId', 'templateId', 'x', 'y', 'width', 'height', 'rotation', 'config', 'zIndex', 'template'].includes(key)) ||
      !Number.isSafeInteger(entry.id) || !Number.isSafeInteger(entry.screenDesignId) || Number(entry.screenDesignId) !== Number(value.id) ||
      !Number.isSafeInteger(entry.templateId) || !Number.isSafeInteger(entry.x) || !Number.isSafeInteger(entry.y) ||
      !Number.isSafeInteger(entry.width) || !Number.isSafeInteger(entry.height) || Number(entry.width) < 1 || Number(entry.height) < 1 ||
      !Number.isSafeInteger(entry.rotation) || !Number.isSafeInteger(entry.zIndex) || entry.config === undefined ||
      !entry.template || typeof entry.template !== 'object' || Array.isArray(entry.template) ||
      Object.keys(entry.template).some(key => !['name', 'label'].includes(key)) ||
      typeof entry.template.name !== 'string' || entry.template.name.length > 100 ||
      typeof entry.template.label !== 'string' || entry.template.label.length > 200) return undefined;
    widgets.push({
      id: Number(entry.id), screenDesignId: Number(entry.screenDesignId), templateId: Number(entry.templateId),
      x: Number(entry.x), y: Number(entry.y), width: Number(entry.width), height: Number(entry.height),
      rotation: Number(entry.rotation), config: entry.config as Prisma.JsonValue, zIndex: Number(entry.zIndex),
      template: { name: entry.template.name, label: entry.template.label },
    });
  }
  return {
    version: 1, id: Number(value.id), name: value.name, width: Number(value.width), height: Number(value.height),
    background: value.background, widgets,
  };
}

export function publicationDynamicDesign(revision: PublicationRevision): PublicationContent['dynamicDesign'] {
  const content = revision.content;
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
    sha256(canonicalJson(content)) !== revision.contentHash) return undefined;
  const value = content.dynamicDesign;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['screenDesignId', 'expectedUpdatedAt', 'refreshSeconds'].includes(key)) ||
    !Number.isSafeInteger(value.screenDesignId) || Number(value.screenDesignId) < 1 || value.refreshSeconds !== 60 ||
    typeof value.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expectedUpdatedAt)) return undefined;
  return { screenDesignId: Number(value.screenDesignId), expectedUpdatedAt: value.expectedUpdatedAt, refreshSeconds: 60 };
}

export function publicationClientOverlay(revision: PublicationRevision): { kind: 'clock'; timezone: string } | undefined {
  const content = revision.content;
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
    sha256(canonicalJson(content)) !== revision.contentHash) return undefined;
  const overlay = content.clientOverlay;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay) ||
    Object.keys(overlay).some(key => !['kind', 'timezone'].includes(key)) || overlay.kind !== 'clock' ||
    typeof overlay.timezone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(overlay.timezone)) return undefined;
  return { kind: 'clock', timezone: overlay.timezone };
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
