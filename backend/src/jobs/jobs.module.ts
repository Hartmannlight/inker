import { Module } from '@nestjs/common';
import { LogCleanupService } from './services/log-cleanup.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Jobs Module
 * Manages background jobs using in-process scheduling (@nestjs/schedule)
 */
@Module({
  imports: [PrismaModule],
  providers: [LogCleanupService],
  exports: [LogCleanupService],
})
export class JobsModule {}
