import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRemoteCreate, remoteApi, remoteErrorMessage, RemoteApiError } from './remote-api';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('../../services/api', () => ({ default: client }));
const at = '2026-08-28T12:00:00.000Z';
const view = { subscriptionId: 'subscription-1', name: 'Remote one', baseUrl: 'https://remote.example',
  serverId: '29787fe4-97d8-4393-9065-efbb9d30bd61', remotePublicationId: 'publication-1', enabled: true, trust: 'trusted',
  status: 'fresh', lastAttemptAt: at, lastSuccessAt: at, nextSyncAt: at, lastErrorCode: null,
  remoteRevision: 1, localPublicationId: 'local-1', localPublicationRevisionId: 'revision-1', deviceIds: [7] };
const token = 'sp_share_' + 'a'.repeat(64);
const input = { name: 'Remote one', baseUrl: 'https://REMOTE.example/', serverId: view.serverId, publicationId: 'publication-1', token, trust: true as const, refreshIntervalSeconds: 300 };
const wrapped = (data: unknown) => ({ data: { data } });
beforeEach(() => vi.resetAllMocks());

describe('remote admin API boundary', () => {
  it('uses wrapped metadata and never retains secret fields from subscription or device responses', async () => {
    client.get.mockResolvedValueOnce(wrapped([view])).mockResolvedValueOnce(wrapped({ items: [{ id: 7, name: 'Display', pairingToken: token }], total: 1 }));
    const signal = new AbortController().signal;
    expect(await remoteApi.list(signal)).toEqual([view]);
    expect(client.get).toHaveBeenCalledWith('/remote-subscriptions', { signal, timeout: 10000 });
    expect(await remoteApi.devices()).toEqual({ items: [{ id: 7, name: 'Display' }], total: 1 });
    client.get.mockResolvedValue(wrapped([{ ...view, token }]));
    await expect(remoteApi.list()).rejects.toMatchObject({ code: 'REMOTE_INVALID_RESPONSE' });
    client.get.mockResolvedValue({ data: [view] });
    await expect(remoteApi.list()).rejects.toMatchObject({ code: 'REMOTE_INVALID_RESPONSE' });
  });
  it('normalizes the HTTPS origin and submits credentials only in command bodies', async () => {
    client.post.mockResolvedValue(wrapped(view));
    const signal = new AbortController().signal;
    expect(await remoteApi.create(input, signal)).toEqual(view);
    expect(client.post).toHaveBeenCalledWith('/remote-subscriptions', { ...input, baseUrl: 'https://remote.example' }, { signal, timeout: 10000 });
    client.patch.mockResolvedValue(wrapped(view));
    await remoteApi.update(view.subscriptionId, { token }, signal);
    expect(client.patch).toHaveBeenCalledWith('/remote-subscriptions/subscription-1', { token }, { signal, timeout: 10000 });
  });
  it('requires trust, HTTPS origin, identity, bounded interval and a valid share credential before sending', async () => {
    for (const patch of [{ trust: false }, { baseUrl: 'http://remote.example' }, { baseUrl: 'https://user:pass@remote.example' },
      { baseUrl: 'https://remote.example/api' }, { baseUrl: 'https://remote.example?token=secret' }, { baseUrl: 'https://remote.example#x' },
      { serverId: 'invalid' }, { publicationId: '../one' }, { refreshIntervalSeconds: 59 }, { refreshIntervalSeconds: 86401 }, { token: 'secret' }]) {
      expect(() => normalizeRemoteCreate({ ...input, ...patch })).toThrow(RemoteApiError);
    }
    await expect(remoteApi.create({ ...input, token: 'invalid' })).rejects.toMatchObject({ code: 'REMOTE_INVALID_INPUT' });
    expect(client.post).not.toHaveBeenCalled();
  });
  it('requires actual command acknowledgement and binds assignment to a local numeric device', async () => {
    client.post.mockResolvedValue(wrapped({ scheduled: true })); client.put.mockResolvedValue(wrapped({ assigned: true }));
    await remoteApi.sync(view.subscriptionId); await remoteApi.assign(view.subscriptionId, 7);
    expect(client.post).toHaveBeenCalledWith('/remote-subscriptions/subscription-1/sync', {}, expect.objectContaining({ timeout: 10000 }));
    expect(client.put).toHaveBeenCalledWith('/remote-subscriptions/subscription-1/devices/7', {}, expect.objectContaining({ timeout: 10000 }));
    client.post.mockResolvedValue(wrapped({ scheduled: false }));
    await expect(remoteApi.sync(view.subscriptionId)).rejects.toMatchObject({ code: 'REMOTE_INVALID_RESPONSE' });
    await expect(remoteApi.assign(view.subscriptionId, 0)).rejects.toMatchObject({ code: 'REMOTE_INVALID_INPUT' });
    await expect(remoteApi.sync('../escape')).rejects.toMatchObject({ code: 'REMOTE_INVALID_INPUT' });
  });
  it('shows explicit unavailable/auth/policy failures without raw server messages or submitted tokens', async () => {
    for (const [status, code] of [[404, 'REMOTE_ENDPOINT_UNAVAILABLE'], [401, 'REMOTE_SESSION_EXPIRED'], [403, 'REMOTE_FORBIDDEN'], [500, 'REMOTE_REQUEST_FAILED']] as const) {
      client.get.mockRejectedValue({ isAxiosError: true, response: { status, data: { message: token } }, config: { data: token } });
      let result: unknown;
      try { await remoteApi.list(); } catch (error) { result = error; }
      expect(result).toMatchObject({ code }); expect(remoteErrorMessage(result)).not.toContain(token);
    }
    client.get.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'REMOTE_ORIGIN_DENIED' } } });
    await expect(remoteApi.list()).rejects.toMatchObject({ code: 'REMOTE_ORIGIN_DENIED' });
    expect(remoteErrorMessage(new Error(token))).not.toContain(token);
  });
});
