import { isJsonValue, type JsonObject } from './json-value';
import { parseTimerFeed, type TimerFeed } from './timer-feed';
import { validateProtocolVersion, type ProtocolVersion } from './protocol';
import {
  addIssue,
  asRecord,
  optionalString,
  parseContract,
  requiredEnum,
  requiredInteger,
  requiredString,
  validateIsoTimestamp,
  type ParseResult,
  type ValidationContext,
} from './validation';

export interface PresentationArtifact {
  artifactId: string;
  role: 'primary' | 'fallback' | 'asset';
  url: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
}

export interface AllowedAction {
  action: string;
  targetId?: string;
  payloadSchemaVersion: string;
}

export interface RefreshHints {
  notBefore?: string;
  refreshAfterSeconds?: number;
  nextTransitionAt?: string;
  expiresAt?: string;
}

export interface PresentationManifest {
  protocolVersion: ProtocolVersion;
  manifestId: string;
  publicationId: string;
  revision: string;
  profileId: string;
  variantId: string;
  generatedAt: string;
  artifacts: PresentationArtifact[];
  refresh: RefreshHints;
  allowedActions: AllowedAction[];
  fallbackRevision?: string;
  metadata?: JsonObject;
  timerState?: TimerFeed;
}

export function parsePresentationManifest(value: unknown): ParseResult<PresentationManifest> {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'timerState') : undefined;
    if (value && typeof value === 'object' && 'timerState' in value && !descriptor) throw new Error();
    if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) throw new Error();
    const feed = descriptor?.value === undefined ? undefined : parseTimerFeed(descriptor.value);
    if (feed && !feed.success) throw new Error();
    const parsed = parseContract(value, validatePresentationManifest);
    if (!parsed.success || !feed?.success) return parsed;
    return { ...parsed, data: { ...parsed.data, timerState: feed.data } };
  } catch {
    return { success: false, errors: [{ code: 'invalid_timer_feed', path: '$.timerState', severity: 'error', message: 'Invalid bounded timer feed.' }], warnings: [] };
  }
}

function validatePresentationManifest(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is PresentationManifest {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'manifestId', context, path);
  requiredString(record, 'publicationId', context, path);
  requiredString(record, 'revision', context, path);
  requiredString(record, 'profileId', context, path);
  requiredString(record, 'variantId', context, path);
  validateIsoTimestamp(record, 'generatedAt', context, path);
  validateArtifacts(record.artifacts, context, `${path}.artifacts`);
  validateRefreshHints(record.refresh, context, `${path}.refresh`);
  validateAllowedActions(record.allowedActions, context, `${path}.allowedActions`);
  optionalString(record, 'fallbackRevision', context, path);
  if (record.metadata !== undefined && (!isJsonValue(record.metadata) || Array.isArray(record.metadata) || record.metadata === null || typeof record.metadata !== 'object')) {
    addIssue(context, 'error', 'invalid_json_object', `${path}.metadata`, 'Metadata must be a JSON-compatible object.');
  }
  return context.errors.length === 0;
}

function validateArtifacts(value: unknown, context: ValidationContext, path: string): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(context, 'error', 'artifacts_required', path, 'Manifest requires at least one artifact.');
    return false;
  }
  value.forEach((item, index) => validateArtifact(item, context, `${path}[${index}]`));
  return context.errors.length === 0;
}

function validateArtifact(value: unknown, context: ValidationContext, path: string): value is PresentationArtifact {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredString(record, 'artifactId', context, path);
  requiredEnum(record, 'role', ['primary', 'fallback', 'asset'] as const, context, path);
  requiredString(record, 'url', context, path);
  requiredString(record, 'mimeType', context, path);
  requiredInteger(record, 'sizeBytes', context, path, { minimum: 0 });
  const hash = requiredString(record, 'sha256', context, path);
  if (hash !== undefined && !/^[a-f0-9]{64}$/i.test(hash)) {
    addIssue(context, 'error', 'invalid_sha256', `${path}.sha256`, 'Expected a 64-character hexadecimal SHA-256 digest.');
  }
  requiredString(record, 'etag', context, path);
  return context.errors.length === 0;
}

function validateRefreshHints(value: unknown, context: ValidationContext, path: string): value is RefreshHints {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateIsoTimestamp(record, 'notBefore', context, path, true);
  validateIsoTimestamp(record, 'nextTransitionAt', context, path, true);
  validateIsoTimestamp(record, 'expiresAt', context, path, true);
  if (record.refreshAfterSeconds !== undefined) {
    requiredInteger(record, 'refreshAfterSeconds', context, path, { minimum: 1 });
  }
  return context.errors.length === 0;
}

function validateAllowedActions(value: unknown, context: ValidationContext, path: string): boolean {
  if (!Array.isArray(value)) {
    addIssue(context, 'error', 'expected_array', path, 'Expected an array of allowed actions.');
    return false;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item, context, itemPath);
    if (!record) return;
    requiredString(record, 'action', context, itemPath);
    optionalString(record, 'targetId', context, itemPath);
    requiredString(record, 'payloadSchemaVersion', context, itemPath);
  });
  return context.errors.length === 0;
}
