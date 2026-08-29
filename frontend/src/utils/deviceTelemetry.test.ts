import { describe, expect, it } from 'vitest';
import { presentDeviceTelemetry } from './deviceTelemetry';

const base = { id: 1, name: 'fixture', deviceType: 'web-display' as const, transport: 'websocket' as const, status: 'online' as const, isOnline: true, lastSeenAt: new Date().toISOString(), battery: null, wifi: null, userId: 1, createdAt: '', updatedAt: '' };

describe('presentDeviceTelemetry', () => {
  it('hides browser defaults and keeps an explicit websocket zero', () => {
    expect(presentDeviceTelemetry(base)).toMatchObject({ showBattery: false, showWirelessSignal: false });
    expect(presentDeviceTelemetry({ ...base, capabilities: { energy: { source: 'battery' } }, telemetryStatus: { batteryPercent: 0, rssi: null, source: 'websocket', updatedAt: '2026-08-29T00:00:00.000Z' } })).toMatchObject({ battery: 0, showBattery: true });
  });

  it('only shows a battery for battery or hybrid profiles and signal for a reported RSSI', () => {
    expect(presentDeviceTelemetry({ ...base, capabilities: { energy: { source: 'mains' } }, telemetryStatus: { batteryPercent: 75, rssi: -60, source: 'websocket', updatedAt: null } })).toMatchObject({ showBattery: false, showWirelessSignal: true });
    expect(presentDeviceTelemetry({ ...base, capabilities: { energy: { source: 'hybrid' } }, telemetryStatus: { batteryPercent: 75, rssi: null, source: 'legacy-pull', updatedAt: null } })).toMatchObject({ showBattery: true, showWirelessSignal: false });
  });

  it('keeps stale telemetry provenance for the view to label rather than inventing a fresh value', () => {
    const stale = '2026-08-01T00:00:00.000Z';
    expect(presentDeviceTelemetry({ ...base, capabilities: { energy: { source: 'battery' } }, telemetryStatus: { batteryPercent: 24, rssi: -91, source: 'legacy-pull', updatedAt: stale } }))
      .toEqual({ battery: 24, rssi: -91, source: 'legacy-pull', updatedAt: stale, showBattery: true, showWirelessSignal: true });
  });
});
