import type { DeviceStatus } from '@inker/contracts';
import {
  resolveDeviceConfiguration,
  type PersistedDeliveryPolicy,
  type PersistedDeviceProfile,
} from '../../device-platform/device-configuration';
export { isNewerVersion } from '../../common/utils/version.util';

export type { DeviceStatus } from '@inker/contracts';

/**
 * Device entity with computed status and isOnline fields
 *
 * This serializer adds computed fields based on device activity
 * to match frontend expectations (online/offline status)
 */

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
/**
 * Serialized device type with computed fields
 */
export type SerializedDevice<T> = T & {
  status: DeviceStatus;
  isOnline: boolean;
  firmwareUpdateAvailable?: boolean;
  latestFirmwareVersion?: string | null;
};

export type NormalizedDeviceTelemetry = {
  batteryPercent: number | null;
  rssi: number | null;
  source: 'websocket' | 'legacy-pull' | null;
  updatedAt: string | null;
};

/**
 * Only websocket values have a persisted zero-value provenance. Legacy columns
 * used zero as a schema default, so an unqualified zero is deliberately unknown.
 */
export function normalizeDeviceTelemetry(device: { telemetry?: unknown; battery?: number | null; wifi?: number | null; lastSeenAt?: Date | null }): NormalizedDeviceTelemetry {
  const record = device.telemetry && typeof device.telemetry === 'object' ? device.telemetry as Record<string, unknown> : undefined;
  const websocket = record?.websocket && typeof record.websocket === 'object' ? record.websocket as Record<string, unknown> : undefined;
  const legacyPull = record?.legacyPull && typeof record.legacyPull === 'object' ? record.legacyPull as Record<string, unknown> : undefined;
  const updatedAt = typeof record?.updatedAt === 'string' ? record.updatedAt : null;
  const battery = typeof websocket?.batteryPercent === 'number' ? websocket.batteryPercent : typeof legacyPull?.batteryPercent === 'number' ? legacyPull.batteryPercent : device.battery && device.battery !== 0 ? device.battery : null;
  const rssi = typeof websocket?.rssi === 'number' ? websocket.rssi : typeof legacyPull?.rssi === 'number' ? legacyPull.rssi : device.wifi && device.wifi !== 0 ? device.wifi : null;
  const source = websocket ? 'websocket' : legacyPull || battery !== null || rssi !== null ? 'legacy-pull' : null;
  return { batteryPercent: battery, rssi, source, updatedAt: updatedAt ?? (source === 'legacy-pull' ? device.lastSeenAt?.toISOString() ?? null : null) };
}

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
  const source = device as T & {
    apiKey?: string;
    profile?: PersistedDeviceProfile;
    deliveryPolicy?: PersistedDeliveryPolicy;
    capabilitiesOverride?: unknown;
    credentials?: Array<Record<string, unknown>>;
    enrollments?: Array<Record<string, unknown>>;
  };
  const {
    profile,
    deliveryPolicy,
    capabilitiesOverride,
    credentials,
    enrollments,
    ...rest
  } = source;
  delete (rest as Record<string, unknown>).apiKey;
  const serialized: Record<string, unknown> = {
    ...rest,
    capabilitiesOverride: capabilitiesOverride ?? null,
    status: online ? 'online' : 'offline',
    isOnline: online,
    telemetryStatus: normalizeDeviceTelemetry(source),
  };
  if (profile && deliveryPolicy) {
    const resolved = resolveDeviceConfiguration(profile, deliveryPolicy, capabilitiesOverride);
    serialized.profile = resolved.profile;
    serialized.deliveryPolicy = resolved.deliveryPolicy;
    serialized.capabilities = resolved.capabilities;
    serialized.width = resolved.capabilities.display.width;
    serialized.height = resolved.capabilities.display.height;
  }
  if (credentials) {
    serialized.credentials = credentials.map((sourceCredential) => {
      const credential = { ...sourceCredential };
      delete credential.tokenHash;
      return credential;
    });
  }
  if (enrollments) {
    serialized.enrollments = enrollments.map((sourceEnrollment) => {
      const enrollment = { ...sourceEnrollment };
      delete enrollment.codeHash;
      return enrollment;
    });
  }
  return serialized as SerializedDevice<Omit<T, 'apiKey'>>;
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
