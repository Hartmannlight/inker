import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FirmwareModule } from '../firmware/firmware.module';
import { DeviceDriverRegistry } from './drivers/device-driver.registry';
import { TrmnlDeviceDriver } from './drivers/trmnl-device.driver';
import { WebDisplayDeviceDriver } from './drivers/web-display-device.driver';
import { DeviceConfigurationService } from '../device-platform/device-configuration.service';

@Module({
  imports: [PrismaModule, FirmwareModule],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceDriverRegistry, TrmnlDeviceDriver, WebDisplayDeviceDriver, DeviceConfigurationService],
  exports: [DevicesService, DeviceDriverRegistry, DeviceConfigurationService],
})
export class DevicesModule {}
