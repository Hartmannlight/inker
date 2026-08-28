import { QUEUE_NAMES, type QueueName } from '../jobs/queue-policy';
import { metadataRecord } from './correlation-context';
import { HTTP_ROUTE_GROUPS, JOB_OUTCOMES, type HttpRouteGroup, type JobOutcome } from './structured-event';

export const HISTOGRAM_BUCKETS_SECONDS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20]);
export const RENDER_RESULTS = Object.freeze(['hit', 'miss', 'fallback', 'rendered', 'failed'] as const);
export const WEBSOCKET_EVENTS = Object.freeze(['accepted', 'authenticated', 'authRejected', 'protocolRejected', 'rateLimited', 'livenessTimeout', 'operationError', 'closed', 'pong', 'telemetry'] as const);
export const DEVICE_DELIVERY_MODES = Object.freeze(['sleepy', 'responsive-pull', 'connected'] as const);
// 11 routes * 5 status classes + 6 queues * 5 outcomes = 85 histograms.
// Each has 13 buckets (including +Inf), sum and count: 1275 series.
// The fixed render/socket/queue/device families add 81 more series.
export const METRICS_LIMITS = Object.freeze({ maxDurationMs: 86_400_000, maxHistogramLabelSets: 85, maxTimeSeries: 1356 });
export type RenderResult = typeof RENDER_RESULTS[number];
export type WebSocketEvent = typeof WEBSOCKET_EVENTS[number];
export type DeviceDeliveryMode = typeof DEVICE_DELIVERY_MODES[number];
export interface QueueMetrics {
  pending: number; delayed: number; processing: number; deadLetters: number; expiredClaims: number;
  oldestDueAgeSeconds: number; oldestProcessingAgeSeconds: number;
}
export interface DeviceMetrics {
  /** Enabled devices in this mode; stale and unseen are disjoint subsets of active. */
  active: number; stale: number; unseen: number; oldestSeenAgeSeconds: number;
}
export interface HistogramSnapshot { count: number; sum: number; buckets: number[]; }
type Histogram = HistogramSnapshot;
const queueFields = ['pending', 'delayed', 'processing', 'deadLetters', 'expiredClaims', 'oldestDueAgeSeconds', 'oldestProcessingAgeSeconds'] as const;
const deviceFields = ['active', 'stale', 'unseen', 'oldestSeenAgeSeconds'] as const;
const invalid = (): never => { throw new Error('OBSERVABILITY_INVALID_METRIC'); };

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid();
  return value as T;
}
function nonnegative(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
    || (integer && !Number.isSafeInteger(value))) return invalid();
  return value;
}
function add(a: number, b: number): number {
  if (!Number.isFinite(a + b) || a + b > Number.MAX_SAFE_INTEGER) throw new Error('OBSERVABILITY_METRIC_LIMIT');
  return a + b;
}
function gauge<T>(input: unknown, fields: readonly string[], ages: readonly string[]): T {
  const value = metadataRecord(input, fields, 'OBSERVABILITY_INVALID_METRIC');
  if (Object.keys(value).length !== fields.length) return invalid();
  const result: Record<string, number> = {};
  for (const key of fields) result[key] = nonnegative(value[key], !ages.includes(key));
  return result as T;
}
const copyHistogram = (value: Histogram): HistogramSnapshot => ({ count: value.count, sum: value.sum, buckets: [...value.buckets] });

/** Fixed dimensions only; IDs, paths, source names and arbitrary labels have no API. */
export class MetricsRegistry {
  private readonly requests = new Map<string, Histogram>();
  private readonly jobs = new Map<string, Histogram>();
  private readonly renders = Object.fromEntries(RENDER_RESULTS.map(key => [key, 0])) as Record<RenderResult, number>;
  private readonly sockets = Object.fromEntries(WEBSOCKET_EVENTS.map(key => [key, 0])) as Record<WebSocketEvent, number>;
  private connections: { authenticated: number; pending: number } | null = null;
  private readonly queues = new Map<QueueName, QueueMetrics>();
  private readonly devices = new Map<DeviceDeliveryMode, DeviceMetrics>();

  private observe(store: Map<string, Histogram>, key: string, durationMs: number) {
    const milliseconds = nonnegative(durationMs);
    if (milliseconds > METRICS_LIMITS.maxDurationMs) return invalid();
    const seconds = milliseconds / 1000;
    const prior = store.get(key) ?? { count: 0, sum: 0, buckets: Array(HISTOGRAM_BUCKETS_SECONDS.length + 1).fill(0) };
    // Validate all additions before mutating a family.
    const next = { count: add(prior.count, 1), sum: add(prior.sum, seconds),
      buckets: prior.buckets.map((count, index) => index === HISTOGRAM_BUCKETS_SECONDS.length
        || seconds <= HISTOGRAM_BUCKETS_SECONDS[index] ? add(count, 1) : count) };
    store.set(key, next);
  }

