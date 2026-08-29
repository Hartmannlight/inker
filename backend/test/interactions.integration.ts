import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import type { CommandResult, InteractionEvent, AllowedAction } from '@inker/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateToken, hashToken } from '../src/common/utils/crypto.util';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { PlaybackService } from '../src/playback/playback.service';
import { PLAYBACK_CHANGED } from '../src/playback/playback.events';
import { ArtifactStore } from '../src/render-cache/artifact-store';
import { RenderCacheService, RENDER_REQUESTED } from '../src/render-cache/render-cache.service';
import { OutboxStore } from '../src/events/outbox.store';
import { InteractionService } from '../src/interactions/interaction.service';
import { CommandRegistry } from '../src/interactions/command-registry';
import { ViewNextHandler } from '../src/interactions/view-next.handler';

const root = resolve(import.meta.dir, '..');
const actions: AllowedAction[] = [{ action: 'view.next', payloadSchemaVersion: '1.0' }];

describe('WP-23 authenticated persistent interactions', () => {
  let directory: string, url: string, previousCachePath: string | undefined;
  let p: PrismaClient, playback: PlaybackService, publisher: PublishService;
  let cache: RenderCacheService, service: InteractionService, outbox: OutboxStore;
  let now: number, deviceId: number, warmDeviceId: number, externalId: string;
  let credentialId: string, token: string, headers: IncomingHttpHeaders, writes: string[];

  function instance(client = p) {
    const persistence = new PublicationPersistenceService(client as PrismaService);
    const player = new PlaybackService(client as PrismaService, persistence, { now: () => now });
    return new InteractionService(client as PrismaService,
      new CommandRegistry([new ViewNextHandler(player)]),
      new RenderCacheService(client as PrismaService, new ArtifactStore()), { now: () => now });
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-interactions-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    previousCachePath = process.env.INKER_RENDER_CACHE_PATH;
    process.env.INKER_RENDER_CACHE_PATH = join(directory, 'artifacts');
    const child = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stdout + stderr).toBe(0);
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    writes = [];
    p.$on('query' as never, (event: { query: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
    });
    await p.$connect();
    now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    const persistence = new PublicationPersistenceService(p as PrismaService);
    playback = new PlaybackService(p as PrismaService, persistence, { now: () => now });
    publisher = new PublishService(p as PrismaService, persistence);
    cache = new RenderCacheService(p as PrismaService, new ArtifactStore());
    outbox = new OutboxStore(p as PrismaService);
    externalId = randomUUID();
    const device = await p.device.create({ data: {
      name: 'interaction target', externalId, apiKey: 'legacy-fixture-key',
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser',
    } });
    deviceId = device.id;
    warmDeviceId = (await p.device.create({ data: {
      name: 'render fixture', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser',
    } })).id;
    token = generateToken(48);
    credentialId = (await p.deviceCredential.create({ data: { deviceId, tokenHash: hashToken(token) } })).credentialId;
    headers = { authorization: `Bearer ${token}` };
    const revisions = [await publication(actions), await publication(actions)];
    const playlist = await p.playlist.create({ data: { name: 'interaction playlist', items: {
      create: [{ order: 0, duration: null }, { order: 1, duration: null }],
    } }, include: { items: { orderBy: { order: 'asc' } } } });
    const release = await playback.publish(playlist.id, {
      version: 1, idempotencyKey: randomUUID(), expectedRevision: 0,
      expectedDraftHash: (await playback.draft(playlist.id)).draftHash,
      bindings: playlist.items.map((item, index) => ({ itemId: item.id, publicationRevisionId: revisions[index] })),
    }) as { playlistRevisionId: string };
    await playback.execute(deviceId, { version: 1, idempotencyKey: randomUUID(), action: 'start',
      expectedVersion: 0, expectedDesiredSequence: 0, playlistRevisionId: release.playlistRevisionId });
    await cache.request(deviceId);
    service = instance();
  }, 30_000);

  afterEach(async () => {
    await p?.$disconnect();
    if (previousCachePath === undefined) delete process.env.INKER_RENDER_CACHE_PATH;
    else process.env.INKER_RENDER_CACHE_PATH = previousCachePath;
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-interactions-'))
        throw new Error('Unsafe interaction fixture cleanup path');
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function publication(allowedActions: AllowedAction[], render = true) {
    const result = await publisher.publish(randomUUID(), {
      idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [warmDeviceId], allowedActions,
      draft: { fixtureArtifacts: ['mono-800x480-white-png'] },
    }) as { publicationRevisionId: string };
    if (render) {
      const key = await cache.request(warmDeviceId);
      const event = await outbox.claim('interaction-render-fixture', new Date(), {
        eventType: RENDER_REQUESTED, aggregateId: key,
      });
      expect(event).not.toBeNull();
      await cache.render(event!);
      expect(await outbox.ack(event!)).toBe(true);
    }
    return result.publicationRevisionId;
  }

  async function target() {
    return p.device.findUniqueOrThrow({ where: { id: deviceId }, include: {
      profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
    } });
  }

  async function event(patch: Partial<InteractionEvent> = {}): Promise<InteractionEvent> {
    const device = await target();
    const state = await p.playbackState.findUniqueOrThrow({ where: { deviceId } });
    const desired = device.publicationState!.desiredRevision!;
    return { protocolVersion: '1.0', eventId: randomUUID(), deviceId: externalId, credentialId,
      publicationId: desired.publicationId, revision: String(desired.revision), action: 'view.next',
      occurredAt: new Date(now).toISOString(), payload: { version: 1,
        expectedPlaybackVersion: state.version, expectedDesiredSequence: device.publicationState!.desiredSequence },
      ...patch };
  }

  async function business() {
    return { playback: await p.playbackState.findUnique({ where: { deviceId } }),
      device: await p.device.findUnique({ where: { id: deviceId } }),
      desired: await p.devicePublicationState.findUnique({ where: { deviceId } }),
      outbox: await p.outboxEvent.findMany({ orderBy: { eventId: 'asc' } }),
      playbackReceipts: await p.playbackCommand.findMany({ orderBy: { keyHash: 'asc' } }) };
  }

  async function rejected(input: InteractionEvent, code?: string, auth = headers) {
    const before = await business();
    const result = await service.execute(auth, input);
    expect(result.status).toBe('rejected');
    expect(result.error?.code).toBeTruthy();
    if (code) expect(result.error?.code).toBe(code);
    expect(await business()).toEqual(before);
    return result;
  }

  async function httpError(operation: Promise<unknown>, status: number, message: string) {
    try { await operation; throw new Error('Expected HTTP error'); }
    catch (error) {
      expect(error).toMatchObject({ message });
      expect((error as { getStatus(): number }).getStatus()).toBe(status);
    }
  }

  async function usePublication(allowedActions: AllowedAction[], render = true) {
    const revisionId = await publication(allowedActions, render);
    const playlist = await p.playlist.create({ data: { name: 'alternate interaction playlist', items: {
      create: [{ order: 0, duration: null }, { order: 1, duration: null }],
    } }, include: { items: { orderBy: { order: 'asc' } } } });
    const release = await playback.publish(playlist.id, {
      version: 1, idempotencyKey: randomUUID(), expectedRevision: 0,
      expectedDraftHash: (await playback.draft(playlist.id)).draftHash,
      bindings: playlist.items.map(item => ({ itemId: item.id, publicationRevisionId: revisionId })),
    }) as { playlistRevisionId: string };
    const input = await event();
    await playback.execute(deviceId, { version: 1, idempotencyKey: randomUUID(), action: 'change',
      expectedVersion: input.payload.expectedPlaybackVersion, expectedDesiredSequence: input.payload.expectedDesiredSequence,
      playlistRevisionId: release.playlistRevisionId });
    await cache.request(deviceId);
  }

  test('actual cached pixels authorize one atomic playback, desired pointer, receipt and outbox change', async () => {
    const device = await target();
    const rendered = await cache.read(device, device.publicationState!.desiredRevision!);
    expect(rendered?.fallback).toBe(false);
    const pixels = await sharp(rendered!.artifact.bytes).metadata();
    expect(pixels).toMatchObject({ format: 'png', width: 1920, height: 1080 });
    const raw = await sharp(rendered!.artifact.bytes).removeAlpha().raw().toBuffer();
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([255, 255, 255]));
    const before = await business(), input = await event();
    const result = await service.execute(headers, input);
    expect(result.status).toBe('accepted');
    const after = await business();
    expect(after.playback!.version).toBe(before.playback!.version + 1);
    expect(after.playback!.currentItemId).not.toBe(before.playback!.currentItemId);
    expect(after.desired!.desiredSequence).toBe(before.desired!.desiredSequence + 1);
    expect(after.desired!.desiredPublicationRevisionId).not.toBe(before.desired!.desiredPublicationRevisionId);
    expect(after.playbackReceipts).toEqual(before.playbackReceipts);
    const newEvents = after.outbox.filter(row => !before.outbox.some(old => old.eventId === row.eventId));
    expect(newEvents.some(row => row.eventType === PLAYBACK_CHANGED)).toBe(true);
    expect(newEvents.some(row => row.eventType === 'device.publication.desired-revision.changed')).toBe(true);
    const receipts = await p.interactionReceipt.findMany();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ deviceId, eventId: input.eventId, commandId: result.commandId,
      credentialId, publicationId: input.publicationId, publicationRevision: input.revision, action: 'view.next', result });
    expect(JSON.stringify(receipts)).not.toContain(token);
    expect(Object.keys(receipts[0])).not.toContain('payload');
  });

  test('duplicate survives service restart and old publication/time/sequence with stable command/result', async () => {
    const input = await event({ clientSequence: 10 });
    const result = await service.execute(headers, input);
    expect(result.status).toBe('accepted');
    const before = await business();
    now += 600_000;
    service = instance();
    const duplicate = await service.execute(headers, input);
    expect(duplicate).toEqual({ ...result, status: 'duplicate' });
    expect(await business()).toEqual(before);
    expect(await p.interactionReceipt.count()).toBe(1);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId } })).minuteCount).toBe(1);
  });

  test('one process serializes publish with identical interactions on its shared SQLite writer', async () => {
    const input = await event();
    const before = { commands: await p.publicationCommand.count(), revisions: await p.publicationRevision.count() };
    const database = p as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const transaction = database.$transaction.bind(p);
    let active = 0, maximum = 0, values: unknown[] = [];
    database.$transaction = async (...args: unknown[]) => {
      active++; maximum = Math.max(maximum, active);
      try { await Bun.sleep(20); return await transaction(...args); }
      finally { active--; }
    };
    try {
      values = await Promise.all([
        publisher.publish(randomUUID(), { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [warmDeviceId], allowedActions: actions,
          draft: { fixtureArtifacts: ['mono-800x480-white-png'] } }),
        service.execute(headers, input), service.execute(headers, input),
      ]);
    } finally { database.$transaction = transaction; }
    const interactions = values.slice(1) as CommandResult[];
    expect(maximum).toBe(1);
    expect(interactions.map(result => result.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(interactions[0].commandId).toBe(interactions[1].commandId);
    expect(await p.interactionReceipt.count({ where: { eventId: input.eventId } })).toBe(1);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId } })).minuteCount).toBe(1);
    expect(await p.publicationCommand.count()).toBe(before.commands + 1);
    expect(await p.publicationRevision.count()).toBe(before.revisions + 1);
  }, 30_000);

  test('event-id collision cannot replay or change the original receipt', async () => {
    const input = await event();
    const result = await service.execute(headers, input);
    const original = await p.interactionReceipt.findMany();
    const collision = await rejected({ ...input, payload: { ...input.payload, expectedPlaybackVersion: 999 } });
    expect(collision.commandId).toBeTruthy();
    expect(await p.interactionReceipt.findMany()).toEqual(original);
    expect((await service.execute(headers, input)).commandId).toBe(result.commandId);
  });

  test('current desired publication, exact action/target and playback fences are required', async () => {
    await rejected(await event({ publicationId: randomUUID() }));
    await rejected(await event({ revision: '999' }));
    await rejected(await event({ action: 'timer.start' }));
    await rejected(await event({ targetId: 'unpublished-button' }));
    const input = await event();
    await rejected({ ...input, payload: { ...input.payload, expectedPlaybackVersion: 0 } });
    await rejected({ ...input, eventId: randomUUID(), payload: { ...input.payload, expectedDesiredSequence: 0 } });
    expect((await service.execute(headers, await event())).status).toBe('accepted');
  });

  test('occurredAt enforces inclusive past/future limits and stale duplicates stay idempotent', async () => {
    await rejected(await event({ occurredAt: new Date(now - 300_001).toISOString() }));
    await rejected(await event({ occurredAt: new Date(now + 30_001).toISOString() }));
    const input = await event({ occurredAt: new Date(now - 300_000).toISOString() });
    expect((await service.execute(headers, input)).status).toBe('accepted');
    expect((await service.execute(headers, await event({ occurredAt: new Date(now + 30_000).toISOString() }))).status).toBe('accepted');
    now += 300_001;
    expect((await service.execute(headers, input)).status).toBe('duplicate');
  });

  test('credential sequence is persisted and rejects reuse/regression after a new service instance', async () => {
    expect((await service.execute(headers, await event({ clientSequence: 10 }))).status).toBe('accepted');
    service = instance();
    await rejected(await event({ clientSequence: 9 }));
    await rejected(await event({ clientSequence: 10 }));
    expect((await service.execute(headers, await event({ clientSequence: 11 }))).status).toBe('accepted');
    expect((await p.interactionSequence.findUniqueOrThrow({ where: { credentialId } })).lastSequence).toBe(11);
  });

  test('8/second and 60/minute quotas persist across services and credentials, excluding duplicates', async () => {
    const secondToken = generateToken(48);
    const secondCredential = await p.deviceCredential.create({ data: { deviceId, tokenHash: hashToken(secondToken) } });
    let first!: InteractionEvent, firstResult!: CommandResult;
    const start = now;
    for (let index = 0; index < 60; index++) {
      now = start + Math.floor(index / 8) * 1001;
      const secondary = index % 2 === 1;
      service = instance();
      const input = await event({ credentialId: secondary ? secondCredential.credentialId : credentialId });
      const result = await service.execute(secondary ? { authorization: `Bearer ${secondToken}` } : headers, input);
      expect(result.status, `quota command ${index + 1}: ${JSON.stringify(result)}`).toBe('accepted');
      if (index === 0) { first = input; firstResult = result; }
      if (index === 7) {
        const before = await business();
        expect(await service.execute(headers, first)).toEqual({ ...firstResult, status: 'duplicate' });
        expect(await business()).toEqual(before);
        await httpError(service.execute(headers, await event()), 429, 'INTERACTION_RATE_LIMITED');
      }
    }
    now = start + 10_000;
    service = instance();
    const beforeLimit = await business(), receiptCount = await p.interactionReceipt.count();
    await httpError(service.execute(headers, await event()), 429, 'INTERACTION_RATE_LIMITED');
    expect(await business()).toEqual(beforeLimit);
    expect(await p.interactionReceipt.count()).toBe(receiptCount);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId } })).minuteCount).toBe(60);
    now = start + 60_001;
    expect((await service.execute(headers, await event())).status).toBe('accepted');
  }, 30_000);

  test('failure after playback writes rolls back state, receipt, sequence, rate and every outbox event', async () => {
    const input = await event({ clientSequence: 1 }), before = await business();
    const receipts = await p.interactionReceipt.findMany(), rates = await p.interactionRate.findMany();
    const sequences = await p.interactionSequence.findMany();
    await p.$executeRawUnsafe(`CREATE TRIGGER fail_interaction_receipt BEFORE INSERT ON interaction_receipts
      BEGIN SELECT RAISE(ABORT, 'interaction fixture rollback'); END`);
    try {
      writes.length = 0;
      await httpError(service.execute(headers, input), 503, 'INTERACTION_UNAVAILABLE');
      expect(writes.some(query => /UPDATE\s+.*playback_states/i.test(query))).toBe(true);
      expect(await business()).toEqual(before);
      expect(await p.interactionReceipt.findMany()).toEqual(receipts);
      expect(await p.interactionRate.findMany()).toEqual(rates);
      expect(await p.interactionSequence.findMany()).toEqual(sequences);
    } finally { await p.$executeRawUnsafe('DROP TRIGGER fail_interaction_receipt'); }
    expect((await service.execute(headers, input)).status).toBe('accepted');
    expect(await p.interactionReceipt.count()).toBe(1);
  });

  test('invalid or secret handler results after real writes roll back domain, outbox and all interaction records', async () => {
    expect((await service.execute(headers, await event({ clientSequence: 1 }))).status).toBe('accepted');
    const delegate = new ViewNextHandler(playback), input = await event({ clientSequence: 2 });
    const before = await business(), receipts = await p.interactionReceipt.findMany();
    const rates = await p.interactionRate.findMany(), sequences = await p.interactionSequence.findMany();
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'result', { enumerable: true,
      get: () => { getterCalls++; return 'unsafe getter'; } });
    const invalidResults: unknown[] = [null, [], { status: 'duplicate' }, { stateRevision: 2 },
      { stateRevision: 'x'.repeat(129) }, { result: { opaque: token } },
      { result: 'x'.repeat(4097) }, accessor];
    for (const candidate of invalidResults) {
      service = new InteractionService(p as PrismaService, new CommandRegistry([{
        action: 'view.next', payloadSchemaVersion: '1.0', validate: delegate.validate.bind(delegate),
        execute: async (...args: Parameters<typeof delegate.execute>) => {
          await delegate.execute(...args);
          return candidate as Awaited<ReturnType<typeof delegate.execute>>;
        },
      }]), cache, { now: () => now });
      writes.length = 0;
      await httpError(service.execute(headers, input), 503, 'INTERACTION_UNAVAILABLE');
      expect(writes.some(query => /UPDATE\s+.*playback_states/i.test(query))).toBe(true);
      expect(await business()).toEqual(before);
      expect(await p.interactionReceipt.findMany()).toEqual(receipts);
      expect(await p.interactionRate.findMany()).toEqual(rates);
      expect(await p.interactionSequence.findMany()).toEqual(sequences);
    }
    expect(getterCalls).toBe(0);
    service = instance();
    expect((await service.execute(headers, input)).status).toBe('accepted');
    expect(await p.interactionReceipt.count()).toBe(receipts.length + 1);
  });

  test('late domain conflict rolls back handler writes but commits one safe rejected receipt', async () => {
    const delegate = new ViewNextHandler(playback), input = await event({ clientSequence: 1 });
    service = new InteractionService(p as PrismaService, new CommandRegistry([{
      action: 'view.next', payloadSchemaVersion: '1.0', validate: delegate.validate.bind(delegate),
      execute: async (...args: Parameters<typeof delegate.execute>) => {
        await delegate.execute(...args);
        throw new ConflictException('private handler error must not escape');
      },
    }]), cache, { now: () => now });
    const result = await rejected(input, 'INTERACTION_STATE_CONFLICT');
    expect(await p.interactionReceipt.count()).toBe(1);
    expect(await p.interactionSequence.count()).toBe(0);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId } })).minuteCount).toBe(1);
    expect(JSON.stringify(await p.interactionReceipt.findMany())).not.toContain('private handler error');
    expect(await service.execute(headers, input)).toEqual({ ...result, status: 'duplicate' });
  });

  test('credential expiry during a handler rolls back the entire command after actual state writes', async () => {
    await p.deviceCredential.update({ where: { credentialId }, data: { expiresAt: new Date(now + 1000) } });
    const delegate = new ViewNextHandler(playback), input = await event({ clientSequence: 1 }), before = await business();
    service = new InteractionService(p as PrismaService, new CommandRegistry([{
      action: 'view.next', payloadSchemaVersion: '1.0', validate: delegate.validate.bind(delegate),
      execute: async (...args: Parameters<typeof delegate.execute>) => {
        const result = await delegate.execute(...args);
        now += 1000;
        return result;
      },
    }]), cache, { now: () => now });
    writes.length = 0;
    await httpError(service.execute(headers, input), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    expect(writes.some(query => /UPDATE\s+.*playback_states/i.test(query))).toBe(true);
    expect(await business()).toEqual(before);
    expect(await p.interactionReceipt.count()).toBe(0);
    expect(await p.interactionSequence.count()).toBe(0);
    expect(await p.interactionRate.count()).toBe(0);
  });

  test('Bearer identity is bound to active device/current credential; legacy and revoked replay fail closed', async () => {
    const input = await event(), before = await business();
    for (const badHeaders of [{}, { http_id: 'legacy-fixture-key' }, { 'access-token': 'legacy-fixture-key' },
      { ...headers, http_id: 'legacy-fixture-key' }, { authorization: 'Bearer invalid' },
      { authorization: `Bearer ${generateToken(48)}` }]) {
      await httpError(service.execute(badHeaders, input), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    }
    await httpError(service.execute(headers, { ...input, deviceId: randomUUID() }), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    await httpError(service.execute(headers, { ...input, credentialId: randomUUID() }), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    expect(await business()).toEqual(before);
    expect(await p.interactionReceipt.count()).toBe(0);
    expect(await p.interactionRate.count()).toBe(0);
    expect((await service.execute(headers, input)).status).toBe('accepted');
    await p.deviceCredential.update({ where: { credentialId }, data: { revokedAt: new Date(now) } });
    await httpError(service.execute(headers, input), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    await httpError(service.context(headers), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    await p.deviceCredential.update({ where: { credentialId }, data: { revokedAt: null, expiresAt: new Date(now) } });
    await httpError(service.execute(headers, input), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    await p.deviceCredential.update({ where: { credentialId }, data: { expiresAt: null } });
    await p.device.update({ where: { id: deviceId }, data: { isActive: false } });
    await httpError(service.execute(headers, input), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    expect(await p.interactionReceipt.count()).toBe(1);
  });

  test('context exposes published rights without SQL writes, and cache fallback/miss confer no rights', async () => {
    const input = await event();
    writes.length = 0;
    expect(await service.context(headers)).toEqual({ protocolVersion: '1.0', deviceId: externalId, credentialId,
      serverTime: new Date(now).toISOString(), publicationId: input.publicationId, revision: input.revision,
      allowedActions: actions, playback: { version: Number(input.payload.expectedPlaybackVersion),
        desiredSequence: Number(input.payload.expectedDesiredSequence) } });
    expect(writes).toEqual([]);
    await usePublication(actions, false);
    const device = await target();
    expect((await cache.read(device, device.publicationState!.desiredRevision!))?.fallback).toBe(true);
    writes.length = 0;
    const fallback = await service.context(headers);
    expect(fallback.allowedActions).toEqual([]);
    expect(fallback.publicationId).toBe(device.publicationState!.desiredRevision!.publicationId);
    expect(writes).toEqual([]);
    await rejected(await event(), 'INTERACTION_NOT_ALLOWED');
    await p.renderBinding.deleteMany({ where: { deviceId } });
    expect(await cache.read(device, device.publicationState!.desiredRevision!)).toBeNull();
    writes.length = 0;
    expect((await service.context(headers)).allowedActions).toEqual([]);
    expect(writes).toEqual([]);
    await rejected(await event(), 'INTERACTION_NOT_ALLOWED');
  });

  test('published target is exact; published unknown handlers and absent rights cannot execute', async () => {
    await usePublication([{ action: 'view.next', targetId: 'next-button', payloadSchemaVersion: '1.0' }]);
    await rejected(await event(), 'INTERACTION_NOT_ALLOWED');
    await rejected(await event({ targetId: 'other-button' }), 'INTERACTION_NOT_ALLOWED');
    expect((await service.execute(headers, await event({ targetId: 'next-button' }))).status).toBe('accepted');
    await usePublication([{ action: 'timer.start', payloadSchemaVersion: '1.0' }]);
    await rejected(await event({ action: 'timer.start' }), 'INTERACTION_UNKNOWN_ACTION');
    await usePublication([]);
    await rejected(await event(), 'INTERACTION_NOT_ALLOWED');
  });

  test('bounded normalization rejects oversize/unsafe input and receipts omit benign unknown metadata', async () => {
    const input = await event(), before = await business();
    for (const invalid of [null, { ...input, payload: { text: 'x'.repeat(4097) } },
      { ...input, ignoredMetadata: 'x'.repeat(8193) }, { ...input, ignoredMetadata: token },
      { ...input, clientSequence: 2_147_483_648 }]) {
      await httpError(service.execute(headers, invalid), 400, 'INTERACTION_INVALID_INPUT');
    }
    let invoked = 0;
    const accessor = Object.defineProperty({ ...input }, 'payload', { enumerable: true, get: () => { invoked++; return {}; } });
    await httpError(service.execute(headers, accessor), 400, 'INTERACTION_INVALID_INPUT');
    expect(invoked).toBe(0);
    expect(await business()).toEqual(before);
    expect(await p.interactionReceipt.count()).toBe(0);
    const marker = 'private-metadata-that-must-not-persist';
    expect((await service.execute(headers, { ...input, ignoredMetadata: marker })).status).toBe('accepted');
    expect(JSON.stringify(await p.interactionReceipt.findMany())).not.toContain(marker);
    expect((await service.execute(headers, input)).status).toBe('duplicate');
  });

  test('two real independent processes commit exactly one playback and one receipt for the same event', async () => {
    const input = await event({ clientSequence: 1 }), before = await business();
    async function run() {
      const child = Bun.spawn([process.execPath, join(root, 'test/fixtures/interaction-process.ts')], {
        cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill(), 20_000);
      try {
        child.stdin.write(JSON.stringify({ url, now, headers, event: input }));
        await child.stdin.flush();
        child.stdin.end();
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exit, stderr).toBe(0);
        return JSON.parse(stdout) as CommandResult;
      } finally { clearTimeout(timeout); child.kill(); }
    }
    const results = await Promise.all([run(), run()]);
    expect(results.map(result => result.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(results[0].commandId).toBe(results[1].commandId);
    expect(results[0].result).toEqual(results[1].result);
    expect(await p.interactionReceipt.count()).toBe(1);
    const after = await business();
    expect(after.playback!.version).toBe(before.playback!.version + 1);
    expect(after.desired!.desiredSequence).toBe(before.desired!.desiredSequence + 1);
    expect(after.playbackReceipts).toEqual(before.playbackReceipts);
    const changed = after.outbox.filter(row => row.eventType === PLAYBACK_CHANGED
      && !before.outbox.some(old => old.eventId === row.eventId));
    expect(changed).toHaveLength(1);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId } })).minuteCount).toBe(1);
  }, 30_000);
});
