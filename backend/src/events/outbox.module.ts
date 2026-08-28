import { Module } from '@nestjs/common';
import { EventsCoreModule } from './events-core.module';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { PlaybackCoreModule } from '../playback/playback-core.module';
import { RenderCacheModule } from '../render-cache/render-cache.module';
import { OutboxTransportModule } from './outbox-transport.module';
import { JobsModule } from '../jobs/jobs.module';
import { SourceWorkerModule } from '../sources/source-worker.module';
import { TimerWorkerModule } from '../timers/timer-worker.module';
import { RemoteWorkerModule } from '../federation/remote-worker.module';

@Module({
  imports: [EventsCoreModule, PlaybackCoreModule, RenderCacheModule, OutboxTransportModule, JobsModule, SourceWorkerModule, TimerWorkerModule, RemoteWorkerModule],
  providers: [OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class OutboxModule {}
