// bun ./test/operations-container-fixture.cjs setup|smoke|cleanup
// One disposable Home container. setup leaves browser QA ready; smoke always removes its resources.
// Credentials and pairing codes are written only to the ignored state file, never stdout.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { MIMEType } = require('node:util');
const { WebSocket } = require('ws');
const { parseOperationsStatus, parseDeviceServerMessage } = require('../../contracts/dist/index.cjs');
const runtime = require('./fixtures/operations-fixture-runtime.cjs');
const { statePath, base, check, save, load, newState, wait, request, json, login, db,
  createInfrastructure, ready, service, remember, noSecrets, logs, audit, cleanup } = runtime;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'initialize';
let failedHttp;

function httpFailure(response, surface) {
  let contentType = 'unknown';
  try {
    const type = new MIMEType(response.headers['content-type']);
    if (['application/json', 'text/plain', 'text/html'].includes(type.essence)) {
      contentType = type.essence;
      if (type.params.get('charset')?.toLowerCase() === 'utf-8') contentType += '; charset=utf-8';
      if (type.params.get('version') === '0.0.4') contentType += '; version=0.0.4';
    }
  } catch { /* Never print an arbitrary header value. */ }
  return { surface: ['operations', 'metrics'].includes(surface) ? surface : 'unknown',
    status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    contentType };
}
function diagnosticLogs(rows) {
  const codes = ['REQUEST_COMPLETED', 'REQUEST_FAILED', 'JOB_STARTED', 'JOB_COMPLETED', 'JOB_FAILED', 'JOB_STALE',
    'DEVICE_CONNECTED', 'DEVICE_DISCONNECTED', 'DEVICE_DELIVERED', 'DEVICE_DELIVERY_FAILED',
    'DEPENDENCY_DEGRADED', 'DEPENDENCY_RECOVERED', 'WORKER_STARTED', 'OUTBOX_POLL_FAILED', 'OUTBOX_CONSUMER_FAILED',
    'OUTBOX_REDIS_UNAVAILABLE'];
  return rows.filter(row => codes.includes(row.code) && ['api', 'worker'].includes(row.role))
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0)).slice(-24).map(row => ({
      code: row.code, role: row.role,
      ...(Number.isInteger(row.statusCode) && row.statusCode >= 100 && row.statusCode <= 599 ? { statusCode: row.statusCode } : {}),
      ...(typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 86400000
        ? { durationMs: row.durationMs } : {}),
    }));
}

function isMetricsContentType(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const type = new MIMEType(value);
    return type.essence === 'text/plain' && type.params.get('version') === '0.0.4'
      && type.params.get('charset')?.toLowerCase() === 'utf-8';
  } catch { return false; }
}
function failureDiagnostic(error) {
  const code = error instanceof Error && /^FIXTURE_[A-Z_]{1,64}$/.test(error.message)
    ? error.message : 'FIXTURE_ASSERTION_FAILED';
  // Assertion headers can embed expected/actual credentials. Only emit exact
  // fixture basenames and numeric locations, never the message, stack or values.
  const frames = [];
  if (error instanceof Error && typeof error.stack === 'string') {
    for (const line of error.stack.split('\n')) {
      if (!/^\s+at\s/.test(line)) continue;
      const match = line.match(/(?:[/\\])(operations-container-fixture\.cjs|operations-fixture-runtime\.cjs):(\d+):(\d+)\)?\s*$/);
      if (match) frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
      if (frames.length === 6) break;
    }
  }
  return { code, stage, frames, ...(failedHttp ? { http: failedHttp } : {}) };
}

