import { describe, expect, test } from 'bun:test';
import {
  jobId, OUTBOX_POLICY, QUEUE_NAMES, QUEUE_POLICIES, queueRetryDelay,
  redisConnection, retryDelay, type QueueName,
} from './queue-policy';

const claim = '70bab4d5-5c73-4451-babb-614778a49843';
const nextClaim = '70bab4d5-5c73-4451-babb-614778a49844';

describe('queue identity and durable retry policy', () => {
  test('reuses a claimed job identity but fences a later claim for the same event', () => {
    const id = jobId('event-1', claim);
    expect(id).toBe(`event-1-${claim}`);
    expect(jobId('event-1', claim)).toBe(id);
    expect(jobId('event-1', nextClaim)).not.toBe(id);
    expect(jobId('event-2', claim)).not.toBe(id);
    expect(jobId('a'.repeat(100), claim)).not.toContain(':');
  });

  test('rejects malformed, oversized and non-string identities without leaking input', () => {
    const invalid: [unknown, unknown][] = [
      ['', claim], ['a'.repeat(101), claim], ['event:secret', claim],
      ['https://secret@example.com', claim], ['event\n', claim], [null, claim],
      ['event', claim.toUpperCase()], ['event', 'f'.repeat(36)],
      ['event', '-'.repeat(36)], ['event', `${claim}\n`], ['event', null],
      [{ toString: () => 'secret' }, claim],
    ];
    for (const [eventId, claimToken] of invalid) {
      expect(() => jobId(eventId as string, claimToken as string)).toThrow('JOB_INVALID_ID');
      try { jobId(eventId as string, claimToken as string); }
      catch (error) { expect(String(error)).not.toContain('secret'); }
    }
  });

  test('preserves outbox backoff including additive jitter and saturation', () => {
    expect([0, 1, 2, 3, 4, 5].map(n => retryDelay(n, () => 0)))
      .toEqual([1_000, 1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(retryDelay(3, () => 0.5)).toBe(4_400);
    expect(retryDelay(100, () => 1)).toBe(72_000);
    expect(retryDelay(Number.MAX_SAFE_INTEGER, () => 0)).toBe(60_000);
  });

  test('every group has finite retries that fit inside its durable lease', () => {
    for (const name of QUEUE_NAMES) {
      const p = QUEUE_POLICIES[name];
      expect(p.timeoutMs).toBeGreaterThan(0);
      expect(p.timeoutMs).toBeLessThan(OUTBOX_POLICY.leaseMs);
      expect(p.concurrency).toBeGreaterThan(0);
      expect(p.globalConcurrency).toBeGreaterThanOrEqual(p.concurrency);
      // Redis queue loss cannot introduce a second five-attempt retry layer.
      expect(p.transportAttempts * p.maxAttempts).toBe(OUTBOX_POLICY.maxAttempts);
      for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
        const earliest = queueRetryDelay(name, attempt, () => 0);
        const latest = queueRetryDelay(name, attempt, () => 1);
        expect(latest).toBeGreaterThan(earliest);
        expect(latest).toBeLessThanOrEqual(p.backoff.maxDelay * (1 + p.backoff.jitter));
      }
    }
  });

  test('rejects invalid retry inputs instead of scheduling NaN, negative or infinite delays', () => {
    for (const attempt of [-1, NaN, Infinity, 1.5]) {
      expect(() => retryDelay(attempt)).toThrow('QUEUE_INVALID_RETRY');
    }
    for (const sample of [-0.1, NaN, Infinity, 1.01]) {
      expect(() => retryDelay(1, () => sample)).toThrow('QUEUE_INVALID_RETRY');
    }
    expect(() => queueRetryDelay('secret' as QueueName, 1)).toThrow('QUEUE_INVALID_RETRY');
  });

  test('keeps shared policy immutable so one consumer cannot alter another queue', () => {
    expect(Reflect.set(QUEUE_POLICIES.delivery.backoff, 'jitter', 9)).toBe(false);
    expect(Reflect.set(QUEUE_POLICIES.render.limiter, 'max', 999)).toBe(false);
    expect(Reflect.set(QUEUE_POLICIES.maintenance.retention.removeOnFail, 'count', 999)).toBe(false);
    expect(Reflect.set(OUTBOX_POLICY, 'leaseMs', 1)).toBe(false);
  });
});

describe('shared Redis connection configuration', () => {
  test('matches local s6 defaults when variables are absent or explicitly empty', () => {
    for (const env of [{}, { OUTBOX_REDIS_PORT: '', REDIS_PASSWORD: '' }]) {
      const connection = redisConnection(env);
      expect(connection.host).toBe('127.0.0.1');
      expect(connection.port).toBe(6379);
      expect(connection.password).toBe('inker_redis');
      expect(connection.enableOfflineQueue).toBe(false);
      expect(connection.retryStrategy?.(100)).toBe(1_000);
    }
  });

  test('preserves isolated service settings without mutating inputs or sharing options', () => {
    const env = Object.freeze({ OUTBOX_REDIS_PORT: '16379', REDIS_PASSWORD: 'test-only-password' });
    const first = redisConnection(env);
    const second = redisConnection(env);
    expect(first).not.toBe(second);
    expect(first.port).toBe(16379);
    expect(first.password).toBe('test-only-password');
    first.host = 'modified';
    expect(second.host).toBe('127.0.0.1');
    expect(first.maxRetriesPerRequest).toBeUndefined();
  });

  test('fails closed on invalid ports with a fixed non-secret diagnostic', () => {
    for (const port of ['0', '-1', '65536', '1.5', 'NaN', 'Infinity', 'secret:password']) {
      expect(() => redisConnection({ OUTBOX_REDIS_PORT: port, REDIS_PASSWORD: 'secret' }))
        .toThrow('QUEUE_INVALID_REDIS_PORT');
      try { redisConnection({ OUTBOX_REDIS_PORT: port, REDIS_PASSWORD: 'secret' }); }
      catch (error) { expect(String(error)).not.toContain('secret'); }
    }
    expect(redisConnection({ OUTBOX_REDIS_PORT: '1' }).port).toBe(1);
    expect(redisConnection({ OUTBOX_REDIS_PORT: '65535' }).port).toBe(65535);
  });
});
