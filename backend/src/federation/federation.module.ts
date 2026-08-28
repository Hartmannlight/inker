import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FederationController } from './federation.controller';
import { FederationFeedService } from './federation-feed.service';
import { FederationIdentityService } from './federation-identity.service';
import { ShareCredentialService } from './share-credential.service';
import { FederationTransportGuard } from './federation-transport.guard';
import { PublicationsCoreModule } from '../publications/publications-core.module';
import { RemoteSubscriptionsService } from './remote-subscriptions.service';
import { RemoteSubscriptionsController } from './remote-subscriptions.controller';

@Module({
  imports: [PrismaModule, PublicationsCoreModule],
  controllers: [FederationController, RemoteSubscriptionsController],
  providers: [FederationFeedService, FederationIdentityService, ShareCredentialService, FederationTransportGuard, RemoteSubscriptionsService],
})
export class FederationModule {}
