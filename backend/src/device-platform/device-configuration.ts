import {
  parseDeliveryPolicy,
  parseDeviceCapabilities,
  parseDeviceProfile,
  validateDeviceConfiguration,
  type DeliveryPolicy,
  type DeviceCapabilities,
  type DeviceProfile,
  type ParseResult,
} from '@inker/contracts';

type JsonRecord = Record<string, unknown>;

export type DeviceCapabilitiesOverride = {
  display?: Partial<DeviceCapabilities['display']> & {
    safeArea?: Partial<DeviceCapabilities['display']['safeArea']>;
    eInk?: Partial<NonNullable<DeviceCapabilities['display']['eInk']>>;
  };
  transport?: Partial<DeviceCapabilities['transport']>;
  energy?: Partial<DeviceCapabilities['energy']>;
  interaction?: Partial<DeviceCapabilities['interaction']>;
};

export interface PersistedDeviceProfile {
  profileId: string;
  protocolVersion: string;
  definition: unknown;
  defaultCapabilities: unknown;
}

export interface PersistedDeliveryPolicy {
  policyId: string;
  protocolVersion: string;
  mode: string;
  definition: unknown;
}

export interface ResolvedDeviceConfiguration {
  profile: DeviceProfile;
  deliveryPolicy: DeliveryPolicy;
  capabilitiesOverride: DeviceCapabilitiesOverride | null;
  capabilities: DeviceCapabilities;
}

const OVERRIDE_KEYS = {
  display: new Set([
    'width', 'height', 'colorSpace', 'bitDepth', 'pixelDensityDpi', 'rotation',
    'safeArea', 'scaling', 'renderFormats', 'mimeTypes', 'eInk',
  ]),
  transport: new Set(['modes', 'conditionalGet', 'pushManifests', 'reconnect', 'heartbeat']),
  energy: new Set(['source', 'canSleep', 'telemetry', 'recommendedMinRefreshSeconds']),
  interaction: new Set(['inputs', 'audioOutput', 'maxTouchPoints']),
} as const;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function unwrap<T>(result: ParseResult<T>, label: string): T {
  if (result.success) return result.data;
  throw new Error(`${label} is invalid: ${result.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
}

export function normalizeCapabilitiesOverride(value: unknown): DeviceCapabilitiesOverride | null {
  if (value === undefined || value === null) return null;
  const override = asRecord(value, 'capabilitiesOverride');
  const allowedSections = new Set(Object.keys(OVERRIDE_KEYS));
  for (const key of Object.keys(override)) {
    if (!allowedSections.has(key)) {
      throw new Error(`capabilitiesOverride.${key} is not an overridable capability section`);
    }
  }
  for (const section of Object.keys(OVERRIDE_KEYS) as Array<keyof typeof OVERRIDE_KEYS>) {
    if (override[section] === undefined) continue;
    const sectionValue = asRecord(override[section], `capabilitiesOverride.${section}`);
    for (const key of Object.keys(sectionValue)) {
      if (!OVERRIDE_KEYS[section].has(key)) {
        throw new Error(`capabilitiesOverride.${section}.${key} is not overridable`);
      }
    }
  }
  return structuredClone(override) as DeviceCapabilitiesOverride;
}

function mergeCapabilities(
  defaults: DeviceCapabilities,
  override: DeviceCapabilitiesOverride | null,
): DeviceCapabilities {
  if (!override) return structuredClone(defaults);
  return {
    ...structuredClone(defaults),
    display: {
      ...defaults.display,
      ...override.display,
      safeArea: {
        ...defaults.display.safeArea,
        ...override.display?.safeArea,
      },
      ...(defaults.display.eInk || override.display?.eInk
        ? { eInk: { ...defaults.display.eInk, ...override.display?.eInk } as DeviceCapabilities['display']['eInk'] }
        : {}),
    },
    transport: { ...defaults.transport, ...override.transport },
    energy: { ...defaults.energy, ...override.energy },
    interaction: { ...defaults.interaction, ...override.interaction },
  };
}

export function resolveDeviceConfiguration(
  persistedProfile: PersistedDeviceProfile,
  persistedPolicy: PersistedDeliveryPolicy,
  rawOverride: unknown,
): ResolvedDeviceConfiguration {
  const profile = unwrap(parseDeviceProfile(persistedProfile.definition), 'DeviceProfile');
  const defaults = unwrap(
    parseDeviceCapabilities(persistedProfile.defaultCapabilities),
    'DeviceProfile.defaultCapabilities',
  );
  const deliveryPolicy = unwrap(parseDeliveryPolicy(persistedPolicy.definition), 'DeliveryPolicy');

  if (profile.profileId !== persistedProfile.profileId || profile.protocolVersion !== persistedProfile.protocolVersion) {
    throw new Error('DeviceProfile identity columns do not match its contract definition');
  }
  if (defaults.profileId !== profile.profileId) {
    throw new Error('DeviceProfile.defaultCapabilities references a different profile');
  }
  if (
    deliveryPolicy.policyId !== persistedPolicy.policyId ||
    deliveryPolicy.protocolVersion !== persistedPolicy.protocolVersion ||
    deliveryPolicy.mode !== persistedPolicy.mode
  ) {
    throw new Error('DeliveryPolicy identity columns do not match its contract definition');
  }

  const capabilitiesOverride = normalizeCapabilitiesOverride(rawOverride);
  const capabilities = unwrap(
    parseDeviceCapabilities(mergeCapabilities(defaults, capabilitiesOverride)),
    'effective DeviceCapabilities',
  );
  const issues = validateDeviceConfiguration(profile, capabilities, deliveryPolicy);
  if (issues.length > 0) {
    throw new Error(`Device configuration is incompatible: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  return { profile, deliveryPolicy, capabilitiesOverride, capabilities };
}
