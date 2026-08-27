import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PublicationsModule } from "../publications/publications.module";
import { PlaybackClock, PlaybackService } from "./playback.service";
import { PlaybackController } from "./playback.controller";

@Module({
  imports: [PrismaModule, PublicationsModule],
  controllers: [PlaybackController],
  providers: [PlaybackClock, PlaybackService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
