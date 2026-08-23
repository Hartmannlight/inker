import { Injectable } from '@nestjs/common';
import {
  DEVICE_TRANSPORTS,
  DEVICE_TYPES,
  DeviceCapabilities,
  DeviceDriver,
} from './device-driver';

@Injectable()
export class WebDisplayDeviceDriver implements DeviceDriver {
  readonly type = DEVICE_TYPES.WEB_DISPLAY;
  readonly transport = DEVICE_TRANSPORTS.WEBSOCKET;

  getDefaultCapabilities(width = 1920, height = 1080): DeviceCapabilities {
    return {
      display: { width, height, colorDepth: 24, formats: ['image/png', 'image/jpeg', 'image/webp'] },
      telemetry: ['browser', 'viewport'],
      interaction: [],
      realtime: true,
    };
  }
}
