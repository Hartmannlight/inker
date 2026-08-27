import { describe, expect, test } from "bun:test";
import { position, transition, type PlaybackEntry } from "./playback.machine";

const entries: PlaybackEntry[] = [
  { itemId: 1, publicationRevisionId: "a", durationMs: 10_000 },
  { itemId: 2, publicationRevisionId: "b", durationMs: 20_000 },
  { itemId: 3, publicationRevisionId: "c", durationMs: 30_000 },
];
describe("deterministic playback with caller-owned fake clock", () => {
  for (const [offset, itemId, next] of [
    [0, 1, 10_000],
    [9999, 1, 10_000],
    [10_000, 2, 30_000],
    [30_000, 3, 60_000],
    [60_000, 1, 70_000],
    [6_000_030_000, 3, 6_000_060_000],
  ]) {
    test(`half-open boundary / downtime ${offset}`, () => {
      const clock = { now: 1_000_000 };
      const state = transition(null, [], "start", clock.now, entries);
      clock.now += offset;
      const result = position(state, entries, clock.now);
      expect(result.itemId).toBe(itemId);
      expect(result.nextTransitionAt).toBe(1_000_000 + next);
      expect(
        position(JSON.parse(JSON.stringify(state)), entries, clock.now),
      ).toEqual(result);
    });
  }
  test("empty and singleton never schedule jobs", () => {
    for (const list of [[], entries.slice(0, 1)]) {
      const state = transition(null, [], "start", 1000, list);
      expect(position(state, list, 1_000_000).nextTransitionAt).toBeNull();
    }
  });
  test("null duration holds indefinitely, explicit advance releases it", () => {
    const list = entries.map((e) => ({
      ...e,
      durationMs: e.itemId === 2 ? null : e.durationMs,
    }));
    const state = transition(null, [], "start", 1000, list);
    expect(position(state, list, 9_000_000)).toMatchObject({
      itemId: 2,
      nextTransitionAt: null,
    });
    const advanced = transition(state, list, "advance", 9_000_000);
    expect(position(advanced, list, 9_000_000).itemId).toBe(3);
  });
  test("pause/resume preserves remaining time, restart preserves timeline", () => {
    const start = transition(null, [], "start", 1000, entries);
    const pause = transition(start, entries, "pause", 16_000);
    expect(position(pause, entries, 999_000)).toMatchObject({
      itemId: 2,
      elapsedMs: 5000,
      nextTransitionAt: null,
    });
    const resumed = transition(pause, entries, "resume", 1_000_000);
    expect(position(resumed, entries, 1_000_000).nextTransitionAt).toBe(
      1_015_000,
    );
    expect(
      position(
        transition(resumed, entries, "restart", 1_020_000),
        entries,
        1_020_000,
      ).itemId,
    ).toBe(3);
  });
  test("backwards wall clock clamps at the last committed evaluation", () => {
    const state = transition(
      transition(null, [], "start", 1000, entries),
      entries,
      "restart",
      36_000,
    );
    expect(position(state, entries, 0)).toEqual(
      position(state, entries, 36_000),
    );
  });
  test("reorder preserves stable item; removal selects first; duration shrink catches up", () => {
    const state = transition(null, [], "start", 1000, entries);
    const reordered = [entries[2], entries[1], entries[0]];
    expect(
      position(
        transition(state, entries, "change", 16_000, reordered),
        reordered,
        16_000,
      ).itemId,
    ).toBe(2);
    const removed = [entries[2], entries[0]];
    expect(
      position(
        transition(state, entries, "change", 16_000, removed),
        removed,
        16_000,
      ).itemId,
    ).toBe(3);
    const shortened = entries.map((e) => ({ ...e, durationMs: 1000 }));
    expect(
      position(
        transition(state, entries, "change", 16_000, shortened),
        shortened,
        16_000,
      ).itemId,
    ).toBe(1);
  });
  test("invalid, zero and negative durations and invalid clocks are rejected", () => {
    for (const durationMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER])
      expect(() =>
        transition(null, [], "start", 1000, [{ ...entries[0], durationMs }]),
      ).toThrow();
    for (const now of [NaN, -1, Infinity, 0.5])
      expect(() => transition(null, [], "start", now, entries)).toThrow();
  });
});
