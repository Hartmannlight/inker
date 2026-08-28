import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboxEvent, RemoteSubscription } from '@prisma/client';
import { FEDERATION_LIMITS, parseFederationCapabilities, parseFederationPublicationFeed, type FederationPublicationFeed } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxStore } from '../events/outbox.store';
import { outboxCorrelation } from '../events/outbox-correlation';
import { OUTBOX_POLICY, queueRetryDelay } from '../jobs/queue-policy';
import { EncryptionService } from '../common/services/encryption.service';
import { DEFAULT_INSTANCE_SECRET_PATH } from '../config/instance-secrets';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { sourceWrite } from '../sources/source-writes';
import { REMOTE_LIMITS, REMOTE_SYNC, scheduleRemote } from './remote-job';
import { RemoteImportService } from './remote-import.service';
import { RemoteTransport } from './remote-transport';

const ERROR_CODES = new Set([
  'REMOTE_URL_INVALID', 'REMOTE_POLICY_INVALID', 'REMOTE_ORIGIN_DENIED', 'REMOTE_ADDRESS_DENIED',
  'REMOTE_DNS_FAILED', 'REMOTE_REQUEST_FAILED', 'REMOTE_REDIRECT_DENIED', 'REMOTE_RESPONSE_INVALID',
  'REMOTE_RESPONSE_TOO_LARGE', 'REMOTE_TIMEOUT', 'REMOTE_ABORTED', 'REMOTE_UNAUTHORIZED',
  'REMOTE_PROTOCOL_MISMATCH', 'REMOTE_IDENTITY_MISMATCH', 'REMOTE_PUBLICATION_MISMATCH',
  'REMOTE_HASH_MISMATCH', 'REMOTE_SECRET_UNAVAILABLE', 'REMOTE_SYNC_FAILED',
  'REMOTE_REVISION_CONFLICT', 'REMOTE_CACHE_INVALID',
]);
const TERMINAL = new Set([
  'REMOTE_URL_INVALID', 'REMOTE_POLICY_INVALID', 'REMOTE_ORIGIN_DENIED', 'REMOTE_ADDRESS_DENIED',
  'REMOTE_UNAUTHORIZED', 'REMOTE_PROTOCOL_MISMATCH', 'REMOTE_IDENTITY_MISMATCH',
  'REMOTE_PUBLICATION_MISMATCH', 'REMOTE_SECRET_UNAVAILABLE',
]);
type Result = {
  etag: string | null; feedHash: string; remoteRevision: number; remoteRevisionId: string;
  feed?: FederationPublicationFeed; artifacts?: Buffer[]; cachedRevisionId?: string;
};
type Transport = RemoteTransport;
function fail(code: string): never { throw new Error(code); }
function constantError(error: unknown): string {
  return error instanceof Error && ERROR_CODES.has(error.message) ? error.message : 'REMOTE_SYNC_FAILED';
}

@Injectable()
export class RemoteWorkerService {
  constructor(private readonly prisma: PrismaService, private readonly store: OutboxStore, private readonly importer: RemoteImportService) {}

