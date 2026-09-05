import {
  calculateDaysUntil,
  type DaysUntilCalculationConfig,
} from '@inker/contracts';

type WidgetConfig = Record<string, unknown>;

export function stripDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export function calendarLayout(
  width: number,
  height: number,
  labels: string[],
  title: string,
  showHeader: boolean,
  weekRows: number,
  scale: number,
) {
  const headerH = showHeader ? Math.max(14, Math.floor(height * 0.15)) : 0;
  const cell = Math.min(width / 7, (height - headerH) / (weekRows + 1));
  const maxLabelLen = Math.max(...labels.map((label) => label.length), 1);
  const daySize = Math.max(8, Math.floor(cell * 0.42 * scale));
  const labelSize = Math.max(7, Math.floor(Math.min(cell * 0.34, (cell * 0.92) / (maxLabelLen * 0.62)) * scale));
  const headerSize = showHeader
    ? Math.max(10, Math.floor(Math.min(headerH * 0.6, (width * 0.9) / (Math.max(title.length, 1) * 0.6)) * scale))
    : 0;
  const dot = Math.max(12, Math.min(Math.floor(cell * 0.92), Math.floor(cell * 0.8 * scale)));
  const cellBase = 'display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;min-height:0;';
  const gridStyle = `flex:1;min-height:0;box-sizing:border-box;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:repeat(${weekRows + 1},minmax(0,1fr));text-align:center;overflow:hidden;`;
  return { headerH, headerSize, labelSize, daySize, dot, gridStyle, cellBase };
}

export interface ContentWidgetTools {
  escapeHtml(value: string): string;
  mapFontFamily(value: string): string;
  sanitizeColor(value: string, fallback?: string): string;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value ? value : fallback;
const number = (value: unknown, fallback: number): number => {
  const candidate = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(candidate) ? candidate : fallback;
};
const choice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;

function daysUntilConfig(config: WidgetConfig): DaysUntilCalculationConfig {
  return {
    inputMode: choice(config.inputMode, ['targetDate', 'duration'] as const, 'targetDate'),
    startDate: typeof config.startDate === 'string' ? config.startDate : undefined,
    targetDate: typeof config.targetDate === 'string' ? config.targetDate : undefined,
    durationDays: typeof config.durationDays === 'number' ? config.durationDays : undefined,
    dayMode: choice(config.dayMode, ['calendar', 'workdays'] as const, 'calendar'),
  };
}

export function calendarWidget(
  config: WidgetConfig,
  width: number,
  height: number,
  defaultTimezone: string,
  tools: ContentWidgetTools,
  now = new Date(),
): string {
  const locale = text(config.locale, 'en-US');
  const configuredTimezone = typeof config.timezone === 'string' ? config.timezone : '';
  const timezone = configuredTimezone === '' || configuredTimezone === 'local'
    ? defaultTimezone
    : configuredTimezone;
  const weekStartsMonday = choice(config.weekStart, ['sunday', 'monday'] as const, 'sunday') === 'monday';
  const showHeader = config.showHeader !== false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const today = part('day');
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = weekStartsMonday ? (firstWeekday + 6) % 7 : firstWeekday;
  const labelFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const allLabels = Array.from({ length: 7 }, (_, index) =>
    stripDiacritics(labelFormatter.format(new Date(2023, 0, 1 + index, 12))),
  );
  const labels = weekStartsMonday ? [...allLabels.slice(1), allLabels[0]] : allLabels;
  const gridLines = config.gridLines === true;
  const highlightWeekends = config.highlightWeekends === true;
  const scale = Math.max(0.3, number(config.fontScale, 100) / 100);
  const title = stripDiacritics(new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: 'long',
    year: 'numeric',
  }).format(now));
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'sans-serif'));
  const weekRows = Math.ceil((lead + daysInMonth) / 7);
  const { headerH, headerSize, labelSize, daySize, dot, gridStyle, cellBase } = calendarLayout(
    width, height, labels, title, showHeader, weekRows, scale,
  );
  const shade = (weekend: boolean): string => highlightWeekends && weekend ? 'background:#cccccc;' : '';
  const cellBorder = gridLines ? 'border-right:1px solid #000;border-bottom:1px solid #000;' : '';
  const gridFrame = gridLines ? 'border-top:1px solid #000;border-left:1px solid #000;' : '';
  const headerCells = labels.map((label, index) => {
    const weekday = weekStartsMonday ? (index + 1) % 7 : index;
    const weekend = weekday === 0 || weekday === 6;
    return `<div style="${cellBase}font-weight:600;font-size:${labelSize}px;text-transform:uppercase;letter-spacing:0.03em;white-space:nowrap;${cellBorder}border-bottom:2px solid #000;${shade(weekend)}">${tools.escapeHtml(label)}</div>`;
  }).join('');
  const blanks = Array.from({ length: lead }, () => `<div style="${cellBorder}"></div>`).join('');
  const dayCells = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const weekday = (firstWeekday + index) % 7;
    const inner = day === today
      ? `<span style="display:flex;align-items:center;justify-content:center;width:${dot}px;height:${dot}px;background:#000;color:#fff;border-radius:50%;font-weight:600;">${day}</span>`
      : String(day);
    return `<div style="${cellBase}font-size:${daySize}px;${cellBorder}${shade(weekday === 0 || weekday === 6)}">${inner}</div>`;
  }).join('');

  return `<div style="width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;font-family:${fontFamily};color:#000;padding:4px;overflow:hidden;">`
    + (showHeader ? `<div style="height:${headerH}px;line-height:${headerH}px;text-align:center;font-weight:700;font-size:${headerSize}px;letter-spacing:0.02em;white-space:nowrap;overflow:hidden;">${tools.escapeHtml(title)}</div>` : '')
    + `<div style="${gridStyle}${gridFrame}">${headerCells}${blanks}${dayCells}</div></div>`;
}

