export type DaysUntilInputMode = 'targetDate' | 'duration';
export type DaysUntilDayMode = 'calendar' | 'workdays';

export interface DaysUntilCalculationConfig {
  inputMode?: DaysUntilInputMode;
  startDate?: string;
  targetDate?: string;
  durationDays?: number;
  dayMode?: DaysUntilDayMode;
}

export interface DaysUntilCalculation {
  startDate: Date | null;
  targetDate: Date | null;
  totalDays: number;
  elapsedDays: number;
  remainingDays: number;
  progress: number;
  hasProgress: boolean;
  isBeforeStart: boolean;
  isComplete: boolean;
  error?: string;
}

// Preserve the existing local civil-date semantics and accepted four-digit years.
// The old Date(year, ...) parser already rejected 0000..0099 through JS's 1900 offset.
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MIN_YEAR = 100;
const MAX_YEAR = 9999;
const LAST_DAY = Date.UTC(MAX_YEAR, 11, 31) / DAY_MS;

export function parseLocalDate(value?: string): Date | null {
  if (typeof value !== 'string') return null;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < MIN_YEAR) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

/** A civil-day ordinal, not elapsed local milliseconds (which vary across DST). */
function dayNumber(date: Date): number | null {
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return Date.UTC(year, date.getMonth(), date.getDate()) / DAY_MS;
}

export function formatLocalDate(date: Date): string {
  if (dayNumber(date) === null) return '';
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function copyAtMidnight(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Start-inclusive, target-exclusive calendar weekdays; at most six remainder iterations. */
export function countDays(start: Date, end: Date, dayMode: DaysUntilDayMode): number {
  const first = dayNumber(start), last = dayNumber(end);
  if (first === null || last === null || first >= last) return 0;
  const days = last - first;
  if (dayMode === 'calendar') return days;
  let count = Math.floor(days / 7) * 5;
  for (let offset = 0; offset < days % 7; offset++) {
    const weekday = (start.getDay() + offset) % 7;
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/** Constant-time duration addition; invalid/overflowing dates return an Invalid Date. */
export function addCountedDays(start: Date, durationDays: number, dayMode: DaysUntilDayMode): Date {
  const first = dayNumber(start);
  if (first === null || !Number.isFinite(durationDays)) return new Date(NaN);
  const duration = Math.max(0, Math.floor(durationDays));
  if (!Number.isSafeInteger(duration) || duration > LAST_DAY - first) return new Date(NaN);
  if (duration === 0) return copyAtMidnight(start);
  let offset = duration;
  if (dayMode !== 'calendar') {
    const weekday = start.getDay();
    const weekend = weekday === 0 ? 1 : weekday === 6 ? 2 : 0;
    const firstWeekday = weekend ? 1 : weekday;
    const weeks = Math.floor((duration - 1) / 5), remainder = (duration - 1) % 5;
    offset = weekend + weeks * 7 + remainder + (firstWeekday + remainder > 5 ? 2 : 0) + 1;
  }
  if (offset > LAST_DAY - first) return new Date(NaN);
  const target = new Date((first + offset) * DAY_MS);
  const local = new Date(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  // A timezone can skip an entire civil date; never silently return a different target.
  if (dayNumber(local) !== first + offset) return new Date(NaN);
  return local;
}

export function calculateDaysUntil(
  config: DaysUntilCalculationConfig,
  now = new Date(),
): DaysUntilCalculation {
  const inputMode = config.inputMode || 'targetDate';
  const dayMode = config.dayMode || 'calendar';
  const today = copyAtMidnight(now);
  if (dayNumber(today) === null) return invalidResult('Current date is outside the supported date range');
  const configuredStart = parseLocalDate(config.startDate);
  let targetDate: Date | null;

  if (inputMode === 'duration') {
    if (!configuredStart) return invalidResult('Start date is required for a duration');
    const duration = Number(config.durationDays);
    if (!Number.isFinite(duration) || duration < 1) {
      return invalidResult('Number of days must be at least 1', configuredStart);
    }
    targetDate = addCountedDays(configuredStart, duration, dayMode);
    if (dayNumber(targetDate) === null) return invalidResult('Number of days exceeds the supported date range', configuredStart);
  } else {
    targetDate = parseLocalDate(config.targetDate);
    if (!targetDate) return invalidResult('Target date is required', configuredStart);
  }

  // Legacy calculations without a start date retain their target-only result.
  if (!configuredStart) {
    const remainingDays = countDays(today, targetDate, dayMode);
    return { startDate: null, targetDate, totalDays: remainingDays, elapsedDays: 0, remainingDays,
      progress: today >= targetDate ? 100 : 0, hasProgress: false, isBeforeStart: false, isComplete: today >= targetDate };
  }
  if (targetDate <= configuredStart) {
    return invalidResult('Target date must be after start date', configuredStart, targetDate);
  }
  const totalDays = countDays(configuredStart, targetDate, dayMode);
  if (totalDays < 1) return invalidResult('The selected period contains no counted days', configuredStart, targetDate);
  const isBeforeStart = today < configuredStart, isComplete = today >= targetDate;
  const elapsedDays = isBeforeStart ? 0 : isComplete ? totalDays : Math.min(totalDays, countDays(configuredStart, today, dayMode));
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const progress = Math.max(0, Math.min(100, Math.round((elapsedDays / totalDays) * 100)));
  return { startDate: configuredStart, targetDate, totalDays, elapsedDays, remainingDays, progress,
    hasProgress: true, isBeforeStart, isComplete };
}

function invalidResult(error: string, startDate: Date | null = null, targetDate: Date | null = null): DaysUntilCalculation {
  return { startDate, targetDate, totalDays: 0, elapsedDays: 0, remainingDays: 0, progress: 0,
    hasProgress: false, isBeforeStart: false, isComplete: false, error };
}
