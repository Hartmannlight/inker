import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './events/outbox.module';
import { OutboxTransportModule } from './events/outbox-transport.module';
import { configuration } from './config/configuration';
import { validationSchema } from './config/validation.schema';

/** No HTTP controllers, gateway, admin auth or plugin initialization in a worker. */
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration], validationSchema,
  envFilePath: ['.env.local', '.env'] }), PrismaModule, OutboxModule, OutboxTransportModule] })
export class WorkerModule {}
