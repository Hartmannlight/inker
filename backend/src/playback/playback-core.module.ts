import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicationsCoreModule } from '../publications/publications-core.module';
import { PlaybackClock, PlaybackService } from './playback.service';

@Module({ imports: [PrismaModule, PublicationsCoreModule], providers: [PlaybackClock, PlaybackService], exports: [PlaybackService] })
export class PlaybackCoreModule {}