  recordRequest(route: HttpRouteGroup, statusCode: number, durationMs: number): void {
    member(route, HTTP_ROUTE_GROUPS);
    if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) return invalid();
    this.observe(this.requests, `${route}:${Math.floor(statusCode / 100)}xx`, durationMs);
  }
  recordJob(queue: QueueName, outcome: JobOutcome, durationMs: number): void {
    member(queue, QUEUE_NAMES); member(outcome, JOB_OUTCOMES);
    this.observe(this.jobs, `${queue}:${outcome}`, durationMs);
  }
  recordRender(result: RenderResult): void {
    member(result, RENDER_RESULTS); this.renders[result] = add(this.renders[result], 1);
  }
  recordWebSocket(event: WebSocketEvent): void {
    member(event, WEBSOCKET_EVENTS); this.sockets[event] = add(this.sockets[event], 1);
  }
  setWebSocketEvents(value: Record<WebSocketEvent, number>): void {
    Object.assign(this.sockets, gauge(value, WEBSOCKET_EVENTS, []));
  }
  setWebSocketConnections(value: { authenticated: number; pending: number } | null): void {
    this.connections = value === null ? null : gauge(value, ['authenticated', 'pending'], []);
  }
  setQueue(queue: QueueName, value: QueueMetrics | null): void {
    member(queue, QUEUE_NAMES);
    if (value === null) this.queues.delete(queue);
    else this.queues.set(queue, gauge(value, queueFields, ['oldestDueAgeSeconds', 'oldestProcessingAgeSeconds']));
  }
  setDeviceCounts(mode: DeviceDeliveryMode, value: DeviceMetrics | null): void {
    member(mode, DEVICE_DELIVERY_MODES);
    if (value === null) this.devices.delete(mode);
    else {
      const counts = gauge<DeviceMetrics>(value, deviceFields, ['oldestSeenAgeSeconds']);
      if (counts.stale + counts.unseen > counts.active) return invalid();
      this.devices.set(mode, counts);
    }
  }

  snapshot() {
    return {
      histogramBucketsSeconds: [...HISTOGRAM_BUCKETS_SECONDS],
      requests: [...this.requests].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
        const [route, statusClass] = key.split(':'); return { route: route as HttpRouteGroup, statusClass, ...copyHistogram(value) };
      }),
      jobs: [...this.jobs].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
        const [queue, outcome] = key.split(':'); return { queue: queue as QueueName, outcome: outcome as JobOutcome, ...copyHistogram(value) };
      }),
      render: { ...this.renders }, websocket: { events: { ...this.sockets }, connections: this.connections ? { ...this.connections } : null },
      queues: QUEUE_NAMES.map(queue => ({ queue, values: this.queues.has(queue) ? { ...this.queues.get(queue)! } : null })),
      devices: DEVICE_DELIVERY_MODES.map(mode => ({ mode, values: this.devices.has(mode) ? { ...this.devices.get(mode)! } : null })),
    };
  }

  /** Prometheus text, static names/label values, deterministic order and no timestamps. */
  toPrometheus(snapshot = this.snapshot()): string {
    const lines: string[] = [];
    const histogram = (name: string, labels: string, value: Histogram) => {
      for (let index = 0; index < value.buckets.length; index++) {
        const bound = HISTOGRAM_BUCKETS_SECONDS[index] ?? '+Inf';
        lines.push(`${name}_bucket{${labels},le="${bound}"} ${value.buckets[index]}`);
      }
      lines.push(`${name}_sum{${labels}} ${value.sum}`, `${name}_count{${labels}} ${value.count}`);
    };
    lines.push('# TYPE statuspanel_request_duration_seconds histogram');
    for (const row of snapshot.requests) histogram('statuspanel_request_duration_seconds', `route="${row.route}",status_class="${row.statusClass}"`, row);
    lines.push('# TYPE statuspanel_job_duration_seconds histogram');
    for (const row of snapshot.jobs) histogram('statuspanel_job_duration_seconds', `queue="${row.queue}",outcome="${row.outcome}"`, row);
    lines.push('# TYPE statuspanel_render_cache_total counter');
    for (const key of RENDER_RESULTS) lines.push(`statuspanel_render_cache_total{result="${key}"} ${snapshot.render[key]}`);
    lines.push('# TYPE statuspanel_websocket_events_total counter');
    for (const key of WEBSOCKET_EVENTS) lines.push(`statuspanel_websocket_events_total{event="${key}"} ${snapshot.websocket.events[key]}`);
    lines.push('# TYPE statuspanel_websocket_sample_available gauge', `statuspanel_websocket_sample_available ${snapshot.websocket.connections ? 1 : 0}`,
      '# TYPE statuspanel_websocket_connections gauge');
    if (snapshot.websocket.connections) for (const state of ['authenticated', 'pending'] as const) lines.push(`statuspanel_websocket_connections{state="${state}"} ${snapshot.websocket.connections[state]}`);
    lines.push('# TYPE statuspanel_queue_sample_available gauge');
    for (const row of snapshot.queues) lines.push(`statuspanel_queue_sample_available{queue="${row.queue}"} ${row.values ? 1 : 0}`);
    const queueNames = {
      pending: 'pending', delayed: 'delayed', processing: 'processing', deadLetters: 'dead_letters', expiredClaims: 'expired_claims',
      oldestDueAgeSeconds: 'oldest_due_age_seconds', oldestProcessingAgeSeconds: 'oldest_processing_age_seconds',
    } as const;
    for (const key of queueFields) {
      const name = `statuspanel_outbox_${queueNames[key]}`;
      lines.push(`# TYPE ${name} gauge`);
      for (const row of snapshot.queues) if (row.values) lines.push(`${name}{queue="${row.queue}"} ${row.values[key]}`);
    }
    lines.push('# TYPE statuspanel_device_sample_available gauge');
    for (const row of snapshot.devices) lines.push(`statuspanel_device_sample_available{mode="${row.mode}"} ${row.values ? 1 : 0}`);
    const deviceNames = { active: 'active', stale: 'stale', unseen: 'unseen', oldestSeenAgeSeconds: 'oldest_seen_age_seconds' } as const;
    for (const key of deviceFields) {
      const name = `statuspanel_device_${deviceNames[key]}`;
      lines.push(`# TYPE ${name} gauge`);
      for (const row of snapshot.devices) if (row.values) lines.push(`${name}{mode="${row.mode}"} ${row.values[key]}`);
    }
    return lines.join('\n') + '\n';
  }
}
