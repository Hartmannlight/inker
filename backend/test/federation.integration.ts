import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashToken, generateToken } from '../src/common/utils/crypto.util';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { canonicalJson, sha256 } from '../src/publications/publication-content';
import { PullDeviceAuthService } from '../src/device-platform/pull-device-auth.service';
import { FederationIdentityService } from '../src/federation/federation-identity.service';
import { ShareCredentialService, SHARE_LIMITS } from '../src/federation/share-credential.service';
import { FederationFeedService } from '../src/federation/federation-feed.service';

const root = resolve(import.meta.dir, '..');
const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });

describe('WP-26 persisted publication sharing', () => {
  let directory: string, url: string, publicationId: string, otherPublicationId: string;
  let p: PrismaClient, other: PrismaClient, shares: ShareCredentialService;
  let identity: FederationIdentityService, feeds: FederationFeedService, publisher: PublishService;
  let writes: string[], parameters: string[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-federation-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const migration = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(migration.stdout).text(), new Response(migration.stderr).text(), migration.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    other = new PrismaClient({ datasources: { db: { url } } });
    writes = []; parameters = [];
    p.$on('query' as never, (event: { query: string; params: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
      parameters.push(event.params);
    });
    await Promise.all([p.$connect(), other.$connect()]);
    await p.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await p.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await other.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await p.adminAccount.create({ data: { adminId: 'fixture-admin' } });
    publisher = new PublishService(p as PrismaService, new PublicationPersistenceService(p as PrismaService));
    publicationId = (await publish('shared')).publicationId;
    otherPublicationId = (await publish('other')).publicationId;
    shares = new ShareCredentialService(p as PrismaService);
    identity = new FederationIdentityService(p as PrismaService);
    feeds = new FederationFeedService(p as PrismaService, identity);
  }, 30_000);

  afterEach(async () => {
    await Promise.all([p?.$disconnect(), other?.$disconnect()]);
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-federation-'))
        throw new Error('Unsafe federation fixture cleanup path');
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function publish(key: string, expectedRevision = 0, artifact = 'mono-800x480-white-png') {
    return await publisher.publish(key, { idempotencyKey: randomUUID(), expectedRevision,
      deviceIds: [], draft: { fixtureArtifacts: [artifact] },
      allowedActions: [{ action: 'view.next', payloadSchemaVersion: '1.0' }],
    }) as { publicationId: string; publicationRevisionId: string; revision: number };
  }
  async function httpError(operation: Promise<unknown>, status: number, message?: string) {
    try { await operation; throw new Error('Expected HTTP error'); }
    catch (error) {
      expect((error as { getStatus(): number }).getStatus()).toBe(status);
      if (message) expect((error as Error).message).toBe(message);
      return error as Error;
    }
  }

  async function separateProcess() {
    const child = Bun.spawn([process.execPath, join(root, 'test/federation.fixture.ts')], {
      cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      child.stdin.write(JSON.stringify({ url, publicationId }));
      await child.stdin.flush();
      child.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      expect(stdout.length).toBeLessThan(1024);
      return JSON.parse(stdout) as { serverId: string; credentialId?: string; error?: string; status?: number };
    } finally { clearTimeout(timeout); child.kill(); }
  }

  test('creation exposes a high-entropy token only once and persists only its hash plus audit metadata', async () => {
    const created = await shares.create(publicationId, {}, 'fixture-admin');
    expect(created.credentialId).toMatch(/^[a-f0-9-]{36}$/);
    expect(created.publicationId).toBe(publicationId);
    expect(created.token).toMatch(/^sp_share_[A-Za-z0-9_-]{64}$/);
    expect(created.expiresAt).toBeNull();
    expect(created.revokedAt).toBeNull();
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    const row = await p.shareCredential.findUniqueOrThrow({ where: { credentialId: created.credentialId } });
    expect(row.tokenHash).toBe(sha256(`share:v1:${created.token}`));
    expect(row.tokenHash).not.toBe(hashToken(created.token));
    expect(row.createdByAdminId).toBe('fixture-admin');
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(parameters.join('\n')).not.toContain(created.token);
    const listed = await shares.list(publicationId);
    expect(listed.credentials).toHaveLength(1);
    expect(listed.truncated).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
    expect(await shares.authenticate(bearer(created.token), publicationId)).toEqual({
      credentialId: created.credentialId, publicationId,
    });
  });

  test('server identity is durable and concurrent clients converge on a single UUID', async () => {
    const peer = new FederationIdentityService(other as PrismaService);
    await Promise.all([identity.onModuleInit(), peer.onModuleInit()]);
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? identity : peer).serverId()));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await p.federationIdentity.count()).toBe(1);
    await other.$disconnect();
    other = new PrismaClient({ datasources: { db: { url } } });
    const restarted = new FederationIdentityService(other as PrismaService);
    await restarted.onModuleInit();
    expect(await restarted.serverId()).toBe(ids[0]);
    writes.length = 0;
    for (let i = 0; i < 20; i++) expect(await identity.serverId()).toBe(ids[0]);
    expect(writes).toEqual([]);
  });

  test('existing identity initializes with only reads while another client holds the SQLite writer lock', async () => {
    expect(await p.federationIdentity.findUnique({ where: { id: 1 } })).toBeNull();
    await identity.onModuleInit();
    const before = await p.federationIdentity.findUniqueOrThrow({ where: { id: 1 } });
    // A regression to empty upsert must fail promptly rather than waiting for
    // the held writer's transaction timeout. This changes only this test DB.
    await p.$queryRawUnsafe('PRAGMA busy_timeout = 200');
    const queries: string[] = [];
    p.$on('query' as never, (event: { query: string }) => { queries.push(event.query); });
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const writer = other.$transaction(async tx => {
      await tx.$executeRawUnsafe('UPDATE admin_accounts SET display_name = display_name WHERE admin_id = ?', 'fixture-admin');
      acquired();
      await held;
    }, { timeout: 5000, maxWait: 2000 });
    try {
      await Promise.race([ready, writer]);
      writes.length = 0; queries.length = 0;
      await identity.onModuleInit();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
      expect(queries.some(sql => /^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i.test(sql))).toBe(false);
      expect(writes).toEqual([]);
      expect(await p.federationIdentity.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
    } finally {
      release();
      await writer;
    }
  });

  test('scope, missing, malformed, legacy, device and revoked credentials have one constant authentication error', async () => {
    const created = await shares.create(publicationId, {}, 'fixture-admin');
    const deviceToken = generateToken(48);
    const device = await p.device.create({ data: { name: 'unrelated device', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    await p.deviceCredential.create({ data: { deviceId: device.id, tokenHash: hashToken(deviceToken) } });
    const invalid: IncomingHttpHeaders[] = [
      {}, { http_id: created.token }, { 'access-token': created.token },
      { authorization: '' }, { authorization: `Basic ${created.token}` },
      { authorization: `Bearer ${created.token}, Bearer ${created.token}` },
      { authorization: `Bearer ${'x'.repeat(4096)}` },
      bearer(`sp_share_${'x'.repeat(64)}`), bearer(deviceToken),
      { authorization: [created.token] as unknown as string },
    ];
    writes.length = 0;
    for (const headers of invalid) await httpError(shares.authenticate(headers, publicationId), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.authenticate(bearer(created.token), otherPublicationId), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.authenticate(bearer(created.token), randomUUID()), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.authenticate(bearer(created.token), '../drafts'), 401, 'SHARE_UNAUTHORIZED');
    await httpError(new PullDeviceAuthService(p as PrismaService).authenticate(bearer(created.token)), 401, 'Invalid device credentials');
    expect(writes).toEqual([]);
    const principal = await shares.authenticate(bearer(created.token), publicationId);
    await httpError(shares.revalidate({ ...principal, publicationId: otherPublicationId }), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.revoke(otherPublicationId, created.credentialId), 404, 'SHARE_NOT_FOUND');
    await shares.revalidate(principal);
    const revoked = await shares.revoke(publicationId, created.credentialId);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await shares.revoke(publicationId, created.credentialId)).toEqual(revoked);
    await httpError(shares.authenticate(bearer(created.token), publicationId), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.revalidate(principal), 401, 'SHARE_UNAUTHORIZED');
  });

  test('expiry is inclusive and a captured principal is rechecked after the clock boundary', async () => {
    const deadline = Date.now() + 60_000;
    const created = await shares.create(publicationId, { expiresAt: new Date(deadline).toISOString() }, 'fixture-admin');
    const clock = spyOn(Date, 'now').mockReturnValue(deadline - 1);
    try {
      const principal = await shares.authenticate(bearer(created.token), publicationId);
      await shares.revalidate(principal);
      clock.mockReturnValue(deadline);
      writes.length = 0;
      await httpError(shares.authenticate(bearer(created.token), publicationId), 401, 'SHARE_UNAUTHORIZED');
      await httpError(shares.revalidate(principal), 401, 'SHARE_UNAUTHORIZED');
      expect(writes).toEqual([]);
      const row = await p.shareCredential.findUniqueOrThrow({ where: { credentialId: created.credentialId } });
      expect(row.expiresAt!.getTime()).toBe(deadline);
      expect(row.revokedAt).toBeNull();
    } finally { clock.mockRestore(); }
  });

  test('credentials survive client restart and revoked state remains authoritative', async () => {
    const created = await shares.create(publicationId, { expiresAt: null }, 'fixture-admin');
    await other.$disconnect();
    other = new PrismaClient({ datasources: { db: { url } } });
    const restarted = new ShareCredentialService(other as PrismaService);
    const principal = await restarted.authenticate(bearer(created.token), publicationId);
    await shares.revoke(publicationId, created.credentialId);
    await httpError(restarted.revalidate(principal), 401, 'SHARE_UNAUTHORIZED');
    await httpError(restarted.authenticate(bearer(created.token), publicationId), 401, 'SHARE_UNAUTHORIZED');
    expect((await restarted.list(publicationId)).credentials[0].revokedAt).not.toBeNull();
  });

  test('input validation is closed, bounded and descriptor-safe before any SQL write', async () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'expiresAt', { enumerable: true, get: () => { reads++; return null; } });
    const invalid: unknown[] = [undefined, null, [], 'string', 1, true,
      { expiresAt: 1 }, { expiresAt: '2027-01-01T00:00:00Z' },
      { expiresAt: '2027-02-30T00:00:00.000Z' }, { expiresAt: '2020-01-01T00:00:00.000Z' },
      { expiresAt: '+010000-01-01T00:00:00.000Z' }, { scope: '*' },
      { token: 'caller-chosen-token' }, { expiresAt: 'x'.repeat(2048) }, getter,
    ];
    writes.length = 0;
    for (const body of invalid) await httpError(shares.create(publicationId, body, 'fixture-admin'), 400, 'INVALID_SHARE');
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
    expect(await p.shareCredential.count()).toBe(0);
    await httpError(shares.create(randomUUID(), {}, 'fixture-admin'), 404, 'PUBLICATION_NOT_FOUND');
    const draftOnly = await p.publication.create({ data: { publicationKey: 'no-published-revision' } });
    await httpError(shares.create(draftOnly.publicationId, {}, 'fixture-admin'), 404, 'PUBLICATION_NOT_FOUND');
    expect(await p.shareCredential.count()).toBe(0);
  });

  test('SQLite rejects scope/hash/expiry/revocation changes and preserves identity through repeated initialization', async () => {
    const created = await shares.create(publicationId, {}, 'fixture-admin');
    const where = { credentialId: created.credentialId };
    for (const data of [{ publicationId: otherPublicationId }, { tokenHash: 'a'.repeat(64) },
      { expiresAt: new Date(Date.now() + 60_000) }, { credentialId: randomUUID() }, { createdAt: new Date(0) }]) {
      await expect(Promise.resolve(p.shareCredential.update({ where, data }))).rejects.toThrow();
    }
    expect(await shares.authenticate(bearer(created.token), publicationId)).toMatchObject(where);
    await shares.revoke(publicationId, created.credentialId);
    await expect(Promise.resolve(p.shareCredential.update({ where, data: { revokedAt: null } }))).rejects.toThrow();
    await httpError(identity.serverId(), 503, 'FEDERATION_UNAVAILABLE');
    await identity.onModuleInit();
    const id = await identity.serverId();
    await identity.onModuleInit();
    await new FederationIdentityService(other as PrismaService).onModuleInit();
    expect(await identity.serverId()).toBe(id);
    await expect(Promise.resolve(p.federationIdentity.update({ where: { id: 1 }, data: { serverId: randomUUID() } }))).rejects.toThrow();
    await expect(Promise.resolve(p.federationIdentity.create({ data: { id: 2 } }))).rejects.toThrow();
    expect(await p.federationIdentity.count()).toBe(1);
  });

  test('two independent database clients cannot overrun the last publication quota slot', async () => {
    for (let i = 0; i < SHARE_LIMITS.perPublication - 1; i++) await shares.create(publicationId, {}, 'fixture-admin');
    const peer = new ShareCredentialService(other as PrismaService);
    const outcomes = await Promise.allSettled([
      shares.create(publicationId, {}, 'fixture-admin'), peer.create(publicationId, {}, 'fixture-admin'),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toBe('SHARE_LIMIT');
    expect(rejected.reason.getStatus()).toBe(409);
    expect(await p.shareCredential.count({ where: { publicationId, revokedAt: null } })).toBe(SHARE_LIMITS.perPublication);
    const first = await p.shareCredential.findFirstOrThrow({ where: { publicationId } });
    await shares.revoke(publicationId, first.credentialId);
    const replacement = await peer.create(publicationId, {}, 'fixture-admin');
    expect(replacement.credentialId).not.toBe(first.credentialId);
    expect(await p.shareCredential.count({ where: { publicationId, revokedAt: null } })).toBe(SHARE_LIMITS.perPublication);
  });

  test('global quota is shared across publications and excludes expired and revoked audit rows', async () => {
    const ids = [publicationId, otherPublicationId];
    for (let i = 0; i < 7; i++) ids.push((await publish(`quota-${i}`)).publicationId);
    const createdAt = new Date(Date.now() - 3600_000);
    for (let i = 0; i < SHARE_LIMITS.global; i++) await p.shareCredential.create({ data: {
      publicationId: ids[Math.floor(i / SHARE_LIMITS.perPublication)], tokenHash: sha256(`quota-${i}`), createdAt,
    } });
    await httpError(shares.create(ids[8], {}, 'fixture-admin'), 409, 'SHARE_LIMIT');
    const freed = await p.shareCredential.findFirstOrThrow();
    await shares.revoke(freed.publicationId, freed.credentialId);
    await p.shareCredential.create({ data: { publicationId: ids[8], tokenHash: sha256('expired'),
      createdAt, expiresAt: new Date(Date.now() - 1000) } });
    await shares.create(ids[8], {}, 'fixture-admin');
    await httpError(shares.create(ids[8], {}, 'fixture-admin'), 409, 'SHARE_LIMIT');
    expect(await p.shareCredential.count()).toBe(SHARE_LIMITS.global + 2);
  });

  test('two real processes converge on one server identity and exactly one remaining share slot', async () => {
    for (let i = 0; i < SHARE_LIMITS.perPublication - 1; i++) await shares.create(publicationId, {}, 'fixture-admin');
    const outcomes = await Promise.all([separateProcess(), separateProcess()]);
    expect(outcomes.filter(result => result.credentialId)).toHaveLength(1);
    expect(outcomes.find(result => result.error)).toMatchObject({ error: 'SHARE_LIMIT', status: 409 });
    expect(outcomes[0].serverId).toBe(outcomes[1].serverId);
    expect(await identity.serverId()).toBe(outcomes[0].serverId);
    expect(await p.federationIdentity.count()).toBe(1);
    expect(await p.shareCredential.count({ where: { publicationId } })).toBe(SHARE_LIMITS.perPublication);
  }, 30_000);

  test('audit listing is bounded and read-only; old terminal rows are cleaned only by creation', async () => {
    const now = Date.now(), recent = new Date(now - 1000);
    const stale = new Date(now - (SHARE_LIMITS.auditDays + 1) * 86400_000);
    const old = await p.shareCredential.create({ data: { publicationId,
      tokenHash: sha256('old-terminal'), createdAt: stale, revokedAt: stale } });
    for (let i = 0; i < SHARE_LIMITS.list + 1; i++) await p.shareCredential.create({ data: {
      publicationId, tokenHash: sha256(`audit-${i}`), createdAt: recent, revokedAt: recent,
    } });
    writes.length = 0;
    const listing = await shares.list(publicationId);
    expect(listing.credentials).toHaveLength(SHARE_LIMITS.list);
    expect(listing.truncated).toBe(true);
    expect(listing.credentials.some(row => row.credentialId === old.credentialId)).toBe(false);
    expect(await p.shareCredential.count()).toBe(SHARE_LIMITS.list + 2);
    expect(writes).toEqual([]);
    await shares.create(publicationId, {}, 'fixture-admin');
    expect(await p.shareCredential.findUnique({ where: { credentialId: old.credentialId } })).toBeNull();
    expect(await p.shareCredential.count()).toBe(SHARE_LIMITS.list + 2);
  });

  test('admin deletion retains share audit rows while publication deletion removes their access', async () => {
    const created = await shares.create(publicationId, {}, 'fixture-admin');
    const principal = await shares.authenticate(bearer(created.token), publicationId);
    await p.adminAccount.delete({ where: { adminId: 'fixture-admin' } });
    const row = await p.shareCredential.findUniqueOrThrow({ where: { credentialId: created.credentialId } });
    expect(row.createdByAdminId).toBeNull();
    await shares.revalidate(principal);
    await p.publication.delete({ where: { publicationId } });
    expect(await p.shareCredential.count()).toBe(0);
    await httpError(shares.authenticate(bearer(created.token), publicationId), 401, 'SHARE_UNAUTHORIZED');
    await httpError(shares.revalidate(principal), 401, 'SHARE_UNAUTHORIZED');
  });

  test('database failures are sanitized and a failed insert leaves no credential behind', async () => {
    await p.$executeRawUnsafe("CREATE TRIGGER federation_test_insert_failure BEFORE INSERT ON share_credentials BEGIN SELECT RAISE(ABORT, 'private-database-marker'); END");
    const error = await httpError(shares.create(publicationId, {}, 'fixture-admin'), 503, 'FEDERATION_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('private-database-marker');
    expect(await p.shareCredential.count()).toBe(0);
    await p.$executeRawUnsafe('DROP TRIGGER federation_test_insert_failure');
    expect((await shares.create(publicationId, {}, 'fixture-admin')).token).toMatch(/^sp_share_/);
  });

  test('feed and artifact reads remain immutable, omit local commands and perform no SQL writes', async () => {
    await identity.onModuleInit();
    const initial = await feeds.read(publicationId);
    const capabilities = await feeds.capabilities();
    expect(capabilities.body.serverId).toBe(initial.body.serverId);
    expect(capabilities.body.readOnly).toBe(true);
    expect(initial.body.revision).toBe(1);
    expect(initial.body.artifacts).toHaveLength(1);
    const json = JSON.stringify(initial.body);
    for (const excluded of ['allowedActions', 'view.next', 'sourceSnapshot', 'timerState', 'deviceId', 'tokenHash'])
      expect(json).not.toContain(excluded);
    const artifact = initial.body.artifacts[0];
    const bytes = await feeds.artifact(publicationId, '1', artifact.sha256);
    expect(sha256(bytes.bytes)).toBe(artifact.sha256);
    expect(bytes.bytes.length).toBe(artifact.sizeBytes);
    expect(bytes.etag).toBe(`"${artifact.sha256}"`);
    writes.length = 0;
    for (let i = 0; i < 25; i++) {
      expect(await feeds.read(publicationId)).toEqual(initial);
      expect(await feeds.capabilities()).toEqual(capabilities);
      expect(await feeds.artifact(publicationId, '1', artifact.sha256)).toEqual(bytes);
    }
    expect(writes).toEqual([]);
    await publish('shared', 1, 'mono-800x480-black-bmp');
    const changed = await feeds.read(publicationId);
    expect(changed.body.revision).toBe(2);
    expect(changed.etag).not.toBe(initial.etag);
    expect(changed.body.serverId).toBe(initial.body.serverId);
    expect(await feeds.artifact(publicationId, '1', artifact.sha256)).toEqual(bytes);
    await httpError(feeds.artifact(publicationId, '2', artifact.sha256), 404);
  });

  test('publication integrity failure cannot expose a draft or arbitrary snapshot metadata', async () => {
    await identity.onModuleInit();
    const persistence = new PublicationPersistenceService(p as PrismaService);
    const content = { schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-png'],
      sourceSnapshot: { secret: 'private-provider-data' }, settings: { token: 'never-share' } };
    await persistence.appendRevision({ publicationId, protocolVersion: '1.0',
      content, contentHash: sha256(canonicalJson(content)) });
    const valid = await feeds.read(publicationId);
    expect(JSON.stringify(valid.body)).not.toContain('private-provider-data');
    expect(JSON.stringify(valid.body)).not.toContain('never-share');
    await persistence.appendRevision({ publicationId, protocolVersion: '1.0', content, contentHash: '0'.repeat(64) });
    writes.length = 0;
    await httpError(feeds.read(publicationId), 503, 'FEDERATION_PUBLICATION_UNAVAILABLE');
    await httpError(feeds.artifact(publicationId, '3', valid.body.artifacts[0].sha256), 503, 'FEDERATION_PUBLICATION_UNAVAILABLE');
    expect(writes).toEqual([]);
  });
});
