import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectedDeliveryPolicy, ResponsivePullDeliveryPolicy, SleepyDeliveryPolicy } from './delivery-policies';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { DeviceUpdateCoordinator } from './device-update-coordinator.service';
import { DeviceConfigurationService } from './device-configuration.service';
import { HttpPullTransportAdapter } from './http-pull.transport-adapter';
import { PresentationService } from './presentation.service';
import { ProfileResolverService } from './profile-resolver.service';
import { TransportAdapterRegistry } from './transport-adapter.registry';
import { WebDisplayAuthService } from './web-display-auth.service';
import { WebDisplayGateway } from './web-display.gateway';
import { WebDisplaysController } from './web-displays.controller';
import { WebSocketTransportAdapter } from './websocket.transport-adapter';
import { PullContentController } from './pull-content.controller';
import { PullContentService } from './pull-content.service';
import { PullDeviceAuthService } from './pull-device-auth.service';
import { PullLastSeenService } from './pull-last-seen.service';
import { WebSocketTelemetryService } from './websocket-telemetry.service';
import { RenderCacheModule } from '../render-cache/render-cache.module';
import { TimerCoreModule } from '../timers/timer-core.module';
import { TimersController } from './timers.controller';

@Module({
  imports: [PrismaModule, DiscoveryModule, RenderCacheModule, TimerCoreModule],
  controllers: [WebDisplaysController, PullContentController, TimersController],
  providers: [
    PullContentService,
    PullDeviceAuthService,
    PullLastSeenService,
    WebSocketTelemetryService,
    PresentationService,
    WebDisplayAuthService,
    WebDisplayGateway,
    DeviceUpdateCoordinator,
    DeviceConfigurationService,
    ProfileResolverService,
    HttpPullTransportAdapter,
    WebSocketTransportAdapter,
    TransportAdapterRegistry,
    SleepyDeliveryPolicy,
    ResponsivePullDeliveryPolicy,
    ConnectedDeliveryPolicy,
    {
      provide: DeliveryPolicyRegistry,
      inject: [SleepyDeliveryPolicy, ResponsivePullDeliveryPolicy, ConnectedDeliveryPolicy],
      useFactory: (
        sleepy: SleepyDeliveryPolicy,
        responsivePull: ResponsivePullDeliveryPolicy,
        connected: ConnectedDeliveryPolicy,
      ) => new DeliveryPolicyRegistry([sleepy, responsivePull, connected]),
    },
  ],
  exports: [
    DeviceUpdateCoordinator,
    PresentationService,
    WebDisplayGateway,
    DeviceConfigurationService,
    ProfileResolverService,
    TransportAdapterRegistry,
    DeliveryPolicyRegistry,
  ],
})
export class DevicePlatformModule {}
