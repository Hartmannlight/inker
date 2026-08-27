import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheckService,
  HealthCheck,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { OutboxRedisService } from '../events/outbox-redis.service';

@ApiTags('health')
@Controller()
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private prisma: PrismaService,
    private redis: OutboxRedisService,
  ) {}

  @Get('health')
  @HealthCheck()
  @ApiOperation({ summary: 'Get application health status' })
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check if application is ready to serve traffic' })
  async ready() {
    try { await this.prisma.$queryRaw`SELECT 1`; }
    catch { throw new ServiceUnavailableException('API_DATABASE_UNAVAILABLE'); }
    return {
      status: 'ready',
      background: await this.redis.backgroundStatus(),
      timestamp: new Date().toISOString(),
    };
  }
}
