import { describe, expect, test } from 'bun:test';
import { OPERATIONS_QUEUE_NAMES, OPERATIONS_LIMITS, parseOperationsStatus, type OperationsStatus } from '../src/observability';
import { REMOTE_ERROR_CODES } from '../src/remote-subscription';

const at = '2026-08-28T12:00:00.000Z';
const sourceId = '8f57dc36-9426-4432-847d-e40c81bda602';
function fixture(): OperationsStatus {
  return {
    protocolVersion: '1.0', generatedAt: at, status: 'healthy', reasons: [],
    health: { apiReady: true, database: 'ready', redis: 'ready', workers: { status: 'ready', count: 1, sampledAt: at } },
    queues: OPERATIONS_QUEUE_NAMES.map(queue => ({ queue, sampledAt: at, pending: 0, delayed: 0, processing: 0,
      deadLetters: 0, expiredClaims: 0, oldestDueAgeSeconds: 0, oldestProcessingAgeSeconds: 0 })),
    renderCache: { sampledAt: at, hits: 12, misses: 1, fallbacks: 2, rendered: 1, failures: 0 },
    websocket: { sampledAt: at, authenticatedConnections: 20, pendingConnections: 0, livenessTimeouts: 0, authRejected: 0 },
    sources: { sampledAt: at, total: 1, truncated: false, items: [{ sourceDefinitionId: sourceId, connectorType: 'fixture',
      enabled: true, lastAttemptAt: at, lastSuccessAt: at, ageSeconds: 0, freshness: 'fresh', errorCode: null, circuitOpenUntil: null }] },
    remotes: { sampledAt: at, total: 1, truncated: false, items: [{ subscriptionId: sourceId, enabled: true,
      status: 'fresh', lastAttemptAt: at, lastSuccessAt: at, nextSyncAt: at, ageSeconds: 0, circuitOpenUntil: null, errorCode: null }] },
    devices: { sampledAt: at, total: 1, truncated: false, items: [{ deviceId: 7, deliveryMode: 'connected', enabled: true,
      connection: 'connected', lastSeenAt: at, lastConnectedAt: at, acknowledgedAt: at, ageSeconds: 0,
      state: 'active', publicationState: 'current' }] },
    deadLetters: { sampledAt: at, total: 0, items: [], truncated: false },
  };
}
function rejects(value: unknown) {
  const parsed = parseOperationsStatus(value);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.length).toBeLessThanOrEqual(OPERATIONS_LIMITS.issues);
    expect(JSON.stringify(parsed)).not.toContain('synthetic-secret');
  }
}

