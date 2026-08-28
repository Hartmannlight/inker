import { DELIVERY_MODES, type DeliveryMode } from './device';
import { utf8ByteLength, type JsonValue } from './json-value';
import { addIssue, parseContract, type ParseResult, type ValidationContext } from './validation';
import { REMOTE_ERROR_CODES, REMOTE_SUBSCRIPTION_LIMITS, type RemoteErrorCode, type RemoteSubscriptionStatus } from './remote-subscription';

export const OPERATIONS_PROTOCOL_VERSION = '1.0' as const;
export const OPERATIONS_QUEUE_NAMES = Object.freeze(['source-refresh', 'render', 'delivery', 'timer', 'maintenance', 'remote-sync'] as const);
export type OperationsQueueName = typeof OPERATIONS_QUEUE_NAMES[number];
export const OPERATIONS_LIMITS = Object.freeze({ rows: 100, remoteRows: REMOTE_SUBSCRIPTION_LIMITS.maxRows, bytes: 256 * 1024, issues: 32,
  depth: 8, nodes: 8192, objectKeys: 32 });
export const OPERATIONS_REASONS = Object.freeze(['API_DATABASE_UNAVAILABLE', 'QUEUE_UNAVAILABLE', 'WORKER_UNAVAILABLE',
  'QUEUE_BACKLOG', 'DEAD_LETTERS', 'SOURCE_ERRORS', 'REMOTE_ERRORS', 'STALE_DEVICES', 'RENDER_ERRORS', 'METRICS_UNAVAILABLE'] as const);
export const OPERATIONS_ERROR_CODES = Object.freeze(['SOURCE_TIMEOUT', 'SOURCE_REFRESH_FAILED', 'SOURCE_TRANSFORM_FAILED',
  'SOURCE_ABORTED', 'SOURCE_SECRET_UNAVAILABLE', 'SOURCE_STALE_CLAIM', 'OUTBOX_INVALID_PAYLOAD', 'OUTBOX_TRANSPORT_FAILED',
  'OUTBOX_ATTEMPTS_EXHAUSTED', 'OUTBOX_ADAPTER_FAILED', 'OUTBOX_CLAIM_EXPIRED', 'RENDER_FAILED', 'RENDER_PIXELS_FAILED',
  'RENDER_VALIDATION_FAILED', 'RENDER_STORAGE_FAILED', 'RENDER_STALE_CLAIM', ...REMOTE_ERROR_CODES, 'UNKNOWN_FAILURE'] as const);
export type OperationsErrorCode = typeof OPERATIONS_ERROR_CODES[number];
export interface OperationsQueueStatus {
  queue: OperationsQueueName;
  sampledAt: string | null;
  pending: number | null;
  delayed: number | null;
  processing: number | null;
  deadLetters: number | null;
  expiredClaims: number | null;
  oldestDueAgeSeconds: number | null;
  oldestProcessingAgeSeconds: number | null;
}
export interface OperationsSourceActivity {
  sourceDefinitionId: string;
  connectorType: 'fixture' | 'slow' | 'failure';
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  freshness: 'fresh' | 'stale' | 'error' | 'missing';
  errorCode: OperationsErrorCode | null;
  circuitOpenUntil: string | null;
}
export interface OperationsDeviceActivity {
  deviceId: number;
  deliveryMode: DeliveryMode;
  enabled: boolean;
  connection: 'connected' | 'disconnected' | 'not-applicable' | 'unknown';
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  acknowledgedAt: string | null;
  ageSeconds: number | null;
  state: 'active' | 'stale' | 'unseen' | 'disabled';
  publicationState: 'current' | 'pending' | 'unassigned' | 'unknown';
}
export interface OperationsRemoteActivity {
  subscriptionId: string;
  enabled: boolean;
  status: RemoteSubscriptionStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string;
  ageSeconds: number | null;
  circuitOpenUntil: string | null;
  errorCode: RemoteErrorCode | 'UNKNOWN_FAILURE' | null;
}
export interface OperationsDeadLetter {
  eventId: string;
  correlationId: string | null;
  queue: OperationsQueueName;
  occurredAt: string;
  processedAt: string;
  attempts: number;
  errorCode: OperationsErrorCode;
}
export interface OperationsCollection<T> {
  sampledAt: string | null;
  total: number | null;
  items: T[];
  truncated: boolean;
}
/** Read-only metadata. No source data, configuration, raw errors, headers or secrets. */
export interface OperationsStatus {
  protocolVersion: '1.0';
  generatedAt: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  reasons: (typeof OPERATIONS_REASONS[number])[];
  health: {
    apiReady: boolean;
    database: 'ready' | 'unavailable';
    redis: 'ready' | 'unavailable';
    workers: { status: 'ready' | 'unavailable' | 'unknown'; count: number | null; sampledAt: string | null };
  };
  queues: OperationsQueueStatus[];
  renderCache: { sampledAt: string | null; hits: number | null; misses: number | null;
    fallbacks: number | null; rendered: number | null; failures: number | null };
  websocket: { sampledAt: string | null; authenticatedConnections: number | null; pendingConnections: number | null;
    livenessTimeouts: number | null; authRejected: number | null };
  sources: OperationsCollection<OperationsSourceActivity>;
  remotes: OperationsCollection<OperationsRemoteActivity>;
  devices: OperationsCollection<OperationsDeviceActivity>;
  deadLetters: OperationsCollection<OperationsDeadLetter>;
}

