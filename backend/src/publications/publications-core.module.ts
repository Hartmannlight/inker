import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicationCleanupService } from './publication-cleanup.service';
import { PublicationPersistenceService } from './publication-persistence.service';

@Module({ imports: [PrismaModule], providers: [PublicationPersistenceService, PublicationCleanupService],
  exports: [PublicationPersistenceService, PublicationCleanupService] })
export class PublicationsCoreModule {}
