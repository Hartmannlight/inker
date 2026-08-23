import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FirmwareModule } from '../firmware/firmware.module';
import { DeviceDriverRegistry } from './drivers/device-driver.registry';
import { TrmnlDeviceDriver } from './drivers/trmnl-device.driver';
import { WebDisplayDeviceDriver } from './drivers/web-display-device.driver';

@Module({
  imports: [PrismaModule, FirmwareModule],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceDriverRegistry, TrmnlDeviceDriver, WebDisplayDeviceDriver],
  exports: [DevicesService, DeviceDriverRegistry],
})
export class DevicesModule {}
