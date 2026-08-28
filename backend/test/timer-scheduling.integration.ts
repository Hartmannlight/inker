import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PrismaClient, type OutboxEvent } from '@prisma/client';
import type { TimerSnapshot } from '@inker/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { OutboxStore } from '../src/events/outbox.store';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import { TimerService, type TimerCommandAction } from '../src/timers/timer.service';
import { TimerWorkerService } from '../src/timers/timer-worker.service';
import { TIMER_CHANGED } from '../src/timers/timer.events';
import { TIMER_DUE, parseTimerDue, timerCompletionId } from '../src/timers/timer-scheduling';

const root = resolve(import.meta.dir, '..');
describe('WP-25 durable timer scheduling and worker recovery', () => {
  let directory: string, url: string, p: PrismaClient, now: number;
  let timers: TimerService, worker: TimerWorkerService, store: OutboxStore;
  let principal: { deviceId: number; externalId: string }, writes: string[];
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-timer-scheduling-'));
    url = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`;
    const child = Bun.spawn([process.execPath, join(root, 'scripts/migrate-database.ts')], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, out + err).toBe(0);
    p = new PrismaClient({ datasources: { db: { url } }, log: [{ level: 'query', emit: 'event' }] });
    writes = [];
    p.$on('query' as never, (event: { query: string }) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(event.query)) writes.push(event.query);
    });
    await p.$connect();
    now = Date.now();
    timers = new TimerService(p as PrismaService, { now: () => now });
    worker = new TimerWorkerService(p as PrismaService, timers, { now: () => now });
    store = new OutboxStore(p as PrismaService);
    const device = await p.device.create({ data: { name: 'timer worker fixture', externalId: randomUUID(),
      profileId: 'browser-hd-1920x1080', deliveryPolicyId: 'reference-connected-browser' } });
    principal = { deviceId: device.id, externalId: device.externalId! };
  }, 30_000);
  afterEach(async () => {
    await p?.$disconnect();
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-timer-scheduling-'))
        throw new Error('Unsafe timer scheduling fixture cleanup path');
      rmSync(target, { recursive: true, force: true });
    }
  });
  function command(action: TimerCommandAction, payload: unknown) {
    return p.$transaction(tx => timers.executeInTransaction(tx, principal, action, payload));
  }
  function create(durationMs = 10_000) { return command('create', { version: 1, visibility: 'shared', durationMs }); }
  function mutation(timer: TimerSnapshot) { return { version: 1, timerId: timer.timerId, expectedVersion: timer.version }; }
  function due(timer: TimerSnapshot) {
    return p.outboxEvent.findUniqueOrThrow({ where: {
      eventId: timerCompletionId(timer.timerId, timer.version, Date.parse(timer.endsAt!)),
    } });
  }
  async function claim(event: OutboxEvent) {
    const claimed = await store.claim('timer-worker-fixture', new Date(now), { eventId: event.eventId, eventType: TIMER_DUE });
    expect(claimed).not.toBeNull();
    return claimed!;
  }
  async function snapshot() {
    return { timers: await p.timer.findMany({ orderBy: { timerId: 'asc' } }),
      events: await p.outboxEvent.findMany({ orderBy: { eventId: 'asc' } }),
      effects: await p.outboxEffect.findMany({ orderBy: { key: 'asc' } }) };
  }
  async function processRun(input: { operation: 'claim' | 'reconcile'; eventId?: string; crashAfterCommit?: boolean }) {
    const child = Bun.spawn([process.execPath, join(root, 'test/fixtures/timer-worker-process.ts')], {
      cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      child.stdin.write(JSON.stringify({ ...input, url, now }));
      await child.stdin.flush(); child.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(input.crashAfterCommit ? 73 : 0);
      return stdout ? JSON.parse(stdout) as { claimed?: boolean; acknowledged?: boolean; reconciled?: boolean } : null;
    } finally { clearTimeout(timeout); child.kill(); }
  }

  test('create/resume atomically schedule one deterministic deadline; pause/cancel retire old pending work', async () => {
    const began = now;
    let timer = await create(), scheduled = await due(timer);
    expect(scheduled).toMatchObject({ eventType: TIMER_DUE, aggregateType: 'Timer', aggregateId: timer.timerId,
      aggregateRevision: '1', payloadVersion: 1, status: 'pending', availableAt: new Date(began + 10_000) });
    expect(parseTimerDue(scheduled)).toMatchObject({ timerId: timer.timerId, version: 1 });
    const before = await snapshot();
    await worker.reconcile(); await worker.reconcile();
    expect(await snapshot()).toEqual(before);
    now += 3000;
    timer = await command('pause', mutation(timer));
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: scheduled.eventId } })).status).not.toBe('pending');
    expect(await p.outboxEvent.count({ where: { eventType: TIMER_DUE, status: 'pending' } })).toBe(0);
    now += 5000;
    timer = await command('resume', mutation(timer));
    const resumed = await due(timer);
    expect(resumed.eventId).not.toBe(scheduled.eventId);
    expect(resumed).toMatchObject({ aggregateRevision: '3', status: 'pending', availableAt: new Date(now + 7000) });
    scheduled = resumed;
    timer = await command('cancel', mutation(timer));
    expect(timer.status).toBe('cancelled');
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: scheduled.eventId } })).status).not.toBe('pending');
    expect(await p.outboxEvent.count({ where: { eventType: TIMER_DUE, status: 'pending' } })).toBe(0);
  });

  test('healthy scheduled timers take a read-only reconciliation fastpath, including startup checks', async () => {
    for (let index = 0; index < 16; index++) await create(60_000 + index * 1000);
    const before = await snapshot();
    writes.length = 0;
    await worker.reconcile();
    await worker.reconcile(true);
    await worker.reconcile();
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  test('failed deadline insertion rolls back create and resume with their domain change events', async () => {
    await p.$executeRawUnsafe(`CREATE TRIGGER reject_timer_due BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'timer.completion.due' BEGIN SELECT RAISE(ABORT, 'scheduling fixture rollback'); END`);
    const empty = await snapshot();
    try { await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(empty); }
    finally { await p.$executeRawUnsafe('DROP TRIGGER reject_timer_due'); }
    let timer = await create();
    timer = await command('pause', mutation(timer));
    const paused = await snapshot();
    await p.$executeRawUnsafe(`CREATE TRIGGER reject_timer_due BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'timer.completion.due' BEGIN SELECT RAISE(ABORT, 'scheduling fixture rollback'); END`);
    try { await expect(command('resume', mutation(timer))).rejects.toThrow(); expect(await snapshot()).toEqual(paused); }
    finally { await p.$executeRawUnsafe('DROP TRIGGER reject_timer_due'); }
    expect((await command('resume', mutation(timer))).status).toBe('running');
  });

  test('clock-only reads remain read-only across expiry; completion uses the committed deadline', async () => {
    const timer = await create(1000), scheduled = await due(timer), before = await snapshot();
    now += 60_000;
    writes.length = 0;
    expect((await timers.listForDevice(principal)).timers).toEqual([timer]);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const event = await claim(scheduled);
    await worker.completeDue(event);
    const row = await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } });
    expect(row).toMatchObject({ version: 2, status: 'completed', completedAt: new Date(timer.endsAt!), evaluatedAt: new Date(now) });
    expect(await p.outboxEvent.count({ where: { eventType: TIMER_CHANGED, aggregateId: timer.timerId } })).toBe(2);
    expect(await store.ack(event, new Date(now))).toBe(true);
  });

  test('expired and replaced claim tokens cannot commit timer or outbox changes', async () => {
    const timer = await create(1000);
    now += 1000;
    const event = await claim(await due(timer));
    await p.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(Date.now() - 1) } });
    let before = await snapshot();
    await expect(worker.completeDue(event)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await p.outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(now + 30_000), claimToken: randomUUID() } });
    before = await snapshot();
    await expect(worker.completeDue(event)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  test('superseded but legitimately claimed deadline cannot complete a paused timer', async () => {
    let timer = await create(1000);
    const began = now;
    now += 1000;
    const event = await claim(await due(timer));
    now = began + 500;
    timer = await command('pause', mutation(timer));
    now = began + 1000;
    await worker.completeDue(event);
    expect(await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).toMatchObject({
      status: 'paused', version: 2, endsAt: null, pausedRemainingMs: 500,
    });
    expect(await p.outboxEvent.count({ where: { eventType: TIMER_CHANGED, aggregateId: timer.timerId } })).toBe(2);
  });

  test('abort before execution and after actual completion writes leaves no partial transaction', async () => {
    const timer = await create(1000);
    now += 1000;
    const event = await claim(await due(timer)), before = await snapshot();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(worker.completeDue(event, cancelled.signal)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const abort = new AbortController(), original = timers.completeInTransaction.bind(timers);
    const hook = spyOn(timers, 'completeInTransaction').mockImplementation(async (...args) => {
      const result = await original(...args);
      abort.abort();
      return result;
    });
    try {
      writes.length = 0;
      await expect(worker.completeDue(event, abort.signal)).rejects.toThrow();
      expect(writes.some(query => /UPDATE\s+.*[.`"]timers[`"]/i.test(query))).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally { hook.mockRestore(); }
    await worker.completeDue(event);
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).status).toBe('completed');
  });

  test('reconciliation restores missing future/overdue jobs without changing timer state or duplicating deadlines', async () => {
    const overdue = await create(1000), future = await create(60_000);
    const old = [await due(overdue), await due(future)];
    // Only delete known rows in this isolated test database to simulate lost scheduling metadata.
    for (const event of old) await p.outboxEvent.delete({ where: { eventId: event.eventId } });
    now += 5000;
    const timersBefore = await p.timer.findMany({ orderBy: { timerId: 'asc' } });
    await worker.reconcile();
    expect(await p.timer.findMany({ orderBy: { timerId: 'asc' } })).toEqual(timersBefore);
    for (const [index, timer] of [overdue, future].entries()) {
      expect(await due(timer)).toMatchObject({ eventId: old[index].eventId, eventType: TIMER_DUE,
        payload: old[index].payload, availableAt: old[index].availableAt, status: 'pending', attempts: 0 });
    }
    const restored = await snapshot();
    await worker.reconcile();
    expect(await snapshot()).toEqual(restored);
    const event = await claim(await due(overdue));
    await worker.completeDue(event);
    expect(await store.ack(event, new Date(now))).toBe(true);
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: overdue.timerId } })).status).toBe('completed');
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: future.timerId } })).status).toBe('running');
    expect(await store.claim('future-test', new Date(now), { eventId: old[1].eventId })).toBeNull();
  });

  test('ordinary reconciliation preserves dead letters; explicit startup recovery resets only current running deadlines', async () => {
    const timer = await create(1000), event = await due(timer);
    const other = await create(1000), obsolete = await due(other);
    await command('pause', mutation(other));
    await p.outboxEvent.updateMany({ where: { eventId: { in: [event.eventId, obsolete.eventId] } }, data: {
      status: 'dead-letter', attempts: 5, processedAt: new Date(now), lastError: 'fixture-safe-error',
    } });
    const before = await snapshot();
    await worker.reconcile();
    expect(await snapshot()).toEqual(before);
    await worker.reconcile(true);
    expect(await due(timer)).toMatchObject({ status: 'pending', attempts: 0, lastError: null, processedAt: null,
      claimOwner: null, claimToken: null, claimUntil: null });
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: obsolete.eventId } })).status).toBe('dead-letter');
    now += 1000;
    await worker.completeDue(await claim(await due(timer)));
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).status).toBe('completed');
  });

  test('a backward domain clock cannot complete early; the same claim succeeds at the exact deadline', async () => {
    const timer = await create(1000), event = await due(timer), began = now;
    now += 1000;
    const claimed = await claim(event);
    now = began - 1000;
    const before = await snapshot();
    await expect(worker.completeDue(claimed)).rejects.toThrow('TIMER_NOT_DUE');
    expect(await snapshot()).toEqual(before);
    now = began + 1000;
    await worker.completeDue(claimed);
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).completedAt).toEqual(new Date(timer.endsAt!));
  });

  test('dispatcher defers six early attempts to the original deadline without consuming retries or dead-lettering', async () => {
    const timer = await create(10_000), event = await due(timer), deadline = Date.parse(timer.endsAt!);
    const domainBefore = await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } });
    const changesBefore = await p.outboxEvent.findMany({ where: { eventType: TIMER_CHANGED }, orderBy: { eventId: 'asc' } });
    const dispatcher = new OutboxDispatcher(p as PrismaService, store,
      {} as never, {} as never, {} as never, {} as never, {} as never, worker);
    // Exercise the real dispatch/catch branch without starting its unrelated poll loop.
    (dispatcher as unknown as { stopped: boolean }).stopped = true;
    const fail = spyOn(store, 'fail');
    now -= 3_600_000;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        // Simulate a claim made just before the server's domain clock stepped back.
        const claimed = await store.claim('early-clock-fixture', new Date(deadline), { eventId: event.eventId });
        expect(claimed).not.toBeNull();
        expect(claimed!.attempts).toBe(1);
        await dispatcher.dispatch({ version: 1, eventId: event.eventId, claimToken: claimed!.claimToken! }, undefined, 'timer');
        expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).toMatchObject({
          status: 'pending', availableAt: new Date(deadline), attempts: 0,
          claimOwner: null, claimToken: null, claimUntil: null,
        });
        expect(await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).toEqual(domainBefore);
      }
      expect(fail).not.toHaveBeenCalled();
      expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(0);
      expect(await p.outboxEvent.findMany({ where: { eventType: TIMER_CHANGED }, orderBy: { eventId: 'asc' } })).toEqual(changesBefore);
      now = deadline;
      const claimed = await store.claim('on-time-fixture', new Date(now), { eventId: event.eventId });
      expect(claimed).not.toBeNull();
      await dispatcher.dispatch({ version: 1, eventId: event.eventId, claimToken: claimed!.claimToken! }, undefined, 'timer');
      expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).toMatchObject({ status: 'delivered', attempts: 1 });
      expect(await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).toMatchObject({
        version: 2, status: 'completed', completedAt: new Date(deadline),
      });
      expect(await p.outboxEvent.count({ where: { eventType: TIMER_CHANGED, aggregateId: timer.timerId } })).toBe(2);
      expect(fail).not.toHaveBeenCalled();
    } finally { fail.mockRestore(); }
  });

  test('lease expiry after actual domain writes rolls back completion and outbox effects', async () => {
    const timer = await create(1000);
    now += 1000;
    const event = await claim(await due(timer)), before = await snapshot();
    const original = timers.completeInTransaction.bind(timers);
    const hook = spyOn(timers, 'completeInTransaction').mockImplementation(async (...args) => {
      const result = await original(...args);
      // Expire this fixture claim inside the same transaction after real domain I/O.
      await args[0].outboxEvent.update({ where: { eventId: event.eventId }, data: { claimUntil: new Date(Date.now() - 1) } });
      return result;
    });
    try {
      writes.length = 0;
      await expect(worker.completeDue(event)).rejects.toThrow('OUTBOX_CLAIM_EXPIRED');
      expect(writes.some(query => /UPDATE\s+.*[.`"]timers[`"]/i.test(query))).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally { hook.mockRestore(); }
  });

  test('malformed deterministic job identity is rejected without touching any durable state', async () => {
    const timer = await create(1000);
    now += 1000;
    const event = await claim(await due(timer)), before = await snapshot();
    for (const bad of [{ ...event, eventId: '0'.repeat(64) }, { ...event, aggregateRevision: '2' },
      { ...event, payload: { timerId: timer.timerId, version: 1, dueAt: Date.parse(timer.endsAt!) + 1 } }]) {
      await expect(worker.completeDue(bad)).rejects.toThrow('OUTBOX_INVALID_PAYLOAD');
      expect(await snapshot()).toEqual(before);
    }
  });

  test('two actual worker processes using real store claims produce exactly one completion', async () => {
    const timer = await create(1000), event = await due(timer);
    now += 1000;
    const results = await Promise.all([
      processRun({ operation: 'claim', eventId: event.eventId }), processRun({ operation: 'claim', eventId: event.eventId }),
    ]);
    expect(results.filter(result => result?.claimed)).toHaveLength(1);
    expect(results.find(result => result?.claimed)?.acknowledged).toBe(true);
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } }))).toMatchObject({
      version: 2, status: 'completed', completedAt: new Date(timer.endsAt!),
    });
    expect(await p.outboxEvent.count({ where: { eventType: TIMER_CHANGED, aggregateId: timer.timerId } })).toBe(2);
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status).toBe('delivered');
  }, 30_000);

  test('crash after completion commit before ack is safely retried by a new worker process', async () => {
    const timer = await create(1000), event = await due(timer);
    now += 1000;
    await processRun({ operation: 'claim', eventId: event.eventId, crashAfterCommit: true });
    const completed = await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } });
    const changed = await p.outboxEvent.findMany({ where: { eventType: TIMER_CHANGED }, orderBy: { eventId: 'asc' } });
    expect(completed.status).toBe('completed');
    expect(changed).toHaveLength(2);
    expect((await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).status).toBe('processing');
    now += 31_000; // Logical claim expiry, no real-time sleep needed.
    expect((await processRun({ operation: 'claim', eventId: event.eventId }))?.acknowledged).toBe(true);
    expect(await p.timer.findUniqueOrThrow({ where: { timerId: timer.timerId } })).toEqual(completed);
    expect(await p.outboxEvent.findMany({ where: { eventType: TIMER_CHANGED }, orderBy: { eventId: 'asc' } })).toEqual(changed);
    expect(await p.outboxEffect.count({ where: { eventId: event.eventId } })).toBe(1);
    expect(await p.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).toMatchObject({ status: 'delivered', attempts: 2 });
  }, 30_000);

  test('fresh process startup reconstructs deadlines and completes overdue state after long downtime', async () => {
    const overdue = await create(1000), future = await create(604_800_000);
    const overdueId = (await due(overdue)).eventId, futureId = (await due(future)).eventId;
    for (const eventId of [overdueId, futureId]) await p.outboxEvent.delete({ where: { eventId } });
    now += 86_400_000;
    expect(await processRun({ operation: 'reconcile' })).toEqual({ reconciled: true });
    expect((await due(future)).availableAt).toEqual(new Date(future.endsAt!));
    expect((await processRun({ operation: 'claim', eventId: overdueId }))?.acknowledged).toBe(true);
    expect((await processRun({ operation: 'claim', eventId: futureId }))?.claimed).toBe(false);
    expect((await p.timer.findUniqueOrThrow({ where: { timerId: overdue.timerId } }))).toMatchObject({
      version: 2, completedAt: new Date(overdue.endsAt!), evaluatedAt: new Date(now),
    });
    const before = await snapshot();
    await processRun({ operation: 'reconcile' });
    expect(await snapshot()).toEqual(before);
  }, 30_000);
});
