export const DEVICE_TYPES = {
  TRMNL: 'trmnl',
  WEB_DISPLAY: 'web-display',
} as const;

export const DEVICE_TRANSPORTS = {
  PULL: 'pull',
  WEBSOCKET: 'websocket',
} as const;

export type DeviceType = (typeof DEVICE_TYPES)[keyof typeof DEVICE_TYPES];
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[keyof typeof DEVICE_TRANSPORTS];

export interface DeviceCapabilities {
  display: {
    width: number;
    height: number;
    colorDepth: number;
    formats: string[];
  };
  telemetry: string[];
  interaction: string[];
  realtime: boolean;
}

export interface DeviceDriver {
  readonly type: DeviceType;
  readonly transport: DeviceTransport;
  getDefaultCapabilities(width?: number, height?: number): DeviceCapabilities;
}
