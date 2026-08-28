import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OutboxStore } from '../../src/events/outbox.store';
import { TimerService } from '../../src/timers/timer.service';
import { TimerWorkerService } from '../../src/timers/timer-worker.service';
import { TIMER_DUE } from '../../src/timers/timer-scheduling';

const chunks: Uint8Array[] = [];
let bytes = 0;
for await (const chunk of Bun.stdin.stream()) {
  bytes += chunk.byteLength;
  if (bytes > 16_384) throw new Error('TIMER_WORKER_FIXTURE_INPUT_LIMIT');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString()) as {
  url: string; now: number; operation: 'claim' | 'reconcile'; eventId?: string; crashAfterCommit?: boolean;
};
const p = new PrismaClient({ datasources: { db: { url: input.url } } });
try {
  const clock = { now: () => input.now }, timers = new TimerService(p as PrismaService, clock);
  const worker = new TimerWorkerService(p as PrismaService, timers, clock), store = new OutboxStore(p as PrismaService);
  if (input.operation === 'reconcile') {
    await worker.reconcile(true);
    process.stdout.write(JSON.stringify({ reconciled: true }));
  } else {
    const event = await store.claim(randomUUID(), new Date(input.now), {
      eventType: TIMER_DUE, ...(input.eventId ? { eventId: input.eventId } : {}),
    });
    if (!event) process.stdout.write(JSON.stringify({ claimed: false }));
    else {
      await worker.completeDue(event);
      // Deliberately terminate after durable domain/effect commit, before ack.
      if (input.crashAfterCommit) process.exit(73);
      const acknowledged = await store.ack(event, new Date(input.now));
      process.stdout.write(JSON.stringify({ claimed: true, eventId: event.eventId, acknowledged }));
    }
  }
} finally { await p.$disconnect(); }
