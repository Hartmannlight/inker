const test = require('node:test');
const assert = require('node:assert/strict');
const { executionOverlap, attachLiveState, acceptTimerFeed, exchangeEnrollmentWithRateLimit, close,
  isRecoverableDeliveryLeaseClose, deliveryLeaseBackoffMs, recordDeliveryLeaseClose,
  completeDeliveryLeaseRecovery, pumpLeaseReconnects, assertNoManualLeaseRecovery } = require('./foundation-load.cjs');
const { acceptAdminCookie } = require('./fixtures/foundation-load-runtime.cjs');
const { MISSING_SECRET_REFUSAL, isExpectedMissingSecretRefusal } = require('./foundation-backup-restore.cjs');
const event = (eventId, queue, code, ms, attempt = 1) => ({ eventId, queue, code, attempt,
  timestamp: new Date(ms).toISOString(), ...(queue === 'source-refresh' ? { sourceDefinitionId: 'slow' } : {}) });

test('long-lived load clients retain server-rotated session cookies for subsequent requests and secret audit', () => {
  const state = { servers: { home: { cookie: 'inker_admin_session=old', csrf: 'unchanged' } }, secrets: [] };
  const token = '_'.repeat(43), headers = { 'set-cookie': [`inker_admin_session=${token}; Path=/api; HttpOnly; SameSite=Strict`] };
  assert.equal(acceptAdminCookie(state, {}), false);
  assert.equal(acceptAdminCookie(state, { 'set-cookie': ['other=value'] }), false);
  assert.equal(acceptAdminCookie(state, headers), true);
  assert.deepEqual(state.servers.home, { cookie: `inker_admin_session=${token}`, csrf: 'unchanged' });
  assert.deepEqual(state.secrets, [token]);
  assert.equal(acceptAdminCookie(state, headers), false);
  assert.throws(() => acceptAdminCookie(state, { 'set-cookie': ['inker_admin_session=malformed'] }), /FIXTURE_SESSION_COOKIE_INVALID/);
  assert.throws(() => acceptAdminCookie(state, { 'set-cookie': [...headers['set-cookie'], ...headers['set-cookie']] }), /FIXTURE_SESSION_COOKIE_INVALID/);
});

test('owned recovery state excludes live sockets and in-flight promises', () => {
  const state = attachLiveState({ runId: 'fixture', secrets: ['test-secret'] });
  const socket = {}; socket.self = socket;
  state.live.push(socket); state.touchPending = Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), { runId: 'fixture', secrets: ['test-secret'] });
  assert.equal(state.live[0], socket);
});

test('connected timer feed replaces stale state and counts initial refresh separately from invalidations', () => {
  const stale = new Map([['old-timer', { status: 'completed', version: 2 }]]);
  const live = { timerStates: stale, timerRefreshes: 0, initialTimerRefreshes: 0 };
  const empty = { protocolVersion: '1.0', serverTime: '2026-08-29T00:00:00.000Z', timers: [] };
  acceptTimerFeed(live, empty, 'connected');
  assert.equal(live.timerStates.size, 0); assert.notEqual(live.timerStates, stale);
  assert.notEqual(live.initialTimerStates, live.timerStates);
  assert.equal(live.timerRefreshes, 1); assert.equal(live.initialTimerRefreshes, 1);
  acceptTimerFeed(live, empty, 'timers.changed');
  assert.equal(live.timerRefreshes, 2); assert.equal(live.initialTimerRefreshes, 1);
  const previous = live.timerStates;
  assert.throws(() => acceptTimerFeed(live, { ...empty, timers: [{}] }, 'connected'));
  assert.equal(live.timerStates, previous);
  assert.equal(live.timerRefreshes, 2); assert.equal(live.initialTimerRefreshes, 1);
});

