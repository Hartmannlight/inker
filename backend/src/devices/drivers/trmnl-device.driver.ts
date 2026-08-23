import { Injectable } from '@nestjs/common';
import {
  DEVICE_TRANSPORTS,
  DEVICE_TYPES,
  DeviceCapabilities,
  DeviceDriver,
} from './device-driver';

@Injectable()
export class TrmnlDeviceDriver implements DeviceDriver {
  readonly type = DEVICE_TYPES.TRMNL;
  readonly transport = DEVICE_TRANSPORTS.PULL;

  getDefaultCapabilities(width = 800, height = 480): DeviceCapabilities {
    return {
      display: { width, height, colorDepth: 1, formats: ['image/png', 'image/bmp'] },
      telemetry: ['battery', 'wifi', 'firmware'],
      interaction: [],
      realtime: false,
    };
  }
}
