import { BadRequestException, Injectable } from '@nestjs/common';
import type { DeviceCapabilities, DeliveryMode, TransportMode } from '@inker/contracts';
import type { DeliveryPolicy } from './device-extension.contracts';

abstract class BaseDeliveryPolicy implements DeliveryPolicy {
  abstract readonly mode: DeliveryMode;
  abstract readonly dispatchOnRefresh: boolean;
  protected abstract readonly requiredTransport: TransportMode;

  selectTransport(capabilities: DeviceCapabilities): string {
    if (!capabilities.transport.modes.includes(this.requiredTransport)) {
      throw new BadRequestException(
        `${this.mode} delivery requires ${this.requiredTransport} capability`,
      );
    }
    return this.requiredTransport;
  }
}

@Injectable()
export class SleepyDeliveryPolicy extends BaseDeliveryPolicy {
  readonly mode = 'sleepy' as const;
  readonly dispatchOnRefresh = false;
  protected readonly requiredTransport = 'http-pull';
}

@Injectable()
export class ResponsivePullDeliveryPolicy extends BaseDeliveryPolicy {
  readonly mode = 'responsive-pull' as const;
  readonly dispatchOnRefresh = false;
  protected readonly requiredTransport = 'http-pull';
}

@Injectable()
export class ConnectedDeliveryPolicy extends BaseDeliveryPolicy {
  readonly mode = 'connected' as const;
  readonly dispatchOnRefresh = true;
  protected readonly requiredTransport = 'websocket';
}
