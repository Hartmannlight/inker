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
const image = process.env.INKER_SMOKE_IMAGE;
if (typeof image !== 'string' || image.length > 255 || !/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(image))
  throw new Error('OUTBOX_FIXTURE_IMAGE_REQUIRED');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function tcpReady(targetPort) {
  return new Promise(resolve => {
    const socket = require('node:net').createConnection({ host: '127.0.0.1', port: targetPort });
    let settled = false;
    const finish = ready => { if (settled) return; settled = true; socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
async function until(predicate, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(25); }
  throw new Error(`Condition timed out at ${stage}`);
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
async function host() {
  const child = fork(require.resolve('./outbox-runtime.cjs'), [], { env: { ...process.env, DATABASE_URL: url,
    INKER_RENDER_CACHE_PATH: require('node:path').join(require('node:path').dirname(process.argv[2]), 'render-cache'),
    OUTBOX_REDIS_PORT: String(port), REDIS_PASSWORD: '' }, silent: true });
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
  return child.messages.find(m => m.id === id);
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
  await until(() => messages.length >= 1);
  return { socket, messages };
}
const DESIRED_EVENT = 'device.publication.desired-revision.changed';
async function latest(eventType = DESIRED_EVENT) {
  return p.outboxEvent.findFirstOrThrow({ where: { eventType }, orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }] });
}
async function delivered(eventType = DESIRED_EVENT) {
  const event = await latest(eventType);
  await until(async () => (await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status === 'delivered');
  return p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
}
const sequences = client => [...new Set(client.messages.map(message => message.revision))];
async function bothSequences(ca, cb, count) {
  await until(() => sequences(ca).length === count && sequences(cb).length === count);
  assert.deepEqual(sequences(ca), sequences(cb));
  for (const client of [ca, cb]) for (let index = 1; index < client.messages.length; index++) {
    const before = client.messages[index - 1], after = client.messages[index];
    assert.ok(after.revision > before.revision || (after.revision === before.revision && (after.renderRevision ?? 0) > (before.renderRevision ?? 0)),
      'Both adapters must deliver monotonically increasing desired/render versions');
  }
}
async function drain(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  // Reconcile first so a transient gap before render-request creation is not
  // mistaken for a drained outbox. No prior ready notification may consume a fault.
  for (const child of hosts) if (child.exitCode === null && child.signalCode === null && child.connected) await command(child, 'reconcile');
  try {
    await until(async () => await p.outboxEvent.count({ where: { status: { in: ['pending', 'processing'] } } }) === 0 &&
      await p.renderRequest.count({ where: { completedAt: null } }) === 0, Math.max(1, deadline - Date.now()));
  } catch (error) {
    const events = await p.outboxEvent.findMany({ where: { status: { not: 'delivered' } },
      select: { eventType: true, status: true, attempts: true, availableAt: true, claimUntil: true } });
    const unfinishedRenders = await p.renderRequest.count({ where: { completedAt: null } });
    throw new Error(`${error.message}; drain diagnostics=${JSON.stringify({ events, unfinishedRenders })}`);
  }
  assert.equal(await p.outboxEvent.count({ where: { status: 'dead-letter' } }), 0);
}
async function main() {
  try {
    // Only this disposable fixture is reachable through Docker's bridge; the
    // published port is restricted to host loopback. Production stays protected.
    docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:6379`, '--entrypoint', 'redis-server', image, '--bind', '0.0.0.0', '--requirepass', 'inker_redis', '--save', '', '--appendonly', 'no');
    progress('Redis readiness'); await until(() => tcpReady(port));
    progress('Redis monitor');
    const redis = new Redis({ host: '127.0.0.1', port, password: 'inker_redis', maxRetriesPerRequest: 1, connectTimeout: 1000 }); redis.on('error', () => {});
    monitor = await redis.monitor(); monitor.on('monitor', (_time, args) => { redisLogs += JSON.stringify(args); });
    monitor.on('error', () => {});
    progress('database fixture');
    const d = await p.device.create({ data: { name: 'outbox-device', externalId: 'outbox-device', profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    await p.deviceCredential.create({ data: { deviceId: d.id, kind: 'web-display', tokenHash: createHash('sha256').update(secret).digest('hex') } });
    progress('starting hosts');
    let a = await host(), b = await host();
    progress('worker connection readiness');
    await until(async () => (await command(a, 'worker-status')).workerReady && (await command(b, 'worker-status')).workerReady);
    await command(a, 'worker-connection-off');
    const unavailableWorker = await command(a, 'worker-status');
    assert.equal(unavailableWorker.redisReady, true, 'Publisher remains connected during worker-only fault');
    assert.equal(unavailableWorker.workerReady, false, 'Running worker with disconnected command client is not ready');
    await until(async () => (await command(b, 'worker-status')).background.workers === 1);
    await command(a, 'worker-connection-on');
    await until(async () => (await command(a, 'worker-status')).workerReady && (await command(b, 'worker-status')).background.workers === 2);
    let ca = await connect(a, d), cb = await connect(b, d);
    progress('design fanout');
    const design = await p.screenDesign.create({ data: { name: 'design' } });
    await p.deviceScreenAssignment.create({ data: { screenDesignId: design.id, deviceId: d.id } });
    await command(a, 'design', { designId: design.id });
    const designEvent = await delivered('screen_design:updated');
    // Draft notifications are durable but cannot implicitly publish.
    assert.equal(ca.messages.length, 1); assert.equal(cb.messages.length, 1);
    assert.equal(await p.outboxEvent.count({ where: { eventType: { not: 'maintenance.cleanup.due' } } }), 1);
    await command(a, 'publish', { deviceId: d.id }); await delivered();
    await bothSequences(ca, cb, 2); await drain();
    assert.equal(designEvent.eventType, 'screen_design:updated');
    progress('subscriber interruption');
    await command(b, 'subscriber-off');
    await command(a, 'publish', { deviceId: d.id }); await delivered();
    await bothSequences(ca, cb, 3); await drain();
    await command(b, 'subscriber-on');
    progress('retry');
    await drain();
    await command(a, 'fail-once'); await command(a, 'publish', { deviceId: d.id });
    const retried = await delivered(); assert.equal(retried.attempts, 2);
    await bothSequences(ca, cb, 4); await drain();
    progress('lost target ack');
    await command(a, 'lose-target-ack-once');
    await command(a, 'publish', { deviceId: d.id });
    const lostAck = await delivered(); assert.equal(lostAck.attempts, 2);
    await bothSequences(ca, cb, 5); await drain();
    progress('Redis outage and empty restart');
    docker('stop', '-t', '1', name);
    await command(a, 'publish', { deviceId: d.id });
    await until(async () => (await latest()).attempts >= 1);
    assert.notEqual((await latest()).status, 'delivered');
    docker('start', name); await delivered();
    await bothSequences(ca, cb, 6); await drain();
    progress('crash after commit');
    await command(a, 'pause'); await command(b, 'pause');
    await command(a, 'publish', { deviceId: d.id });
    assert.equal((await latest()).status, 'pending');
    a.kill('SIGKILL'); b.kill('SIGKILL');
    await until(() => a.exitCode !== null || a.signalCode !== null);
    a = await host(); await delivered();
    ca = await connect(a, d);
    await drain();
    progress('crash after dispatch before ack');
    await command(a, 'crash-before-ack');
    await command(a, 'publish', { deviceId: d.id });
    await until(() => a.exitCode === 73);
    const crashed = await latest(); assert.equal(crashed.status, 'processing');
    const revision = (await p.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision;
    await until(() => sequences(ca).length === 2);
    const recovering = await p.outboxEvent.findMany({ where: { status: { in: ['pending', 'processing'] } }, select: { eventId: true } });
    const recoveryStart = Date.now(), recoveryDeadline = recoveryStart + 100_000;
    a = await host();
    // Real wall-clock recovery only. A concurrently killed render has a 30s
    // BullMQ lock plus stalled-check cycles and a separate 30s SQLite lease;
    // measure their combined cost within one bounded 100s restart budget.
    await until(async () => (await p.outboxEvent.findUniqueOrThrow({ where: { eventId: crashed.eventId } })).status === 'delivered', Math.max(1, recoveryDeadline - Date.now()));
    assert.equal((await p.device.findUniqueOrThrow({ where: { id: d.id } })).presentationRevision, revision);
    progress('crash recovery draining renders');
    await drain(Math.max(1, recoveryDeadline - Date.now()));
    const recoveredEvents = await p.outboxEvent.findMany({ where: { eventId: { in: recovering.map(event => event.eventId) } },
      select: { eventType: true, attempts: true, status: true } });
    assert.ok(recoveredEvents.every(event => event.status === 'delivered'));
    console.info(`WP-19 overlapping render/delivery crash recovery: ${Date.now() - recoveryStart} ms, ${JSON.stringify(recoveredEvents)}`);
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
    progress('WP-18 durable playback through empty Redis restart');
    b = await host();
    ca = await connect(a, d); cb = await connect(b, d);
    await command(a, 'playback-start', { deviceId: d.id });
    const started = await p.playbackState.findUniqueOrThrow({ where: { deviceId: d.id } });
    docker('stop', '-t', '1', name);
    await sleep(2500);
    // Content reads remain stable; DB holds the due event while Redis is absent.
    assert.equal((await p.playbackState.findUniqueOrThrow({ where: { deviceId: d.id } })).version, 1);
    assert.ok(await p.outboxEvent.count({ where: { eventType: 'playback.transition.due', status: { in: ['pending', 'processing'] } } }));
    docker('start', name);
    await until(async () => (await p.playbackState.findUniqueOrThrow({ where: { deviceId: d.id } })).version === 2, 45_000);
    const advanced = await p.playbackState.findUniqueOrThrow({ where: { deviceId: d.id } });
    assert.notEqual(advanced.currentItemId, started.currentItemId);
    assert.equal(advanced.anchorAt.toISOString(), started.anchorAt.toISOString());
    assert.equal(advanced.nextTransitionAt, null);
    const sequence = (await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: d.id } })).desiredSequence;
    await until(() => ca.messages.at(-1).revision === sequence && cb.messages.at(-1).revision === sequence);
    await until(async () => await p.outboxEvent.count({ where: { eventType: 'playback.transition.due', status: 'delivered' } }) === 1);
    assert.equal(await p.outboxEvent.count({ where: { status: 'dead-letter' } }), 0);
    assert.equal(logs.includes(secret), false);
    assert.equal(redisLogs.includes(secret), false);
    console.info('WP-18 scheduled transition, Redis loss/recovery, two adapter processes and monotonic delivery: passed');
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
