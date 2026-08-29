import { Injectable } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { effectKey } from '../events/outbox.types';
import { QUEUE_POLICIES } from '../jobs/queue-policy';
import { TimerClock, TimerService } from './timer.service';
import { parseTimerDue, scheduleTimer, timerCompletionId } from './timer-scheduling';
import { sqliteWrite } from '../sources/source-writes';

@Injectable()
export class TimerWorkerService {
  constructor(private readonly prisma: PrismaService, private readonly timers: TimerService, private readonly clock: TimerClock) {}

  async reconcile(recoverDeadLetters = false) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.timer.findMany({ where: { status: 'running', ...(cursor ? { timerId: { gt: cursor } } : {}) },
        orderBy: { timerId: 'asc' }, select: { timerId: true, version: true, endsAt: true }, take: 100 });
      for (const { timerId, version, endsAt } of rows) {
        if (!endsAt) throw new Error('TIMER_INVALID_STATE');
        const existing = await this.prisma.outboxEvent.findUnique({ where: {
          eventId: timerCompletionId(timerId, version, endsAt.getTime()),
        }, select: { status: true } });
        if (existing && !(recoverDeadLetters && existing.status === 'dead-letter')) continue;
        await sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
        await tx.$executeRaw`UPDATE outbox_events SET event_id = event_id WHERE 1 = 0`;
        const current = await tx.timer.findUnique({ where: { timerId } });
        if (current?.status === 'running') await scheduleTimer(tx, current, recoverDeadLetters);
        }));
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].timerId;
    }
  }

  /** A wall-clock correction is not a failed job and must not consume retries. */
  async deferEarly(event: OutboxEvent): Promise<boolean> {
    const input = parseTimerDue(event);
    if (!event.claimOwner || !event.claimToken || this.clock.now() >= input.dueAt) return false;
    return sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      const result = await tx.outboxEvent.updateMany({ where: { eventId: event.eventId, status: 'processing',
        claimOwner: event.claimOwner, claimToken: event.claimToken, claimUntil: { gt: new Date() }, attempts: { gt: 0 } },
      data: { status: 'pending', availableAt: new Date(input.dueAt), attempts: { decrement: 1 },
        claimOwner: null, claimToken: null, claimUntil: null, lastError: null } });
      return result.count === 1;
    }));
  }

  async completeDue(event: OutboxEvent, signal?: AbortSignal) {
    const check = () => { if (signal?.aborted) throw new Error('TIMER_ABORTED'); };
    check();
    const input = parseTimerDue(event);
    if (!event.claimOwner || !event.claimToken) throw new Error('OUTBOX_CLAIM_EXPIRED');
    const key = effectKey(event.eventType, event.aggregateType, event.aggregateId, event.aggregateRevision!);
    await sqliteWrite(this.prisma, () => this.prisma.$transaction(async tx => {
      check();
      // Lease time is wall-clock time; TimerClock may be controlled for domain tests.
      const fence = { eventId: event.eventId, status: 'processing', claimOwner: event.claimOwner,
        claimToken: event.claimToken, claimUntil: { gt: new Date() } };
      if (!(await tx.outboxEvent.updateMany({ where: fence, data: { claimOwner: event.claimOwner } })).count)
        throw new Error('OUTBOX_CLAIM_EXPIRED');
      if (await tx.outboxEffect.findUnique({ where: { key } })) return;
      const now = this.clock.now();
      await this.timers.completeInTransaction(tx, input.timerId, input.version, input.dueAt, now);
      check();
      // Recheck the lease after domain I/O: a late result must roll back all writes.
      if (!(await tx.outboxEvent.count({ where: { ...fence, claimUntil: { gt: new Date() } } }))) throw new Error('OUTBOX_CLAIM_EXPIRED');
      await tx.outboxEffect.create({ data: { key, eventId: event.eventId, completedAt: new Date(now) } });
      check();
    }, { timeout: QUEUE_POLICIES.timer.timeoutMs }));
  }
}
