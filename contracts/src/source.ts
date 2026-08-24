import { isJsonValue, type JsonValue } from './json-value';
import { validateProtocolVersion, type ProtocolVersion } from './protocol';
import {
  addIssue,
  asRecord,
  optionalString,
  parseContract,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
  validateIsoTimestamp,
  type ParseResult,
  type ValidationContext,
} from './validation';

export interface SnapshotError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SourceSnapshot {
  protocolVersion: ProtocolVersion;
  snapshotId: string;
  sourceDefinitionId: string;
  schemaVersion: string;
  connectorVersion: string;
  createdAt: string;
  sourceTimestamp?: string;
  freshness: {
    state: 'fresh' | 'stale' | 'error';
    staleAfterSeconds?: number;
  };
  data: JsonValue;
  error?: SnapshotError;
}

export function parseSourceSnapshot(value: unknown): ParseResult<SourceSnapshot> {
  return parseContract(value, validateSourceSnapshot);
}

function validateSourceSnapshot(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is SourceSnapshot {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'snapshotId', context, path);
  requiredString(record, 'sourceDefinitionId', context, path);
  requiredString(record, 'schemaVersion', context, path);
  requiredString(record, 'connectorVersion', context, path);
  validateIsoTimestamp(record, 'createdAt', context, path);
  validateIsoTimestamp(record, 'sourceTimestamp', context, path, true);
  const freshnessState = validateFreshness(record.freshness, context, `${path}.freshness`);
  if (!isJsonValue(record.data)) {
    addIssue(context, 'error', 'invalid_json_value', `${path}.data`, 'Snapshot data must be JSON-compatible.');
  }
  if (record.error !== undefined) {
    validateSnapshotError(record.error, context, `${path}.error`);
  } else if (freshnessState === 'error') {
    addIssue(context, 'error', 'snapshot_error_required', `${path}.error`, 'Error freshness requires an error descriptor.');
  }
  return context.errors.length === 0;
}

function validateFreshness(
  value: unknown,
  context: ValidationContext,
  path: string,
): SourceSnapshot['freshness']['state'] | undefined {
  const record = asRecord(value, context, path);
  if (!record) return undefined;
  const state = requiredEnum(record, 'state', ['fresh', 'stale', 'error'] as const, context, path);
  if (record.staleAfterSeconds !== undefined) {
    requiredInteger(record, 'staleAfterSeconds', context, path, { minimum: 1 });
  }
  return state;
}

function validateSnapshotError(value: unknown, context: ValidationContext, path: string): value is SnapshotError {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredString(record, 'code', context, path);
  requiredString(record, 'message', context, path);
  requiredBoolean(record, 'retryable', context, path);
  return context.errors.length === 0;
}
