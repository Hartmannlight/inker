import { describe, expect, it } from 'bun:test';
import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  RegisterTransportAdapter,
  type TransportAdapter,
} from './device-extension.contracts';
import { TransportAdapterRegistry } from './transport-adapter.registry';

@Injectable()
@RegisterTransportAdapter()
class DummyMqttAdapter implements TransportAdapter {
  readonly adapterId = 'test-mqtt';
  readonly transportMode = 'mqtt';
  readonly legacy = { deviceType: 'web-display', transport: 'websocket' } as const;

  prepareRegistration() {
    return {
      apiKey: null,
      externalId: null,
    };
  }

  async dispatchRefresh() {}
}

describe('TransportAdapterRegistry discovery contract', () => {
  it('discovers a dummy adapter without changing DevicesService or a central adapter list', async () => {
    const module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [TransportAdapterRegistry, DummyMqttAdapter],
    }).compile();
    await module.init();

    const registry = module.get(TransportAdapterRegistry);
    expect(registry.get('mqtt').adapterId).toBe('test-mqtt');
    expect(registry.list().map((adapter) => adapter.transportMode)).toEqual(['mqtt']);

    await module.close();
  });

  it('reports an unknown adapter as a checked error', async () => {
    const module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [TransportAdapterRegistry],
    }).compile();
    await module.init();

    expect(() => module.get(TransportAdapterRegistry).get('mqtt')).toThrow(
      'Unsupported transport adapter: mqtt',
    );

    await module.close();
  });
});
