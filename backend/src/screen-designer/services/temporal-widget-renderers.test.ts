import { describe, expect, it } from 'bun:test';
import {
  clockWidget,
  clockWidgetStyles,
  countdownWidget,
  dateWidget,
  type TemporalWidgetTools,
} from './temporal-widget-renderers';

const tools: TemporalWidgetTools = {
  escapeHtml: (value) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  mapFontFamily: (value) => `mapped(${value})`,
};
const now = new Date('2026-01-02T13:04:05.000Z');

describe('temporal widget renderers', () => {
  it('renders clocks from an explicit timezone and clock value', () => {
    expect(clockWidget({ format: '24h', showSeconds: true }, 'UTC', tools, now)).toBe('13:04:05');
    expect(clockWidget({ format: '12h' }, 'UTC', tools, now)).toContain('01:04 PM');
  });

  it('uses the configured default timezone for local date widgets', () => {
    expect(dateWidget({ timezone: 'local', locale: 'en-US' }, 'UTC', tools, now))
      .toBe('January 2, 2026');
  });

  it('falls back to a useful date when every display flag is disabled', () => {
    expect(dateWidget({ showDay: false, showMonth: false, showYear: false }, 'UTC', tools, now))
      .toBe('January 2, 2026');
  });

  it('renders a deterministic countdown and escapes its label', () => {
    const html = countdownWidget({ targetDate: '2026-01-03T15:07:09.000Z', label: '<launch>' }, tools, now);
    expect(html).toContain('1d 02h 03m 04s');
    expect(html).toContain('&lt;launch&gt;');
    expect(html).not.toContain('<launch>');
  });

  it('does not interpolate non-numeric font sizes into styles', () => {
    const styles = clockWidgetStyles({ fontSize: '1;background:red', fontFamily: 'monospace' }, tools);
    expect(styles).toContain('font-size: 48px');
    expect(styles).toContain('mapped(monospace)');
    expect(styles).not.toContain('background:red');
  });
});
