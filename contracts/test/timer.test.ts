import { describe, expect, test } from 'bun:test';
import { parseTimerCreatePayload, parseTimerMutationPayload, parseTimerSnapshot, TIMER_LIMITS,
  type TimerCreatePayload, type TimerMutationPayload, type TimerSnapshot } from '../src/timer';
import type { ParseResult } from '../src/validation';

const timerId = '9435c24b-b254-4bde-8439-e5a08f8a313a';
const start = '2026-08-28T12:00:00.000Z';
const middle = '2026-08-28T12:00:30.000Z';
const end = '2026-08-28T12:01:00.000Z';
const later = '2026-08-28T12:01:30.000Z';
function snapshot(status: TimerSnapshot['status'] = 'running'): TimerSnapshot {
  const base: TimerSnapshot = { timerId, version: 1, creatorDeviceId: 'display:browser-1', visibility: 'private', status,
    durationMs: 60_000, startedAt: start, evaluatedAt: start, endsAt: end, pausedRemainingMs: null,
    completedAt: null, cancelledAt: null, acknowledgedAt: null, acknowledgedByDeviceId: null };
  if (status === 'paused') Object.assign(base, { endsAt: null, pausedRemainingMs: 30_000, evaluatedAt: middle });
  if (status === 'completed') Object.assign(base, { completedAt: end, evaluatedAt: end });
  if (status === 'cancelled') Object.assign(base, { endsAt: null, cancelledAt: middle, evaluatedAt: middle });
  return base;
}
function rejected(result: ParseResult<unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  }
}

describe('timer command payloads', () => {
  test('accepts inclusive duration and version bounds and returns detached metadata', () => {
    for (const durationMs of [TIMER_LIMITS.durationMinMs, TIMER_LIMITS.durationMaxMs]) {
      for (const visibility of ['private', 'shared'] as const) {
        const value: TimerCreatePayload = { version: 1, durationMs, visibility };
        const parsed = parseTimerCreatePayload(value);
        expect(parsed).toEqual({ success: true, data: value, warnings: [] });
        if (parsed.success) { expect(parsed.data).not.toBe(value); value.durationMs = 0; expect(parsed.data.durationMs).toBe(durationMs); }
      }
    }
    for (const expectedVersion of [1, TIMER_LIMITS.maxVersion]) {
      const value: TimerMutationPayload = { version: 1, timerId, expectedVersion };
      expect(parseTimerMutationPayload(value)).toEqual({ success: true, data: value, warnings: [] });
    }
  });

  test('rejects malformed or unbounded command fields without coercion', () => {
    for (const durationMs of [-1, 0, 999, 1000.5, TIMER_LIMITS.durationMaxMs + 1, NaN, Infinity, '1000', null, {}]) {
      rejected(parseTimerCreatePayload({ version: 1, durationMs, visibility: 'shared' }));
    }
    for (const version of [0, 2, 1.1, '1', null]) rejected(parseTimerCreatePayload({ version, durationMs: 1000, visibility: 'private' }));
    for (const visibility of ['', 'public', 'synthetic-secret', null]) rejected(parseTimerCreatePayload({ version: 1, durationMs: 1000, visibility }));
    for (const expectedVersion of [0, -1, 1.5, TIMER_LIMITS.maxVersion + 1, Infinity, '1']) {
      rejected(parseTimerMutationPayload({ version: 1, timerId, expectedVersion }));
    }
    for (const invalidId of ['', 'synthetic-secret', timerId.toUpperCase(), `${timerId}-`, timerId.replaceAll('-', ''), null]) {
      rejected(parseTimerMutationPayload({ version: 1, timerId: invalidId, expectedVersion: 1 }));
    }
  });

  test('requires exact keys for both payloads and never returns extra metadata', () => {
    const examples = [
      { parse: parseTimerCreatePayload, input: { version: 1, durationMs: 1000, visibility: 'private' } },
      { parse: parseTimerMutationPayload, input: { version: 1, timerId, expectedVersion: 1 } },
    ];
    for (const { parse, input } of examples) {
      for (const key of Object.keys(input)) { const changed = { ...input } as Record<string, unknown>; delete changed[key]; rejected(parse(changed)); }
      rejected(parse({ ...input, 'synthetic-secret-key': 'synthetic-secret' }));
      rejected(parse({ ...input, [Symbol('synthetic-secret')]: 'synthetic-secret' }));
    }
  });
});

