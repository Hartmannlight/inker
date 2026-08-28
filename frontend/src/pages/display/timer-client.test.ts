import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimerClient } from './timer-client';

const at = '2026-08-28T12:00:00.000Z', end = '2026-08-28T12:01:00.000Z';
const timer = { timerId: '9435c24b-b254-4bde-8439-e5a08f8a313a', version: 1, creatorDeviceId: 'display', visibility: 'shared', status: 'running',
  durationMs: 60000, startedAt: at, endsAt: end, evaluatedAt: at, pausedRemainingMs: null, completedAt: null,
  cancelledAt: null, acknowledgedAt: null, acknowledgedByDeviceId: null };
const feed = { protocolVersion: '1.0', serverTime: at, timers: [timer] };
const context = { protocolVersion: '1.0', deviceId: 'display', credentialId: 'credential-id', publicationId: 'publication', revision: '1',
  allowedActions: [{ action: 'timer.create', payloadSchemaVersion: '1.0', targetId: 'timer-controls' }] };
const response = (value: unknown, status = 200, headers?: HeadersInit) => new Response(status === 304 ? null : JSON.stringify(value), { status, headers });
const clients: TimerClient[] = [];
const create = (notify = vi.fn(), unauthorized = vi.fn()) => {
  const client = new TimerClient('/api', 'display', 'synthetic-device-token', notify, unauthorized); clients.push(client); client.setConnected(true); return client;
};
let mono = 100;
beforeEach(() => { mono = 100; vi.spyOn(performance, 'now').mockImplementation(() => mono); });
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('timer HTTP client', () => {
  it('uses device-only headers and a monotonic server clock without polling', async () => {
    const fetcher = vi.fn(async (url: string) => response(url.endsWith('/timers') ? feed : { data: context }, 200, { ETag: '"one"' }));
    vi.stubGlobal('fetch', fetcher);
    const client = create(); await client.refresh();
    expect(client.state.status).toBe('ready'); expect(client.serverNow()).toBe(Date.parse(at));
    mono += 6000; expect(client.remaining(client.state.feed!.timers[0])).toBe(54000);
    vi.spyOn(Date, 'now').mockReturnValue(1); expect(client.remaining(client.state.feed!.timers[0])).toBe(54000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain('synthetic-device-token');
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-device-token' } });
    }
  });
  it('coalesces a burst into one active and one follow-up refresh', async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let feeds = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/timers') && ++feeds === 1 ? pending : Promise.resolve(response(url.endsWith('/timers') ? feed : { data: context }))));
    const client = create(), work = client.refresh();
    for (let i = 0; i < 20; i++) expect(client.refresh()).toBe(work);
    finish(response(feed)); await work;
    expect(feeds).toBe(2); expect(client.state.status).toBe('ready');
  });
  it('resynchronizes time on 304 and retains its bounded feed', async () => {
    let feeds = 0;
    const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async (url: string) => url.endsWith('/timers')
      ? ++feeds === 1 ? response(feed, 200, { ETag: 'W/"one"' }) : response(null, 304, { ETag: 'W/"one"', 'X-Server-Time': '2026-08-28T12:00:20.000Z' })
      : response({ data: context }));
    vi.stubGlobal('fetch', fetcher);
    const client = create(); await client.refresh(); await client.refresh();
    expect(client.remaining(client.state.feed!.timers[0])).toBe(40000);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ headers: { 'If-None-Match': 'W/"one"' } });
  });
  it('does not undo a persisted evaluation when a 304 server-time probe moves backward', async () => {
    const resumed = { ...timer, evaluatedAt: '2026-08-28T12:00:30.000Z', endsAt: '2026-08-28T12:01:30.000Z' };
    let feeds = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => !url.endsWith('/timers') ? response({ data: context })
      : ++feeds === 1 ? response({ ...feed, serverTime: '2026-08-28T12:00:40.000Z', timers: [resumed] }, 200, { ETag: '"one"' })
        : response(null, 304, { ETag: '"one"', 'X-Server-Time': '2026-08-28T12:00:10.000Z' })));
    const client = create(); await client.refresh();
    expect(client.remaining(client.state.feed!.timers[0])).toBe(50000);
    await client.refresh();
    expect(client.remaining(client.state.feed!.timers[0])).toBe(60000);
    expect(client.remaining(client.state.feed!.timers[0])).toBeLessThanOrEqual(resumed.durationMs);
  });
  it('bounds round-trip compensation and elapsed time to the canonical year-9999 range', async () => {
    const maximum = '9999-12-31T23:59:59.999Z'; let feeds = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!url.endsWith('/timers')) return response({ data: context });
      mono += 1000;
      return ++feeds === 1 ? response(feed, 200, { ETag: '"one"' }) : response(null, 304, { ETag: '"one"', 'X-Server-Time': maximum });
    }));
    const client = create(); await client.refresh(); await client.refresh();
    expect(client.serverNow()).toBe(Date.parse(maximum));
    mono += 5000;
    expect(new Date(client.serverNow()!).toISOString()).toBe(maximum);
    expect(client.remaining(client.state.feed!.timers[0])).toBe(0);
  });
  it('locks double taps and retries the identical event after an uncertain response', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<Response>((_, fail) => { reject = fail; });
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(String(init.body));
        if (bodies.length === 1) return pending;
        const event = JSON.parse(bodies[0]);
        return Promise.resolve(response({ data: { protocolVersion: '1.0', commandId: 'command-id', eventId: event.eventId, status: 'duplicate', serverTime: at } }));
      }
      return Promise.resolve(response(url.endsWith('/timers') ? feed : { data: context }));
    }));
    const client = create(); await client.refresh();
    const work = client.command('timer.create', { version: 1, durationMs: 1000, visibility: 'shared' });
    await client.command('timer.create', { version: 1, durationMs: 1000, visibility: 'shared' });
    expect(bodies).toHaveLength(1); expect(client.state.busy).toBe(true);
    reject(new Error('synthetic-secret-response')); await work;
    expect(client.state.retryAvailable).toBe(true); expect(client.state.message).not.toContain('synthetic-secret');
    await client.retry(); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0])).toMatchObject({ occurredAt: at, targetId: 'timer-controls', credentialId: 'credential-id' });
    expect(bodies[0]).not.toContain('synthetic-device-token'); expect(client.state.retryAvailable).toBe(false);
  });
  it('blocks ungranted commands and clears private data on 401', async () => {
    const unauthorized = vi.fn(); let authorized = true;
    const fetcher = vi.fn(async (url: string) => !authorized ? response({}, 401) : response(url.endsWith('/timers') ? feed : { data: { ...context, allowedActions: [] } }));
    vi.stubGlobal('fetch', fetcher);
    const client = create(vi.fn(), unauthorized); await client.refresh();
    await client.command('timer.create', { version: 1, durationMs: 1000, visibility: 'private' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    authorized = false; await client.refresh();
    expect(client.state).toMatchObject({ feed: null, context: null, status: 'unauthorized' }); expect(unauthorized).toHaveBeenCalledOnce();
  });
  it('unlocks new commands after a stable retry is rejected as expired', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(String(init.body));
        if (bodies.length === 1) throw new Error('network unavailable');
        const event = JSON.parse(String(init.body));
        return response({ data: { protocolVersion: '1.0', eventId: event.eventId, commandId: 'command', serverTime: at,
          status: bodies.length === 2 ? 'rejected' : 'accepted', ...(bodies.length === 2
            ? { error: { code: 'INTERACTION_EXPIRED', message: 'INTERACTION_EXPIRED', retryable: false } } : {}) } });
      }
      return response(url.endsWith('/timers') ? feed : { data: context });
    }));
    const client = create(); await client.refresh();
    const payload = { version: 1, durationMs: 1000, visibility: 'shared' };
    await client.command('timer.create', payload); expect(client.state.retryAvailable).toBe(true);
    mono += 300001; await client.retry();
    expect(bodies[1]).toBe(bodies[0]); expect(client.state).toMatchObject({ busy: false, retryAvailable: false, status: 'ready' });
    await client.command('timer.create', payload);
    expect(bodies).toHaveLength(3); expect(JSON.parse(bodies[2]).eventId).not.toBe(JSON.parse(bodies[0]).eventId);
  });
  it('keeps offline state but rejects late replies after identity disposal', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/timers') ? feed : { data: context }))));
    const notify = vi.fn(), client = create(notify); await client.refresh();
    client.setConnected(false); expect(client.state.feed).not.toBeNull(); expect(client.state.context).toBeNull();
    expect(client.state.status).toBe('offline');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    client.setConnected(true); const work = client.refresh(); client.dispose(); const calls = notify.mock.calls.length;
    finish(response({ ...feed, timers: [] })); await work; expect(notify).toHaveBeenCalledTimes(calls);
  });
  it('starts a new refresh immediately on reconnect even if an aborted old fetch has not settled', async () => {
    let finish!: (value: Response) => void;
    let feeds = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/timers') && ++feeds === 1
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(response(url.endsWith('/timers') ? { ...feed, timers: [] } : { data: context }))));
    const client = create(), old = client.refresh();
    client.setConnected(false); client.setConnected(true);
    await client.refresh(); expect(feeds).toBe(2); expect(client.state.feed?.timers).toEqual([]);
    finish(response(feed)); await old;
    expect(client.state.feed?.timers).toEqual([]); expect(client.state.status).toBe('ready');
  });
  it('rejects oversized wire bodies and malformed context without displaying response errors', async () => {
    const fetcher = vi.fn(async () => new Response('synthetic-secret' + 'x'.repeat(131073)));
    vi.stubGlobal('fetch', fetcher);
    const client = create(); await client.refresh(); expect(client.state.status).toBe('offline'); expect(client.state.feed).toBeNull();
    expect(JSON.stringify(client.state)).not.toContain('synthetic-secret');
    fetcher.mockImplementation(async (url?: unknown) => response(String(url).endsWith('/timers') ? feed : { data: { ...context, deviceId: 'other' } }));
    await client.refresh(); expect(client.state.context).toBeNull();
  });
});
