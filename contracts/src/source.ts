import { isJsonValue, type JsonObject, type JsonValue } from './json-value';
import { validateProtocolVersion, type ProtocolVersion } from './protocol';
import {
  addIssue,
  asRecord,
  parseContract,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
  validateIsoTimestamp,
  type ParseResult,
  type ValidationContext,
} from './validation';

/** Public definition metadata. Secret values never belong in this contract. */
export interface SourceDefinition {
  protocolVersion: ProtocolVersion;
  sourceDefinitionId: string;
  /** Monotonic persisted revision used for optimistic concurrency checks. */
  definitionVersion: number;
  name: string;
  connectorType: string;
  schemaVersion: string;
  configuration: JsonObject;
  /** Optional pure JavaScript transformation; executed without connector secrets. */
  transformationCode?: string | null;
  /** Connector input names mapped to opaque IDs in the worker's secret store. */
  secretReferences: Record<string, string>;
  refreshIntervalSeconds: number;
  timeoutMs: number;
  concurrencyGroup: string;
}

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

export function parseSourceDefinition(value: unknown): ParseResult<SourceDefinition> {
  return parseContract(value, validateSourceDefinition);
}

export function parseSourceSnapshot(value: unknown): ParseResult<SourceSnapshot> {
  return parseContract(value, validateSourceSnapshot);
}

function validateSourceDefinition(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is SourceDefinition {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  validateIdentifier(record.sourceDefinitionId, context, `${path}.sourceDefinitionId`);
  requiredInteger(record, 'definitionVersion', context, path, {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  requiredString(record, 'name', context, path);
  requiredString(record, 'connectorType', context, path);
  requiredString(record, 'schemaVersion', context, path);
  if (record.transformationCode !== undefined && record.transformationCode !== null
    && (typeof record.transformationCode !== 'string' || record.transformationCode.length > 10_000)) {
    addIssue(context, 'error', 'invalid_transformation', path + '.transformationCode', 'Transformation must be null or JavaScript source of at most 10000 characters.');
  }
  if (
    !isJsonValue(record.configuration) ||
    record.configuration === null ||
    typeof record.configuration !== 'object' ||
    Array.isArray(record.configuration)
  ) {
    addIssue(context, 'error', 'invalid_json_object', `${path}.configuration`, 'Configuration must be a JSON object.');
  }
  const references = asRecord(record.secretReferences, context, `${path}.secretReferences`);
  if (references) {
    if (!isJsonValue(references)) {
      addIssue(context, 'error', 'invalid_json_object', `${path}.secretReferences`, 'Secret references must be a JSON object.');
    } else {
      for (const [name, reference] of Object.entries(references)) {
        // Do not include a submitted key/value in diagnostics: a caller may
        // accidentally submit a credential where an opaque ID is required.
        validateIdentifier(name, context, `${path}.secretReferences`);
        validateIdentifier(reference, context, `${path}.secretReferences`);
      }
    }
  }
  requiredInteger(record, 'refreshIntervalSeconds', context, path, { minimum: 1, maximum: 86400 });
  requiredInteger(record, 'timeoutMs', context, path, { minimum: 50, maximum: 7500 });
  validateIdentifier(record.concurrencyGroup, context, `${path}.concurrencyGroup`);
  return context.errors.length === 0;
}

function validateIdentifier(value: unknown, context: ValidationContext, path: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    addIssue(context, 'error', 'invalid_identifier', path, 'Expected an identifier of 1 to 128 ASCII letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit.');
  }
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
