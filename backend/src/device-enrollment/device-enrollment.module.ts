import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceEnrollmentController } from './device-enrollment.controller';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { PairingTransportGuard } from './pairing-transport.guard';

@Module({
  imports: [PrismaModule],
  controllers: [DeviceEnrollmentController],
  providers: [DeviceEnrollmentService, PairingTransportGuard],
  exports: [DeviceEnrollmentService],
})
export class DeviceEnrollmentModule {}
