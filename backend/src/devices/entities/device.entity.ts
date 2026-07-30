import { Device as PrismaDevice } from '@prisma/client';

/**
 * Device entity with computed status and isOnline fields
 *
 * This serializer adds computed fields based on device activity
 * to match frontend expectations (online/offline status)
 */

export type DeviceStatus = 'online' | 'offline';

/**
 * Get the offline threshold in milliseconds from environment variable
 * Default: 5 minutes (300000ms)
 * Configurable via DEVICE_OFFLINE_THRESHOLD environment variable
 */
export function getOfflineThresholdMs(): number {
  const envValue = process.env.DEVICE_OFFLINE_THRESHOLD;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Default: 5 minutes
  return 5 * 60 * 1000;
}

/**
 * Check if a device is online based on lastSeenAt timestamp
 *
 * A device is considered online if:
 * - isActive is true AND
 * - lastSeenAt is within the offline threshold (default: 5 minutes)
 *
 * @param device - Device from database
 * @returns true if device is online, false otherwise
 */
export function isDeviceOnline(device: {
  isActive: boolean;
  lastSeenAt: Date | null;
}): boolean {
  // Device is offline if not active
  if (!device.isActive) {
    return false;
  }

  // Device is offline if never seen
  if (!device.lastSeenAt) {
    return false;
  }

  // Check if device was seen recently (within threshold)
  const thresholdMs = getOfflineThresholdMs();
  const thresholdTime = new Date(Date.now() - thresholdMs);
  return device.lastSeenAt > thresholdTime;
}

/**
 * Calculate device status based on lastSeenAt timestamp and isActive flag
 *
 * A device is considered:
 * - 'offline': if isActive is false OR lastSeenAt is older than threshold
 * - 'online': if isActive is true AND lastSeenAt is within the threshold
 *
 * @param device - Device from database
 * @returns 'online' or 'offline' status
 */
export function calculateDeviceStatus(device: {
  isActive: boolean;
  lastSeenAt: Date | null;
}): DeviceStatus {
  return isDeviceOnline(device) ? 'online' : 'offline';
}

/**
 * Compare two semver-ish version strings and report whether `candidate` is newer
 * than `current`.
 *
 * Used to show an informational "newer firmware available" note on the device
 * detail page — Inker never pushes OTA updates. Handles a leading "v" and compares
 * dot-separated numeric parts (e.g. "1.7.8" vs "1.10.0"). Non-numeric or empty
 * input returns false so a malformed version never triggers a false positive.
 *
 * @param candidate - the version to test (e.g. latest stable firmware)
 * @param current - the baseline version (e.g. device's current firmware)
 * @returns true only if candidate is strictly newer than current
 */
export function isNewerVersion(candidate?: string | null, current?: string | null): boolean {
  if (!candidate || !current) {
    return false;
  }

  const parse = (v: string): number[] | null => {
    const parts = v.trim().replace(/^v/i, '').split('.');
    const nums = parts.map((p) => parseInt(p, 10));
    return nums.some((n) => isNaN(n)) ? null : nums;
  };

  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) {
    return false;
  }

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * Serialized device type with computed fields
 */
export type SerializedDevice<T> = T & {
  status: DeviceStatus;
  isOnline: boolean;
  firmwareUpdateAvailable?: boolean;
  latestFirmwareVersion?: string | null;
};

/**
 * Serialize device with computed status and isOnline fields
 *
 * @param device - Device with relations from Prisma
 * @returns Device object with added 'status' and 'isOnline' fields
 */
export function serializeDevice<T extends { isActive: boolean; lastSeenAt: Date | null }>(
  device: T,
): SerializedDevice<Omit<T, 'apiKey'>> {
  const online = isDeviceOnline(device);
  const { apiKey, ...rest } = device as T & { apiKey?: string };
  return {
    ...rest,
    status: online ? 'online' : 'offline',
    isOnline: online,
  };
}

/**
 * Serialize array of devices with computed status and isOnline fields
 *
 * @param devices - Array of devices from Prisma
 * @returns Array of devices with added 'status' and 'isOnline' fields
 */
export function serializeDevices<T extends { isActive: boolean; lastSeenAt: Date | null }>(
  devices: T[],
): Array<SerializedDevice<Omit<T, 'apiKey'>>> {
  return devices.map(serializeDevice);
}
