import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';

export interface CorrelationContext {
  correlationId: string;
  eventId?: string;
  deviceId?: number;
  sourceDefinitionId?: string;
  deliveryId?: string;
}

const fields = ['correlationId', 'eventId', 'deviceId', 'sourceDefinitionId', 'deliveryId'] as const;
const contexts = new AsyncLocalStorage<Readonly<CorrelationContext>>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identifier = /^[a-zA-Z0-9-]{1,100}$/;

/** Fixed metadata only. Never pass request objects, errors, headers or payloads. */
export function metadataRecord(value: unknown, allowed: readonly string[], errorCode: string): Record<string, unknown> {
  const fail = (): never => { throw new Error(errorCode); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}

/** IDs are server-owned metadata; this is not an HTTP-header ingestion API. */
export function createCorrelationContext(input: unknown = {}): Readonly<CorrelationContext> {
  const value = metadataRecord(input, fields, 'OBSERVABILITY_INVALID_CONTEXT');
  const correlationId = value.correlationId === undefined ? randomUUID() : value.correlationId;
  if (typeof correlationId !== 'string' || !uuid.test(correlationId)) throw new Error('OBSERVABILITY_INVALID_CONTEXT');
  const result: CorrelationContext = { correlationId };
  for (const key of ['eventId', 'deliveryId'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !identifier.test(value[key])) throw new Error('OBSERVABILITY_INVALID_CONTEXT');
    result[key] = value[key];
  }
  if (value.sourceDefinitionId !== undefined) {
    if (typeof value.sourceDefinitionId !== 'string' || !uuid.test(value.sourceDefinitionId)) throw new Error('OBSERVABILITY_INVALID_CONTEXT');
    result.sourceDefinitionId = value.sourceDefinitionId;
  }
  if (value.deviceId !== undefined) {
    if (!Number.isSafeInteger(value.deviceId) || Number(value.deviceId) < 1) throw new Error('OBSERVABILITY_INVALID_CONTEXT');
    result.deviceId = value.deviceId as number;
  }
  return Object.freeze(result);
}

export function runWithCorrelation<T>(context: CorrelationContext, operation: () => T): T {
  return contexts.run(createCorrelationContext(context), operation);
}

export function currentCorrelation(): Readonly<CorrelationContext> | undefined {
  return contexts.getStore();
}