describe('operations metadata contract', () => {
  test('accepts existing source/device/queue activity without domain data', () => {
    const input = fixture();
    const parsed = parseOperationsStatus(input);
    expect(parsed).toEqual({ success: true, data: input, warnings: [] });
    expect(JSON.stringify(parsed)).not.toMatch(/configuration|payload|secretReferences|transformationCode/);
  });

  test('represents an unavailable metric sample explicitly instead of measured zero', () => {
    const input = fixture();
    input.status = 'degraded'; input.reasons = ['QUEUE_UNAVAILABLE', 'METRICS_UNAVAILABLE'];
    input.health.redis = 'unavailable'; input.health.workers = { status: 'unknown', count: null, sampledAt: null };
    input.renderCache = { sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null };
    expect(parseOperationsStatus(input).success).toBe(true);
    input.renderCache.hits = 0;
    rejects(input);
  });

  test('supports unavailable database projection and unknown collections', () => {
    const input = fixture();
    input.status = 'unavailable'; input.reasons = ['API_DATABASE_UNAVAILABLE'];
    input.health.apiReady = false; input.health.database = 'unavailable';
    input.queues = OPERATIONS_QUEUE_NAMES.map(queue => ({ queue, sampledAt: null, pending: null, delayed: null, processing: null,
      deadLetters: null, expiredClaims: null, oldestDueAgeSeconds: null, oldestProcessingAgeSeconds: null }));
    input.sources = { sampledAt: null, total: null, items: [], truncated: false };
    input.remotes = { sampledAt: null, total: null, items: [], truncated: false };
    input.devices = { sampledAt: null, total: null, items: [], truncated: false };
    expect(parseOperationsStatus(input).success).toBe(true);
    input.status = 'healthy';
    rejects(input);
  });

  test('rejects unknown fields at every nested boundary without leaking their names or values', () => {
    const paths = ['', 'health', 'health.workers', 'queues.0', 'renderCache', 'websocket',
      'sources', 'sources.items.0', 'remotes', 'remotes.items.0', 'devices', 'devices.items.0', 'deadLetters'];
    for (const path of paths) {
      const input = fixture();
      let target: Record<string, unknown> = input as unknown as Record<string, unknown>;
      if (path) for (const key of path.split('.')) target = target[key] as Record<string, unknown>;
      target['synthetic-secret-field'] = { payload: 'synthetic-secret-value' };
      rejects(input);
    }
    rejects({ ...fixture(), remote: { token: 'synthetic-secret' } });
    rejects({ ...fixture(), protocolVersion: 'synthetic-secret' });
    rejects({ ...fixture(), protocolVersion: '1.1' });
  });

  test('bounds rows, IDs, timestamps, counters and complete unique queue inventory', () => {
    const invalid: Array<(input: OperationsStatus) => void> = [
      input => { input.generatedAt = '2026-02-30T12:00:00.000Z'; },
      input => { input.generatedAt = '2026-08-28T12:00:00'; },
      input => { input.queues[0].pending = -1; },
      input => { input.queues[0].processing = 1.5; },
      input => { input.queues[0].oldestDueAgeSeconds = Infinity; },
      input => { input.health.workers.count = Number.MAX_SAFE_INTEGER + 1; },
      input => { input.health.workers.count = 0; },
      input => { input.queues.pop(); },
      input => { input.queues[0] = input.queues[1]; },
      input => { input.sources.items[0].sourceDefinitionId = 'synthetic-secret'; },
      input => { input.devices.items[0].deviceId = 0; },
      input => { input.devices.items[0].lastSeenAt = null; },
      input => { input.sources.items[0].lastSuccessAt = null; },
      input => { input.sources.items = Array(101).fill(input.sources.items[0]); input.sources.total = 101; },
    ];
    for (const change of invalid) { const input = fixture(); change(input); rejects(input); }
  });

  test('accepts bounded pages and rejects duplicate or falsely complete activity lists', () => {
    const input = fixture();
    input.devices.items = Array.from({ length: OPERATIONS_LIMITS.rows }, (_, index) => ({ ...input.devices.items[0], deviceId: index + 1 }));
    input.devices.total = 101; input.devices.truncated = true;
    expect(parseOperationsStatus(input).success).toBe(true);
    input.devices.truncated = false;
    rejects(input);
    input.devices.truncated = true; input.devices.items[99].deviceId = 1;
    rejects(input);
  });

  test('bounds the complete metadata projection and the number of validation issues', () => {
    const input = fixture();
    input.sources.items = Array.from({ length: OPERATIONS_LIMITS.rows }, (_, index) => ({ ...input.sources.items[0],
      sourceDefinitionId: `8f57dc36-9426-4432-847d-${String(index).padStart(12, '0')}` }));
    input.sources.total = OPERATIONS_LIMITS.rows;
    input.remotes.items = Array.from({ length: OPERATIONS_LIMITS.remoteRows }, (_, index) => ({ ...input.remotes.items[0],
      subscriptionId: '8f57dc36-9426-4432-847d-' + String(index).padStart(12, '0') }));
    input.remotes.total = OPERATIONS_LIMITS.remoteRows;
    input.devices.items = Array.from({ length: OPERATIONS_LIMITS.rows }, (_, index) => ({ ...input.devices.items[0], deviceId: index + 1 }));
    input.devices.total = OPERATIONS_LIMITS.rows;
    input.deadLetters.items = Array.from({ length: OPERATIONS_LIMITS.rows }, (_, index) => ({ eventId: `event-${String(index).padStart(94, '0')}`,
      correlationId: sourceId, queue: 'render', occurredAt: at, processedAt: at, attempts: 5, errorCode: 'RENDER_FAILED' }));
    input.deadLetters.total = OPERATIONS_LIMITS.rows;
    expect(parseOperationsStatus(input).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThanOrEqual(OPERATIONS_LIMITS.bytes);
    for (const device of input.devices.items) device.ageSeconds = -1;
    const invalid = parseOperationsStatus(input);
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.errors).toHaveLength(OPERATIONS_LIMITS.issues);
  });

  test('returns bounded failure for executable objects and never invokes ordinary accessors', () => {
    let calls = 0;
    const getter = Object.defineProperty(fixture(), 'health', { enumerable: true, get() { calls++; return {}; } });
    rejects(getter);
    rejects({ ...fixture(), toJSON() { calls++; return {}; } });
    const input = fixture();
    Object.defineProperty(input.queues, '0', { enumerable: true, get() { calls++; return {}; } });
    rejects(input);
    expect(calls).toBe(0);
    const inherited = Object.create(fixture());
    rejects(inherited);
  });

  test('returns detached descriptor values instead of proxy get values or serialization hooks', () => {
    let reads = 0, hooks = 0;
    const input = fixture();
    const cache = { ...input.renderCache };
    input.renderCache = new Proxy(cache, {
      get(target, key, receiver) {
        reads++;
        if (key === 'toJSON') return () => { hooks++; return { leaked: 'synthetic-secret' }; };
        return key === 'hits' ? 'synthetic-secret' : Reflect.get(target, key, receiver);
      },
    });
    const queue = { ...input.queues[0] };
    input.queues[0] = new Proxy(queue, { get() { reads++; return 'synthetic-secret'; } });
    input.queues = new Proxy(input.queues, { get() { reads++; return 'synthetic-secret'; } });
    const parsed = parseOperationsStatus(new Proxy(input, { get() { reads++; return 'synthetic-secret'; } }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Expected detached metadata');
    expect(parsed.data.renderCache.hits).toBe(cache.hits);
    expect(parsed.data.queues[0]).toEqual(queue);
    expect(JSON.stringify(parsed)).not.toContain('synthetic-secret');
    expect(reads).toBe(0);
    expect(hooks).toBe(0);
  });

  test('does not share nested output objects or arrays with the submitted metadata', () => {
    const input = fixture(), parsed = parseOperationsStatus(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Expected detached metadata');
    expect(parsed.data).not.toBe(input);
    expect(parsed.data.sources.items).not.toBe(input.sources.items);
    expect(parsed.data.sources.items[0]).not.toBe(input.sources.items[0]);
    input.renderCache.hits = 999;
    input.sources.items[0].errorCode = 'SOURCE_TIMEOUT';
    input.queues.pop();
    expect(parsed.data.renderCache.hits).toBe(12);
    expect(parsed.data.sources.items[0].errorCode).toBeNull();
    expect(parsed.data.queues).toHaveLength(OPERATIONS_QUEUE_NAMES.length);
    parsed.data.devices.items[0].deviceId = 88;
    expect(input.devices.items[0].deviceId).toBe(7);
  });

  test('bounds descriptor traversal before schema validation and safely handles reflection failures', () => {
    let deep: unknown = 0;
    for (let index = 0; index <= OPERATIONS_LIMITS.depth; index++) deep = { nested: deep };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const manyKeys = Object.fromEntries(Array.from({ length: OPERATIONS_LIMITS.objectKeys + 1 }, (_, index) => [String(index), 0]));
    const sparse = new Array(2);
    const extraArrayProperty = Object.assign([], { 'synthetic-secret': 0 });
    const symbol = Object.assign(fixture(), { [Symbol('synthetic-secret')]: 0 });
    for (const extra of [deep, cycle, manyKeys, sparse, extraArrayProperty, Array(OPERATIONS_LIMITS.rows + 1).fill(0),
      '😀'.repeat(OPERATIONS_LIMITS.bytes / 4), 'x'.repeat(OPERATIONS_LIMITS.bytes + 1)]) {
      rejects({ ...fixture(), extra });
    }
    rejects(symbol);
    let descriptors = 0;
    const leaf = new Proxy({ value: 0 }, {
      getOwnPropertyDescriptor(target, key) { descriptors++; return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    // Repeated references are not cycles; their expanded representation still
    // consumes the node budget instead of creating an unbounded detached copy.
    rejects({ ...fixture(), extra: Array(100).fill(Array(100).fill(leaf)) });
    expect(descriptors).toBeGreaterThan(0);
    expect(descriptors).toBeLessThan(OPERATIONS_LIMITS.nodes);
    let reflectionCalls = 0;
    const throwing = new Proxy({}, { getPrototypeOf() { reflectionCalls++; throw new Error('synthetic-secret'); } });
    rejects(throwing);
    expect(reflectionCalls).toBe(1);
  });

  test('carries only fixed failure codes and correlation IDs for dead letters', () => {
    const input = fixture();
    input.status = 'degraded'; input.reasons = ['DEAD_LETTERS'];
    input.deadLetters = { sampledAt: at, total: 1, truncated: false, items: [{ eventId: 'event-1', correlationId: sourceId,
      queue: 'source-refresh', occurredAt: at, processedAt: at, attempts: 5, errorCode: 'SOURCE_TIMEOUT' }] };
    expect(parseOperationsStatus(input).success).toBe(true);
    input.deadLetters.items[0].eventId = 'x'.repeat(101);
    rejects(input);
    input.deadLetters.items[0].eventId = 'event-1';
    input.deadLetters.items[0].errorCode = 'synthetic-secret' as never;
    rejects(input);
  });

  test('includes all six queues and fixed remote errors without remote secrets or URLs', () => {
    expect(OPERATIONS_QUEUE_NAMES).toHaveLength(6);
    expect(OPERATIONS_QUEUE_NAMES).toContain('remote-sync');
    for (const errorCode of REMOTE_ERROR_CODES) {
      const input = fixture();
      input.status = 'degraded'; input.reasons = ['REMOTE_ERRORS'];
      Object.assign(input.remotes.items[0], { status: 'stale', errorCode });
      input.deadLetters = { sampledAt: at, total: 1, truncated: false, items: [{
        eventId: 'remote-event-1', correlationId: sourceId, queue: 'remote-sync',
        occurredAt: at, processedAt: at, attempts: 5, errorCode,
      }] };
      const parsed = parseOperationsStatus(input);
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(parsed)).not.toMatch(/baseUrl|credentialId|ciphertext|secretReferences|artifactBytes/);
    }
    const input = fixture();
    input.remotes.items[0].errorCode = 'synthetic-secret' as never;
    rejects(input);
    input.remotes.items[0].errorCode = 'SOURCE_TIMEOUT' as never;
    rejects(input);
    input.remotes.items[0].errorCode = 'UNKNOWN_FAILURE';
    expect(parseOperationsStatus(input).success).toBe(true);
  });

  test('bounds remote identity, timestamps, ages, enabled state and collection size', () => {
    const changes: Array<(input: OperationsStatus) => void> = [
      input => { input.remotes.items[0].subscriptionId = 'synthetic-secret'; },
      input => { input.remotes.items[0].lastSuccessAt = null; },
      input => { input.remotes.items[0].nextSyncAt = '2026-02-30T12:00:00.000Z'; },
      input => { input.remotes.items[0].circuitOpenUntil = 'synthetic-secret'; },
      input => { input.remotes.items[0].ageSeconds = -1; },
      input => { input.remotes.items[0].enabled = false; },
      input => { input.remotes.items[0].status = 'disabled'; },
      input => { input.remotes.items.push({ ...input.remotes.items[0] }); input.remotes.total = 2; },
      input => {
        input.remotes.items = Array.from({ length: OPERATIONS_LIMITS.remoteRows + 1 }, (_, index) => ({
          ...input.remotes.items[0], subscriptionId: '8f57dc36-9426-4432-847d-' + String(index).padStart(12, '0'),
        }));
        input.remotes.total = input.remotes.items.length;
      },
    ];
    for (const change of changes) { const input = fixture(); change(input); rejects(input); }
    const input = fixture();
    Object.assign(input.remotes.items[0], { enabled: false, status: 'disabled', lastSuccessAt: null, ageSeconds: null });
    expect(parseOperationsStatus(input).success).toBe(true);
    input.remotes = { sampledAt: null, total: null, items: [], truncated: false };
    expect(parseOperationsStatus(input).success).toBe(true);
    input.remotes.total = 0;
    rejects(input);
  });

  test('remote projection rejects accessors and strips no unchecked proxy values into output', () => {
    let calls = 0;
    const input = fixture(), original = { ...input.remotes.items[0] };
    input.remotes.items[0] = new Proxy(original, { get() { calls++; return 'synthetic-secret'; } });
    const parsed = parseOperationsStatus(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Expected detached remote metadata');
    expect(parsed.data.remotes.items[0]).toEqual(original);
    expect(parsed.data.remotes.items[0]).not.toBe(original);
    expect(calls).toBe(0);
    const accessor = fixture();
    Object.defineProperty(accessor.remotes.items[0], 'errorCode', { enumerable: true, get() { calls++; return 'synthetic-secret'; } });
    rejects(accessor);
    expect(calls).toBe(0);
    for (const key of ['baseUrl', 'token', 'credentialId', 'payload']) {
      const unsafe = fixture();
      Object.assign(unsafe.remotes.items[0], { [key]: 'synthetic-secret' });
      rejects(unsafe);
    }
  });
});
