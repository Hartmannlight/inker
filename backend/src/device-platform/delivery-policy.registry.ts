import { BadRequestException, Injectable } from '@nestjs/common';
import type { DeliveryMode } from '@inker/contracts';
import type { DeliveryPolicy } from './device-extension.contracts';

@Injectable()
export class DeliveryPolicyRegistry {
  private readonly policies: Map<DeliveryMode, DeliveryPolicy>;

  constructor(policies: DeliveryPolicy[]) {
    this.policies = new Map(policies.map((policy) => [policy.mode, policy]));
  }

  get(mode: DeliveryMode | string): DeliveryPolicy {
    const policy = this.policies.get(mode as DeliveryMode);
    if (!policy) throw new BadRequestException(`Unsupported delivery policy mode: ${mode}`);
    return policy;
  }
}
