import { validateProtocolVersion, type ProtocolVersion } from './protocol';
import {
  addIssue,
  asRecord,
  optionalInteger,
  parseContract,
  requiredBoolean,
  requiredEnum,
  requiredEnumArray,
  requiredInteger,
  requiredString,
  requiredStringArray,
  type ParseResult,
  type ValidationContext,
  type ValidationIssue,
} from './validation';

export const RENDER_FORMATS = ['html', 'png', 'jpeg', 'bmp1'] as const;
export const TRANSPORT_MODES = ['http-pull', 'websocket'] as const;
export const ENERGY_SOURCES = ['battery', 'mains', 'hybrid'] as const;
export const INTERACTION_INPUTS = ['touch', 'buttons', 'pointer'] as const;
export const DELIVERY_MODES = ['sleepy', 'responsive-pull', 'connected'] as const;

export type RenderFormat = (typeof RENDER_FORMATS)[number];
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export type EnergySource = (typeof ENERGY_SOURCES)[number];
export type InteractionInput = (typeof INTERACTION_INPUTS)[number];
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DisplayCapabilities {
  width: number;
  height: number;
  colorSpace: 'monochrome' | 'grayscale' | 'rgb';
  bitDepth: number;
  pixelDensityDpi?: number;
  rotation: 0 | 90 | 180 | 270;
  safeArea: SafeArea;
  scaling: 'none' | 'contain' | 'cover';
  renderFormats: RenderFormat[];
  mimeTypes: string[];
  eInk?: {
    partialRefreshSupported: boolean;
    fullRefreshAfterUpdates?: number;
  };
}

export interface TransportCapabilities {
  modes: TransportMode[];
  conditionalGet: boolean;
  pushManifests: boolean;
  reconnect: boolean;
  heartbeat: boolean;
}

export interface EnergyCapabilities {
  source: EnergySource;
  canSleep: boolean;
  telemetry: 'minimal' | 'standard';
  recommendedMinRefreshSeconds?: number;
}

export interface InteractionCapabilities {
  inputs: InteractionInput[];
  audioOutput: boolean;
  maxTouchPoints?: number;
}

export interface DeviceProfile {
  protocolVersion: ProtocolVersion;
  profileId: string;
  label: string;
  display: DisplayCapabilities;
  interaction: InteractionCapabilities;
  supportedTransports: TransportMode[];
  supportedEnergySources: EnergySource[];
}

export interface DeviceCapabilities {
  protocolVersion: ProtocolVersion;
  profileId: string;
  display: DisplayCapabilities;
  transport: TransportCapabilities;
  energy: EnergyCapabilities;
  interaction: InteractionCapabilities;
}

export interface DeliveryPolicy {
  protocolVersion: ProtocolVersion;
  policyId: string;
  mode: DeliveryMode;
  pollIntervalSeconds?: number;
  heartbeatSeconds?: number;
  reconnectBackoffSeconds?: number;
  telemetryIntervalSeconds: number;
  maxStaleSeconds: number;
}

export function parseDeviceProfile(value: unknown): ParseResult<DeviceProfile> {
  return parseContract(value, validateDeviceProfile);
}

export function parseDeviceCapabilities(value: unknown): ParseResult<DeviceCapabilities> {
  return parseContract(value, validateDeviceCapabilities);
}

export function parseDeliveryPolicy(value: unknown): ParseResult<DeliveryPolicy> {
  return parseContract(value, validateDeliveryPolicy);
}

function validateDeviceProfile(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is DeviceProfile {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'profileId', context, path);
  requiredString(record, 'label', context, path);
  validateDisplay(record.display, context, `${path}.display`);
  validateInteraction(record.interaction, context, `${path}.interaction`);
  requiredEnumArray(record, 'supportedTransports', TRANSPORT_MODES, context, path);
  requiredEnumArray(record, 'supportedEnergySources', ENERGY_SOURCES, context, path);
  return context.errors.length === 0;
}

function validateDeviceCapabilities(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is DeviceCapabilities {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'profileId', context, path);
  validateDisplay(record.display, context, `${path}.display`);
  validateTransport(record.transport, context, `${path}.transport`);
  validateEnergy(record.energy, context, `${path}.energy`);
  validateInteraction(record.interaction, context, `${path}.interaction`);
  return context.errors.length === 0;
}

