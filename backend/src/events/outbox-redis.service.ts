import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

export interface OutboxJob {
  version: 1;
  eventId: string;
  claimToken: string;
}
const CHANNEL = 'inker:delivery-hints:v1';

/** BullMQ carries fenced references only. SQLite owns retries and recovery. */
@Injectable()
export class OutboxRedisService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRedisService.name);
  private queue?: Queue<OutboxJob>;
  private worker?: Worker<OutboxJob>;
  private subscriber?: Redis;
  private publisher?: Redis;
  private hint?: () => void;
  private ready = false;

  start(dispatchJob: (job: OutboxJob) => Promise<void>, hint: () => void) {
    this.hint = hint;
    const connection = {
      host: '127.0.0.1',
      port: Number(process.env.OUTBOX_REDIS_PORT || 6379),
      // Match the existing s6 default, including an empty environment value.
      password: process.env.REDIS_PASSWORD || 'inker_redis',
      connectTimeout: 1000,
      enableOfflineQueue: false,
      retryStrategy: () => 1000,
    };
    this.publisher = new Redis({
      ...connection,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });
    this.publisher.on('error', () => {
      this.ready = false;
    });
    this.queue = new Queue<OutboxJob>('delivery', {
      prefix: 'inker-wp16',
      connection: this.publisher,
    });
    this.queue.on('error', () => {
      this.ready = false;
    });
    this.worker = new Worker<OutboxJob>(
      'delivery',
      async (job) => {
        // Never interpolate arbitrary Redis job data into diagnostics.
        const value: unknown = job.data;
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).sort().join(',') !== 'claimToken,eventId,version'
        )
          return;
        const data = value as OutboxJob;
        if (
          data.version !== 1 ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(data.eventId) ||
          !/^[a-f0-9-]{36}$/.test(data.claimToken)
        )
          return;
        try {
          await dispatchJob(data);
        } catch {
          throw new Error('OUTBOX_JOB_FAILED');
        }
      },
      {
        prefix: 'inker-wp16',
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 4,
        limiter: { max: 32, duration: 1000 },
        lockDuration: 30_000,
      },
    );
    this.worker.on('error', () => {
      this.ready = false;
    });
    this.subscriber = new Redis({
      ...connection,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });
    this.subscriber.on('error', () => {
      this.ready = false;
    });
    this.subscriber.on('ready', () => {
      void this.subscribe().catch(() => {
        this.ready = false;
      });
    });
  }

  private async subscribe() {
    const client = this.subscriber!;
    client.removeAllListeners('message');
    client.on('message', (channel: string, message: string) => {
      if (channel === CHANNEL && message === '{"version":1}') this.hint?.();
    });
    // ioredis automatically resubscribes after reconnect. Polling covers missed hints.
    await client.subscribe(CHANNEL);
    this.ready = true;
  }

  async enqueue(job: OutboxJob) {
    if (!this.queue || this.publisher?.status !== 'ready')
      throw new Error('OUTBOX_REDIS_UNAVAILABLE');
    await this.queue.add('dispatch-v1', job, {
      jobId: `${job.eventId}-${job.claimToken}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 100, age: 86400 },
    });
  }

  async publish() {
    if (this.publisher?.status !== 'ready')
      throw new Error('OUTBOX_REDIS_UNAVAILABLE');
    await this.publisher.publish(CHANNEL, '{"version":1}');
    this.ready = true;
  }
  metrics() {
    return { redisReady: this.ready };
  }

  async onModuleDestroy() {
    // Force-close BullMQ on shutdown: fenced DB leases recover interrupted jobs.
    this.subscriber?.disconnect();
    await Promise.allSettled([this.worker?.close(true), this.queue?.close()]);
    this.publisher?.disconnect();
    this.logger.debug('Outbox Redis connections closed');
  }
}
