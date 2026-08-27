import type { RedisOptions } from 'ioredis';

export const QUEUE_NAMES = Object.freeze([
  'source-refresh', 'render', 'delivery', 'timer', 'maintenance',
] as const);
export type QueueName = (typeof QUEUE_NAMES)[number];
export const JOB_VERSION = 1;
// Preserve existing BullMQ keys so rolling process restarts can recover work.
export const QUEUE_PREFIX = 'inker-wp16';

export const OUTBOX_POLICY = Object.freeze({
  maxAttempts: 5,
  leaseMs: 30_000,
  dispatchTimeoutMs: 8_000,
  pollMs: 500,
  batchSize: 16,
  consumerLeaseMs: 15_000,
} as const);

export interface QueuePolicy {
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly globalConcurrency: number;
  /** Durable database attempts; Redis must not multiply the retry budget. */
  readonly maxAttempts: number;
  readonly transportAttempts: 1;
  readonly backoff: Readonly<{
    type: 'exponential'; delay: number; maxDelay: number; jitter: number;
  }>;
  readonly retention: Readonly<{
    removeOnComplete: true;
    removeOnFail: Readonly<{ count: number; age: number }>;
  }>;
  readonly limiter: Readonly<{ max: number; duration: number }>;
}

const backoff = Object.freeze({
  type: 'exponential' as const, delay: 1_000, maxDelay: 60_000, jitter: 0.2,
});
const retention = Object.freeze({
  removeOnComplete: true as const,
  // BullMQ retention age is in seconds; these records are diagnostics only.
  removeOnFail: Object.freeze({ count: 100, age: 86_400 }),
});

function policy(
  timeoutMs: number,
  concurrency: number,
  globalConcurrency: number,
  ratePerSecond: number,
): QueuePolicy {
  return Object.freeze({
    timeoutMs, concurrency, globalConcurrency,
    maxAttempts: OUTBOX_POLICY.maxAttempts,
    transportAttempts: 1 as const,
    backoff, retention,
    limiter: Object.freeze({ max: ratePerSecond, duration: 1_000 }),
  });
}

/** Limits apply across worker processes as well as within each process. */
export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = Object.freeze({
  'source-refresh': policy(8_000, 2, 4, 8),
  render: policy(20_000, 1, 1, 4),
  delivery: policy(OUTBOX_POLICY.dispatchTimeoutMs, 4, 4, 32),
  timer: policy(8_000, 2, 2, 16),
  maintenance: policy(20_000, 1, 1, 2),
});

/** Database retry delay, with additive jitter (not BullMQ's subtractive jitter). */
export function queueRetryDelay(
  name: QueueName,
  attempt: number,
  random = Math.random,
): number {
  const config = QUEUE_POLICIES[name]?.backoff;
  if (!config || !Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('QUEUE_INVALID_RETRY');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('QUEUE_INVALID_RETRY');
  }
  return Math.min(config.maxDelay, config.delay * 2 ** Math.max(0, attempt - 1))
    * (1 + sample * config.jitter);
}

/** Existing outbox API and its five-attempt, 1s..60s + 20% jitter semantics. */
export function retryDelay(attempt: number, random = Math.random): number {
  return queueRetryDelay('delivery', attempt, random);
}

/** Callers add maxRetriesPerRequest=null for workers and bounded retries for API. */
export function redisConnection(env: Readonly<Record<string, string | undefined>> = process.env): RedisOptions {
  const port = Number(env.OUTBOX_REDIS_PORT || 6379);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('QUEUE_INVALID_REDIS_PORT');
  }
  return {
    host: '127.0.0.1',
    port,
    // Match the s6 default, including an explicitly empty environment value.
    password: env.REDIS_PASSWORD || 'inker_redis',
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    retryStrategy: () => 1_000,
  };
}

/** The claim fence changes on recovery; the persistent event remains the identity. */
export function jobId(eventId: string, claimToken: string): string {
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(eventId)
    || typeof claimToken !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claimToken)) {
    // Never echo Redis payloads, URLs or credentials into diagnostics.
    throw new Error('JOB_INVALID_ID');
  }
  return `${eventId}-${claimToken}`;
}
