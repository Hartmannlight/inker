export type DaysUntilInputMode = 'targetDate' | 'duration';
export type DaysUntilDayMode = 'calendar' | 'workdays';
export type DaysUntilDesign = 'text' | 'progressBar' | 'compact' | 'segments';

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

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLocalDate(value?: string): Date | null {
  if (!value) return null;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function copyAtMidnight(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isCountedDay(date: Date, dayMode: DaysUntilDayMode): boolean {
  if (dayMode === 'calendar') return true;
  const weekday = date.getDay();
  return weekday !== 0 && weekday !== 6;
}

export function countDays(start: Date, end: Date, dayMode: DaysUntilDayMode): number {
  const cursor = copyAtMidnight(start);
  const limit = copyAtMidnight(end);
  if (cursor >= limit) return 0;
  let count = 0;
  while (cursor < limit) {
    if (isCountedDay(cursor, dayMode)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function addCountedDays(start: Date, durationDays: number, dayMode: DaysUntilDayMode): Date {
  const cursor = copyAtMidnight(start);
  const duration = Math.max(0, Math.floor(durationDays));
  let counted = 0;
  while (counted < duration) {
    if (isCountedDay(cursor, dayMode)) counted++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return cursor;
}

export function calculateDaysUntil(
  config: DaysUntilCalculationConfig,
  now = new Date(),
): DaysUntilCalculation {
  const inputMode = config.inputMode || 'targetDate';
  const dayMode = config.dayMode || 'calendar';
  const today = copyAtMidnight(now);
  const configuredStart = parseLocalDate(config.startDate);
  let targetDate: Date | null;

  if (inputMode === 'duration') {
    if (!configuredStart) return invalidResult('Start date is required for a duration');
    const duration = Number(config.durationDays);
    if (!Number.isFinite(duration) || duration < 1) {
      return invalidResult('Number of days must be at least 1', configuredStart);
    }
    targetDate = addCountedDays(configuredStart, duration, dayMode);
  } else {
    targetDate = parseLocalDate(config.targetDate);
    if (!targetDate) return invalidResult('Target date is required', configuredStart);
  }

  // Older widgets have no start date. They still show remaining days, while
  // percentage-based designs explain that a start date is needed.
  if (!configuredStart) {
    const remainingDays = countDays(today, targetDate, dayMode);
    return {
      startDate: null,
      targetDate,
      totalDays: remainingDays,
      elapsedDays: 0,
      remainingDays,
      progress: today >= targetDate ? 100 : 0,
      hasProgress: false,
      isBeforeStart: false,
      isComplete: today >= targetDate,
    };
  }

  if (targetDate <= configuredStart) {
    return invalidResult('Target date must be after start date', configuredStart, targetDate);
  }
  const totalDays = countDays(configuredStart, targetDate, dayMode);
  if (totalDays < 1) {
    return invalidResult('The selected period contains no counted days', configuredStart, targetDate);
  }

  const isBeforeStart = today < configuredStart;
  const isComplete = today >= targetDate;
  const elapsedDays = isBeforeStart
    ? 0
    : isComplete
      ? totalDays
      : Math.min(totalDays, countDays(configuredStart, today, dayMode));
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const progress = Math.max(0, Math.min(100, Math.round((elapsedDays / totalDays) * 100)));

  return {
    startDate: configuredStart,
    targetDate,
    totalDays,
    elapsedDays,
    remainingDays,
    progress,
    hasProgress: true,
    isBeforeStart,
    isComplete,
  };
}

function invalidResult(
  error: string,
  startDate: Date | null = null,
  targetDate: Date | null = null,
): DaysUntilCalculation {
  return {
    startDate,
    targetDate,
    totalDays: 0,
    elapsedDays: 0,
    remainingDays: 0,
    progress: 0,
    hasProgress: false,
    isBeforeStart: false,
    isComplete: false,
    error,
  };
}
