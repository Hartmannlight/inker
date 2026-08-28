import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxStore } from './outbox.store';
import { OutboxRedisService, OutboxJob } from './outbox-redis.service';
import { OUTBOX_POLICY as POLICY } from './outbox.types';
import { PlaybackService } from '../playback/playback.service';
import { PLAYBACK_DUE } from '../playback/playback.events';
import { RenderCacheService, RENDER_REQUESTED } from '../render-cache/render-cache.service';
import { MaintenanceService, MAINTENANCE_DUE } from '../jobs/maintenance.service';
import { QUEUE_POLICIES, type QueueName } from '../jobs/queue-policy';
import type { Prisma } from '@prisma/client';
import { SourceWorkerService } from '../sources/source-worker.service';
import { SOURCE_REFRESH } from '../sources/source-job';
import { TimerWorkerService } from '../timers/timer-worker.service';
import { TIMER_DUE } from '../timers/timer-scheduling';

@Injectable()
export class OutboxDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private heartbeatAt = 0;
  private maintenanceAt = 0;
  private reconcileAt = 0;
  private timerReconcileAt = 0;
  private stopTask?: Promise<void>;
  private readonly counts = { claimed: 0, delivered: 0, failed: 0, stale: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: OutboxStore,
    private readonly redis: OutboxRedisService,
    private readonly maintenance: MaintenanceService,
    private readonly playback: PlaybackService,
    private readonly renderCache: RenderCacheService,
    private readonly sources: SourceWorkerService,
    private readonly timers: TimerWorkerService,
  ) {}

  async onApplicationBootstrap() {
    await this.timers.reconcile(true);
    this.redis.startWorkers((job, signal, queue) => this.dispatch(job, signal, queue));
    this.timer = setInterval(() => {
      void this.tick();
    }, POLICY.pollMs);
    this.timer.unref?.();
    void this.tick();
  }
  stop() {
    return this.stopTask ??= this.stopOnce();
  }
  private async stopOnce() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + 22_000;
    await this.redis.leave(this.owner);
    while (this.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    await this.redis.drain(Math.max(0, deadline - Date.now()));
  }
  onModuleDestroy() { return this.stop(); }
  metrics() {
    return { ...this.counts, ...this.redis.metrics() };
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (Date.now() >= this.heartbeatAt) {
        this.heartbeatAt = Date.now() + 2000;
        await this.redis.heartbeat(this.owner).catch(() => undefined);
      }
      if (Date.now() >= this.maintenanceAt) {
        await this.maintenance.schedule();
        this.maintenanceAt = Date.now() + 60_000;
      }
      if (Date.now() >= this.reconcileAt) {
        this.reconcileAt = Date.now() + POLICY.pollMs;
        await this.renderCache.reconcile();
        await this.sources.schedule();
      }
      if (Date.now() >= this.timerReconcileAt) {
        await this.timers.reconcile();
        this.timerReconcileAt = Date.now() + 5000;
      }
      for (const name of ['delivery', 'render', 'timer', 'maintenance', 'source-refresh'] as const) {
        for (let i = 0; i < QUEUE_POLICIES[name].globalConcurrency && !this.stopped; i++) {
        const filter = this.queueFilter(name);
        const event = name === 'source-refresh' ? await this.sources.claim(this.owner)
          : await this.store.claim(this.owner, new Date(), filter,
            { where: filter, limit: QUEUE_POLICIES[name].globalConcurrency });
        if (!event) break;
        this.counts.claimed++;
        try {
          await this.redis.enqueue({
            version: 1,
            eventId: event.eventId,
            claimToken: event.claimToken!,
          }, name);
        } catch {
          await this.store.fail(event, 'OUTBOX_TRANSPORT_FAILED');
          this.logFailure(event.eventId, 'OUTBOX_REDIS_UNAVAILABLE');
          break; // Do not hot-loop through the entire backlog during an outage.
        }
        }
      }
    } catch {
      this.logFailure(this.owner, 'OUTBOX_POLL_FAILED');
    } finally {
      this.running = false;
    }
  }

  private queueFilter(name: QueueName): Prisma.OutboxEventWhereInput {
    const special = [RENDER_REQUESTED, PLAYBACK_DUE, TIMER_DUE, MAINTENANCE_DUE, SOURCE_REFRESH];
    if (name === 'source-refresh') return { eventType: SOURCE_REFRESH };
    if (name === 'render') return { eventType: RENDER_REQUESTED };
    if (name === 'timer') return { eventType: { in: [PLAYBACK_DUE, TIMER_DUE] } };
    if (name === 'maintenance') return { eventType: MAINTENANCE_DUE };
    return { eventType: { notIn: special } };
  }

  async dispatch(job: OutboxJob, signal = new AbortController().signal, queue?: QueueName) {
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
    const expectedQueue = event.eventType === SOURCE_REFRESH ? 'source-refresh' : event.eventType === RENDER_REQUESTED ? 'render'
      : [PLAYBACK_DUE, TIMER_DUE].includes(event.eventType) ? 'timer' : event.eventType === MAINTENANCE_DUE ? 'maintenance' : 'delivery';
    if (queue && queue !== expectedQueue) { this.counts.stale++; return; }
    try {
      signal.throwIfAborted();
      if (event.eventType === TIMER_DUE) {
        await this.timers.completeDue(event, signal);
        signal.throwIfAborted();
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      if (event.eventType === SOURCE_REFRESH) {
        const outcome = await this.sources.execute(event, signal);
        if (outcome === 'failed') { this.counts.failed++; return; }
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      if (event.eventType === RENDER_REQUESTED) {
        await this.renderCache.render(event, undefined, signal);
        signal.throwIfAborted();
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      if (event.eventType === MAINTENANCE_DUE) {
        await this.maintenance.execute(event, signal);
        signal.throwIfAborted();
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      if (event.eventType === PLAYBACK_DUE) {
        await this.playback.advanceDue(event, signal);
        signal.throwIfAborted();
        if (await this.store.ack(event)) this.counts.delivered++;
        else this.counts.stale++;
        return;
      }
      const prepared = await this.store.prepare(event);
      if (!prepared.duplicate) {
        await this.redis.publish();
        const deadline = Date.now() + POLICY.dispatchTimeoutMs;
        while (!(await this.store.targetsComplete(prepared.key))) {
          if (
            signal.aborted ||
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
      if (event.eventType === TIMER_DUE && error instanceof Error && error.message === 'TIMER_NOT_DUE') {
        if (!await this.timers.deferEarly(event)) this.counts.stale++;
        return;
      }
      const code =
        error instanceof Error && error.message === 'OUTBOX_INVALID_PAYLOAD'
          ? 'OUTBOX_INVALID_PAYLOAD'
          : 'OUTBOX_TRANSPORT_FAILED';
      await this.store.fail(event, code);
      this.logFailure(event.eventId, code);
    } finally {
      // Refill freed slots promptly instead of imposing one polling interval
      // on every batch. Periodic reconciliation remains independently bounded.
      if (!this.stopped) void this.tick();
    }
  }
  private logFailure(correlationId: string, code: string) {
    this.counts.failed++;
    this.logger.warn({ code, correlationId });
  }
}
