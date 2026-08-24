import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { ExchangeDeviceEnrollmentDto } from './device-enrollment.dto';
import { PairingTransportGuard } from './pairing-transport.guard';

@ApiTags('device-enrollments')
@Controller()
export class DeviceEnrollmentController {
  constructor(private readonly enrollments: DeviceEnrollmentService) {}

  @Post('devices/:deviceId/enrollments')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create a ten-minute one-time device enrollment' })
  create(@Param('deviceId', ParseIntPipe) deviceId: number) {
    return this.enrollments.create(deviceId);
  }

  @Public()
  @Post('device-enrollments/exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(PairingTransportGuard)
  @ApiOperation({ summary: 'Exchange a one-time code for a device credential' })
  exchange(@Body() dto: ExchangeDeviceEnrollmentDto) {
    return this.enrollments.exchange(dto.code);
  }
}
