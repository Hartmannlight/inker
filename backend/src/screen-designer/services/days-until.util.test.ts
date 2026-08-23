import { describe, expect, it } from 'bun:test';
import {
  addCountedDays,
  calculateDaysUntil,
  countDays,
  formatLocalDate,
  parseLocalDate,
} from './days-until.util';

describe('days-until utilities', () => {
  it('parses date-only values without UTC conversion', () => {
    const date = parseLocalDate('2026-08-03');
    expect(date).not.toBeNull();
    expect(formatLocalDate(date!)).toBe('2026-08-03');
    expect(parseLocalDate('2026-02-30')).toBeNull();
  });

  it('counts calendar days using a start-inclusive, target-exclusive interval', () => {
    expect(countDays(parseLocalDate('2026-08-03')!, parseLocalDate('2026-08-08')!, 'calendar')).toBe(5);
  });

  it('excludes Saturdays and Sundays in workday mode', () => {
    const monday = parseLocalDate('2026-08-03')!;
    expect(countDays(monday, parseLocalDate('2026-08-10')!, 'workdays')).toBe(5);
    expect(formatLocalDate(addCountedDays(monday, 5, 'workdays'))).toBe('2026-08-08');
  });

  it('derives a target date and calculates progress from a duration', () => {
    const result = calculateDaysUntil(
      { inputMode: 'duration', startDate: '2026-08-03', durationDays: 10, dayMode: 'calendar' },
      parseLocalDate('2026-08-07')!,
    );
    expect(formatLocalDate(result.targetDate!)).toBe('2026-08-13');
    expect(result).toMatchObject({ totalDays: 10, elapsedDays: 4, remainingDays: 6, progress: 40 });
  });

  it('calculates workday progress across a weekend', () => {
    const result = calculateDaysUntil(
      { inputMode: 'targetDate', startDate: '2026-08-03', targetDate: '2026-08-17', dayMode: 'workdays' },
      parseLocalDate('2026-08-10')!,
    );
    expect(result).toMatchObject({ totalDays: 10, elapsedDays: 5, remainingDays: 5, progress: 50 });
  });

  it('keeps legacy target-only widgets usable without inventing progress', () => {
    const result = calculateDaysUntil({ targetDate: '2026-08-13' }, parseLocalDate('2026-08-08')!);
    expect(result).toMatchObject({ remainingDays: 5, hasProgress: false, progress: 0 });
  });
});
