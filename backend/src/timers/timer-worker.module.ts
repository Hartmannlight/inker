import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TimerCoreModule } from './timer-core.module';
import { TimerWorkerService } from './timer-worker.service';

@Module({ imports: [PrismaModule, TimerCoreModule], providers: [TimerWorkerService], exports: [TimerWorkerService] })
export class TimerWorkerModule {}
