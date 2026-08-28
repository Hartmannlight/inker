import { utf8ByteLength } from './json-value';
import type { ParseResult } from './validation';

export const REMOTE_SUBSCRIPTION_LIMITS = Object.freeze({
  maxRows: 32, maxNameLength: 100, maxBaseUrlLength: 2048, maxDeviceIds: 100,
  maxListBytes: 128 * 1024, refreshIntervalMinSeconds: 60, refreshIntervalMaxSeconds: 86400,
});
export const REMOTE_ERROR_CODES = [
  'REMOTE_URL_INVALID', 'REMOTE_POLICY_INVALID', 'REMOTE_ORIGIN_DENIED', 'REMOTE_ADDRESS_DENIED',
  'REMOTE_DNS_FAILED', 'REMOTE_REQUEST_FAILED', 'REMOTE_REDIRECT_DENIED', 'REMOTE_RESPONSE_INVALID',
  'REMOTE_RESPONSE_TOO_LARGE', 'REMOTE_TIMEOUT', 'REMOTE_ABORTED', 'REMOTE_UNAUTHORIZED',
  'REMOTE_PROTOCOL_MISMATCH', 'REMOTE_IDENTITY_MISMATCH', 'REMOTE_PUBLICATION_MISMATCH',
  'REMOTE_HASH_MISMATCH', 'REMOTE_SECRET_UNAVAILABLE', 'REMOTE_SYNC_FAILED', 'REMOTE_REVISION_CONFLICT',
  'REMOTE_CACHE_INVALID',
] as const;
export type RemoteErrorCode = typeof REMOTE_ERROR_CODES[number];
export type RemoteSubscriptionStatus = 'pending' | 'fresh' | 'stale' | 'error' | 'disabled';

/** Administrative metadata only. Credentials are never part of a read projection. */
export interface RemoteSubscriptionView {
  subscriptionId: string;
  name: string;
  baseUrl: string;
  serverId: string;
  remotePublicationId: string;
  enabled: boolean;
  trust: 'trusted';
  status: RemoteSubscriptionStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string;
  lastErrorCode: RemoteErrorCode | null;
  remoteRevision: number | null;
  localPublicationId: string;
  localPublicationRevisionId: string | null;
  deviceIds: number[];
}

const fields = ['subscriptionId', 'name', 'baseUrl', 'serverId', 'remotePublicationId', 'enabled', 'trust', 'status',
  'lastAttemptAt', 'lastSuccessAt', 'nextSyncAt', 'lastErrorCode', 'remoteRevision', 'localPublicationId',
  'localPublicationRevisionId', 'deviceIds'] as const;
const id = /^[A-Za-z0-9-]{1,100}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function valid(condition: unknown): asserts condition { if (!condition) throw new Error('Invalid remote metadata'); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
function identifier(value: unknown): value is string { return typeof value === 'string' && id.test(value); }
function time(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch >= 0 && new Date(epoch).toISOString() === value;
}
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > REMOTE_SUBSCRIPTION_LIMITS.maxBaseUrlLength) return false;
  // Syntax only; DNS, TLS, allowlisting and address policy belong to the server fetch boundary.
  const match = /^https:\/\/(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || (match[2] && (Number(match[2]) > 65535 || match[2] === '443'))) return false;
  return match[1].startsWith('[') || match[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function array(input: unknown, limit: number): unknown[] {
  valid(Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype);
  const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  valid(typeof length === 'number' && Number.isInteger(length) && length >= 0 && length <= limit
    && Reflect.ownKeys(input).length === length + 1);
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    valid(descriptor?.enumerable && 'value' in descriptor);
    result.push(descriptor.value);
  }
  return result;
}
function project(input: unknown): RemoteSubscriptionView {
  valid(input !== null && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const keys = Reflect.ownKeys(input);
  valid(keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key as typeof fields[number])));
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    valid(descriptor?.enumerable && 'value' in descriptor);
    value[key] = descriptor.value;
  }
  valid(identifier(value.subscriptionId) && identifier(value.remotePublicationId) && identifier(value.localPublicationId)
    && (value.localPublicationRevisionId === null || identifier(value.localPublicationRevisionId)));
  valid(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= REMOTE_SUBSCRIPTION_LIMITS.maxNameLength
    && !/[\u0000-\u001f\u007f]/.test(value.name));
  valid(origin(value.baseUrl) && typeof value.serverId === 'string' && uuid.test(value.serverId));
  valid(typeof value.enabled === 'boolean' && value.trust === 'trusted'
    && ['pending', 'fresh', 'stale', 'error', 'disabled'].includes(value.status as string));
  valid((value.lastAttemptAt === null || time(value.lastAttemptAt)) && (value.lastSuccessAt === null || time(value.lastSuccessAt))
    && time(value.nextSyncAt) && (value.remoteRevision === null || integer(value.remoteRevision)));
  valid(value.lastErrorCode === null || REMOTE_ERROR_CODES.includes(value.lastErrorCode as RemoteErrorCode));
  const deviceIds = array(value.deviceIds, REMOTE_SUBSCRIPTION_LIMITS.maxDeviceIds);
  valid(deviceIds.every(integer) && new Set(deviceIds).size === deviceIds.length);
  value.deviceIds = deviceIds;
  return value as unknown as RemoteSubscriptionView;
}
function failure<T>(): ParseResult<T> {
  return { success: false, errors: [{ code: 'invalid_remote_subscription', path: '$', severity: 'error',
    message: 'Invalid bounded remote subscription metadata.' }], warnings: [] };
}
export function parseRemoteSubscriptionView(input: unknown): ParseResult<RemoteSubscriptionView> {
  try { return { success: true, data: project(input), warnings: [] }; } catch { return failure(); }
}
export function parseRemoteSubscriptionList(input: unknown): ParseResult<RemoteSubscriptionView[]> {
  try {
    const result = array(input, REMOTE_SUBSCRIPTION_LIMITS.maxRows).map(project);
    valid(new Set(result.map(row => row.subscriptionId)).size === result.length
      && utf8ByteLength(JSON.stringify(result)) <= REMOTE_SUBSCRIPTION_LIMITS.maxListBytes);
    return { success: true, data: result, warnings: [] };
  } catch { return failure(); }
}
