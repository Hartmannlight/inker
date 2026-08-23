import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';
import { PresentationService } from './presentation.service';
import { WebDisplayAuthService } from './web-display-auth.service';
import { WebDisplayGateway } from './web-display.gateway';
import { WebDisplaysController } from './web-displays.controller';

@Module({
  imports: [PrismaModule],
  controllers: [WebDisplaysController],
  providers: [PresentationService, WebDisplayAuthService, WebDisplayGateway, DeviceUpdateCoordinator],
  exports: [PresentationService, WebDisplayGateway],
})
export class DevicePlatformModule {}
