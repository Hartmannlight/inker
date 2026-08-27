import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsService } from './events.service';
import { OutboxStore } from './outbox.store';

/** Durable event commands and persistence, without HTTP/SSE controllers. */
@Global()
@Module({ imports: [PrismaModule], providers: [EventsService, OutboxStore], exports: [EventsService, OutboxStore] })
export class EventsCoreModule {}
