import { BadRequestException, Injectable } from '@nestjs/common';
import type { DeviceCapabilities, DeliveryMode, TransportMode, DeliveryPolicy as PolicyContract } from '@inker/contracts';
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

abstract class PullDeliveryPolicy extends BaseDeliveryPolicy {
  protected readonly requiredTransport = 'http-pull';
  readonly dispatchOnRefresh = false;

  pullHints(capabilities: DeviceCapabilities, policy: PolicyContract) {
    this.selectTransport(capabilities);
    if (!policy.pollIntervalSeconds) throw new BadRequestException('Pull interval is required');
    return {
      refreshAfterSeconds: Math.max(policy.pollIntervalSeconds, capabilities.energy.recommendedMinRefreshSeconds ?? 1),
      telemetryIntervalSeconds: Math.max(60, policy.telemetryIntervalSeconds),
    };
  }
}

@Injectable()
export class SleepyDeliveryPolicy extends PullDeliveryPolicy {
  readonly mode = 'sleepy' as const;
}

@Injectable()
export class ResponsivePullDeliveryPolicy extends PullDeliveryPolicy {
  readonly mode = 'responsive-pull' as const;
}

@Injectable()
export class ConnectedDeliveryPolicy extends BaseDeliveryPolicy {
  readonly mode = 'connected' as const;
  readonly dispatchOnRefresh = true;
  protected readonly requiredTransport = 'websocket';

  /**
   * Connected devices use WebSocket for immediate invalidation but may fall
   * back to the canonical pull manifest while the socket is unavailable.
   */
  pullHints(capabilities: DeviceCapabilities, policy: PolicyContract) {
    if (!capabilities.transport.modes.includes('http-pull')) {
      throw new BadRequestException('Connected pull fallback requires http-pull capability');
    }
    if (!policy.pollIntervalSeconds) {
      throw new BadRequestException('Connected pull fallback interval is required');
    }
    return {
      refreshAfterSeconds: Math.max(policy.pollIntervalSeconds, capabilities.energy.recommendedMinRefreshSeconds ?? 1),
      telemetryIntervalSeconds: Math.max(60, policy.telemetryIntervalSeconds),
    };
  }
}
