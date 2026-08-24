import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeCapabilitiesOverride,
  resolveDeviceConfiguration,
  type ResolvedDeviceConfiguration,
} from './device-configuration';

export const DEVICE_CONFIGURATION_INCLUDE = {
  profile: true,
  deliveryPolicy: true,
} satisfies Prisma.DeviceInclude;

@Injectable()
export class DeviceConfigurationService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    profileId: string,
    deliveryPolicyId: string,
    capabilitiesOverride: unknown,
  ): Promise<ResolvedDeviceConfiguration> {
    const [profile, deliveryPolicy] = await Promise.all([
      this.prisma.deviceProfile.findUnique({ where: { profileId } }),
      this.prisma.deliveryPolicy.findUnique({ where: { policyId: deliveryPolicyId } }),
    ]);
    if (!profile) throw new BadRequestException(`Unknown device profile: ${profileId}`);
    if (!deliveryPolicy) throw new BadRequestException(`Unknown delivery policy: ${deliveryPolicyId}`);
    try {
      return resolveDeviceConfiguration(profile, deliveryPolicy, capabilitiesOverride);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid device configuration');
    }
  }

  normalizeOverride(capabilitiesOverride: unknown) {
    try {
      return normalizeCapabilitiesOverride(capabilitiesOverride);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid capabilities override');
    }
  }
}