export const calendarWidgetStyles = (): string =>
  'align-items: stretch; justify-content: stretch; padding: 0;';

export function textWidget(config: WidgetConfig, tools: ContentWidgetTools): string {
  const align = choice(config.textAlign, ['left', 'center', 'right'] as const, 'left');
  return `<div style="width: 100%; text-align: ${align};">${tools.escapeHtml(text(config.text, 'Text'))}</div>`;
}

export function textWidgetStyles(config: WidgetConfig, tools: ContentWidgetTools): string {
  const fontSize = number(config.fontSize, 24);
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'sans-serif'));
  const fontWeight = choice(config.fontWeight, ['normal', 'bold', 'lighter', 'bolder'] as const, 'normal');
  const color = tools.sanitizeColor(text(config.color, '#000000'));
  return `font-size: ${fontSize}px; font-family: ${fontFamily}; font-weight: ${fontWeight}; color: ${color}; padding: 10px; line-height: 1.2;`;
}

export function daysUntilWidget(config: WidgetConfig, tools: ContentWidgetTools): string {
  const calculation = calculateDaysUntil(daysUntilConfig(config));
  if (calculation.error) {
    return `<div style="font-size:14px;text-align:center;color:#666;">${tools.escapeHtml(calculation.error)}</div>`;
  }
  const prefix = text(config.labelPrefix, '');
  const suffix = text(config.labelSuffix, ' days until vacation');
  const label = `${prefix}${calculation.remainingDays}${suffix}`;
  const design = choice(config.design, ['text', 'progressBar', 'compact', 'segments'] as const, 'text');
  const showPercentage = config.showPercentage !== false;
  const progress = calculation.hasProgress ? calculation.progress : 0;
  const color = tools.sanitizeColor(text(config.color, '#000000'));
  if (design === 'text') return tools.escapeHtml(label);
  if (!calculation.hasProgress) {
    return `<div style="text-align:center;"><div>${tools.escapeHtml(label)}</div><div style="font-size:12px;color:#666;">Set a start date to show progress</div></div>`;
  }
  if (design === 'compact') {
    return `<div style="display:flex;align-items:center;width:100%;height:100%;gap:12px;padding:8px;box-sizing:border-box;"><div style="font-size:min(72px,1.8em);font-weight:700;line-height:1;">${calculation.remainingDays}</div><div style="display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;"><div style="font-size:0.55em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${tools.escapeHtml(text(config.eventName, 'Vacation'))}</div><div style="height:12px;border:1px solid ${color};padding:1px;"><div style="height:100%;width:${progress}%;background:${color};"></div></div>${showPercentage ? `<div style="font-size:0.4em;">${progress}%</div>` : ''}</div></div>`;
  }
  if (design === 'segments') {
    const filled = Math.round(progress / 5);
    const segments = Array.from({ length: 20 }, (_, index) =>
      `<span style="display:block;min-width:0;border:1px solid ${color};background:${index < filled ? color : 'white'};"></span>`,
    ).join('');
    return `<div style="display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;gap:8px;padding:8px;box-sizing:border-box;"><div style="display:flex;justify-content:space-between;gap:8px;font-size:0.55em;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tools.escapeHtml(label)}</span>${showPercentage ? `<strong>${progress}%</strong>` : ''}</div><div style="display:grid;grid-template-columns:repeat(20,minmax(0,1fr));gap:1px;height:20px;">${segments}</div></div>`;
  }
  return `<div style="display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;gap:7px;padding:8px;box-sizing:border-box;"><div style="display:flex;justify-content:space-between;gap:8px;font-size:0.55em;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tools.escapeHtml(label)}</span>${showPercentage ? `<strong>${progress}%</strong>` : ''}</div><div style="height:20px;border:2px solid ${color};padding:2px;"><div style="height:100%;width:${progress}%;background:${color};"></div></div><div style="display:flex;justify-content:space-between;font-size:0.36em;"><span>${calculation.elapsedDays} done</span><span>${calculation.totalDays} total</span></div></div>`;
}

export function daysUntilWidgetStyles(config: WidgetConfig, tools: ContentWidgetTools): string {
  const fontSize = number(config.fontSize, 32);
  const fontFamily = tools.mapFontFamily(text(config.fontFamily, 'sans-serif'));
  const color = tools.sanitizeColor(text(config.color, '#000000'));
  return `font-size: ${fontSize}px; font-family: ${fontFamily}; color: ${color}; white-space: nowrap; padding: 0; align-items: stretch; justify-content: stretch;`;
}
