const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { WebSocket } = require('ws');
const name = `inker-wp16-redis-${randomUUID().slice(0, 8)}`;
const port = 18716;
const url = `file:${process.argv[2].replaceAll('\\', '/')}`;
const p = new PrismaClient({ datasources: { db: { url } } });
const hosts = [], sockets = [];
let logs = '', redisLogs = '', stage = 'start', monitor;
const progress = value => { stage = value; fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[2]), 'progress.txt'), value); };
const fs = require('node:fs');
const secret = randomBytes(32).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(25); }
  throw new Error(`Condition timed out at ${stage}`);
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
async function host() {
  const child = fork(require.resolve('./outbox-runtime.cjs'), [], { env: { ...process.env, DATABASE_URL: url, OUTBOX_REDIS_PORT: String(port), REDIS_PASSWORD: '' }, silent: true });
  hosts.push(child); child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  child.messages = []; child.on('message', m => child.messages.push(m));
  await until(() => child.messages.some(m => m.ready) || child.exitCode !== null);
  assert.equal(child.exitCode, null, logs);
  child.url = child.messages.find(m => m.ready).url;
  return child;
}
async function command(child, command, data = {}) {
  const id = randomUUID(); child.send({ id, command, ...data });
  await until(() => child.messages.some(m => m.id === id));
  assert.equal(child.messages.find(m => m.id === id).error, undefined);
}
async function connect(child, d) {
  const socket = new WebSocket(child.url); sockets.push(socket);
  const messages = []; socket.on('error', () => {});
  socket.on('open', () => socket.send(JSON.stringify({ protocolVersion: '1.0', type: 'authenticate', externalId: d.externalId, token: secret })));
  socket.on('message', raw => {
    assert.equal(raw.toString().includes(secret), false);
    const m = JSON.parse(raw.toString());
    if (m.type === 'presentation.changed') messages.push(m.presentation);
    if (m.type === 'ping') socket.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: m.nonce }));
  });
  await until(() => messages.length === 1);
  return { socket, messages };
}
async function latest() { return p.outboxEvent.findFirstOrThrow({ orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }] }); }
async function delivered() { await until(async () => (await latest()).status === 'delivered'); return latest(); }
async function main() {
  try {
    // Only this disposable fixture is reachable through Docker's bridge; the
    // published port is restricted to host loopback. Production stays protected.
    docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:6379`, '--entrypoint', 'redis-server', 'inker:wp15-test', '--bind', '0.0.0.0', '--requirepass', 'inker_redis', '--save', '', '--appendonly', 'no');
    progress('Redis monitor');
    const redis = new Redis({ host: '127.0.0.1', port, password: 'inker_redis', maxRetriesPerRequest: 1, connectTimeout: 1000 }); redis.on('error', () => {});
    monitor = await redis.monitor(); monitor.on('monitor', (_time, args) => { redisLogs += JSON.stringify(args); });
    monitor.on('error', () => {});
    progress('database fixture');
    const d = await p.device.create({ data: { name: 'outbox-device', externalId: 'outbox-device', profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    await p.deviceCredential.create({ data: { deviceId: d.id, kind: 'web-display', tokenHash: createHash('sha256').update(secret).digest('hex') } });
    progress('starting hosts');
    let a = await host(), b = await host();
    let ca = await connect(a, d), cb = await connect(b, d);
    progress('design fanout');
    const design = await p.screenDesign.create({ data: { name: 'design' } });
    await p.deviceScreenAssignment.create({ data: { screenDesignId: design.id, deviceId: d.id } });
    await command(a, 'design', { designId: design.id });
    const designEvent = await delivered();
    await until(() => ca.messages.length === 2 && cb.messages.length === 2);
    assert.equal(await p.outboxEvent.count(), 1);
    assert.equal(ca.messages[1].revision, cb.messages[1].revision);
    assert.equal(designEvent.eventType, 'screen_design:updated');
    progress('subscriber interruption');
    await command(b, 'subscriber-off');
    await command(a, 'notify', { deviceId: d.id }); await delivered();
    await until(() => ca.messages.length === 3 && cb.messages.length === 3);
    await command(b, 'subscriber-on');
    progress('retry');
    await command(a, 'fail-once'); await command(a, 'notify', { deviceId: d.id });
    const retried = await delivered(); assert.equal(retried.attempts, 2);
    await until(() => ca.messages.length === 4 && cb.messages.length === 4);
    assert.equal(ca.messages[3].revision, cb.messages[3].revision);
    progress('lost target ack');
    await command(a, 'lose-target-ack-once');
    await command(a, 'notify', { deviceId: d.id });
    const lostAck = await delivered(); assert.equal(lostAck.attempts, 2);
    await until(() => ca.messages.length === 5 && cb.messages.length === 5);
    assert.equal(ca.messages[4].revision, cb.messages[4].revision);
    progress('Redis outage and empty restart');
    docker('stop', '-t', '1', name);
    await command(a, 'notify', { deviceId: d.id });
    await until(async () => (await latest()).attempts >= 1);
    assert.notEqual((await latest()).status, 'delivered');
    docker('start', name); await delivered();
    await until(() => ca.messages.length === 6 && cb.messages.length === 6);
    progress('crash after commit');
    await command(a, 'pause'); await command(b, 'pause');
    await command(a, 'notify', { deviceId: d.id });
    assert.equal((await latest()).status, 'pending');
    a.kill('SIGKILL'); b.kill('SIGKILL');
    await until(() => a.exitCode !== null || a.signalCode !== null);
    a = await host(); await delivered();
    ca = await connect(a, d);
    progress('crash after dispatch before ack');
    await command(a, 'crash-before-ack');
    await command(a, 'notify', { deviceId: d.id });
    await until(() => a.exitCode === 73);
    const crashed = await latest(); assert.equal(crashed.status, 'processing');
    const revision = (await p.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision;
    assert.equal(ca.messages.length, 2);
    a = await host();
    // Real wall-clock lease expiration, no synthetic time or manual DB recovery.
    await until(async () => (await p.outboxEvent.findUniqueOrThrow({ where: { eventId: crashed.eventId } })).status === 'delivered', 40_000);
    assert.equal((await p.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision, revision);
    progress('throughput');
    const count = 100, start = Date.now();
    for (let i = 0; i < count; i++) await command(a, 'notify', { deviceId: d.id });
    await until(async () => await p.outboxEvent.count({ where: { status: { in: ['pending', 'processing'] } } }) === 0, 30_000);
    const elapsed = Date.now() - start;
    assert.equal(await p.outboxEvent.count({ where: { status: 'dead-letter' } }), 0);
    assert.equal(logs.includes(secret), false); assert.equal(logs.includes('credential-test-secret-do-not-log'), false);
    assert.equal(redisLogs.includes(secret), false); assert.equal(redisLogs.includes('credential-test-secret-do-not-log'), false);
    assert.equal(JSON.stringify(await p.outboxEvent.findMany()).includes(secret), false);
    console.info(`WP-16 measured: ${count} events in ${elapsed} ms (${(count * 1000 / elapsed).toFixed(1)} events/s), real Redis/BullMQ/SQLite, offline adapter, command roundtrips included`);
    console.info('WP-16 Redis/fanout/subscriber/retry/crash/restart: passed');
  } finally {
    monitor?.disconnect();
    for (const socket of sockets) socket.terminate();
    for (const child of hosts) if (child.exitCode === null && child.signalCode === null) {
      try { await command(child, 'stop'); } catch { child.kill('SIGKILL'); }
    }
    await p.$disconnect();
    try { docker('rm', '-f', '-v', name); } catch {}
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack); console.error(logs.slice(-12000)); process.exit(1); });