test('pairing exchange respects repeated Retry-After responses without weakening the product limit', async () => {
  const state = { pairingRateLimitedWaits: 0 };
  const responses = [
    { status: 429, headers: { 'retry-after': '49' } },
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 200, headers: {} },
  ];
  const delays = [], logs = [];
  const response = await exchangeEnrollmentWithRateLimit(state, 'pairing-code', 2, {
    requestFn: async (_state, url, options) => {
      assert.equal(url, '/api/device-enrollments/exchange');
      assert.deepEqual(options, { method: 'POST', data: { code: 'pairing-code' } });
      return responses.shift();
    },
    sleepFn: async delay => delays.push(delay),
    logFn: line => logs.push(JSON.parse(line)),
  });
  assert.equal(response.status, 200);
  assert.equal(state.pairingRateLimitedWaits, 2);
  assert.deepEqual(delays, [50_250, 1_250]);
  assert.deepEqual(logs.map(({ completedClients, seconds, retry }) => ({ completedClients, seconds, retry })), [
    { completedClients: 2, seconds: 49, retry: 1 },
    { completedClients: 2, seconds: 0, retry: 2 },
  ]);
});

test('pairing exchange rejects an invalid Retry-After header', async () => {
  for (const value of [undefined, '', '1.5', '1e1', '-1', '61']) {
    await assert.rejects(() => exchangeEnrollmentWithRateLimit({ pairingRateLimitedWaits: 0 }, 'pairing-code', 0, {
      requestFn: async () => ({ status: 429, headers: { 'retry-after': value } }),
      sleepFn: async () => assert.fail('must not sleep'),
      logFn: () => assert.fail('must not log'),
    }), /FIXTURE_RETRY_AFTER_INVALID/);
  }
});

test('pairing exchange does not retry non-rate-limit failures', async () => {
  let requests = 0;
  const response = await exchangeEnrollmentWithRateLimit({ pairingRateLimitedWaits: 0 }, 'pairing-code', 0, {
    requestFn: async () => { requests++; return { status: 500, headers: {} }; },
    sleepFn: async () => assert.fail('must not sleep'),
  });
  assert.equal(response.status, 500);
  assert.equal(requests, 1);
});

test('pairing exchange fails closed when its retry budget is exhausted', async () => {
  let now = 0, requests = 0;
  const state = { pairingRateLimitedWaits: 0 };
  await assert.rejects(() => exchangeEnrollmentWithRateLimit(state, 'pairing-code', 0, {
    requestFn: async () => { requests++; return { status: 429, headers: { 'retry-after': '60' } }; },
    sleepFn: async delay => { now += delay; },
    nowFn: () => now,
    logFn: () => {},
  }), /FOUNDATION_PAIRING_RATE_LIMIT_TIMEOUT/);
  assert.equal(requests, 3);
  assert.equal(state.pairingRateLimitedWaits, 2);
});

test('fixture close marks only an open socket it closes itself as expected', async () => {
  const alreadyClosed = { closed: true, expectedClose: false, ws: { readyState: 3, close: () => assert.fail('must not close') } };
  await close(alreadyClosed);
  assert.equal(alreadyClosed.expectedClose, false);

  const open = { closed: false, expectedClose: false, ws: { readyState: 1, close: () => { open.closed = true; } } };
  await close(open);
  assert.equal(open.expectedClose, true);
});

test('automatic reconnect accepts only the exact documented delivery-lease close', () => {
  assert.equal(isRecoverableDeliveryLeaseClose(1011, Buffer.from('Delivery lease expired')), true);
  assert.equal(isRecoverableDeliveryLeaseClose(1011, Buffer.from('Device operation failed')), false);
  assert.equal(isRecoverableDeliveryLeaseClose(1001, Buffer.from('Delivery lease expired')), false);
  assert.equal(isRecoverableDeliveryLeaseClose(1011, 'Delivery lease expired'), false);
});

test('delivery-lease recovery preserves the first close and records only a validated recovery', () => {
  const state = { leaseRecovery: new Map(), leaseRecoveryRecords: [] };
  const first = recordDeliveryLeaseClose(state, 3, 1000);
  assert.deepEqual(first, { clientIndex: 3, firstClosedAt: 1000, attempts: 0, nextAttemptAt: 2000 });
  first.attempts = 1;
  const repeated = recordDeliveryLeaseClose(state, 3, 2500);
  assert.equal(repeated, first);
  assert.equal(repeated.firstClosedAt, 1000);
  assert.equal(repeated.nextAttemptAt, 4500);
  assert.equal(deliveryLeaseBackoffMs(10), 30000);

  assert.deepEqual(completeDeliveryLeaseRecovery(state, 3, 5000),
    { clientIndex: 3, attempts: 1, elapsedMs: 4000 });
  assert.equal(state.leaseRecovery.size, 0);
  assert.deepEqual(state.leaseRecoveryRecords, [{ clientIndex: 3, attempts: 1, elapsedMs: 4000 }]);
  assert.equal(completeDeliveryLeaseRecovery(state, 3, 6000), null);
});