async function operations(state) {
  const response = await request(state, '/api/operations', { admin: true });
  if (response.status !== 200) failedHttp = httpFailure(response, 'operations');
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  noSecrets(state, response.bytes.toString('utf8'));
  const parsed = parseOperationsStatus(json(response)); check(parsed.success, 'FIXTURE_OPERATIONS_INVALID'); return parsed.data;
}
async function metricText(state) {
  const response = await request(state, '/api/operations/metrics', { admin: true });
  if (response.status !== 200) failedHttp = httpFailure(response, 'metrics');
  assert.equal(response.status, 200); assert.ok(isMetricsContentType(response.headers['content-type']));
  assert.equal(response.headers['cache-control'], 'no-store'); noSecrets(state, response.bytes.toString('utf8'));
  return response.bytes.toString('utf8');
}
async function waitOperations(state, predicate, milliseconds) {
  let value; await wait(async () => { value = await operations(state); return predicate(value); }, milliseconds); return value;
}
async function source(state) {
  const response = await request(state, `/api/sources/${state.sourceId}`, { admin: true });
  assert.equal(response.status, 200); noSecrets(state, response.bytes.toString('utf8')); return json(response);
}
async function createDevice(state, key, name, exchange) {
  const response = await request(state, '/api/devices', { method: 'POST', admin: true, data: { name, deviceType: 'web-display' } });
  assert.equal(response.status, 201); const device = json(response);
  remember(state, device.pairingToken); remember(state, device.apiKey);
  const enrolled = await request(state, `/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true, data: {} });
  assert.equal(enrolled.status, 201); const enrollment = json(enrolled); remember(state, enrollment.code);
  state[key] = { id: device.id, externalId: device.externalId,
    url: `${base}/display/${device.externalId}`, pairingCode: enrollment.code, pairingExpiresAt: enrollment.expiresAt };
  if (exchange) {
    const response = await request(state, '/api/device-enrollments/exchange', { method: 'POST', data: { code: enrollment.code } });
    assert.equal(response.status, 200); const credentials = json(response); remember(state, credentials.credential);
    state[key].credential = credentials.credential; state[key].credentialId = credentials.credentialId;
    delete state[key].pairingCode;
  }
  save(state);
}
async function rendered(state, deviceId) {
  let result;
  await wait(() => {
    result = db(state, 'p.renderBinding.findFirst({where:{deviceId:input.deviceId},include:{ready:true,device:{include:{publicationState:true}}}})', { deviceId });
    return result?.ready?.completedAt && result.readyKey === result.desiredKey
      && result.ready.publicationRevisionId === result.device.publicationState?.desiredPublicationRevisionId;
  });
  return result;
}
async function cached(state) {
  const auth = { Authorization: `Bearer ${state.device.credential}` };
  const response = await request(state, `/api/web-displays/${state.device.externalId}/presentation`, { headers: auth });
  assert.equal(response.status, 200); const manifest = json(response);
  const parsed = parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: manifest });
  check(parsed.success, 'FIXTURE_PRESENTATION_INVALID');
  check(manifest.content.url.startsWith(`/api/web-displays/${state.device.externalId}/artifacts/`), 'FIXTURE_ARTIFACT_NOT_LOCAL');
  const artifact = await request(state, manifest.content.url, { headers: auth }); assert.equal(artifact.status, 200);
  const hash = sha256(artifact.bytes); assert.equal(hash, manifest.content.url.split('/').pop());
  const conditional = await request(state, manifest.content.url, { headers: { ...auth, 'If-None-Match': artifact.headers.etag } });
  assert.equal(conditional.status, 304); assert.equal(conditional.bytes.length, 0);
  return { manifest, hash };
}
function connect(state) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/device-connect', { origin: base });
  const live = { ws, messages: [], closed: false, failed: false };
  ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'authenticate', externalId: state.device.externalId,
    token: state.device.credential, viewport: { width: 800, height: 480 } })));
  ws.on('message', bytes => {
    try {
      noSecrets(state, bytes.toString()); const parsed = parseDeviceServerMessage(JSON.parse(bytes.toString()));
      check(parsed.success, 'FIXTURE_WS_MESSAGE_INVALID'); const message = parsed.data; live.messages.push(message);
      if (message.type === 'ping') ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: message.nonce }));
      // Deliberately no render/display acknowledgement: only actual receipt is tested.
    } catch { live.failed = true; ws.close(); }
  });
  ws.on('error', () => { live.failed = true; }); ws.on('close', () => { live.closed = true; }); return live;
}
async function close(live) {
  if (!live || live.closed) return;
  live.ws.close(); try { await wait(() => live.closed, 5000); } finally { live.ws.terminate(); }
}
async function publish(state, expectedRevision, draft) {
  const supplied = randomUUID();
  const response = await request(state, '/api/publications/wp28-operations/publish', { method: 'POST', admin: true,
    headers: { 'X-Correlation-ID': supplied }, data: { idempotencyKey: randomUUID(), expectedRevision,
      deviceIds: [state.device.id, state.browser.id], draft } });
  assert.equal(response.status, 201); const correlationId = response.headers['x-correlation-id'];
  assert.match(correlationId, uuid); assert.notEqual(correlationId, supplied);
  const rows = db(state, 'p.outboxEvent.findMany({where:{correlationId:input.id},select:{eventId:true,eventType:true,correlationId:true,status:true}})', { id: correlationId });
  assert.ok(rows.length >= 2); assert.ok(rows.every(row => row.correlationId === correlationId));
  return { correlationId, result: json(response), eventIds: rows.map(row => row.eventId) };
}
async function prepare(state) {
  stage = 'create one labelled Home container'; createInfrastructure(state); await ready(state); await login(state);
  await waitOperations(state, value => value.health.workers.status === 'ready' && value.renderCache.sampledAt !== null);
  stage = 'synthetic encrypted source and enrolled display';
  state.sourceInput = { protocolVersion: '1.0', name: 'WP28 visible slow source', connectorType: 'fixture', schemaVersion: '1',
    configuration: { data: { fixtureArtifacts: ['mono-800x480-white-png'] } },
    refreshIntervalSeconds: 3600, timeoutMs: 4000, concurrencyGroup: 'wp28-fixture' };
  const secret = randomBytes(32).toString('hex'); remember(state, secret);
  const response = await request(state, '/api/sources', { method: 'POST', admin: true, data: { ...state.sourceInput, secret } });
  assert.equal(response.status, 201); noSecrets(state, response.bytes.toString()); state.sourceId = json(response).definition.sourceDefinitionId; save(state);
  await wait(async () => (await source(state)).snapshot?.freshness.state === 'fresh');
  await createDevice(state, 'device', 'WP28 diagnostic transport', true);
  await createDevice(state, 'browser', 'WP28 browser verification', false);
  const snapshot = (await source(state)).snapshot;
  state.initialPublish = await publish(state, 0, { sourceSnapshotId: snapshot.snapshotId });
  await rendered(state, state.device.id); await rendered(state, state.browser.id);
  state.baseline = await cached(state); state.ready = true; save(state); audit(state);
}
async function authorization(state) {
  stage = 'operations admin auth and device credential denial';
  for (const path of ['/api/operations', '/api/operations/metrics']) {
    assert.equal((await request(state, path)).status, 401);
    assert.equal((await request(state, path, { headers: { Authorization: `Bearer ${state.device.credential}` } })).status, 401);
  }
  await operations(state); await metricText(state);
  const synthetic = randomBytes(32).toString('hex'); remember(state, synthetic); save(state);
  const denied = await request(state, '/api/operations', { headers: { 'X-Device-Key': synthetic, Cookie: `session=${synthetic}` } });
  assert.equal(denied.status, 401); noSecrets(state, denied.bytes.toString());
}
async function slowJob(state) {
  stage = 'real slow source, failed duration histogram and JSON logs';
  const before = await source(state);
  const response = await request(state, `/api/sources/${state.sourceId}`, { method: 'PUT', admin: true,
    data: { ...state.sourceInput, expectedDefinitionVersion: before.definition.definitionVersion,
      connectorType: 'slow', configuration: { data: state.sourceInput.configuration.data, delayMs: 60000 } } });
  assert.equal(response.status, 200); const eventId = json(response).eventId;
  const correlationId = response.headers['x-correlation-id']; assert.match(correlationId, uuid);
  const running = await waitOperations(state, value => value.queues.some(row => row.queue === 'source-refresh' && row.processing > 0));
  assert.ok(running.sources.items.some(row => row.sourceDefinitionId === state.sourceId));
  assert.deepEqual(await cached(state), state.baseline);
  const failed = await waitOperations(state, value => value.sources.items.some(row => row.sourceDefinitionId === state.sourceId && row.errorCode === 'SOURCE_TIMEOUT'));
  assert.equal(failed.status, 'degraded'); assert.ok(failed.reasons.includes('SOURCE_ERRORS'));
  const sourceRow = failed.sources.items.find(row => row.sourceDefinitionId === state.sourceId);
  assert.equal(sourceRow.freshness, 'stale'); assert.ok(sourceRow.lastSuccessAt); assert.ok(sourceRow.lastAttemptAt);
  await wait(async () => {
    const text = await metricText(state);
    const count = text.match(/statuspanel_job_duration_seconds_count\{queue="source-refresh",outcome="failure"\} ([\d.]+)/);
    const sum = text.match(/statuspanel_job_duration_seconds_sum\{queue="source-refresh",outcome="failure"\} ([\d.]+)/);
    return count && Number(count[1]) >= 1 && sum && Number(sum[1]) >= 3.8;
  });
  const recorded = logs(state);
  assert.ok(recorded.some(row => row.code === 'REQUEST_COMPLETED' && row.role === 'api' && row.correlationId === correlationId));
  assert.ok(recorded.some(row => row.code === 'JOB_STARTED' && row.role === 'worker' && row.eventId === eventId && row.correlationId === correlationId));
  assert.ok(recorded.some(row => row.code === 'JOB_FAILED' && row.role === 'worker' && row.eventId === eventId
    && row.correlationId === correlationId && row.sourceDefinitionId === state.sourceId && row.durationMs >= 3800));
  const stored = db(state, 'p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId}})', { eventId });
  assert.equal(stored.correlationId, correlationId); assert.equal(JSON.parse(stored.lastError).code, 'SOURCE_TIMEOUT');
  const current = await source(state);
  const restored = await request(state, `/api/sources/${state.sourceId}`, { method: 'PUT', admin: true,
    data: { ...state.sourceInput, expectedDefinitionVersion: current.definition.definitionVersion } });
  assert.equal(restored.status, 200);
  await waitOperations(state, value => value.sources.items.some(row => row.sourceDefinitionId === state.sourceId && row.freshness === 'fresh' && row.errorCode === null));
}
async function availableDuringOutage(state, baseline) {
  const live = await request(state, '/live'); assert.equal(live.status, 200); assert.equal(json(live).status, 'alive');
  const ready = await request(state, '/ready'); assert.equal(ready.status, 200); assert.equal(json(ready).status, 'ready');
  assert.equal(json(ready).background.status, 'degraded');
  assert.equal((await request(state, '/api/devices', { admin: true })).status, 200);
  assert.deepEqual(await cached(state), baseline);
  const metrics = await metricText(state);
  assert.match(metrics, /statuspanel_worker_sample_available 0/);
  assert.doesNotMatch(metrics, /^statuspanel_job_duration_seconds_(?:bucket|sum|count)\{/m);
  assert.doesNotMatch(metrics, /^statuspanel_render_cache_total\{/m);
}
async function outagesAndCorrelation(state, live) {
  stage = 'worker stop, unknown measurements and intact cached API';
  await service(state, 'worker', false);
  const down = await waitOperations(state, value => value.health.workers.status === 'unavailable' && value.renderCache.sampledAt === null);
  assert.equal(down.status, 'degraded'); assert.ok(down.reasons.includes('WORKER_UNAVAILABLE')); assert.ok(down.reasons.includes('METRICS_UNAVAILABLE'));
  assert.equal(down.renderCache.hits, null); await availableDuringOutage(state, state.baseline);
  stage = 'durable correlated publish while worker stopped';
  const publication = await publish(state, 1, { fixtureArtifacts: ['mono-800x480-black-bmp'] });
  assert.ok(db(state, 'p.outboxEvent.count({where:{correlationId:input.id,status:"pending"}})', { id: publication.correlationId }) >= 2);
  stage = 'worker restart, persisted correlation and actual WebSocket send';
  await service(state, 'worker', true);
  await waitOperations(state, value => value.health.workers.status === 'ready' && value.renderCache.sampledAt !== null);
  await rendered(state, state.device.id); const updated = await cached(state); assert.notEqual(updated.hash, state.baseline.hash);
  await wait(() => !live.failed && live.messages.some(message => message.type === 'presentation.changed'
    && message.presentation.content.url === updated.manifest.content.url));
  await wait(() => {
    const rows = logs(state);
    return rows.some(row => row.code === 'JOB_COMPLETED' && row.role === 'worker' && row.correlationId === publication.correlationId)
      && rows.some(row => row.code === 'DEVICE_DELIVERED' && row.role === 'api' && row.correlationId === publication.correlationId
        && row.deviceId === state.device.id && typeof row.eventId === 'string' && typeof row.deliveryId === 'string');
  });
  const outbox = db(state, 'p.outboxEvent.findMany({where:{correlationId:input.id}})', { id: publication.correlationId });
  assert.ok(outbox.some(row => row.status === 'delivered'));
  const view = await operations(state), device = view.devices.items.find(row => row.deviceId === state.device.id);
  assert.equal(device.publicationState, 'pending'); assert.equal(device.acknowledgedAt, null);
  stage = 'Redis stop, unknown worker count and cache availability';
  await service(state, 'redis', false);
  const redisDown = await waitOperations(state, value => value.health.redis === 'unavailable' && value.health.workers.status === 'unknown');
  assert.equal(redisDown.status, 'degraded'); assert.equal(redisDown.health.workers.count, null);
  assert.equal(redisDown.health.workers.sampledAt, null); assert.equal(redisDown.renderCache.sampledAt, null);
  assert.ok(redisDown.reasons.includes('QUEUE_UNAVAILABLE')); await availableDuringOutage(state, updated);
  stage = 'Redis recovery with real worker samples';
  await service(state, 'redis', true);
  await waitOperations(state, value => value.health.redis === 'ready' && value.health.workers.status === 'ready' && value.renderCache.sampledAt !== null);
  assert.deepEqual(await cached(state), updated); assert.match(await metricText(state), /statuspanel_worker_sample_available 1/);
}
async function smoke(state) {
  let live;
  try {
    await authorization(state);
    stage = 'connected display and last activity'; live = connect(state);
    await wait(() => !live.failed && live.messages.some(message => message.type === 'presentation.changed'));
    const connected = await waitOperations(state, value => value.devices.items.some(row => row.deviceId === state.device.id
      && row.connection === 'connected' && row.lastSeenAt !== null && row.lastConnectedAt !== null));
    assert.ok(connected.websocket.authenticatedConnections >= 1);
    await slowJob(state); await outagesAndCorrelation(state, live);
    stage = 'disconnected display retains last successful activity'; await close(live);
    const disconnected = await waitOperations(state, value => value.devices.items.some(row => row.deviceId === state.device.id && row.connection === 'disconnected'));
    const device = disconnected.devices.items.find(row => row.deviceId === state.device.id);
    assert.ok(device.lastSeenAt); assert.ok(device.lastConnectedAt); assert.equal(device.acknowledgedAt, null);
    assert.equal(disconnected.status, 'degraded'); assert.ok(disconnected.reasons.includes('STALE_DEVICES'));
    const rows = logs(state);
    assert.ok(rows.some(row => row.code === 'DEVICE_CONNECTED' && row.deviceId === device.deviceId));
    assert.ok(rows.some(row => row.code === 'DEVICE_DISCONNECTED' && row.deviceId === device.deviceId));
    assert.match(await metricText(state), /statuspanel_websocket_events_total\{event="closed"\} [1-9]\d*/);
    stage = 'synthetic secrets absent from sampled logs and durable records'; audit(state);
  } finally { await close(live); }
}
async function main() {
  const action = process.argv[2]; check(['setup', 'smoke', 'cleanup'].includes(action), 'FIXTURE_ACTION_INVALID');
  if (action === 'cleanup') {
    if (existsSync(statePath)) await cleanup(load()); console.log('WP28 owned fixture cleanup complete'); return;
  }
  const state = newState(); let retain = false;
  try {
    await prepare(state);
    if (action === 'setup') {
      retain = true;
      console.log(JSON.stringify({ base, operations: `${base}/operations`, display: state.browser.url, statePath,
        note: 'Admin credentials and the unconsumed browser pairing code are only in the ignored state file.' }));
    } else {
      await smoke(state);
    }
  } catch (error) {
    let recentLogs;
    try { recentLogs = diagnosticLogs(logs(state)); }
    catch { recentLogs = 'unavailable'; }
    console.error(JSON.stringify({ ...failureDiagnostic(error), phase: 'beforeCleanup', recentLogs }));
    throw error;
  } finally { if (!retain) await cleanup(state); }
  if (action === 'smoke') console.log('WP28 real auth, slow source, JSON/correlation, WS send, disconnection, worker/Redis degradation and recovery passed; own resources removed');
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify(failureDiagnostic(error))); process.exitCode = 1;
});
module.exports = { operations, metricText, prepare, smoke, isMetricsContentType, failureDiagnostic, httpFailure, diagnosticLogs };
