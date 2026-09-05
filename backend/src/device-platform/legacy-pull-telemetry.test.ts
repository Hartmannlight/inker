import { describe, expect, test } from 'bun:test';
import { mergeLegacyPullTelemetry } from './legacy-pull-telemetry';

describe('legacy pull telemetry merge', () => {
  test('preserves unrelated telemetry and merges valid pull measurements', () => {
    expect(mergeLegacyPullTelemetry(
      { connected: { brightness: 40 }, legacyPull: { batteryPercent: 50 } },
      { battery: 75, wifi: -48 },
      new Date('2026-09-05T12:00:00.000Z'),
    )).toEqual({
      connected: { brightness: 40 },
      legacyPull: { batteryPercent: 75, rssi: -48 },
      updatedAt: '2026-09-05T12:00:00.000Z',
    });
  });

  test('normalizes malformed legacy data and ignores non-finite measurements', () => {
    expect(mergeLegacyPullTelemetry(
      ['not', 'an', 'object'],
      { battery: Number.NaN, wifi: Number.POSITIVE_INFINITY },
      new Date('2026-09-05T12:00:00.000Z'),
    )).toEqual({ legacyPull: {}, updatedAt: '2026-09-05T12:00:00.000Z' });
  });
});
