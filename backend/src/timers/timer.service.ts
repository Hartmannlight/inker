import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { parseTimerCreatePayload, parseTimerMutationPayload, parseTimerSnapshot, TIMER_LIMITS, type TimerSnapshot } from '@inker/contracts';
import { Prisma, type Timer } from '@prisma/client';
import type { CommandPrincipal } from '../interactions/command-registry';
import { PrismaService } from '../prisma/prisma.service';
import { transitionTimer, type TimerAnchor, type TimerAction } from './timer-domain';
import { TIMER_CHANGED, type TIMER_REASONS } from './timer.events';
import { scheduleTimer } from './timer-scheduling';
import { intentCorrelationId } from '../events/outbox-correlation';

type Tx = Prisma.TransactionClient;
type DevicePrincipal = Pick<CommandPrincipal, 'deviceId' | 'externalId'>;
export type TimerCommandAction = Exclude<TimerAction, 'complete'>;
const outstanding: Prisma.TimerWhereInput = { OR: [
  { status: { in: ['running', 'paused'] } }, { status: 'completed', acknowledgedAt: null },
] };
const visible = (deviceId: number): Prisma.TimerWhereInput => ({ OR: [{ creatorDeviceId: deviceId }, { visibility: 'shared' }] });
const timestamp = (value: Date | null) => value?.getTime() ?? null;
const date = (value: number | null) => value === null ? null : new Date(value);

@Injectable()
export class TimerClock { now() { return Date.now(); } }

@Injectable()
export class TimerService {
  constructor(private readonly prisma: PrismaService, private readonly clock: TimerClock) {}

  private async principal(tx: Tx, principal: DevicePrincipal) {
    if (!await tx.device.findFirst({ where: { id: principal.deviceId, externalId: principal.externalId, isActive: true }, select: { id: true } }))
      throw new NotFoundException('TIMER_NOT_FOUND');
  }
  private anchor(row: Timer): TimerAnchor {
    return { version: row.version, status: row.status as TimerAnchor['status'], durationMs: row.durationMs,
      startedAt: row.startedAt.getTime(), endsAt: timestamp(row.endsAt), pausedRemainingMs: row.pausedRemainingMs,
      evaluatedAt: row.evaluatedAt.getTime(), completedAt: timestamp(row.completedAt),
      cancelledAt: timestamp(row.cancelledAt), acknowledgedAt: timestamp(row.acknowledgedAt) };
  }
  private data(anchor: TimerAnchor) {
    return { version: anchor.version, status: anchor.status, durationMs: anchor.durationMs, startedAt: new Date(anchor.startedAt),
      endsAt: date(anchor.endsAt), pausedRemainingMs: anchor.pausedRemainingMs, evaluatedAt: new Date(anchor.evaluatedAt),
      completedAt: date(anchor.completedAt), cancelledAt: date(anchor.cancelledAt), acknowledgedAt: date(anchor.acknowledgedAt) };
  }
  private snapshot(row: Timer): TimerSnapshot {
    const result = parseTimerSnapshot({ timerId: row.timerId, version: row.version,
      creatorDeviceId: row.creatorExternalId, visibility: row.visibility, status: row.status, durationMs: row.durationMs,
      startedAt: row.startedAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null,
      pausedRemainingMs: row.pausedRemainingMs, evaluatedAt: row.evaluatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, acknowledgedByDeviceId: row.acknowledgedByExternalId });
    if (!result.success) throw new Error('TIMER_INVALID_STATE');
    return result.data;
  }
  private transition(previous: TimerAnchor | null, action: TimerCommandAction, now: number, durationMs?: number) {
    try { return transitionTimer(previous, action, now, durationMs); }
    catch (error) {
      if (error instanceof Error && ['TIMER_INVALID_TRANSITION', 'TIMER_VERSION_EXHAUSTED'].includes(error.message))
        throw new ConflictException('TIMER_STATE_CONFLICT');
      throw error; // Corrupt persisted state or invalid server clock must roll everything back.
    }
  }
  private async changed(tx: Tx, row: Timer, reason: typeof TIMER_REASONS[number]) {
    const correlationId = intentCorrelationId();
    await scheduleTimer(tx, row, false, correlationId);
    await tx.outboxEvent.create({ data: { correlationId, eventType: TIMER_CHANGED, aggregateType: 'Timer', aggregateId: row.timerId,
      aggregateRevision: String(row.version), payloadVersion: 1, payload: { timerId: row.timerId, version: row.version, reason },
      occurredAt: row.evaluatedAt, availableAt: row.evaluatedAt } });
  }