  async schedule(now = new Date()) {
    const due = await this.prisma.remoteSubscription.findMany({ where: {
      enabled: true, nextSyncAt: { lte: now },
      syncJobs: { none: { completedAt: null, event: { status: { in: ['pending', 'processing'] } } } },
    }, orderBy: [{ nextSyncAt: 'asc' }, { subscriptionId: 'asc' }], take: 32, select: { subscriptionId: true } });
    for (const item of due) await sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE remote_subscriptions SET version = version WHERE subscription_id = ?', item.subscriptionId);
      const subscription = await tx.remoteSubscription.findUnique({ where: item });
      if (subscription) await scheduleRemote(tx, subscription, now);
    }));
  }

  async claim(owner: string, now = new Date()) {
    const candidates = await this.prisma.remoteSyncJob.findMany({ where: { event: {
      eventType: REMOTE_SYNC, OR: [
        { status: 'pending', availableAt: { lte: now } },
        { status: 'processing', OR: [{ claimUntil: { lte: now } }, { claimUntil: null }] },
      ],
    } }, orderBy: { scheduledAt: 'asc' }, take: 32 });
    for (const candidate of candidates) {
      const scope = { eventType: REMOTE_SYNC };
      const event = await this.store.claim(owner, now, { eventId: candidate.eventId }, {
        where: scope, limit: REMOTE_LIMITS.global, additional: [
          { where: { ...scope, remoteSync: { remoteServerId: candidate.remoteServerId } }, limit: REMOTE_LIMITS.remote },
          { where: { ...scope, aggregateId: candidate.subscriptionId }, limit: REMOTE_LIMITS.subscription },
        ],
      });
      if (event) return event;
    }
    return null;
  }

  protected createTransport(): Transport { return new RemoteTransport(); }
  protected decrypt(ciphertext: string): string {
    const config = new ConfigService({ encryption: { secretPath: process.env.INKER_INSTANCE_SECRET_PATH || DEFAULT_INSTANCE_SECRET_PATH } });
    return new EncryptionService(config).decrypt(ciphertext);
  }

  async execute(event: OutboxEvent, parent: AbortSignal) {
    const job = await this.prisma.remoteSyncJob.findUnique({
      where: { eventId: event.eventId }, include: { subscription: { include: { server: true, credential: true } } },
    });
    if (!job || event.eventType !== REMOTE_SYNC || event.aggregateType !== 'RemoteSubscription'
      || event.aggregateId !== job.subscriptionId || event.aggregateRevision !== String(job.subscriptionVersion)
      || job.remoteServerId !== job.subscription.remoteServerId
      || event.payloadVersion !== 1 || canonicalJson(event.payload) !== canonicalJson({
        subscriptionId: job.subscriptionId, subscriptionVersion: job.subscriptionVersion, scheduledAt: job.scheduledAt.getTime(),
      })) throw new Error('OUTBOX_INVALID_PAYLOAD');
    if (job.completedAt) return 'completed' as const;
    if (!await this.store.current(event)) throw new Error('REMOTE_STALE_CLAIM');
    if (!job.subscription.enabled || job.subscription.version !== job.subscriptionVersion) {
      return this.persist(event, undefined, undefined, parent, true);
    }
    const abort = new AbortController();
    const abortParent = () => abort.abort();
    if (parent.aborted) abort.abort();
    else parent.addEventListener('abort', abortParent, { once: true });
    const timeout = setTimeout(() => abort.abort(), REMOTE_LIMITS.networkMs);
    let result: Result | undefined, errorCode: string | undefined;
    try {
      abort.signal.throwIfAborted();
      const subscription = job.subscription;
      if (!subscription.server.trusted) fail('REMOTE_ORIGIN_DENIED');
      let token: string;
      try { token = this.decrypt(subscription.credential.ciphertext); }
      catch { fail('REMOTE_SECRET_UNAVAILABLE'); }
      if (!/^sp_share_[A-Za-z0-9_-]{64}$/.test(token!)) fail('REMOTE_SECRET_UNAVAILABLE');
      result = await this.download(this.createTransport(), subscription, token!, abort.signal);
      abort.signal.throwIfAborted();
    } catch (error) {
      result = undefined;
      errorCode = abort.signal.aborted ? (parent.aborted ? 'REMOTE_ABORTED' : 'REMOTE_TIMEOUT') : constantError(error);
    } finally {
      clearTimeout(timeout);
      parent.removeEventListener('abort', abortParent);
    }
    try { return await this.persist(event, result, errorCode, parent); }
    catch (error) {
      if (error instanceof Error && error.message === 'REMOTE_STALE_CLAIM') throw error;
      // The import transaction rolled back completely. Record its bounded
      // failure through a fresh fenced transaction, preserving the old cache.
      return this.persist(event, undefined, parent.aborted ? 'REMOTE_ABORTED' : constantError(error), parent);
    }
  }

  private async download(
    transport: Transport, subscription: RemoteSubscription & { server: { baseUrl: string; serverId: string } },
    token: string, signal: AbortSignal,
  ): Promise<Result> {
    const baseUrl = subscription.server.baseUrl;
    const capabilities = await transport.get(baseUrl, '/api/federation/v1/capabilities', { maxBytes: FEDERATION_LIMITS.manifestBytes, signal });
    const parsedCapabilities = parseFederationCapabilities(this.json(capabilities, token));
    if (!parsedCapabilities.success) fail('REMOTE_PROTOCOL_MISMATCH');
    if (parsedCapabilities.data.serverId !== subscription.server.serverId) fail('REMOTE_IDENTITY_MISMATCH');
    const path = '/api/federation/v1/publications/' + subscription.remotePublicationId;
    let response = await transport.get(baseUrl, path, {
      token, ...(subscription.etag ? { etag: subscription.etag } : {}), maxBytes: FEDERATION_LIMITS.manifestBytes, signal,
    });
    if (response.status === 304) {
      if (!subscription.etag) fail('REMOTE_RESPONSE_INVALID');
      try {
        if (!subscription.latestLocalRevisionId || !subscription.feedHash || !subscription.remoteRevision || !subscription.remoteRevisionId) throw new Error();
        await this.importer.verifyCached(subscription);
        signal.throwIfAborted();
        return {
          etag: this.etag(response.etag ?? subscription.etag, token), feedHash: subscription.feedHash,
          remoteRevision: subscription.remoteRevision, remoteRevisionId: subscription.remoteRevisionId,
          cachedRevisionId: subscription.latestLocalRevisionId,
        };
      } catch {
        signal.throwIfAborted();
        response = await transport.get(baseUrl, path, { token, maxBytes: FEDERATION_LIMITS.manifestBytes, signal });
      }
    }
    const parsed = parseFederationPublicationFeed(this.json(response, token));
    if (!parsed.success) fail('REMOTE_PROTOCOL_MISMATCH');
    const feed = parsed.data;
    if (feed.serverId !== subscription.server.serverId) fail('REMOTE_IDENTITY_MISMATCH');
    if (feed.publicationId !== subscription.remotePublicationId) fail('REMOTE_PUBLICATION_MISMATCH');
    const feedHash = sha256(canonicalJson(feed));
    if (subscription.remoteRevision !== null && (feed.revision < subscription.remoteRevision
      || (feed.revision === subscription.remoteRevision && (feedHash !== subscription.feedHash || feed.publicationRevisionId !== subscription.remoteRevisionId)))) {
      fail('REMOTE_REVISION_CONFLICT');
    }
    const artifacts: Buffer[] = [];
    let total = 0;
    for (const artifact of feed.artifacts) {
      signal.throwIfAborted();
      const response = await transport.get(baseUrl, artifact.url, { token, maxBytes: FEDERATION_LIMITS.artifactBytes, signal });
      this.status(response.status);
      const bytes = response.bytes;
      total += bytes.length;
      if (bytes.length > FEDERATION_LIMITS.artifactBytes || total > FEDERATION_LIMITS.totalArtifactBytes) fail('REMOTE_RESPONSE_TOO_LARGE');
      if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) fail('REMOTE_HASH_MISMATCH');
      if (this.mime(response.contentType) !== artifact.mimeType || bytes.includes(Buffer.from(token))) fail('REMOTE_RESPONSE_INVALID');
      artifacts.push(Buffer.from(bytes));
    }
    signal.throwIfAborted();
    await this.importer.validateArtifacts(feed, artifacts);
    signal.throwIfAborted();
    return {
      feed, artifacts, feedHash, remoteRevision: feed.revision, remoteRevisionId: feed.publicationRevisionId,
      etag: this.etag(response.etag, token),
    };
  }

  private status(status: number) {
    if (status === 401 || status === 403) fail('REMOTE_UNAUTHORIZED');
    if (status !== 200) fail('REMOTE_RESPONSE_INVALID');
  }
  private mime(value: string | undefined | null): string { return (value ?? '').split(';')[0].trim().toLowerCase(); }
  private json(response: Awaited<ReturnType<Transport['get']>>, token: string): unknown {
    this.status(response.status);
    if (response.bytes.length > FEDERATION_LIMITS.manifestBytes) fail('REMOTE_RESPONSE_TOO_LARGE');
    if (this.mime(response.contentType) !== 'application/json' || response.bytes.includes(Buffer.from(token))) fail('REMOTE_RESPONSE_INVALID');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); }
    catch { return fail('REMOTE_RESPONSE_INVALID'); }
  }
  private etag(value: string | undefined | null, token: string): string | null {
    if (value === null || value === undefined) return null;
    if (value.length > 200 || !/^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value) || value.includes(token)) fail('REMOTE_RESPONSE_INVALID');
    return value;
  }

  private async persist(event: OutboxEvent, result: Result | undefined, errorCode: string | undefined, signal: AbortSignal, cancelled = false) {
    return sourceWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      const fence = () => ({ eventId: event.eventId, status: 'processing', claimToken: event.claimToken,
        claimOwner: event.claimOwner, claimUntil: { gt: new Date() } });
      if (!event.claimToken || !event.claimOwner || (await tx.outboxEvent.updateMany({ where: fence(), data: { claimToken: event.claimToken } })).count !== 1) throw new Error('REMOTE_STALE_CLAIM');
      const job = await tx.remoteSyncJob.findUniqueOrThrow({ where: { eventId: event.eventId }, include: { subscription: { include: { server: true } } } });
      const subscription = job.subscription, now = new Date();
      if (job.completedAt) return 'completed' as const;
      const obsolete = cancelled || !subscription.enabled || subscription.version !== job.subscriptionVersion;
      if (obsolete) {
        await this.complete(tx, event, now);
        return 'completed' as const;
      }
      if (result && signal.aborted) { result = undefined; errorCode = 'REMOTE_ABORTED'; }
      if (result && !subscription.server.trusted) { result = undefined; errorCode = 'REMOTE_ORIGIN_DENIED'; }
      if (result?.cachedRevisionId && (subscription.latestLocalRevisionId !== result.cachedRevisionId || subscription.feedHash !== result.feedHash
        || subscription.remoteRevision !== result.remoteRevision || subscription.remoteRevisionId !== result.remoteRevisionId)) {
        result = undefined; errorCode = 'REMOTE_CACHE_INVALID';
      }
      let imported: { publicationRevisionId: string; revision: number } | undefined;
      if (result?.feed && result.artifacts) {
        // Importer validates signatures/metadata and owns all cache/publication writes.
        // Any exception rolls the entire transaction back; no partial artifact can survive.
        imported = await this.importer.persist(tx, subscription, result.feed, result.artifacts);
      }
      const terminal = !result && (TERMINAL.has(errorCode ?? '') || event.attempts >= OUTBOX_POLICY.maxAttempts);
      const failures = result ? 0 : subscription.consecutiveFailures + 1;
      const circuitUntil = !result && failures >= REMOTE_LIMITS.circuitFailures ? new Date(now.getTime() + REMOTE_LIMITS.circuitCooldownMs) : null;
      await tx.remoteSubscription.update({ where: { subscriptionId: subscription.subscriptionId }, data: {
        lastAttemptAt: now, lastErrorCode: result ? null : errorCode ?? 'REMOTE_SYNC_FAILED',
        consecutiveFailures: failures, circuitOpenUntil: circuitUntil,
        nextSyncAt: new Date(Math.max(now.getTime() + subscription.refreshIntervalSeconds * 1000, circuitUntil?.getTime() ?? 0)),
        ...(result ? { lastSuccessAt: now, etag: result.etag, feedHash: result.feedHash,
          remoteRevision: result.remoteRevision, remoteRevisionId: result.remoteRevisionId,
          ...(imported ? { latestLocalRevisionId: imported.publicationRevisionId } : {}),
        } : {}),
      } });
      if (result || terminal) await this.complete(tx, event, now);
      if (!result) {
        if ((await tx.outboxEvent.updateMany({ where: fence(), data: {
          status: terminal ? 'dead-letter' : 'pending', claimOwner: null, claimToken: null, claimUntil: null,
          processedAt: terminal ? now : null,
          availableAt: new Date(Math.max(now.getTime() + queueRetryDelay('remote-sync', event.attempts), circuitUntil?.getTime() ?? 0)),
          lastError: JSON.stringify({ code: errorCode ?? 'REMOTE_SYNC_FAILED', ...outboxCorrelation(event) }),
        } })).count !== 1) throw new Error('REMOTE_STALE_CLAIM');
      } else {
        signal.throwIfAborted();
        if ((await tx.outboxEvent.updateMany({ where: fence(), data: { claimToken: event.claimToken } })).count !== 1) throw new Error('REMOTE_STALE_CLAIM');
        signal.throwIfAborted();
      }
      return result ? 'completed' as const : 'failed' as const;
    }, { timeout: 8_000 }));
  }

  private async complete(tx: import('@prisma/client').Prisma.TransactionClient, event: OutboxEvent, now: Date) {
    await tx.remoteSyncJob.update({ where: { eventId: event.eventId }, data: { completedAt: now } });
    await tx.outboxEffect.upsert({ where: { eventId: event.eventId }, update: {}, create: {
      key: sha256('remote:' + event.eventId), eventId: event.eventId, completedAt: now,
    } });
  }
}
