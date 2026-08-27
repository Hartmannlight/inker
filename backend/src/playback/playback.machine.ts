/** Pure WP-18 domain model. Times are integer Unix milliseconds supplied by the caller. */
export interface PlaybackEntry {
  itemId: number;
  publicationRevisionId: string;
  durationMs: number | null;
}
export type PlaybackStatus = "empty" | "running" | "paused" | "stopped";
export interface PlaybackAnchor {
  status: PlaybackStatus;
  anchorIndex: number;
  anchorAt: number;
  elapsedMs: number;
  evaluatedAt: number;
}
export interface PlaybackPosition {
  index: number | null;
  itemId: number | null;
  publicationRevisionId: string | null;
  elapsedMs: number;
  nextTransitionAt: number | null;
}
export type PlaybackAction =
  | "start"
  | "advance"
  | "change"
  | "pause"
  | "resume"
  | "restart"
  | "stop";
export const MAX_TIME = 8_000_000_000_000_000;

export function validateEntries(entries: readonly PlaybackEntry[]) {
  if (
    entries.length > 100 ||
    new Set(entries.map((e) => e.itemId)).size !== entries.length ||
    entries.some(
      (e) =>
        !Number.isSafeInteger(e.itemId) ||
        e.itemId < 1 ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(e.publicationRevisionId) ||
        (e.durationMs !== null &&
          (!Number.isSafeInteger(e.durationMs) ||
            e.durationMs < 1000 ||
            e.durationMs > 86_400_000)),
    )
  ) {
    throw new Error("PLAYBACK_INVALID_ENTRIES");
  }
}

function time(now: number, state?: PlaybackAnchor) {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME)
    throw new Error("PLAYBACK_INVALID_TIME");
  return Math.max(now, state?.evaluatedAt ?? now, state?.anchorAt ?? now);
}

/** O(n), independent of missed cycles. Boundaries are [start, end). */
export function position(
  state: PlaybackAnchor,
  entries: readonly PlaybackEntry[],
  now: number,
): PlaybackPosition {
  validateEntries(entries);
  const at = time(now, state);
  if (!entries.length)
    return {
      index: null,
      itemId: null,
      publicationRevisionId: null,
      elapsedMs: 0,
      nextTransitionAt: null,
    };
  if (
    !Number.isInteger(state.anchorIndex) ||
    state.anchorIndex < 0 ||
    state.anchorIndex >= entries.length ||
    !Number.isSafeInteger(state.elapsedMs) ||
    state.elapsedMs < 0
  )
    throw new Error("PLAYBACK_INVALID_ANCHOR");
  let index = state.anchorIndex;
  let elapsed =
    state.elapsedMs + (state.status === "running" ? at - state.anchorAt : 0);
  const running = state.status === "running" && entries.length > 1;
  if (running) {
    if (entries.every((e) => e.durationMs !== null)) {
      const cycle = entries.reduce((sum, e) => sum + e.durationMs!, 0);
      elapsed %= cycle;
    }
    for (let i = 0; i < entries.length; i++) {
      const duration = entries[index].durationMs;
      if (duration === null || elapsed < duration) break;
      elapsed -= duration;
      index = (index + 1) % entries.length;
    }
  }
  const entry = entries[index];
  const remaining =
    running && entry.durationMs !== null ? entry.durationMs - elapsed : null;
  const next = remaining === null ? null : at + remaining;
  if (next !== null && next > MAX_TIME)
    throw new Error("PLAYBACK_INVALID_TIME");
  return {
    index,
    itemId: entry.itemId,
    publicationRevisionId: entry.publicationRevisionId,
    elapsedMs: elapsed,
    nextTransitionAt: next,
  };
}

export function transition(
  state: PlaybackAnchor | null,
  entries: readonly PlaybackEntry[],
  action: PlaybackAction,
  now: number,
  replacement: readonly PlaybackEntry[] = entries,
): PlaybackAnchor {
  validateEntries(entries);
  validateEntries(replacement);
  const at = time(now, state ?? undefined);
  const fresh = (
    index: number,
    status: PlaybackStatus,
    elapsedMs = 0,
  ): PlaybackAnchor => ({
    status,
    anchorIndex: index,
    anchorAt: at,
    elapsedMs,
    evaluatedAt: at,
  });
  if (action === "start") {
    if (state && state.status !== "stopped" && state.status !== "empty")
      throw new Error("PLAYBACK_ALREADY_STARTED");
    return fresh(0, replacement.length ? "running" : "empty");
  }
  if (!state) throw new Error("PLAYBACK_NOT_STARTED");
  // Restart reconciles time; it never resets to the first item.
  if (action === "restart") return { ...state, evaluatedAt: at };
  const current = position(state, entries, at);
  if (action === "change") {
    if (!replacement.length) return fresh(0, "empty");
    const preserved = replacement.findIndex((e) => e.itemId === current.itemId);
    const status =
      state.status === "paused" || state.status === "stopped"
        ? state.status
        : "running";
    // Keep stable item across reorder; removal selects the first new item.
    // Shortened duration is exhausted at this boundary, never by a GET.
    return fresh(
      Math.max(0, preserved),
      status,
      preserved < 0 ? 0 : current.elapsedMs,
    );
  }
  if (action === "pause")
    return state.status === "running"
      ? fresh(current.index!, "paused", current.elapsedMs)
      : state;
  if (action === "resume")
    return state.status === "paused"
      ? fresh(state.anchorIndex, "running", state.elapsedMs)
      : state;
  if (action === "stop")
    return state.status === "stopped"
      ? state
      : fresh(current.index ?? 0, "stopped", current.elapsedMs);
  if (state.status === "empty" || state.status === "stopped" || !entries.length)
    return state;
  return fresh(((current.index ?? 0) + 1) % entries.length, state.status);
}
