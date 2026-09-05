import { Module } from "@nestjs/common";
import { PublicationsCoreModule } from './publications-core.module';
import { PublishService } from './publish.service';
import { PublicationsController } from './publications.controller';
import { CustomWidgetsModule } from '../custom-widgets/custom-widgets.module';
import { SettingsModule } from '../settings/settings.module';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';

@Module({
  imports: [PublicationsCoreModule, CustomWidgetsModule, SettingsModule],
  controllers: [PublicationsController],
  providers: [PublishService, ScreenRendererService],
  exports: [PublicationsCoreModule, PublishService],
})
export class PublicationsModule {}