test('delivery-lease reconnect pump applies persistent backoff until a validated feed completes recovery', async () => {
  const old = { closed: true, reconnectPending: true, failed: false, timerPending: Promise.resolve() };
  const state = { shuttingDown: false, leaseRecovery: new Map(), leaseRecoveryRecords: [], live: [old], loadClients: [{ id: 'device' }] };
  recordDeliveryLeaseClose(state, 0, 1000);
  const replacements = [];
  const connectFn = (_state, _device, options) => {
    assert.deepEqual(options, { leaseRecoveryAttempt: true });
    const replacement = { closed: false, reconnectPending: false, failed: false, leaseRecoveryAttempt: true };
    replacements.push(replacement); return replacement;
  };

  await pumpLeaseReconnects(state, { now: 1999, connectFn });
  assert.equal(replacements.length, 0);
  await pumpLeaseReconnects(state, { now: 2000, connectFn });
  assert.equal(replacements.length, 1);
  assert.equal(state.leaseRecovery.get(0).attempts, 1);

  Object.assign(replacements[0], { closed: true, reconnectPending: true, timerPending: Promise.resolve() });
  recordDeliveryLeaseClose(state, 0, 2500);
  await pumpLeaseReconnects(state, { now: 4499, connectFn });
  assert.equal(replacements.length, 1);
  await pumpLeaseReconnects(state, { now: 4500, connectFn });
  assert.equal(replacements.length, 2);
  assert.equal(state.leaseRecovery.get(0).attempts, 2);

  const live = { timerStates: new Map(), timerRefreshes: 0, initialTimerRefreshes: 0 };
  acceptTimerFeed(live, { protocolVersion: '1.0', serverTime: '2026-08-29T00:00:00.000Z', timers: [] }, 'connected');
  assert.deepEqual(completeDeliveryLeaseRecovery(state, 0, 5000),
    { clientIndex: 0, attempts: 2, elapsedMs: 4000 });
});

test('delivery-lease recovery times out deterministically and shutdown or a manual probe prevents replacement', async () => {
  const live = { closed: true, reconnectPending: true, failed: false, timerPending: Promise.resolve() };
  const state = { shuttingDown: true, leaseRecovery: new Map(), leaseRecoveryRecords: [], live: [live], loadClients: [{}] };
  recordDeliveryLeaseClose(state, 0, 1000);
  let connected = false;
  await pumpLeaseReconnects(state, { now: 2000, connectFn: () => { connected = true; } });
  assert.equal(connected, false);
  assert.equal(state.leaseRecovery.size, 1);
  state.shuttingDown = false; state.reconnectPaused = true;
  await pumpLeaseReconnects(state, { now: 2000, connectFn: () => { connected = true; } });
  assert.equal(connected, false);
  assert.equal(state.leaseRecovery.size, 1);
  assert.throws(() => completeDeliveryLeaseRecovery(state, 0, 1000 + 90001),
    /FOUNDATION_DELIVERY_LEASE_RECOVERY_TIMEOUT/);
  assert.equal(state.leaseRecovery.size, 1);
});

test('a lease-close outside a manual probe recovers after the global pause is released', async () => {
  const live = { closed: true, reconnectPending: true, failed: false, timerPending: Promise.resolve() };
  const state = { shuttingDown: false, reconnectPaused: true, leaseRecovery: new Map(), leaseRecoveryRecords: [],
    live: Array(7).fill(undefined), loadClients: Array(7).fill({}) };
  state.live[6] = live; recordDeliveryLeaseClose(state, 6, 1000);
  let replacements = 0;
  const connectFn = () => { replacements++; return { closed: false, reconnectPending: false, leaseRecoveryAttempt: true }; };
  await pumpLeaseReconnects(state, { now: 2000, connectFn });
  assert.equal(replacements, 0);
  state.reconnectPaused = false;
  await pumpLeaseReconnects(state, { now: 2000, connectFn });
  assert.equal(replacements, 1);
  assert.equal(state.leaseRecovery.get(6).attempts, 1);
});

