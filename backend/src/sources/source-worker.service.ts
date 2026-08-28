import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type OutboxEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxStore } from '../events/outbox.store';
import { OUTBOX_POLICY, queueRetryDelay } from '../jobs/queue-policy';
import { EncryptionService } from '../common/services/encryption.service';
import { DEFAULT_INSTANCE_SECRET_PATH } from '../config/instance-secrets';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { runConnector, validateConnectorResult, type ConnectorType } from './connectors';
import { SOURCE_LIMITS, SOURCE_REFRESH, scheduleSource } from './source-job';
import { sourceWrite } from './source-writes';
import { executeIsolated, IsolatedExecutionError } from '../isolation/isolated-executor';

type Result = Awaited<ReturnType<typeof runConnector>>;

@Injectable()
export class SourceWorkerService {
  constructor(private readonly prisma: PrismaService, private readonly store: OutboxStore) {}
  async schedule(now = new Date()) {
    const due = await this.prisma.sourceDefinition.findMany({ where: { enabled: true, nextRefreshAt: { lte: now },
      refreshJobs: { none: { completedAt: null, event: { status: { in: ['pending', 'processing'] } } } } },
      orderBy: [{ nextRefreshAt: 'asc' }, { sourceDefinitionId: 'asc' }], take: 64, select: { sourceDefinitionId: true } });
    for (const item of due) await sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE source_definitions SET definition_version = definition_version WHERE source_definition_id = ${item.sourceDefinitionId}`;
      const source = await tx.sourceDefinition.findUnique({ where: item });
      if (source) await scheduleSource(tx, source, now);
    }));
  }
  async claim(owner: string, now = new Date()) {
    const candidates = await this.prisma.sourceRefreshJob.findMany({ where: { event: { eventType: SOURCE_REFRESH,
      OR: [{ status: 'pending', availableAt: { lte: now } }, { status: 'processing', claimUntil: { lte: now } }] } },
      orderBy: { scheduledAt: 'asc' }, take: 64 });
    const global = { eventType: SOURCE_REFRESH };
    for (const candidate of candidates) {
      const event = await this.store.claim(owner, now, { eventId: candidate.eventId }, {
        where: global, limit: SOURCE_LIMITS.global, additional: [
          { where: { ...global, sourceRefresh: { concurrencyGroup: candidate.concurrencyGroup } }, limit: SOURCE_LIMITS.provider },
          { where: { ...global, sourceRefresh: { connectorType: candidate.connectorType } }, limit: SOURCE_LIMITS.connector },
          { where: { ...global, aggregateId: candidate.sourceDefinitionId }, limit: SOURCE_LIMITS.source },
        ],
      });
      if (event) return event;
    }
    return null;
  }
  private decrypt(ciphertext: string) {
    // Loaded only for an actual connector job, never in API/renderer reads.
    const config = new ConfigService({ encryption: { secretPath: process.env.INKER_INSTANCE_SECRET_PATH || DEFAULT_INSTANCE_SECRET_PATH } });
    return new EncryptionService(config).decrypt(ciphertext);
  }
  async execute(event: OutboxEvent, parent: AbortSignal) {
    const job = await this.prisma.sourceRefreshJob.findUnique({ where: { eventId: event.eventId }, include: { source: { include: { secret: true } } } });
    if (!job || event.eventType !== SOURCE_REFRESH || event.aggregateId !== job.sourceDefinitionId
      || event.aggregateRevision !== String(job.definitionVersion) || event.payloadVersion !== 1
      || canonicalJson(event.payload) !== canonicalJson({ sourceDefinitionId: job.sourceDefinitionId, definitionVersion: job.definitionVersion, scheduledAt: job.scheduledAt.getTime() })) {
      throw new Error('OUTBOX_INVALID_PAYLOAD');
    }
    if (job.completedAt || !job.source.enabled || job.source.definitionVersion !== job.definitionVersion) return 'completed' as const;
    const abort = new AbortController();
    const abortParent = () => abort.abort();
    if (parent.aborted) abort.abort();
    else parent.addEventListener('abort', abortParent, { once: true });
    const timeout = setTimeout(() => abort.abort(), job.source.timeoutMs);
    let result: Result | undefined, errorCode: string | undefined, retryable = true;
    try {
      abort.signal.throwIfAborted();
      let secret: string | undefined;
      try { if (job.source.secret) secret = this.decrypt(job.source.secret.ciphertext); }
      catch { errorCode = 'SOURCE_SECRET_UNAVAILABLE'; retryable = false; throw new Error(errorCode); }
      result = validateConnectorResult(await runConnector(job.connectorType as ConnectorType, job.source.configuration,
        { signal: abort.signal, attempt: event.attempts, ...(secret ? { secret } : {}) }), secret);
      abort.signal.throwIfAborted();
      if (job.source.transformationCode !== null) {
        try {
          // Only the already-normalized connector data enters the child. Never
          // pass source configuration, secret references, credentials or the job.
          const data = await executeIsolated({ version: 1, kind: 'javascript',
            code: job.source.transformationCode, data: result.data, mode: 'value' }, abort.signal);
          abort.signal.throwIfAborted();
          result = validateConnectorResult({ ...result, data }, secret);
          result.connectorVersion += '+pure-js-v1';
        } catch (error) {
          errorCode = abort.signal.aborted ? (parent.aborted ? 'SOURCE_ABORTED' : 'SOURCE_TIMEOUT')
            : error instanceof IsolatedExecutionError && error.code === 'ISOLATION_TIMEOUT' ? 'SOURCE_TIMEOUT'
            : error instanceof IsolatedExecutionError && error.code === 'ISOLATION_ABORTED' ? 'SOURCE_ABORTED'
            : 'SOURCE_TRANSFORM_FAILED';
          throw new Error(errorCode);
        }
      }
      abort.signal.throwIfAborted();
    } catch {
      result = undefined;
      errorCode ??= abort.signal.aborted ? (parent.aborted ? 'SOURCE_ABORTED' : 'SOURCE_TIMEOUT') : 'SOURCE_REFRESH_FAILED';
    } finally {
      clearTimeout(timeout);
      parent.removeEventListener('abort', abortParent);
    }
    return this.persist(event, result, errorCode, retryable, parent);
  }
  private async persist(event: OutboxEvent, result: Result | undefined, errorCode: string | undefined, retryable: boolean, signal: AbortSignal) {
    return sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      const fence = () => ({ eventId: event.eventId, status: 'processing', claimToken: event.claimToken,
        claimOwner: event.claimOwner, claimUntil: { gt: new Date() } });
      if (!event.claimToken || !event.claimOwner || (await tx.outboxEvent.updateMany({ where: fence(), data: { claimToken: event.claimToken } })).count !== 1) throw new Error('SOURCE_STALE_CLAIM');
      const job = await tx.sourceRefreshJob.findUniqueOrThrow({ where: { eventId: event.eventId }, include: { source: { include: { latestValidSnapshot: true } } } });
      const source = job.source, now = new Date();
      if (job.completedAt || !source.enabled || source.definitionVersion !== job.definitionVersion) return 'completed' as const;
      if (result && signal.aborted) { result = undefined; errorCode = 'SOURCE_ABORTED'; }
      const previous = await tx.sourceSnapshot.findUnique({ where: { refreshEventId_attempt: { refreshEventId: event.eventId, attempt: event.attempts } } });
      if (previous) return previous.errorCode ? 'failed' as const : 'completed' as const;
      const lastGood = source.latestValidSnapshot;
      const data = result ? result.data : lastGood?.data ?? null;
      const terminal = !result && (!retryable || event.attempts >= OUTBOX_POLICY.maxAttempts);
      const failures = result ? 0 : source.consecutiveFailures + 1;
      const circuitUntil = !result && failures >= SOURCE_LIMITS.circuitFailures ? new Date(now.getTime() + SOURCE_LIMITS.circuitCooldownMs) : null;
      const snapshot = await tx.sourceSnapshot.create({ data: {
        sourceDefinitionId: source.sourceDefinitionId, definitionVersion: source.definitionVersion,
        revision: source.snapshotRevision + 1, schemaVersion: source.schemaVersion,
        connectorVersion: result?.connectorVersion ?? lastGood?.connectorVersion ?? `builtin-${source.connectorType}-v1`,
        createdAt: now, sourceTimestamp: result?.sourceTimestamp ? new Date(result.sourceTimestamp) : lastGood?.sourceTimestamp,
        validDataCreatedAt: result ? now : lastGood?.validDataCreatedAt,
        freshnessState: result ? 'fresh' : lastGood ? 'stale' : 'error', staleAfterSeconds: source.refreshIntervalSeconds,
        data: data === null ? Prisma.JsonNull : data as Prisma.InputJsonValue, contentHash: sha256(canonicalJson(data)),
        errorCode: result ? null : errorCode ?? 'SOURCE_REFRESH_FAILED', retryable: result ? false : !terminal,
        refreshEventId: event.eventId, attempt: event.attempts,
      } });
      await tx.sourceDefinition.update({ where: { sourceDefinitionId: source.sourceDefinitionId }, data: {
        snapshotRevision: snapshot.revision, latestSnapshotId: snapshot.snapshotId,
        ...(result ? { latestValidSnapshotId: snapshot.snapshotId, lastSuccessAt: now } : {}),
        lastAttemptAt: now, consecutiveFailures: failures, circuitOpenUntil: circuitUntil,
        nextRefreshAt: new Date(Math.max(now.getTime() + source.refreshIntervalSeconds * 1000, circuitUntil?.getTime() ?? 0)),
      } });
      if (result || terminal) {
        await tx.sourceRefreshJob.update({ where: { eventId: event.eventId }, data: { completedAt: now } });
        await tx.outboxEffect.upsert({ where: { eventId: event.eventId }, create: { key: sha256(`source:${event.eventId}`), eventId: event.eventId, completedAt: now }, update: {} });
      }
      if (!result) {
        const failed = await tx.outboxEvent.updateMany({ where: fence(), data: {
        status: terminal ? 'dead-letter' : 'pending', claimOwner: null, claimToken: null, claimUntil: null,
        processedAt: terminal ? now : null,
        availableAt: new Date(Math.max(now.getTime() + queueRetryDelay('source-refresh', event.attempts), circuitUntil?.getTime() ?? 0)),
        lastError: JSON.stringify({ code: errorCode ?? 'SOURCE_REFRESH_FAILED', correlationId: event.eventId }),
        } });
        if (failed.count !== 1) throw new Error('SOURCE_STALE_CLAIM');
      }
      // Late success cannot commit after shutdown/queue timeout; failure metadata
      // may still be recorded so the last-good snapshot remains visibly stale.
      if (result) {
        signal.throwIfAborted();
        if ((await tx.outboxEvent.updateMany({ where: fence(), data: { claimToken: event.claimToken } })).count !== 1) throw new Error('SOURCE_STALE_CLAIM');
        signal.throwIfAborted();
      }
      return result ? 'completed' as const : 'failed' as const;
    }, { timeout: 5000 }));
  }
}
