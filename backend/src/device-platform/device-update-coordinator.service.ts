import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebDisplayGateway } from './web-display.gateway';
import { resolveDeviceConfiguration } from './device-configuration';

@Injectable()
export class DeviceUpdateCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceUpdateCoordinator.name);
  private subscription?: Subscription;

  constructor(
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly webDisplays: WebDisplayGateway,
  ) {}

  onModuleInit() {
    this.subscription = this.events.getEventStream().subscribe((event) => {
      const deviceIds = event.payload.deviceIds ?? [];
      if (deviceIds.length) void this.refreshDevices(deviceIds);
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
    await Promise.all(devices.map(async (device) => {
      const configuration = resolveDeviceConfiguration(
        device.profile,
        device.deliveryPolicy,
        device.capabilitiesOverride,
      );
      if (configuration.capabilities.transport.modes.includes('websocket')) {
        await this.webDisplays.pushPresentation(device.id);
      }
    }));
    this.logger.debug(`Dispatched update to ${devices.length} device transports`);
  }
}
