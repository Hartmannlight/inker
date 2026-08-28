import { QUEUE_NAMES, type QueueName } from '../jobs/queue-policy';
import { createCorrelationContext, currentCorrelation, metadataRecord, type CorrelationContext } from './correlation-context';

export const HTTP_ROUTE_GROUPS = Object.freeze(['live', 'health', 'ready', 'auth', 'pairing', 'devices', 'sources', 'publications', 'display', 'operations', 'other'] as const);
export type HttpRouteGroup = typeof HTTP_ROUTE_GROUPS[number];
export const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const);
export const JOB_OUTCOMES = Object.freeze(['success', 'failure', 'timeout', 'aborted', 'stale'] as const);
export type JobOutcome = typeof JOB_OUTCOMES[number];
const levels = Object.freeze({
  REQUEST_COMPLETED: 'info', REQUEST_FAILED: 'warn',
  JOB_STARTED: 'info', JOB_COMPLETED: 'info', JOB_FAILED: 'warn', JOB_STALE: 'warn',
  DEVICE_CONNECTED: 'info', DEVICE_DISCONNECTED: 'info', DEVICE_DELIVERED: 'info', DEVICE_DELIVERY_FAILED: 'warn',
  SOURCE_REFRESH_SUCCEEDED: 'info', SOURCE_REFRESH_FAILED: 'warn',
  RENDER_SUCCEEDED: 'info', RENDER_FAILED: 'warn',
  DEPENDENCY_DEGRADED: 'warn', DEPENDENCY_RECOVERED: 'info',
} as const);
export type StructuredEventCode = keyof typeof levels;
export const STRUCTURED_EVENT_CODES = Object.freeze(Object.keys(levels) as StructuredEventCode[]);
export interface StructuredEventFields extends Partial<CorrelationContext> {
  role: 'api' | 'worker';
  queue?: QueueName;
  route?: HttpRouteGroup;
  method?: typeof HTTP_METHODS[number];
  outcome?: JobOutcome;
  durationMs?: number;
  statusCode?: number;
  attempt?: number;
}
export interface StructuredEvent extends CorrelationContext, Omit<StructuredEventFields, keyof CorrelationContext> {
  protocolVersion: '1.0';
  timestamp: string;
  code: StructuredEventCode;
  level: 'info' | 'warn';
}
const allowed = ['role', 'queue', 'route', 'method', 'outcome', 'durationMs', 'statusCode', 'attempt',
  'correlationId', 'eventId', 'deviceId', 'sourceDefinitionId', 'deliveryId'] as const;

/** No arbitrary messages, exception objects, paths, labels or payload fields. */
export function structuredEvent(code: StructuredEventCode, fields: StructuredEventFields, now = new Date()): Readonly<StructuredEvent> {
  const fail = (): never => { throw new Error('OBSERVABILITY_INVALID_EVENT'); };
  if (!STRUCTURED_EVENT_CODES.includes(code)) return fail();
  const value = metadataRecord(fields, allowed, 'OBSERVABILITY_INVALID_EVENT');
  if (!['api', 'worker'].includes(value.role as string)) return fail();
  const enums = { queue: QUEUE_NAMES, route: HTTP_ROUTE_GROUPS, method: HTTP_METHODS, outcome: JOB_OUTCOMES };
  for (const key of ['queue', 'route', 'method', 'outcome'] as const) {
    if (value[key] !== undefined && !(enums[key] as readonly unknown[]).includes(value[key])) return fail();
  }
  if (value.durationMs !== undefined && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs)
    || value.durationMs < 0 || value.durationMs > 86_400_000)) return fail();
  if (value.statusCode !== undefined && (!Number.isSafeInteger(value.statusCode) || Number(value.statusCode) < 100 || Number(value.statusCode) > 599)) return fail();
  if (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0 || Number(value.attempt) > 5)) return fail();
  let timestamp: string;
  try { timestamp = Date.prototype.toISOString.call(now); } catch { return fail(); }
  const context: Record<string, unknown> = { ...currentCorrelation() };
  for (const key of ['correlationId', 'eventId', 'deviceId', 'sourceDefinitionId', 'deliveryId']) {
    if (value[key] !== undefined) context[key] = value[key];
  }
  let correlation: Readonly<CorrelationContext>;
  try { correlation = createCorrelationContext(context); } catch { return fail(); }
  const result: StructuredEvent = { protocolVersion: '1.0', timestamp, code, level: levels[code],
    role: value.role as 'api' | 'worker', ...correlation };
  for (const key of ['queue', 'route', 'method', 'outcome', 'durationMs', 'statusCode', 'attempt'] as const) {
    if (value[key] !== undefined) Object.assign(result, { [key]: value[key] });
  }
  return Object.freeze(result);
}
