import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublicationCleanupService } from '../publications/publication-cleanup.service';
import { OutboxStore } from './outbox.store';
import { OutboxRedisService, OutboxJob } from './outbox-redis.service';
import { OUTBOX_POLICY as POLICY } from './outbox.types';
import { DeviceUpdateCoordinator } from '../device-platform/device-update-coordinator.service';
import { PlaybackService } from '../playback/playback.service';
import { PLAYBACK_DUE } from '../playback/playback.events';

@Injectable()
export class OutboxDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private cleanupAt = 0;
  private readonly counts = { claimed: 0, delivered: 0, failed: 0, stale: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: OutboxStore,
    private readonly redis: OutboxRedisService,
    private readonly consumer: DeviceUpdateCoordinator,
    private readonly cleanup: PublicationCleanupService,
    private readonly playback: PlaybackService,
  ) {}

  async onApplicationBootstrap() {
    await this.consumer.start();
    this.redis.start(
      (job) => this.dispatch(job),
      () => this.consumer.wake(),
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, POLICY.pollMs);
    this.timer.unref?.();
    void this.tick();
  }
  beforeApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    return this.consumer.stop();
  }
  metrics() {
    return { ...this.counts, ...this.redis.metrics() };
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let i = 0; i < POLICY.batchSize && !this.stopped; i++) {
        // Bound queue wait below the lease even when four jobs hit their timeout.
        if (
          (await this.prisma.outboxEvent.count({
            where: { status: 'processing', claimUntil: { gt: new Date() } },
          })) >= 8
        )
          break;
        const event = await this.store.claim(this.owner);
        if (!event) break;
        this.counts.claimed++;
        try {
          await this.redis.enqueue({
            version: 1,
            eventId: event.eventId,
            claimToken: event.claimToken!,
          });
        } catch {
          await this.store.fail(event, 'OUTBOX_TRANSPORT_FAILED');
          this.logFailure(event.eventId, 'OUTBOX_REDIS_UNAVAILABLE');
          break; // Do not hot-loop through the entire backlog during an outage.
        }
      }
      if (Date.now() >= this.cleanupAt) {
        this.cleanupAt = Date.now() + 3_600_000;
        await this.cleanup.cleanup();
      }
    } catch {
      this.logFailure(this.owner, 'OUTBOX_POLL_FAILED');
    } finally {
      this.running = false;
    }
  }

  async dispatch(job: OutboxJob) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { eventId: job.eventId },
    });
    if (
      !event ||
      event.claimToken !== job.claimToken ||
      !(await this.store.current(event))
    ) {
      this.counts.stale++;
      return;
    }
    try {
      if (event.eventType === PLAYBACK_DUE) {
        await this.playback.advanceDue(event);
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      const prepared = await this.store.prepare(event);
      if (!prepared.duplicate) {
        await this.redis.publish();
        this.consumer.wake();
        const deadline = Date.now() + POLICY.dispatchTimeoutMs;
        while (!(await this.store.targetsComplete(prepared.key))) {
          if (
            this.stopped ||
            Date.now() >= deadline ||
            (await this.store.targetFailed(prepared.key, event.claimToken!))
          )
            throw new Error('OUTBOX_DELIVERY_FAILED');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (await this.store.ack(event)) this.counts.delivered++;
      else this.counts.stale++;
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'OUTBOX_INVALID_PAYLOAD'
          ? 'OUTBOX_INVALID_PAYLOAD'
          : 'OUTBOX_TRANSPORT_FAILED';
      await this.store.fail(event, code);
      this.logFailure(event.eventId, code);
    }
  }
  private logFailure(correlationId: string, code: string) {
    this.counts.failed++;
    this.logger.warn({ code, correlationId });
  }
}
