import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { OutboxTransportModule } from '../events/outbox-transport.module';

@Module({
  imports: [TerminusModule, OutboxTransportModule],
  controllers: [HealthController],
})
export class HealthModule {}
