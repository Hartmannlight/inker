import { Module } from "@nestjs/common";
import { PlaybackCoreModule } from './playback-core.module';
import { PlaybackController } from "./playback.controller";

@Module({
  imports: [PlaybackCoreModule],
  controllers: [PlaybackController],
  exports: [PlaybackCoreModule],
})
export class PlaybackModule {}
