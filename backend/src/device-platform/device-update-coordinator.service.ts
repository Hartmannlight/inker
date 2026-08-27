import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { ProfileResolverService } from './profile-resolver.service';
import { TransportAdapterRegistry } from './transport-adapter.registry';

@Injectable()
export class DeviceUpdateCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceUpdateCoordinator.name);
  private subscription?: Subscription;

  constructor(
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileResolverService,
    private readonly deliveryPolicies: DeliveryPolicyRegistry,
    private readonly transports: TransportAdapterRegistry,
  ) {}

  onModuleInit() {
    this.subscription = this.events.getEventStream().subscribe((event) => {
      const deviceIds = event.payload.deviceIds ?? [];
      if (deviceIds.length) void this.refreshDevices(deviceIds).catch(() => {
        this.logger.warn('Device update dispatch failed');
      });
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  async refreshDevices(deviceIds: number[]) {
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds }, isActive: true },
      include: { profile: true, deliveryPolicy: true },
    });
    let dispatched = 0;
    await Promise.all(devices.map(async (device) => {
      const configuration = this.profiles.resolvePersisted(device);
      const policy = this.deliveryPolicies.get(configuration.deliveryPolicy.mode);
      if (!policy.dispatchOnRefresh) return;
      const adapter = this.transports.get(policy.selectTransport(configuration.capabilities));
      await adapter.dispatchRefresh(device.id);
      dispatched += 1;
    }));
    this.logger.debug(`Dispatched update to ${dispatched} device transports`);
  }
}
