import { BadRequestException, Injectable } from '@nestjs/common';
import { generateToken } from '../common/utils/crypto.util';
import {
  RegisterTransportAdapter,
  type TransportAdapter,
  type TransportRegistration,
} from './device-extension.contracts';

@Injectable()
@RegisterTransportAdapter()
export class HttpPullTransportAdapter implements TransportAdapter {
  readonly adapterId = 'http-pull';
  readonly transportMode = 'http-pull';
  readonly legacy = { deviceType: 'trmnl', transport: 'pull' } as const;

  prepareRegistration(input: { macAddress?: string }): TransportRegistration {
    if (!input.macAddress) throw new BadRequestException('MAC address is required for TRMNL devices');
    return {
      apiKey: generateToken(32),
      externalId: null,
      pairingTokenHash: null,
      pairingExpiresAt: null,
    };
  }

  async dispatchRefresh(): Promise<void> {}
}
