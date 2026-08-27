import { SetMetadata } from '@nestjs/common';
import type {
  DeliveryMode,
  DeviceCapabilities,
  DeviceProfile,
  DeliveryPolicy as DeliveryPolicyContract,
  ProtocolVersion,
} from '@inker/contracts';
import type { ResolvedDeviceConfiguration } from './device-configuration';
import type { DeliveryContext } from '../events/outbox.types';

export const TRANSPORT_ADAPTER_METADATA = Symbol('inker.transport-adapter');

export function RegisterTransportAdapter(): ClassDecorator {
  return SetMetadata(TRANSPORT_ADAPTER_METADATA, true);
}

export type LegacyDeviceType = 'trmnl' | 'web-display';
export type LegacyTransport = 'pull' | 'websocket';

export interface TransportRegistration {
  apiKey: string | null;
  externalId: string | null;
  pairingTokenHash: string | null;
  pairingExpiresAt: Date | null;
  bootstrap?: {
    pairingToken: string;
  };
}

export interface TransportAdapter {
  readonly adapterId: string;
  readonly transportMode: string;
  /** Implemented pull wire contract, independent of legacy device identity. */
  readonly pullProtocolVersion?: ProtocolVersion;
  readonly webSocketProtocolVersion?: ProtocolVersion;
  readonly legacy: {
    deviceType: LegacyDeviceType;
    transport: LegacyTransport;
  };
  prepareRegistration(input: { macAddress?: string }): TransportRegistration;
  rotateBootstrap?(device: { id: number; externalId: string | null }): TransportRegistration;
  /** With context: reuse the revision keyed by deliveryId on retry and honor signal. */
  dispatchRefresh(deviceId: number, context?: DeliveryContext): Promise<void>;
  /** Connected transports must drop sessions when their durable consumer lease expires. */
  deliveryLeaseExpired?(): void;
}

export interface DeliveryPolicy {
  readonly mode: DeliveryMode;
  readonly dispatchOnRefresh: boolean;
  selectTransport(capabilities: DeviceCapabilities): string;
  pullHints?(capabilities: DeviceCapabilities, policy: DeliveryPolicyContract): PullDeliveryHints;
}

export interface PullDeliveryHints {
  refreshAfterSeconds: number;
  telemetryIntervalSeconds: number;
}

export interface CreateProfileSelection {
  deviceType?: LegacyDeviceType;
  profileId?: string;
  deliveryPolicyId?: string;
  capabilitiesOverride?: unknown;
  width?: number;
  height?: number;
}

export interface ProfileResolver {
  resolveForCreate(selection: CreateProfileSelection): Promise<ResolvedDeviceConfiguration>;
  resolvePersisted(device: {
    profile: { profileId: string; protocolVersion: string; definition: unknown; defaultCapabilities: unknown };
    deliveryPolicy: { policyId: string; protocolVersion: string; mode: string; definition: unknown };
    capabilitiesOverride: unknown;
  }): ResolvedDeviceConfiguration;
}

export interface EffectiveDeviceExtension {
  profile: DeviceProfile;
  deliveryPolicy: DeliveryPolicyContract;
  capabilities: DeviceCapabilities;
  transportAdapter: TransportAdapter;
  deliveryStrategy: DeliveryPolicy;
}
