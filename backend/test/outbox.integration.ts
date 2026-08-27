import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventsService } from '../src/events/events.service';
import { OutboxStore } from '../src/events/outbox.store';
import { PresentationService } from '../src/device-platform/presentation.service';
import { ScreensService } from '../src/screens/screens.service';
import { OUTBOX_POLICY } from '../src/events/outbox.types';
import { PlaylistsService } from '../src/playlists/playlists.service';
import { ScreenDesignerService } from '../src/screen-designer/screen-designer.service';
import { DevicesService } from '../src/devices/devices.service';
import { PublicationPersistenceService } from '../src/publications/publication-persistence.service';
import { PublicationCleanupService } from '../src/publications/publication-cleanup.service';

const root = resolve(__dirname, '..');
describe('durable outbox with real SQLite transactions', () => {
  let directory: string,
    url: string,
    p: PrismaClient,
    store: OutboxStore,
    events: EventsService;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-wp16-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const child = spawn({
      cmd: [process.execPath, 'scripts/migrate-database.ts'],
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, out + err).toBe(0);
    p = new PrismaClient({ datasources: { db: { url } } });
    store = new OutboxStore(p as any);
    events = new EventsService(p as any);
  }, 30_000);
  afterEach(async () => {
    await p?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function device() {
    return p.device.create({
      data: {
        name: 'test',
        externalId: 'test-device',
        profileId: 'browser-hd-1920x1080',
        deliveryPolicyId: 'reference-connected-browser',
      },
    });
  }
  test('screen mutation, refresh flag, revision and outbox roll back together', async () => {
    const s = await p.screen.create({
      data: { name: 'before', imageUrl: '/uploads/example.png' },
    });
    const service = new ScreensService(p as any, {} as any, {} as any, events);
    await p.$executeRawUnsafe(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT, 'failure'); END",
    );
    await expect(service.update(s.id, { name: 'after' })).rejects.toThrow();
    expect(
      (await p.screen.findUniqueOrThrow({ where: { id: s.id } })).name,
    ).toBe('before');
    expect(await p.outboxAggregate.count()).toBe(0);
    expect(await p.outboxEvent.count()).toBe(0);
  });
  test('commit survives process restart before dispatch; expired owner cannot acknowledge', async () => {
    const d = await device();
    await events.notifyDevicesRefresh([d.id]);
    const now = new Date();
    const first = await store.claim('owner-a', now);
    expect(first).not.toBeNull();
    expect(await store.claim('owner-b', now)).toBeNull();
    await p.$disconnect();
    p = new PrismaClient({ datasources: { db: { url } } });
    store = new OutboxStore(p as any);
    const second = await store.claim(
      'owner-b',
      new Date(now.getTime() + OUTBOX_POLICY.leaseMs + 1),
    );
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(second?.attempts).toBe(2);
    expect(await store.ack(first!, now)).toBe(false);
    expect(
      await store.ack(
        second!,
        new Date(now.getTime() + OUTBOX_POLICY.leaseMs + 2),
      ),
    ).toBe(true);
  });
  test('concurrent dispatcher claims have exactly one winner', async () => {
    await events.notifyDevicesRefresh([(await device()).id]);
    const other = new PrismaClient({ datasources: { db: { url } } });
    try {
      const results = await Promise.all([
        store.claim('one'),
        new OutboxStore(other as any).claim('two'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });
  test('WP-20 two worker clients atomically share one render reservation across different candidates', async () => {
    const now = new Date();
    await p.outboxEvent.createMany({ data: ['render-a', 'render-b'].map(eventId => ({
      eventId, eventType: 'render.requested', aggregateType: 'RenderRequest', aggregateId: eventId,
      payload: {}, availableAt: now,
    })) });
    const other = new PrismaClient({ datasources: { db: { url } } });
    await p.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await p.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await other.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    const budget = { where: { eventType: 'render.requested' }, limit: 1 };
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    try {
      // Different candidates prevent a single-row CAS collision from hiding a
      // missing queue-wide capacity check. Both stores use the real same SQLite DB.
      const claims = [store, new OutboxStore(other as any)].map(async (worker, index) => {
        await barrier;
        return worker.claim(`worker-${index}`, now, { eventId: index ? 'render-b' : 'render-a' }, budget);
      });
      release();
      const results = await Promise.all(claims);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await p.outboxEvent.count({ where: { status: 'processing' } })).toBe(1);
      expect(await p.outboxEvent.count({ where: { status: 'pending', attempts: 0 } })).toBe(1);
      expect(await store.claim('still-full', now, {}, budget)).toBeNull();
      const winner = results.find(result => result !== null)!;
      expect(await store.ack(winner, now)).toBe(true);
      const next = await new OutboxStore(other as any).claim('after-ack', now, {}, budget);
      expect(next?.eventId).not.toBe(winner.eventId);
      expect(next?.attempts).toBe(1);
    } finally {
      release();
      await other.$disconnect();
    }
  });
  test('WP-20 queue budgets ignore expired leases and terminal rows without blocking other groups', async () => {
    const now = new Date();
    await p.outboxEvent.createMany({ data: [
      { eventId: 'old-render', eventType: 'render.requested', status: 'processing', claimToken: randomUUID(),
        claimOwner: 'expired', claimUntil: new Date(now.getTime() - 1) },
      { eventId: 'terminal-render', eventType: 'render.requested', status: 'delivered', processedAt: now },
      { eventId: 'next-render', eventType: 'render.requested', status: 'pending' },
      { eventId: 'delivery-event', eventType: 'device.refresh', status: 'pending' },
    ].map(event => ({ ...event, aggregateType: 'Test', aggregateId: event.eventId, payload: {}, availableAt: now })) });
    const renderBudget = { where: { eventType: 'render.requested' }, limit: 1 };
    const render = await store.claim('render', now, { eventId: 'next-render' }, renderBudget);
    expect(render?.eventId).toBe('next-render');
    const delivery = await store.claim('delivery', now, {}, { where: { eventType: 'device.refresh' }, limit: 1 });
    expect(delivery?.eventId).toBe('delivery-event');
    expect(await store.claim('blocked-render', now, { eventId: 'old-render' }, renderBudget)).toBeNull();
    const expired = new Date(now.getTime() + OUTBOX_POLICY.leaseMs + 1);
    expect((await store.claim('recovered-render', expired, { eventId: 'old-render' }, renderBudget))?.eventId).toBe('old-render');
    expect(await p.outboxEvent.count({ where: { eventType: 'render.requested', status: 'processing', claimUntil: { gt: expired } } })).toBe(1);
  });
  test('WP-20 validates reservation limits and preserves compound candidate filters', async () => {
    const now = new Date();
    await p.outboxEvent.createMany({ data: ['unrelated', 'allowed'].map((eventId, index) => ({
      eventId, eventType: 'test', aggregateType: 'Test', aggregateId: eventId, payload: {},
      availableAt: now, occurredAt: new Date(now.getTime() + index),
    })) });
    for (const limit of [0, -1, NaN, Infinity, 1.5]) {
      await expect(store.claim('invalid', now, {}, { where: {}, limit })).rejects.toThrow('OUTBOX_INVALID_CLAIM_BUDGET');
    }
    expect(await p.outboxEvent.count({ where: { attempts: { gt: 0 } } })).toBe(0);
    expect((await store.claim('filtered', now, { OR: [{ eventId: 'allowed' }, { eventId: 'missing' }] }, { where: {}, limit: 1 }))?.eventId).toBe('allowed');
  });
  test('retry delays and exhausted/orphaned attempts remain persistently visible', async () => {
    await events.notifyDevicesRefresh([(await device()).id]);
    let now = new Date();
    for (let i = 1; i <= OUTBOX_POLICY.maxAttempts; i++) {
      const claim = await store.claim('owner', now);
      expect(claim?.attempts).toBe(i);
      await store.fail(claim!, 'OUTBOX_TRANSPORT_FAILED', now, () => 0);
      expect(await store.claim('early', now)).toBeNull();
      now = new Date(now.getTime() + 1000 * 2 ** (i - 1));
    }
    const row = await p.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('dead-letter');
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toContain(row.eventId);
  });
  test('one logical effect survives duplicate events and a crash after dispatch before ack', async () => {
    const d = await device();
    await events.notifyDevicesRefresh([d.id]);
    const claim = (await store.claim('owner'))!;
    await store.register('consumer');
    const prepared = await store.prepare(claim);
    const delivery = await p.outboxDelivery.findFirstOrThrow();
    const presentations = new PresentationService(p as any);
    const context = {
      deliveryId: delivery.deliveryId,
      signal: new AbortController().signal,
    };
    const first = await presentations.getForDevice(d.id, context);
    await p.$disconnect();
    p = new PrismaClient({ datasources: { db: { url } } });
    store = new OutboxStore(p as any);
    const retry = await new PresentationService(p as any).getForDevice(
      d.id,
      context,
    );
    expect(retry).toEqual(first);
    expect(
      (await p.device.findUniqueOrThrow({ where: { id: d.id } }))
        .presentationRevision,
    ).toBe(first.revision);
    const { eventId: _id, ...data } = claim;
    await p.outboxEvent.create({
      data: {
        ...data,
        payload: data.payload as any,
        status: 'pending',
        attempts: 0,
        claimToken: null,
        claimOwner: null,
        claimUntil: null,
      },
    });
    const duplicate = (await store.claim('duplicate'))!;
    expect((await store.prepare(duplicate)).duplicate).toBe(true);
    expect(await p.outboxEffect.count()).toBe(1);
    expect(prepared.key).toBe(delivery.effectKey);
  });

  test('playlist, design and device producers roll their mutations and flags back', async () => {
    const d = await device();
    const playlist = await p.playlist.create({ data: { name: 'before' } });
    const design = await p.screenDesign.create({ data: { name: 'before' } });
    await p.device.update({
      where: { id: d.id },
      data: { playlistId: playlist.id },
    });
    await p.deviceScreenAssignment.create({
      data: { deviceId: d.id, screenDesignId: design.id },
    });
    await p.$executeRawUnsafe(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT, 'failure'); END",
    );
    await expect(
      new PlaylistsService(p as any, events).update(playlist.id, {
        name: 'after',
        screens: [],
      }),
    ).rejects.toThrow();
    await expect(
      new ScreenDesignerService(p as any, events, {} as any).updateScreenDesign(
        design.id,
        { name: 'after' },
      ),
    ).rejects.toThrow();
    await expect(
      new DevicesService(
        p as any,
        events,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      ).unassignPlaylist(d.id),
    ).rejects.toThrow();
    expect(
      (await p.playlist.findUniqueOrThrow({ where: { id: playlist.id } })).name,
    ).toBe('before');
    expect(
      (await p.screenDesign.findUniqueOrThrow({ where: { id: design.id } }))
        .name,
    ).toBe('before');
    expect(
      await p.device.findUniqueOrThrow({ where: { id: d.id } }),
    ).toMatchObject({ playlistId: playlist.id, refreshPending: false });
    expect(await p.outboxAggregate.count()).toBe(0);
    expect(await p.outboxEvent.count()).toBe(0);
  });

  test('screen design stores only one logical event including direct and playlist assignments', async () => {
    const d = await device(),
      design = await p.screenDesign.create({ data: { name: 'test' } });
    const playlist = await p.playlist.create({
      data: { name: 'test', items: { create: { screenDesignId: design.id } } },
    });
    await p.device.update({
      where: { id: d.id },
      data: { playlistId: playlist.id },
    });
    await p.deviceScreenAssignment.create({
      data: { deviceId: d.id, screenDesignId: design.id },
    });
    expect(await events.notifyScreenDesignUpdate(design.id)).toBe(1);
    const rows = await p.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('screen_design:updated');
    expect((rows[0].payload as any).deviceIds).toEqual([d.id]);
    expect(
      (await p.device.findUniqueOrThrow({ where: { id: d.id } }))
        .refreshPending,
    ).toBe(true);
  });

  test('WP-07 event types retain version 1 and deduplicate by publication revision', async () => {
    const d = await device(),
      publications = new PublicationPersistenceService(p as any);
    const published = await publications.createPublication({
      publicationKey: 'test',
      protocolVersion: '1.0',
      content: {},
      contentHash: 'hash',
    });
    await publications.setDesiredRevision(
      d.id,
      published.revision.publicationRevisionId,
    );
    // Same assignment is now a producer no-op. An actual duplicate event still
    // exercises the permanent WP-16 consumer deduplication receipt.
    const assigned = await p.outboxEvent.findFirstOrThrow({ where: { eventType: 'device.publication.desired-revision.changed' } });
    const { eventId: _assignedId, ...assignedData } = assigned;
    await p.outboxEvent.create({ data: { ...assignedData, payload: assignedData.payload as any } });
    await publications.setDesiredRevision(
      d.id,
      published.revision.publicationRevisionId,
    );
    let duplicates = 0;
    for (let i = 0; i < 3; i++) {
      const claim = (await store.claim('test'))!;
      const prepared = await store.prepare(claim);
      if (prepared.duplicate) duplicates++;
      await store.ack(claim);
    }
    expect(duplicates).toBe(1);
    expect(await p.outboxDelivery.count()).toBe(1);
  });

  test('last-attempt crash is recovered into a persistent dead letter, not deleted', async () => {
    await events.notifyDevicesRefresh([(await device()).id]);
    await p.outboxEvent.updateMany({
      data: { attempts: OUTBOX_POLICY.maxAttempts - 1 },
    });
    const claim = (await store.claim('crashing'))!;
    expect(
      await store.claim('recovery', new Date(claim.claimUntil!.getTime() + 1)),
    ).toBeNull();
    expect(await p.outboxEvent.findFirstOrThrow()).toMatchObject({
      status: 'dead-letter',
      attempts: OUTBOX_POLICY.maxAttempts,
    });
  });

  test('retention clears terminal payloads at 30/90 days, preserves live work and dedupe receipts', async () => {
    const d = await device(),
      now = new Date(),
      old = new Date(now.getTime() - 100 * 86400_000);
    await events.notifyDevicesRefresh([d.id]);
    const claim = (await store.claim('owner'))!,
      prepared = await store.prepare(claim);
    await store.ack(claim);
    await p.outboxEvent.updateMany({ data: { processedAt: old } });
    await events.notifyDevicesRefresh([d.id]);
    const dead = (await store.claim('owner'))!;
    await store.prepare(dead);
    await store.fail(dead, 'OUTBOX_INVALID_PAYLOAD');
    await p.outboxEvent.update({
      where: { eventId: dead.eventId },
      data: { processedAt: old },
    });
    await events.notifyDevicesRefresh([d.id]);
    const live = (await store.claim('owner'))!;
    await p.outboxEvent.update({
      where: { eventId: live.eventId },
      data: { occurredAt: old },
    });
    await new PublicationCleanupService(p as any).cleanup(now);
    expect(await p.outboxEvent.count()).toBe(1);
    expect((await p.outboxEvent.findFirstOrThrow()).status).toBe('processing');
    expect(await p.outboxDelivery.count()).toBe(0);
    expect(
      await p.outboxEffect.findUnique({ where: { key: prepared.key } }),
    ).not.toBeNull();
  });

  test('malformed notification IDs fail before credentials can reach storage', async () => {
    await expect(
      events.notifyDevicesRefresh(['credential-test-secret' as any]),
    ).rejects.toThrow('Invalid notification identifiers');
    expect(await p.outboxEvent.count()).toBe(0);
  });

  test('late target acknowledgements are fenced out after a replacement claim', async () => {
    const d = await device();
    await events.notifyDevicesRefresh([d.id]);
    const first = (await store.claim('first'))!;
    await store.register('subscriber');
    const prepared = await store.prepare(first);
    expect(await store.beginTarget(prepared.key, 'subscriber', first)).toBe(
      true,
    );
    await p.outboxEvent.update({
      where: { eventId: first.eventId },
      data: { claimUntil: new Date(0) },
    });
    const second = (await store.claim('second'))!;
    expect(await store.beginTarget(prepared.key, 'subscriber', second)).toBe(
      true,
    );
    expect(
      await store.finishTarget(prepared.key, 'subscriber', first, true),
    ).toBe(false);
    expect(
      await store.finishTarget(prepared.key, 'subscriber', second, true),
    ).toBe(true);
  });

  test('invalid presentation URLs never enter the durable retry snapshot', async () => {
    const d = await device();
    const playlist = await p.playlist.create({
      data: {
        name: 'test',
        items: {
          create: {
            screen: {
              create: {
                name: 'test',
                imageUrl: '/uploads/image.png?credential=do-not-persist',
              },
            },
          },
        },
      },
    });
    await p.device.update({
      where: { id: d.id },
      data: { playlistId: playlist.id },
    });
    await events.notifyDevicesRefresh([d.id]);
    await store.prepare((await store.claim('owner'))!);
    const delivery = await p.outboxDelivery.findFirstOrThrow();
    const manifest = await new PresentationService(p as any).getForDevice(d.id, {
        deliveryId: delivery.deliveryId,
        signal: new AbortController().signal,
      });
    expect(manifest.content.url).toBe('/assets/publication-unassigned.svg');
    expect(JSON.stringify((await p.outboxDelivery.findFirstOrThrow()).presentation)).not.toContain('do-not-persist');
    expect(
      (await p.device.findUniqueOrThrow({ where: { id: d.id } }))
        .presentationRevision,
    ).toBe(0);
  });
});
