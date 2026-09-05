import { NotAcceptableException } from '@nestjs/common';
import type { DeviceCapabilities, RenderFormat } from '@inker/contracts';
import type { PublicationRevision } from '@prisma/client';
import type { ResolvedDeviceConfiguration } from '../device-platform/device-configuration';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';

type DisplayCapabilities = DeviceCapabilities['display'];

/** Bump when pixel processing, encoding settings or renderer dependencies change. */
export const RENDERER_VERSION = 'snapshot-sharp-0.33.5-v1';
export const MAX_RENDER_PIXELS = 16_777_216;
export const MAX_RENDER_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface RenderTarget {
  profileId: string;
  width: number;
  height: number;
  colorSpace: DisplayCapabilities['colorSpace'];
  /** Panel precision: RGB16 is RGB565, RGB24 is 8 bits per channel. */
  bitDepth: number;
  rotation: DisplayCapabilities['rotation'];
  format: Exclude<RenderFormat, 'html'>;
  scaling: DisplayCapabilities['scaling'];
  /** Canonical #RRGGBB letterbox/pillarbox background. */
  backgroundColor?: string;
  safeArea: DisplayCapabilities['safeArea'];
}

export interface SnapshotVersion {
  sourceId: string;
  revision: number;
  contentHash: string;
  connectorVersion?: string;
}

export const RENDER_MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg', bmp1: 'image/bmp' } as const;

function supportsPixels(target: Pick<RenderTarget, 'colorSpace' | 'bitDepth' | 'format'>): boolean {
  const { colorSpace, bitDepth, format } = target;
  if (format === 'bmp1') return colorSpace === 'monochrome' && bitDepth === 1;
  if (format === 'jpeg') return (colorSpace === 'rgb' && bitDepth === 24) || (colorSpace === 'grayscale' && bitDepth === 8);
  if (format !== 'png') return false;
  return (colorSpace === 'monochrome' && bitDepth === 1) ||
    (colorSpace === 'grayscale' && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorSpace === 'rgb' && [8, 16, 24].includes(bitDepth));
}

export function validateRenderTarget(target: RenderTarget): void {
  const invalid = () => { throw new NotAcceptableException('Unsupported render target'); };
  if (!target || typeof target.profileId !== 'string' || !target.profileId.length || target.profileId.length > 200 ||
    !Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height) || target.width < 1 || target.height < 1 ||
    target.width * target.height > MAX_RENDER_PIXELS || ![0, 90, 180, 270].includes(target.rotation) ||
    !['none', 'contain', 'cover'].includes(target.scaling) || !supportsPixels(target) || !target.safeArea ||
    (target.backgroundColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(target.backgroundColor))) return invalid();
  const { top, right, bottom, left } = target.safeArea;
  if ([top, right, bottom, left].some(value => !Number.isSafeInteger(value) || value < 0) ||
    top + bottom >= target.height || left + right >= target.width) return invalid();
}

/** Delivery policy, device identity and telemetry are intentionally not inputs. */
export function targetFor(configuration: Pick<ResolvedDeviceConfiguration, 'profile' | 'capabilities'>): RenderTarget {
  const { capabilities, profile } = configuration;
  if (profile.profileId !== capabilities.profileId) throw new NotAcceptableException('Render profile mismatch');
  const { width, height, colorSpace, bitDepth, rotation, scaling, safeArea } = capabilities.display;
  const backgroundColor = capabilities.display.backgroundColor ?? '#ffffff';
  for (const format of capabilities.display.renderFormats) {
    if (format === 'html' || !capabilities.display.mimeTypes.includes(RENDER_MIME_TYPES[format])) continue;
    if (!supportsPixels({ format, colorSpace, bitDepth })) continue;
    const target = { profileId: profile.profileId, width, height, colorSpace, bitDepth, rotation, format, scaling, backgroundColor, safeArea: { ...safeArea } };
    validateRenderTarget(target);
    return target;
  }
  throw new NotAcceptableException('No compatible snapshot render format');
}

/** Explicit projection prevents accidental invalidation by device, policy or timestamps. */
export function renderKey(
  revision: PublicationRevision,
  target: RenderTarget,
  snapshotVersions?: readonly SnapshotVersion[],
  rendererVersion = RENDERER_VERSION,
): string {
  validateRenderTarget(target);
  const content = revision.content;
  const reference = content && typeof content === 'object' && !Array.isArray(content) ? content.sourceSnapshot : undefined;
  let pinned: SnapshotVersion[] = [];
  if (reference !== undefined) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || typeof reference.sourceId !== 'string' || typeof reference.snapshotId !== 'string'
      || typeof reference.connectorVersion !== 'string' || typeof reference.contentHash !== 'string'
      || !Number.isSafeInteger(reference.revision)) throw new Error('Invalid pinned source snapshot');
    pinned = [{ sourceId: reference.sourceId, revision: Number(reference.revision), contentHash: reference.contentHash, connectorVersion: reference.connectorVersion }];
  }
  const snapshots = (snapshotVersions ?? pinned).map(({ sourceId, revision, contentHash, connectorVersion }) => {
    if (!sourceId || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error('Invalid snapshot render version');
    }
    return { sourceId, revision, contentHash, ...(connectorVersion === undefined ? {} : { connectorVersion }) };
  }).sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (new Set(snapshots.map(snapshot => snapshot.sourceId)).size !== snapshots.length) throw new Error('Duplicate snapshot source');
  const { profileId, width, height, colorSpace, bitDepth, rotation, format, scaling } = target;
  const backgroundColor = target.backgroundColor ?? '#ffffff';
  const { top, right, bottom, left } = target.safeArea;
  return sha256(canonicalJson({
    rendererVersion,
    publication: {
      publicationId: revision.publicationId,
      publicationRevisionId: revision.publicationRevisionId,
      revision: revision.revision,
      protocolVersion: revision.protocolVersion,
      contentHash: revision.contentHash,
    },
    target: { profileId, width, height, colorSpace, bitDepth, rotation, format, scaling, backgroundColor, safeArea: { top, right, bottom, left } },
    snapshots,
  }));
}
