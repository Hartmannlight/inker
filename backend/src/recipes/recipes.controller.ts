import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RecipesService } from './recipes.service';
import type { PluginLayout } from '../plugins/plugin-renderer.service';

@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  list() { return this.recipes.list(); }

  @Get(':id')
  read(@Param('id') id: string) { return this.recipes.read(id); }

  @Post()
  create(@Body() body: unknown) { return this.recipes.create(body); }

  @Post(':id/revisions')
  appendRevision(@Param('id') id: string, @Body() body: unknown) {
    return this.recipes.appendRevision(id, body);
  }

  @Post(':id/bindings')
  createBinding(@Param('id') id: string, @Body() body: unknown) {
    return this.recipes.createBinding(id, body);
  }

  @Get('bindings/:id')
  readBinding(@Param('id') id: string) { return this.recipes.readBinding(id); }

  @Put('bindings/:id')
  updateBinding(@Param('id') id: string, @Body() body: unknown) {
    return this.recipes.updateBinding(id, body);
  }

  @Get('bindings/:id/render')
  async render(
    @Param('id') id: string,
    @Query('layout') requestedLayout: string | undefined,
    @Query('mode') requestedMode: string | undefined,
    @Res() response: Response,
  ) {
    const layout = (['full', 'half_horizontal', 'half_vertical', 'quadrant'].includes(requestedLayout ?? '')
      ? requestedLayout : 'full') as PluginLayout;
    const mode = (['device', 'preview', 'einkPreview'].includes(requestedMode ?? '')
      ? requestedMode : 'preview') as 'device' | 'preview' | 'einkPreview';
    const bytes = await this.recipes.renderBinding(id, layout, mode);
    response.set({ 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    response.send(bytes);
  }
}
