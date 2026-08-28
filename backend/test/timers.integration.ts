import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import type { AllowedAction, CommandResult, InteractionEvent, JsonObject, TimerSnapshot } from '@inker/contracts';
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateToken, hashToken } from '../src/common/utils/crypto.util';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublishService } from '../src/publications/publish.service';
import { ArtifactStore } from '../src/render-cache/artifact-store';
import { RenderCacheService, RENDER_REQUESTED } from '../src/render-cache/render-cache.service';
import { OutboxStore } from '../src/events/outbox.store';
import { parseOutboxEvent } from '../src/events/outbox.types';
import { InteractionService } from '../src/interactions/interaction.service';
import { CommandRegistry } from '../src/interactions/command-registry';
import { TimerService, type TimerCommandAction } from '../src/timers/timer.service';
import { TIMER_ACTIONS, TimerCommandHandler } from '../src/timers/timer-handlers';
import { TIMER_CHANGED, parseTimerEvent } from '../src/timers/timer.events';

const root = resolve(import.meta.dir, '..');
type Actor = { deviceId: number; externalId: string; credentialId: string; token: string; headers: IncomingHttpHeaders };
type TimerVisibility = TimerSnapshot['visibility'];
const allowedActions: AllowedAction[] = TIMER_ACTIONS.map(action => ({ action, payloadSchemaVersion: '1.0' }));

