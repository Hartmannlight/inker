import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsCoreModule } from '../events/events-core.module';
import { SourceWorkerService } from './source-worker.service';

@Module({ imports: [PrismaModule, EventsCoreModule], providers: [SourceWorkerService], exports: [SourceWorkerService] })
export class SourceWorkerModule {}
