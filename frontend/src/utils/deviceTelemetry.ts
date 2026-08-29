import type { Device } from '../types';

export type DeviceTelemetryPresentation = { battery: number | null; rssi: number | null; source: 'websocket' | 'legacy-pull' | null; updatedAt: string | null; showBattery: boolean; showWirelessSignal: boolean };
type CapabilityShape = { energy?: { source?: string } };
type TelemetryShape = { batteryPercent?: number | null; rssi?: number | null; source?: DeviceTelemetryPresentation['source']; updatedAt?: string | null };

/** The shared display policy; legacy default zeroes have no measurement provenance. */
export function presentDeviceTelemetry(device: Device): DeviceTelemetryPresentation {
  const telemetry = device.telemetryStatus as TelemetryShape | undefined;
  const energy = (device.capabilities as CapabilityShape | null | undefined)?.energy?.source;
  const battery = telemetry?.batteryPercent ?? null;
  const rssi = telemetry?.rssi ?? null;
  return { battery, rssi, source: telemetry?.source ?? null, updatedAt: telemetry?.updatedAt ?? null, showBattery: (energy === 'battery' || energy === 'hybrid') && battery !== null, showWirelessSignal: rssi !== null };
}
