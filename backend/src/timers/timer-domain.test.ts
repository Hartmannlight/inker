import { describe, expect, test } from 'bun:test';
import { transitionTimer, type TimerAction, type TimerAnchor } from './timer-domain';

const MAX_TIME = 253_402_300_799_999;
const MAX_VERSION = 2_147_483_647;
const start = () => transitionTimer(null, 'create', 1000, 10_000).state;
const paused = () => transitionTimer(start(), 'pause', 4000).state;
const completed = () => transitionTimer(start(), 'complete', 11_000).state;
const cancelled = () => transitionTimer(start(), 'cancel', 4000).state;
const acknowledged = () => transitionTimer(completed(), 'acknowledge', 12_000).state;

describe('persistent timer domain with a caller-owned clock', () => {
  test('create records its original start and exactly one durable future boundary', () => {
    expect(transitionTimer(null, 'create', 1000, 10_000)).toEqual({ changed: true, reason: 'created',
      state: { version: 1, status: 'running', durationMs: 10_000, startedAt: 1000, endsAt: 11_000,
        pausedRemainingMs: null, evaluatedAt: 1000, completedAt: null, cancelledAt: null, acknowledgedAt: null } });
  });

  for (const duration of [1000, 604_800_000]) {
    test(`duration boundary ${duration} milliseconds is accepted`, () => {
      expect(transitionTimer(null, 'create', 0, duration).state.endsAt).toBe(duration);
    });
  }
  for (const duration of [undefined, null, -1, 0, 999, 1000.5, 604_800_001, NaN, Infinity, '1000']) {
    test(`invalid duration ${String(duration)} has a constant error`, () => {
      expect(() => transitionTimer(null, 'create', 0, duration as number)).toThrow('TIMER_INVALID_DURATION');
    });
  }
  for (const now of [-1, 0.5, NaN, Infinity, MAX_TIME + 1, '1000', null]) {
    test(`invalid server time ${String(now)} is rejected, even for no-ops`, () => {
      expect(() => transitionTimer(null, 'create', now as number, 1000)).toThrow('TIMER_INVALID_TIME');
      expect(() => transitionTimer(paused(), 'pause', now as number)).toThrow('TIMER_INVALID_TIME');
    });
  }

  const matrix: Array<[string, () => TimerAnchor, TimerAction, ReturnType<typeof transitionTimer>['reason'] | 'invalid']> = [
    ['running', start, 'pause', 'paused'], ['running', start, 'resume', null],
    ['running', start, 'cancel', 'cancelled'], ['running', start, 'acknowledge', 'invalid'],
    ['running', start, 'complete', null],
    ['paused', paused, 'pause', null], ['paused', paused, 'resume', 'resumed'],
    ['paused', paused, 'cancel', 'cancelled'], ['paused', paused, 'acknowledge', 'invalid'],
    ['paused', paused, 'complete', null],
    ['completed', completed, 'pause', 'invalid'], ['completed', completed, 'resume', 'invalid'],
    ['completed', completed, 'cancel', 'invalid'], ['completed', completed, 'acknowledge', 'acknowledged'],
    ['completed', completed, 'complete', null],
    ['cancelled', cancelled, 'pause', 'invalid'], ['cancelled', cancelled, 'resume', 'invalid'],
    ['cancelled', cancelled, 'cancel', null], ['cancelled', cancelled, 'acknowledge', 'invalid'],
    ['cancelled', cancelled, 'complete', null],
    ['acknowledged', acknowledged, 'pause', 'invalid'], ['acknowledged', acknowledged, 'resume', 'invalid'],
    ['acknowledged', acknowledged, 'cancel', 'invalid'], ['acknowledged', acknowledged, 'acknowledge', null],
    ['acknowledged', acknowledged, 'complete', null],
  ];
  for (const [label, fixture, action, reason] of matrix) {
    test(`${label} + ${action} => ${reason ?? 'no-op'}`, () => {
      const state = Object.freeze(fixture()), before = structuredClone(state);
      const now = state.status === 'running' ? 5000 : 15_000;
      if (reason === 'invalid') {
        expect(() => transitionTimer(state, action, now)).toThrow('TIMER_INVALID_TRANSITION');
      } else {
        const result = transitionTimer(state, action, now);
        expect(result.reason).toBe(reason);
        expect(result.changed).toBe(reason !== null);
        expect(result.state.version).toBe(state.version + (reason === null ? 0 : 1));
        expect(result.state.startedAt).toBe(state.startedAt);
        expect(result.state.evaluatedAt).toBe(reason === null ? state.evaluatedAt : now);
        if (reason === null) expect(result.state).toBe(state);
        else expect(result.state).not.toBe(state);
      }
      expect(state).toEqual(before);
    });
  }

  for (const action of ['pause', 'resume', 'cancel', 'acknowledge', 'complete'] as const) {
    for (const now of [11_000, 11_001, 600_000]) {
      test(`${action} at/after expiry ${now} completes instead of reviving elapsed time`, () => {
        const result = transitionTimer(start(), action, now);
        expect(result).toEqual({ changed: true, reason: action === 'acknowledge' ? 'acknowledged' : 'completed',
          state: { ...start(), version: 2, status: 'completed', completedAt: 11_000, evaluatedAt: now,
            acknowledgedAt: action === 'acknowledge' ? now : null } });
        expect(transitionTimer(result.state, 'complete', now + 1).changed).toBe(false);
      });
    }
  }

  test('one millisecond before expiry can pause and resume its exact remaining millisecond', () => {
    const state = transitionTimer(start(), 'pause', 10_999).state;
    expect(state).toMatchObject({ status: 'paused', endsAt: null, pausedRemainingMs: 1 });
    const resumed = transitionTimer(state, 'resume', 50_000).state;
    expect(resumed).toMatchObject({ status: 'running', startedAt: 1000, endsAt: 50_001, pausedRemainingMs: null });
    expect(transitionTimer(resumed, 'complete', 50_000).changed).toBe(false);
    expect(transitionTimer(resumed, 'complete', 50_001).state.completedAt).toBe(50_001);
  });

  test('pause/resume cycles preserve duration without writing countdown ticks', () => {
    const clock = { now: 1000 };
    let state = transitionTimer(null, 'create', clock.now, 10_000).state;
    clock.now = 4000;
    state = transitionTimer(state, 'pause', clock.now).state;
    expect(state.pausedRemainingMs).toBe(7000);
    clock.now = 100_000;
    expect(transitionTimer(state, 'complete', clock.now).state).toBe(state);
    state = transitionTimer(state, 'resume', clock.now).state;
    expect(state.endsAt).toBe(107_000);
    for (clock.now = 100_000; clock.now < 102_000; clock.now += 137) {
      const tick = transitionTimer(state, 'complete', clock.now);
      expect(tick).toEqual({ state, changed: false, reason: null });
      expect(tick.state).toBe(state);
    }
    state = transitionTimer(state, 'pause', 102_000).state;
    expect(state.pausedRemainingMs).toBe(5000);
    state = transitionTimer(state, 'resume', 1_000_000).state;
    expect(state).toMatchObject({ version: 5, endsAt: 1_005_000, startedAt: 1000 });
    expect(transitionTimer(state, 'complete', 1_005_000).state).toMatchObject({ version: 6, status: 'completed', completedAt: 1_005_000 });
  });

  test('backward clock clamps every mutation to the last persisted evaluation', () => {
    const state = paused();
    const resumed = transitionTimer(state, 'resume', 0).state;
    expect(resumed).toMatchObject({ evaluatedAt: 4000, endsAt: 11_000, startedAt: 1000 });
    expect(transitionTimer(resumed, 'pause', 1000).state).toMatchObject({ evaluatedAt: 4000, pausedRemainingMs: 7000 });
    expect(transitionTimer(state, 'cancel', 0).state.cancelledAt).toBe(4000);
    expect(transitionTimer(completed(), 'acknowledge', 0).state.acknowledgedAt).toBe(11_000);
  });

  test('cancel clears scheduling fields and acknowledgement preserves the completed terminal state', () => {
    expect(transitionTimer(paused(), 'cancel', 5000).state).toMatchObject({ status: 'cancelled', endsAt: null,
      pausedRemainingMs: null, cancelledAt: 5000, completedAt: null, acknowledgedAt: null });
    expect(acknowledged()).toMatchObject({ status: 'completed', endsAt: 11_000, completedAt: 11_000,
      acknowledgedAt: 12_000, version: 3, cancelledAt: null });
  });

  test('creation/resume accept the final ISO millisecond but reject addition overflow', () => {
    const final = transitionTimer(null, 'create', MAX_TIME - 1000, 1000).state;
    expect(final.endsAt).toBe(MAX_TIME);
    expect(new Date(final.endsAt!).toISOString()).toBe('9999-12-31T23:59:59.999Z');
    expect(transitionTimer(final, 'complete', MAX_TIME).state.completedAt).toBe(MAX_TIME);
    expect(() => transitionTimer(null, 'create', MAX_TIME - 999, 1000)).toThrow('TIMER_INVALID_TIME');
    const state = paused();
    expect(transitionTimer(state, 'resume', MAX_TIME - 7000).state.endsAt).toBe(MAX_TIME);
    expect(() => transitionTimer(state, 'resume', MAX_TIME - 6999)).toThrow('TIMER_INVALID_TIME');
    expect(state).toEqual(paused());
  });

  test('version exhaustion forbids changes but retains all supported no-ops', () => {
    for (const [state, action] of [[start(), 'resume'], [paused(), 'pause'], [cancelled(), 'cancel'],
      [acknowledged(), 'acknowledge'], [completed(), 'complete']] as const) {
      const exhausted = { ...state, version: MAX_VERSION };
      expect(transitionTimer(exhausted, action, exhausted.evaluatedAt)).toEqual({ state: exhausted, changed: false, reason: null });
    }
    expect(() => transitionTimer({ ...start(), version: MAX_VERSION }, 'pause', 4000)).toThrow('TIMER_VERSION_EXHAUSTED');
    expect(() => transitionTimer({ ...start(), version: MAX_VERSION }, 'complete', 11_000)).toThrow('TIMER_VERSION_EXHAUSTED');
    expect(transitionTimer({ ...start(), version: MAX_VERSION - 1 }, 'pause', 4000).state.version).toBe(MAX_VERSION);
  });

  test('missing anchors, recreation, unknown actions and non-create durations are rejected', () => {
    for (const action of ['pause', 'resume', 'cancel', 'acknowledge', 'complete'] as const) {
      expect(() => transitionTimer(null, action, 1000)).toThrow('TIMER_INVALID_TRANSITION');
      expect(() => transitionTimer(start(), action, 5000, 1000)).toThrow('TIMER_INVALID_DURATION');
    }
    for (const state of [start(), paused(), completed(), cancelled()]) {
      expect(() => transitionTimer(state, 'create', 20_000, 1000)).toThrow('TIMER_INVALID_TRANSITION');
    }
    expect(() => transitionTimer(start(), 'secret-invalid-action' as TimerAction, 2000)).toThrow('TIMER_INVALID_TRANSITION');
  });

  test('corrupt persisted anchor invariants fail with a bounded error', () => {
    const invalid: unknown[] = [undefined, [], {}, { ...start(), status: 'secret-invalid-state' },
      ...[0, -1, 1.5, MAX_VERSION + 1, NaN].map(version => ({ ...start(), version })),
      { ...start(), durationMs: 0 }, { ...start(), startedAt: -1 }, { ...start(), evaluatedAt: 999 },
      { ...start(), endsAt: null }, { ...start(), endsAt: 1000 }, { ...start(), endsAt: MAX_TIME + 1 },
      { ...start(), endsAt: 20_000 }, { ...start(), pausedRemainingMs: 1 }, { ...start(), completedAt: 1000 },
      { ...start(), cancelledAt: 1000 }, { ...start(), acknowledgedAt: 1000 },
      { ...paused(), endsAt: 11_000 }, { ...paused(), pausedRemainingMs: null },
      ...[0, -1, 0.5, 10_001].map(pausedRemainingMs => ({ ...paused(), pausedRemainingMs })),
      { ...completed(), completedAt: null }, { ...completed(), completedAt: 10_999 },
      { ...completed(), endsAt: null }, { ...completed(), evaluatedAt: 10_999 },
      { ...completed(), acknowledgedAt: 10_000 }, { ...completed(), acknowledgedAt: 12_000 },
      { ...cancelled(), cancelledAt: null }, { ...cancelled(), cancelledAt: 5000 },
      { ...cancelled(), pausedRemainingMs: 1 }, { ...cancelled(), acknowledgedAt: 4000 }];
    for (const state of invalid) {
      expect(() => transitionTimer(state as TimerAnchor, 'complete', 20_000)).toThrow('TIMER_INVALID_STATE');
    }
  });

  test('serialized anchors reproduce the same outcomes without mutation or hidden clock state', () => {
    for (const state of [start(), paused(), completed(), cancelled(), acknowledged()]) {
      for (const now of [0, 4000, 11_000, 1_000_000]) {
        const restored = JSON.parse(JSON.stringify(state)) as TimerAnchor;
        expect(transitionTimer(restored, 'complete', now)).toEqual(transitionTimer(state, 'complete', now));
      }
    }
  });
});
