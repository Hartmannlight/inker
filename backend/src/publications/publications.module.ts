import { Module } from "@nestjs/common";
import { PublicationsCoreModule } from './publications-core.module';
import { PublishService } from './publish.service';
import { PublicationsController } from './publications.controller';

@Module({
  imports: [PublicationsCoreModule],
  controllers: [PublicationsController],
  providers: [PublishService],
  exports: [PublicationsCoreModule, PublishService],
})
export class PublicationsModule {}
