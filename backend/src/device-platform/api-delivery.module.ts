import { Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { OutboxTransportModule } from '../events/outbox-transport.module';
import { OutboxRedisService } from '../events/outbox-redis.service';
import { DevicePlatformModule } from './device-platform.module';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';

/** Socket ownership stays in the API even while every background worker is down. */
@Injectable()
export class ApiDeliveryLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private stopTask?: Promise<void>;
  constructor(private readonly consumer: DeviceUpdateCoordinator, private readonly redis: OutboxRedisService) {}
  async onApplicationBootstrap() {
    await this.consumer.start();
    this.redis.startHints(() => this.consumer.wake());
  }
  stop() { return this.stopTask ??= this.consumer.stop(); }
  onModuleDestroy() { return this.stop(); }
}

@Module({ imports: [EventsCoreModule, DevicePlatformModule, OutboxTransportModule],
  providers: [ApiDeliveryLifecycle], exports: [ApiDeliveryLifecycle] })
export class ApiDeliveryModule {}
