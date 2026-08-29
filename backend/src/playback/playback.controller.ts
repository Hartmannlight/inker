import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from "@nestjs/common";
import { PlaybackService } from "./playback.service";

// Admin sessions/CSRF apply. Device authentication never grants control authority.
@Controller("playback")
export class PlaybackController {
  constructor(private readonly playback: PlaybackService) {}
  @Get("playlists/:id/draft")
  draft(@Param("id", ParseIntPipe) id: number) {
    return this.playback.draft(id);
  }
  @Post("playlists/:id/publish")
  publish(@Param("id", ParseIntPipe) id: number, @Body() body: unknown) {
    return this.playback.publish(id, body);
  }
  @Post("playlists/:id/publish-from-draft")
  publishFromDraft(@Param("id", ParseIntPipe) id: number, @Body() body: unknown) {
    return this.playback.publishFromDraft(id, body);
  }
  @Get("devices/:id")
  read(@Param("id", ParseIntPipe) id: number) {
    return this.playback.read(id);
  }
  @Post("devices/:id/commands")
  execute(@Param("id", ParseIntPipe) id: number, @Body() body: unknown) {
    return this.playback.execute(id, body);
  }
}