  /** Caller owns command receipt and transaction. All writes stay on that tx. */
  async executeInTransaction(tx: Tx, principal: DevicePrincipal, action: TimerCommandAction, payload: unknown): Promise<TimerSnapshot> {
    await tx.$executeRaw`UPDATE devices SET id = id WHERE id = ${principal.deviceId}`;
    await this.principal(tx, principal);
    const now = this.clock.now();
    if (action === 'create') {
      const input = parseTimerCreatePayload(payload);
      if (!input.success) throw new BadRequestException('TIMER_INVALID_PAYLOAD');
      // Unreachable private timers of deleted devices do not consume usable capacity.
      const globalWhere: Prisma.TimerWhereInput = { AND: [outstanding, { OR: [{ visibility: 'shared' }, { creatorDeviceId: { not: null } }] }] };
      if (await tx.timer.count({ where: globalWhere }) >= TIMER_LIMITS.activeGlobal
        || await tx.timer.count({ where: { AND: [outstanding, { creatorDeviceId: principal.deviceId }] } }) >= TIMER_LIMITS.activePerDevice)
        throw new ConflictException('TIMER_LIMIT_REACHED');
      const next = this.transition(null, action, now, input.data.durationMs);
      const row = await tx.timer.create({ data: { ...this.data(next.state), creatorDeviceId: principal.deviceId,
        creatorExternalId: principal.externalId, visibility: input.data.visibility } });
      await this.changed(tx, row, 'created');
      return this.snapshot(row);
    }
    if (!['pause', 'resume', 'cancel', 'acknowledge'].includes(action)) throw new BadRequestException('TIMER_INVALID_PAYLOAD');
    const input = parseTimerMutationPayload(payload);
    if (!input.success) throw new BadRequestException('TIMER_INVALID_PAYLOAD');
    const previous = await tx.timer.findFirst({ where: { AND: [{ timerId: input.data.timerId }, visible(principal.deviceId)] } });
    if (!previous) throw new NotFoundException('TIMER_NOT_FOUND');
    if (previous.version !== input.data.expectedVersion) throw new ConflictException('TIMER_STATE_CONFLICT');
    const next = this.transition(this.anchor(previous), action, now);
    if (!next.changed) return this.snapshot(previous);
    const acknowledgement = next.state.acknowledgedAt !== null && previous.acknowledgedAt === null
      ? { acknowledgedByDeviceId: principal.deviceId, acknowledgedByExternalId: principal.externalId } : {};
    const row = await tx.timer.update({ where: { timerId: previous.timerId }, data: { ...this.data(next.state), ...acknowledgement } });
    await this.changed(tx, row, next.reason!);
    return this.snapshot(row);
  }

  /** Only the fenced worker invokes this within its completion transaction. */
  async completeInTransaction(tx: Tx, timerId: string, version: number, dueAt: number, now: number) {
    const previous = await tx.timer.findUnique({ where: { timerId } });
    if (!previous || previous.status !== 'running' || previous.version !== version || previous.endsAt?.getTime() !== dueAt) return;
    if (now < dueAt) throw new Error('TIMER_NOT_DUE');
    const next = transitionTimer(this.anchor(previous), 'complete', now);
    if (!next.changed) return;
    const row = await tx.timer.update({ where: { timerId }, data: this.data(next.state) });
    await this.changed(tx, row, 'completed');
  }

  /** No tick writes or implicit completion. */
  async listForDevice(principal: DevicePrincipal) {
    await this.principal(this.prisma, principal);
    return this.listForAuthenticatedDevice(principal.deviceId);
  }

  /** Read-only pull credentials may identify legacy devices without externalId. */
  async listForAuthenticatedDevice(deviceId: number) {
    if (!Number.isSafeInteger(deviceId) || deviceId < 1 || !await this.prisma.device.findFirst({
      where: { id: deviceId, isActive: true }, select: { id: true },
    })) throw new NotFoundException('TIMER_NOT_FOUND');
    const rows = await this.prisma.timer.findMany({ where: { AND: [outstanding, visible(deviceId)] },
      orderBy: [{ startedAt: 'asc' }, { timerId: 'asc' }], take: TIMER_LIMITS.maxRows });
    return { protocolVersion: '1.0' as const, serverTime: new Date(this.clock.now()).toISOString(), timers: rows.map(row => this.snapshot(row)) };
  }
}
