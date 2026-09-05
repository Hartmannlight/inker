import { describe, expect, it, mock } from 'bun:test';
import { NotAcceptableException } from '@nestjs/common';
import { BUILTIN_DELIVERY_POLICIES, BUILTIN_DEVICE_PROFILES } from './device-configuration.catalog';
import { DeviceArtifactResolverService } from './device-artifact-resolver.service';
import { canonicalJson, sha256 } from '../publications/publication-content';

const bytes = Buffer.from('device-artifact');
const content = { schemaVersion: 1, image: { png: bytes.toString('base64'), width: 1920, height: 1080, sha256: sha256(bytes) } };
const revision = {
  publicationId: 'p', publicationRevisionId: 'r', revision: 1, protocolVersion: '1.0', content,
  contentHash: sha256(canonicalJson(content)), publishedAt: new Date('2026-08-30'), createdAt: new Date('2026-08-30'),
};

function device() {
  const profile = BUILTIN_DEVICE_PROFILES[2];
  const policy = BUILTIN_DELIVERY_POLICIES.find(entry => entry.policyId === 'reference-connected-browser')!;
  return {
    id: 3, name: 'Browser', battery: null, wifi: null, firmwareVersion: null, macAddress: null, configuration: null,
    capabilitiesOverride: null,
    profile: { ...profile.profile, definition: profile.profile, defaultCapabilities: profile.defaultCapabilities },
    deliveryPolicy: { ...policy, definition: policy },
  };
}

describe('DeviceArtifactResolverService', () => {
  it('makes a device-themed artifact authoritative over cache and publication bytes', async () => {
    const themed = { format: 'png', mimeType: 'image/png', width: 1920, height: 1080, colorSpace: 'rgb', bitDepth: 24,
      rotation: 0, bytes: Buffer.from('themed'), sha256: sha256(Buffer.from('themed')) } as const;
    const cache = { read: mock(async () => ({ revision, artifact: { ...themed, bytes: Buffer.from('stale') }, fallback: false })) };
    const dynamic = { render: mock(async () => themed) };
    const service = new DeviceArtifactResolverService({} as never, cache as never, dynamic as never);

    const resolved = await service.resolve(device() as never, revision as never);
    expect(resolved.artifact).toEqual(themed);
    expect(resolved.rendererVersion).toBe('dynamic-device-design-v1');
  });

  it('rejects artifacts that differ from the exact target instead of silently adapting per transport', async () => {
    const incompatible = { format: 'png', mimeType: 'image/png', width: 800, height: 480, colorSpace: 'rgb', bitDepth: 24,
      rotation: 0, bytes, sha256: sha256(bytes) } as const;
    const service = new DeviceArtifactResolverService({} as never,
      { read: mock(async () => ({ revision, artifact: incompatible, fallback: false })) } as never,
      { render: mock(async () => undefined) } as never);

    await expect(service.resolve(device() as never, revision as never)).rejects.toBeInstanceOf(NotAcceptableException);
  });
});
