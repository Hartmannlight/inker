import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { WebDisplayGateway } from './web-display.gateway';

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
