import { describe, expect, it } from 'bun:test';
import {
  assessProtocolVersion,
  isJsonValue,
  parseCommandResult,
  parseDeliveryPolicy,
  parseDeviceCapabilities,
  parseDeviceProfile,
  parseInteractionEvent,
  parsePresentationManifest,
  parseSourceSnapshot,
  validateDeviceConfiguration,
  type ParseResult,
} from '../src';

interface ProfileFixture {
  fixtureId: string;
  profile: unknown;
  capabilities: unknown;
  deliveryPolicy: unknown;
}

const profileFixtureNames = [
  'trmnl-battery',
  'trmnl-mains',
  'esp32-touch',
  'pi-browser',
] as const;

async function loadFixture(path: string): Promise<unknown> {
  return Bun.file(new URL(`../fixtures/${path}`, import.meta.url)).json();
}

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.success) {
    throw new Error(result.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  }
  return result.data;
}

describe('device profile fixtures', () => {
  for (const name of profileFixtureNames) {
    it(`validates ${name}`, async () => {
      const fixture = await loadFixture(`profiles/${name}.json`) as ProfileFixture;
      expect(isJsonValue(fixture)).toBe(true);

      const profile = unwrap(parseDeviceProfile(fixture.profile));
      const capabilities = unwrap(parseDeviceCapabilities(fixture.capabilities));
      const deliveryPolicy = unwrap(parseDeliveryPolicy(fixture.deliveryPolicy));

      expect(validateDeviceConfiguration(profile, capabilities, deliveryPolicy)).toEqual([]);
    });
  }

  it('keeps battery and mains TRMNL on the same profile with different policies', async () => {
    const battery = await loadFixture('profiles/trmnl-battery.json') as ProfileFixture;
    const mains = await loadFixture('profiles/trmnl-mains.json') as ProfileFixture;
    const batteryProfile = unwrap(parseDeviceProfile(battery.profile));
    const mainsProfile = unwrap(parseDeviceProfile(mains.profile));
    const batteryPolicy = unwrap(parseDeliveryPolicy(battery.deliveryPolicy));
    const mainsPolicy = unwrap(parseDeliveryPolicy(mains.deliveryPolicy));

    expect(batteryProfile.profileId).toBe(mainsProfile.profileId);
    expect(batteryPolicy.mode).toBe('sleepy');
    expect(mainsPolicy.mode).toBe('responsive-pull');
  });
});

describe('core contract fixtures', () => {
  it('validates a widget-neutral presentation manifest', async () => {
    const fixture = await loadFixture('presentation-manifest.json');
    const manifest = unwrap(parsePresentationManifest(fixture));
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.allowedActions[0]?.action).toBe('view.next');
  });

  it('validates a normalized source snapshot', async () => {
    const fixture = await loadFixture('source-snapshot.json');
    const snapshot = unwrap(parseSourceSnapshot(fixture));
    expect(snapshot.freshness.state).toBe('fresh');
  });

  it('validates an interaction event and command result', async () => {
    const event = unwrap(parseInteractionEvent(await loadFixture('interaction-event.json')));
    const result = unwrap(parseCommandResult(await loadFixture('command-result.json')));
    expect(result.eventId).toBe(event.eventId);
  });

  it('returns understandable paths and messages for invalid values', async () => {
    const invalid = await loadFixture('presentation-manifest.json') as Record<string, unknown>;
    invalid.artifacts = [];
    const result = parsePresentationManifest(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]?.path).toBe('$.artifacts');
    expect(result.errors[0]?.message).toContain('at least one artifact');
  });

  it('rejects non-object interaction payloads', async () => {
    const invalid = await loadFixture('interaction-event.json') as Record<string, unknown>;
    invalid.payload = ['not', 'an', 'object'];
    const result = parseInteractionEvent(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((issue) => issue.code === 'invalid_json_object')).toBe(true);
  });

  it('requires error details for rejected commands', async () => {
    const invalid = await loadFixture('command-result.json') as Record<string, unknown>;
    invalid.status = 'rejected';
    const result = parseCommandResult(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((issue) => issue.code === 'command_error_required')).toBe(true);
  });
});

describe('protocol compatibility', () => {
  it('accepts the current protocol version', () => {
    expect(assessProtocolVersion('1.0').status).toBe('supported');
  });

  it('accepts an unknown minor version with an explicit warning', async () => {
    const fixture = await loadFixture('profiles/trmnl-battery.json') as ProfileFixture;
    const profile = structuredClone(fixture.profile) as Record<string, unknown>;
    profile.protocolVersion = '1.1';
    const result = parseDeviceProfile(profile);
    expect(result.success).toBe(true);
    expect(result.warnings.some((issue) => issue.code === 'protocol_unknown_minor')).toBe(true);
  });

  it('rejects an incompatible major version', async () => {
    const fixture = await loadFixture('profiles/trmnl-battery.json') as ProfileFixture;
    const profile = structuredClone(fixture.profile) as Record<string, unknown>;
    profile.protocolVersion = '2.0';
    const result = parseDeviceProfile(profile);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toMatchObject({
      code: 'protocol_incompatible',
      path: '$.protocolVersion',
    });
  });

  it('rejects malformed protocol versions', () => {
    expect(assessProtocolVersion('v1').status).toBe('malformed');
  });
});
