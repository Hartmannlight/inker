import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PublicationCleanupService } from "./publication-cleanup.service";
import { PublicationPersistenceService } from "./publication-persistence.service";
import { PublishService } from './publish.service';
import { PublicationsController } from './publications.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PublicationsController],
  providers: [PublicationPersistenceService, PublicationCleanupService, PublishService],
  exports: [PublicationPersistenceService, PublicationCleanupService],
})
export class PublicationsModule {}
