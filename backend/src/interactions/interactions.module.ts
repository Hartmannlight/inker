import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlaybackCoreModule } from '../playback/playback-core.module';
import { RenderCacheModule } from '../render-cache/render-cache.module';
import { CommandRegistry } from './command-registry';
import { ViewNextHandler } from './view-next.handler';
import { InteractionClock, InteractionService } from './interaction.service';
import { InteractionsController } from './interactions.controller';

@Module({ imports: [PrismaModule, PlaybackCoreModule, RenderCacheModule],
  controllers: [InteractionsController], providers: [ViewNextHandler, InteractionClock, InteractionService,
    { provide: CommandRegistry, useFactory: (next: ViewNextHandler) => new CommandRegistry([next]), inject: [ViewNextHandler] }],
  exports: [InteractionService, CommandRegistry] })
export class InteractionsModule {}
