import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsCoreModule } from './events-core.module';

@Module({
  imports: [EventsCoreModule],
  controllers: [EventsController],
  exports: [EventsCoreModule],
})
export class EventsModule {}
