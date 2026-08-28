import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OPERATIONS_ERROR_CODES, OPERATIONS_LIMITS, OPERATIONS_QUEUE_NAMES, REMOTE_ERROR_CODES, parseDeliveryPolicy,
  parseOperationsStatus, type DeliveryMode, type OperationsCollection, type OperationsDeviceActivity,
  type OperationsRemoteActivity, type OperationsSourceActivity, type OperationsStatus } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRedisService } from '../events/outbox-redis.service';
import { WebDisplayGateway } from '../device-platform/web-display.gateway';
import { queueEventFilter, queueForEvent } from '../jobs/queue-routing';
import { DEVICE_DELIVERY_MODES, type DeviceMetrics } from './metrics-registry';
import { runtimeMetrics, emitStructuredEvent } from './runtime-observability';
import { combineWorkerMetrics, workerSampleFresh, WorkerMetricsAccumulator, WORKER_METRIC_LIMITS, type WorkerMetricReading } from './worker-metrics';
import { BoundedRead, readBatch } from './bounded-read';
import { sourceFreshness } from '../sources/source-read.service';
import { remoteStatus } from '../federation/remote-status';

export const OPERATIONS_THRESHOLDS = Object.freeze({ cacheMs: 1000, readTimeoutMs: 2000, queueAgeSeconds: 30, maxPolicies: 100 });
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
const age = (value: Date | null, now: Date): number | null => value ? Math.max(0, (now.getTime() - value.getTime()) / 1000) : null;
const empty = <T>(): OperationsCollection<T> => ({ sampledAt: null, total: null, items: [], truncated: false });
const collection = <T>(items: T[], total: number, now: Date): OperationsCollection<T> => {
  if (total < items.length) throw new Error('OPERATIONS_INCONSISTENT_SAMPLE');
  return { sampledAt: now.toISOString(), total, items, truncated: total > items.length };
};
function errorCode(value: string | null): typeof OPERATIONS_ERROR_CODES[number] | null {
  if (value === null) return null;
  let code: unknown = value;
  if (value.length <= 4096 && value.startsWith('{')) {
    try { code = (JSON.parse(value) as { code?: unknown }).code; } catch { code = undefined; }
  }
  return OPERATIONS_ERROR_CODES.includes(code as never) ? code as typeof OPERATIONS_ERROR_CODES[number] : 'UNKNOWN_FAILURE';
}

@Injectable()
export class OperationsService {
  private pending?: Promise<OperationsStatus>;
  private cached?: { until: number; value: OperationsStatus };
  private previousState?: OperationsStatus['status'];
  private workers: WorkerMetricReading[] | null = null;
  private readonly databaseRead = new BoundedRead();
  private readonly databaseProbe = new BoundedRead();
  private readonly workerCounters = new WorkerMetricsAccumulator();
  constructor(private readonly prisma: PrismaService, private readonly redis: OutboxRedisService,
    private readonly gateway: WebDisplayGateway) {}

  /** Shared bounded read, not one scan per concurrent dashboard/scrape. No writes. */
  async status(): Promise<OperationsStatus> {
    if (this.cached && this.cached.until > Date.now()) return this.currentStatus(this.cached.value);
    if (!this.pending) this.pending = this.sample().then(value => {
      const workerExpiry = this.workers ? Math.min(...this.workers.map(row => row.sample.sampledAt + WORKER_METRIC_LIMITS.ttlMs)) : Infinity;
      this.cached = { until: Math.min(Date.now() + OPERATIONS_THRESHOLDS.cacheMs, workerExpiry), value }; return value;
    }).finally(() => { this.pending = undefined; });
    return this.currentStatus(await this.pending);
  }
  private currentStatus(value: OperationsStatus): OperationsStatus {
    const result = structuredClone(value);
    if (result.renderCache.sampledAt !== null && (Date.now() - Date.parse(result.renderCache.sampledAt) >= WORKER_METRIC_LIMITS.ttlMs
      || (this.workers !== null && !this.workers.every(row => workerSampleFresh(row.sample))))) {
      this.workers = null;
      this.cached = undefined;
      result.renderCache = { sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null };
      if (!result.reasons.includes('METRICS_UNAVAILABLE')) result.reasons.push('METRICS_UNAVAILABLE');
      if (result.status === 'healthy') result.status = 'degraded';
    }
    return result;
  }
  async metrics(): Promise<string> {
    await this.status();
    const available = this.workers !== null && this.workers.every(row => workerSampleFresh(row.sample));
    const snapshot = available ? combineWorkerMetrics(runtimeMetrics.snapshot(), [this.workerCounters.snapshot()]) : runtimeMetrics.snapshot();
    let text = runtimeMetrics.toPrometheus(snapshot);
    // Unknown worker families cannot become fabricated zero-valued measurements.
    if (!available) text = text.split('\n').filter(line => !line.startsWith('statuspanel_render_cache_total{')
      && !line.startsWith('statuspanel_job_duration_seconds_')).join('\n');
    return text + '# TYPE statuspanel_worker_sample_available gauge\n' + `statuspanel_worker_sample_available ${available ? 1 : 0}\n`;
  }

