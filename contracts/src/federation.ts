import type { DisplayCapabilities, RenderFormat } from './device';
import { utf8ByteLength } from './json-value';
import { assessProtocolVersion, type ProtocolVersion } from './protocol';
import type { ParseResult, ValidationIssue } from './validation';

export const FEDERATION_LIMITS = Object.freeze({
  manifestBytes: 65_536,
  artifactBytes: 2_097_152,
  artifacts: 8,
  totalArtifactBytes: 8_388_608,
  maxDimension: 8_192,
  maxPixels: 16_777_216,
  maxRevision: 2_147_483_647,
} as const);

export interface FederationCapabilities {
  protocolVersion: ProtocolVersion;
  serverId: string;
  readOnly: true;
  features: ['publication-feed', 'immutable-artifacts'];
  limits: { manifestBytes: 65_536; artifactBytes: 2_097_152; artifacts: 8 };
}

export interface FederationArtifact {
  artifactId: string;
  sha256: string;
  mimeType: 'image/png' | 'image/bmp';
  format: Extract<RenderFormat, 'png' | 'bmp1'>;
  width: number;
  height: number;
  colorSpace: DisplayCapabilities['colorSpace'];
  /** Panel precision, consistent with local render targets (RGB16 means RGB565). */
  bitDepth: number;
  rotation: DisplayCapabilities['rotation'];
  sizeBytes: number;
  url: string;
}

export interface FederationPublicationFeed {
  protocolVersion: ProtocolVersion;
  serverId: string;
  publicationId: string;
  publicationRevisionId: string;
  revision: number;
  publishedAt: string;
  artifacts: FederationArtifact[];
}

type RecordValue = Record<string, unknown>;
const features = ['publication-feed', 'immutable-artifacts'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9-]{1,100}$/;
const hash = /^[a-f0-9]{64}$/;

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid federation metadata');
}

/**
 * Copy descriptor values before any validation/serialization; never return caller objects.
 * This browser boundary does not promise trap-free Proxy detection. Server callers must
 * reject executable objects before parsing. Unknown minor extensions count toward limits.
 */
function detachedJson(input: unknown): unknown {
  let nodes = 0, characters = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    requireValid(++nodes <= 4_096 && depth <= 8);
    if (typeof value === 'string') {
      characters += value.length;
      requireValid(characters <= FEDERATION_LIMITS.manifestBytes);
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { requireValid(Number.isFinite(value)); return value; }
    requireValid(typeof value === 'object' && value !== null && !ancestors.has(value));
    ancestors.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    requireValid(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(value);
    let copy: unknown;
    if (array) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      requireValid(typeof length === 'number' && Number.isInteger(length) && length >= 0 && length <= 128
        && keys.length === length + 1);
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        requireValid(descriptor?.enumerable && 'value' in descriptor);
        result.push(visit(descriptor.value, depth + 1));
      }
      copy = result;
    } else {
      requireValid(keys.length <= 64);
      const result: RecordValue = Object.create(null) as RecordValue;
      for (const key of keys) {
        requireValid(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key));
        characters += key.length;
        requireValid(characters <= FEDERATION_LIMITS.manifestBytes);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValid(descriptor?.enumerable && 'value' in descriptor);
        result[key] = visit(descriptor.value, depth + 1);
      }
      copy = result;
    }
    ancestors.delete(value);
    return copy;
  }
  const copy = visit(input, 0);
  requireValid(utf8ByteLength(JSON.stringify(copy)) <= FEDERATION_LIMITS.manifestBytes);
  return copy;
}

function record(value: unknown): RecordValue {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}

function fields(value: RecordValue, expected: readonly string[], future: boolean): void {
  requireValid(expected.every(key => Object.hasOwn(value, key)));
  if (!future) requireValid(Object.keys(value).every(key => expected.includes(key)));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch >= 0 && new Date(epoch).toISOString() === value;
}

function version(value: unknown): { protocolVersion: ProtocolVersion; future: boolean; warnings: ValidationIssue[] } {
  requireValid(typeof value === 'string' && value.length <= 24
    && value.split('.').every(part => Number.isSafeInteger(Number(part))));
  const result = assessProtocolVersion(value);
  requireValid(result.version && (result.status === 'supported' || result.status === 'unknown-compatible'));
  const future = result.status === 'unknown-compatible';
  return {
    protocolVersion: result.version,
    future,
    warnings: future ? [{ code: 'protocol_unknown_minor', path: '$.protocolVersion', severity: 'warning',
      message: 'Compatible newer protocol minor; unknown fields and features were omitted.' }] : [],
  };
}

function invalid<T>(kind: 'capabilities' | 'feed'): ParseResult<T> {
  return { success: false, errors: [{ code: `invalid_federation_${kind}`, path: '$', severity: 'error',
    message: 'Invalid bounded federation metadata.' }], warnings: [] };
}

