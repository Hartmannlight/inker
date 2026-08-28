import { describe, expect, it } from 'bun:test';
import { REMOTE_ERROR_CODES, parseRemoteSubscriptionList, parseRemoteSubscriptionView, type RemoteSubscriptionView } from '../src/remote-subscription';

const now = '2026-08-28T12:00:00.000Z';
const fixture = (): RemoteSubscriptionView => ({ subscriptionId: 'sub-1', name: 'Friend server', baseUrl: 'https://friend.example',
  serverId: '29787fe4-97d8-4393-9065-efbb9d30bd61', remotePublicationId: 'remote-pub', enabled: true, trust: 'trusted',
  status: 'stale', lastAttemptAt: now, lastSuccessAt: now, nextSyncAt: now, lastErrorCode: 'REMOTE_UNAUTHORIZED',
  remoteRevision: 2, localPublicationId: 'local-pub', localPublicationRevisionId: 'local-revision', deviceIds: [1, 2] });
describe('remote subscription metadata', () => {
  it('projects detached known metadata and all documented status/error codes', () => {
    const value = fixture(), result = parseRemoteSubscriptionView(value);
    expect(result).toEqual({ success: true, data: value, warnings: [] });
    if (!result.success) throw new Error('Fixture invalid');
    value.deviceIds.push(3); expect(result.data.deviceIds).toEqual([1, 2]);
    for (const status of ['pending', 'fresh', 'stale', 'error', 'disabled']) expect(parseRemoteSubscriptionView({ ...fixture(), status }).success).toBe(true);
    for (const lastErrorCode of [...REMOTE_ERROR_CODES, null]) expect(parseRemoteSubscriptionView({ ...fixture(), lastErrorCode }).success).toBe(true);
    expect(parseRemoteSubscriptionView({ ...fixture(), remoteRevision: null, localPublicationRevisionId: null,
      lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null, deviceIds: [] }).success).toBe(true);
  });
  it('requires every field, rejects extra secrets and keeps diagnostics constant', () => {
    for (const key of Object.keys(fixture())) { const input: Record<string, unknown> = { ...fixture() }; delete input[key]; expect(parseRemoteSubscriptionView(input).success).toBe(false); }
    for (const patch of [{ token: 'synthetic-secret' }, { credentialRef: 'synthetic-secret' }, { lastErrorCode: 'synthetic-secret' },
      { trust: 'untrusted' }, { status: 'unknown' }, { enabled: 'true' }]) {
      const result = parseRemoteSubscriptionView({ ...fixture(), ...patch }); expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    }
  });
  it('bounds identities, dates, names, device cardinality and list rows', () => {
    for (const patch of [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'name\n' }, { subscriptionId: '../id' },
      { serverId: 'not-a-uuid' }, { remoteRevision: 0 }, { remoteRevision: 2147483648 },
      { lastAttemptAt: '2026-08-28' }, { nextSyncAt: '2026-02-30T00:00:00.000Z' }, { deviceIds: [1, 1] },
      { deviceIds: [0] }, { deviceIds: ['1'] }, { deviceIds: Array.from({ length: 101 }, (_, i) => i + 1) }]) {
      expect(parseRemoteSubscriptionView({ ...fixture(), ...patch }).success).toBe(false);
    }
    const list = Array.from({ length: 32 }, (_, i) => ({ ...fixture(), subscriptionId: `sub-${i}` }));
    expect(parseRemoteSubscriptionList(list).success).toBe(true);
    expect(parseRemoteSubscriptionList([...list, { ...fixture(), subscriptionId: 'extra' }]).success).toBe(false);
    expect(parseRemoteSubscriptionList([fixture(), fixture()]).success).toBe(false);
    expect(parseRemoteSubscriptionList([]).success).toBe(true);
    expect(parseRemoteSubscriptionView({ ...fixture(), deviceIds: Array.from({ length: 100 }, (_, i) => i + 1) }).success).toBe(true);
  });
  it('accepts HTTPS origins only without userinfo, path, query or noncanonical syntax', () => {
    for (const baseUrl of ['https://example.com', 'https://xn--bcher-kva.example:8443', 'https://127.0.0.1:18726', 'https://[::1]:8443']) {
      expect(parseRemoteSubscriptionView({ ...fixture(), baseUrl }).success).toBe(true);
    }
    for (const baseUrl of ['http://example.com', 'https://user:synthetic-secret@example.com', 'https://example.com/',
      'https://example.com/path', 'https://example.com?token=synthetic-secret', 'https://example.com#fragment',
      'https://Example.com', 'https://example.com:443', 'https://example.com:0', 'https://example.com:65536',
      'https://example..com', 'https://-example.com', '//example.com', 'javascript:alert(1)']) {
      expect(parseRemoteSubscriptionView({ ...fixture(), baseUrl }).success).toBe(false);
    }
  });
  it('rejects accessors and malformed arrays while serializing only descriptor projections', () => {
    let calls = 0;
    const getter = { ...fixture() }; Object.defineProperty(getter, 'name', { enumerable: true, get() { calls++; return 'secret'; } });
    expect(parseRemoteSubscriptionView(getter).success).toBe(false);
    const proxy = new Proxy(fixture(), { get() { calls++; return 'synthetic-secret'; } });
    const result = parseRemoteSubscriptionList([proxy]); expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret'); expect(calls).toBe(0);
    const array = [fixture()]; Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return fixture(); } });
    expect(parseRemoteSubscriptionList(array).success).toBe(false); expect(calls).toBe(0);
    expect(parseRemoteSubscriptionView({ ...fixture(), deviceIds: Array(1) }).success).toBe(false);
    expect(parseRemoteSubscriptionView(Object.assign(Object.create({ extra: true }) as object, fixture())).success).toBe(false);
    expect(parseRemoteSubscriptionList(new Proxy([], { ownKeys() { throw new Error('synthetic-secret'); } })).success).toBe(false);
  });
});
