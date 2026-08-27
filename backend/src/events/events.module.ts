import { Module, Global } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxStore } from './outbox.store';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [EventsController],
  providers: [EventsService, OutboxStore],
  exports: [EventsService, OutboxStore],
})
export class EventsModule {}
