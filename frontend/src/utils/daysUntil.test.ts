import { describe, expect, it } from 'vitest';
import { calculateDaysUntil as sharedCalculation } from '@inker/contracts';
import { calculateDaysUntil, parseLocalDate } from './daysUntil';

describe('calculateDaysUntil', () => {
  it('uses the shared domain function and rejects durations that exceed supported dates', () => {
    expect(calculateDaysUntil).toBe(sharedCalculation);
    expect(calculateDaysUntil({ inputMode: 'duration', startDate: '2026-08-03', durationDays: Number.MAX_VALUE }).error)
      .toBe('Number of days exceeds the supported date range');
  });
  it('calculates calendar-day progress', () => {
    const result = calculateDaysUntil(
      { inputMode: 'duration', startDate: '2026-08-03', durationDays: 10, dayMode: 'calendar' },
      parseLocalDate('2026-08-07')!,
    );
    expect(result).toMatchObject({ totalDays: 10, elapsedDays: 4, remainingDays: 6, progress: 40 });
  });

  it('excludes weekends from workday progress', () => {
    const result = calculateDaysUntil(
      { inputMode: 'targetDate', startDate: '2026-08-03', targetDate: '2026-08-17', dayMode: 'workdays' },
      parseLocalDate('2026-08-10')!,
    );
    expect(result).toMatchObject({ totalDays: 10, elapsedDays: 5, remainingDays: 5, progress: 50 });
  });
});
