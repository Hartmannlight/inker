import { Injectable } from '@nestjs/common';
import { generateToken } from '../common/utils/crypto.util';
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
  readonly webSocketProtocolVersion = '1.0';
  readonly legacy = { deviceType: 'web-display', transport: 'websocket' } as const;

  constructor(private readonly gateway: WebDisplayGateway) {}

  prepareRegistration(): TransportRegistration {
    return { apiKey: null, externalId: generateToken(12) };
  }

  async dispatchRefresh(deviceId: number, context?: import('../events/outbox.types').DeliveryContext): Promise<void> {
    if (context?.stateTopic === 'timers') await this.gateway.pushTimersChanged(deviceId, context);
    else await this.gateway.pushPresentation(deviceId, context);
  }

  deliveryLeaseExpired() { this.gateway.expireDeliveryConnections(); }
}
