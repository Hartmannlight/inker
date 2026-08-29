import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const LOG_RETENTION_DAYS = 30;
export const MAINTENANCE_BATCH_SIZE = 64;

/**
 * Log Cleanup Service
 * Deletes device logs older than the retention window. MaintenanceService owns
 * the durable schedule and supplies its fixed slot time and transaction.
 */
@Injectable()
export class LogCleanupService {
  constructor(private prisma: PrismaService) {}

  async cleanup(now = new Date(), transaction?: Prisma.TransactionClient) {
    let deleted = 0;
    const run = async (tx: Prisma.TransactionClient) => {
      for (;;) {
        const batch = await this.cleanupBatch(now, tx);
        deleted += batch.deleted;
        if (batch.done) return;
      }
    };
    if (transaction) await run(transaction);
    else await this.prisma.$transaction(run);
    return { deleted };
  }

  async cleanupBatch(now: Date, transaction: Prisma.TransactionClient, limit = MAINTENANCE_BATCH_SIZE) {
    const cutoff = new Date(
      now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows = await transaction.deviceLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { id: 'asc' }, take: limit, select: { id: true },
    });
    const result = rows.length ? await transaction.deviceLog.deleteMany({
      where: { id: { in: rows.map(row => row.id) } },
    }) : { count: 0 };
    return { deleted: result.count, done: rows.length < limit };
  }
}
