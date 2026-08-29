import { describe, expect, it } from 'bun:test';
import { HttpPullTransportAdapter } from './http-pull.transport-adapter';
import { WebSocketTransportAdapter } from './websocket.transport-adapter';
import { PULL_FIXTURE_ARTIFACTS } from './pull-fixture-artifacts';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

describe('built-in transport adapters', () => {
  it('exposes the versioned pull contract without altering TRMNL registration', () => {
    expect(new HttpPullTransportAdapter().pullProtocolVersion).toBe('1.0');
  });

  it('delivers real fixture images whose dimensions and hashes match their descriptors', async () => {
    for (const artifact of PULL_FIXTURE_ARTIFACTS) {
      expect(createHash('sha256').update(artifact.bytes).digest('hex')).toBe(artifact.sha256);
      if (artifact.format === 'bmp1') {
        expect(artifact.bytes.subarray(0, 2).toString()).toBe('BM');
        expect(artifact.bytes.readInt32LE(18)).toBe(artifact.width);
        expect(artifact.bytes.readInt32LE(22)).toBe(artifact.height);
        expect(artifact.bytes.readUInt16LE(28)).toBe(1);
        expect(artifact.bytes.readUInt32LE(2)).toBe(artifact.bytes.length);
      } else {
        const metadata = await sharp(artifact.bytes).metadata();
        expect(metadata.width).toBe(artifact.width);
        expect(metadata.height).toBe(artifact.height);
        expect(metadata.format).toBe('png');
        const raw = await sharp(artifact.bytes).raw().toBuffer();
        expect(raw.every((value) => value === 255)).toBe(true);
      }
    }
  });
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
    const registration = new WebSocketTransportAdapter(gateway as any).prepareRegistration();

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

    const rotated = adapter.rotateBootstrap({ externalId: 'stable-external-id' });
    await adapter.dispatchRefresh(9);

    expect(rotated.externalId).toBe('stable-external-id');
    expect(rotated.pairingTokenHash).not.toBe(rotated.bootstrap?.pairingToken);
    expect(dispatchedDeviceId).toBe(9);
  });
});
