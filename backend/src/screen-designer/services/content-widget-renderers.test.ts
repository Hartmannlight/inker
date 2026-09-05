import { describe, expect, test } from 'bun:test';
import {
  calendarWidget,
  daysUntilWidget,
  textWidget,
  textWidgetStyles,
  type ContentWidgetTools,
} from './content-widget-renderers';

const tools: ContentWidgetTools = {
  escapeHtml: (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  mapFontFamily: (value) => value,
  sanitizeColor: (value) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000',
};

describe('content widget renderers', () => {
  test('escapes text and rejects unsupported alignment and weight values', () => {
    expect(textWidget({ text: '<script>', textAlign: 'position:fixed' }, tools)).toContain('&lt;script&gt;');
    expect(textWidget({ text: 'safe', textAlign: 'position:fixed' }, tools)).toContain('text-align: left');
    expect(textWidgetStyles({ fontWeight: '900;position:fixed' }, tools)).toContain('font-weight: normal');
  });

  test('renders a deterministic calendar without unescaped locale labels', () => {
    const html = calendarWidget(
      { locale: 'en-US', weekStart: 'monday', showHeader: true },
      700,
      500,
      'UTC',
      tools,
      new Date('2026-09-05T12:00:00Z'),
    );
    expect(html).toContain('September 2026');
    expect(html).toContain('>5</span>');
  });

  test('renders validation errors for invalid days-until data', () => {
    expect(daysUntilWidget({ inputMode: 'duration' }, tools)).toContain('Start date is required');
  });
});
