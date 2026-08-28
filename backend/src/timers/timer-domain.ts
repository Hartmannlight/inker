/** Pure timer domain: integer Unix milliseconds, no clock or persistence side effects. */
export type TimerStatus = 'running' | 'paused' | 'completed' | 'cancelled';
export type TimerAction = 'create' | 'pause' | 'resume' | 'cancel' | 'acknowledge' | 'complete';
export interface TimerAnchor {
  version: number;
  status: TimerStatus;
  durationMs: number;
  startedAt: number;
  endsAt: number | null;
  pausedRemainingMs: number | null;
  evaluatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  acknowledgedAt: number | null;
}

type TimerTransition = {
  state: TimerAnchor;
  changed: boolean;
  reason: 'created' | 'paused' | 'resumed' | 'cancelled' | 'completed' | 'acknowledged' | null;
};
const MIN_DURATION = 1000;
const MAX_DURATION = 604_800_000;
const MAX_TIME = 253_402_300_799_999; // Last millisecond with a four-digit ISO year.
const MAX_VERSION = 2_147_483_647;
const actions: readonly TimerAction[] = ['create', 'pause', 'resume', 'cancel', 'acknowledge', 'complete'];

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIME;
}
function validDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= MIN_DURATION && Number(value) <= MAX_DURATION;
}
function checkedTime(value: number) {
  if (!validTime(value)) throw new Error('TIMER_INVALID_TIME');
  return value;
}

/** Reject corrupt stored anchors before calculating time or attempting a repair. */
function validateAnchor(state: TimerAnchor) {
  const invalid = (): never => { throw new Error('TIMER_INVALID_STATE'); };
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isSafeInteger(state.version) || state.version < 1 || state.version > MAX_VERSION
    || !validDuration(state.durationMs) || !validTime(state.startedAt) || !validTime(state.evaluatedAt)
    || state.evaluatedAt < state.startedAt) return invalid();
  for (const value of [state.endsAt, state.completedAt, state.cancelledAt, state.acknowledgedAt]) {
    if (value !== null && (!validTime(value) || value < state.startedAt)) return invalid();
  }
  if (state.status === 'running') {
    if (state.endsAt === null || state.endsAt <= state.evaluatedAt
      || state.endsAt - state.evaluatedAt > state.durationMs || state.pausedRemainingMs !== null
      || state.completedAt !== null || state.cancelledAt !== null || state.acknowledgedAt !== null) return invalid();
  } else if (state.status === 'paused') {
    if (state.endsAt !== null || !Number.isSafeInteger(state.pausedRemainingMs)
      || Number(state.pausedRemainingMs) < 1 || Number(state.pausedRemainingMs) > state.durationMs
      || state.completedAt !== null || state.cancelledAt !== null || state.acknowledgedAt !== null) return invalid();
  } else if (state.status === 'completed') {
    if (state.endsAt === null || state.endsAt <= state.startedAt || state.completedAt !== state.endsAt
      || state.evaluatedAt < state.endsAt || state.pausedRemainingMs !== null || state.cancelledAt !== null
      || (state.acknowledgedAt !== null && (state.acknowledgedAt < state.endsAt
        || state.acknowledgedAt > state.evaluatedAt))) return invalid();
  } else if (state.status === 'cancelled') {
    if (state.endsAt !== null || state.pausedRemainingMs !== null || state.completedAt !== null
      || state.acknowledgedAt !== null || state.cancelledAt === null || state.cancelledAt > state.evaluatedAt) return invalid();
  } else return invalid();
}

export function transitionTimer(
  previous: TimerAnchor | null,
  action: TimerAction,
  now: number,
  durationMs?: number,
): TimerTransition {
  checkedTime(now);
  if (!actions.includes(action)) throw new Error('TIMER_INVALID_TRANSITION');
  if (action !== 'create' && durationMs !== undefined) throw new Error('TIMER_INVALID_DURATION');
  if (previous !== null) validateAnchor(previous);
  if (action === 'create') {
    if (previous !== null) throw new Error('TIMER_INVALID_TRANSITION');
    if (!validDuration(durationMs)) throw new Error('TIMER_INVALID_DURATION');
    return { state: { version: 1, status: 'running', durationMs, startedAt: now,
      endsAt: checkedTime(now + durationMs), pausedRemainingMs: null, evaluatedAt: now,
      completedAt: null, cancelledAt: null, acknowledgedAt: null }, changed: true, reason: 'created' };
  }
  if (previous === null) throw new Error('TIMER_INVALID_TRANSITION');
  const at = Math.max(now, previous.evaluatedAt);
  const unchanged = (): TimerTransition => ({ state: previous, changed: false, reason: null });
  const changed = (patch: Partial<TimerAnchor>, reason: TimerTransition['reason']): TimerTransition => {
    if (previous.version === MAX_VERSION) throw new Error('TIMER_VERSION_EXHAUSTED');
    return { state: { ...previous, ...patch, version: previous.version + 1, evaluatedAt: at }, changed: true, reason };
  };

  // Reconcile expiry before pause/resume/cancel. A late command cannot revive or
  // cancel elapsed time. Completion and acknowledgement are one atomic version.
  if (previous.status === 'running' && at >= previous.endsAt!) {
    return changed({ status: 'completed', completedAt: previous.endsAt,
      ...(action === 'acknowledge' ? { acknowledgedAt: at } : {}) },
    action === 'acknowledge' ? 'acknowledged' : 'completed');
  }
  if (action === 'complete') return unchanged();
  if (action === 'pause') {
    if (previous.status === 'paused') return unchanged();
    if (previous.status === 'running') return changed({ status: 'paused', endsAt: null,
      pausedRemainingMs: previous.endsAt! - at }, 'paused');
  } else if (action === 'resume') {
    if (previous.status === 'running') return unchanged();
    if (previous.status === 'paused') return changed({ status: 'running',
      endsAt: checkedTime(at + previous.pausedRemainingMs!), pausedRemainingMs: null }, 'resumed');
  } else if (action === 'cancel') {
    if (previous.status === 'cancelled') return unchanged();
    if (previous.status === 'running' || previous.status === 'paused') return changed({ status: 'cancelled',
      endsAt: null, pausedRemainingMs: null, cancelledAt: at }, 'cancelled');
  } else if (action === 'acknowledge' && previous.status === 'completed') {
    return previous.acknowledgedAt === null ? changed({ acknowledgedAt: at }, 'acknowledged') : unchanged();
  }
  throw new Error('TIMER_INVALID_TRANSITION');
}
