import { isJsonValue, type JsonObject, type JsonValue } from './json-value';
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
  return parseContract(value, validateInteractionEvent);
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
