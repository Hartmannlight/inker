import type { Prisma } from '@prisma/client';

export interface LegacyPullMetrics {
  battery?: number;
  wifi?: number;
}

function jsonObject(value: unknown): Record<string, Prisma.JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

export function mergeLegacyPullTelemetry(
  telemetry: Prisma.JsonValue | null,
  metrics: LegacyPullMetrics,
  updatedAt = new Date(),
): Prisma.InputJsonValue {
  const existing = jsonObject(telemetry);
  const previous = jsonObject(existing.legacyPull);
  return {
    ...existing,
    legacyPull: {
      ...previous,
      ...(metrics.battery !== undefined && Number.isFinite(metrics.battery)
        ? { batteryPercent: metrics.battery } : {}),
      ...(metrics.wifi !== undefined && Number.isFinite(metrics.wifi)
        ? { rssi: metrics.wifi } : {}),
    },
    updatedAt: updatedAt.toISOString(),
  } as Prisma.InputJsonValue;
}