function validateDeliveryPolicy(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is DeliveryPolicy {
  const record = asRecord(value, context, path);
  if (!record) return false;
  validateProtocolVersion(record.protocolVersion, context, `${path}.protocolVersion`);
  requiredString(record, 'policyId', context, path);
  const mode = requiredEnum(record, 'mode', DELIVERY_MODES, context, path);
  const poll = optionalInteger(record, 'pollIntervalSeconds', context, path, { minimum: 1 });
  const heartbeat = optionalInteger(record, 'heartbeatSeconds', context, path, { minimum: 1 });
  const reconnect = optionalInteger(record, 'reconnectBackoffSeconds', context, path, { minimum: 1 });
  requiredInteger(record, 'telemetryIntervalSeconds', context, path, { minimum: 1 });
  requiredInteger(record, 'maxStaleSeconds', context, path, { minimum: 1 });
  if ((mode === 'sleepy' || mode === 'responsive-pull') && poll === undefined) {
    addIssue(context, 'error', 'poll_interval_required', `${path}.pollIntervalSeconds`, `${mode} delivery requires a polling interval.`);
  }
  if (mode === 'connected' && (heartbeat === undefined || reconnect === undefined)) {
    addIssue(context, 'error', 'connection_policy_required', path, 'Connected delivery requires heartbeatSeconds and reconnectBackoffSeconds.');
  }
  return context.errors.length === 0;
}

function validateDisplay(value: unknown, context: ValidationContext, path: string): value is DisplayCapabilities {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredInteger(record, 'width', context, path, { minimum: 1 });
  requiredInteger(record, 'height', context, path, { minimum: 1 });
  requiredEnum(record, 'colorSpace', ['monochrome', 'grayscale', 'rgb'] as const, context, path);
  requiredInteger(record, 'bitDepth', context, path, { minimum: 1, maximum: 32 });
  optionalInteger(record, 'pixelDensityDpi', context, path, { minimum: 1 });
  const rotation = record.rotation;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    addIssue(context, 'error', 'unsupported_rotation', `${path}.rotation`, 'Expected rotation 0, 90, 180, or 270.');
  }
  validateSafeArea(record.safeArea, context, `${path}.safeArea`);
  requiredEnum(record, 'scaling', ['none', 'contain', 'cover'] as const, context, path);
  requiredEnumArray(record, 'renderFormats', RENDER_FORMATS, context, path);
  requiredStringArray(record, 'mimeTypes', context, path);
  if (record.eInk !== undefined) validateEInk(record.eInk, context, `${path}.eInk`);
  return context.errors.length === 0;
}

function validateSafeArea(value: unknown, context: ValidationContext, path: string): value is SafeArea {
  const record = asRecord(value, context, path);
  if (!record) return false;
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    requiredInteger(record, edge, context, path, { minimum: 0 });
  }
  return context.errors.length === 0;
}

function validateEInk(value: unknown, context: ValidationContext, path: string): boolean {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredBoolean(record, 'partialRefreshSupported', context, path);
  optionalInteger(record, 'fullRefreshAfterUpdates', context, path, { minimum: 1 });
  return context.errors.length === 0;
}

function validateTransport(value: unknown, context: ValidationContext, path: string): value is TransportCapabilities {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredEnumArray(record, 'modes', TRANSPORT_MODES, context, path);
  requiredBoolean(record, 'conditionalGet', context, path);
  requiredBoolean(record, 'pushManifests', context, path);
  requiredBoolean(record, 'reconnect', context, path);
  requiredBoolean(record, 'heartbeat', context, path);
  return context.errors.length === 0;
}

function validateEnergy(value: unknown, context: ValidationContext, path: string): value is EnergyCapabilities {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredEnum(record, 'source', ENERGY_SOURCES, context, path);
  requiredBoolean(record, 'canSleep', context, path);
  requiredEnum(record, 'telemetry', ['minimal', 'standard'] as const, context, path);
  optionalInteger(record, 'recommendedMinRefreshSeconds', context, path, { minimum: 1 });
  return context.errors.length === 0;
}

function validateInteraction(value: unknown, context: ValidationContext, path: string): value is InteractionCapabilities {
  const record = asRecord(value, context, path);
  if (!record) return false;
  requiredEnumArray(record, 'inputs', INTERACTION_INPUTS, context, path, { allowEmpty: true });
  requiredBoolean(record, 'audioOutput', context, path);
  optionalInteger(record, 'maxTouchPoints', context, path, { minimum: 1 });
  return context.errors.length === 0;
}

export function validateDeviceConfiguration(
  profile: DeviceProfile,
  capabilities: DeviceCapabilities,
  policy: DeliveryPolicy,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: string, path: string, message: string) => issues.push({ code, path, message, severity: 'error' });

  if (profile.profileId !== capabilities.profileId) {
    push('profile_mismatch', '$.capabilities.profileId', 'Capabilities must reference the selected profile.');
  }
  if (!profile.supportedEnergySources.includes(capabilities.energy.source)) {
    push('unsupported_energy_source', '$.capabilities.energy.source', 'Energy source is not supported by the selected profile.');
  }
  for (const mode of capabilities.transport.modes) {
    if (!profile.supportedTransports.includes(mode)) {
      push('unsupported_transport', '$.capabilities.transport.modes', `Transport ${mode} is not supported by the selected profile.`);
    }
  }
  if ((policy.mode === 'sleepy' || policy.mode === 'responsive-pull') && !capabilities.transport.modes.includes('http-pull')) {
    push('delivery_transport_mismatch', '$.deliveryPolicy.mode', `${policy.mode} delivery requires http-pull capability.`);
  }
  if (policy.mode === 'connected' && !capabilities.transport.modes.includes('websocket')) {
    push('delivery_transport_mismatch', '$.deliveryPolicy.mode', 'Connected delivery requires websocket capability.');
  }
  return issues;
}
