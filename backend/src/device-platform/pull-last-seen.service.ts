import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Reconstructible telemetry only: DB timestamps survive restarts; in-flight work does not. */
@Injectable()
export class PullLastSeenService implements OnModuleDestroy {
  private readonly logger = new Logger(PullLastSeenService.name);
  private readonly pending = new Map<number, Promise<void>>();
  private closing = false;

  constructor(private readonly prisma: PrismaService) {}

  observe(device: { id: number; lastSeenAt: Date | null }, intervalSeconds: number): void {
    const now = new Date();
    const cutoff = new Date(now.getTime() - Math.max(60, intervalSeconds) * 1000);
    if (this.closing || this.pending.has(device.id) || (device.lastSeenAt && device.lastSeenAt > cutoff)) return;
    // Bound concurrent telemetry work, not authentication or content delivery.
    if (this.pending.size >= 1024) return;
    const write = Promise.resolve().then(async () => {
      await this.prisma.device.updateMany({
        where: { id: device.id, isActive: true, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: cutoff } }] },
        data: { lastSeenAt: now },
      });
    }).catch(() => {
      // Database errors can include query values. Never log the original error here.
      this.logger.warn('Pull last-seen update failed');
    }).finally(() => { this.pending.delete(device.id); });
    this.pending.set(device.id, write);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await Promise.all(this.pending.values());
  }
}
