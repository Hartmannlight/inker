import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FederationController } from './federation.controller';
import { FederationFeedService } from './federation-feed.service';
import { FederationIdentityService } from './federation-identity.service';
import { ShareCredentialService } from './share-credential.service';
import { FederationTransportGuard } from './federation-transport.guard';

@Module({
  imports: [PrismaModule],
  controllers: [FederationController],
  providers: [FederationFeedService, FederationIdentityService, ShareCredentialService, FederationTransportGuard],
})
export class FederationModule {}
