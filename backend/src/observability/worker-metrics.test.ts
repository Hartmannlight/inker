import { describe, expect, test } from 'bun:test';
import { MetricsRegistry } from './metrics-registry';
import { combineWorkerMetrics, parseWorkerMetricSample, workerMetricSample, workerSampleFresh,
  WorkerMetricsAccumulator, WORKER_METRIC_LIMITS, type WorkerMetricReading } from './worker-metrics';

describe('bounded cross-process worker metrics', () => {
  const now = 1_800_000_000_000;
  function sample() {
    const registry = new MetricsRegistry();
    registry.recordJob('source-refresh', 'failure', 1500);
    registry.recordRender('failed');
    return { registry, text: workerMetricSample(registry.snapshot(), now) };
  }
  test('accepts current fixed samples and rejects expired/future/malformed or secret-bearing data', () => {
    const { text } = sample();
    expect(parseWorkerMetricSample(text, now)?.jobs[0].sum).toBe(1.5);
    expect(parseWorkerMetricSample(text, now + WORKER_METRIC_LIMITS.ttlMs - 1)).not.toBeNull();
    expect(parseWorkerMetricSample(text, now + WORKER_METRIC_LIMITS.ttlMs)).toBeNull();
    expect(parseWorkerMetricSample(text, now + WORKER_METRIC_LIMITS.ttlMs + 1)).toBeNull();
    expect(parseWorkerMetricSample(text, now - 2001)).toBeNull();
    for (const patch of [{ version: 2 }, { sampledAt: NaN }, { token: 'synthetic-metric-secret' }, { jobs: [{}] },
      { render: { failed: 1 } }, { jobs: Array(31).fill({}) }]) {
      expect(parseWorkerMetricSample(JSON.stringify({ ...JSON.parse(text), ...patch }), now)).toBeNull();
    }
    expect(parseWorkerMetricSample('x'.repeat(WORKER_METRIC_LIMITS.bytes + 1), now)).toBeNull();
    expect(parseWorkerMetricSample('{broken', now)).toBeNull();
  });
  test('rejects duplicate labels and inconsistent/negative histogram buckets', () => {
    const value = JSON.parse(sample().text);
    for (const change of [(row: any) => { row.queue = 'source:secret'; }, (row: any) => { row.outcome = 'secret'; },
      (row: any) => { row.count = -1; }, (row: any) => { row.buckets[0] = 3; },
      (row: any) => { row.buckets[0] = 1; row.buckets[1] = 0; }, (row: any) => { row.buckets.pop(); }]) {
      const modified = structuredClone(value); change(modified.jobs[0]);
      expect(parseWorkerMetricSample(JSON.stringify(modified), now)).toBeNull();
    }
    value.jobs.push(value.jobs[0]);
    expect(parseWorkerMetricSample(JSON.stringify(value), now)).toBeNull();
  });
  test('aggregates jobs/render across workers without arbitrary labels or mutating inputs', () => {
    const { registry, text } = sample(), worker = parseWorkerMetricSample(text, now)!;
    const api = new MetricsRegistry(); api.recordRequest('pairing', 200, 10); api.recordRender('hit');
    const before = api.snapshot(), merged = combineWorkerMetrics(before, [worker, worker]);
    expect(merged.jobs[0]).toMatchObject({ queue: 'source-refresh', outcome: 'failure', count: 2, sum: 3 });
    expect(merged.render).toEqual({ hit: 1, miss: 0, fallback: 0, rendered: 0, failed: 2 });
    expect(api.toPrometheus(merged)).toContain('statuspanel_job_duration_seconds_sum{queue="source-refresh",outcome="failure"} 3');
    expect(api.snapshot()).toEqual(before);
    expect(registry.snapshot().jobs[0].count).toBe(1);
    merged.jobs[0].buckets.fill(9);
    expect(worker.jobs[0].buckets.at(-1)).toBe(1);
    expect(() => combineWorkerMetrics(before, Array(17).fill(worker))).toThrow('OBSERVABILITY_WORKER_LIMIT');
  });

  function reading(owner: string, count: number, at = now): WorkerMetricReading {
    const registry = new MetricsRegistry();
    for (let index = 0; index < count; index++) {
      registry.recordRender('hit'); registry.recordJob('render', 'success', 10);
    }
    return { owner, sample: parseWorkerMetricSample(workerMetricSample(registry.snapshot(), at), at)! };
  }
  test('freshness expires at the exact TTL and rejects invalid or overly future timestamps', () => {
    for (const sampledAt of [-1, NaN, Infinity, now + 2001]) expect(workerSampleFresh({ sampledAt }, now)).toBe(false);
    expect(workerSampleFresh({ sampledAt: now + 2000 }, now)).toBe(true);
    expect(workerSampleFresh({ sampledAt: now }, now + 8000)).toBe(false);
    expect(workerSampleFresh({ sampledAt: now }, NaN)).toBe(false);
  });
  test('observes deltas without a counter drop or double count during a partial worker restart', () => {
    const accumulator = new WorkerMetricsAccumulator();
    accumulator.observe([reading('a-incarnation-1', 100), reading('b-incarnation-1', 100)], now);
    expect(accumulator.snapshot(now).render.hit).toBe(0);
    expect(accumulator.snapshot(now).jobs[0].count).toBe(0);
    accumulator.observe([reading('a-incarnation-1', 101, now + 1), reading('b-incarnation-1', 101, now + 1)], now + 1);
    expect(accumulator.snapshot(now + 1).render.hit).toBe(2);
    accumulator.observe([reading('a-incarnation-2', 0, now + 2), reading('b-incarnation-1', 102, now + 2)], now + 2);
    expect(accumulator.snapshot(now + 2).render.hit).toBe(3);
    accumulator.observe([reading('a-incarnation-2', 1, now + 3), reading('b-incarnation-1', 103, now + 3)], now + 3);
    const total = accumulator.snapshot(now + 3);
    expect(total.render.hit).toBe(5);
    expect(total.jobs[0].count).toBe(5);
    expect(total.jobs[0].sum).toBeCloseTo(0.05, 12);
    expect(total.jobs[0].buckets).toEqual([0, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const registry = new MetricsRegistry(), text = registry.toPrometheus(combineWorkerMetrics(registry.snapshot(), [total]));
    expect(text).toContain('statuspanel_job_duration_seconds_count{queue="render",outcome="success"} 5');
    expect(text).not.toContain('incarnation');
  });
  test('ignores duplicates, older samples and counter regressions without advancing the baseline', () => {
    const accumulator = new WorkerMetricsAccumulator();
    accumulator.observe([reading('a', 10)], now);
    accumulator.observe([reading('a', 11, now + 2)], now + 2);
    accumulator.observe([reading('a', 11, now + 2)], now + 2);
    accumulator.observe([reading('a', 10, now + 1)], now + 3);
    accumulator.observe([reading('a', 1, now + 4)], now + 4);
    expect(accumulator.snapshot(now + 4).render.hit).toBe(1);
    accumulator.observe([reading('a', 12, now + 5)], now + 5);
    expect(accumulator.snapshot(now + 5).render.hit).toBe(2);
    expect(accumulator.snapshot(now + 5).jobs[0].count).toBe(2);
  });
  test('retains baselines during unknown samples but rebaselines a departed or evicted returning owner', () => {
    const accumulator = new WorkerMetricsAccumulator();
    accumulator.observe([reading('returning', 10)], now);
    accumulator.observe(null, now + 1);
    accumulator.observe([reading('returning', 12, now + 2)], now + 2);
    expect(accumulator.snapshot(now + 2).render.hit).toBe(2);
    accumulator.observe([], now + 3);
    expect(accumulator.snapshot(now + 3).render.hit).toBe(2);
    for (let batch = 0; batch < 20; batch++) {
      const time = now + 4 + batch;
      accumulator.observe(Array.from({ length: 16 }, (_, index) => reading(`churn-${batch}-${index}`, 1, time)), time);
      expect((accumulator as unknown as { baselines: Map<string, unknown> }).baselines.size).toBe(16);
    }
    accumulator.observe([reading('returning', 20, now + 30)], now + 30);
    expect(accumulator.snapshot(now + 30).render.hit).toBe(2);
    accumulator.observe([reading('returning', 21, now + 31)], now + 31);
    expect(accumulator.snapshot(now + 31).render.hit).toBe(3);
    expect(accumulator.snapshot(now + 31).jobs).toHaveLength(1);
  });
  test('validates complete reading sets atomically and detaches caller and returned objects', () => {
    const accumulator = new WorkerMetricsAccumulator(), initial = reading('a', 1);
    accumulator.observe([initial], now);
    initial.sample.render.hit = 500;
    initial.sample.jobs[0].buckets.fill(999);
    const next = reading('a', 2, now + 1);
    expect(() => accumulator.observe([next, next], now + 1)).toThrow('OBSERVABILITY_INVALID_WORKER_READING');
    expect(() => accumulator.observe([{ ...next, owner: 'invalid:owner' }], now + 1)).toThrow('OBSERVABILITY_INVALID_WORKER_READING');
    expect(() => accumulator.observe([next], now + 8001)).toThrow('OBSERVABILITY_INVALID_WORKER_READING');
    expect(() => accumulator.observe(Array.from({ length: 17 }, (_, index) => reading(`owner-${index}`, 1)), now)).toThrow('OBSERVABILITY_WORKER_LIMIT');
    accumulator.observe([next], now + 1);
    expect(accumulator.snapshot(now + 1).render.hit).toBe(1);
    const snapshot = accumulator.snapshot(now + 1); snapshot.render.hit = 900; snapshot.jobs[0].buckets.fill(999);
    expect(accumulator.snapshot(now + 1).render.hit).toBe(1);
    expect(accumulator.snapshot(now + 1).jobs[0].buckets.at(-1)).toBe(1);
  });
  test('rejects changed histogram membership and aggregate overflow without losing valid future increments', () => {
    const accumulator = new WorkerMetricsAccumulator();
    accumulator.observe([reading('a', 1)], now);
    const moved = reading('a', 1, now + 1);
    moved.sample.jobs[0].buckets[0] = 1;
    accumulator.observe([moved], now + 1);
    accumulator.observe([reading('a', 2, now + 2)], now + 2);
    expect(accumulator.snapshot(now + 2).jobs[0].count).toBe(1);
    const huge = new WorkerMetricsAccumulator();
    huge.observe([reading('a', 0), reading('b', 0)], now);
    const limit = reading('a', 0, now + 1); limit.sample.render.hit = Number.MAX_SAFE_INTEGER;
    huge.observe([limit, reading('b', 0, now + 1)], now + 1);
    expect(() => huge.observe([limit, reading('b', 1, now + 2)], now + 2)).toThrow('OBSERVABILITY_METRIC_LIMIT');
    expect(huge.snapshot(now + 2).render.hit).toBe(Number.MAX_SAFE_INTEGER);
    expect(huge.snapshot(now + 2).jobs).toEqual([]);
  });
});
