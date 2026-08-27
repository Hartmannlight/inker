import { describe, expect, it } from 'bun:test';
import { BUILTIN_POLICY_IDS, BUILTIN_PROFILE_IDS } from './device-configuration.catalog';
import { ProfileResolverService } from './profile-resolver.service';

describe('ProfileResolverService', () => {
  const resolved = (profileId: string, policyId: string, override: unknown) => ({
    profile: { profileId },
    deliveryPolicy: { policyId, mode: policyId.includes('connected') ? 'connected' : 'sleepy' },
    capabilitiesOverride: override ?? null,
    capabilities: {
      profileId,
      display: { width: (override as any)?.display?.width ?? 800, height: (override as any)?.display?.height ?? 480 },
      transport: { modes: profileId === BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO ? ['http-pull'] : ['websocket'] },
      energy: { source: 'mains' },
      interaction: { inputs: [] },
    },
  });
  const configuration = {
    normalizeOverride: (value: unknown) => value ?? null,
    resolve: async (profileId: string, policyId: string, override: unknown) =>
      resolved(profileId, policyId, override),
  };
  const resolver = new ProfileResolverService(configuration as any);

  it('moves legacy TRMNL and WebDisplay defaults into profile metadata', async () => {
    const trmnl = await resolver.resolveForCreate({ deviceType: 'trmnl' });
    const browser = await resolver.resolveForCreate({ deviceType: 'web-display' });

    expect(trmnl.profile.profileId).toBe(BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO);
    expect(trmnl.deliveryPolicy.policyId).toBe(BUILTIN_POLICY_IDS.SLEEPY);
    expect(trmnl.capabilitiesOverride).toEqual({
      display: { renderFormats: ['png'], mimeTypes: ['image/png'] },
    });
    expect(browser.profile.profileId).toBe(BUILTIN_PROFILE_IDS.BROWSER_HD);
    expect(browser.deliveryPolicy.policyId).toBe(BUILTIN_POLICY_IDS.CONNECTED_BROWSER);
  });

  it('applies explicit capability and display overrides before adapter selection', async () => {
    const result = await resolver.resolveForCreate({
      profileId: BUILTIN_PROFILE_IDS.ESP32_TOUCH_REFERENCE,
      deliveryPolicyId: BUILTIN_POLICY_IDS.CONNECTED_EMBEDDED,
      capabilitiesOverride: { interaction: { maxTouchPoints: 2 } },
      width: 640,
      height: 480,
    });

    expect(result.capabilitiesOverride).toEqual({
      interaction: { maxTouchPoints: 2 },
      display: { width: 640, height: 480 },
    });
  });

  it('requires an explicit policy for a future profile without runtime defaults', async () => {
    await expect(resolver.resolveForCreate({ profileId: 'third-party-profile' })).rejects.toThrow(
      'deliveryPolicyId is required for profile third-party-profile',
    );
  });
});
