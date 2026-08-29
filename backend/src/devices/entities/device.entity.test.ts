import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  isDeviceOnline,
  calculateDeviceStatus,
  getOfflineThresholdMs,
  serializeDevice,
  serializeDevices,
  isNewerVersion,
  normalizeDeviceTelemetry,
} from './device.entity';

describe('device.entity', () => {
  const originalEnv = process.env.DEVICE_OFFLINE_THRESHOLD;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEVICE_OFFLINE_THRESHOLD;
    } else {
      process.env.DEVICE_OFFLINE_THRESHOLD = originalEnv;
    }
  });

  describe('getOfflineThresholdMs', () => {
    it('should return 5 minutes by default', () => {
      delete process.env.DEVICE_OFFLINE_THRESHOLD;
      expect(getOfflineThresholdMs()).toBe(300000);
    });

    it('should use environment variable when set', () => {
      process.env.DEVICE_OFFLINE_THRESHOLD = '60000';
      expect(getOfflineThresholdMs()).toBe(60000);
    });

    it('should fall back to default for invalid env value', () => {
      process.env.DEVICE_OFFLINE_THRESHOLD = 'abc';
      expect(getOfflineThresholdMs()).toBe(300000);
    });

    it('should fall back to default for negative value', () => {
      process.env.DEVICE_OFFLINE_THRESHOLD = '-1';
      expect(getOfflineThresholdMs()).toBe(300000);
    });
  });

  describe('isDeviceOnline', () => {
    it('should return false when device is not active', () => {
      expect(isDeviceOnline({ isActive: false, lastSeenAt: new Date() })).toBe(false);
    });

    it('should return false when lastSeenAt is null', () => {
      expect(isDeviceOnline({ isActive: true, lastSeenAt: null })).toBe(false);
    });

    it('should return true when seen recently', () => {
      const recentDate = new Date(Date.now() - 60000); // 1 min ago
      expect(isDeviceOnline({ isActive: true, lastSeenAt: recentDate })).toBe(true);
    });

    it('should return false when seen too long ago', () => {
      const staleDate = new Date(Date.now() - 600000); // 10 min ago
      expect(isDeviceOnline({ isActive: true, lastSeenAt: staleDate })).toBe(false);
    });
  });

  describe('calculateDeviceStatus', () => {
    it('should return online for active recent device', () => {
      expect(calculateDeviceStatus({ isActive: true, lastSeenAt: new Date() })).toBe('online');
    });

    it('should return offline for inactive device', () => {
      expect(calculateDeviceStatus({ isActive: false, lastSeenAt: new Date() })).toBe('offline');
    });
  });

  describe('serializeDevice', () => {
    it('should add status and isOnline fields', () => {
      const device = { id: 1, isActive: true, lastSeenAt: new Date() };
      const result = serializeDevice(device);
      expect(result.status).toBe('online');
      expect(result.isOnline).toBe(true);
      expect(result.id).toBe(1);
    });

    it('keeps explicit websocket zero telemetry but hides unproven legacy defaults', () => {
      expect(normalizeDeviceTelemetry({ battery: 0, wifi: 0, lastSeenAt: new Date('2026-08-29T00:00:00.000Z') }))
        .toEqual({ batteryPercent: null, rssi: null, source: null, updatedAt: null });
      expect(normalizeDeviceTelemetry({ battery: 0, wifi: 0, telemetry: { websocket: { batteryPercent: 0, rssi: 0 }, updatedAt: '2026-08-29T00:00:00.000Z' } }))
        .toEqual({ batteryPercent: 0, rssi: 0, source: 'websocket', updatedAt: '2026-08-29T00:00:00.000Z' });
      expect(normalizeDeviceTelemetry({ battery: 0, wifi: 0, telemetry: { legacyPull: { batteryPercent: 0, rssi: 0 }, updatedAt: '2026-08-29T00:00:00.000Z' } }))
        .toEqual({ batteryPercent: 0, rssi: 0, source: 'legacy-pull', updatedAt: '2026-08-29T00:00:00.000Z' });
    });

    it('normalizes legacy pull values with their observation time', () => {
      const seenAt = new Date('2026-08-29T01:02:03.000Z');
      expect(normalizeDeviceTelemetry({ battery: 72, wifi: -63, lastSeenAt: seenAt }))
        .toEqual({ batteryPercent: 72, rssi: -63, source: 'legacy-pull', updatedAt: seenAt.toISOString() });
    });

    it('never serializes credential, pairing or enrollment hashes', () => {
      const device = {
        id: 1,
        isActive: true,
        lastSeenAt: new Date(),
        apiKey: 'raw-api-key',
        credentials: [{ credentialId: 'cred-1', tokenHash: 'token-hash', kind: 'device' }],
        enrollments: [{ enrollmentId: 'enrollment-1', codeHash: 'code-hash', attemptCount: 1 }],
      };
      const result = serializeDevice(device) as any;
      expect(result.apiKey).toBeUndefined();
      expect(result.credentials).toEqual([{ credentialId: 'cred-1', kind: 'device' }]);
      expect(result.enrollments).toEqual([{ enrollmentId: 'enrollment-1', attemptCount: 1 }]);
    });
  });

  describe('serializeDevices', () => {
    it('should serialize array of devices', () => {
      const devices = [
        { id: 1, isActive: true, lastSeenAt: new Date() },
        { id: 2, isActive: false, lastSeenAt: null },
      ];
      const result = serializeDevices(devices);
      expect(result).toHaveLength(2);
      expect(result[0].isOnline).toBe(true);
      expect(result[1].isOnline).toBe(false);
    });
  });

  describe('isNewerVersion', () => {
    it('should return true when candidate is a newer patch', () => {
      expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    });

    it('should return true when candidate is a newer minor', () => {
      expect(isNewerVersion('1.2.0', '1.0.9')).toBe(true);
    });

    it('should compare numeric parts, not lexically (1.10 > 1.9)', () => {
      expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    });

    it('should return false for equal versions', () => {
      expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    });

    it('should return false when candidate is older', () => {
      expect(isNewerVersion('1.0.0', '1.7.8')).toBe(false);
    });

    it('should ignore a leading "v"', () => {
      expect(isNewerVersion('v2.0.0', '1.9.9')).toBe(true);
    });

    it('should return false for missing or malformed input', () => {
      expect(isNewerVersion(undefined, '1.0.0')).toBe(false);
      expect(isNewerVersion('1.0.0', null)).toBe(false);
      expect(isNewerVersion('', '1.0.0')).toBe(false);
      expect(isNewerVersion('abc', '1.0.0')).toBe(false);
    });
  });
});
