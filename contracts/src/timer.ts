import { addIssue, parseContract, type ParseResult, type ValidationContext } from './validation';

export const TIMER_LIMITS = Object.freeze({
  durationMinMs: 1000,
  durationMaxMs: 604_800_000,
  maxVersion: 2_147_483_647,
  activePerDevice: 32,
  activeGlobal: 100,
  maxRows: 100,
});

export type TimerVisibility = 'private' | 'shared';
export type TimerStatus = 'running' | 'paused' | 'completed' | 'cancelled';

export interface TimerCreatePayload {
  version: 1;
  durationMs: number;
  visibility: TimerVisibility;
}

export interface TimerMutationPayload {
  version: 1;
  timerId: string;
  expectedVersion: number;
}

export interface TimerSnapshot {
  timerId: string;
  version: number;
  creatorDeviceId: string;
  visibility: TimerVisibility;
  status: TimerStatus;
  durationMs: number;
  startedAt: string;
  endsAt: string | null;
  pausedRemainingMs: number | null;
  /** Last persisted domain evaluation, not the current server time of a read. */
  evaluatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByDeviceId: string | null;
}

const createFields = ['version', 'durationMs', 'visibility'] as const;
const mutationFields = ['version', 'timerId', 'expectedVersion'] as const;
const snapshotFields = ['timerId', 'version', 'creatorDeviceId', 'visibility', 'status', 'durationMs',
  'startedAt', 'endsAt', 'pausedRemainingMs', 'evaluatedAt', 'completedAt', 'cancelledAt',
  'acknowledgedAt', 'acknowledgedByDeviceId'] as const;

type ErrorCode = 'invalid_timer_payload' | 'invalid_timer_snapshot';
function issue(context: ValidationContext, code: ErrorCode, path: string): false {
  addIssue(context, 'error', code, path, 'Expected bounded timer metadata with a valid state.');
  return false;
}

/**
 * Flat, detached JSON projection. Never read values via property access on the
 * caller's object or retain its references. Browser contracts cannot detect all
 * proxies without executing descriptor traps; server callers reject them first.
 */
function detached(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const fail = (): never => { throw new Error('INVALID_TIMER_METADATA'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    const item: unknown = descriptor.value;
    if (item !== null && typeof item !== 'number' && typeof item !== 'string') return fail();
    // Every accepted string is an identifier (<=128) or a fixed ISO timestamp.
    if (typeof item === 'string' && item.length > 128) return fail();
    result[key] = item;
  }
  return result;
}

function parse<T>(value: unknown, fields: readonly string[], code: ErrorCode,
  validate: (record: Record<string, unknown>, context: ValidationContext, path: string) => boolean): ParseResult<T> {
  try {
    return parseContract<T>(detached(value, fields), (input, context, path): input is T =>
      validate(input as Record<string, unknown>, context, path));
  } catch {
    const context: ValidationContext = { errors: [], warnings: [] };
    issue(context, code, '$');
    return { success: false, errors: context.errors, warnings: context.warnings };
  }
}

const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
const duration = (value: unknown): value is number => integer(value, TIMER_LIMITS.durationMinMs, TIMER_LIMITS.durationMaxMs);
const version = (value: unknown): value is number => integer(value, 1, TIMER_LIMITS.maxVersion);
const visibility = (value: unknown): value is TimerVisibility => value === 'private' || value === 'shared';
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const deviceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() >= 0 && parsed.toISOString() === value;
};

export function parseTimerCreatePayload(value: unknown): ParseResult<TimerCreatePayload> {
  return parse(value, createFields, 'invalid_timer_payload', (record, context, path) => {
    if (record.version !== 1) return issue(context, 'invalid_timer_payload', `${path}.version`);
    if (!duration(record.durationMs)) return issue(context, 'invalid_timer_payload', `${path}.durationMs`);
    return visibility(record.visibility) || issue(context, 'invalid_timer_payload', `${path}.visibility`);
  });
}

export function parseTimerMutationPayload(value: unknown): ParseResult<TimerMutationPayload> {
  return parse(value, mutationFields, 'invalid_timer_payload', (record, context, path) => {
    if (record.version !== 1) return issue(context, 'invalid_timer_payload', `${path}.version`);
    if (!uuid(record.timerId)) return issue(context, 'invalid_timer_payload', `${path}.timerId`);
    return version(record.expectedVersion) || issue(context, 'invalid_timer_payload', `${path}.expectedVersion`);
  });
}

export function parseTimerSnapshot(value: unknown): ParseResult<TimerSnapshot> {
  return parse(value, snapshotFields, 'invalid_timer_snapshot', (record, context, path) => {
    const invalid = (field?: string) => issue(context, 'invalid_timer_snapshot', field ? `${path}.${field}` : path);
    if (!uuid(record.timerId)) return invalid('timerId');
    if (!version(record.version)) return invalid('version');
    if (!deviceId(record.creatorDeviceId)) return invalid('creatorDeviceId');
    if (!visibility(record.visibility)) return invalid('visibility');
    if (!duration(record.durationMs)) return invalid('durationMs');
    if (!timestamp(record.startedAt)) return invalid('startedAt');
    if (!timestamp(record.evaluatedAt)) return invalid('evaluatedAt');
    for (const key of ['endsAt', 'completedAt', 'cancelledAt', 'acknowledgedAt'] as const) {
      if (record[key] !== null && !timestamp(record[key])) return invalid(key);
    }
    if (record.pausedRemainingMs !== null && !integer(record.pausedRemainingMs, 1, record.durationMs)) return invalid('pausedRemainingMs');
    if (record.acknowledgedByDeviceId !== null && !deviceId(record.acknowledgedByDeviceId)) return invalid('acknowledgedByDeviceId');
    const snapshot = record as unknown as TimerSnapshot;
    // All timestamp strings are canonical UTC values and can be ordered directly.
    if (snapshot.startedAt > snapshot.evaluatedAt) return invalid();
    if ((snapshot.acknowledgedAt === null) !== (snapshot.acknowledgedByDeviceId === null)) return invalid();
    for (const at of [snapshot.completedAt, snapshot.cancelledAt, snapshot.acknowledgedAt]) {
      if (at !== null && (at < snapshot.startedAt || at > snapshot.evaluatedAt)) return invalid();
    }
    const noAcknowledgement = snapshot.acknowledgedAt === null;
    switch (snapshot.status) {
      case 'running':
        return (snapshot.endsAt !== null && snapshot.endsAt > snapshot.evaluatedAt
          && Date.parse(snapshot.endsAt) - Date.parse(snapshot.evaluatedAt) <= snapshot.durationMs
          && snapshot.pausedRemainingMs === null && snapshot.completedAt === null
          && snapshot.cancelledAt === null && noAcknowledgement) || invalid();
      case 'paused':
        return (snapshot.endsAt === null && snapshot.pausedRemainingMs !== null
          && snapshot.completedAt === null && snapshot.cancelledAt === null && noAcknowledgement) || invalid();
      case 'completed':
        return (snapshot.endsAt !== null && snapshot.completedAt === snapshot.endsAt
          && snapshot.endsAt > snapshot.startedAt
          && snapshot.pausedRemainingMs === null && snapshot.cancelledAt === null
          && (noAcknowledgement || snapshot.acknowledgedAt! >= snapshot.completedAt)) || invalid();
      case 'cancelled':
        return (snapshot.endsAt === null && snapshot.pausedRemainingMs === null
          && snapshot.cancelledAt !== null && snapshot.completedAt === null && noAcknowledgement) || invalid();
      default: return invalid('status');
    }
  });
}