test('a lease-close in a paused manual slot fails fast instead of waiting for its disabled pump', () => {
  const state = { leaseRecovery: new Map([[2, { clientIndex: 2 }]]) };
  assert.doesNotThrow(() => assertNoManualLeaseRecovery(state, [0, 1, 3, 4]));
  assert.throws(() => assertNoManualLeaseRecovery(state, [0, 1, 2, 3, 4]),
    /FOUNDATION_DELIVERY_LEASE_RECOVERY_CONFLICT/);
});

test('later invalidation cannot replace the separate initial reconnect evidence', () => {
  const startedAt = '2026-08-29T00:00:00.000Z', endsAt = '2026-08-29T00:00:01.000Z';
  const timer = { timerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 2, creatorDeviceId: '_fixture-device',
    visibility: 'shared', status: 'completed', durationMs: 1000, startedAt, endsAt, pausedRemainingMs: null,
    evaluatedAt: endsAt, completedAt: endsAt, cancelledAt: null, acknowledgedAt: null, acknowledgedByDeviceId: null };
  const live = { timerStates: new Map(), initialTimerStates: new Map(), timerRefreshes: 0, initialTimerRefreshes: 0 };
  const feed = { protocolVersion: '1.0', serverTime: endsAt, timers: [timer] };
  acceptTimerFeed(live, feed, 'connected');
  const initial = live.initialTimerStates;
  assert.deepEqual(initial.get(timer.timerId), { status: 'completed', version: 2 });
  acceptTimerFeed(live, { ...feed, timers: [] }, 'timers.changed');
  assert.equal(live.timerStates.size, 0); assert.equal(live.initialTimerStates, initial);
  assert.deepEqual(initial.get(timer.timerId), { status: 'completed', version: 2 });
  assert.equal(live.initialTimerRefreshes, 1);
});

test('combined load evidence requires completed execution intervals of the selected jobs', () => {
  const rows = [event('s', 'source-refresh', 'JOB_STARTED', 1000), event('s', 'source-refresh', 'JOB_FAILED', 5000),
    event('r', 'render', 'JOB_STARTED', 2000), event('r', 'render', 'JOB_COMPLETED', 3000)];
  assert.deepEqual(executionOverlap(rows, ['r'], ['slow'], 500),
    { completedRenderExecutions: 1, completedSlowExecutions: 1, overlapPairs: 1, maxOverlapMs: 1000 });
  assert.equal(executionOverlap(rows, ['other'], ['slow'], 500).overlapPairs, 0);
  assert.equal(executionOverlap(rows, ['r'], ['other'], 500).overlapPairs, 0);
  assert.equal(executionOverlap(rows, ['r'], ['slow'], 1500).overlapPairs, 0);
  assert.equal(executionOverlap(rows.slice(0, 3), ['r'], ['slow'], 500).overlapPairs, 0);
});

test('claims, separate retries and merely adjacent execution do not prove overlap', () => {
  const rows = [event('s', 'source-refresh', 'JOB_STARTED', 1000), event('s', 'source-refresh', 'JOB_FAILED', 5000, 2),
    event('r', 'render', 'JOB_STARTED', 2000), event('r', 'render', 'JOB_COMPLETED', 3000)];
  assert.equal(executionOverlap(rows, ['r'], ['slow'], 0).overlapPairs, 0);
  rows[1] = event('s', 'source-refresh', 'JOB_FAILED', 2000);
  assert.equal(executionOverlap(rows, ['r'], ['slow'], 0).overlapPairs, 0);
  assert.equal(executionOverlap([], ['r'], ['slow'], 0).overlapPairs, 0);
});

test('missing-secret restore gate accepts only the exact fail-closed refusal', () => {
  assert.equal(isExpectedMissingSecretRefusal(1, Buffer.from(`${MISSING_SECRET_REFUSAL}\n`)), true);
  assert.equal(isExpectedMissingSecretRefusal(2, Buffer.from(MISSING_SECRET_REFUSAL)), false);
  assert.equal(isExpectedMissingSecretRefusal(1, Buffer.from('API_START_FAILED')), false);
  assert.equal(isExpectedMissingSecretRefusal(1, Buffer.from(`${MISSING_SECRET_REFUSAL}\nunexpected`)), false);
});
