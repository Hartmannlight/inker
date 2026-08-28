import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, type OutboxEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicationCleanupService } from '../publications/publication-cleanup.service';
import { LogCleanupService } from './services/log-cleanup.service';
import { JOB_VERSION, jobId } from './queue-policy';
import { intentCorrelationId } from '../events/outbox-correlation';

export const MAINTENANCE_DUE = 'maintenance.cleanup.due';
const HOUR_MS = 3_600_000;

function slot(now: Date): number {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('OUTBOX_INVALID_PAYLOAD');
  }
  return Math.floor(timestamp / HOUR_MS);
}

function receiptKey(hour: number): string {
  return createHash('sha256')
    .update(JSON.stringify([MAINTENANCE_DUE, 'Maintenance', 'cleanup', String(hour)]))
    .digest('hex');
}

function scheduledTime(event: OutboxEvent): Date {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).join(',') !== 'scheduledAt'
    || typeof payload.scheduledAt !== 'number') {
    throw new Error('OUTBOX_INVALID_PAYLOAD');
  }
  const now = new Date(payload.scheduledAt);
  const hour = slot(now);
  if (payload.scheduledAt !== hour * HOUR_MS
    || event.eventType !== MAINTENANCE_DUE || event.payloadVersion !== JOB_VERSION
    || event.aggregateType !== 'Maintenance' || event.aggregateId !== 'cleanup'
    || event.aggregateRevision !== String(hour) || event.eventId !== `maintenance-v1-${hour}`) {
    throw new Error('OUTBOX_INVALID_PAYLOAD');
  }
  return now;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('MAINTENANCE_ABORTED');
}

/** Database intent and receipt survive worker, queue and process restarts. */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogCleanupService,
    private readonly publications: PublicationCleanupService,
  ) {}

  async schedule(now = new Date()): Promise<OutboxEvent | null> {
    const hour = slot(now);
    const eventId = `maintenance-v1-${hour}`;
    // Repeated dispatcher polls are reads. The unique event key resolves races
    // between independent workers without an in-memory scheduling cursor.
    const existing = await this.prisma.outboxEvent.findUnique({ where: { eventId } });
    if (existing) return existing;
    if (await this.prisma.outboxEffect.findUnique({ where: { eventId } })) return null;
    const scheduledAt = hour * HOUR_MS;
    try {
      return await this.prisma.outboxEvent.create({ data: {
        correlationId: intentCorrelationId(),
        eventId, eventType: MAINTENANCE_DUE, aggregateType: 'Maintenance',
        aggregateId: 'cleanup', aggregateRevision: String(hour), payloadVersion: JOB_VERSION,
        payload: { scheduledAt }, availableAt: new Date(scheduledAt), occurredAt: new Date(scheduledAt),
      } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.outboxEvent.findUnique({ where: { eventId } });
      }
      throw error;
    }
  }

  async execute(event: OutboxEvent, signal?: AbortSignal) {
    const scheduledAt = scheduledTime(event);
    checkAbort(signal);
    if (!event.claimToken || !event.claimOwner || event.status !== 'processing' || !event.claimUntil) {
      throw new Error('MAINTENANCE_STALE_CLAIM');
    }
    try { jobId(event.eventId, event.claimToken); }
    catch { throw new Error('MAINTENANCE_STALE_CLAIM'); }

    return this.prisma.$transaction(async transaction => {
      const fence = () => ({
        eventId: event.eventId, status: 'processing', claimToken: event.claimToken,
        claimOwner: event.claimOwner, claimUntil: { gt: new Date() },
      });
      const assertLease = async () => {
        checkAbort(signal);
        // First statement takes SQLite's write lock; a later claimant cannot
        // replace this fence while retention and its receipt are committed.
        const current = await transaction.outboxEvent.updateMany({
          where: fence(), data: { claimToken: event.claimToken },
        });
        if (current.count !== 1) throw new Error('MAINTENANCE_STALE_CLAIM');
      };
      await assertLease();
      const persisted = await transaction.outboxEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
      if (scheduledTime(persisted).getTime() !== scheduledAt.getTime()) {
        throw new Error('OUTBOX_INVALID_PAYLOAD');
      }
      const key = receiptKey(slot(scheduledAt));
      const previous = await transaction.outboxEffect.findUnique({ where: { key } });
      if (previous?.completedAt) {
        checkAbort(signal);
        return { duplicate: true, deviceLogs: 0, deliveredOutboxEvents: 0,
          deadLetterOutboxEvents: 0, publicationRevisions: 0 };
      }
      await transaction.outboxEffect.upsert({
        where: { key }, create: { key, eventId: event.eventId }, update: {},
      });
      checkAbort(signal);
      // The original UTC slot is the cutoff anchor, not the retry time.
      const logs = await this.logs.cleanup(scheduledAt, transaction);
      checkAbort(signal);
      const publications = await this.publications.cleanup(scheduledAt, transaction);
      await transaction.outboxEffect.update({ where: { key }, data: { completedAt: new Date() } });
      await assertLease();
      // The dispatcher owns the separately fenced job acknowledgement.
      return { duplicate: false, deviceLogs: logs.deleted, ...publications };
    });
  }
}
