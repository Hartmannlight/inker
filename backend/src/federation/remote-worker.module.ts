import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicationsCoreModule } from '../publications/publications-core.module';
import { EventsCoreModule } from '../events/events-core.module';
import { RemoteWorkerService } from './remote-worker.service';
import { RemoteImportService } from './remote-import.service';

@Module({ imports: [PrismaModule, PublicationsCoreModule, EventsCoreModule], providers: [RemoteWorkerService, RemoteImportService], exports: [RemoteWorkerService] })
export class RemoteWorkerModule {}