  private async sample(): Promise<OperationsStatus> {
    const now = new Date();
    const [database, background, workers, probe] = await Promise.allSettled([
      this.databaseRead.run(signal => this.database(this.prisma, now, signal), OPERATIONS_THRESHOLDS.readTimeoutMs),
      this.redis.backgroundStatus(), this.redis.workerMetricSamples(),
      this.databaseProbe.run(async () => this.prisma.$queryRaw`SELECT 1`, OPERATIONS_THRESHOLDS.readTimeoutMs),
    ]);
    const data = database.status === 'fulfilled' ? database.value : null;
    const bg = background.status === 'fulfilled' ? background.value : null;
    const redisReady = bg?.redis === 'ready';
    const workerCount = redisReady ? bg?.workers ?? 0 : null;
    const workerRows = workers.status === 'fulfilled' ? workers.value : null;
    this.workers = workerCount && workerRows?.length === workerCount && workerRows.every(row => workerSampleFresh(row.sample)) ? workerRows : null;
    let merged: ReturnType<typeof runtimeMetrics.snapshot> | null = null;
    try {
      if (this.workers) merged = combineWorkerMetrics(runtimeMetrics.snapshot(), this.workers.map(row => row.sample));
      this.workerCounters.observe(this.workers);
    }
    catch { this.workers = null; merged = null; }
    const reasons: OperationsStatus['reasons'] = [];
    const apiReady = probe.status === 'fulfilled';
    if (!apiReady) reasons.push('API_DATABASE_UNAVAILABLE');
    if (!redisReady) reasons.push('QUEUE_UNAVAILABLE');
    else if (!workerCount) reasons.push('WORKER_UNAVAILABLE');
    if (!merged || !data) reasons.push('METRICS_UNAVAILABLE');
    if (data?.queues.some(queue => queue.oldestDueAgeSeconds! >= OPERATIONS_THRESHOLDS.queueAgeSeconds || queue.expiredClaims! > 0)) reasons.push('QUEUE_BACKLOG');
    if (data?.deadLetters.total) reasons.push('DEAD_LETTERS');
    if (data?.sourceErrors) reasons.push('SOURCE_ERRORS');
    if (data?.remotes.items.some(row => row.enabled && ['stale', 'error'].includes(row.status))) reasons.push('REMOTE_ERRORS');
    if (data?.deviceGauges.some(row => row.values.stale > 0 || row.values.unseen > 0)
      || data?.devices.items.some(row => row.enabled && row.connection === 'disconnected')) reasons.push('STALE_DEVICES');
    if (data?.renderErrors) reasons.push('RENDER_ERRORS');
    if (data?.policyOverflow && !reasons.includes('METRICS_UNAVAILABLE')) reasons.push('METRICS_UNAVAILABLE');
    for (const queue of OPERATIONS_QUEUE_NAMES) {
      const row = data?.queues.find(value => value.queue === queue);
      runtimeMetrics.setQueue(queue, row ? { pending: row.pending!, delayed: row.delayed!, processing: row.processing!,
        deadLetters: row.deadLetters!, expiredClaims: row.expiredClaims!, oldestDueAgeSeconds: row.oldestDueAgeSeconds!,
        oldestProcessingAgeSeconds: row.oldestProcessingAgeSeconds! } : null);
    }
    for (const mode of DEVICE_DELIVERY_MODES) runtimeMetrics.setDeviceCounts(mode, data?.deviceGauges.find(row => row.mode === mode)?.values ?? null);
    let websocket: OperationsStatus['websocket'] = { sampledAt: null, authenticatedConnections: null, pendingConnections: null, livenessTimeouts: null, authRejected: null };
    try {
      const ws = this.gateway.metrics();
      websocket = { sampledAt: now.toISOString(), authenticatedConnections: ws.authenticatedConnections,
        pendingConnections: Math.max(0, ws.connections - ws.authenticatedConnections), livenessTimeouts: ws.livenessTimeouts, authRejected: ws.authRejected };
      runtimeMetrics.setWebSocketConnections({ authenticated: ws.authenticatedConnections, pending: websocket.pendingConnections! });
      runtimeMetrics.setWebSocketEvents({ accepted: ws.accepted, authenticated: ws.authenticated, authRejected: ws.authRejected,
        protocolRejected: ws.protocolRejected, rateLimited: ws.rateLimited, livenessTimeout: ws.livenessTimeouts,
        operationError: ws.operationErrors, closed: ws.closed, pong: ws.pongs, telemetry: ws.telemetryMessages });
    } catch { runtimeMetrics.setWebSocketConnections(null); if (!reasons.includes('METRICS_UNAVAILABLE')) reasons.push('METRICS_UNAVAILABLE'); }
    const value: OperationsStatus = {
      protocolVersion: '1.0', generatedAt: now.toISOString(), status: !apiReady ? 'unavailable' : reasons.length ? 'degraded' : 'healthy', reasons,
      health: { apiReady, database: apiReady ? 'ready' : 'unavailable', redis: redisReady ? 'ready' : 'unavailable',
        workers: { status: workerCount === null ? 'unknown' : workerCount > 0 ? 'ready' : 'unavailable',
          count: workerCount, sampledAt: workerCount === null ? null : now.toISOString() } },
      queues: data?.queues ?? OPERATIONS_QUEUE_NAMES.map(queue => ({ queue, sampledAt: null, pending: null, delayed: null,
        processing: null, deadLetters: null, expiredClaims: null, oldestDueAgeSeconds: null, oldestProcessingAgeSeconds: null })),
      renderCache: merged ? { sampledAt: new Date(Math.min(now.getTime(), ...this.workers!.map(row => row.sample.sampledAt))).toISOString(),
        hits: merged.render.hit, misses: merged.render.miss, fallbacks: merged.render.fallback, rendered: merged.render.rendered, failures: merged.render.failed }
        : { sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null },
      websocket, sources: data?.sources ?? empty(), remotes: data?.remotes ?? empty(), devices: data?.devices ?? empty(), deadLetters: data?.deadLetters ?? empty(),
    };
    const parsed = parseOperationsStatus(value);
    if (!parsed.success) throw new ServiceUnavailableException('OPERATIONS_UNAVAILABLE');
    if (this.previousState !== value.status) {
      emitStructuredEvent(value.status === 'healthy' ? 'DEPENDENCY_RECOVERED' : 'DEPENDENCY_DEGRADED', { role: 'api' });
      this.previousState = value.status;
    }
    return parsed.data;
  }

