import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const LOG_RETENTION_DAYS = 30;

/**
 * Log Cleanup Service
 * Deletes device logs older than the retention window. MaintenanceService owns
 * the durable schedule and supplies its fixed slot time and transaction.
 */
@Injectable()
export class LogCleanupService {
  constructor(private prisma: PrismaService) {}

  async cleanup(now = new Date(), transaction?: Prisma.TransactionClient) {
    const cutoff = new Date(
      now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await (transaction ?? this.prisma).deviceLog.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });

    return { deleted: result.count };
  }
}
