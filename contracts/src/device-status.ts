export const DEVICE_STATUSES = ['online', 'offline'] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export function isDeviceStatus(value: unknown): value is DeviceStatus {
  return typeof value === 'string' && DEVICE_STATUSES.some((status) => status === value);
}