  /** Best-effort metadata reads: never acquire SQLite's writer lock for a dashboard. */
  private async database(tx: Prisma.TransactionClient, now: Date, signal: AbortSignal) {
    const queues: OperationsStatus['queues'] = [];
    for (const queue of OPERATIONS_QUEUE_NAMES) {
      signal.throwIfAborted();
      const filter = queueEventFilter(queue), due = { ...filter, status: 'pending', availableAt: { lte: now } };
      const processing = { ...filter, status: 'processing' };
      const [pending, delayed, active, deadLetters, expiredClaims, oldest, oldestActive] = await readBatch([
        tx.outboxEvent.count({ where: due }), tx.outboxEvent.count({ where: { ...filter, status: 'pending', availableAt: { gt: now } } }),
        tx.outboxEvent.count({ where: processing }), tx.outboxEvent.count({ where: { ...filter, status: 'dead-letter' } }),
        tx.outboxEvent.count({ where: { ...processing, OR: [{ claimUntil: { lte: now } }, { claimUntil: null }] } }),
        tx.outboxEvent.aggregate({ where: due, _min: { availableAt: true } }),
        tx.outboxEvent.aggregate({ where: processing, _min: { lastAttemptAt: true } }),
      ] as const);
      queues.push({ queue, sampledAt: now.toISOString(), pending, delayed, processing: active, deadLetters, expiredClaims,
        oldestDueAgeSeconds: age(oldest._min.availableAt, now) ?? 0, oldestProcessingAgeSeconds: age(oldestActive._min.lastAttemptAt, now) ?? 0 });
    }
    signal.throwIfAborted();
    const [sourceRows, sourceTotal, sourceErrors, remoteRows, remoteTotal, deviceRows, deviceTotal, deadRows, deadTotal, policies, renderErrors] = await readBatch([
      tx.sourceDefinition.findMany({ take: OPERATIONS_LIMITS.rows, orderBy: { sourceDefinitionId: 'asc' }, select: {
        sourceDefinitionId: true, connectorType: true, enabled: true, lastAttemptAt: true, lastSuccessAt: true, circuitOpenUntil: true,
        latestSnapshot: { select: { freshnessState: true, validDataCreatedAt: true, staleAfterSeconds: true, errorCode: true } },
      } }), tx.sourceDefinition.count(), tx.sourceDefinition.count({ where: { enabled: true, consecutiveFailures: { gt: 0 } } }),
      tx.remoteSubscription.findMany({ take: OPERATIONS_LIMITS.remoteRows, orderBy: { subscriptionId: 'asc' }, select: {
        subscriptionId: true, enabled: true, lastAttemptAt: true, lastSuccessAt: true, nextSyncAt: true, circuitOpenUntil: true,
        lastErrorCode: true, latestLocalRevisionId: true, refreshIntervalSeconds: true,
      } }), tx.remoteSubscription.count(),
      tx.device.findMany({ take: OPERATIONS_LIMITS.rows, orderBy: { id: 'asc' }, select: { id: true, isActive: true,
        lastSeenAt: true, lastConnectedAt: true, deliveryPolicy: { select: { mode: true, definition: true } },
        publicationState: { select: { desiredPublicationRevisionId: true, acknowledgedPublicationRevisionId: true, acknowledgedAt: true } },
      } }), tx.device.count(),
      tx.outboxEvent.findMany({ where: { status: 'dead-letter' }, take: OPERATIONS_LIMITS.rows, orderBy: [{ processedAt: 'desc' }, { eventId: 'asc' }],
        select: { eventId: true, correlationId: true, eventType: true, occurredAt: true, processedAt: true, attempts: true, lastError: true } }),
      tx.outboxEvent.count({ where: { status: 'dead-letter' } }),
      tx.deliveryPolicy.findMany({ take: OPERATIONS_THRESHOLDS.maxPolicies + 1, select: { policyId: true, mode: true, definition: true } }),
      tx.outboxEvent.count({ where: { ...queueEventFilter('render'), status: { in: ['pending', 'processing', 'dead-letter'] }, lastError: { not: null } } }),
    ] as const);
    signal.throwIfAborted();
    const sources = sourceRows.map((row): OperationsSourceActivity => {
      const last = row.latestSnapshot;
      const freshness = !last ? 'missing' : sourceFreshness(last, now) as 'fresh' | 'stale' | 'error';
      return { sourceDefinitionId: row.sourceDefinitionId, connectorType: row.connectorType as OperationsSourceActivity['connectorType'],
        enabled: row.enabled, lastAttemptAt: iso(row.lastAttemptAt), lastSuccessAt: iso(row.lastSuccessAt), ageSeconds: age(row.lastSuccessAt, now),
        freshness, errorCode: errorCode(last?.errorCode ?? null), circuitOpenUntil: iso(row.circuitOpenUntil) };
    });
    const remotes = remoteRows.map((row): OperationsRemoteActivity => ({ subscriptionId: row.subscriptionId, enabled: row.enabled,
      status: remoteStatus(row, now),
      lastAttemptAt: iso(row.lastAttemptAt), lastSuccessAt: iso(row.lastSuccessAt), nextSyncAt: row.nextSyncAt.toISOString(), ageSeconds: age(row.lastSuccessAt, now),
      circuitOpenUntil: iso(row.circuitOpenUntil), errorCode: row.lastErrorCode === null ? null : REMOTE_ERROR_CODES.includes(row.lastErrorCode as never)
        ? row.lastErrorCode as typeof REMOTE_ERROR_CODES[number] : 'UNKNOWN_FAILURE' }));
    const devices = deviceRows.map((row): OperationsDeviceActivity => {
      const parsed = parseDeliveryPolicy(row.deliveryPolicy.definition);
      if (!parsed.success) throw new Error('OPERATIONS_INVALID_POLICY');
      const seenAge = age(row.lastSeenAt, now), state = row.publicationState;
      return { deviceId: row.id, enabled: row.isActive, deliveryMode: parsed.data.mode,
        connection: parsed.data.mode === 'connected' ? this.gateway.isConnected(row.id) ? 'connected' : 'disconnected' : 'not-applicable',
        lastSeenAt: iso(row.lastSeenAt), lastConnectedAt: iso(row.lastConnectedAt), acknowledgedAt: iso(state?.acknowledgedAt ?? null), ageSeconds: seenAge,
        state: !row.isActive ? 'disabled' : seenAge === null ? 'unseen' : seenAge >= parsed.data.maxStaleSeconds ? 'stale' : 'active',
        publicationState: !state?.desiredPublicationRevisionId ? 'unassigned' : state.desiredPublicationRevisionId === state.acknowledgedPublicationRevisionId ? 'current' : 'pending' };
    });
    const deviceGauges: { mode: DeliveryMode; values: DeviceMetrics }[] = [];
    if (policies.length <= OPERATIONS_THRESHOLDS.maxPolicies) for (const mode of DEVICE_DELIVERY_MODES) {
      signal.throwIfAborted();
      const matching = policies.filter(policy => policy.mode === mode);
      const staleWhere = matching.map(policy => {
        const parsed = parseDeliveryPolicy(policy.definition);
        if (!parsed.success) throw new Error('OPERATIONS_INVALID_POLICY');
        return { deliveryPolicyId: policy.policyId, lastSeenAt: { lte: new Date(now.getTime() - parsed.data.maxStaleSeconds * 1000) } };
      });
      const where = { isActive: true, deliveryPolicy: { mode } };
      const [active, unseen, stale, oldest] = await readBatch([tx.device.count({ where }),
        tx.device.count({ where: { ...where, lastSeenAt: null } }), tx.device.count({ where: { ...where, OR: staleWhere } }),
        tx.device.aggregate({ where, _min: { lastSeenAt: true } })] as const);
      if (stale + unseen > active) throw new Error('OPERATIONS_INCONSISTENT_SAMPLE');
      deviceGauges.push({ mode, values: { active, stale, unseen, oldestSeenAgeSeconds: age(oldest._min.lastSeenAt, now) ?? 0 } });
    }
    signal.throwIfAborted();
    return { queues, sources: collection(sources, sourceTotal, now), sourceErrors,
      remotes: collection(remotes, remoteTotal, now), devices: collection(devices, deviceTotal, now), deviceGauges,
      policyOverflow: policies.length > OPERATIONS_THRESHOLDS.maxPolicies, renderErrors,
      deadLetters: collection(deadRows.map(row => ({ eventId: row.eventId, correlationId: row.correlationId, queue: queueForEvent(row.eventType),
        occurredAt: row.occurredAt.toISOString(), processedAt: row.processedAt!.toISOString(), attempts: row.attempts,
        errorCode: errorCode(row.lastError) ?? 'UNKNOWN_FAILURE' })), deadTotal, now) };
  }
}
