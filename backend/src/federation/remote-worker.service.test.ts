import { describe, expect, mock, test } from 'bun:test';
import type { OutboxEvent, Prisma, RemoteSubscription } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { OutboxStore } from '../events/outbox.store';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { RemoteWorkerService } from './remote-worker.service';
import type { RemoteImportService } from './remote-import.service';
import type { RemoteTransport } from './remote-transport';
import { REMOTE_SYNC } from './remote-job';
import type { EncryptionService } from '../common/services/encryption.service';

const SERVER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = 'sp_share_' + 'a'.repeat(64);
const PNG = PULL_FIXTURE_ARTIFACTS.find(value => value.format === 'png')!;
const feed = () => ({
  protocolVersion: '1.0', serverId: SERVER, publicationId: 'publication-one',
  publicationRevisionId: 'remote-revision-one', revision: 1, publishedAt: '2026-08-28T12:00:00.000Z',
  artifacts: [{
    artifactId: PNG.sha256, sha256: PNG.sha256, mimeType: 'image/png', format: 'png',
    width: PNG.width, height: PNG.height, colorSpace: PNG.colorSpace, bitDepth: PNG.bitDepth, rotation: PNG.rotation,
    sizeBytes: PNG.bytes.length, url: '/api/federation/v1/publications/publication-one/revisions/1/artifacts/' + PNG.sha256,
  }],
});
const capabilities = {
  protocolVersion: '1.0', serverId: SERVER, readOnly: true,
  features: ['publication-feed', 'immutable-artifacts'],
  limits: { manifestBytes: 65536, artifactBytes: 2097152, artifacts: 8 },
};
const json = (body: unknown, status = 200) => ({
  status, etag: '"etag-one"', contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body)),
});

function setup() {
  const now = new Date();
  const subscription = {
    subscriptionId: 'subscription-one', version: 1, name: 'Test', remoteServerId: 'remote-one', remotePublicationId: 'publication-one',
    credentialId: 'credential-one', localPublicationId: 'local-one', enabled: true, nextSyncAt: now,
    refreshIntervalSeconds: 60, lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null,
    consecutiveFailures: 0, circuitOpenUntil: null, etag: null, remoteRevision: null, remoteRevisionId: null,
    feedHash: null, latestLocalRevisionId: null, createdAt: now, updatedAt: now,
    server: { baseUrl: 'https://remote.example', serverId: SERVER, trusted: true },
    credential: { ciphertext: 'encrypted-only' },
  } as RemoteSubscription & { server: { baseUrl: string; serverId: string; trusted: boolean }; credential: { ciphertext: string } };
  const event = {
    eventId: 'remote-event-one', eventType: REMOTE_SYNC, aggregateType: 'RemoteSubscription', aggregateId: 'subscription-one',
    aggregateRevision: '1', payloadVersion: 1, payload: { subscriptionId: 'subscription-one', subscriptionVersion: 1, scheduledAt: now.getTime() },
    attempts: 1, status: 'processing', claimToken: 'claim-one', claimOwner: 'worker-one', claimUntil: new Date(now.getTime() + 30_000),
    createdAt: now, availableAt: now, occurredAt: now, lastAttemptAt: now, processedAt: null, lastError: null, correlationId: null,
  } as OutboxEvent;
  const job = {
    eventId: event.eventId, subscriptionId: subscription.subscriptionId, subscriptionVersion: 1,
    remoteServerId: subscription.remoteServerId,
    scheduledAt: now, completedAt: null as Date | null, subscription,
  };
  const updates: Prisma.RemoteSubscriptionUpdateArgs[] = [];
  const outboxUpdates: Prisma.OutboxEventUpdateManyArgs[] = [];
  const updateMany = mock(async (args: Prisma.OutboxEventUpdateManyArgs) => { outboxUpdates.push(args); return { count: 1 }; });
  const effect = mock(async (_args: unknown) => ({}));
  const complete = mock(async (_args: unknown) => ({}));
  const tx = {
    remoteSyncJob: { findUniqueOrThrow: mock(async () => job), update: complete },
    outboxEvent: { updateMany }, outboxEffect: { upsert: effect },
    remoteSubscription: { update: mock(async (args: Prisma.RemoteSubscriptionUpdateArgs) => { updates.push(args); return subscription; }) },
  };
  const findJob = mock(async (_args: unknown) => job);
  const prisma = {
    remoteSyncJob: { findUnique: findJob, findMany: mock(async () => [{ eventId: event.eventId, remoteServerId: 'remote-one', subscriptionId: 'subscription-one' }]) },
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
  };
  const current = mock(async (_event: unknown): Promise<OutboxEvent | null> => event);
  const claim = mock(async (_owner: string, _now: Date, _filter: unknown, _budget: unknown, _leaseNow?: Date) => event);
  const importer = {
    persist: mock(async (_tx: unknown, _subscription: unknown, _feed: unknown, _artifacts: Buffer[]) => ({ publicationRevisionId: 'local-revision-one', revision: 1 })),
    verifyCached: mock(async (_subscription: unknown) => {}),
    validateArtifacts: mock(async (_feed: unknown, _artifacts: Buffer[]) => {}),
  };
  const transport = {
    get: mock(async (_base: string, path: string, _options: unknown) => {
      if (path.endsWith('/capabilities')) return json(capabilities);
      if (path.includes('/artifacts/')) return { status: 200, etag: '"artifact"', contentType: 'image/png', bytes: PNG.bytes };
      return json(feed());
    }),
  };
  let decrypted = 0, unavailableSecret = false, createdTransport = 0;
  class Worker extends RemoteWorkerService {
    protected override createTransport(): RemoteTransport { createdTransport++; return transport as unknown as RemoteTransport; }
    protected override decrypt(_ciphertext: string): string {
      decrypted++;
      if (unavailableSecret) throw new Error('DO-NOT-EXPOSE-SECRET');
      return TOKEN;
    }
  }
  const worker = new Worker(
    prisma as unknown as PrismaService,
    { current, claim } as unknown as OutboxStore,
    importer as unknown as RemoteImportService,
    {} as EncryptionService,
  );
  return {
    worker, event, job, subscription, updates, outboxUpdates, updateMany, complete, effect, current, claim, importer, transport,
    decrypted: () => decrypted, createdTransport: () => createdTransport, failSecret: () => { unavailableSecret = true; },
  };
}
const run = (h: ReturnType<typeof setup>, signal = new AbortController().signal) => h.worker.execute(h.event, signal);
const lastUpdate = (h: ReturnType<typeof setup>) => h.updates.at(-1)!.data;

