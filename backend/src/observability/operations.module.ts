import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxTransportModule } from '../events/outbox-transport.module';
import { DevicePlatformModule } from '../device-platform/device-platform.module';
import { OperationsService } from './operations.service';
import { OperationsController } from './operations.controller';

@Module({ imports: [PrismaModule, OutboxTransportModule, DevicePlatformModule],
  controllers: [OperationsController], providers: [OperationsService] })
export class OperationsModule {}
