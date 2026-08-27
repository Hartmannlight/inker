import { Module } from '@nestjs/common';
import { EventsModule } from './events.module';
import { PublicationsModule } from '../publications/publications.module';
import { DevicePlatformModule } from '../device-platform/device-platform.module';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { OutboxRedisService } from './outbox-redis.service';
import { PlaybackModule } from '../playback/playback.module';

@Module({
  imports: [EventsModule, PublicationsModule, DevicePlatformModule, PlaybackModule],
  providers: [OutboxDispatcher, OutboxRedisService],
  exports: [OutboxDispatcher],
})
export class OutboxModule {}
