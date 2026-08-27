import { Module } from '@nestjs/common';
import { LogCleanupService } from './services/log-cleanup.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicationsCoreModule } from '../publications/publications-core.module';
import { MaintenanceService } from './maintenance.service';

/**
 * Jobs Module
 * Worker-only maintenance. Scheduling is persisted by MaintenanceService.
 */
@Module({
  imports: [PrismaModule, PublicationsCoreModule],
  providers: [LogCleanupService, MaintenanceService],
  exports: [LogCleanupService, MaintenanceService],
})
export class JobsModule {}
