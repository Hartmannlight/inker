import axios from 'axios';
import { REMOTE_ERROR_CODES, REMOTE_SUBSCRIPTION_LIMITS, parseRemoteSubscriptionList, parseRemoteSubscriptionView,
  type RemoteSubscriptionView } from '@inker/contracts';
import apiClient from '../../services/api';

export interface RemoteCreateInput {
  name: string; baseUrl: string; serverId: string; publicationId: string; token: string;
  trust: true; refreshIntervalSeconds: number;
}
export interface RemoteDeviceChoice { id: number; name: string }
export class RemoteApiError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function remoteErrorMessage(error: unknown): string {
  const code = error instanceof RemoteApiError ? error.code : 'REMOTE_REQUEST_FAILED';
  const messages: Record<string, string> = {
    REMOTE_ENDPOINT_UNAVAILABLE: 'Remote subscriptions are unavailable on this server (404).',
    REMOTE_INVALID_INPUT: 'Check the HTTPS origin, server ID, publication ID, share token and trust confirmation.',
    REMOTE_INVALID_RESPONSE: 'The server returned invalid remote subscription metadata.',
    REMOTE_SESSION_EXPIRED: 'Your admin session has expired. Sign in again.',
    REMOTE_FORBIDDEN: 'This action was denied. Check your admin session and server policy.',
    REMOTE_CONFLICT: 'The subscription could not be changed because its current state conflicts with this action.',
    REMOTE_UNAUTHORIZED: 'The remote rejected the share credential. It may have expired or been revoked.',
    REMOTE_PROTOCOL_MISMATCH: 'The remote federation protocol is incompatible.',
    REMOTE_IDENTITY_MISMATCH: 'The remote server ID does not match the identity you trusted.',
    REMOTE_ORIGIN_DENIED: 'The remote HTTPS origin is not allowed by this server configuration.',
    REMOTE_ADDRESS_DENIED: 'The remote address was denied by the server network policy.',
  };
  return messages[code] ?? (REMOTE_ERROR_CODES.includes(code as typeof REMOTE_ERROR_CODES[number])
    ? `Remote operation failed (${code}). The last valid local copy is retained.` : 'The remote operation could not be completed.');
}
function safeError(error: unknown): RemoteApiError {
  if (error instanceof RemoteApiError) return error;
  if (axios.isAxiosError(error)) {
    const message: unknown = error.response?.data?.message;
    if (typeof message === 'string' && REMOTE_ERROR_CODES.includes(message as typeof REMOTE_ERROR_CODES[number])) return new RemoteApiError(message);
    const status = error.response?.status;
    return new RemoteApiError(status === 404 ? 'REMOTE_ENDPOINT_UNAVAILABLE' : status === 401 ? 'REMOTE_SESSION_EXPIRED'
      : status === 403 ? 'REMOTE_FORBIDDEN' : status === 400 ? 'REMOTE_INVALID_INPUT' : status === 409 ? 'REMOTE_CONFLICT' : 'REMOTE_REQUEST_FAILED');
  }
  return new RemoteApiError('REMOTE_REQUEST_FAILED');
}
async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw safeError(error); }
}
function view(value: unknown): RemoteSubscriptionView {
  const result = parseRemoteSubscriptionView(value);
  if (!result.success) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
  return result.data;
}
function path(id: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new RemoteApiError('REMOTE_INVALID_INPUT');
  return `/remote-subscriptions/${encodeURIComponent(id)}`;
}
export function normalizeRemoteCreate(input: Omit<RemoteCreateInput, 'trust'> & { trust: boolean }): RemoteCreateInput {
  try {
    const url = new URL(input.baseUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || url.origin.length > REMOTE_SUBSCRIPTION_LIMITS.maxBaseUrlLength || !input.trust
      || !input.name.trim() || input.name.trim().length > REMOTE_SUBSCRIPTION_LIMITS.maxNameLength
      || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.serverId.trim())
      || !/^[A-Za-z0-9-]{1,100}$/.test(input.publicationId.trim())
      || !/^sp_share_[A-Za-z0-9_-]{64}$/.test(input.token)
      || !Number.isSafeInteger(input.refreshIntervalSeconds)
      || input.refreshIntervalSeconds < REMOTE_SUBSCRIPTION_LIMITS.refreshIntervalMinSeconds
      || input.refreshIntervalSeconds > REMOTE_SUBSCRIPTION_LIMITS.refreshIntervalMaxSeconds) throw new Error();
    return { name: input.name.trim(), baseUrl: url.origin, serverId: input.serverId.trim(), publicationId: input.publicationId.trim(),
      token: input.token, refreshIntervalSeconds: input.refreshIntervalSeconds, trust: true };
  } catch { throw new RemoteApiError('REMOTE_INVALID_INPUT'); }
}
export const remoteApi = {
  list: (signal?: AbortSignal) => guarded(async () => {
    const response = await apiClient.get<{ data: unknown }>('/remote-subscriptions', { signal, timeout: 10000 });
    const result = parseRemoteSubscriptionList(response.data.data);
    if (!result.success) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
    return result.data;
  }),
  create: (input: RemoteCreateInput, signal?: AbortSignal) => guarded(async () => {
    const response = await apiClient.post<{ data: unknown }>('/remote-subscriptions', normalizeRemoteCreate(input), { signal, timeout: 10000 });
    return view(response.data.data);
  }),
  update: (id: string, input: { enabled?: boolean; token?: string }, signal?: AbortSignal) => guarded(async () => {
    if (input.token !== undefined && !/^sp_share_[A-Za-z0-9_-]{64}$/.test(input.token)) throw new RemoteApiError('REMOTE_INVALID_INPUT');
    const response = await apiClient.patch<{ data: unknown }>(path(id), input, { signal, timeout: 10000 });
    return view(response.data.data);
  }),
  sync: (id: string, signal?: AbortSignal) => guarded(async () => {
    const response = await apiClient.post<{ data: { scheduled?: unknown } }>(`${path(id)}/sync`, {}, { signal, timeout: 10000 });
    if (response.data.data?.scheduled !== true) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
  }),
  assign: (id: string, deviceId: number, signal?: AbortSignal) => guarded(async () => {
    if (!Number.isSafeInteger(deviceId) || deviceId < 1) throw new RemoteApiError('REMOTE_INVALID_INPUT');
    const response = await apiClient.put<{ data: { assigned?: unknown } }>(`${path(id)}/devices/${deviceId}`, {}, { signal, timeout: 10000 });
    if (response.data.data?.assigned !== true) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
  }),
  devices: (signal?: AbortSignal) => guarded(async (): Promise<{ items: RemoteDeviceChoice[]; total: number }> => {
    const response = await apiClient.get<{ data: { items?: unknown; total?: unknown } }>('/devices?page=1&limit=100', { signal, timeout: 10000 });
    const data = response.data.data;
    if (!Array.isArray(data?.items) || data.items.length > 100 || typeof data.total !== 'number' || !Number.isSafeInteger(data.total)
      || data.total < data.items.length) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
    const items = data.items.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('id' in item) || !('name' in item) || typeof item.id !== 'number'
        || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.name !== 'string' || item.name.length > 200) throw new RemoteApiError('REMOTE_INVALID_RESPONSE');
      return { id: item.id, name: item.name };
    });
    return { items, total: data.total };
  }),
};
