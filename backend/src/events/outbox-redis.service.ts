import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type RedisClient } from 'bullmq';
import Redis from 'ioredis';
import { JOB_VERSION, QUEUE_NAMES, QUEUE_POLICIES, QUEUE_PREFIX, jobId, redisConnection, type QueueName } from '../jobs/queue-policy';

export interface OutboxJob { version: 1; eventId: string; claimToken: string; }
const CHANNEL = 'inker:delivery-hints:v1';
const PRESENCE = 'inker:workers:v1';
export const WORKER_PRESENCE_MS = 8_000;

/** Only reconstructed references/presence live in Redis; SQLite owns job intent. */
@Injectable()
export class OutboxRedisService implements OnModuleDestroy {
  private publisher?: Redis;
  private subscriber?: Redis;
  private readonly queues = new Map<QueueName, Queue<OutboxJob>>();
  private readonly workers = new Map<QueueName, Worker<OutboxJob>>();
  private readonly workerConnections = new Map<QueueName, { command: RedisClient; blocking: RedisClient }>();
  private readonly aborts = new Set<AbortController>();
  private closeTask?: Promise<void>;
  private stopping = false;
  private lastHeartbeat = 0;

  private connect() {
    if (this.publisher) return this.publisher;
    this.publisher = new Redis({ ...redisConnection(), maxRetriesPerRequest: 1, commandTimeout: 1000 });
    this.publisher.on('error', () => undefined);
    return this.publisher;
  }
  private queue(name: QueueName) {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue<OutboxJob>(name, { prefix: QUEUE_PREFIX, connection: this.connect() });
      queue.on('error', () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }
  startHints(hint: () => void) {
    this.connect();
    if (this.subscriber) return;
    this.subscriber = new Redis({ ...redisConnection(), maxRetriesPerRequest: 1, commandTimeout: 1000 });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (channel, message) => {
      if (channel === CHANNEL && message === '{"version":1}') hint();
    });
    this.subscriber.on('ready', () => { void this.subscriber!.subscribe(CHANNEL).catch(() => undefined); });
  }
  startWorkers(dispatch: (job: OutboxJob, signal: AbortSignal, queue: QueueName) => Promise<void>) {
    this.connect();
    for (const name of QUEUE_NAMES) {
      if (this.workers.has(name)) continue;
      const policy = QUEUE_POLICIES[name];
      const queue = this.queue(name);
      const worker = new Worker<OutboxJob>(name, async job => {
        const data: unknown = job.data;
        if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'claimToken,eventId,version') return;
        const value = data as OutboxJob;
        try { if (value.version !== JOB_VERSION) return; jobId(value.eventId, value.claimToken); }
        catch { return; }
        if (this.stopping) return;
        const abort = new AbortController();
        this.aborts.add(abort);
        const timer = setTimeout(() => abort.abort(), policy.timeoutMs);
        try { await dispatch(value, abort.signal, name); }
        catch { throw new Error('OUTBOX_JOB_FAILED'); }
        finally { clearTimeout(timer); this.aborts.delete(abort); }
      }, { prefix: QUEUE_PREFIX, connection: { ...redisConnection(), maxRetriesPerRequest: null },
        concurrency: policy.concurrency, limiter: policy.limiter, lockDuration: 30_000 });
      worker.on('error', () => undefined);
      this.workers.set(name, worker);
      // isRunning is set before BullMQ connects. Retain both actual clients so
      // initial connection failures and later reconnects cannot advertise ready.
      void Promise.all([worker.client, worker.waitUntilReady()]).then(([command, blocking]) => {
        this.workerConnections.set(name, { command, blocking });
      }).catch(() => undefined);
      void queue.setGlobalConcurrency(policy.globalConcurrency).catch(() => undefined);
    }
  }
  async enqueue(job: OutboxJob, name: QueueName = 'delivery') {
    if (this.stopping || this.publisher?.status !== 'ready') throw new Error('OUTBOX_REDIS_UNAVAILABLE');
    const queue = this.queue(name), policy = QUEUE_POLICIES[name];
    await queue.setGlobalConcurrency(policy.globalConcurrency);
    await queue.add('dispatch-v1', job, { jobId: jobId(job.eventId, job.claimToken), attempts: policy.transportAttempts, ...policy.retention });
  }
  async publish() {
    if (this.publisher?.status !== 'ready') throw new Error('OUTBOX_REDIS_UNAVAILABLE');
    await this.publisher.publish(CHANNEL, '{"version":1}');
  }
  metrics() { return { redisReady: this.publisher?.status === 'ready' }; }
  async heartbeat(owner: string) {
    if (!this.connectionsReady()) { this.lastHeartbeat = 0; await this.leave(owner); return; }
    const client = this.connect(), now = Date.now();
    const result = await client.multi().zremrangebyscore(PRESENCE, '-inf', now - WORKER_PRESENCE_MS)
      .zadd(PRESENCE, now, owner).expire(PRESENCE, 30).exec();
    if (!result || result.some(([error]) => error)) throw new Error('QUEUE_UNAVAILABLE');
    this.lastHeartbeat = now;
  }
  workerReady() {
    return this.connectionsReady() && Date.now() - this.lastHeartbeat < WORKER_PRESENCE_MS;
  }
  private connectionsReady() {
    return !this.stopping && this.publisher?.status === 'ready' && this.workers.size === QUEUE_NAMES.length
      && QUEUE_NAMES.every(name => {
        const worker = this.workers.get(name), connection = this.workerConnections.get(name);
        return worker?.isRunning() && !worker.isPaused() && connection?.command.status === 'ready'
          && connection.blocking.status === 'ready';
      });
  }
  async leave(owner: string) { try { await this.publisher?.zrem(PRESENCE, owner); } catch { /* TTL fences lost presence. */ } }
  async backgroundStatus() {
    try {
      const workers = await this.connect().zcount(PRESENCE, Date.now() - WORKER_PRESENCE_MS, '+inf');
      return { status: workers ? 'ready' : 'degraded', redis: 'ready', workers, code: workers ? undefined : 'WORKER_UNAVAILABLE' };
    } catch { return { status: 'degraded', redis: 'unavailable', workers: 0, code: 'QUEUE_UNAVAILABLE' }; }
  }
  async pauseWorkers() { await Promise.all([...this.workers.values()].map(worker => worker.pause(true))); }
  async drain(timeoutMs = 22_000) {
    this.stopping = true;
    // Never delete queue contents: unfinished claims recover from SQLite.
    await Promise.allSettled([...this.workers.values()].map(worker => worker.pause(true)));
    const deadline = Date.now() + timeoutMs;
    while (this.aborts.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    for (const abort of this.aborts) abort.abort();
  }
  close() {
    return this.closeTask ??= (async () => {
      this.stopping = true;
      this.subscriber?.disconnect();
      for (const abort of this.aborts) abort.abort();
      await Promise.allSettled([...this.workers.values()].map(worker => worker.close(true)));
      await Promise.allSettled([...this.queues.values()].map(queue => queue.close()));
      this.publisher?.disconnect();
    })();
  }
  onModuleDestroy() { return this.close(); }
}
