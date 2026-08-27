import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ArtifactStore } from './artifact-store';
import { RenderCacheService } from './render-cache.service';

@Module({ imports: [PrismaModule], providers: [ArtifactStore, RenderCacheService], exports: [RenderCacheService] })
export class RenderCacheModule {}
