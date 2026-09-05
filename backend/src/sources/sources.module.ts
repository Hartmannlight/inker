import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { SourceReadService } from './source-read.service';
import { SourcesService } from './sources.service';
import { SourcesController } from './sources.controller';

@Module({ imports: [PrismaModule, CommonModule], controllers: [SourcesController], providers: [SourcesService, SourceReadService], exports: [SourceReadService] })
export class SourcesModule {}
