import { isJsonValue, utf8ByteLength, type JsonObject, type JsonValue } from './json-value';
import { validateProtocolVersion, type ProtocolVersion } from './protocol';
import {
  addIssue,
  asRecord,
  optionalInteger,
  optionalString,
  parseContract,
  requiredBoolean,
  requiredEnum,
  requiredString,
  validateIsoTimestamp,
  type ParseResult,
  type ValidationContext,
} from './validation';

export interface InteractionEvent {
  protocolVersion: ProtocolVersion;
  eventId: string;
  deviceId: string;
  credentialId: string;
  publicationId: string;
  revision: string;
  action: string;
  targetId?: string;
  payload: JsonObject;
  occurredAt: string;
  clientSequence?: number;
}

export const INTERACTION_LIMITS = Object.freeze({
  messageBytes: 8192, payloadBytes: 4096, payloadDepth: 8,
  maxAgeMs: 300_000, maxFutureMs: 30_000, perMinute: 60, perSecond: 8,
  maxClientSequence: 2_147_483_647,
});

export interface CommandError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CommandResult {
  protocolVersion: ProtocolVersion;
  commandId: string;
  eventId: string;
  status: 'accepted' | 'completed' | 'rejected' | 'duplicate';
  serverTime: string;
  stateRevision?: string;
  result?: JsonValue;
  error?: CommandError;
}

export function parseInteractionEvent(value: unknown): ParseResult<InteractionEvent> {
  const parsed = parseContract(value, validateInteractionEvent);
  if (!parsed.success) return parsed;
  const event = parsed.data;
  // Forward-compatible minor metadata is never retained as command input/audit.
  return { ...parsed, data: {
    protocolVersion: event.protocolVersion, eventId: event.eventId, deviceId: event.deviceId,
    credentialId: event.credentialId, publicationId: event.publicationId, revision: event.revision,
    action: event.action, ...(event.targetId === undefined ? {} : { targetId: event.targetId }),
    payload: event.payload, occurredAt: event.occurredAt,
    ...(event.clientSequence === undefined ? {} : { clientSequence: event.clientSequence }),
  } };
}

export function parseCommandResult(value: unknown): ParseResult<CommandResult> {
  return parseContract(value, validateCommandResult);
}

function validateInteractionEvent(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is InteractionEvent {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'eventId', context, path);
  requiredString(record, 'deviceId', context, path);
  requiredString(record, 'credentialId', context, path);
  requiredString(record, 'publicationId', context, path);
  requiredString(record, 'revision', context, path);
  requiredString(record, 'action', context, path);
  optionalString(record, 'targetId', context, path);
  if (!isJsonObject(record.payload)) {
    addIssue(context, 'error', 'invalid_json_object', `${path}.payload`, 'Interaction payload must be a JSON-compatible object.');
  }
  validateIsoTimestamp(record, 'occurredAt', context, path);
  optionalInteger(record, 'clientSequence', context, path, { minimum: 0 });
  for (const key of ['eventId', 'deviceId', 'credentialId', 'publicationId', 'targetId']) {
    const text = record[key];
    if (text !== undefined && (typeof text !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text))) {
      addIssue(context, 'error', 'invalid_identifier', `${path}.${key}`, 'Expected a bounded identifier.');
    }
  }
  if (typeof record.action !== 'string' || record.action.length > 64 || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(record.action)) {
    addIssue(context, 'error', 'invalid_action', `${path}.action`, 'Expected a bounded dotted action.');
  }
  if (typeof record.revision !== 'string' || record.revision.length > 128) {
    addIssue(context, 'error', 'invalid_revision', `${path}.revision`, 'Expected a bounded revision.');
  }
  if (record.clientSequence !== undefined && (!Number.isSafeInteger(record.clientSequence) || Number(record.clientSequence) > INTERACTION_LIMITS.maxClientSequence)) {
    addIssue(context, 'error', 'invalid_sequence', `${path}.clientSequence`, 'Sequence is outside the supported range.');
  }
  const bounded = (input: JsonValue, depth: number): boolean => {
    if (input === null || typeof input !== 'object') return true;
    if (depth >= INTERACTION_LIMITS.payloadDepth) return false;
    return Object.values(input).every(item => bounded(item, depth + 1));
  };
  if (isJsonObject(record.payload) && (!bounded(record.payload, 0)
    || utf8ByteLength(JSON.stringify(record.payload)) > INTERACTION_LIMITS.payloadBytes)) {
    addIssue(context, 'error', 'payload_limit', `${path}.payload`, 'Payload exceeds the depth or byte limit.');
  }
  return context.errors.length === 0;
}

function validateCommandResult(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is CommandResult {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'commandId', context, path);
  requiredString(record, 'eventId', context, path);
  const status = requiredEnum(record, 'status', ['accepted', 'completed', 'rejected', 'duplicate'] as const, context, path);
  validateIsoTimestamp(record, 'serverTime', context, path);
  optionalString(record, 'stateRevision', context, path);
  if (record.result !== undefined && !isJsonValue(record.result)) {
    addIssue(context, 'error', 'invalid_json_value', `${path}.result`, 'Command result must be JSON-compatible.');
  }
  if (record.error !== undefined) {
    validateCommandError(record.error, context, `${path}.error`);
  } else if (status === 'rejected') {
    addIssue(context, 'error', 'command_error_required', `${path}.error`, 'Rejected commands require an error descriptor.');
  }
  return context.errors.length === 0;
}

function validateCommandError(value: unknown, context: ValidationContext, path: string): value is CommandError {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredString(record, 'code', context, path);
  requiredString(record, 'message', context, path);
  requiredBoolean(record, 'retryable', context, path);
  return context.errors.length === 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value);
}
