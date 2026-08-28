import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { WebDisplayGateway } from './web-display.gateway';
import { runWithCorrelation } from '../observability/correlation-context';

const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const frame = (type: string, fields = {}) => Buffer.from(JSON.stringify({ protocolVersion: '1.0', type, ...fields }));
class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  code?: number;
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
  close(code: number) { this.code = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.readyState = 3; this.emit('close'); }
  message(type: string, fields = {}) { this.emit('message', frame(type, fields), false); }
}
const gateways: WebDisplayGateway[] = [];
function setup() {
  let valid = true;
  const session = { credentialId: 'credential-id', device: { id: 7, externalId: 'screen', lastSeenAt: null, telemetry: null }, telemetryIntervalSeconds: 300 };
  const auth = {
    authenticateConnection: mock(async () => { if (!valid) throw new UnauthorizedException(); return session; }),
    revalidateConnection: mock(async () => { if (!valid) throw new UnauthorizedException(); return session; }),
  };
  const presentation = { deviceId: 7, externalId: 'screen', revision: 1, generatedAt: new Date().toISOString(), nextTransitionAt: null,
    viewport: { width: 800, height: 480 }, content: { kind: 'image', url: '/uploads/a.png', title: 'Screen', fit: 'contain', background: '#000000' } };
  const presentations = { getForDevice: mock(async () => presentation) };
  const telemetry = { observe: mock(() => {}), release: mock(() => {}) };
  const gateway = new WebDisplayGateway({} as any, auth as any, presentations as any, telemetry as any);
  gateways.push(gateway);
  const client = new Client();
  (gateway as any).accept(client);
  const authenticate = async () => { client.message('authenticate', { externalId: 'screen', token: 's'.repeat(64) }); await settle(); };
  return { gateway, client, auth, presentations, telemetry, authenticate, revoke: () => { valid = false; } };
}
afterEach(async () => { for (const g of gateways.splice(0)) await g.onApplicationShutdown(); setSystemTime(); });