type Rule = (value: unknown, context: ValidationContext, path: string) => boolean;
function problem(context: ValidationContext, path: string): false {
  // Never put submitted values or unknown property names in diagnostics.
  if (context.errors.length < OPERATIONS_LIMITS.issues) addIssue(context, 'error', 'invalid_operations_status', path, 'Expected bounded operations metadata.');
  return false;
}
const predicate = (check: (value: unknown) => boolean): Rule => (value, context, path) => check(value) || problem(context, path);
const enumeration = (values: readonly unknown[]): Rule => predicate(value => values.includes(value));
const nullable = (rule: Rule): Rule => (value, context, path) => value === null || rule(value, context, path);
const count = predicate(value => Number.isSafeInteger(value) && Number(value) >= 0);
const positive = predicate(value => Number.isSafeInteger(value) && Number(value) > 0);
const seconds = predicate(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
const boolean = predicate(value => typeof value === 'boolean');
const identifier = predicate(value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value));
const uuid = predicate(value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value));
const timestamp = predicate(value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
function object(shape: Record<string, Rule>, invariant?: (record: Record<string, unknown>) => boolean): Rule {
  return (value, context, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return problem(context, path);
    const keys = Reflect.ownKeys(value), known = Object.keys(shape);
    if (keys.length !== known.length || keys.some(key => typeof key !== 'string' || !known.includes(key))) return problem(context, path);
    const record: Record<string, unknown> = {};
    for (const key of known) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return problem(context, path);
      record[key] = descriptor.value;
    }
    let valid = true;
    for (const key of known) if (!shape[key](record[key], context, `${path}.${key}`)) valid = false;
    return valid && (!invariant || invariant(record) || problem(context, path));
  };
}
function list(rule: Rule, maximum: number = OPERATIONS_LIMITS.rows, unique?: string): Rule {
  return (value, context, path) => {
    if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) return problem(context, path);
    const seen = new Set<unknown>();
    let valid = true;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return problem(context, path);
      const item: unknown = descriptor.value;
      if (!rule(item, context, `${path}[${index}]`)) { valid = false; continue; }
      const identity = unique ? (item as Record<string, unknown>)[unique] : item;
      if (seen.has(identity)) valid = problem(context, path);
      seen.add(identity);
    }
    return valid;
  };
}
const sampleInvariant = (fields: readonly string[]) => (record: Record<string, unknown>) => fields.every(key => (record[key] === null) === (record.sampledAt === null));
function sample(fields: Record<string, Rule>, extra: Record<string, Rule> = {}): Rule {
  return object({ ...extra, sampledAt: nullable(timestamp), ...Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, nullable(rule)])) }, sampleInvariant(Object.keys(fields)));
}
function collection(rule: Rule, key: string, maximum: number = OPERATIONS_LIMITS.rows): Rule {
  return object({ sampledAt: nullable(timestamp), total: nullable(count), items: list(rule, maximum, key), truncated: boolean }, record => {
    const length = (record.items as unknown[]).length;
    if (record.sampledAt === null) return record.total === null && length === 0 && record.truncated === false;
    return typeof record.total === 'number' && record.total >= length && record.truncated === (record.total > length);
  });
}
const queue = sample({ pending: count, delayed: count, processing: count, deadLetters: count, expiredClaims: count,
  oldestDueAgeSeconds: seconds, oldestProcessingAgeSeconds: seconds }, { queue: enumeration(OPERATIONS_QUEUE_NAMES) });
const source = object({ sourceDefinitionId: uuid, connectorType: enumeration(['fixture', 'slow', 'failure']), enabled: boolean,
  lastAttemptAt: nullable(timestamp), lastSuccessAt: nullable(timestamp), ageSeconds: nullable(seconds),
  freshness: enumeration(['fresh', 'stale', 'error', 'missing']), errorCode: nullable(enumeration(OPERATIONS_ERROR_CODES)), circuitOpenUntil: nullable(timestamp) },
  record => (record.lastSuccessAt === null) === (record.ageSeconds === null));
const device = object({ deviceId: positive, deliveryMode: enumeration(DELIVERY_MODES), enabled: boolean,
  connection: enumeration(['connected', 'disconnected', 'not-applicable', 'unknown']), lastSeenAt: nullable(timestamp),
  lastConnectedAt: nullable(timestamp), acknowledgedAt: nullable(timestamp), ageSeconds: nullable(seconds),
  state: enumeration(['active', 'stale', 'unseen', 'disabled']), publicationState: enumeration(['current', 'pending', 'unassigned', 'unknown']) },
  record => (record.lastSeenAt === null) === (record.ageSeconds === null));