describe('timer snapshot contract', () => {
  test('accepts every lifecycle state and a jointly acknowledged completion', () => {
    for (const state of ['running', 'paused', 'completed', 'cancelled'] as const) {
      const value = snapshot(state), parsed = parseTimerSnapshot(value);
      expect(parsed).toEqual({ success: true, data: value, warnings: [] });
      if (parsed.success) { expect(parsed.data).not.toBe(value); value.creatorDeviceId = 'changed'; expect(parsed.data.creatorDeviceId).toBe('display:browser-1'); }
    }
    const completed = { ...snapshot('completed'), acknowledgedAt: later, acknowledgedByDeviceId: 'display.other_2', evaluatedAt: later };
    expect(parseTimerSnapshot(completed).success).toBe(true);
    expect(parseTimerSnapshot({ ...completed, acknowledgedAt: end }).success).toBe(true);
  });

  test('uses persisted evaluation time without reading the current clock', () => {
    // This running record is old relative to wall time; its persisted evaluation
    // is still before the deadline and no read-side completion is invented.
    const old = { ...snapshot(), startedAt: '2000-01-01T00:00:00.000Z', evaluatedAt: '2000-01-01T00:00:00.000Z', endsAt: '2000-01-01T00:01:00.000Z' };
    expect(parseTimerSnapshot(old).success).toBe(true);
    rejected(parseTimerSnapshot({ ...old, evaluatedAt: old.endsAt }));
    rejected(parseTimerSnapshot({ ...old, evaluatedAt: '2000-01-01T00:02:00.000Z' }));
    expect(parseTimerSnapshot({ ...snapshot('completed'), evaluatedAt: later }).success).toBe(true);
  });

  test('rejects impossible lifecycle field combinations', () => {
    const cases: Array<[TimerSnapshot['status'], Partial<TimerSnapshot>]> = [
      ['running', { endsAt: null }], ['running', { endsAt: start }], ['running', { endsAt: later }], ['running', { pausedRemainingMs: 1 }],
      ['running', { completedAt: start }], ['running', { cancelledAt: start }],
      ['running', { acknowledgedAt: start, acknowledgedByDeviceId: 'display' }],
      ['paused', { endsAt: end }], ['paused', { pausedRemainingMs: null }], ['paused', { pausedRemainingMs: 0 }],
      ['paused', { pausedRemainingMs: 60_001 }], ['paused', { pausedRemainingMs: 1.5 }],
      ['paused', { completedAt: middle }], ['paused', { cancelledAt: middle }],
      ['paused', { acknowledgedAt: middle, acknowledgedByDeviceId: 'display' }],
      ['completed', { endsAt: null }], ['completed', { completedAt: null }], ['completed', { completedAt: middle }],
      ['completed', { endsAt: start, completedAt: start }],
      ['completed', { pausedRemainingMs: 1 }], ['completed', { cancelledAt: end }],
      ['completed', { acknowledgedAt: end }], ['completed', { acknowledgedByDeviceId: 'display' }],
      ['completed', { acknowledgedAt: middle, acknowledgedByDeviceId: 'display' }],
      ['cancelled', { cancelledAt: null }], ['cancelled', { endsAt: end }], ['cancelled', { pausedRemainingMs: 1 }],
      ['cancelled', { completedAt: middle }], ['cancelled', { acknowledgedAt: middle, acknowledgedByDeviceId: 'display' }],
    ];
    for (const [status, changes] of cases) rejected(parseTimerSnapshot({ ...snapshot(status), ...changes }));
    for (const remaining of [1, 60_000]) expect(parseTimerSnapshot({ ...snapshot('paused'), pausedRemainingMs: remaining }).success).toBe(true);
  });

  test('enforces canonical millisecond timestamps and terminal time ordering', () => {
    for (const bad of ['2026-02-30T12:00:00.000Z', '2026-08-28T12:00:00Z', '2026-08-28T14:00:00.000+02:00',
      '2026-08-28T12:00:00.000', '2026-08-28T12:00:00.0000Z', '1969-12-31T23:59:59.999Z', 'synthetic-secret', null]) {
      rejected(parseTimerSnapshot({ ...snapshot(), startedAt: bad }));
      rejected(parseTimerSnapshot({ ...snapshot(), evaluatedAt: bad }));
    }
    rejected(parseTimerSnapshot({ ...snapshot(), startedAt: middle }));
    rejected(parseTimerSnapshot({ ...snapshot('completed'), evaluatedAt: middle }));
    rejected(parseTimerSnapshot({ ...snapshot('completed'), startedAt: later, evaluatedAt: later }));
    rejected(parseTimerSnapshot({ ...snapshot('cancelled'), cancelledAt: later }));
    rejected(parseTimerSnapshot({ ...snapshot('cancelled'), cancelledAt: '2026-08-28T11:59:59.999Z' }));
    rejected(parseTimerSnapshot({ ...snapshot('completed'), acknowledgedAt: later, acknowledgedByDeviceId: 'display' }));
  });

  test('bounds identities, versions and exact snapshot shape', () => {
    const input = snapshot();
    for (const key of Object.keys(input)) { const changed = { ...input } as Record<string, unknown>; delete changed[key]; rejected(parseTimerSnapshot(changed)); }
    rejected(parseTimerSnapshot({ ...input, 'synthetic-secret-field': 'synthetic-secret' }));
    for (const id of ['', '-invalid', '../synthetic-secret', 'name with spaces', 'x'.repeat(129), 'ä']) {
      rejected(parseTimerSnapshot({ ...input, creatorDeviceId: id }));
      rejected(parseTimerSnapshot({ ...snapshot('completed'), acknowledgedAt: end, acknowledgedByDeviceId: id }));
    }
    expect(parseTimerSnapshot({ ...input, creatorDeviceId: 'x'.repeat(128), version: TIMER_LIMITS.maxVersion }).success).toBe(true);
    for (const version of [0, 1.5, TIMER_LIMITS.maxVersion + 1]) rejected(parseTimerSnapshot({ ...input, version }));
    rejected(parseTimerSnapshot({ ...input, status: 'synthetic-secret' }));
    rejected(parseTimerSnapshot({ ...input, durationMs: 0 }));
  });

  test('rejects accessors, conversion hooks and exotic objects without calling them', () => {
    let calls = 0;
    const getter = Object.defineProperty(snapshot(), 'durationMs', { enumerable: true, get() { calls++; return 1000; } });
    rejected(parseTimerSnapshot(getter));
    rejected(parseTimerSnapshot({ ...snapshot(), toJSON() { calls++; return {}; } }));
    rejected(parseTimerSnapshot({ ...snapshot(), creatorDeviceId: { toString() { calls++; return 'display'; } } }));
    rejected(parseTimerSnapshot(Object.create(snapshot())));
    rejected(parseTimerSnapshot(Object.defineProperty(snapshot(), 'durationMs', { value: 1000, enumerable: false })));
    for (const value of [null, [], new Date(), 1, 'synthetic-secret']) rejected(parseTimerSnapshot(value));
    expect(calls).toBe(0);
  });

  test('projects descriptor values from a proxy and never serializes the original', () => {
    let reads = 0;
    const proxy = new Proxy(snapshot(), { get() { reads++; return 'synthetic-secret'; } });
    const parsed = parseTimerSnapshot(proxy);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('synthetic-secret');
    expect(reads).toBe(0);
    const throws = new Proxy({}, { ownKeys() { throw new Error('synthetic-secret'); } });
    rejected(parseTimerSnapshot(throws));
  });
});