describe('WebSocket gateway security and liveness', () => {
  test('delivery logs require a successful send callback and retain explicit job correlation', async () => {
    const h = setup(); await h.authenticate();
    const records: any[] = [];
    const log = spyOn(Logger.prototype, 'log').mockImplementation(value => { records.push(value); });
    try {
      let release!: (error?: Error) => void;
      h.client.send = (_value, callback) => { release = callback!; };
      const correlation = { correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', eventId: 'event-1', deliveryId: 'delivery-1' };
      const pending = runWithCorrelation(correlation, () => h.gateway.pushTimersChanged(7,
        { deliveryId: 'delivery-1', signal: new AbortController().signal }));
      await settle();
      expect(records.filter(row => row.code === 'DEVICE_DELIVERED')).toHaveLength(0);
      release(); await pending;
      expect(records.filter(row => row.code === 'DEVICE_DELIVERED')).toEqual([expect.objectContaining({ ...correlation, deviceId: 7, role: 'api' })]);
      records.length = 0;
      const failed = h.gateway.pushTimersChanged(7, { deliveryId: 'delivery-2', signal: new AbortController().signal });
      await settle(); release(new Error('synthetic-send-failure'));
      await expect(failed).rejects.toThrow('OUTBOX_ADAPTER_FAILED');
      await h.gateway.pushPresentation(7);
      expect(records.filter(row => row.code === 'DEVICE_DELIVERED')).toHaveLength(0);
    } finally { log.mockRestore(); }
  });

  test('timer notifications recheck credentials and send no presentation, IDs or timer data', async () => {
    const h = setup();
    await h.authenticate();
    const context = { deliveryId: 'timer-delivery', stateTopic: 'timers' as const, signal: new AbortController().signal };
    const before = h.presentations.getForDevice.mock.calls.length;
    const checks = h.auth.revalidateConnection.mock.calls.length;
    const revision = [...(h.gateway as any).connections.get(7)][0].lastRevision;
    await h.gateway.pushTimersChanged(7, context);
    expect(h.client.sent.at(-1)).toEqual({ protocolVersion: '1.0', type: 'timers.changed' });
    expect(h.presentations.getForDevice.mock.calls.length).toBe(before);
    expect(h.auth.revalidateConnection.mock.calls.length).toBe(checks + 1);
    expect([...(h.gateway as any).connections.get(7)][0].lastRevision).toEqual(revision);
    expect((h.gateway as any).transitionTimers.size).toBe(0);
    expect(JSON.stringify(h.client.sent.at(-1))).not.toMatch(/delivery|credential|timerId|presentation/);
  });

  test('timer notifications reject revoked or expired credentials without presentation work', async () => {
    for (const reason of ['revoked', 'expired']) {
      const h = setup();
      await h.authenticate();
      h.auth.revalidateConnection.mockRejectedValue(new UnauthorizedException(reason));
      await h.gateway.pushTimersChanged(7, { deliveryId: 'timer', signal: new AbortController().signal, stateTopic: 'timers' });
      expect(h.client.sent.some(message => message.type === 'timers.changed')).toBe(false);
      expect(h.client.code).toBe(4401);
      expect(h.presentations.getForDevice).toHaveBeenCalledTimes(1);
    }
  });

  test('pre-aborted timer pushes perform no credential read or send', async () => {
    const h = setup(); await h.authenticate();
    const before = h.client.sent.length, checks = h.auth.revalidateConnection.mock.calls.length;
    const abort = new AbortController(); abort.abort();
    await expect(h.gateway.pushTimersChanged(7, { deliveryId: 'timer', signal: abort.signal })).rejects.toThrow();
    expect(h.client.sent).toHaveLength(before);
    expect(h.auth.revalidateConnection.mock.calls.length).toBe(checks);
    expect(h.gateway.isConnected(7)).toBe(true);
  });

  test('abort during timer authorization closes the socket and late DB completion cannot send', async () => {
    const h = setup(); await h.authenticate();
    const session = await h.auth.revalidateConnection();
    let release!: (value: typeof session) => void;
    h.auth.revalidateConnection.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = h.gateway.pushTimersChanged(7, { deliveryId: 'timer', signal: abort.signal });
    await settle(); abort.abort();
    await expect(pending).rejects.toThrow('OUTBOX_ADAPTER_FAILED');
    release(session); await settle();
    expect(h.client.sent.some(message => message.type === 'timers.changed')).toBe(false);
    expect(h.client.code).toBe(1011);
    expect((h.gateway as any).inFlight.size).toBe(0);
    expect(h.presentations.getForDevice).toHaveBeenCalledTimes(1);
  });

  test('timer sends wait for confirmation and abort releases pending socket operations', async () => {
    const h = setup(); await h.authenticate();
    let callback!: (error?: Error) => void, settled = false;
    h.client.send = (value, done) => { h.client.sent.push(JSON.parse(value)); callback = done!; };
    const abort = new AbortController();
    const pending = h.gateway.pushTimersChanged(7, { deliveryId: 'timer', signal: abort.signal });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await settle(); expect(settled).toBe(false);
    expect(h.client.sent.at(-1)).toEqual({ protocolVersion: '1.0', type: 'timers.changed' });
    abort.abort(); await expect(pending).rejects.toThrow('OUTBOX_ADAPTER_FAILED');
    callback(); await settle();
    expect(h.client.code).toBe(1011);
    expect((h.gateway as any).inFlight.size).toBe(0);
    expect(h.client.sent.filter(message => message.type === 'timers.changed')).toHaveLength(1);
  });

  test('timer push backpressure fails durably without invoking presentation work', async () => {
    const h = setup(); await h.authenticate(); h.client.bufferedAmount = 262145;
    await expect(h.gateway.pushTimersChanged(7, { deliveryId: 'timer', signal: new AbortController().signal }))
      .rejects.toThrow('OUTBOX_ADAPTER_FAILED');
    expect(h.client.sent.some(message => message.type === 'timers.changed')).toBe(false);
    expect(h.client.code).toBe(1011);
    expect(h.presentations.getForDevice).toHaveBeenCalledTimes(1);
  });

  test('sends ready render at the same desired revision and rejects late fallback receipts', async () => {
    const h = setup();
    await h.authenticate();
    const original = h.client.sent.find(message => message.type === 'presentation.changed').presentation;
    h.presentations.getForDevice.mockResolvedValue({ ...original, renderRevision: 1, content: { ...original.content, url: '/assets/ready.png' } });
    await h.gateway.pushPresentation(7);
    const sent = () => h.client.sent.filter(message => message.type === 'presentation.changed');
    expect(sent()).toHaveLength(2);
    expect(sent()[1].presentation).toMatchObject({ revision: 1, renderRevision: 1, content: { url: '/assets/ready.png' } });
    h.presentations.getForDevice.mockResolvedValue(original);
    await h.gateway.pushPresentation(7);
    expect(sent()).toHaveLength(2);
    h.presentations.getForDevice.mockResolvedValue({ ...original, revision: 0, renderRevision: 999 });
    await h.gateway.pushPresentation(7);
    expect(sent()).toHaveLength(2);
    h.presentations.getForDevice.mockResolvedValue({ ...original, revision: 2, renderRevision: 0 });
    await h.gateway.pushPresentation(7);
    expect(sent()).toHaveLength(3);
    expect(sent()[2].presentation.revision).toBe(2);
  });

  test('late send callbacks cannot roll the connection generation back', async () => {
    const h = setup();
    await h.authenticate();
    const original = h.client.sent.find(message => message.type === 'presentation.changed').presentation;
    const callbacks: Array<() => void> = [];
    h.client.send = (value, callback) => { h.client.sent.push(JSON.parse(value)); if (callback) callbacks.push(() => callback()); };
    h.presentations.getForDevice.mockResolvedValue({ ...original, revision: 2, renderRevision: 0 });
    const lower = h.gateway.pushPresentation(7, { deliveryId: 'lower', signal: new AbortController().signal });
    await settle();
    expect(callbacks).toHaveLength(1);
    h.presentations.getForDevice.mockResolvedValue({ ...original, revision: 2, renderRevision: 1 });
    const higher = h.gateway.pushPresentation(7, { deliveryId: 'higher', signal: new AbortController().signal });
    await settle();
    expect(callbacks).toHaveLength(2);
    callbacks[1](); await higher;
    callbacks[0](); await lower;
    const sent = h.client.sent.length;
    h.presentations.getForDevice.mockResolvedValue({ ...original, revision: 2, renderRevision: 0 });
    await h.gateway.pushPresentation(7);
    expect(h.client.sent).toHaveLength(sent);
  });

  test('authenticates before content, projects versioned output and rejects cross-device messages', async () => {
    const h = setup();
    expect(h.presentations.getForDevice).not.toHaveBeenCalled();
    await h.authenticate();
    expect(h.gateway.isConnected(7)).toBe(true);
    expect(h.client.sent[0]).toMatchObject({ protocolVersion: '1.0', type: 'connected', deviceId: 7 });
    expect(JSON.stringify(h.client.sent)).not.toContain('s'.repeat(64));
    h.client.message('authenticate', { externalId: 'other', token: 's'.repeat(64) });
    await settle();
    expect(h.client.code).toBe(4400);
  });
  test('pre-auth messages, missing credentials and invalid versions close without access', async () => {
    for (const value of [frame('telemetry', { payload: { width: 800 } }), frame('authenticate'), Buffer.from('{'), frame('authenticate', { protocolVersion: '2.0', externalId: 'screen', token: 's'.repeat(64) })]) {
      const h = setup(); h.client.emit('message', value, false); await settle();
      expect(h.client.readyState).toBe(3);
      expect(h.auth.authenticateConnection).not.toHaveBeenCalled();
      expect(h.presentations.getForDevice).not.toHaveBeenCalled();
    }
  });
  test('auth deadline includes stalled DB and late completion cannot resurrect a socket', async () => {
    setSystemTime(100_000);
    const h = setup(); let finish!: (value: any) => void;
    h.auth.authenticateConnection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.client.message('authenticate', { externalId: 'screen', token: 's'.repeat(64) }); await settle();
    setSystemTime(110_001); (h.gateway as any).tick();
    finish({ device: { id: 7 }, credentialId: 'id', telemetryIntervalSeconds: 300 }); await settle();
    expect(h.gateway.isConnected(7)).toBe(false);
    expect(h.client.readyState).toBe(3);
  });
  test('correlated pong deadline removes dead clients and all application listeners', async () => {
    setSystemTime(100_000); const h = setup(); await h.authenticate();
    setSystemTime(130_000); (h.gateway as any).tick(); await settle();
    const ping = h.client.sent.find(m => m.type === 'ping'); expect(ping.nonce).toBeString();
    setSystemTime(140_001); (h.gateway as any).tick(); await settle();
    expect(h.client.code).toBe(4408); expect(h.gateway.isConnected(7)).toBe(false);
    expect(h.client.listenerCount('message')).toBe(0);
    expect((h.gateway as any).transitionTimers.size).toBe(0);
  });
  test('valid pong keeps connection live, unsolicited and stale pong do not', async () => {
    setSystemTime(100_000); const h = setup(); await h.authenticate();
    setSystemTime(130_000); (h.gateway as any).tick(); await settle();
    const ping = h.client.sent.find(m => m.type === 'ping'); h.client.message('pong', { nonce: ping.nonce }); await settle();
    setSystemTime(140_001); (h.gateway as any).tick(); await settle(); expect(h.gateway.isConnected(7)).toBe(true);
    h.client.message('pong', { nonce: ping.nonce }); await settle(); expect(h.client.code).toBe(4400);
  });
  test('revocation is enforced on idle connections and before push; reconnect authenticates again', async () => {
    setSystemTime(100_000); const h = setup(); await h.authenticate(); h.revoke();
    setSystemTime(110_000); (h.gateway as any).tick(); await settle(); expect(h.client.code).toBe(4401);
    const next = new Client(); (h.gateway as any).accept(next); next.message('authenticate', { externalId: 'screen', token: 's'.repeat(64) }); await settle();
    expect(next.code).toBe(4401);
    const other = setup(); await other.authenticate(); other.revoke(); await other.gateway.pushPresentation(7);
    expect(other.client.code).toBe(4401); expect(other.presentations.getForDevice).toHaveBeenCalledTimes(1);
  });
  test('rejects unknown, binary, oversized and flood messages', async () => {
    for (const kind of ['unknown', 'binary', 'size', 'flood']) {
      const h = setup(); await h.authenticate();
      if (kind === 'unknown') h.client.message('execute');
      if (kind === 'binary') h.client.emit('message', frame('pong'), true);
      if (kind === 'size') h.client.emit('message', Buffer.alloc(8193), false);
      if (kind === 'flood') for (let i = 0; i < 40; i++) h.client.message('telemetry', { payload: { width: 800 } });
      await settle(); expect(h.client.readyState).toBe(3); expect(h.gateway.isConnected(7)).toBe(false);
    }
  });
  test('DB/presentation/send errors have constant close reasons, no raw secrets or unhandled rejection', async () => {
    const warnings = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
    const h = setup(); h.auth.authenticateConnection.mockImplementation(async () => { throw new Error('database-secret'); });
    await h.authenticate(); expect(h.client.code).toBe(1011); expect(JSON.stringify(h.client.sent)).not.toContain('database-secret');
    const other = setup(); other.presentations.getForDevice.mockImplementation(async () => { throw new Error('transport-secret'); });
    await other.authenticate(); expect(other.client.code).toBe(1011);
    const third = setup(); third.client.send = () => { throw new Error('send-secret'); }; await third.authenticate(); expect(third.client.readyState).toBe(3);
      const logs = JSON.stringify(warnings.mock.calls);
      for (const secret of ['database-secret', 'transport-secret', 'send-secret', 's'.repeat(64)]) expect(logs).not.toContain(secret);
    } finally { warnings.mockRestore(); }
  });
  test('close/error/shutdown clean unauthenticated and connected sockets; restart has no stale presence', async () => {
    const h = setup(); await h.authenticate(); h.client.emit('error', new Error('socket-secret')); await settle(); expect(h.gateway.isConnected(7)).toBe(false);
    const other = setup(); await other.authenticate(); await other.gateway.onApplicationShutdown(); expect(other.client.code).toBe(1001);
    expect(other.gateway.isConnected(7)).toBe(false); expect((other.gateway as any).clients.size).toBe(0);
    const fresh = setup(); expect(fresh.gateway.isConnected(7)).toBe(false);
  });

  test('backpressure and send callback failures close without retaining listeners', async () => {
    const h = setup(); h.client.bufferedAmount = 262145; await h.authenticate();
    expect(h.client.code).toBe(1011);
    const other = setup(); other.client.send = (_value, callback) => callback?.(new Error('private-send-error'));
    await other.authenticate(); expect(other.client.code).toBe(1011);
    expect(other.client.eventNames()).toHaveLength(0);
  });

  test('caps sockets per device and never removes another live connection during cleanup', async () => {
    const h = setup(); await h.authenticate();
    const clients: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client(); clients.push(c); (h.gateway as any).accept(c);
      c.message('authenticate', { externalId: 'screen', token: 's'.repeat(64) }); await settle();
    }
    expect(clients[3].code).toBe(4429);
    h.client.close(1000); expect(h.gateway.isConnected(7)).toBe(true);
    expect(h.gateway.metrics().authenticatedConnections).toBe(3);
    for (const c of clients) c.close(1000);
    expect(h.gateway.isConnected(7)).toBe(false);
  });

  test('late revoked credentials during presentation work cannot receive content', async () => {
    const h = setup(); let finish!: (value: any) => void;
    h.presentations.getForDevice.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await h.authenticate(); h.revoke(); finish({ nextTransitionAt: null }); await settle();
    expect(h.client.code).toBe(4401);
    expect(h.client.sent.some(m => m.type === 'presentation.changed')).toBe(false);
  });
});
