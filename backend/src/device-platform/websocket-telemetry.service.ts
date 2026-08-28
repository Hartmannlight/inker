import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DEVICE_WEBSOCKET_LIMITS as LIMITS, parseDeviceClientMessage, type DeviceTelemetry } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';

type ObservedDevice = { id: number; lastSeenAt: Date | null; telemetry: unknown };
interface BufferedTelemetry {
  interval: number;
  nextWrite: number;
  seenAt: number;
  connectedAt?: number;
  sample?: DeviceTelemetry;
  persisted?: string;
  pending?: Promise<void>;
  released: boolean;
  attempted: boolean;
}

@Injectable()
export class WebSocketTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebSocketTelemetryService.name);
  private readonly devices = new Map<number, BufferedTelemetry>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private writes = 0;
  private failures = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() { this.timer = setInterval(() => this.flush(), 1000); this.timer.unref?.(); }

  observe(device: ObservedDevice, intervalSeconds: number, sample?: DeviceTelemetry, connected = false): void {
    if (this.closing) return;
    const now = Date.now();
    const interval = Math.max(LIMITS.minTelemetryIntervalSeconds, intervalSeconds) * 1000;
    let entry = this.devices.get(device.id);
    if (!entry) {
      if (this.devices.size >= LIMITS.maxConnections) return;
      const stored = device.telemetry && typeof device.telemetry === 'object' && 'websocket' in device.telemetry
        ? device.telemetry.websocket : undefined;
      const parsed = parseDeviceClientMessage({ protocolVersion: '1.0', type: 'telemetry', payload: stored });
      const previous = parsed.success && parsed.data.type === 'telemetry' ? parsed.data.payload : undefined;
      entry = { interval, nextWrite: (device.lastSeenAt?.getTime() ?? 0) + interval, seenAt: now,
        persisted: previous ? JSON.stringify(previous) : undefined, sample: previous, released: false, attempted: false };
      this.devices.set(device.id, entry);
    }
    // A longer changed policy must not shorten an already scheduled write boundary.
    entry.nextWrite += Math.max(0, interval - entry.interval);
    entry.interval = interval;
    entry.seenAt = now;
    entry.released = false;
    if (connected) {
      entry.connectedAt = now;
      // A new connection gets one attempt at the existing write boundary even
      // if it closes first. It never resets the cooldown or an in-flight write.
      entry.attempted = false;
    }
    if (sample) entry.sample = { ...entry.sample, ...sample };
  }

  release(deviceId: number) {
    const entry = this.devices.get(deviceId);
    if (entry) entry.released = true;
  }

  flush(): void {
    if (this.closing) return;
    const now = Date.now();
    for (const [id, entry] of this.devices) {
      if (entry.pending || now < entry.nextWrite) continue;
      // Keep a bounded cooldown after close, including failed writes. Reconnect
      // must not turn repeated failures into an immediate retry loop.
      if (entry.released && entry.attempted) { this.devices.delete(id); continue; }
      const cutoff = new Date(now - entry.interval);
      const serialized = entry.sample ? JSON.stringify(entry.sample) : undefined;
      const sample = serialized !== entry.persisted ? entry.sample : undefined;
      const connectedAt = entry.connectedAt;
      const seenAt = entry.seenAt;
      entry.nextWrite = now + entry.interval; // Failed attempts are throttled too.
      entry.attempted = true;
      entry.pending = Promise.resolve().then(async () => {
        const result = await this.prisma.device.updateMany({
          where: { id, isActive: true, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: cutoff } }] },
          // lastSeenAt is a sampled presence timestamp, not an exact disconnect
          // time. Persist the flush boundary so reconnect/restart cannot shorten
          // the write interval; precise liveness belongs to the gateway.
          data: { lastSeenAt: new Date(now), ...(connectedAt !== undefined ? { lastConnectedAt: new Date(connectedAt) } : {}),
            ...(sample ? { telemetry: { websocket: { ...sample }, updatedAt: new Date(seenAt).toISOString() } } : {}) },
        });
        if (result.count) {
          this.writes += result.count;
          if (sample) entry.persisted = serialized;
          // Reconnect may have buffered a newer time while this write awaited I/O.
          if (entry.connectedAt === connectedAt) entry.connectedAt = undefined;
        }
      }).catch(() => {
        this.failures++;
        this.logger.warn('Device telemetry write failed');
      }).finally(() => {
        entry.pending = undefined;
      });
    }
  }

  metrics() { return { bufferedDevices: this.devices.size, writes: this.writes, failures: this.failures }; }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    // No final forced write: reconnect/shutdown must not bypass the write interval.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.devices.values()].map(v => v.pending)),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, LIMITS.operationTimeoutMs); })]);
    if (timeout) clearTimeout(timeout);
    this.devices.clear();
  }
}
