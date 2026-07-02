import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

const LOG_RETENTION_DAYS = 30;

/**
 * Log Cleanup Service
 * Deletes device logs older than the retention window. Runs daily via an
 * in-process cron, plus once shortly after startup.
 */
@Injectable()
export class LogCleanupService implements OnModuleInit {
  private readonly logger = new Logger(LogCleanupService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    this.logger.log('Device log cleanup scheduled (daily)');
    // Run once shortly after startup without blocking boot
    setTimeout(() => {
      void this.cleanup();
    }, 30000);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanup() {
    const cutoff = new Date(
      Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    this.logger.log(`Cleaning up device logs older than ${cutoff.toISOString()}`);

    const result = await this.prisma.deviceLog.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });

    this.logger.log(`Deleted ${result.count} old device log entries`);

    return { deleted: result.count };
  }
}
