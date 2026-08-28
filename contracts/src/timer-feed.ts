import { utf8ByteLength } from './json-value';
import { parseTimerSnapshot, TIMER_LIMITS, type TimerSnapshot } from './timer';
import type { ParseResult } from './validation';

export const TIMER_FEED_LIMITS = Object.freeze({ maxRows: TIMER_LIMITS.maxRows, maxBytes: 128 * 1024 });
export interface TimerFeed { protocolVersion: '1.0'; serverTime: string; timers: TimerSnapshot[]; }

/** Detached metadata only; server callers reject executable objects before this JSON boundary. */
export function parseTimerFeed(input: unknown): ParseResult<TimerFeed> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 || keys.some(key => !['protocolVersion', 'serverTime', 'timers'].includes(key as string))) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(input);
    for (const key of keys) if (!fields[key as string]?.enumerable || !('value' in fields[key as string])) throw new Error();
    const protocolVersion: unknown = fields.protocolVersion.value, serverTime: unknown = fields.serverTime.value;
    if (protocolVersion !== '1.0' || typeof serverTime !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(serverTime)
      || !Number.isFinite(Date.parse(serverTime)) || Date.parse(serverTime) < 0 || new Date(serverTime).toISOString() !== serverTime) throw new Error();
    const values: unknown = fields.timers.value;
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) throw new Error();
    const length: unknown = Object.getOwnPropertyDescriptor(values, 'length')?.value;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > TIMER_FEED_LIMITS.maxRows
      || Reflect.ownKeys(values).length !== length + 1) throw new Error();
    const timers: TimerSnapshot[] = [], ids = new Set<string>();
    for (let index = 0; index < length; index++) {
      const entry = Object.getOwnPropertyDescriptor(values, String(index));
      if (!entry?.enumerable || !('value' in entry)) throw new Error();
      const parsed = parseTimerSnapshot(entry.value);
      if (!parsed.success || ids.has(parsed.data.timerId)) throw new Error();
      ids.add(parsed.data.timerId); timers.push(parsed.data);
    }
    const result: TimerFeed = { protocolVersion, serverTime, timers };
    if (utf8ByteLength(JSON.stringify(result)) > TIMER_FEED_LIMITS.maxBytes) throw new Error();
    return { success: true, data: result, warnings: [] };
  } catch {
    return { success: false, errors: [{ code: 'invalid_timer_feed', path: '$', severity: 'error', message: 'Invalid bounded timer feed.' }], warnings: [] };
  }
}
