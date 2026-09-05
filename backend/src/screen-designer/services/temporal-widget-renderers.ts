type WidgetConfig = Record<string, unknown>;

export interface TemporalWidgetTools {
  escapeHtml(value: string): string;
  mapFontFamily(value: string): string;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value ? value : fallback;
const number = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function timezone(config: WidgetConfig, defaultTimezone: string): string {
  const configured = typeof config.timezone === 'string' ? config.timezone : '';
  return configured === '' || configured === 'local' ? defaultTimezone : configured;
}

export function clockWidget(
  config: WidgetConfig,
  defaultTimezone: string,
  tools: TemporalWidgetTools,
  now = new Date(),
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone(config, defaultTimezone),
    hour: '2-digit',
    minute: '2-digit',
    second: config.showSeconds ? '2-digit' : undefined,
    hour12: text(config.format, '24h') === '12h',
  };
  return tools.escapeHtml(now.toLocaleTimeString('en-US', options));
}

export function clockWidgetStyles(config: WidgetConfig, tools: TemporalWidgetTools): string {
  const fontSize = number(config.fontSize, 48);
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'monospace'));
  const textAlign = text(config.textAlign, 'left');
  const justifyContent = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center';
  return `font-size: ${fontSize}px; font-family: ${fontFamily}; justify-content: ${justifyContent}; white-space: nowrap; padding: 0 8px;`;
}

export function dateWidget(
  config: WidgetConfig,
  defaultTimezone: string,
  tools: TemporalWidgetTools,
  now = new Date(),
): string {
  const locale = text(config.locale, 'en-US');
  const showWeekday = Boolean(config.showWeekday ?? config.showDayOfWeek ?? false);
  const showDay = Boolean(config.showDay ?? true);
  const showMonth = Boolean(config.showMonth ?? true);
  const showYear = Boolean(config.showYear ?? true);
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone(config, defaultTimezone) };
  if (showWeekday) options.weekday = 'long';
  if (showDay) options.day = 'numeric';
  if (showMonth) options.month = 'long';
  if (showYear) options.year = 'numeric';
  if (!showWeekday && !showDay && !showMonth && !showYear) {
    options.day = 'numeric';
    options.month = 'long';
    options.year = 'numeric';
  }
  return tools.escapeHtml(now.toLocaleDateString(locale, options));
}

export function dateWidgetStyles(config: WidgetConfig, tools: TemporalWidgetTools): string {
  const fontSize = number(config.fontSize, 24);
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'sans-serif'));
  const textAlign = text(config.textAlign, 'center');
  const justifyContent = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center';
  return `font-size: ${fontSize}px; font-family: ${fontFamily}; line-height: ${fontSize * 1.2}px; white-space: nowrap; padding: 0 8px; justify-content: ${justifyContent};`;
}

export function countdownWidget(
  config: WidgetConfig,
  tools: TemporalWidgetTools,
  now = new Date(),
): string {
  const target = new Date(text(config.targetDate, '2025-12-31T23:59:59'));
  const label = text(config.label, '');
  const diffMs = target.getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return tools.escapeHtml(label || "Time's up!");

  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const seconds = Math.floor((diffMs % 60_000) / 1000);
  const parts: string[] = [];
  if (config.showDays !== false && days > 0) parts.push(`${days}d`);
  if (config.showHours !== false) parts.push(`${hours.toString().padStart(2, '0')}h`);
  if (config.showMinutes !== false) parts.push(`${minutes.toString().padStart(2, '0')}m`);
  if (config.showSeconds !== false) parts.push(`${seconds.toString().padStart(2, '0')}s`);

  const fontSize = number(config.fontSize, 32);
  const heading = label
    ? `<div style="font-size: ${fontSize * 0.5}px; margin-bottom: 4px;">${tools.escapeHtml(label)}</div>`
    : '';
  return `${heading}<div style="font-weight: bold;">${tools.escapeHtml(parts.join(' '))}</div>`;
}

export function countdownWidgetStyles(config: WidgetConfig, tools: TemporalWidgetTools): string {
  const fontSize = number(config.fontSize, 32);
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'monospace'));
  return `font-size: ${fontSize}px; font-family: ${fontFamily}; flex-direction: column; justify-content: center; white-space: nowrap; padding: 0 8px;`;
}
