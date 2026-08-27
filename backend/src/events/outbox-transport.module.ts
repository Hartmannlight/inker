import { Module } from '@nestjs/common';
import { OutboxRedisService } from './outbox-redis.service';

@Module({ providers: [OutboxRedisService], exports: [OutboxRedisService] })
export class OutboxTransportModule {}
