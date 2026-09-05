import { describe, expect, it } from 'bun:test';
import {
  batteryWidget,
  deviceInfoWidget,
  dividerWidget,
  rectangleWidget,
  wifiWidget,
  type WidgetHtmlTools,
} from './device-widget-renderers';

const tools: WidgetHtmlTools = {
  escapeHtml: (value) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  sanitizeColor: (value, fallback = '#000000') => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback,
};

describe('device widget renderers', () => {
  it('renders bounded battery state and the external-power fallback', () => {
    expect(batteryWidget({ showIcon: true, showPercentage: true }, { battery: 50 }))
      .toContain('width="7"');
    expect(batteryWidget({}, undefined)).toContain('External power');
  });

  it('distinguishes unavailable WiFi from a measured RSSI', () => {
    expect(wifiWidget({}, undefined)).toContain('Signal unavailable');
    expect(wifiWidget({ showIcon: false }, { wifi: -51.4 })).toContain('-51 dBm');
  });

  it('escapes all device-controlled information', () => {
    const html = deviceInfoWidget({ showMac: true }, {
      deviceName: '<name>', firmwareVersion: '<firmware>', macAddress: '<mac>',
    }, tools);
    expect(html).not.toContain('<name>');
    expect(html).toContain('&lt;name&gt;');
    expect(html).toContain('&lt;firmware&gt;');
    expect(html).toContain('&lt;mac&gt;');
  });

  it('sanitizes divider colors and ignores non-numeric thickness', () => {
    const html = dividerWidget({ color: 'url(evil)', thickness: 'huge', orientation: 'vertical' }, tools);
    expect(html).toContain('#000000');
    expect(html).toContain('width: 2px; height: 100%');
    expect(html).not.toContain('url(evil)');
  });

  it('sanitizes rectangle colors and omits invalid borders', () => {
    const html = rectangleWidget({ backgroundColor: '#123456', borderColor: 'bad', borderWidth: 'wide' }, tools);
    expect(html).toContain('background-color: #123456');
    expect(html).toContain('border: none');
    expect(html).not.toContain('bad');
  });
});
