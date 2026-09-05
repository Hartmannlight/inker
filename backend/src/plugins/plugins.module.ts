import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PluginsService } from './plugins.service';
import { PluginRendererService } from './plugin-renderer.service';
import { OAuthService } from './oauth/oauth.service';
import { PluginsController } from './plugins.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PluginsController],
  providers: [PluginsService, PluginRendererService, OAuthService],
  exports: [PluginsService, PluginRendererService, OAuthService],
})
export class PluginsModule implements OnModuleInit {
  private readonly logger = new Logger(PluginsModule.name);

  constructor(private readonly pluginsService: PluginsService) {}

  async onModuleInit() {
    try {
      await this.pluginsService.cleanupStalePlugins();
      await this.pluginsService.seedBuiltinPlugins();
    } catch (error) {
      // Plugin initialization is non-fatal, but must remain observable so an
      // incomplete catalog cannot masquerade as a healthy initialization.
      this.logger.error('Plugin catalog initialization failed; continuing in degraded mode', error);
    }
  }
}
