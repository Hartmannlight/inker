import { QUEUE_NAMES } from '../jobs/queue-policy';
import { HISTOGRAM_BUCKETS_SECONDS, RENDER_RESULTS, type MetricsRegistry } from './metrics-registry';
import { JOB_OUTCOMES } from './structured-event';

type Snapshot = ReturnType<MetricsRegistry['snapshot']>;
export interface WorkerMetricSample { version: 1; sampledAt: number; jobs: Snapshot['jobs']; render: Snapshot['render']; }
/** Internal Redis owner/process incarnation; never a Prometheus label or wire sample field. */
export interface WorkerMetricReading { owner: string; sample: WorkerMetricSample; }
export const WORKER_METRIC_LIMITS = Object.freeze({ workers: 16, bytes: 64 * 1024, ttlMs: 8000 });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function workerSampleFresh(sample: Pick<WorkerMetricSample, 'sampledAt'>, now = Date.now()): boolean {
  return count(now) && count(sample.sampledAt) && sample.sampledAt <= now + 2000
    && now - sample.sampledAt < WORKER_METRIC_LIMITS.ttlMs;
}

/** Only JSON from the private, derived Redis channel enters this bounded parser. */
export function parseWorkerMetricSample(text: string, now = Date.now()): WorkerMetricSample | null {
  if (Buffer.byteLength(text) > WORKER_METRIC_LIMITS.bytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!keys(value, ['version', 'sampledAt', 'jobs', 'render']) || value.version !== 1 || !count(value.sampledAt)
      || !workerSampleFresh({ sampledAt: value.sampledAt }, now)
      || !Array.isArray(value.jobs) || value.jobs.length > QUEUE_NAMES.length * JOB_OUTCOMES.length
      || !keys(value.render, [...RENDER_RESULTS]) || !Object.values(value.render).every(count)) return null;
    const seen = new Set<string>();
    for (const row of value.jobs) {
      if (!keys(row, ['queue', 'outcome', 'count', 'sum', 'buckets']) || !QUEUE_NAMES.includes(row.queue as never)
        || !JOB_OUTCOMES.includes(row.outcome as never) || !count(row.count) || !nonnegative(row.sum)
        || !Array.isArray(row.buckets) || row.buckets.length !== HISTOGRAM_BUCKETS_SECONDS.length + 1
        || !row.buckets.every(count) || row.buckets.some((entry, index, all) => entry > Number(row.count) || (index > 0 && entry < all[index - 1]))
        || row.buckets.at(-1) !== row.count) return null;
      const key = `${row.queue}:${row.outcome}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return value as unknown as WorkerMetricSample;
  } catch { return null; }
}

export function workerMetricSample(snapshot: Snapshot, now = Date.now()): string {
  const text = JSON.stringify({ version: 1, sampledAt: now, jobs: snapshot.jobs, render: snapshot.render });
  if (!parseWorkerMetricSample(text, now)) throw new Error('OBSERVABILITY_INVALID_WORKER_SAMPLE');
  return text;
}

/** Sum fixed families without adding worker/owner IDs as metric labels. */
export function combineWorkerMetrics(local: Snapshot, samples: WorkerMetricSample[]): Snapshot {
  if (samples.length > WORKER_METRIC_LIMITS.workers) throw new Error('OBSERVABILITY_WORKER_LIMIT');
  const result = structuredClone(local), jobs = new Map(result.jobs.map(row => [`${row.queue}:${row.outcome}`, row]));
  const add = (a: number, b: number) => {
    if (!nonnegative(a + b)) throw new Error('OBSERVABILITY_METRIC_LIMIT');
    return a + b;
  };
  for (const sample of samples) {
    for (const key of RENDER_RESULTS) result.render[key] = add(result.render[key], sample.render[key]);
    for (const row of sample.jobs) {
      const key = `${row.queue}:${row.outcome}`, prior = jobs.get(key);
      if (!prior) { jobs.set(key, structuredClone(row)); continue; }
      prior.count = add(prior.count, row.count); prior.sum = add(prior.sum, row.sum);
      prior.buckets = prior.buckets.map((value, index) => add(value, row.buckets[index]));
    }
  }
  result.jobs = [...jobs.values()].sort((a, b) => `${a.queue}:${a.outcome}`.localeCompare(`${b.queue}:${b.outcome}`));
  return result;
}

const emptySample = (sampledAt: number): WorkerMetricSample => ({ version: 1, sampledAt, jobs: [],
  render: { hit: 0, miss: 0, fallback: 0, rendered: 0, failed: 0 } });
const jobKey = (row: Snapshot['jobs'][number]) => `${row.queue}:${row.outcome}`;
const zeroJob = (row: Snapshot['jobs'][number]): Snapshot['jobs'][number] => ({
  queue: row.queue, outcome: row.outcome, count: 0, sum: 0, buckets: row.buckets.map(() => 0),
});

/** Returns no delta if any cumulative family moves backwards or changes old bucket membership. */
function sampleDelta(previous: WorkerMetricSample, next: WorkerMetricSample): WorkerMetricSample | null {
  const delta = emptySample(next.sampledAt);
  for (const key of RENDER_RESULTS) {
    delta.render[key] = next.render[key] - previous.render[key];
    if (delta.render[key] < 0) return null;
  }
  const priorJobs = new Map(previous.jobs.map(row => [jobKey(row), row]));
  const nextJobs = new Map(next.jobs.map(row => [jobKey(row), row]));
  if (previous.jobs.some(row => !nextJobs.has(jobKey(row)))) return null;
  for (const row of next.jobs) {
    const prior = priorJobs.get(jobKey(row)) ?? zeroJob(row);
    const change = { queue: row.queue, outcome: row.outcome, count: row.count - prior.count,
      sum: row.sum - prior.sum, buckets: row.buckets.map((value, index) => value - prior.buckets[index]) };
    if (change.count < 0 || change.sum < 0 || (change.count === 0 && change.sum !== 0)
      || change.buckets.some((value, index, all) => value < 0 || (index > 0 && value < all[index - 1]))
      || change.buckets.at(-1) !== change.count) return null;
    delta.jobs.push(change);
  }
  return delta;
}

/**
 * API-process counters cover observed increments between valid samples, not worker lifetime totals.
 * Every new/reappearing owner starts as a baseline: work before that sample is intentionally outside
 * this observed window. Missing Redis samples retain baselines; an authoritative owner set can prune
 * departures. At most 16 baselines and the fixed queue/outcome families survive; no owner labels.
 * Worker restarts need a new owner/incarnation. Reordered samples and regressing counters do not reset
 * the accumulator. Only an API-process restart resets these Prometheus counters.
 */
export class WorkerMetricsAccumulator {
  private baselines = new Map<string, WorkerMetricSample>();
  private total = emptySample(0);

  observe(readings: readonly WorkerMetricReading[] | null, now = Date.now()): void {
    if (readings === null) return;
    if (!count(now)) throw new Error('OBSERVABILITY_INVALID_WORKER_READING');
    if (readings.length > WORKER_METRIC_LIMITS.workers) throw new Error('OBSERVABILITY_WORKER_LIMIT');
    const incoming = new Map<string, WorkerMetricSample>();
    for (const reading of readings) {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(reading.owner) || incoming.has(reading.owner)) {
        throw new Error('OBSERVABILITY_INVALID_WORKER_READING');
      }
      // These samples were already parsed from private Redis JSON; copy to detach caller state.
      const sample = parseWorkerMetricSample(JSON.stringify(reading.sample), now);
      if (!sample) throw new Error('OBSERVABILITY_INVALID_WORKER_READING');
      incoming.set(reading.owner, sample);
    }
    const baselines = new Map<string, WorkerMetricSample>();
    const total = structuredClone(this.total), jobs = new Map(total.jobs.map(row => [jobKey(row), row]));
    const add = (a: number, b: number) => {
      if (!nonnegative(a + b)) throw new Error('OBSERVABILITY_METRIC_LIMIT');
      return a + b;
    };
    for (const [owner, sample] of incoming) {
      const previous = this.baselines.get(owner);
      baselines.set(owner, previous ?? sample);
      if (previous && sample.sampledAt <= previous.sampledAt) continue;
      const delta = previous ? sampleDelta(previous, sample) : emptySample(now);
      if (!delta) continue;
      for (const row of sample.jobs) if (!jobs.has(jobKey(row))) jobs.set(jobKey(row), zeroJob(row));
      for (const key of RENDER_RESULTS) total.render[key] = add(total.render[key], delta.render[key]);
      for (const row of delta.jobs) {
        const accumulated = jobs.get(jobKey(row))!;
        accumulated.count = add(accumulated.count, row.count);
        accumulated.sum = add(accumulated.sum, row.sum);
        accumulated.buckets = accumulated.buckets.map((value, index) => add(value, row.buckets[index]));
      }
      baselines.set(owner, sample);
    }
    total.jobs = [...jobs.values()].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    total.sampledAt = now;
    this.total = total;
    this.baselines = baselines;
  }

  snapshot(now = Date.now()): WorkerMetricSample {
    if (!count(now)) throw new Error('OBSERVABILITY_INVALID_WORKER_SAMPLE');
    return { ...structuredClone(this.total), sampledAt: now };
  }
}
