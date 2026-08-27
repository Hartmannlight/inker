import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FirmwareModule } from '../firmware/firmware.module';
import { DevicePlatformModule } from '../device-platform/device-platform.module';

@Module({
  imports: [PrismaModule, FirmwareModule, DevicePlatformModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService, DevicePlatformModule],
})
export class DevicesModule {}
