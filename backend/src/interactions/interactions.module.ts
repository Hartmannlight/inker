import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlaybackCoreModule } from '../playback/playback-core.module';
import { RenderCacheModule } from '../render-cache/render-cache.module';
import { CommandRegistry } from './command-registry';
import { ViewNextHandler } from './view-next.handler';
import { InteractionClock, InteractionService } from './interaction.service';
import { InteractionsController } from './interactions.controller';
import { TimerCoreModule } from '../timers/timer-core.module';
import { TimerHandlers } from '../timers/timer-handlers';

@Module({ imports: [PrismaModule, PlaybackCoreModule, RenderCacheModule, TimerCoreModule],
  controllers: [InteractionsController], providers: [ViewNextHandler, InteractionClock, InteractionService,
    { provide: CommandRegistry, useFactory: (next: ViewNextHandler, timers: TimerHandlers) => new CommandRegistry([next, ...timers.handlers]), inject: [ViewNextHandler, TimerHandlers] }],
  exports: [InteractionService, CommandRegistry] })
export class InteractionsModule {}
