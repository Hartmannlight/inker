import { Injectable } from '@nestjs/common';
import { generateToken, hashToken } from '../common/utils/crypto.util';
import { WebDisplayGateway } from './web-display.gateway';
import {
  RegisterTransportAdapter,
  type TransportAdapter,
  type TransportRegistration,
} from './device-extension.contracts';

@Injectable()
@RegisterTransportAdapter()
export class WebSocketTransportAdapter implements TransportAdapter {
  readonly adapterId = 'websocket';
  readonly transportMode = 'websocket';
  readonly legacy = { deviceType: 'web-display', transport: 'websocket' } as const;

  constructor(private readonly gateway: WebDisplayGateway) {}

  prepareRegistration(): TransportRegistration {
    return this.createBootstrap(generateToken(12));
  }

  rotateBootstrap(device: { externalId: string | null }): TransportRegistration {
    return this.createBootstrap(device.externalId ?? generateToken(12));
  }

  async dispatchRefresh(deviceId: number): Promise<void> {
    await this.gateway.pushPresentation(deviceId);
  }

  private createBootstrap(externalId: string): TransportRegistration {
    const pairingToken = generateToken(32);
    return {
      apiKey: null,
      externalId,
      pairingTokenHash: hashToken(pairingToken),
      pairingExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      bootstrap: { pairingToken },
    };
  }
}
