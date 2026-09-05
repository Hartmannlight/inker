import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomWidgetsModule } from '../custom-widgets/custom-widgets.module';
import { SettingsModule } from '../settings/settings.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ScreenDesignerController, WidgetTemplatesController } from './screen-designer.controller';
import { ScreenDesignerService } from './screen-designer.service';
import { WidgetTemplatesService } from './services/widget-templates.service';
import { ScreenRendererService } from './services/screen-renderer.service';

@Module({
  imports: [PrismaModule, CustomWidgetsModule, SettingsModule, PluginsModule],
  controllers: [ScreenDesignerController, WidgetTemplatesController],
  providers: [
    ScreenDesignerService,
    WidgetTemplatesService,
    ScreenRendererService,
  ],
  exports: [
    ScreenDesignerService,
    WidgetTemplatesService,
    ScreenRendererService,
  ],
})
export class ScreenDesignerModule {}
