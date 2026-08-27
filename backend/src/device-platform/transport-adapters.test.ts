import { describe, expect, it } from 'bun:test';
import { HttpPullTransportAdapter } from './http-pull.transport-adapter';
import { WebSocketTransportAdapter } from './websocket.transport-adapter';

describe('built-in transport adapters', () => {
  it('prepares the existing TRMNL pull credential shape without web bootstrap material', () => {
    const registration = new HttpPullTransportAdapter().prepareRegistration({
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });

    expect(registration.apiKey).toHaveLength(43);
    expect(registration.externalId).toBeNull();
    expect(registration.pairingTokenHash).toBeNull();
    expect(registration.bootstrap).toBeUndefined();
  });

  it('requires a MAC address for the legacy pull registration path', () => {
    expect(() => new HttpPullTransportAdapter().prepareRegistration({})).toThrow(
      'MAC address is required for TRMNL devices',
    );
  });

  it('prepares the existing WebDisplay bootstrap while persisting only its hash', () => {
    const gateway = { pushPresentation: async () => undefined };
    const registration = new WebSocketTransportAdapter(gateway as any).prepareRegistration({});

    expect(registration.apiKey).toBeNull();
    expect(registration.externalId).toHaveLength(16);
    expect(registration.pairingTokenHash).toHaveLength(64);
    expect(registration.bootstrap?.pairingToken).toHaveLength(43);
    expect(registration.pairingTokenHash).not.toBe(registration.bootstrap?.pairingToken);
  });

  it('rotates WebDisplay bootstrap material without changing its public identity', async () => {
    let dispatchedDeviceId: number | undefined;
    const adapter = new WebSocketTransportAdapter({
      pushPresentation: async (deviceId: number) => { dispatchedDeviceId = deviceId; },
    } as any);

    const rotated = adapter.rotateBootstrap({ id: 9, externalId: 'stable-external-id' });
    await adapter.dispatchRefresh(9);

    expect(rotated.externalId).toBe('stable-external-id');
    expect(rotated.pairingTokenHash).not.toBe(rotated.bootstrap?.pairingToken);
    expect(dispatchedDeviceId).toBe(9);
  });
});
