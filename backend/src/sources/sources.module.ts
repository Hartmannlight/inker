import { Body, Controller, Get, Module, Param, Post, Put } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { SourceReadService } from './source-read.service';
import { SourcesService } from './sources.service';

// Existing admin session and CSRF guards protect every route, including reads.
@Controller('sources')
export class SourcesController {
  constructor(private readonly commands: SourcesService, private readonly reads: SourceReadService) {}
  @Get() list() { return this.reads.list(); }
  @Get(':id') read(@Param('id') id: string) { return this.reads.read(id); }
  @Get(':id/snapshots/:snapshotId') snapshot(@Param('id') id: string, @Param('snapshotId') snapshotId: string) { return this.reads.snapshot(id, snapshotId); }
  @Post() create(@Body() body: unknown) { return this.commands.create(body); }
  @Put(':id') update(@Param('id') id: string, @Body() body: unknown) { return this.commands.update(id, body); }
  @Post(':id/refresh') refresh(@Param('id') id: string) { return this.commands.refresh(id); }
}

@Module({ imports: [PrismaModule, CommonModule], controllers: [SourcesController], providers: [SourcesService, SourceReadService], exports: [SourceReadService] })
export class SourcesModule {}
