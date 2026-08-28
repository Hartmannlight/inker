import { describe, expect, test } from 'bun:test';
import { parseTimerFeed, TIMER_FEED_LIMITS } from '../src/timer-feed';
import { parseDeviceServerMessage } from '../src/websocket';
import { parsePresentationManifest } from '../src/presentation';
import type { TimerSnapshot } from '../src/timer';

const at = '2026-08-28T12:00:00.000Z';
const row = (index = 0): TimerSnapshot => ({ timerId: `9435c24b-b254-4bde-8439-${String(index).padStart(12, '0')}`, version: 1,
  creatorDeviceId: 'display', visibility: 'shared', status: 'running', durationMs: 60_000, startedAt: at,
  evaluatedAt: at, endsAt: '2026-08-28T12:01:00.000Z', pausedRemainingMs: null, completedAt: null,
  cancelledAt: null, acknowledgedAt: null, acknowledgedByDeviceId: null });
const feed = () => ({ protocolVersion: '1.0', serverTime: at, timers: [row()] });
describe('timer feed and invalidation', () => {
  test('bounds and detaches an empty or full feed without coupling server time to persisted evaluation', () => {
    for (const length of [0, 1, 100]) {
      const input = { ...feed(), serverTime: '2026-08-28T12:03:00.000Z', timers: Array.from({ length }, (_, index) => row(index)) };
      const parsed = parseTimerFeed(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.timers).not.toBe(input.timers);
        expect(new TextEncoder().encode(JSON.stringify(parsed.data)).length).toBeLessThan(TIMER_FEED_LIMITS.maxBytes);
        if (length) { input.timers[0].version = 99; expect(parsed.data.timers[0].version).toBe(1); }
      }
    }
  });
  test('rejects malformed, unknown, duplicate and oversized fields with fixed errors', () => {
    for (const value of [null, {}, { ...feed(), protocolVersion: '1.1' }, { ...feed(), serverTime: '2026-02-30T00:00:00.000Z' },
      { ...feed(), serverTime: at.slice(0, -1) }, { ...feed(), timers: [row(), row()] },
      { ...feed(), timers: Array.from({ length: 101 }, (_, index) => row(index)) },
      { ...feed(), timers: [{ ...row(), secret: 'synthetic-secret' }] }, { ...feed(), secret: 'synthetic-secret' },
      { ...feed(), timers: [{ ...row(), creatorDeviceId: 'x'.repeat(131073) }] }]) {
      const parsed = parseTimerFeed(value); expect(parsed.success).toBe(false); expect(JSON.stringify(parsed)).not.toContain('synthetic-secret');
    }
  });
  test('never reads getters or serializes original proxy objects', () => {
    let calls = 0;
    const input = feed();
    const proxy = new Proxy(input, { get() { calls++; return 'synthetic-secret'; } });
    const parsed = parseTimerFeed(proxy);
    expect(parsed.success).toBe(true); expect(JSON.stringify(parsed)).not.toContain('synthetic-secret'); expect(calls).toBe(0);
    expect(parseTimerFeed(Object.defineProperty(feed(), 'timers', { enumerable: true, get() { calls++; return []; } })).success).toBe(false);
    Object.defineProperty(input.timers, '0', { enumerable: true, get() { calls++; return row(); } });
    expect(parseTimerFeed(input).success).toBe(false); expect(calls).toBe(0);
  });
  test('keeps websocket invalidation tiny and payload-free', () => {
    const message = { protocolVersion: '1.0', type: 'timers.changed' } as const;
    expect(parseDeviceServerMessage(message)).toEqual({ success: true, data: message, warnings: [] });
    expect(JSON.stringify(message).length).toBeLessThan(100);
    expect(parseDeviceServerMessage({ ...message, timers: feed().timers }).success).toBe(false);
    expect(parseDeviceServerMessage({ ...message, timerId: row().timerId }).success).toBe(false);
  });
  test('validates and detaches optional pull timer state without changing legacy manifests', () => {
    const manifest = { protocolVersion: '1.0', manifestId: 'manifest', publicationId: 'publication', revision: '1', profileId: 'profile',
      variantId: 'png', generatedAt: at, artifacts: [{ artifactId: 'image', role: 'primary', url: '/image.png', mimeType: 'image/png',
        sizeBytes: 1, sha256: 'a'.repeat(64), etag: 'tag' }], refresh: {}, allowedActions: [] };
    expect(parsePresentationManifest(manifest).success).toBe(true);
    const state = feed(), result = parsePresentationManifest({ ...manifest, timerState: state });
    expect(result.success).toBe(true);
    if (result.success) { state.timers.length = 0; expect(result.data.timerState!.timers).toHaveLength(1); }
    expect(parsePresentationManifest({ ...manifest, timerState: { ...feed(), serverTime: 'synthetic-secret' } }).success).toBe(false);
  });
});
