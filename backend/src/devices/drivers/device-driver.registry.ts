import { BadRequestException, Injectable } from '@nestjs/common';
import { DeviceDriver, DeviceType } from './device-driver';
import { TrmnlDeviceDriver } from './trmnl-device.driver';
import { WebDisplayDeviceDriver } from './web-display-device.driver';

@Injectable()
export class DeviceDriverRegistry {
  private readonly drivers: Map<string, DeviceDriver>;

  constructor(trmnl: TrmnlDeviceDriver, webDisplay: WebDisplayDeviceDriver) {
    this.drivers = new Map<string, DeviceDriver>([
      [trmnl.type, trmnl],
      [webDisplay.type, webDisplay],
    ]);
  }

  get(type: DeviceType | string): DeviceDriver {
    const driver = this.drivers.get(type);
    if (!driver) throw new BadRequestException(`Unsupported device type: ${type}`);
    return driver;
  }

  list(): DeviceDriver[] {
    return Array.from(this.drivers.values());
  }
}
