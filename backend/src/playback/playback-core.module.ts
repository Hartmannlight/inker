import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicationsModule } from '../publications/publications.module';
import { PlaybackClock, PlaybackService } from './playback.service';

@Module({ imports: [PrismaModule, PublicationsModule], providers: [PlaybackClock, PlaybackService], exports: [PlaybackService] })
export class PlaybackCoreModule {}
