import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OutboxEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  OUTBOX_POLICY as POLICY,
  parseOutboxEvent,
  retryDelay,
} from './outbox.types';

@Injectable()
export class OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  private fence(event: OutboxEvent, now: Date) {
    return {
      eventId: event.eventId,
      status: 'processing',
      claimToken: event.claimToken,
      claimOwner: event.claimOwner,
      claimUntil: { gt: now },
    };
  }

  async claim(owner: string, now = new Date()): Promise<OutboxEvent | null> {
    // CAS outside a read transaction avoids SQLite read-to-write lock upgrades.
    const eligible: Prisma.OutboxEventWhereInput = {
      OR: [
        { status: 'pending', availableAt: { lte: now } },
        {
          status: 'processing',
          OR: [{ claimUntil: { lte: now } }, { claimUntil: null }],
        },
      ],
    };
    const exhausted = await this.prisma.outboxEvent.findMany({
      where: { ...eligible, attempts: { gte: POLICY.maxAttempts } },
      take: POLICY.batchSize,
    });
    for (const row of exhausted)
      await this.prisma.outboxEvent.updateMany({
        where: {
          ...eligible,
          eventId: row.eventId,
          attempts: { gte: POLICY.maxAttempts },
        },
        data: {
          status: 'dead-letter',
          processedAt: now,
          claimToken: null,
          claimOwner: null,
          claimUntil: null,
          lastError: JSON.stringify({
            code: 'OUTBOX_ATTEMPTS_EXHAUSTED',
            correlationId: row.eventId,
          }),
        },
      });
    const candidate = await this.prisma.outboxEvent.findFirst({
      where: { ...eligible, attempts: { lt: POLICY.maxAttempts } },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
    });
    if (!candidate) return null;
    const claimToken = randomUUID();
    const claimed = await this.prisma.outboxEvent.updateMany({
      where: {
        ...eligible,
        eventId: candidate.eventId,
        attempts: candidate.attempts,
      },
      data: {
        status: 'processing',
        claimOwner: owner,
        claimToken,
        claimUntil: new Date(now.getTime() + POLICY.leaseMs),
        lastAttemptAt: now,
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return null;
    return this.prisma.outboxEvent.findUnique({
      where: { eventId: candidate.eventId },
    });
  }

  async current(event: OutboxEvent, now = new Date()) {
    return this.prisma.outboxEvent.findFirst({ where: this.fence(event, now) });
  }

  async ack(event: OutboxEvent, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.outboxEvent.updateMany({
        where: this.fence(event, now),
        data: {
          status: 'delivered',
          processedAt: now,
          lastError: null,
          claimToken: null,
          claimOwner: null,
          claimUntil: null,
        },
      });
      if (result.count)
        await tx.outboxEffect.updateMany({
          where: { eventId: event.eventId },
          data: { completedAt: now },
        });
      return result.count === 1;
    });
  }

  async fail(
    event: OutboxEvent,
    code: 'OUTBOX_INVALID_PAYLOAD' | 'OUTBOX_TRANSPORT_FAILED',
    now = new Date(),
    random = Math.random,
  ) {
    const dead =
      event.attempts >= POLICY.maxAttempts || code === 'OUTBOX_INVALID_PAYLOAD';
    const result = await this.prisma.outboxEvent.updateMany({
      where: this.fence(event, now),
      data: {
        status: dead ? 'dead-letter' : 'pending',
        processedAt: dead ? now : null,
        availableAt: new Date(
          now.getTime() + retryDelay(event.attempts, random),
        ),
        claimToken: null,
        claimOwner: null,
        claimUntil: null,
        lastError: JSON.stringify({ code, correlationId: event.eventId }),
      },
    });
    return result.count === 1;
  }

  async register(consumerId: string, now = new Date()) {
    const expiresAt = new Date(now.getTime() + POLICY.consumerLeaseMs);
    await this.prisma.outboxConsumer.upsert({
      where: { consumerId },
      create: { consumerId, expiresAt },
      update: { expiresAt },
    });
  }
  async unregister(consumerId: string) {
    await this.prisma.outboxConsumer.deleteMany({ where: { consumerId } });
  }

  async prepare(event: OutboxEvent) {
    const parsed = parseOutboxEvent(event);
    return this.prisma.$transaction(async (tx) => {
      // The first statement takes the write lock and fences the complete effect transaction.
      if (
        !(
          await tx.outboxEvent.updateMany({
            where: this.fence(event, new Date()),
            data: { claimOwner: event.claimOwner },
          })
        ).count
      ) {
        throw new Error('OUTBOX_CLAIM_EXPIRED');
      }
      const existing = await tx.outboxEffect.findUnique({
        where: { key: parsed.key },
      });
      if (existing)
        return { ...parsed, duplicate: existing.eventId !== event.eventId };
      await tx.outboxEffect.create({
        data: { key: parsed.key, eventId: event.eventId },
      });
      const devices = await tx.device.findMany({
        where: { id: { in: parsed.deviceIds } },
        select: { id: true },
      });
      if (devices.length)
        await tx.outboxDelivery.createMany({
          data: devices.map((d) => ({ effectKey: parsed.key, deviceId: d.id })),
        });
      const consumers = await tx.outboxConsumer.findMany({
        where: { expiresAt: { gt: new Date() } },
      });
      if (consumers.length)
        await tx.outboxTarget.createMany({
          data: consumers.map((c) => ({
            effectKey: parsed.key,
            consumerId: c.consumerId,
          })),
        });
      return { ...parsed, duplicate: false };
    });
  }

  async targetsComplete(key: string, now = new Date()) {
    const live = await this.prisma.outboxConsumer.findMany({
      where: { expiresAt: { gt: now } },
      select: { consumerId: true },
    });
    // A dead process has no surviving sockets. Reconnecting clients read current DB state.
    return (
      (await this.prisma.outboxTarget.count({
        where: {
          effectKey: key,
          delivered: false,
          consumerId: { in: live.map((c) => c.consumerId) },
        },
      })) === 0
    );
  }

  async pendingTargets(consumerId: string) {
    const processing = await this.prisma.outboxEvent.findMany({
      where: { status: 'processing', claimUntil: { gt: new Date() } },
      select: { eventId: true },
    });
    return this.prisma.outboxTarget.findMany({
      where: {
        consumerId,
        delivered: false,
        effect: { eventId: { in: processing.map((e) => e.eventId) } },
      },
      include: { effect: { include: { deliveries: true } } },
      take: POLICY.batchSize,
    });
  }

  async beginTarget(key: string, consumerId: string, event: OutboxEvent) {
    if (!(await this.current(event))) return false;
    return (
      (
        await this.prisma.outboxTarget.updateMany({
          where: {
            effectKey: key,
            consumerId,
            delivered: false,
            OR: [
              { attemptToken: null },
              { attemptToken: { not: event.claimToken } },
            ],
          },
          data: { attemptToken: event.claimToken, lastError: null },
        })
      ).count === 1
    );
  }

  async finishTarget(
    key: string,
    consumerId: string,
    event: OutboxEvent,
    success: boolean,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (
        !(
          await tx.outboxEvent.updateMany({
            where: this.fence(event, new Date()),
            data: { claimOwner: event.claimOwner },
          })
        ).count
      )
        return false;
      return (
        (
          await tx.outboxTarget.updateMany({
            where: {
              effectKey: key,
              consumerId,
              attemptToken: event.claimToken,
            },
            data: {
              delivered: success,
              lastError: success ? null : 'OUTBOX_ADAPTER_FAILED',
            },
          })
        ).count === 1
      );
    });
  }

  async targetFailed(key: string, claimToken: string) {
    return (
      (await this.prisma.outboxTarget.count({
        where: {
          effectKey: key,
          delivered: false,
          attemptToken: claimToken,
          lastError: { not: null },
        },
      })) > 0
    );
  }
}
