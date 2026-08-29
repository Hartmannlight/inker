import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { addCountedDays, calculateDaysUntil, countDays, formatLocalDate, parseLocalDate } from '../src/days-until';

const date = (value: string) => parseLocalDate(value)!;

// Bounded reference of the previous implementation for normal supported inputs.
function referenceCount(start: Date, end: Date, workdays: boolean): number {
  const cursor = new Date(start); let total = 0;
  while (cursor < end) {
    if (!workdays || (cursor.getDay() !== 0 && cursor.getDay() !== 6)) total++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}
function referenceAdd(start: Date, duration: number, workdays: boolean): Date {
  const cursor = new Date(start); let total = 0;
  while (total < Math.max(0, Math.floor(duration))) {
    if (!workdays || (cursor.getDay() !== 0 && cursor.getDay() !== 6)) total++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return cursor;
}

describe('shared Days Until civil-date domain', () => {
  test('preserves local date-only parsing and rejects impossible or out-of-range dates', () => {
    for (const value of ['0100-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) expect(formatLocalDate(date(value))).toBe(value);
    for (const value of ['', '0000-01-01', '0099-12-31', '1900-02-29', '2026-02-30', '2026-13-01',
      '2026-01-00', '10000-01-01', '2026-08-03T00:00:00Z', '2026-8-3']) expect(parseLocalDate(value)).toBeNull();
    expect(date('2026-08-03').getDate()).toBe(3);
    expect(date('2026-08-03').getHours()).toBe(0);
  });

  test('matches the previous start-inclusive/end-exclusive calculation across every weekday and bounded duration', () => {
    for (const dayMode of ['calendar', 'workdays'] as const) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const start = date('2026-03-23'); start.setDate(start.getDate() + weekday);
        const before = start.getTime();
        for (const duration of [-1, 0, 1, 1.9, 2, 4, 5, 6, 10, 31, 90]) {
          const target = addCountedDays(start, duration, dayMode);
          expect(target.getTime()).toBe(referenceAdd(start, duration, dayMode === 'workdays').getTime());
          expect(countDays(start, target, dayMode)).toBe(referenceCount(start, target, dayMode === 'workdays'));
        }
        expect(start.getTime()).toBe(before);
      }
    }
  });

  test('preserves fractional truncation, workweek boundaries and legacy target-only results', () => {
    expect(formatLocalDate(addCountedDays(date('2026-08-03'), 5, 'workdays'))).toBe('2026-08-08');
    expect(formatLocalDate(addCountedDays(date('2026-08-08'), 1, 'workdays'))).toBe('2026-08-11');
    expect(calculateDaysUntil({ inputMode: 'duration', startDate: '2026-08-03', durationDays: 10.9 }, date('2026-08-07')))
      .toMatchObject({ totalDays: 10, elapsedDays: 4, remainingDays: 6, progress: 40, hasProgress: true });
    expect(calculateDaysUntil({ targetDate: '2026-08-13' }, date('2026-08-08')))
      .toMatchObject({ remainingDays: 5, hasProgress: false, progress: 0, isComplete: false });
    expect(calculateDaysUntil({ targetDate: '2026-08-13' }, date('2026-08-14')))
      .toMatchObject({ remainingDays: 0, hasProgress: false, progress: 100, isComplete: true });
  });

  test('clamps before-start and completed progress and preserves invalid-period failures', () => {
    const config = { startDate: '2026-08-03', targetDate: '2026-08-13' };
    expect(calculateDaysUntil(config, date('2026-08-02'))).toMatchObject({ elapsedDays: 0, remainingDays: 10, progress: 0, isBeforeStart: true });
    expect(calculateDaysUntil(config, date('2026-08-20'))).toMatchObject({ elapsedDays: 10, remainingDays: 0, progress: 100, isComplete: true });
    expect(calculateDaysUntil({ startDate: '2026-08-08', targetDate: '2026-08-10', dayMode: 'workdays' }, date('2026-08-08')).error)
      .toBe('The selected period contains no counted days');
    expect(calculateDaysUntil({ startDate: '2026-08-03', targetDate: '2026-08-03' }).error).toBe('Target date must be after start date');
    expect(calculateDaysUntil({ inputMode: 'duration', durationDays: 5 }).error).toBe('Start date is required for a duration');
  });

  test('rejects huge and non-finite durations without per-day loops or overflowing the date range', () => {
    const setDate = spyOn(Date.prototype, 'setDate');
    try {
      for (const dayMode of ['calendar', 'workdays'] as const) {
        for (const durationDays of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 1e12, Infinity, NaN, 0, -1]) {
          const result = calculateDaysUntil({ inputMode: 'duration', startDate: '2026-08-03', durationDays, dayMode }, date('2026-08-03'));
          expect(result.error).toBeDefined();
          expect(result.hasProgress).toBe(false);
        }
        expect(Number.isNaN(addCountedDays(date('9999-12-31'), 1, dayMode).getTime())).toBe(true);
      }
      const first = date('0100-01-01'), last = date('9999-12-31');
      const span = countDays(first, last, 'calendar');
      expect(span).toBeGreaterThan(3_000_000);
      expect(formatLocalDate(addCountedDays(first, span, 'calendar'))).toBe('9999-12-31');
      expect(countDays(first, last, 'workdays')).toBeGreaterThan(2_000_000);
      expect(setDate).not.toHaveBeenCalled();
    } finally { setDate.mockRestore(); }
  });

  test('fails closed for invalid dates and keeps leap-day and daylight-saving civil-day spans', () => {
    expect(calculateDaysUntil({ targetDate: '2026-08-03' }, new Date(NaN)).error).toBeDefined();
    expect(countDays(new Date(NaN), date('2026-08-03'), 'calendar')).toBe(0);
    expect(formatLocalDate(new Date(NaN))).toBe('');
    expect(Number.isNaN(addCountedDays(date('2026-08-03'), Infinity, 'calendar').getTime())).toBe(true);
    expect(countDays(date('2024-02-28'), date('2024-03-01'), 'calendar')).toBe(2);
    expect(countDays(date('2026-03-28'), date('2026-03-30'), 'calendar')).toBe(2);
    expect(countDays(date('2026-10-24'), date('2026-10-26'), 'calendar')).toBe(2);
  });

  test('normalizes a midnight DST gap without carrying its shifted hour to later target dates', async () => {
    const result = await inTimezone('America/Sao_Paulo', `
      const result = calculateDaysUntil({ inputMode: 'duration', startDate: '2018-11-01', durationDays: 5 }, parseLocalDate('2018-11-06'));
      console.log(JSON.stringify({
        gapHour: parseLocalDate('2018-11-04').getHours(),
        target: formatLocalDate(result.targetDate), targetHour: result.targetDate.getHours(),
        total: result.totalDays, remaining: result.remainingDays, complete: result.isComplete,
      }));
    `);
    expect(result).toEqual({ gapHour: 1, target: '2018-11-06', targetHour: 0, total: 5, remaining: 0, complete: true });
  });

  test('counts civil dates across an entirely skipped day and rejects a nonexistent target', async () => {
    const result = await inTimezone('Pacific/Apia', `
      const start = parseLocalDate('2011-12-28'), end = parseLocalDate('2012-01-02');
      const valid = calculateDaysUntil({ inputMode: 'duration', startDate: '2011-12-28', durationDays: 5 }, end);
      const missing = calculateDaysUntil({ inputMode: 'duration', startDate: '2011-12-28', durationDays: 2 }, start);
      console.log(JSON.stringify({
        missingDate: parseLocalDate('2011-12-30'), calendar: countDays(start, end, 'calendar'),
        workdays: countDays(start, end, 'workdays'), target: formatLocalDate(valid.targetDate),
        total: valid.totalDays, complete: valid.isComplete,
        missingError: missing.error, missingTarget: missing.targetDate, missingProgress: missing.hasProgress,
        invalidAddedDate: Number.isNaN(addCountedDays(start, 2, 'calendar').getTime()),
      }));
    `);
    expect(result).toEqual({
      missingDate: null, calendar: 5, workdays: 3, target: '2012-01-02', total: 5, complete: true,
      missingError: 'Number of days exceeds the supported date range', missingTarget: null,
      missingProgress: false, invalidAddedDate: true,
    });
  });
});

// A separate Node process fixes the timezone before Date initialization on every
// supported host. Transpile the actual source in memory; no stale dist dependency
// and no shared process.env mutation in concurrently running Bun tests.
async function inTimezone(timezone: string, script: string): Promise<unknown> {
  const source = await Bun.file(new URL('../src/days-until.ts', import.meta.url)).text();
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const output = execFileSync('node', ['--input-type=module', '--eval', javascript + '\n' + script], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TZ: timezone },
  });
  return JSON.parse(output);
}
