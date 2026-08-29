// Real combined Foundation gate. Run only with an explicitly built production image.
// Reuses the WP27 TLS infrastructure/ownership checks, but runs simultaneous WP29 workloads.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { parseDeviceServerMessage, parseOperationsStatus, parsePresentationManifest, parseTimerFeed } = require('../../contracts/dist/index.cjs');
const fixture = require('./remote-container-fixture.cjs');
const infra = require('./fixtures/remote-fixture-runtime.cjs');
const r = require('./fixtures/foundation-load-runtime.cjs');
const limits = Object.freeze({ displayP95Ms: 500, displayMaxMs: 2000, controlP95Ms: 1000,
  controlMaxMs: 5000, queueAgeSeconds: 30, renderMs: 10000, recoveryMs: 90000,
  memoryBytes: 1200 * 1024 * 1024, stableSeconds: 60, recoveryRepeats: 3 });
const actions = ['create', 'pause', 'resume', 'cancel', 'acknowledge'].map(action => ({ action: `timer.${action}`, payloadSchemaVersion: '1.0' }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pairingRateLimitRetries = 3;
const pairingRateLimitBudgetMs = 130_000;
let stage = 'initialize';
let httpFailure;
let lastPhaseResult;
const reportPath = path.resolve(__dirname, '../../.tmp/foundation-load-result.json');
function saveReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const bytes = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(path.resolve(path.dirname(reportPath), `foundation-load-${report.runId}-result.json`), bytes);
  writeFileSync(reportPath, bytes);
}
function expectStatus(response, expected, surface) {
  if (response.status !== expected) httpFailure = { status: response.status, expected, surface };
  assert.equal(response.status, expected);
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null; }
function summary(values) { return { count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: values.length ? Math.max(...values) : null }; }
function attachLiveState(state) {
  // Infrastructure persists state during remote sync. Live sockets/promises are
  // process-local and must never enter that JSON recovery file.
  Object.defineProperties(state, {
    live: { value: [], writable: true }, touchPending: { value: undefined, writable: true },
    leaseRecovery: { value: new Map() }, leaseRecoveryRecords: { value: [] },
    reconnectTimer: { value: undefined, writable: true }, reconnectRunning: { value: undefined, writable: true },
    reconnectFailure: { value: undefined, writable: true },
    reconnectPaused: { value: false, writable: true },
    shuttingDown: { value: false, writable: true },
  });
  return state;
}
async function exchangeEnrollmentWithRateLimit(state, code, completedClients, options = {}) {
  const requestFn = options.requestFn ?? r.request;
  const sleepFn = options.sleepFn ?? sleep;
  const logFn = options.logFn ?? console.log;
  const nowFn = options.nowFn ?? (() => performance.now());
  const startedAt = nowFn();
  let response;
  for (let retry = 0; retry <= pairingRateLimitRetries; retry++) {
    response = await requestFn(state, '/api/device-enrollments/exchange', { method: 'POST', data: { code } });
    if (response.status !== 429) return response;
    if (retry === pairingRateLimitRetries) throw new Error('FOUNDATION_PAIRING_RATE_LIMIT_TIMEOUT');
    const rawRetryAfter = response.headers['retry-after'];
    assert.ok(typeof rawRetryAfter === 'string' && /^\d+$/.test(rawRetryAfter), 'FIXTURE_RETRY_AFTER_INVALID');
    const seconds = Number(rawRetryAfter);
    assert.ok(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 60, 'FIXTURE_RETRY_AFTER_INVALID');
    const delayMs = (seconds + 1) * 1000 + 250;
    if (nowFn() - startedAt + delayMs > pairingRateLimitBudgetMs) throw new Error('FOUNDATION_PAIRING_RATE_LIMIT_TIMEOUT');
    state.pairingRateLimitedWaits++;
    logFn(JSON.stringify({ runId: state.runId, stage: 'pairing-rate-limit-wait', completedClients, seconds, retry: retry + 1 }));
    // Retry-After is integer-valued and can round down close to the window edge.
    // A fixed margin plus a one-second minimum avoids retrying in the same bucket.
    await sleepFn(delayMs);
  }
  throw new Error('FOUNDATION_PAIRING_RATE_LIMIT_TIMEOUT');
}
function diagnose(error) {
  const frame = typeof error?.stack === 'string' && error.stack.match(/(foundation-load(?:-runtime)?\.cjs):(\d+):(\d+)/);
  return { result: 'failed', stage,
    code: typeof error?.message === 'string' && /^(?:FIXTURE|FOUNDATION)_[A-Z_]+$/.test(error.message) ? error.message : 'FOUNDATION_ASSERTION_FAILED',
    ...(httpFailure ? { http: httpFailure } : {}),
    ...(Number.isFinite(error?.actual) && Number.isFinite(error?.expected) ? { actual: error.actual, expected: error.expected } : {}),
    ...(frame ? { file: frame[1], line: Number(frame[2]), column: Number(frame[3]) } : {}) };
}
async function saveFailureDiagnostics(state) {
  const output = await r.exec(state, ['bun', '-e', `const fs=require('node:fs');const dir='/app/logs';const chunks=[];let size=0;
    if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).sort()){
      const file=dir+'/'+name;if(!fs.statSync(file).isFile())continue;const bytes=fs.readFileSync(file);size+=bytes.length;
      if(size>8*1024*1024)throw new Error('FOUNDATION_LOG_LIMIT');chunks.push('===== '+name+' =====\\n',bytes.toString(),'\\n');
    }process.stdout.write(chunks.join(''));`]);
  r.noSecrets(state, output);
  const failureLogPath = path.resolve(__dirname, `../../.tmp/foundation-load-${state.runId}-failure.log`);
  writeFileSync(failureLogPath, output);
  return { file: path.basename(failureLogPath), bytes: Buffer.byteLength(output), sha256: hash(output) };
}
function assertLiveHealthy(state) {
  if (state.reconnectFailure) throw state.reconnectFailure;
  for (const outage of state.leaseRecovery?.values?.() ?? [])
    if (performance.now() - outage.firstClosedAt > limits.recoveryMs) throw new Error('FOUNDATION_DELIVERY_LEASE_RECOVERY_TIMEOUT');
  const index = (state.live ?? []).findIndex(live => live.failed || (live.closed && !live.expectedClose && !live.reconnectPending));
  if (index >= 0) {
    const error = new Error(state.live[index].failure?.code ?? 'FOUNDATION_WEBSOCKET_FAILED');
    error.liveIndex = index; throw error;
  }
}
function isRecoverableDeliveryLeaseClose(code, reason) {
  return code === 1011 && Buffer.isBuffer(reason) && reason.equals(Buffer.from('Delivery lease expired'));
}
function deliveryLeaseBackoffMs(attempts) { return Math.min(30_000, 1000 * 2 ** Math.min(15, attempts)); }
function recordDeliveryLeaseClose(state, clientIndex, now = performance.now()) {
  let outage = state.leaseRecovery.get(clientIndex);
  if (!outage) {
    outage = { clientIndex, firstClosedAt: now, attempts: 0, nextAttemptAt: now + deliveryLeaseBackoffMs(0) };
    state.leaseRecovery.set(clientIndex, outage);
  } else outage.nextAttemptAt = now + deliveryLeaseBackoffMs(outage.attempts);
  return outage;
}
function completeDeliveryLeaseRecovery(state, clientIndex, now = performance.now()) {
  const outage = state.leaseRecovery.get(clientIndex);
  if (!outage) return null;
  const elapsedMs = now - outage.firstClosedAt;
  if (elapsedMs > limits.recoveryMs) throw new Error('FOUNDATION_DELIVERY_LEASE_RECOVERY_TIMEOUT');
  const record = { clientIndex, attempts: outage.attempts, elapsedMs };
  state.leaseRecoveryRecords.push(record); state.leaseRecovery.delete(clientIndex); return record;
}
function assertNoManualLeaseRecovery(state, indexes) {
  if (indexes.some(index => state.leaseRecovery.has(index)))
    throw new Error('FOUNDATION_DELIVERY_LEASE_RECOVERY_CONFLICT');
}
function remainingRecoveryMs(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('FOUNDATION_RECOVERY_TIMEOUT');
  return remaining;
}
function recoveryRequestTimeout(deadline) { return Math.min(10_000, remainingRecoveryMs(deadline)); }
async function ops(state, timeoutMs = 10000) {
  const response = await r.request(state, '/api/operations', { admin: true, timeoutMs }); expectStatus(response, 200, 'operations');
  r.noSecrets(state, response.bytes.toString()); const parsed = parseOperationsStatus(r.json(response));
  assert.equal(parsed.success, true); return parsed.data;
}
async function untilReady(state, deadline = performance.now() + limits.recoveryMs, check = () => {}) {
  await r.wait(async () => { check(); const view = await ops(state, recoveryRequestTimeout(deadline)); return view.health.apiReady && view.health.redis === 'ready'
    && view.health.workers.status === 'ready' && view.renderCache.sampledAt !== null; }, remainingRecoveryMs(deadline));
}
async function rendered(state, publicationRevisionId, deadline = performance.now() + limits.recoveryMs, check = () => {}) {
  let rows;
  await r.wait(async () => {
    check();
    rows = await r.db(state, 'p.renderRequest.findMany({where:{publicationRevisionId:input.id}})', { id: publicationRevisionId });
    return rows.length === 3 && rows.every(row => row.completedAt && row.artifactHash);
  }, remainingRecoveryMs(deadline));
  return rows;
}
async function publish(state, expectedRevision) {
  const start = performance.now();
  const response = await r.request(state, '/api/publications/wp29-combined/publish', { method: 'POST', admin: true,
    data: { idempotencyKey: randomUUID(), expectedRevision, deviceIds: state.loadClients.map(d => d.id), allowedActions: actions,
      draft: { fixtureArtifacts: [expectedRevision % 2 === 0 ? 'mono-800x480-white-png' : 'mono-800x480-black-bmp'] } } });
  expectStatus(response, 201, 'publish');
  const result = r.json(response); state.publication = result;
  return { ...result, started: start };
}
async function createLoadClients(state) {
  state.loadClients = [];
  state.pairingRateLimitedWaits = 0;
  for (let i = 0; i < 23; i++) {
    const web = i <= 20;
    const data = { name: `WP29 ${i < 20 ? 'browser' : i === 20 ? 'touch' : i === 21 ? 'battery' : 'fast-pull'} ${i}`, deviceType: web ? 'web-display' : 'trmnl',
      ...(!web ? { macAddress: `02:29:00:00:00:${i.toString(16).padStart(2, '0')}`, profileId: 'trmnl-byod-7.5-mono',
        deliveryPolicyId: i === 21 ? 'reference-sleepy' : 'reference-responsive-pull',
        capabilitiesOverride: { energy: { source: i === 21 ? 'battery' : 'mains', canSleep: i === 21 } } } : {}),
      ...(i === 20 ? { profileId: 'esp32-touch-reference-480x480', deliveryPolicyId: 'reference-connected-embedded' } : {}) };
    stage = `enroll load client ${i + 1} of 23`;
    const created = await r.request(state, '/api/devices', { method: 'POST', admin: true, data }); expectStatus(created, 201, 'device-create');
    const device = r.json(created); infra.remember(state, device.apiKey); infra.remember(state, device.pairingToken);
    const enrolled = await r.request(state, `/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true, data: {} });
    expectStatus(enrolled, 201, 'enrollment-create'); const code = r.json(enrolled).code; infra.remember(state, code);
    // Preserve the real five/minute pairing limit. Never spoof addresses or reset its store.
    const exchange = await exchangeEnrollmentWithRateLimit(state, code, i);
    expectStatus(exchange, 200, 'pairing-exchange'); const credentials = r.json(exchange); infra.remember(state, credentials.credential);
    const client = { id: device.id, externalId: device.externalId, credential: credentials.credential, credentialId: credentials.credentialId,
      web, kind: i < 20 ? 'browser' : i === 20 ? 'touch' : i === 21 ? 'battery' : 'fast-pull' };
    state.devices[`load-${i}`] = client; state.loadClients.push(client); infra.save(state);
  }
  const revision = await publish(state, 0); await rendered(state, revision.publicationRevisionId);
  const response = await r.request(state, '/api/interactions/context', { headers: { Authorization: `Bearer ${state.loadClients[20].credential}` } });
  expectStatus(response, 200, 'interaction-context'); state.touchContext = r.json(response);
}
function acceptTimerFeed(live, input, trigger) {
  const feed = parseTimerFeed(input); assert.equal(feed.success, true);
  // A feed replaces the current client view; acknowledged rows must not survive
  // only in the fixture's memory and disguise a stale reconnect.
  live.timerStates = new Map(feed.data.timers.map(timer => [timer.timerId, { status: timer.status, version: timer.version }]));
  live.timerRefreshes++;
  if (trigger === 'connected') {
    live.initialTimerRefreshes++;
    live.initialTimerStates = new Map(live.timerStates);
  }
}
function connect(state, device, options = {}) {
  const ws = new WebSocket(r.base.replace('http', 'ws') + '/api/device-connect', { origin: r.base });
  const live = { ws, clientIndex: state.loadClients.findIndex(value => value.id === device.id), kind: device.kind,
    messages: [], timerStates: new Map(), initialTimerStates: new Map(), timerRefreshes: 0, initialTimerRefreshes: 0,
    connected: false, failed: false, closed: false, expectedClose: false,
    leaseRecoveryAttempt: options.leaseRecoveryAttempt === true };
  ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'authenticate', externalId: device.externalId, token: device.credential })));
  ws.on('message', bytes => {
    try {
      r.noSecrets(state, bytes.toString()); const parsed = parseDeviceServerMessage(JSON.parse(bytes.toString())); assert.equal(parsed.success, true);
      const message = parsed.data; live.lastMessageType = message.type; live.messages.push(message); if (live.messages.length > 500) live.messages.shift();
      if (message.type === 'connected') live.connected = true;
      if (message.type === 'ping') ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: message.nonce }));
      if (message.type === 'timers.changed' || message.type === 'connected') {
        // Real clients refresh on authentication/reconnect as well as timer
        // invalidation. An unrelated later GET must not disguise this path.
        live.timerPending = (live.timerPending ?? Promise.resolve()).then(async () => {
          const response = await r.request(state, '/api/timers', { headers: { Authorization: `Bearer ${device.credential}` } });
          expectStatus(response, 200, 'websocket-timer-refresh'); r.noSecrets(state, response.bytes.toString());
          acceptTimerFeed(live, r.json(response), message.type);
          if (message.type === 'connected' && live.leaseRecoveryAttempt && live.connected && !live.closed)
            completeDeliveryLeaseRecovery(state, live.clientIndex);
        }).catch(error => { live.failed = true; live.failure = diagnose(error); });
      }
    } catch (error) { live.failed = true; live.failure = diagnose(error); ws.terminate(); }
  });
  ws.on('error', error => { live.failed = true; live.failure = { ...diagnose(error), code: 'FOUNDATION_WEBSOCKET_ERROR' }; });
  ws.on('close', (code, reason) => {
    live.closed = true;
    if (!live.expectedClose) {
      if (isRecoverableDeliveryLeaseClose(code, reason)) {
        live.connected = false;
        live.reconnectPending = true;
        recordDeliveryLeaseClose(state, live.clientIndex);
        return;
      }
      live.failed = true;
      live.failure ??= { result: 'failed', stage, code: 'FOUNDATION_WEBSOCKET_CLOSED', closeCode: code,
        reasonBytes: Buffer.byteLength(reason), clientIndex: live.clientIndex, kind: live.kind,
        lastMessageType: live.lastMessageType ?? null, timerRefreshes: live.timerRefreshes };
    }
  }); return live;
}
async function pumpLeaseReconnects(state, options = {}) {
  const now = options.now ?? performance.now();
  const connectFn = options.connectFn ?? connect;
  for (const [index, outage] of state.leaseRecovery) {
    if (state.shuttingDown || state.reconnectPaused) return;
    const live = state.live[index];
    if (!live?.closed || !live.reconnectPending || now < outage.nextAttemptAt) continue;
    await live.timerPending;
    if (state.shuttingDown || state.reconnectPaused) return;
    if (live.failed) throw new Error(live.failure?.code ?? 'FOUNDATION_WEBSOCKET_FAILED');
    outage.attempts++;
    live.reconnectPending = false;
    state.live[index] = connectFn(state, state.loadClients[index], { leaseRecoveryAttempt: true });
  }
}
function startReconnectPump(state) {
  assert.equal(state.reconnectTimer, undefined);
  state.reconnectTimer = setInterval(() => {
    if (state.reconnectRunning || state.reconnectFailure || state.reconnectPaused) return;
    state.reconnectRunning = pumpLeaseReconnects(state)
      .catch(error => { state.reconnectFailure = error; })
      .finally(() => { state.reconnectRunning = undefined; });
  }, 250);
  state.reconnectTimer.unref?.();
}
async function stopReconnectPump(state) {
  if (state.reconnectTimer) clearInterval(state.reconnectTimer);
  await state.reconnectRunning;
  state.reconnectTimer = undefined;
}
async function close(live) {
  if (!live.closed && live.ws.readyState === WebSocket.OPEN) { live.expectedClose = true; live.ws.close(); }
  await r.wait(() => live.closed, 5000).catch(() => live.ws.terminate());
  await live.timerPending;
}
async function displayRead(state, client, metrics, mayFollowTransition = true, timeoutMs = 10000) {
  const started = performance.now();
  const headers = { Authorization: `Bearer ${client.credential}` };
  const response = await r.request(state, client.web ? `/api/web-displays/${client.externalId}/presentation` : '/api/v1/device-content', { headers, timeoutMs });
  expectStatus(response, 200, client.kind); metrics.push(response.durationMs); r.noSecrets(state, response.bytes.toString());
  const value = r.json(response);
  const parsed = client.web ? parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: value }) : parsePresentationManifest(value);
  assert.equal(parsed.success, true);
  const url = client.web ? value.content.url : value.artifacts[0].url;
  assert.ok(url.startsWith('/api/'));
  const followTransition = async () => {
    assert.equal(mayFollowTransition, true);
    const current = await r.request(state, client.web ? `/api/web-displays/${client.externalId}/presentation` : '/api/v1/device-content', { headers, timeoutMs });
    expectStatus(current, 200, 'transition-manifest'); r.noSecrets(state, current.bytes.toString());
    const next = r.json(current), nextUrl = client.web ? next.content.url : next.artifacts[0].url;
    // Only a proven current-artifact switch permits one new read. A stable
    // manifest plus 404 is a real failure, never an ordinary retry condition.
    assert.notEqual(nextUrl, url);
    state.artifactTransitionRetries = (state.artifactTransitionRetries ?? 0) + 1;
    const result = await displayRead(state, client, metrics, false, timeoutMs);
    metrics.push(performance.now() - started); return result;
  };
  const artifact = await r.request(state, url, { headers, timeoutMs });
  if (artifact.status === 404) return followTransition();
  expectStatus(artifact, 200, 'artifact'); metrics.push(artifact.durationMs);
  const digest = hash(artifact.bytes); assert.equal(digest, url.split('/').pop());
  const cached = await r.request(state, url, { headers: { ...headers, 'If-None-Match': artifact.headers.etag }, timeoutMs });
  if (cached.status === 404) return followTransition();
  expectStatus(cached, 304, 'conditional-artifact'); metrics.push(cached.durationMs); assert.equal(cached.bytes.length, 0);
  if (!client.web) {
    assert.equal(response.headers['x-delivery-mode'], client.kind === 'battery' ? 'sleepy' : 'responsive-pull');
    assert.equal(Number(response.headers['x-refresh-after-seconds']), client.kind === 'battery' ? 900 : 60);
    client.lastPull = value;
  }
  return { value, digest };
}
async function touch(state, metrics) {
  const client = state.loadClients[20], headers = { Authorization: `Bearer ${client.credential}` };
  const contextResponse = await r.request(state, '/api/interactions/context', { headers }); expectStatus(contextResponse, 200, 'interaction-context');
  const context = r.json(contextResponse);
  // A newly desired revision has no interaction rights until its artifact is ready.
  // Real clients defer touch in this state; do not send an unauthorized command.
  if (!context.allowedActions.some(value => value.action === 'timer.create')) return null;
  // Completed alerts still consume the real per-device quota. Acknowledge only
  // after every live WS client has observed completion; retain the three recovery
  // timers until their independent reconnect proof. Never raise product limits.
  const feedResponse = await r.request(state, '/api/timers', { headers });
  expectStatus(feedResponse, 200, 'touch-timer-feed'); metrics.push(feedResponse.durationMs);
  const feed = parseTimerFeed(r.json(feedResponse)); assert.equal(feed.success, true);
  const completed = feed.data.timers.filter(timer => timer.status === 'completed' && timer.acknowledgedAt === null
    && !(state.recoveryTimerIds ?? []).includes(timer.timerId)
    && state.live.every(live => live.timerStates.get(timer.timerId)?.status === 'completed'
      && live.timerStates.get(timer.timerId)?.version === timer.version));
  for (const timer of completed) {
    assert.ok(context.allowedActions.some(value => value.action === 'timer.acknowledge'));
    const response = await r.request(state, '/api/interactions', { method: 'POST', headers,
      data: { protocolVersion: '1.0', eventId: randomUUID(), deviceId: client.externalId, credentialId: context.credentialId,
        publicationId: context.publicationId, revision: context.revision, action: 'timer.acknowledge',
        payload: { version: 1, timerId: timer.timerId, expectedVersion: timer.version }, occurredAt: new Date().toISOString() } });
    expectStatus(response, 200, 'touch-acknowledge'); metrics.push(response.durationMs); r.noSecrets(state, response.bytes.toString());
    const result = r.json(response); assert.equal(result.status, 'accepted');
    assert.ok(result.result.acknowledgedAt); assert.equal(result.result.version, timer.version + 1);
    state.acknowledgedTimers = (state.acknowledgedTimers ?? 0) + 1;
  }
  const event = { protocolVersion: '1.0', eventId: randomUUID(), deviceId: client.externalId, credentialId: context.credentialId,
    publicationId: context.publicationId, revision: context.revision, action: 'timer.create',
    payload: { version: 1, durationMs: 3000, visibility: 'shared' }, occurredAt: new Date().toISOString() };
  const results = await Promise.all([0, 1].map(async () => {
    const response = await r.request(state, '/api/interactions', { method: 'POST', headers, data: event });
    expectStatus(response, 200, 'touch'); metrics.push(response.durationMs); r.noSecrets(state, response.bytes.toString()); return r.json(response);
  }));
  assert.deepEqual(results.map(v => v.status).sort(), ['accepted', 'duplicate']);
  assert.equal(results[0].result.timerId, results[1].result.timerId);
  state.lastTimer = results[0].result; return state.lastTimer;
}
async function sources(state) {
  state.loadSources = [];
  for (let i = 0; i < 4; i++) {
    const definition = { protocolVersion: '1.0', name: `WP29 source ${i}`, connectorType: 'fixture', schemaVersion: '1',
      configuration: { data: { fixtureArtifacts: ['mono-800x480-white-png'] } }, refreshIntervalSeconds: 30,
      timeoutMs: 4000, concurrencyGroup: `wp29-${i}`, secret: randomBytes(32).toString('hex') };
    infra.remember(state, definition.secret);
    const response = await r.request(state, '/api/sources', { method: 'POST', admin: true, data: definition }); expectStatus(response, 201, 'source-create');
    const id = r.json(response).definition.sourceDefinitionId;
    await r.wait(async () => { const value = await r.request(state, `/api/sources/${id}`, { admin: true }); return r.json(value).snapshot?.freshness.state === 'fresh'; });
    delete definition.secret;
    state.loadSources.push({ id, definition });
  }
  infra.save(state);
}
async function enableSourceFaults(state) {
  for (const [index, source] of state.loadSources.entries()) {
    const response = await r.request(state, `/api/sources/${source.id}`, { method: 'PUT', admin: true, data: { ...source.definition,
      connectorType: index < 2 ? 'slow' : 'failure', configuration: { ...source.definition.configuration, ...(index < 2 ? { delayMs: 60000 } : {}) },
      expectedDefinitionVersion: 1 } }); expectStatus(response, 200, 'source-fault-enable');
  }
  infra.save(state);
}
async function installWriteCounters(state) {
  await r.db(state, `(async()=>{await p.$executeRawUnsafe('CREATE TABLE wp29_write_counts (table_name TEXT PRIMARY KEY,n INTEGER NOT NULL)');
    const tables=await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' AND name<>'wp29_write_counts'");
    for(const row of tables){const table=row.name;if(!/^[a-z][a-z0-9_]*$/.test(table))throw new Error('FOUNDATION_TABLE_INVALID');
      await p.$executeRawUnsafe('INSERT INTO wp29_write_counts VALUES (?,0)',table);
      for(const op of ['INSERT','UPDATE','DELETE'])await p.$executeRawUnsafe('CREATE TRIGGER wp29_count_'+table+'_'+op+' AFTER '+op+' ON '+table+" BEGIN UPDATE wp29_write_counts SET n=n+1 WHERE table_name='"+table+"'; END");}
    return true;})()`);
}
async function counts(state) { return r.db(state, 'p.$queryRawUnsafe("SELECT table_name,CAST(n AS REAL) AS n FROM wp29_write_counts ORDER BY table_name")'); }
function countDelta(before, after) { return Object.fromEntries(after.map(row => [row.table_name, row.n - before.find(v => v.table_name === row.table_name).n])); }
async function sample(state, phase) {
  const value = await ops(state); phase.operations++;
  assert.equal(value.health.apiReady, true);
  for (const queue of value.queues) {
    if (queue.oldestDueAgeSeconds === null) phase.unknownQueueSamples++;
    else {
      phase.queueSamples[queue.queue] = (phase.queueSamples[queue.queue] ?? 0) + 1;
      phase.queueAge[queue.queue] = Math.max(phase.queueAge[queue.queue] ?? 0, queue.oldestDueAgeSeconds);
    }
  }
  const mem = await r.memory(state); phase.memoryBytes.push(mem.bytes); assert.equal(mem.oomKills, 0);
  phase.memoryPeakBytes = Math.max(phase.memoryPeakBytes, mem.peakBytes);
  assert.ok(mem.peakBytes < limits.memoryBytes); return value;
}
async function workload(state, name, durationMs, action) {
  stage = name; await r.owned(state); const before = await counts(state);
  const phase = { name, display: [], control: [], memoryBytes: [], memoryPeakBytes: 0, queueAge: {}, queueSamples: {}, unknownQueueSamples: 0,
    operations: 0, touchEvents: 0, start: Date.now() };
  let stop = false, failure;
  const loop = async (interval, operation) => {
    while (!stop && !failure) {
      const started = performance.now();
      try { await operation(); } catch (error) { failure = error; break; }
      await sleep(Math.max(10, interval - (performance.now() - started)));
    }
  };
  // Accelerated pull probes stress transport without claiming hardware refresh cadence.
  const jobs = [loop(5000, async () => {
    for (let offset = 0; offset < 20; offset += 5) await Promise.all(state.loadClients.slice(offset, offset + 5).map(d => displayRead(state, d, phase.display)));
  }), loop(2000, () => displayRead(state, state.loadClients[22], phase.display)),
  loop(10000, () => displayRead(state, state.loadClients[21], phase.display)),
  loop(10000, async () => {
    if (state.pauseTouch) return;
    state.touchPending = touch(state, phase.control);
    try { if (await state.touchPending) phase.touchEvents++; } finally { state.touchPending = undefined; }
  }),
  loop(5000, () => sample(state, phase)),
  loop(5000, async () => { const response = await r.request(state, '/api/screens', { admin: true }); expectStatus(response, 200, 'editor'); phase.control.push(response.durationMs); }),
  loop(500, async () => { assert.equal(state.live.some(client => client.failed), false); })];
  const start = performance.now();
  const check = () => { if (failure) throw failure; assertLiveHealthy(state); };
  try { if (action) await action(phase, check); await sleep(Math.max(0, durationMs - (performance.now() - start))); }
  finally { stop = true; await Promise.all(jobs); }
  if (failure) throw failure;
  const result = { name, elapsedMs: performance.now() - start, display: summary(phase.display), control: summary(phase.control),
    operations: phase.operations, touchEvents: phase.touchEvents, queueAgeSeconds: phase.queueAge,
    queueSamples: phase.queueSamples, unknownQueueSamples: phase.unknownQueueSamples,
    memorySampleMaxBytes: Math.max(...phase.memoryBytes), memoryPeakBytes: phase.memoryPeakBytes, dbRowWrites: countDelta(before, await counts(state)) };
  // Preserve bounded numeric evidence even when a threshold assertion below
  // fails; raw request bodies, headers and credentials never enter this value.
  lastPhaseResult = result;
  assert.ok(result.display.count >= 20); assert.ok(result.control.count >= 2);
  assert.ok(result.display.p95Ms <= limits.displayP95Ms); assert.ok(result.display.maxMs <= limits.displayMaxMs);
  assert.ok(result.control.p95Ms <= limits.controlP95Ms); assert.ok(result.control.maxMs <= limits.controlMaxMs);
  if (name !== 'combined-fault-recovery') {
    assert.equal(result.unknownQueueSamples, 0); assert.equal(Object.keys(result.queueSamples).length, 6);
    assert.ok(Object.values(result.queueSamples).every(count => count >= 3));
    assert.ok(result.touchEvents >= Math.max(1, Math.floor(durationMs / 20000)));
  }
  return result;
}
async function convergence(state, revision, metrics = [], deadline = performance.now() + limits.recoveryMs, check = () => {}) {
  check();
  const rows = await r.db(state, 'p.device.findMany({where:{id:{in:input.ids}},include:{publicationState:true,renderBindings:{include:{ready:true}}}})',
    { ids: state.loadClients.map(d => d.id) });
  assert.equal(rows.length, 23);
  const expected = new Map(rows.map(row => {
    assert.equal(row.publicationState.desiredPublicationRevisionId, revision.publicationRevisionId);
    const binding = row.renderBindings.find(v => v.ready?.publicationRevisionId === revision.publicationRevisionId);
    assert.ok(binding && binding.readyKey === binding.desiredKey);
    return [row.id, { sequence: row.publicationState.desiredSequence, renderRevision: row.renderRevision, hash: binding.ready.artifactHash }];
  }));
  await r.wait(() => { check(); return state.live.every((live, index) => {
    const target = expected.get(state.loadClients[index].id);
    return live.messages.some(message => message.type === 'presentation.changed' && message.presentation.revision === target.sequence
      && message.presentation.renderRevision === target.renderRevision && message.presentation.content.url.endsWith('/' + target.hash));
  }); }, remainingRecoveryMs(deadline));
  for (const client of state.loadClients) {
    check();
    const result = await displayRead(state, client, metrics, true, recoveryRequestTimeout(deadline)), target = expected.get(client.id);
    assert.equal(result.digest, target.hash);
    if (client.web) { assert.equal(result.value.revision, target.sequence); assert.equal(result.value.renderRevision, target.renderRevision); }
    else { assert.equal(result.value.publicationId, revision.publicationId); assert.equal(result.value.revision, String(revision.revision)); }
  }
  return { webSocketCurrentPresentations: 21, matchingHttpClients: 23, publicationRevision: revision.revision };
}
async function sourceFaultEvidence(state) {
  let rows;
  await r.wait(async () => {
    rows = await r.db(state, 'p.sourceDefinition.findMany({where:{sourceDefinitionId:{in:input.ids}},include:{latestSnapshot:true}})', { ids: state.loadSources.map(v => v.id) });
    return rows.length === 4 && rows.every(row => row.latestSnapshot?.errorCode && row.lastAttemptAt && row.lastSuccessAt);
  });
  for (const row of rows) {
    assert.equal(row.latestSnapshot.freshnessState, 'stale');
    assert.equal(row.latestSnapshot.errorCode, row.connectorType === 'slow' ? 'SOURCE_TIMEOUT' : 'SOURCE_REFRESH_FAILED');
    assert.deepEqual(row.latestSnapshot.data, { fixtureArtifacts: ['mono-800x480-white-png'] });
    assert.ok(row.latestSnapshot.validDataCreatedAt);
  }
  return rows.map(row => ({ connector: row.connectorType, errorCode: row.latestSnapshot.errorCode, lastGoodRetained: true }));
}
async function restoreSources(state) {
  for (const source of state.loadSources) {
    const response = await r.request(state, `/api/sources/${source.id}`, { method: 'PUT', admin: true,
      data: { ...source.definition, expectedDefinitionVersion: 2 } }); expectStatus(response, 200, 'source-restore');
  }
  await r.wait(async () => {
    const rows = await r.db(state, 'p.sourceDefinition.findMany({where:{sourceDefinitionId:{in:input.ids}},include:{latestSnapshot:true}})', { ids: state.loadSources.map(v => v.id) });
    return rows.length === 4 && rows.every(row => row.latestSnapshot?.freshnessState === 'fresh' && !row.latestSnapshot.errorCode);
  });
}
async function proveDedupe(state, revision) {
  const rows = await rendered(state, revision.publicationRevisionId);
  const binding = await r.db(state, 'p.renderBinding.findMany({where:{deviceId:{in:input.ids}}})', { ids: state.loadClients.slice(0, 20).map(d => d.id) });
  assert.equal(binding.length, 20); assert.equal(new Set(binding.map(v => v.readyKey)).size, 1);
  const browserKey = binding[0].readyKey; assert.equal(rows.filter(row => row.key === browserKey).length, 1);
  let jobs;
  await r.wait(async () => {
    jobs = await r.db(state, 'p.outboxEvent.findMany({where:{eventType:"render.requested",aggregateId:{in:input.keys}},select:{attempts:true,status:true}})', { keys: rows.map(row => row.key) });
    return jobs.length === 3 && jobs.every(row => row.status === 'delivered');
  });
  assert.equal(jobs.length, 3); assert.ok(jobs.every(row => row.status === 'delivered' && row.attempts === 1));
  return { clients: 23, profiles: 3, renderRequests: rows.length, browserDisplays: 20, browserRenderKeys: 1, elapsedMs: performance.now() - revision.started };
}
// Queue claims do not prove execution overlap. Match actual worker start/end
// events by durable event ID and attempt, entirely inside the active load phase.
function executionOverlap(events, renderIds, sourceIds, phaseStart) {
  const intervals = events.filter(row => row.code === 'JOB_STARTED').flatMap(start => {
    const at = Date.parse(start.timestamp);
    const end = events.find(row => row.code !== 'JOB_STARTED' && row.eventId === start.eventId
      && row.attempt === start.attempt && Date.parse(row.timestamp) >= at);
    return end && at >= phaseStart ? [{ ...start, start: at, end: Date.parse(end.timestamp) }] : [];
  });
  const renders = intervals.filter(row => row.queue === 'render' && renderIds.includes(row.eventId));
  const sources = intervals.filter(row => row.queue === 'source-refresh' && sourceIds.includes(row.sourceDefinitionId));
  const overlaps = renders.flatMap(render => sources.map(source => Math.max(0,
    Math.min(render.end, source.end) - Math.max(render.start, source.start)))).filter(ms => ms > 0);
  return { completedRenderExecutions: new Set(renders.map(row => row.eventId)).size,
    completedSlowExecutions: sources.length, overlapPairs: overlaps.length, maxOverlapMs: Math.max(0, ...overlaps) };
}
async function proveExecutionOverlap(state, revision, phaseStart) {
  const requests = await rendered(state, revision.publicationRevisionId);
  const jobs = await r.db(state, 'p.outboxEvent.findMany({where:{eventType:"render.requested",aggregateId:{in:input.keys}},select:{eventId:true}})',
    { keys: requests.map(row => row.key) });
  const proof = executionOverlap(await r.workerEvents(state), jobs.map(row => row.eventId), state.loadSources.slice(0, 2).map(row => row.id), phaseStart);
  assert.equal(proof.completedRenderExecutions, 3); assert.ok(proof.overlapPairs > 0); return proof;
}
async function recovery(state, phase, report, check = () => assertLiveHealthy(state)) {
  for (let i = 0; i < limits.recoveryRepeats; i++) {
    const repetition = i + 1;
    stage = `worker recovery ${repetition}: stop`;
    state.pauseTouch = true; await state.touchPending;
    await r.service(state, 'worker', false);
    stage = `worker recovery ${repetition}: unavailable health`;
    await r.wait(async () => (await ops(state)).health.workers.status === 'unavailable');
    const down = await ops(state); assert.equal(down.renderCache.sampledAt, null);
    const before = await counts(state);
    await Promise.all(state.loadClients.slice(0, 20).map(d => displayRead(state, d, phase.display)));
    const after = countDelta(before, await counts(state));
    for (const table of ['device_publication_states', 'publication_revisions', 'render_requests', 'render_bindings']) assert.equal(after[table], 0);
    const timer = await touch(state, phase.control); assert.ok(timer); phase.touchEvents++;
    (state.recoveryTimerIds ??= []).push(timer.timerId);
    const revision = await publish(state, state.publication.revision);
    await sleep(3500);
    stage = `worker recovery ${repetition}: start`;
    const start = performance.now(), deadline = start + limits.recoveryMs;
    await r.service(state, 'worker', true); await untilReady(state, deadline, check);
    stage = `worker recovery ${repetition}: render`;
    await rendered(state, revision.publicationRevisionId, deadline, check);
    stage = `worker recovery ${repetition}: convergence`;
    report.convergence.push(await convergence(state, revision, phase.display, deadline, check));
    stage = `worker recovery ${repetition}: timer persistence`;
    await r.wait(async () => { check(); return (await r.db(state, 'p.timer.findUnique({where:{timerId:input.id}})', { id: timer.timerId }))?.status === 'completed'; },
      remainingRecoveryMs(deadline));
    stage = `worker recovery ${repetition}: websocket timer convergence`;
    await r.wait(() => { check(); return state.live.every(live => live.timerStates.get(timer.timerId)?.status === 'completed'); },
      remainingRecoveryMs(deadline));
    stage = `worker recovery ${repetition}: pull timer convergence`;
    for (const client of state.loadClients) {
      check();
      const response = await r.request(state, client.web ? '/api/timers' : '/api/v1/device-content', {
        headers: { Authorization: `Bearer ${client.credential}` }, timeoutMs: recoveryRequestTimeout(deadline) });
      expectStatus(response, 200, 'timer-convergence'); phase.display.push(response.durationMs);
      const feed = client.web ? r.json(response) : r.json(response).timerState;
      assert.equal(feed.timers.find(value => value.timerId === timer.timerId)?.status, 'completed');
    }
    const elapsedMs = performance.now() - start; assert.ok(elapsedMs <= limits.recoveryMs);
    report.workerRecoveryMs.push(elapsedMs);
    state.pauseTouch = false;
  }
  stage = 'redis recovery: stop';
  state.pauseTouch = true; await state.touchPending;
  await r.service(state, 'redis', false);
  stage = 'redis recovery: unavailable health';
  await r.wait(async () => (await ops(state)).health.redis === 'unavailable');
  const value = await ops(state); assert.equal(value.renderCache.sampledAt, null); assert.equal(value.health.workers.count, null);
  const revision = await publish(state, state.publication.revision); await sleep(3500);
  stage = 'redis recovery: start';
  const start = performance.now(), deadline = start + limits.recoveryMs;
  await r.service(state, 'redis', true); await untilReady(state, deadline, check);
  await rendered(state, revision.publicationRevisionId, deadline, check);
  stage = 'redis recovery: convergence';
  report.convergence.push(await convergence(state, revision, phase.display, deadline, check));
  report.redisRecoveryMs = performance.now() - start; assert.ok(report.redisRecoveryMs <= limits.recoveryMs);
  state.pauseTouch = false;
  stage = 'remote recovery: stop';
  for (const role of ['remote-a', 'remote-b']) await r.control(state, role, false);
  for (const role of ['remote-a', 'remote-b']) await fixture.sync(state, role);
  stage = 'remote recovery: stale cache';
  await r.wait(async () => (await fixture.views(state)).every(row => row.status === 'stale'));
  for (const role of ['remote-a', 'remote-b']) {
    const result = await displayRead(state, { ...state.devices[role], web: true, kind: 'remote-cache' }, phase.display);
    assert.equal(result.digest, state.baseline[role].sha256);
  }
  stage = 'remote recovery: start';
  for (const role of ['remote-a', 'remote-b']) { await r.control(state, role, true); await infra.ready(state, role); }
  for (const role of ['remote-a', 'remote-b']) await fixture.sync(state, role);
  stage = 'remote recovery: fresh cache';
  await r.wait(async () => (await fixture.views(state)).every(row => row.status === 'fresh'));
  state.pauseTouch = true; await state.touchPending;
  const manualReconnectIndexes = [0, 1, 2, 3, 4];
  stage = 'websocket recovery: lease drain';
  await r.wait(() => {
    assertLiveHealthy(state);
    return manualReconnectIndexes.every(index => !state.leaseRecovery.has(index) && state.live[index].connected && !state.live[index].closed);
  }, limits.recoveryMs);
  state.reconnectPaused = true;
  await state.reconnectRunning;
  try {
    assertLiveHealthy(state);
    assertNoManualLeaseRecovery(state, manualReconnectIndexes);
    const first = manualReconnectIndexes.map(index => state.live[index]);
    await Promise.all(first.map(close));
    for (const index of manualReconnectIndexes) state.live[index] = connect(state, state.loadClients[index]);
    stage = 'websocket recovery: reconnect';
    await r.wait(() => {
      assertLiveHealthy(state);
      assertNoManualLeaseRecovery(state, manualReconnectIndexes);
      return manualReconnectIndexes.every(index => state.live[index].connected && !state.live[index].failed);
    });
  } finally { state.reconnectPaused = false; }
  stage = 'websocket recovery: all clients converged';
  await r.wait(() => { assertLiveHealthy(state); return state.live.every(live => live.connected && !live.failed); }, limits.recoveryMs);
  report.convergence.push(await convergence(state, state.publication, phase.display));
  assert.equal(state.recoveryTimerIds.length, limits.recoveryRepeats);
  stage = 'websocket recovery: initial timer feeds';
  await r.wait(() => state.live.every(live => live.initialTimerRefreshes > 0 && state.recoveryTimerIds.every(id =>
    live.timerStates.get(id)?.status === 'completed' && live.timerStates.get(id)?.version === 2)));
  assert.ok(state.live.slice(0, 5).every(live => state.recoveryTimerIds.every(id =>
    live.initialTimerStates.get(id)?.status === 'completed' && live.initialTimerStates.get(id)?.version === 2)));
  report.reconnectedTimerFeeds = { clients: 5, retainedCompletedTimers: state.recoveryTimerIds.length };
  report.reconnectedWebSockets = 5;
  state.pauseTouch = false;
}
async function main() {
  assert.ok(process.env.INKER_SMOKE_IMAGE && /^(?:sha256:[a-f0-9]{64}|inker:[a-zA-Z0-9_.-]+)$/.test(process.env.INKER_SMOKE_IMAGE));
  const state = attachLiveState(infra.newState()); let report = { version: 1, result: 'running', runId: state.runId, requestedImage: process.env.INKER_SMOKE_IMAGE };
  let failure;
  saveReport(report);
  try {
    stage = 'owned TLS setup'; await fixture.prepare(state);
    const resources = await r.resources(state); await createLoadClients(state); await sources(state); await installWriteCounters(state);
    state.live = state.loadClients.filter(d => d.web).map(d => connect(state, d));
    await r.wait(() => state.live.every(live => live.connected && !live.failed)); assert.equal(state.live.length, 21);
    startReconnectPump(state);
    report = { ...report, timestamp: new Date().toISOString(), resources, limits,
      pairingRateLimitedWaits: state.pairingRateLimitedWaits,
      clients: { permanentBrowserWebSockets: 20, touchWebSockets: 1, batteryPull: 1, fastPull: 1, remoteSubscriptions: 2 },
      phases: [], workerRecoveryMs: [], convergence: [], hardware: 'not executed: no physical devices available' };
    report.phases.push(await workload(state, 'combined-steady-load', limits.stableSeconds * 1000, async phase => {
      await enableSourceFaults(state);
      await r.wait(async () => (await r.db(state, 'p.outboxEvent.count({where:{eventType:"source.refresh.due",aggregateId:{in:input.ids},status:"processing"}})',
        { ids: state.loadSources.slice(0, 2).map(v => v.id) })) === 2);
      const login = await r.request(state, '/api/auth/login', { method: 'POST', data: { password: state.servers.home.password } });
      expectStatus(login, 200, 'login-under-slow-sources'); phase.control.push(login.durationMs);
      infra.remember(state, login.headers['set-cookie'][0].split(';')[0].split('=')[1]); infra.remember(state, login.headers['x-csrf-token']);
      state.pauseTouch = true; await state.touchPending;
      const first = await publish(state, state.publication.revision);
      report.slowSourceRenderOverlap = await r.db(state, 'p.outboxEvent.count({where:{eventType:"source.refresh.due",aggregateId:{in:input.ids},status:"processing"}})',
        { ids: state.loadSources.slice(0, 2).map(v => v.id) });
      assert.ok(report.slowSourceRenderOverlap >= 1);
      report.deduplication = await proveDedupe(state, first); assert.ok(report.deduplication.elapsedMs <= limits.renderMs);
      state.pauseTouch = false;
      report.convergence.push(await convergence(state, first, phase.display));
      report.sourceFailures = await sourceFaultEvidence(state);
      report.sourceRenderExecutionOverlap = await proveExecutionOverlap(state, first, phase.start);
    }));
    for (const age of Object.values(report.phases[0].queueAgeSeconds)) assert.ok(age <= limits.queueAgeSeconds);
    report.phases.push(await workload(state, 'combined-fault-recovery', 30000, (phase, check) => recovery(state, phase, report, check)));
    await restoreSources(state);
    report.phases.push(await workload(state, 'post-recovery-stability', 30000));
    for (const age of Object.values(report.phases[2].queueAgeSeconds)) assert.ok(age <= limits.queueAgeSeconds);
    await r.wait(async () => (await ops(state)).queues.filter(q => ['render', 'delivery', 'timer'].includes(q.queue)).every(q => q.pending === 0 && q.processing === 0));
    const dead = await r.db(state, 'p.outboxEvent.findMany({where:{status:"dead-letter"},select:{eventType:true,aggregateId:true}})');
    assert.ok(dead.every(row => row.eventType === 'source.refresh.due' && state.loadSources.some(source => source.id === row.aggregateId)));
    report.expectedSourceDeadLetters = dead.length;
    report.artifactTransitionRetries = state.artifactTransitionRetries ?? 0;
    report.webSocketTriggeredTimerRefreshes = state.live.map(live => live.timerRefreshes);
    report.webSocketInitialTimerRefreshes = state.live.map(live => live.initialTimerRefreshes);
    report.acknowledgedTimers = state.acknowledgedTimers ?? 0;
    assert.ok(report.acknowledgedTimers > 0);
    await fixture.adminBoundaries(state);
    stage = 'secret audit'; infra.audit(state);
    r.noSecrets(state, await r.db(state, 'Promise.all([p.sourceSecret.findMany(),p.sourceDefinition.findMany(),p.sourceSnapshot.findMany(),p.interactionReceipt.findMany()])'));
    stage = 'delivery lease reconnect drain';
    await r.wait(() => {
      assertLiveHealthy(state);
      return state.leaseRecovery.size === 0 && state.live.every(live =>
        live.connected && !live.closed && !live.reconnectPending && !live.failed);
    }, limits.recoveryMs);
    report.deliveryLeaseRecoveries = [...state.leaseRecoveryRecords];
    report.deliveryLeaseReconnectAttempts = report.deliveryLeaseRecoveries.reduce((sum, recovery) => sum + recovery.attempts, 0);
    report.result = 'passed'; r.noSecrets(state, report);
  } catch (error) {
    report.result = 'failed'; report.failure = diagnose(error); failure = error;
    if (lastPhaseResult) report.lastCompletedOrFailedPhase = lastPhaseResult;
    try { report.failureDiagnostics = await saveFailureDiagnostics(state); }
    catch (diagnosticError) { report.failureDiagnostics = { code: diagnose(diagnosticError).code }; }
  }
  const acceptanceErrors = [], cleanupErrors = [];
  state.shuttingDown = true;
  try { await stopReconnectPump(state); } catch (error) { cleanupErrors.push(error); }
  if (state.reconnectFailure) acceptanceErrors.push(state.reconnectFailure);
  const socketResults = await Promise.allSettled((state.live ?? []).map(close));
  cleanupErrors.push(...socketResults.filter(result => result.status === 'rejected').map(result => result.reason));
  if (state.leaseRecovery.size > 0) {
    report.deliveryLeaseActiveRecoveries = state.leaseRecovery.size;
    acceptanceErrors.push(new Error('FOUNDATION_DELIVERY_LEASE_RECOVERY_INCOMPLETE'));
  }
  if (state.live?.some(live => live.failed)) acceptanceErrors.push(new Error('FOUNDATION_WEBSOCKET_FAILED'));
  try { infra.cleanup(state); report.cleanup = 'passed'; }
  catch (error) { report.cleanup = 'failed'; cleanupErrors.push(error); }
  if (cleanupErrors.length > 0) report.cleanup = 'failed';
  const finalError = acceptanceErrors[0] ?? cleanupErrors[0];
  if (finalError) {
    report.result = 'failed'; report.failure ??= diagnose(finalError); failure ??= finalError;
    if (cleanupErrors.length > 0) report.cleanupErrors = cleanupErrors.map(error => diagnose(error));
  }
  report.webSocketFailures = (state.live ?? []).filter(live => live.failed).map(live => live.failure ?? { code: 'FOUNDATION_WEBSOCKET_CLOSED' });
  r.noSecrets(state, report); saveReport(report);
  if (failure) throw failure;
  console.log(JSON.stringify(report));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify(diagnose(error))); process.exitCode = 1; });
module.exports = { limits, percentile, summary, diagnose, executionOverlap, attachLiveState, acceptTimerFeed,
  exchangeEnrollmentWithRateLimit, close, isRecoverableDeliveryLeaseClose, deliveryLeaseBackoffMs,
  recordDeliveryLeaseClose, completeDeliveryLeaseRecovery, pumpLeaseReconnects, assertNoManualLeaseRecovery };
