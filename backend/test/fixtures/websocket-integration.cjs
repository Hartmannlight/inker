const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { PrismaClient } = require('@prisma/client');
const { WebSocket } = require('ws');
// Test-only TS loader: use the exact source and existing compiler, with Nest metadata.
const ts = require('typescript');
const fs = require('node:fs');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
}).outputText, filename);
const { DevicePlatformModule } = require('../../src/device-platform/device-platform.module');
const { WebDisplayGateway } = require('../../src/device-platform/web-display.gateway');
const { PresentationService } = require('../../src/device-platform/presentation.service');
const { WebSocketTelemetryService } = require('../../src/device-platform/websocket-telemetry.service');
const { WebDisplayAuthService } = require('../../src/device-platform/web-display-auth.service');
const { DeviceEnrollmentService } = require('../../src/device-enrollment/device-enrollment.service');
const { EventsModule } = require('../../src/events/events.module');
const { PrismaService } = require('../../src/prisma/prisma.service');
const { generateToken, hashToken } = require('../../src/common/utils/crypto.util');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await sleep(10); }
  throw new Error('WebSocket condition timed out');
}

async function main() {
  const scenario = process.argv[2];
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${process.argv[3].replaceAll('\\', '/')}` } } });
  let writes = 0;
  const updateMany = prisma.device.updateMany.bind(prisma.device);
  prisma.device.updateMany = args => { if (args.data.lastSeenAt) writes++; return updateMany(args); };
  const module = await Test.createTestingModule({ imports: [DevicePlatformModule, EventsModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
  const app = module.createNestApplication(); app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  const gateway = app.get(WebDisplayGateway), telemetry = app.get(WebSocketTelemetryService);
  const url = `ws://127.0.0.1:${app.getHttpServer().address().port}/api/device-connect`;
  const sockets = [];
  const realNow = Date.now;
  const tokens = [];
  let output = '';
  async function device(name) {
    const token = generateToken(48); tokens.push(token);
    const row = await prisma.device.create({ data: { name, externalId: name, profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser', lastSeenAt: new Date() } });
    await prisma.deviceCredential.create({ data: { deviceId: row.id, kind: 'web-display', tokenHash: hashToken(token) } });
    return { ...row, token };
  }
  function connect(d, options = {}) {
    const ws = new WebSocket(url, options); sockets.push(ws);
    const state = { messages: [], code: undefined, respond: true, ws };
    ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'authenticate', externalId: d.externalId, token: d.token, viewport: { width: 800, height: 480 } })));
    ws.on('message', raw => {
      output += raw.toString();
      const message = JSON.parse(raw.toString()); state.messages.push(message);
      if (message.type === 'ping' && state.respond) ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: message.nonce }));
    });
    ws.on('error', () => {}); ws.on('close', code => { state.code = code; });
    return state;
  }
  const ready = state => until(() => state.messages.some(m => m.type === 'presentation.changed'));
  try {
    if (scenario === 'idle') {
      const policy = await prisma.deliveryPolicy.findUniqueOrThrow({ where: { policyId: 'reference-connected-browser' } });
      await prisma.deliveryPolicy.update({ where: { policyId: policy.policyId }, data: { definition: { ...policy.definition, telemetryIntervalSeconds: 300 } } });
      const clients = [];
      for (let i = 0; i < 20; i++) clients.push(connect(await device(`idle-${i}`)));
      await Promise.all(clients.map(ready));
      assert.equal(gateway.metrics().authenticatedConnections, 20);
      const start = realNow() + 100; let now = start; Date.now = () => now;
      for (let beat = 1; beat < 10; beat++) {
        now = start + beat * 30000; gateway.tick(); await until(() => gateway.metrics().pongs === beat * 20);
        telemetry.flush(); await sleep(20);
      }
      assert.equal(writes, 0);
      now = start + 300000; gateway.tick(); await until(() => gateway.metrics().pongs === 200);
      telemetry.flush(); await until(() => telemetry.metrics().writes === 20);
      assert.equal(writes, 20);
      for (const row of await prisma.device.findMany()) assert.deepEqual(row.telemetry.websocket, { width: 800, height: 480 });
      for (const c of clients) c.respond = false;
      now = start + 330000; gateway.tick(); await sleep(30);
      now = start + 340001; gateway.tick(); await until(() => clients.every(c => c.code === 4408));
      assert.equal(gateway.metrics().authenticatedConnections, 0); assert.equal(gateway.metrics().livenessTimeouts, 20); assert.equal(writes, 20);
      console.info('WP-15 measurement: 20 clients / 200 pongs / 0 writes before interval / 20 interval writes / 20 dead clients removed');
    } else if (scenario === 'rotation') {
      const d = await device('rotation'); const old = connect(d); await ready(old);
      const enrollments = new DeviceEnrollmentService(prisma);
      const exchanged = await enrollments.exchange((await enrollments.create(d.id)).code); tokens.push(exchanged.credential);
      await gateway.pushPresentation(d.id); await until(() => old.code !== undefined); assert.equal(old.code, 4401);
      const rejected = connect(d); await until(() => rejected.code !== undefined); assert.equal(rejected.code, 4401);
      const fresh = connect({ ...d, token: exchanged.credential }); await ready(fresh);
      gateway.onApplicationShutdown(); await until(() => fresh.code !== undefined); assert.equal(gateway.isConnected(d.id), false);
      gateway.onApplicationBootstrap(); const restarted = connect({ ...d, token: exchanged.credential }); await ready(restarted);
      assert.equal(writes, 0);
    } else if (scenario === 'auth') {
      const d = await device('auth'); const auth = app.get(WebDisplayAuthService);
      await assert.rejects(() => auth.authenticate('other', d.token));
      for (const patch of [{ expiresAt: new Date(realNow() - 1) }, { expiresAt: null, revokedAt: new Date() }]) {
        await prisma.deviceCredential.updateMany({ where: { deviceId: d.id }, data: patch });
        const c = connect(d, { headers: { Cookie: 'inker_admin_session=not-device-auth' } });
        await until(() => c.code !== undefined); assert.equal(c.code, 4401);
      }
      await prisma.deviceCredential.updateMany({ where: { deviceId: d.id }, data: { revokedAt: null } });
      await prisma.device.update({ where: { id: d.id }, data: { isActive: false } });
      await assert.rejects(() => auth.authenticate(d.externalId, d.token)); assert.equal(writes, 0);
    } else if (scenario === 'render-order') {
      const d = await device('render-order');
      const client = connect(d); await ready(client);
      const presentations = () => client.messages.filter(message => message.type === 'presentation.changed');
      const fallback = presentations()[0].presentation;
      assert.equal(fallback.renderRevision, 0);
      await prisma.device.update({ where: { id: d.id }, data: { renderRevision: { increment: 1 } } });
      await gateway.pushPresentation(d.id);
      await until(() => presentations().length === 2);
      assert.equal(presentations()[1].presentation.revision, fallback.revision);
      assert.equal(presentations()[1].presentation.renderRevision, 1);
      const service = app.get(PresentationService);
      const original = service.getForDevice.bind(service);
      // Simulate a retry of an immutable outbox receipt captured before ready.
      service.getForDevice = async () => fallback;
      await gateway.pushPresentation(d.id);
      await sleep(50);
      assert.equal(presentations().length, 2);
      service.getForDevice = original;
      await gateway.pushPresentation(d.id);
      await sleep(50);
      assert.equal(presentations().length, 2);
      assert.equal(gateway.isConnected(d.id), true);
    } else if (scenario === 'limits') {
      const d = await device('limits');
      for (const kind of ['unknown', 'binary', 'size', 'flood']) {
        const c = connect(d); await ready(c);
        if (kind === 'unknown') c.ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'execute' }));
        if (kind === 'binary') c.ws.send(Buffer.from('{}'));
        if (kind === 'size') c.ws.send('x'.repeat(8193));
        if (kind === 'flood') for (let i = 0; i < 50; i++) c.ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'telemetry', payload: { width: 800 } }));
        await until(() => c.code !== undefined);
        assert.equal(c.code, kind === 'size' ? 1009 : kind === 'flood' ? 4429 : 4400);
      }
      for (const options of [{ origin: 'https://evil.example' }, { url: `${url}?credential=forbidden` }, { origin: 'null' }]) {
        const ws = new WebSocket(options.url ?? url, { origin: options.origin }); sockets.push(ws);
        const status = await new Promise(resolve => {
          ws.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.resume(); ws.terminate(); });
          ws.on('error', () => {});
        });
        assert.equal(status, 403);
      }
      const c = connect(d, { origin: `http://127.0.0.1:${app.getHttpServer().address().port}` }); await ready(c);
      assert.equal(gateway.isConnected(d.id), true);
    } else throw new Error('Unknown scenario');
    for (const token of tokens) assert.equal(output.includes(token), false);
    console.info(`WP-15 ${scenario}: passed`);
  } finally {
    Date.now = realNow;
    gateway.onApplicationShutdown(); for (const socket of sockets) socket.terminate();
    await app.close(); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
