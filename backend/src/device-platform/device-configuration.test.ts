import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_DELIVERY_POLICIES,
  BUILTIN_DEVICE_PROFILES,
  BUILTIN_POLICY_IDS,
  BUILTIN_PROFILE_IDS,
} from './device-configuration.catalog';
import {
  normalizeCapabilitiesOverride,
  resolveDeviceConfiguration,
} from './device-configuration';
import { DeviceConfigurationService } from './device-configuration.service';
import { createMockPrisma } from '../test/mocks/prisma.mock';
import { serializeDevice } from '../devices/entities/device.entity';

function persistedProfile(profileId: string) {
  const entry = BUILTIN_DEVICE_PROFILES.find((candidate) => candidate.profile.profileId === profileId)!;
  return {
    profileId,
    protocolVersion: entry.profile.protocolVersion,
    definition: structuredClone(entry.profile),
    defaultCapabilities: structuredClone(entry.defaultCapabilities),
  };
}

function persistedPolicy(policyId: string) {
  const policy = BUILTIN_DELIVERY_POLICIES.find((candidate) => candidate.policyId === policyId)!;
  return {
    policyId,
    protocolVersion: policy.protocolVersion,
    mode: policy.mode,
    definition: structuredClone(policy),
  };
}

describe('device configuration persistence contracts', () => {
  const cases = [
    {
      name: 'battery TRMNL',
      profileId: BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO,
      policyId: BUILTIN_POLICY_IDS.SLEEPY,
      override: null,
      expected: { width: 800, height: 480, energy: 'battery', mode: 'sleepy' },
    },
    {
      name: 'mains TRMNL',
      profileId: BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO,
      policyId: BUILTIN_POLICY_IDS.RESPONSIVE_PULL,
      override: { energy: { source: 'mains', canSleep: false, telemetry: 'standard' } },
      expected: { width: 800, height: 480, energy: 'mains', mode: 'responsive-pull' },
    },
    {
      name: 'ESP32 touch reference',
      profileId: BUILTIN_PROFILE_IDS.ESP32_TOUCH_REFERENCE,
      policyId: BUILTIN_POLICY_IDS.CONNECTED_EMBEDDED,
      override: null,
      expected: { width: 480, height: 480, energy: 'mains', mode: 'connected' },
    },
    {
      name: 'Pi browser',
      profileId: BUILTIN_PROFILE_IDS.BROWSER_HD,
      policyId: BUILTIN_POLICY_IDS.CONNECTED_BROWSER,
      override: null,
      expected: { width: 1920, height: 1080, energy: 'mains', mode: 'connected' },
    },
  ] as const;

  for (const testCase of cases) {
    it(`round-trips ${testCase.name} through persisted JSON`, () => {
      const result = resolveDeviceConfiguration(
        persistedProfile(testCase.profileId),
        persistedPolicy(testCase.policyId),
        JSON.parse(JSON.stringify(testCase.override)),
      );
      expect(result.profile.profileId).toBe(testCase.profileId);
      expect(result.deliveryPolicy.policyId).toBe(testCase.policyId);
      expect(result.deliveryPolicy.mode).toBe(testCase.expected.mode);
      expect(result.capabilities.display.width).toBe(testCase.expected.width);
      expect(result.capabilities.display.height).toBe(testCase.expected.height);
      expect(result.capabilities.energy.source).toBe(testCase.expected.energy);
    });
  }

  it('merges nested safe-area overrides without losing profile defaults', () => {
    const result = resolveDeviceConfiguration(
      persistedProfile(BUILTIN_PROFILE_IDS.BROWSER_HD),
      persistedPolicy(BUILTIN_POLICY_IDS.CONNECTED_BROWSER),
      { display: { width: 1280, height: 720, safeArea: { top: 12 } } },
    );
    expect(result.capabilities.display.safeArea).toEqual({ top: 12, right: 0, bottom: 0, left: 0 });
    expect(result.capabilities.display.colorSpace).toBe('rgb');
  });

  it('rejects identity fields and unknown legacy capability keys in overrides', () => {
    expect(() => normalizeCapabilitiesOverride({ profileId: 'other' })).toThrow();
    expect(() => normalizeCapabilitiesOverride({ display: { colorDepth: 1 } })).toThrow();
  });

  it('rejects a policy that is incompatible with effective transport capabilities', () => {
    expect(() => resolveDeviceConfiguration(
      persistedProfile(BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO),
      persistedPolicy(BUILTIN_POLICY_IDS.CONNECTED_BROWSER),
      null,
    )).toThrow(/Connected delivery requires websocket/);
  });

  it('serializes exactly one effective capability view and keeps only the override separately', () => {
    const profile = persistedProfile(BUILTIN_PROFILE_IDS.BROWSER_HD);
    const deliveryPolicy = persistedPolicy(BUILTIN_POLICY_IDS.CONNECTED_BROWSER);
    const serialized = serializeDevice({
      id: 7,
      isActive: true,
      lastSeenAt: null,
      width: 1,
      height: 1,
      capabilities: { legacy: true },
      capabilitiesOverride: { display: { width: 1280, height: 720 } },
      profile,
      deliveryPolicy,
    }) as any;
    expect(serialized.capabilities.display.width).toBe(1280);
    expect(serialized.capabilities.display.height).toBe(720);
    expect(serialized.capabilities.legacy).toBeUndefined();
    expect(serialized.capabilitiesOverride).toEqual({ display: { width: 1280, height: 720 } });
  });

  it('reports unknown persisted profile and policy IDs as checked service errors', async () => {
    const prisma = createMockPrisma();
    prisma.deviceProfile.findUnique.mockResolvedValue(null);
    prisma.deliveryPolicy.findUnique.mockResolvedValue(null);
    const service = new DeviceConfigurationService(prisma as any);
    await expect(service.resolve('missing-profile', 'missing-policy', null)).rejects.toThrow(
      'Unknown device profile: missing-profile',
    );
  });
});
