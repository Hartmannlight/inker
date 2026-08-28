import { describe, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service';
import { OutboxStore } from '../events/outbox.store';
import { effectKey, parseOutboxEvent, type EventInput } from '../events/outbox.types';
import { parseTimerEvent, TIMER_CHANGED, TIMER_REASONS } from './timer.events';

const timerId = 'e6a81379-1b77-4309-a310-ec8ac4ea7339';
const event = (version = 1): EventInput => ({
  eventId: 'event-1', eventType: TIMER_CHANGED, aggregateType: 'Timer',
  aggregateId: timerId, aggregateRevision: String(version), payloadVersion: 1,
  payload: { timerId, version, reason: 'created' },
});
function rejects(input: EventInput) {
  for (const parse of [parseTimerEvent, parseOutboxEvent]) {
    expect(() => parse(input)).toThrow('OUTBOX_INVALID_PAYLOAD');
    try { parse(input); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
  }
}

describe('WP-24 timer events', () => {
  test('real SQLite acknowledges retries as one effect without deliveries or dead letters', async () => {
    const root = resolve(import.meta.dir, '../..');
    const directory = mkdtempSync(join(tmpdir(), 'inker-timer-event-'));
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-timer-event-'))
      throw new Error('Unsafe timer fixture cleanup');
    const url = 'file:' + join(directory, 'test.db').replaceAll('\\', '/');
    let prisma: PrismaClient | undefined;
    try {
      const child = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
        cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
      prisma = new PrismaClient({ datasources: { db: { url } } });
      await prisma.$connect();
      let originalKey: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = new OutboxStore(prisma as PrismaService);
        const input = event();
        const row = await prisma.outboxEvent.create({ data: {
          eventId: randomUUID(), eventType: input.eventType, aggregateType: input.aggregateType,
          aggregateId: input.aggregateId, aggregateRevision: input.aggregateRevision, payloadVersion: 1,
          payload: { timerId, version: 1, reason: 'created' },
        } });
        const claimed = await store.claim('timer-event-test', new Date(), { eventId: row.eventId });
        expect(claimed).not.toBeNull();
        const prepared = await store.prepare(claimed!);
        expect(prepared.deviceIds).toEqual([]);
        expect(prepared.notification).toBeUndefined();
        expect(prepared.duplicate).toBe(attempt > 0);
        if (originalKey === undefined) originalKey = prepared.key;
        else expect(prepared.key).toBe(originalKey);
        expect(await store.targetsComplete(prepared.key)).toBe(true);
        expect(await store.ack(claimed!)).toBe(true);
        expect(await prisma.outboxEvent.findUnique({ where: { eventId: row.eventId } }))
          .toMatchObject({ status: 'delivered', attempts: 1, lastError: null });
      }
      expect(await prisma.outboxEffect.count()).toBe(1);
      expect(await prisma.outboxDelivery.count()).toBe(0);
      expect(await prisma.outboxTarget.count()).toBe(0);
      expect(await prisma.outboxEvent.count({ where: { status: 'dead-letter' } })).toBe(0);
    } finally {
      await prisma?.$disconnect();
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000);

  test('accepts every domain transition and projects only timer identity and version', () => {
    for (const reason of TIMER_REASONS) {
      const input = { ...event(), payload: { timerId, version: 1, reason } };
      expect(parseTimerEvent(input)).toEqual({ timerId, version: 1, reason });
      expect(parseOutboxEvent(input)).toEqual({ key: effectKey(TIMER_CHANGED, 'Timer', timerId, '1'), deviceIds: [],
        stateChange: { topic: 'timers', timerId } });
    }
  });

  test('keeps one effect across retries without implicit delivery or notification', () => {
    const original = parseOutboxEvent(event());
    expect(original.key).toMatch(/^[a-f0-9]{64}$/);
    expect(parseOutboxEvent({ ...event(), eventId: 'retry-id' })).toEqual(original);
    expect(parseOutboxEvent(event(2)).key).not.toBe(original.key);
    const another = '55317594-5b03-4ad0-aeb7-1392c5ce36bc';
    expect(parseOutboxEvent({ ...event(), aggregateId: another, payload: { timerId: another, version: 1, reason: 'created' } }).key)
      .not.toBe(original.key);
    expect(Object.keys(original).sort()).toEqual(['deviceIds', 'key', 'stateChange']);
    original.deviceIds.push(99);
    expect(parseOutboxEvent(event()).deviceIds).toEqual([]);
  });

  test('requires matching event, aggregate and payload versions', () => {
    for (const patch of [{ eventType: 'synthetic-secret' }, { aggregateType: 'Device' }, { payloadVersion: 0 },
      { payloadVersion: 2 }, { aggregateId: 'synthetic-secret' }, { aggregateRevision: null },
      { aggregateRevision: undefined }, { aggregateRevision: '01' }, { aggregateRevision: '2' }]) rejects({ ...event(), ...patch });
    for (const version of [1, 2_147_483_647]) expect(parseTimerEvent(event(version)).version).toBe(version);
    for (const version of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null])
      rejects({ ...event(), aggregateRevision: String(version), payload: { timerId, version, reason: 'created' } });
  });

  test('rejects missing, extra or mistyped payload fields without echoing submitted values', () => {
    for (const payload of [null, [], 'synthetic-secret', {}, { timerId, version: 1 },
      { timerId, reason: 'created' }, { version: 1, reason: 'created' },
      { timerId, version: 1, reason: 'synthetic-secret' }, { timerId, version: 1, reason: 1 },
      { timerId, version: 1, reason: 'created', deviceIds: [1] },
      { timerId, version: 1, reason: 'created', credential: 'synthetic-secret' }]) rejects({ ...event(), payload });
    for (const id of ['', timerId.toUpperCase(), timerId + '\n', 'synthetic-secret', 1, null]) {
      rejects({ ...event(), aggregateId: String(id), payload: { timerId: id, version: 1, reason: 'created' } });
    }
  });
});
