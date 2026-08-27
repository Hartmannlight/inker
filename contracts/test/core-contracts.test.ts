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
  parseSourceDefinition,
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

describe('SourceDefinition contract', () => {
  async function definition(): Promise<Record<string, unknown>> {
    return await loadFixture('source-definition.json') as Record<string, unknown>;
  }

  it('validates the fixture and retains a generic connector type and opaque references', async () => {
    const fixture = await definition();
    expect(isJsonValue(fixture)).toBe(true);
    fixture.connectorType = 'future-provider.connector/v2';
    fixture.secretReferences = { accessToken: 'secret-1', refreshToken: '2cf1fbe4-d8fb-4f0a-a2b2-275a196632e6' };
    const parsed = unwrap(parseSourceDefinition(fixture));
    expect(parsed.connectorType).toBe('future-provider.connector/v2');
    expect(parsed.definitionVersion).toBe(1);
    expect(parsed.secretReferences.accessToken).toBe('secret-1');
    expect(fixture.configuration).toEqual(parsed.configuration);
  });

  it('requires every definition field and rejects wrong types', async () => {
    const fixture = await definition();
    for (const field of Object.keys(fixture)) {
      const missing = { ...fixture };
      delete missing[field];
      const result = parseSourceDefinition(missing);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errors.some((issue) => issue.path === `$.${field}`)).toBe(true);
      expect(parseSourceDefinition({ ...fixture, [field]: [] }).success).toBe(false);
      expect(parseSourceDefinition({ ...fixture, [field]: null }).success).toBe(false);
    }
    expect(parseSourceDefinition(null).success).toBe(false);
    expect(parseSourceDefinition([]).success).toBe(false);
  });

  it('enforces integer scheduling bounds and safe positive revisions', async () => {
    const fixture = await definition();
    const limits: Record<string, readonly [number, number]> = {
      refreshIntervalSeconds: [1, 86400],
      timeoutMs: [50, 7500],
      definitionVersion: [1, Number.MAX_SAFE_INTEGER],
    };
    for (const [field, [minimum, maximum]] of Object.entries(limits)) {
      for (const valid of [minimum, maximum]) {
        expect(parseSourceDefinition({ ...fixture, [field]: valid }).success).toBe(true);
      }
      for (const invalid of [minimum - 1, maximum + 1, 1.5, Number.NaN, Infinity, '50']) {
        expect(parseSourceDefinition({ ...fixture, [field]: invalid }).success).toBe(false);
      }
    }
  });

  it('rejects non-JSON configuration while accepting nested normalized values', async () => {
    const fixture = await definition();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const configuration of [undefined, null, [], 'text', 2, new Date(), { value: undefined }, { value: NaN }, cyclic]) {
      const result = parseSourceDefinition({ ...fixture, configuration });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errors.some((issue) => issue.code === 'invalid_json_object')).toBe(true);
    }
    expect(parseSourceDefinition({ ...fixture, configuration: { nested: [null, true, 1, 'text', {}] } }).success).toBe(true);
  });

  it('bounds opaque IDs and concurrency identifiers without accepting paths or whitespace', async () => {
    const fixture = await definition();
    for (const field of ['sourceDefinitionId', 'concurrencyGroup']) {
      for (const valid of ['a', 'provider:group_1.v2-3', 'a'.repeat(128)]) {
        expect(parseSourceDefinition({ ...fixture, [field]: valid }).success).toBe(true);
      }
      for (const invalid of ['', ' ', 'a'.repeat(129), '../secrets', 'https://provider', 'two groups', '\nvalue', '_private']) {
        expect(parseSourceDefinition({ ...fixture, [field]: invalid }).success).toBe(false);
      }
    }
  });

  it('accepts only an object of named opaque references and does not echo submitted secrets', async () => {
    const fixture = await definition();
    for (const secretReferences of [[], null, new Date(), { key: 42 }, { key: {} }, { key: ['secret-id'] }, { key: '' }, { key: 'x'.repeat(129) }, { '': 'secret-id' }, { 'Bearer test-secret': 'test secret value' }]) {
      const result = parseSourceDefinition({ ...fixture, secretReferences });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('Bearer test-secret');
      expect(JSON.stringify(result)).not.toContain('test secret value');
    }
    expect(parseSourceDefinition({ ...fixture, secretReferences: {} }).success).toBe(true);
    expect(parseSourceDefinition({ ...fixture, secretReferences: { token: 'a'.repeat(128) } }).success).toBe(true);
  });

  it('uses the shared protocol compatibility policy', async () => {
    const fixture = await definition();
    const minor = parseSourceDefinition({ ...fixture, protocolVersion: '1.1' });
    expect(minor.success).toBe(true);
    expect(minor.warnings.some((issue) => issue.code === 'protocol_unknown_minor')).toBe(true);
    expect(parseSourceDefinition({ ...fixture, protocolVersion: '2.0' }).success).toBe(false);
    expect(parseSourceDefinition({ ...fixture, protocolVersion: 'v1' }).success).toBe(false);
  });

  it('keeps the existing SourceSnapshot shape compatible independently of definition metadata', async () => {
    const fixture = await loadFixture('source-snapshot.json') as Record<string, unknown>;
    expect(fixture.definitionVersion).toBeUndefined();
    expect(parseSourceSnapshot(fixture).success).toBe(true);
    const stale = { ...fixture, freshness: { state: 'stale' }, error: { code: 'connector_timeout', message: 'Source refresh timed out.', retryable: true } };
    const parsed = unwrap(parseSourceSnapshot(stale));
    expect(fixture.data).toEqual(parsed.data);
    expect(parsed.freshness.state).toBe('stale');
  });
});
