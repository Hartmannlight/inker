import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BUILTIN_DEVICE_PROFILES,
  type BuiltinDeviceProfile,
} from './device-configuration.catalog';
import { DeviceConfigurationService } from './device-configuration.service';
import {
  resolveDeviceConfiguration,
  type DeviceCapabilitiesOverride,
  type ResolvedDeviceConfiguration,
} from './device-configuration';
import type {
  CreateProfileSelection,
  LegacyDeviceType,
  ProfileResolver,
} from './device-extension.contracts';

@Injectable()
export class ProfileResolverService implements ProfileResolver {
  constructor(private readonly configuration: DeviceConfigurationService) {}

  async resolveForCreate(selection: CreateProfileSelection): Promise<ResolvedDeviceConfiguration> {
    const profileId = selection.profileId ?? this.defaultProfile(selection.deviceType ?? 'trmnl').profile.profileId;
    const builtin = BUILTIN_DEVICE_PROFILES.find((candidate) => candidate.profile.profileId === profileId);
    const deliveryPolicyId = selection.deliveryPolicyId ?? builtin?.provisioning.defaultDeliveryPolicyId;
    if (!deliveryPolicyId) {
      throw new BadRequestException(`deliveryPolicyId is required for profile ${profileId}`);
    }

    const baseOverride = selection.capabilitiesOverride ?? builtin?.provisioning.compatibilityOverride;
    const override = this.withDisplayDimensions(baseOverride, selection.width, selection.height);
    return this.configuration.resolve(profileId, deliveryPolicyId, override);
  }

  resolvePersisted(device: Parameters<ProfileResolver['resolvePersisted']>[0]): ResolvedDeviceConfiguration {
    return resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride);
  }

  private defaultProfile(deviceType: LegacyDeviceType): BuiltinDeviceProfile {
    const profile = BUILTIN_DEVICE_PROFILES.find((candidate) =>
      candidate.provisioning.legacyDefault && candidate.provisioning.legacyDeviceType === deviceType,
    );
    if (!profile) throw new BadRequestException(`No default profile for legacy device type: ${deviceType}`);
    return profile;
  }

  private withDisplayDimensions(
    rawOverride: unknown,
    width?: number,
    height?: number,
  ): DeviceCapabilitiesOverride | null {
    const override = this.configuration.normalizeOverride(rawOverride);
    if (width === undefined && height === undefined) return override;
    return {
      ...override,
      display: {
        ...override?.display,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
    };
  }
}