describe('WP-24 persistent timer commands through real authenticated interactions', () => {
  let directory: string, url: string, previousCachePath: string | undefined;
  let p: PrismaClient, timers: TimerService, interactions: InteractionService;
  let cache: RenderCacheService, outbox: OutboxStore, publisher: PublishService;
  let owner: Actor, peer: Actor, unprivileged: Actor, now: number, writes: string[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-timers-'));
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
    timers = new TimerService(p as PrismaService, { now: () => now });
    cache = new RenderCacheService(p as PrismaService, new ArtifactStore());
    outbox = new OutboxStore(p as PrismaService);
    publisher = new PublishService(p as PrismaService, new PublicationPersistenceService(p as PrismaService));
    interactions = new InteractionService(p as PrismaService,
      new CommandRegistry(TIMER_ACTIONS.map(action => new TimerCommandHandler(action, timers))), cache, { now: () => now });
    owner = await actor(); peer = await actor(); unprivileged = await actor();
    await publish([owner, peer], allowedActions);
    await publish([unprivileged], []);
  }, 30_000);

  afterEach(async () => {
    await p?.$disconnect();
    if (previousCachePath === undefined) delete process.env.INKER_RENDER_CACHE_PATH;
    else process.env.INKER_RENDER_CACHE_PATH = previousCachePath;
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-timers-'))
        throw new Error('Unsafe timer fixture cleanup path');
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function actor(): Promise<Actor> {
    const externalId = randomUUID(), token = generateToken(48);
    const device = await p.device.create({ data: { name: 'timer fixture', externalId,
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    const credential = await p.deviceCredential.create({ data: { deviceId: device.id, tokenHash: hashToken(token) } });
    return { deviceId: device.id, externalId, credentialId: credential.credentialId, token, headers: { authorization: `Bearer ${token}` } };
  }
  async function publish(devices: Actor[], rights: AllowedAction[]) {
    await publisher.publish(randomUUID(), { idempotencyKey: randomUUID(), expectedRevision: 0,
      deviceIds: devices.map(device => device.deviceId), allowedActions: rights,
      draft: { fixtureArtifacts: ['mono-800x480-white-png'] } });
    const key = await cache.request(devices[0].deviceId);
    const task = await outbox.claim('timer-render-fixture', new Date(), { eventType: RENDER_REQUESTED, aggregateId: key });
    expect(task).not.toBeNull();
    await cache.render(task!);
    expect(await outbox.ack(task!)).toBe(true);
    for (const device of devices.slice(1)) await cache.request(device.deviceId);
  }
  async function event(action: TimerCommandAction, payload: JsonObject, device = owner,
    patch: Partial<InteractionEvent> = {}): Promise<InteractionEvent> {
    const state = await p.devicePublicationState.findUniqueOrThrow({ where: { deviceId: device.deviceId }, include: { desiredRevision: true } });
    return { protocolVersion: '1.0', eventId: randomUUID(), deviceId: device.externalId,
      credentialId: device.credentialId, publicationId: state.desiredRevision!.publicationId,
      revision: String(state.desiredRevision!.revision), action: `timer.${action}`,
      payload, occurredAt: new Date(now).toISOString(), ...patch };
  }
  async function send(action: TimerCommandAction, payload: JsonObject, device = owner) {
    return interactions.execute(device.headers, await event(action, payload, device));
  }
  function mutation(timer: TimerSnapshot) { return { version: 1, timerId: timer.timerId, expectedVersion: timer.version }; }
  function createPayload(visibility: TimerVisibility = 'private', durationMs = 60_000) { return { version: 1, durationMs, visibility }; }
  async function command(action: TimerCommandAction, payload: JsonObject, device = owner) {
    const result = await send(action, payload, device);
    expect(result.status, JSON.stringify(result)).toBe('accepted');
    expect(result.stateRevision).toBe(String((result.result as unknown as TimerSnapshot).version));
    return result.result as unknown as TimerSnapshot;
  }
  function domain(action: TimerCommandAction, payload: unknown, device = owner) {
    return p.$transaction(tx => timers.executeInTransaction(tx, device, action, payload));
  }
  async function snapshot() {
    return { timers: await p.timer.findMany({ orderBy: { timerId: 'asc' } }),
      outbox: await p.outboxEvent.findMany({ orderBy: { eventId: 'asc' } }),
      receipts: await p.interactionReceipt.findMany({ orderBy: { commandId: 'asc' } }),
      rates: await p.interactionRate.findMany({ orderBy: { deviceId: 'asc' } }),
      sequences: await p.interactionSequence.findMany({ orderBy: { credentialId: 'asc' } }) };
  }
  async function domainRows() {
    return { timers: await p.timer.findMany({ orderBy: { timerId: 'asc' } }),
      events: await p.outboxEvent.findMany({ where: { eventType: TIMER_CHANGED }, orderBy: { eventId: 'asc' } }) };
  }
  async function httpError(operation: Promise<unknown>, status: number, message: string) {
    try { await operation; throw new Error('Expected HTTP error'); }
    catch (error) {
      expect(error).toMatchObject({ message });
      expect((error as { getStatus(): number }).getStatus()).toBe(status);
    }
  }
  async function processCommand(input: InteractionEvent, device = owner) {
    const child = Bun.spawn([process.execPath, join(root, 'test/fixtures/timer-process.ts')], {
      cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      child.stdin.write(JSON.stringify({ url, now, headers: device.headers, event: input }));
      await child.stdin.flush();
      child.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      return JSON.parse(stdout) as CommandResult;
    } finally { clearTimeout(timeout); child.kill(); }
  }

  test('published cached pixels permit create/pause/resume/cancel with stable no-ops and exact versions', async () => {
    const device = await p.device.findUniqueOrThrow({ where: { id: owner.deviceId }, include: {
      profile: true, deliveryPolicy: true, publicationState: { include: { desiredRevision: true } },
    } });
    const rendered = await cache.read(device, device.publicationState!.desiredRevision!);
    expect(rendered?.fallback).toBe(false);
    expect(await sharp(rendered!.artifact.bytes).metadata()).toMatchObject({ format: 'png', width: 1920, height: 1080 });
    const began = now;
    let timer = await command('create', createPayload());
    expect(timer).toMatchObject({ version: 1, status: 'running', creatorDeviceId: owner.externalId,
      startedAt: new Date(began).toISOString(), endsAt: new Date(began + 60_000).toISOString() });
    now += 5000;
    timer = await command('pause', mutation(timer));
    expect(timer).toMatchObject({ version: 2, status: 'paused', pausedRemainingMs: 55_000, endsAt: null });
    let before = await domainRows();
    expect(await command('pause', mutation(timer))).toEqual(timer);
    expect(await domainRows()).toEqual(before);
    now += 5000;
    timer = await command('resume', mutation(timer));
    expect(timer).toMatchObject({ version: 3, status: 'running', pausedRemainingMs: null,
      startedAt: new Date(began).toISOString(), endsAt: new Date(now + 55_000).toISOString() });
    before = await domainRows();
    expect(await command('resume', mutation(timer))).toEqual(timer);
    expect(await domainRows()).toEqual(before);
    timer = await command('cancel', mutation(timer));
    expect(timer).toMatchObject({ version: 4, status: 'cancelled', endsAt: null, cancelledAt: new Date(now).toISOString() });
    before = await domainRows();
    expect(await command('cancel', mutation(timer))).toEqual(timer);
    expect(await domainRows()).toEqual(before);
    const stale = await send('resume', { ...mutation(timer), expectedVersion: 1 });
    expect(stale).toMatchObject({ status: 'rejected', error: { code: 'INTERACTION_STATE_CONFLICT' } });
    expect(await domainRows()).toEqual(before);
    expect(before.events.map(row => row.aggregateRevision).sort()).toEqual(['1', '2', '3', '4']);
    expect((await timers.listForDevice(owner)).timers).toEqual([]);
  });

  test('clock-only reads never write or complete; pause at exact deadline completes and acknowledge is durable', async () => {
    const began = now;
    let timer = await command('create', createPayload('shared', 1000));
    const before = await snapshot();
    now += 1000;
    writes.length = 0;
    const list = await timers.listForDevice(peer);
    expect(list.serverTime).toBe(new Date(now).toISOString());
    expect(list.timers).toEqual([timer]);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    timer = await command('pause', mutation(timer), peer);
    expect(timer).toMatchObject({ version: 2, status: 'completed', endsAt: new Date(began + 1000).toISOString(),
      completedAt: new Date(began + 1000).toISOString(), acknowledgedAt: null });
    expect((await timers.listForDevice(peer)).timers).toEqual([timer]);
    now += 1000;
    timer = await command('acknowledge', mutation(timer), peer);
    expect(timer).toMatchObject({ version: 3, status: 'completed', acknowledgedAt: new Date(now).toISOString(),
      acknowledgedByDeviceId: peer.externalId });
    const after = await domainRows();
    expect(await command('acknowledge', mutation(timer), owner)).toEqual(timer);
    expect(await domainRows()).toEqual(after);
    expect((await timers.listForDevice(owner)).timers).toEqual([]);
    expect(after.events.map(row => (row.payload as { reason: string }).reason).sort()).toEqual(['acknowledged', 'completed', 'created']);
  });

  test('overdue acknowledgement combines completion and acknowledgement into one version/event; backward time is clamped', async () => {
    let timer = await domain('create', createPayload('shared', 1000));
    const began = now;
    now += 5000;
    timer = await command('acknowledge', mutation(timer), peer);
    expect(timer).toMatchObject({ version: 2, status: 'completed', completedAt: new Date(began + 1000).toISOString(),
      acknowledgedAt: new Date(now).toISOString(), acknowledgedByDeviceId: peer.externalId });
    expect((await domainRows()).events).toHaveLength(2);
    let other = await domain('create', createPayload('private', 10_000));
    now += 3000;
    other = await domain('pause', mutation(other));
    const pausedAt = now;
    now -= 2000;
    other = await domain('resume', mutation(other));
    expect(other.evaluatedAt).toBe(new Date(pausedAt).toISOString());
    expect(other.endsAt).toBe(new Date(pausedAt + 7000).toISOString());
    now = 253_402_300_799_999;
    const before = await snapshot();
    await expect(domain('create', createPayload())).rejects.toThrow('TIMER_INVALID_TIME');
    expect(await snapshot()).toEqual(before);
  });

  test('private timers are hidden from foreign principals; shared mutation commands still need published rights', async () => {
    const privateTimer = await command('create', createPayload()), shared = await command('create', createPayload('shared'));
    expect((await timers.listForDevice(peer)).timers).toEqual([shared]);
    const before = await domainRows();
    await httpError(domain('pause', mutation(privateTimer), peer), 404, 'TIMER_NOT_FOUND');
    const privateResult = await send('pause', mutation(privateTimer), peer);
    expect(privateResult).toMatchObject({ status: 'rejected', error: { code: 'INTERACTION_STATE_CONFLICT' } });
    const denied = await send('pause', mutation(shared), unprivileged);
    expect(denied).toMatchObject({ status: 'rejected', error: { code: 'INTERACTION_NOT_ALLOWED' } });
    expect(await domainRows()).toEqual(before);
    const paused = await command('pause', mutation(shared), peer);
    expect(paused).toMatchObject({ version: 2, status: 'paused' });
    await p.device.update({ where: { id: peer.deviceId }, data: { isActive: false } });
    await httpError(timers.listForDevice(peer), 404, 'TIMER_NOT_FOUND');
    await httpError(domain('resume', mutation(paused), peer), 404, 'TIMER_NOT_FOUND');
    await httpError(send('resume', mutation(paused), peer), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: shared.timerId } })).version).toBe(2);
  });

  test('duplicate create event persists exactly one timer/event and request collisions preserve it', async () => {
    const input = await event('create', createPayload(), owner, { clientSequence: 1 });
    const result = await interactions.execute(owner.headers, input), before = await snapshot();
    expect(result.status).toBe('accepted');
    now += 600_000;
    expect(await interactions.execute(owner.headers, input)).toEqual({ ...result, status: 'duplicate' });
    expect(await snapshot()).toEqual(before);
    expect(await interactions.execute(owner.headers, { ...input, payload: createPayload('shared') })).toMatchObject({
      status: 'rejected', error: { code: 'INTERACTION_EVENT_CONFLICT' },
    });
    expect(await snapshot()).toEqual(before);
    expect(before.timers).toHaveLength(1);
    expect(before.outbox.filter(row => row.eventType === TIMER_CHANGED)).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);
    expect(JSON.stringify(before.receipts)).not.toContain(owner.token);
  });

  for (const point of ['outbox', 'receipt'] as const) {
    test(`${point} trigger failure after timer writes rolls back timer, event, receipt, rate and sequence`, async () => {
      const initial = await event('create', createPayload(), owner, { clientSequence: 1 });
      const first = await interactions.execute(owner.headers, initial);
      const timer = first.result as unknown as TimerSnapshot;
      const input = await event('pause', mutation(timer), owner, { clientSequence: 2 }), before = await snapshot();
      const table = point === 'outbox' ? 'outbox_events' : 'interaction_receipts';
      await p.$executeRawUnsafe(`CREATE TRIGGER fail_timer_fixture BEFORE INSERT ON ${table}
        ${point === 'outbox' ? "WHEN NEW.event_type = 'timer.state.changed'" : ''}
        BEGIN SELECT RAISE(ABORT, 'timer fixture rollback'); END`);
      try {
        writes.length = 0;
        await httpError(interactions.execute(owner.headers, input), 503, 'INTERACTION_UNAVAILABLE');
        expect(writes.some(query => /UPDATE\s+.*[.`"]timers[`"]/i.test(query))).toBe(true);
        expect(await snapshot()).toEqual(before);
      } finally { await p.$executeRawUnsafe('DROP TRIGGER fail_timer_fixture'); }
      expect((await interactions.execute(owner.headers, input)).status).toBe('accepted');
      expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).version).toBe(2);
    });
  }

  test('owner credential rotation preserves ownership; device deletion preserves shared state and hides private orphans', async () => {
    const privateTimer = await command('create', createPayload()), shared = await command('create', createPayload('shared', 1000));
    await p.deviceCredential.update({ where: { credentialId: owner.credentialId }, data: { revokedAt: new Date(now) } });
    const old = owner;
    const token = generateToken(48);
    const credential = await p.deviceCredential.create({ data: { deviceId: owner.deviceId, tokenHash: hashToken(token) } });
    owner = { ...owner, token, credentialId: credential.credentialId, headers: { authorization: `Bearer ${token}` } };
    const paused = await command('pause', mutation(privateTimer));
    expect(paused.creatorDeviceId).toBe(old.externalId);
    await httpError(send('resume', mutation(paused), old), 401, 'INTERACTION_AUTHENTICATION_FAILED');
    await p.device.delete({ where: { id: owner.deviceId } });
    const rows = await p.timer.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.creatorDeviceId === null && row.creatorExternalId === old.externalId)).toBe(true);
    expect((await timers.listForDevice(peer)).timers).toEqual([shared]);
    await httpError(domain('cancel', mutation(paused), peer), 404, 'TIMER_NOT_FOUND');
    now += 1000;
    const acknowledged = await command('acknowledge', mutation(shared), peer);
    expect(acknowledged).toMatchObject({ creatorDeviceId: old.externalId, acknowledgedByDeviceId: peer.externalId, version: 2 });
    await p.device.delete({ where: { id: peer.deviceId } });
    const persisted = await p.timer.findUniqueOrThrow({ where: { timerId: shared.timerId } });
    expect(persisted).toMatchObject({ creatorDeviceId: null, creatorExternalId: old.externalId,
      acknowledgedByDeviceId: null, acknowledgedByExternalId: peer.externalId });
  });

  test('32 per-owner outstanding quota includes paused and unacknowledged completed, excluding cancelled/acknowledged', async () => {
    const created: TimerSnapshot[] = [];
    for (let index = 0; index < 32; index++) created.push(await domain('create', createPayload('private', 1000)));
    now += 100;
    for (let index = 0; index < 10; index++) created[index] = await domain('pause', mutation(created[index]));
    now += 900;
    for (let index = 10; index < 20; index++) created[index] = await domain('pause', mutation(created[index]));
    const states = await p.timer.groupBy({ by: ['status'], _count: true });
    expect(Object.fromEntries(states.map(state => [state.status, state._count]))).toEqual({ running: 12, paused: 10, completed: 10 });
    const before = await snapshot();
    await httpError(domain('create', createPayload()), 409, 'TIMER_LIMIT_REACHED');
    expect(await snapshot()).toEqual(before);
    await domain('acknowledge', mutation(created[10]));
    await domain('create', createPayload());
    await domain('cancel', mutation(created[0]));
    await domain('create', createPayload());
    expect(await p.timer.count()).toBe(34);
    expect((await timers.listForDevice(owner)).timers).toHaveLength(32);
    await httpError(domain('create', createPayload()), 409, 'TIMER_LIMIT_REACHED');
  });

  test('100 global outstanding quota keeps shared orphans but ignores inaccessible private orphans', async () => {
    const fourth = await actor(), fifth = await actor();
    for (const [device, visibility] of [[owner, 'private'], [peer, 'shared'], [unprivileged, 'private'], [fourth, 'shared']] as const) {
      for (let index = 0; index < 25; index++) await domain('create', createPayload(visibility), device);
    }
    const full = await snapshot();
    await httpError(domain('create', createPayload(), fifth), 409, 'TIMER_LIMIT_REACHED');
    expect(await snapshot()).toEqual(full);
    await p.device.delete({ where: { id: peer.deviceId } });
    await httpError(domain('create', createPayload(), fifth), 409, 'TIMER_LIMIT_REACHED');
    expect((await timers.listForDevice(fifth)).timers).toHaveLength(50);
    await p.device.delete({ where: { id: owner.deviceId } });
    for (let index = 0; index < 25; index++) await domain('create', createPayload(), fifth);
    expect(await p.timer.count()).toBe(125);
    expect((await timers.listForDevice(fifth)).timers).toHaveLength(75);
    await httpError(domain('create', createPayload(), fifth), 409, 'TIMER_LIMIT_REACHED');
  }, 30_000);

  test('real timer events pass strict outbox parsing and finish delivery without dead-letter or display fanout', async () => {
    const timer = await domain('create', createPayload());
    await domain('pause', mutation(timer));
    const rows = (await domainRows()).events;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(parseTimerEvent(row).timerId).toBe(timer.timerId);
      expect(parseOutboxEvent(row).deviceIds).toEqual([]);
      const claimed = await outbox.claim('timer-event-fixture', new Date(Math.max(now, Date.now())), { eventId: row.eventId });
      expect(claimed).not.toBeNull();
      const prepared = await outbox.prepare(claimed!);
      expect(prepared.deviceIds).toEqual([]);
      expect(await outbox.targetsComplete(prepared.key)).toBe(true);
      expect(await outbox.ack(claimed!)).toBe(true);
      expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: row.eventId } })).toMatchObject({ status: 'delivered', lastError: null });
    }
    expect(await p.outboxDelivery.count()).toBe(0);
    expect(await p.outboxEvent.count({ where: { status: 'dead-letter' } })).toBe(0);
  });

  test('two independent processes replay a create as one timer, receipt and event', async () => {
    const input = await event('create', createPayload('shared'));
    const results = await Promise.all([processCommand(input), processCommand(input)]);
    expect(results.map(result => result.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(results[0].commandId).toBe(results[1].commandId);
    expect(results[0].result).toEqual(results[1].result);
    expect(await p.timer.count()).toBe(1);
    expect(await p.interactionReceipt.count()).toBe(1);
    expect((await domainRows()).events).toHaveLength(1);
    expect((await p.interactionRate.findUniqueOrThrow({ where: { deviceId: owner.deviceId } })).minuteCount).toBe(1);
  }, 30_000);

  test('two independent devices/processes with the same expected timer version commit only one mutation', async () => {
    const timer = await domain('create', createPayload('shared'));
    const pause = await event('pause', mutation(timer)), cancel = await event('cancel', mutation(timer), peer);
    const results = await Promise.all([processCommand(pause), processCommand(cancel, peer)]);
    expect(results.map(result => result.status).sort()).toEqual(['accepted', 'rejected']);
    expect(results.find(result => result.status === 'rejected')?.error?.code).toBe('INTERACTION_STATE_CONFLICT');
    const row = await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } });
    expect(row.version).toBe(2);
    expect(['paused', 'cancelled']).toContain(row.status);
    expect((await domainRows()).events.map(item => item.aggregateRevision).sort()).toEqual(['1', '2']);
    expect(await p.interactionReceipt.count()).toBe(2);
    const before = await snapshot();
    expect((await processCommand(pause)).status).toBe('duplicate');
    expect((await processCommand(cancel, peer)).status).toBe('duplicate');
    expect(await snapshot()).toEqual(before);
  }, 30_000);
});