const remote = object({
  subscriptionId: uuid, enabled: boolean, status: enumeration(['pending', 'fresh', 'stale', 'error', 'disabled']),
  lastAttemptAt: nullable(timestamp), lastSuccessAt: nullable(timestamp), nextSyncAt: timestamp,
  ageSeconds: nullable(seconds), circuitOpenUntil: nullable(timestamp),
  errorCode: nullable(enumeration([...REMOTE_ERROR_CODES, 'UNKNOWN_FAILURE'])),
}, record => (record.lastSuccessAt === null) === (record.ageSeconds === null)
  && (record.enabled === false) === (record.status === 'disabled'));
const deadLetter = object({ eventId: identifier, correlationId: nullable(uuid), queue: enumeration(OPERATIONS_QUEUE_NAMES),
  occurredAt: timestamp, processedAt: timestamp, attempts: count, errorCode: enumeration(OPERATIONS_ERROR_CODES) });
const status = object({
  protocolVersion: enumeration([OPERATIONS_PROTOCOL_VERSION]), generatedAt: timestamp,
  status: enumeration(['healthy', 'degraded', 'unavailable']), reasons: list(enumeration(OPERATIONS_REASONS), OPERATIONS_REASONS.length),
  health: object({ apiReady: boolean, database: enumeration(['ready', 'unavailable']), redis: enumeration(['ready', 'unavailable']),
    workers: object({ status: enumeration(['ready', 'unavailable', 'unknown']), count: nullable(count), sampledAt: nullable(timestamp) }, record =>
      record.status === 'unknown' ? record.count === null && record.sampledAt === null
        : record.sampledAt !== null && (record.status === 'ready' ? Number(record.count) > 0 : record.count === 0)) }),
  queues: (value, context, path) => list(queue, OPERATIONS_QUEUE_NAMES.length, 'queue')(value, context, path)
    && ((value as unknown[]).length === OPERATIONS_QUEUE_NAMES.length || problem(context, path)),
  renderCache: sample({ hits: count, misses: count, fallbacks: count, rendered: count, failures: count }),
  websocket: sample({ authenticatedConnections: count, pendingConnections: count, livenessTimeouts: count, authRejected: count }),
  sources: collection(source, 'sourceDefinitionId'), remotes: collection(remote, 'subscriptionId', OPERATIONS_LIMITS.remoteRows),
  devices: collection(device, 'deviceId'), deadLetters: collection(deadLetter, 'eventId'),
}, record => {
  const health = record.health as OperationsStatus['health'];
  const available = health.apiReady && health.database === 'ready';
  if (record.status === 'unavailable') return !available;
  if (!available) return false;
  return record.status !== 'healthy' || (health.redis === 'ready' && health.workers.status === 'ready' && (record.reasons as unknown[]).length === 0);
});

/**
 * Copy descriptor values once, with budgets independent of schema validity.
 * No value getters or conversion hooks are called. Portable JavaScript cannot
 * reject proxies without invoking reflection traps; server callers must first
 * apply their host's proxy-rejecting JSON boundary to executable objects.
 */
function detachedMetadata(input: unknown): JsonValue {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new Error('INVALID_OPERATIONS_METADATA'); };
  const add = (amount: number) => { bytes += amount; if (bytes > OPERATIONS_LIMITS.bytes) fail(); };
  const string = (value: string) => {
    if (value.length > OPERATIONS_LIMITS.bytes) fail();
    add(utf8ByteLength(JSON.stringify(value)));
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (++nodes > OPERATIONS_LIMITS.nodes || depth > OPERATIONS_LIMITS.depth) return fail();
    if (value === null) { add(4); return null; }
    if (typeof value === 'string') { string(value); return value; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) {
      add(JSON.stringify(value).length); return value === 0 ? 0 : value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail();
    const keys = Reflect.ownKeys(value);
    ancestors.add(value);
    try {
      if (array) {
        const property = Object.getOwnPropertyDescriptor(value, 'length');
        if (!property || !('value' in property)) return fail();
        const length: unknown = property.value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > OPERATIONS_LIMITS.rows
          || keys.length !== length + 1) return fail();
        add(2 + Math.max(0, length - 1));
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      if (keys.length > OPERATIONS_LIMITS.objectKeys) return fail();
      add(2 + Math.max(0, keys.length - 1));
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') return fail();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
        string(key); add(1);
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  return copy(input, 0);
}

/** Detached JSON boundary parser: unknown keys never appear in diagnostics. */
export function parseOperationsStatus(value: unknown): ParseResult<OperationsStatus> {
  try {
    const detached = detachedMetadata(value);
    return parseContract(detached, (input, context, path): input is OperationsStatus => {
      if (!status(input, context, path)) return false;
      if (utf8ByteLength(JSON.stringify(input)) > OPERATIONS_LIMITS.bytes) return problem(context, path);
      return true;
    });
  } catch {
    const context: ValidationContext = { errors: [], warnings: [] };
    problem(context, '$');
    return { success: false, errors: context.errors, warnings: context.warnings };
  }
}
