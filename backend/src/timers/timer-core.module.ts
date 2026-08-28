import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TimerClock, TimerService } from './timer.service';
import { TimerHandlers } from './timer-handlers';

@Module({ imports: [PrismaModule], providers: [TimerClock, TimerService, TimerHandlers], exports: [TimerService, TimerHandlers] })
export class TimerCoreModule {}
