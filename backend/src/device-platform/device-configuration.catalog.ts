import type {
  DeliveryPolicy,
  DeviceCapabilities,
  DeviceProfile,
} from '@inker/contracts';

export const BUILTIN_PROFILE_IDS = {
  TRMNL_7_5_MONO: 'trmnl-byod-7.5-mono',
  ESP32_TOUCH_REFERENCE: 'esp32-touch-reference-480x480',
  BROWSER_HD: 'browser-hd-1920x1080',
} as const;

export const BUILTIN_POLICY_IDS = {
  SLEEPY: 'reference-sleepy',
  RESPONSIVE_PULL: 'reference-responsive-pull',
  CONNECTED_EMBEDDED: 'reference-connected-embedded',
  CONNECTED_BROWSER: 'reference-connected-browser',
} as const;

export interface BuiltinDeviceProfile {
  profile: DeviceProfile;
  defaultCapabilities: DeviceCapabilities;
  provisioning: {
    legacyDeviceType: 'trmnl' | 'web-display';
    legacyDefault: boolean;
    defaultDeliveryPolicyId: string;
    compatibilityOverride?: Record<string, unknown>;
  };
}

const zeroSafeArea = { top: 0, right: 0, bottom: 0, left: 0 } as const;

export const BUILTIN_DEVICE_PROFILES: readonly BuiltinDeviceProfile[] = [
  {
    provisioning: {
      legacyDeviceType: 'trmnl',
      legacyDefault: true,
      defaultDeliveryPolicyId: BUILTIN_POLICY_IDS.SLEEPY,
      compatibilityOverride: {
        display: { renderFormats: ['png'], mimeTypes: ['image/png'] },
      },
    },
    profile: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO,
      label: 'TRMNL BYOD 7.5 monochrome',
      display: {
        width: 800,
        height: 480,
        colorSpace: 'monochrome',
        bitDepth: 1,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['bmp1'],
        mimeTypes: ['image/bmp'],
        eInk: { partialRefreshSupported: false },
      },
      interaction: { inputs: ['buttons'], audioOutput: false },
      supportedTransports: ['http-pull'],
      supportedEnergySources: ['battery', 'mains'],
    },
    defaultCapabilities: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.TRMNL_7_5_MONO,
      display: {
        width: 800,
        height: 480,
        colorSpace: 'monochrome',
        bitDepth: 1,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['bmp1'],
        mimeTypes: ['image/bmp'],
        eInk: { partialRefreshSupported: false },
      },
      transport: {
        modes: ['http-pull'],
        conditionalGet: true,
        pushManifests: false,
        reconnect: false,
        heartbeat: false,
      },
      energy: {
        source: 'battery',
        canSleep: true,
        telemetry: 'minimal',
      },
      interaction: { inputs: ['buttons'], audioOutput: false },
    },
  },
  {
    provisioning: {
      legacyDeviceType: 'web-display',
      legacyDefault: false,
      defaultDeliveryPolicyId: BUILTIN_POLICY_IDS.CONNECTED_EMBEDDED,
    },
    profile: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.ESP32_TOUCH_REFERENCE,
      label: 'ESP32 touch reference fixture (hardware mapping unverified)',
      display: {
        width: 480,
        height: 480,
        colorSpace: 'rgb',
        bitDepth: 16,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['png', 'jpeg'],
        mimeTypes: ['image/png', 'image/jpeg'],
      },
      interaction: { inputs: ['touch'], audioOutput: false, maxTouchPoints: 1 },
      supportedTransports: ['websocket', 'http-pull'],
      supportedEnergySources: ['mains'],
    },
    defaultCapabilities: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.ESP32_TOUCH_REFERENCE,
      display: {
        width: 480,
        height: 480,
        colorSpace: 'rgb',
        bitDepth: 16,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['png', 'jpeg'],
        mimeTypes: ['image/png', 'image/jpeg'],
      },
      transport: {
        modes: ['websocket', 'http-pull'],
        conditionalGet: true,
        pushManifests: true,
        reconnect: true,
        heartbeat: true,
      },
      energy: { source: 'mains', canSleep: false, telemetry: 'standard' },
      interaction: { inputs: ['touch'], audioOutput: false, maxTouchPoints: 1 },
    },
  },
  {
    provisioning: {
      legacyDeviceType: 'web-display',
      legacyDefault: true,
      defaultDeliveryPolicyId: BUILTIN_POLICY_IDS.CONNECTED_BROWSER,
    },
    profile: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.BROWSER_HD,
      label: 'Browser kiosk HD',
      display: {
        width: 1920,
        height: 1080,
        colorSpace: 'rgb',
        bitDepth: 24,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['html', 'png', 'jpeg'],
        mimeTypes: ['text/html', 'image/png', 'image/jpeg'],
      },
      interaction: { inputs: ['pointer'], audioOutput: true },
      supportedTransports: ['websocket', 'http-pull'],
      supportedEnergySources: ['mains'],
    },
    defaultCapabilities: {
      protocolVersion: '1.0',
      profileId: BUILTIN_PROFILE_IDS.BROWSER_HD,
      display: {
        width: 1920,
        height: 1080,
        colorSpace: 'rgb',
        bitDepth: 24,
        rotation: 0,
        safeArea: zeroSafeArea,
        scaling: 'contain',
        renderFormats: ['html', 'png', 'jpeg'],
        mimeTypes: ['text/html', 'image/png', 'image/jpeg'],
      },
      transport: {
        modes: ['websocket', 'http-pull'],
        conditionalGet: true,
        pushManifests: true,
        reconnect: true,
        heartbeat: true,
      },
      energy: { source: 'mains', canSleep: false, telemetry: 'standard' },
      interaction: { inputs: ['pointer'], audioOutput: true },
    },
  },
] as const;

export const BUILTIN_DELIVERY_POLICIES: readonly DeliveryPolicy[] = [
  {
    protocolVersion: '1.0',
    policyId: BUILTIN_POLICY_IDS.SLEEPY,
    mode: 'sleepy',
    pollIntervalSeconds: 900,
    telemetryIntervalSeconds: 3600,
    maxStaleSeconds: 86400,
  },
  {
    protocolVersion: '1.0',
    policyId: BUILTIN_POLICY_IDS.RESPONSIVE_PULL,
    mode: 'responsive-pull',
    pollIntervalSeconds: 60,
    telemetryIntervalSeconds: 300,
    maxStaleSeconds: 3600,
  },
  {
    protocolVersion: '1.0',
    policyId: BUILTIN_POLICY_IDS.CONNECTED_EMBEDDED,
    mode: 'connected',
    heartbeatSeconds: 30,
    reconnectBackoffSeconds: 5,
    telemetryIntervalSeconds: 60,
    maxStaleSeconds: 3600,
  },
  {
    protocolVersion: '1.0',
    policyId: BUILTIN_POLICY_IDS.CONNECTED_BROWSER,
    mode: 'connected',
    heartbeatSeconds: 20,
    reconnectBackoffSeconds: 2,
    telemetryIntervalSeconds: 60,
    maxStaleSeconds: 3600,
  },
] as const;
