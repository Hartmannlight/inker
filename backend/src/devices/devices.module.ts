import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FirmwareModule } from '../firmware/firmware.module';
import { DevicePlatformModule } from '../device-platform/device-platform.module';
import { PublicationsModule } from '../publications/publications.module';
import { PlaybackCoreModule } from '../playback/playback-core.module';
import { ContentAssignmentService } from './content-assignment.service';
import { RenderCacheModule } from '../render-cache/render-cache.module';

@Module({
  imports: [PrismaModule, FirmwareModule, DevicePlatformModule, PublicationsModule, PlaybackCoreModule, RenderCacheModule],
  controllers: [DevicesController],
  providers: [DevicesService, ContentAssignmentService],
  exports: [DevicesService, DevicePlatformModule],
})
export class DevicesModule {}
