import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { PluginsModule } from '../plugins/plugins.module';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { LegacyContentMigrationService } from './legacy-content-migration.service';

@Module({
  imports: [PrismaModule, CommonModule, PluginsModule],
  controllers: [RecipesController],
  providers: [RecipesService, LegacyContentMigrationService],
  exports: [RecipesService],
})
export class RecipesModule {}
