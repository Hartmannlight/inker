export interface DisplayControlSettings {
  brightness: number;
  scheduleEnabled: boolean;
  dimStartAt: string;
  dimStopAt: string;
  dimBrightness: number;
  timezone: string;
  foregroundColor: string;
  backgroundColor: string;
}

export interface ResolvedDisplayControl extends DisplayControlSettings {
  effectiveBrightness: number;
  mode: 'manual' | 'scheduled-day' | 'scheduled-dim';
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';

export const defaultDisplayControl = (): DisplayControlSettings => ({
  brightness: 100,
  scheduleEnabled: false,
  dimStartAt: '22:00',
  dimStopAt: '07:00',
  dimBrightness: 20,
  timezone: DEFAULT_TIMEZONE,
  foregroundColor: '#000000',
  backgroundColor: '#ffffff',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function percentage(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error(`${field} must be an integer from 0 to 100`);
  }
  return value as number;
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${field} must be a #RRGGBB color`);
  }
  return value.toLowerCase();
}

/** Strict validation for the admin REST boundary. */
export function parseDisplayControlInput(value: unknown): DisplayControlSettings {
  if (!isRecord(value)) throw new Error('Display control settings must be an object');
  const defaults = defaultDisplayControl();
  const brightness = percentage(value.brightness ?? defaults.brightness, 'brightness');
  const dimBrightness = percentage(value.dimBrightness ?? defaults.dimBrightness, 'dimBrightness');
  const scheduleEnabled = value.scheduleEnabled ?? defaults.scheduleEnabled;
  if (typeof scheduleEnabled !== 'boolean') throw new Error('scheduleEnabled must be a boolean');
  const dimStartAt = value.dimStartAt ?? defaults.dimStartAt;
  const dimStopAt = value.dimStopAt ?? defaults.dimStopAt;
  if (typeof dimStartAt !== 'string' || !TIME_PATTERN.test(dimStartAt)) throw new Error('dimStartAt must be in HH:MM format');
  if (typeof dimStopAt !== 'string' || !TIME_PATTERN.test(dimStopAt)) throw new Error('dimStopAt must be in HH:MM format');
  const timezone = value.timezone ?? defaults.timezone;
  if (typeof timezone !== 'string' || timezone.length > 128 || !validTimezone(timezone)) throw new Error('timezone must be a valid IANA timezone');
  const foregroundColor = color(value.foregroundColor ?? defaults.foregroundColor, 'foregroundColor');
  const backgroundColor = color(value.backgroundColor ?? defaults.backgroundColor, 'backgroundColor');
  return { brightness, scheduleEnabled, dimStartAt, dimStopAt, dimBrightness, timezone, foregroundColor, backgroundColor };
}

/** Tolerant read for existing devices whose JSON predates display controls. */
export function readDisplayControl(configuration: unknown): DisplayControlSettings {
  const root = isRecord(configuration) ? configuration : {};
  try {
    return parseDisplayControlInput(root.displayControl ?? {});
  } catch {
    return defaultDisplayControl();
  }
}

function minutesInTimezone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function resolveDisplayControl(configuration: unknown, now = new Date()): ResolvedDisplayControl {
  const settings = readDisplayControl(configuration);
  if (!settings.scheduleEnabled) {
    return { ...settings, effectiveBrightness: settings.brightness, mode: 'manual' };
  }
  const current = minutesInTimezone(now, settings.timezone);
  const start = timeToMinutes(settings.dimStartAt);
  const stop = timeToMinutes(settings.dimStopAt);
  const dimmed = start !== stop && (start < stop
    ? current >= start && current < stop
    : current >= start || current < stop);
  return {
    ...settings,
    effectiveBrightness: dimmed ? settings.dimBrightness : settings.brightness,
    mode: dimmed ? 'scheduled-dim' : 'scheduled-day',
  };
}