describe('RemoteWorkerService', () => {
  test('success fetches bounded capabilities/feed/artifact and imports only through the transaction', async () => {
    const h = setup();
    expect(await run(h)).toBe('completed');
    expect(h.decrypted()).toBe(1);
    expect(h.createdTransport()).toBe(1);
    expect(h.transport.get).toHaveBeenCalledTimes(3);
    expect(h.transport.get.mock.calls[0][2]).toMatchObject({ maxBytes: 65536 });
    expect(h.transport.get.mock.calls[0][2]).not.toHaveProperty('token');
    expect(h.transport.get.mock.calls[1][2]).toMatchObject({ maxBytes: 65536, token: TOKEN });
    expect(h.transport.get.mock.calls[2][2]).toMatchObject({ maxBytes: 2097152, token: TOKEN });
    expect(h.importer.validateArtifacts).toHaveBeenCalledTimes(1);
    expect(h.importer.persist).toHaveBeenCalledTimes(1);
    expect(h.importer.persist.mock.calls[0][3]).toEqual([PNG.bytes]);
    expect(lastUpdate(h)).toMatchObject({ lastErrorCode: null, remoteRevision: 1, latestLocalRevisionId: 'local-revision-one', consecutiveFailures: 0 });
    expect(JSON.stringify(h.updates)).not.toContain(TOKEN);
    expect(h.effect).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  test('claim budgets cover two jobs globally and one per remote/subscription', async () => {
    const h = setup(), now = new Date(), before = Date.now();
    expect(await h.worker.claim('owner', now)).toBe(h.event);
    const after = Date.now();
    expect(h.claim).toHaveBeenCalledWith('owner', now, { eventId: h.event.eventId }, {
      where: { eventType: REMOTE_SYNC }, limit: 2, additional: [
        { where: { eventType: REMOTE_SYNC, remoteSync: { remoteServerId: 'remote-one' } }, limit: 1 },
        { where: { eventType: REMOTE_SYNC, aggregateId: 'subscription-one' }, limit: 1 },
      ],
    }, expect.any(Date));
    const leaseNow = h.claim.mock.calls[0][4] as Date;
    expect(leaseNow.getTime()).toBeGreaterThanOrEqual(before);
    expect(leaseNow.getTime()).toBeLessThanOrEqual(after);
    expect(leaseNow).not.toBe(now);
  });

  test('obsolete, disabled, completed and stale claims cannot decrypt or fetch', async () => {
    for (const mode of ['obsolete', 'disabled', 'completed', 'stale']) {
      const h = setup();
      if (mode === 'obsolete') h.subscription.version = 2;
      if (mode === 'disabled') h.subscription.enabled = false;
      if (mode === 'completed') h.job.completedAt = new Date();
      if (mode === 'stale') h.current.mockResolvedValue(null);
      if (mode === 'stale') await expect(run(h)).rejects.toThrow('REMOTE_STALE_CLAIM');
      else expect(await run(h)).toBe('completed');
      expect(h.decrypted()).toBe(0);
      expect(h.transport.get).not.toHaveBeenCalled();
      expect(h.importer.persist).not.toHaveBeenCalled();
    }
  });

  test('invalid durable payload fails before fetching', async () => {
    const h = setup();
    h.event.payload = { ...h.event.payload as object, secret: TOKEN };
    await expect(run(h)).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    expect(h.decrypted()).toBe(0);
  });

  test('tampered remote concurrency identity fails before fetching', async () => {
    const h = setup();
    h.job.remoteServerId = 'other-remote';
    await expect(run(h)).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
    expect(h.decrypted()).toBe(0);
  });

  test.each(['REMOTE_UNAUTHORIZED', 'REMOTE_IDENTITY_MISMATCH', 'REMOTE_PROTOCOL_MISMATCH', 'REMOTE_ORIGIN_DENIED'])('terminal %s preserves cache and completes the effect', async code => {
    const h = setup();
    h.subscription.latestLocalRevisionId = 'last-good';
    h.transport.get.mockRejectedValue(new Error(code));
    expect(await run(h)).toBe('failed');
    expect(lastUpdate(h).lastErrorCode).toBe(code);
    expect(lastUpdate(h)).not.toHaveProperty('latestLocalRevisionId');
    expect(lastUpdate(h)).not.toHaveProperty('etag');
    expect(h.outboxUpdates.at(-1)!.data.status).toBe('dead-letter');
    expect(h.effect).toHaveBeenCalledTimes(1);
    expect(h.importer.persist).not.toHaveBeenCalled();
  });

  test('malformed secret and untrusted server never create a transport', async () => {
    for (const code of ['REMOTE_SECRET_UNAVAILABLE', 'REMOTE_ORIGIN_DENIED']) {
      const h = setup();
      if (code === 'REMOTE_SECRET_UNAVAILABLE') h.failSecret();
      else h.subscription.server.trusted = false;
      expect(await run(h)).toBe('failed');
      expect(lastUpdate(h).lastErrorCode).toBe(code);
      expect(h.createdTransport()).toBe(0);
    }
  });

  test('unknown transport diagnostics are reduced to a constant retryable error', async () => {
    const h = setup();
    h.transport.get.mockRejectedValue(new Error('URL https://private/' + TOKEN));
    expect(await run(h)).toBe('failed');
    expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_SYNC_FAILED');
    expect(h.outboxUpdates.at(-1)!.data.status).toBe('pending');
    expect(JSON.stringify(h.outboxUpdates)).not.toContain(TOKEN);
    expect(h.effect).not.toHaveBeenCalled();
  });

  test('third transient failure opens a circuit; fifth attempt is terminal', async () => {
    const h = setup();
    h.subscription.consecutiveFailures = 2;
    h.transport.get.mockRejectedValue(new Error('REMOTE_DNS_FAILED'));
    const before = Date.now();
    expect(await run(h)).toBe('failed');
    expect((lastUpdate(h).circuitOpenUntil as Date).getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(h.outboxUpdates.at(-1)!.data.availableAt).toEqual(lastUpdate(h).circuitOpenUntil as Date);
    h.event.attempts = 5;
    expect(await run(h)).toBe('failed');
    expect(h.outboxUpdates.at(-1)!.data.status).toBe('dead-letter');
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  test('304 verifies a complete cached revision without artifact fetch or import', async () => {
    const h = setup();
    Object.assign(h.subscription, { etag: '"cached"', latestLocalRevisionId: 'cached-local',
      remoteRevision: 1, remoteRevisionId: 'remote-revision-one', feedHash: sha256(canonicalJson(feed())) });
    h.transport.get.mockImplementation(async (_base, path) => path.endsWith('/capabilities') ? json(capabilities) : json({}, 304));
    expect(await run(h)).toBe('completed');
    expect(h.importer.verifyCached).toHaveBeenCalledWith(h.subscription);
    expect(h.transport.get).toHaveBeenCalledTimes(2);
    expect(h.importer.persist).not.toHaveBeenCalled();
    expect(lastUpdate(h)).not.toHaveProperty('latestLocalRevisionId');
    expect(lastUpdate(h).lastErrorCode).toBeNull();
  });

  test('304 with corrupt/missing cache refetches once without If-None-Match', async () => {
    const h = setup();
    h.subscription.etag = '"cached"';
    let feeds = 0;
    h.transport.get.mockImplementation(async (_base, path) => {
      if (path.endsWith('/capabilities')) return json(capabilities);
      if (path.includes('/artifacts/')) return { status: 200, etag: '"a"', contentType: 'image/png', bytes: PNG.bytes };
      return ++feeds === 1 ? json({}, 304) : json(feed());
    });
    expect(await run(h)).toBe('completed');
    expect(h.transport.get).toHaveBeenCalledTimes(4);
    expect(h.transport.get.mock.calls[1][2]).toHaveProperty('etag', '"cached"');
    expect(h.transport.get.mock.calls[2][2]).not.toHaveProperty('etag');
    expect(h.importer.persist).toHaveBeenCalledTimes(1);
  });

  test.each(['identity', 'publication', 'protocol', 'backwards', 'same-version-different-hash'])('invalid feed %s cannot replace a last-good revision', async mode => {
    const h = setup(), value = feed();
    if (mode === 'identity') value.serverId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    if (mode === 'publication') value.publicationId = 'another-publication';
    if (mode === 'protocol') value.protocolVersion = '2.0';
    if (mode === 'backwards') h.subscription.remoteRevision = 2;
    if (mode === 'same-version-different-hash') { h.subscription.remoteRevision = 1; h.subscription.feedHash = '0'.repeat(64); }
    h.transport.get.mockImplementation(async (_base, path) => json(path.endsWith('/capabilities') ? capabilities : value));
    expect(await run(h)).toBe('failed');
    expect(h.importer.persist).not.toHaveBeenCalled();
    expect(lastUpdate(h)).not.toHaveProperty('latestLocalRevisionId');
  });

  test('corrupt artifact or metadata validation failure preserves cache', async () => {
    for (const metadata of [false, true]) {
      const h = setup();
      if (metadata) h.importer.validateArtifacts.mockRejectedValue(new Error('REMOTE_RESPONSE_INVALID'));
      else h.transport.get.mockImplementation(async (_base, path) => {
        if (path.endsWith('/capabilities')) return json(capabilities);
        if (path.includes('/artifacts/')) return { status: 200, etag: '"a"', contentType: 'image/png', bytes: Buffer.from('bad') };
        return json(feed());
      });
      expect(await run(h)).toBe('failed');
      expect(lastUpdate(h).lastErrorCode).toBe(metadata ? 'REMOTE_RESPONSE_INVALID' : 'REMOTE_HASH_MISMATCH');
      expect(h.importer.persist).not.toHaveBeenCalled();
    }
  });

  test('version edit during download fences the completed response', async () => {
    const h = setup();
    h.importer.validateArtifacts.mockImplementation(async () => { h.subscription.version = 2; });
    expect(await run(h)).toBe('completed');
    expect(h.importer.persist).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  test('trust revoked during download denies an otherwise valid import', async () => {
    const h = setup();
    h.importer.validateArtifacts.mockImplementation(async () => { h.subscription.server.trusted = false; });
    expect(await run(h)).toBe('failed');
    expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_ORIGIN_DENIED');
    expect(h.importer.persist).not.toHaveBeenCalled();
  });

  test.each(['token-body', 'invalid-json', 'invalid-utf8', 'oversized', 'wrong-mime', 'token-etag', 'oversized-etag'])('untrusted response %s never reaches publication writes', async mode => {
    const h = setup();
    h.transport.get.mockImplementation(async (_base, path) => {
      if (path.endsWith('/capabilities')) return json(capabilities);
      if (path.includes('/artifacts/')) return { status: 200, etag: '"artifact"', contentType: 'image/png', bytes: PNG.bytes };
      const response = json(feed());
      if (mode === 'token-body') response.bytes = Buffer.from(TOKEN);
      if (mode === 'invalid-json') response.bytes = Buffer.from('{invalid');
      if (mode === 'invalid-utf8') response.bytes = Buffer.from([0xff]);
      if (mode === 'oversized') response.bytes = Buffer.alloc(65537);
      if (mode === 'wrong-mime') response.contentType = 'text/html';
      if (mode === 'token-etag') response.etag = '"' + TOKEN + '"';
      if (mode === 'oversized-etag') response.etag = '"' + 'a'.repeat(199) + '"';
      return response;
    });
    expect(await run(h)).toBe('failed');
    expect(h.importer.persist).not.toHaveBeenCalled();
    expect(lastUpdate(h).lastErrorCode).toBe(mode === 'oversized' ? 'REMOTE_RESPONSE_TOO_LARGE' : 'REMOTE_RESPONSE_INVALID');
    expect(JSON.stringify(h.updates)).not.toContain(TOKEN);
    expect(JSON.stringify(h.outboxUpdates)).not.toContain(TOKEN);
  });

  test('HTTP 401 is terminal and no upstream error body is persisted', async () => {
    const h = setup();
    h.transport.get.mockImplementation(async (_base, path) => path.endsWith('/capabilities') ? json(capabilities) : json({ secret: TOKEN }, 401));
    expect(await run(h)).toBe('failed');
    expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_UNAUTHORIZED');
    expect(h.outboxUpdates.at(-1)!.data.status).toBe('dead-letter');
    expect(JSON.stringify(h.outboxUpdates)).not.toContain(TOKEN);
  });

  test('stalled requests share a real 15 second total abort deadline', async () => {
    const h = setup(), started = Date.now();
    h.transport.get.mockImplementation((_base, _path, options) => new Promise((_resolve, reject) => {
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener('abort', () => reject(new Error('REMOTE_ABORTED')), { once: true });
    }));
    expect(await run(h)).toBe('failed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_500);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_TIMEOUT');
    expect(h.importer.persist).not.toHaveBeenCalled();
  }, 22_000);

  test('abort before request and after validation cannot commit success', async () => {
    for (const late of [false, true]) {
      const h = setup(), controller = new AbortController();
      if (late) h.importer.validateArtifacts.mockImplementation(async () => { controller.abort(); });
      else controller.abort();
      expect(await run(h, controller.signal)).toBe('failed');
      expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_ABORTED');
      expect(h.importer.persist).not.toHaveBeenCalled();
      if (!late) expect(h.createdTransport()).toBe(0);
    }
  });

  test('lost transaction claim cannot write or import', async () => {
    const h = setup();
    h.updateMany.mockResolvedValue({ count: 0 });
    await expect(run(h)).rejects.toThrow('REMOTE_STALE_CLAIM');
    expect(h.updates).toHaveLength(0);
    expect(h.importer.persist).not.toHaveBeenCalled();
  });

  test('import failure is persisted after the rolled-back import attempt', async () => {
    const h = setup();
    h.importer.persist.mockRejectedValue(new Error('REMOTE_REVISION_CONFLICT'));
    expect(await run(h)).toBe('failed');
    expect(lastUpdate(h).lastErrorCode).toBe('REMOTE_REVISION_CONFLICT');
    expect(lastUpdate(h)).not.toHaveProperty('latestLocalRevisionId');
    expect(h.importer.persist).toHaveBeenCalledTimes(1);
  });
});
