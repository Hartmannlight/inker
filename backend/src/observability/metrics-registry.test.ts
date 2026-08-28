import { describe, expect, test } from 'bun:test';
import { QUEUE_NAMES } from '../jobs/queue-policy';
import { HTTP_ROUTE_GROUPS, JOB_OUTCOMES } from './structured-event';
import { MetricsRegistry, HISTOGRAM_BUCKETS_SECONDS, METRICS_LIMITS, DEVICE_DELIVERY_MODES, type QueueMetrics } from './metrics-registry';

const queue: QueueMetrics = { pending: 2, delayed: 1, processing: 1, deadLetters: 1, expiredClaims: 0, oldestDueAgeSeconds: 12.5, oldestProcessingAgeSeconds: 2 };
describe('bounded metrics registry', () => {
  test('records cumulative histogram boundaries, sums and finite overflow bucket', () => {
    const registry = new MetricsRegistry();
    for (const milliseconds of [5, 10, 5000, 25000]) registry.recordJob('render', 'success', milliseconds);
    const histogram = registry.snapshot().jobs[0];
    expect(histogram.count).toBe(4);
    expect(histogram.sum).toBeCloseTo(30.015);
    expect(histogram.buckets[0]).toBe(1);
    expect(histogram.buckets[1]).toBe(2);
    expect(histogram.buckets[HISTOGRAM_BUCKETS_SECONDS.indexOf(5)]).toBe(3);
    expect(histogram.buckets.at(-1)).toBe(4);
    expect(registry.toPrometheus()).toContain('statuspanel_job_duration_seconds_bucket{queue="render",outcome="success",le="+Inf"} 4');
    registry.recordRequest('display', 304, 3);
    expect(registry.snapshot().requests[0]).toMatchObject({ route: 'display', statusClass: '3xx', count: 1 });
  });

  test('distinguishes missing gauges from measured zeros and copies all samples', () => {
    const registry = new MetricsRegistry();
    expect(registry.snapshot().queues[1].values).toBeNull();
    expect(registry.toPrometheus()).not.toContain('statuspanel_outbox_pending{queue="render"}');
    registry.setQueue('render', queue);
    registry.setWebSocketConnections({ authenticated: 0, pending: 0 });
    registry.setDeviceCounts('connected', { active: 20, stale: 2, unseen: 1, oldestSeenAgeSeconds: 30 });
    registry.recordRender('fallback'); registry.recordWebSocket('closed');
    const snapshot = registry.snapshot();
    snapshot.queues[1].values!.pending = 500;
    snapshot.websocket.events.closed = 500;
    snapshot.render.fallback = 500;
    snapshot.devices[2].values!.active = 500;
    expect(registry.snapshot().queues[1].values!.pending).toBe(2);
    expect(registry.snapshot().websocket.events.closed).toBe(1);
    expect(registry.snapshot().render.fallback).toBe(1);
    expect(registry.snapshot().devices[2].values!.active).toBe(20);
    expect(registry.toPrometheus()).toContain('statuspanel_websocket_connections{state="authenticated"} 0');
    registry.setQueue('render', null); registry.setWebSocketConnections(null);
    expect(registry.toPrometheus()).toContain('statuspanel_queue_sample_available{queue="render"} 0');
    expect(registry.toPrometheus()).not.toContain('statuspanel_websocket_connections{state=');
  });

  test('rejects arbitrary labels, unknown gauge fields and malformed numbers atomically', () => {
    const registry = new MetricsRegistry();
    registry.setQueue('render', queue);
    const before = registry.toPrometheus();
    const invalid = [
      () => registry.recordJob('secret' as never, 'success', 1),
      () => registry.recordJob('render', 'secret' as never, 1),
      () => registry.recordRequest('/secret/path' as never, 200, 1),
      () => registry.recordRequest('display', 999, 1),
      () => registry.recordRender('secret' as never),
      () => registry.recordWebSocket('secret' as never),
      () => registry.setQueue('render', { ...queue, token: 'synthetic-secret' } as QueueMetrics),
      () => registry.setQueue('render', { ...queue, pending: 1.5 }),
      () => registry.setQueue('render', { ...queue, oldestDueAgeSeconds: NaN }),
      () => registry.setDeviceCounts('connected', { active: 1, stale: 1, unseen: 1, oldestSeenAgeSeconds: 0 }),
    ];
    for (const value of [NaN, Infinity, -1, 86_400_001]) invalid.push(() => registry.recordJob('render', 'failure', value));
    for (const run of invalid) {
      expect(run).toThrow('OBSERVABILITY_INVALID_METRIC');
      try { run(); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
    }
    expect(registry.toPrometheus()).toBe(before);
  });

  test('caps cardinality by construction across every accepted label combination', () => {
    expect(QUEUE_NAMES).toHaveLength(6);
    expect(METRICS_LIMITS.maxHistogramLabelSets).toBe(85);
    expect(METRICS_LIMITS.maxTimeSeries).toBe(1356);
    const registry = new MetricsRegistry();
    for (const route of HTTP_ROUTE_GROUPS) for (const code of [100, 200, 300, 400, 500]) registry.recordRequest(route, code, 0);
    for (const name of QUEUE_NAMES) {
      for (const outcome of JOB_OUTCOMES) registry.recordJob(name, outcome, 0);
      registry.setQueue(name, queue);
    }
    for (const mode of DEVICE_DELIVERY_MODES) registry.setDeviceCounts(mode, { active: 0, stale: 0, unseen: 0, oldestSeenAgeSeconds: 0 });
    registry.setWebSocketConnections({ authenticated: 0, pending: 0 });
    const snapshot = registry.snapshot();
    expect(snapshot.requests.length + snapshot.jobs.length).toBe(METRICS_LIMITS.maxHistogramLabelSets);
    const before = registry.toPrometheus();
    for (let index = 0; index < 1000; index++) {
      expect(() => registry.recordRequest(`secret-${index}` as never, 200, 1)).toThrow('OBSERVABILITY_INVALID_METRIC');
    }
    expect(registry.toPrometheus()).toBe(before);
    const series = before.trim().split('\n').filter(line => !line.startsWith('#'));
    expect(series.length).toBe(METRICS_LIMITS.maxTimeSeries);
    expect(new Set(series.map(line => line.split(' ')[0])).size).toBe(series.length);
    expect(before).not.toMatch(/secret|undefined|NaN/);
  });

  test('remote sync uses only the fixed queue and outcome dimensions', () => {
    const registry = new MetricsRegistry();
    registry.recordJob('remote-sync', 'failure', 15_000);
    registry.setQueue('remote-sync', queue);
    expect(registry.snapshot().jobs).toEqual([{
      queue: 'remote-sync', outcome: 'failure', count: 1, sum: 15,
      buckets: HISTOGRAM_BUCKETS_SECONDS.map(bound => bound >= 15 ? 1 : 0).concat(1),
    }]);
    const output = registry.toPrometheus();
    expect(output).toContain('statuspanel_job_duration_seconds_sum{queue="remote-sync",outcome="failure"} 15');
    expect(output).toContain('statuspanel_outbox_pending{queue="remote-sync"} 2');
    expect(output).not.toMatch(/subscriptionId|serverId|baseUrl|credential/);
    expect(() => registry.recordJob('remote-sync:synthetic-secret' as never, 'failure', 1)).toThrow('OBSERVABILITY_INVALID_METRIC');
    expect(registry.toPrometheus()).toBe(output);
  });

  test('does not invoke gauge getters or proxies and does not share registry instances', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'authenticated', { enumerable: true, get() { calls++; return 1; } });
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
    const first = new MetricsRegistry(), second = new MetricsRegistry();
    for (const input of [getter, proxy]) expect(() => first.setWebSocketConnections(input as never)).toThrow('OBSERVABILITY_INVALID_METRIC');
    expect(calls).toBe(0);
    first.recordRender('hit');
    expect(second.snapshot().render.hit).toBe(0);
    first.recordJob('render', 'success', 1);
    first.snapshot().jobs[0].buckets.fill(999);
    expect(first.snapshot().jobs[0].buckets.at(-1)).toBe(1);
  });
});