export function parseFederationCapabilities(input: unknown): ParseResult<FederationCapabilities> {
  try {
    const value = record(detachedJson(input));
    const { protocolVersion, future, warnings } = version(value.protocolVersion);
    fields(value, ['protocolVersion', 'serverId', 'readOnly', 'features', 'limits'], future);
    requireValid(matches(value.serverId, uuid) && value.readOnly === true && Array.isArray(value.features));
    requireValid(value.features.every(feature => typeof feature === 'string')
      && new Set(value.features).size === value.features.length
      && features.every(feature => (value.features as unknown[]).includes(feature)));
    if (!future) requireValid(value.features.length === features.length);
    const limits = record(value.limits);
    fields(limits, ['manifestBytes', 'artifactBytes', 'artifacts'], future);
    requireValid(limits.manifestBytes === FEDERATION_LIMITS.manifestBytes
      && limits.artifactBytes === FEDERATION_LIMITS.artifactBytes && limits.artifacts === FEDERATION_LIMITS.artifacts);
    return { success: true, data: { protocolVersion, serverId: value.serverId, readOnly: true,
      features: [...features], limits: { manifestBytes: FEDERATION_LIMITS.manifestBytes,
        artifactBytes: FEDERATION_LIMITS.artifactBytes, artifacts: FEDERATION_LIMITS.artifacts } }, warnings };
  } catch { return invalid('capabilities'); }
}

function artifact(input: unknown, publicationId: string, revision: number, future: boolean): FederationArtifact {
  const value = record(input);
  fields(value, ['artifactId', 'sha256', 'mimeType', 'format', 'width', 'height', 'colorSpace',
    'bitDepth', 'rotation', 'sizeBytes', 'url'], future);
  requireValid(matches(value.sha256, hash) && value.artifactId === value.sha256);
  requireValid(integer(value.width, 1, FEDERATION_LIMITS.maxDimension)
    && integer(value.height, 1, FEDERATION_LIMITS.maxDimension)
    && value.width * value.height <= FEDERATION_LIMITS.maxPixels);
  requireValid(integer(value.sizeBytes, 1, FEDERATION_LIMITS.artifactBytes));
  requireValid(value.rotation === 0 || value.rotation === 90 || value.rotation === 180 || value.rotation === 270);
  requireValid(integer(value.bitDepth, 1, 24));
  const mono = value.colorSpace === 'monochrome' && value.bitDepth === 1;
  const gray = value.colorSpace === 'grayscale' && [1, 2, 4, 8].includes(value.bitDepth);
  const rgb = value.colorSpace === 'rgb' && [8, 16, 24].includes(value.bitDepth);
  requireValid((value.format === 'bmp1' && value.mimeType === 'image/bmp' && mono)
    || (value.format === 'png' && value.mimeType === 'image/png' && (mono || gray || rgb)));
  requireValid(value.url === `/api/federation/v1/publications/${publicationId}/revisions/${revision}/artifacts/${value.sha256}`);
  return {
    artifactId: value.sha256, sha256: value.sha256,
    mimeType: value.mimeType as FederationArtifact['mimeType'], format: value.format as FederationArtifact['format'],
    width: value.width, height: value.height, colorSpace: value.colorSpace as FederationArtifact['colorSpace'],
    bitDepth: value.bitDepth, rotation: value.rotation, sizeBytes: value.sizeBytes, url: value.url as string,
  };
}

export function parseFederationPublicationFeed(input: unknown): ParseResult<FederationPublicationFeed> {
  try {
    const value = record(detachedJson(input));
    const { protocolVersion, future, warnings } = version(value.protocolVersion);
    fields(value, ['protocolVersion', 'serverId', 'publicationId', 'publicationRevisionId', 'revision',
      'publishedAt', 'artifacts'], future);
    requireValid(matches(value.serverId, uuid) && matches(value.publicationId, identifier)
      && matches(value.publicationRevisionId, identifier) && integer(value.revision, 1, FEDERATION_LIMITS.maxRevision)
      && canonicalTime(value.publishedAt));
    requireValid(Array.isArray(value.artifacts) && value.artifacts.length >= 1
      && value.artifacts.length <= FEDERATION_LIMITS.artifacts);
    const artifacts = value.artifacts.map(entry => artifact(entry, value.publicationId as string, value.revision as number, future));
    requireValid(new Set(artifacts.map(entry => entry.artifactId)).size === artifacts.length
      && artifacts.reduce((total, entry) => total + entry.sizeBytes, 0) <= FEDERATION_LIMITS.totalArtifactBytes);
    return { success: true, data: { protocolVersion, serverId: value.serverId, publicationId: value.publicationId,
      publicationRevisionId: value.publicationRevisionId, revision: value.revision, publishedAt: value.publishedAt,
      artifacts }, warnings };
  } catch { return invalid('feed'); }
}
