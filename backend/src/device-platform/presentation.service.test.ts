import { beforeEach, describe, expect, it } from 'bun:test';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import { PresentationService } from './presentation.service';
import { BUILTIN_DEVICE_PROFILES, BUILTIN_DELIVERY_POLICIES } from './device-configuration.catalog';
import { canonicalJson, sha256 } from '../publications/publication-content';
import { publicationArtifacts } from '../publications/publication-content';
import { resolveDeviceConfiguration } from './device-configuration';
import { PullArtifactLeaseService } from './pull-artifact-lease.service';

describe('PresentationService', () => {
  let prisma: MockPrisma;
  let service: PresentationService;

  beforeEach(() => {
    prisma = createMockPrisma();
    const resolver = { resolve: async (device: any, desired: any) => {
      const configuration = resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride);
      return { configuration, target: {}, revision: desired, artifact: publicationArtifacts(desired)[0], fallback: false };
    } };
    service = new PresentationService(prisma as any, resolver as any, new PullArtifactLeaseService());
    const profile = BUILTIN_DEVICE_PROFILES[2];
    const policy = BUILTIN_DELIVERY_POLICIES.find(p => p.policyId === 'reference-connected-browser')!;
    prisma.device.findUnique.mockResolvedValue({ id: 3, externalId: 'browser-3', presentationRevision: 4,
      createdAt: new Date('2026-01-01'), profile: { ...profile.profile, definition: profile.profile, defaultCapabilities: profile.defaultCapabilities },
      deliveryPolicy: { ...policy, definition: policy }, capabilitiesOverride: null, publicationState: null });
  });

  it('assembles only the persisted publication; draft URLs never reach the manifest', async () => {
    const device = await prisma.device.findUnique();
    const content = { schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-png'] };
    prisma.device.findUnique.mockResolvedValue({ ...device, playlist: { items: [{ screen: { imageUrl: '/uploads/secret.png' } }] },
      publicationState: { desiredSequence: 4, desiredRevision: { protocolVersion: '1.0', content, contentHash: sha256(canonicalJson(content)), publishedAt: new Date('2026-08-27') } } });
    const result = await service.getForDevice(3);
    expect(result.content.url).toMatch(/^\/api\/web-displays\/browser-3\/artifacts\/[a-f0-9]{64}$/);
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
    expect(result.nextTransitionAt).toBeNull();
    expect(result.generatedAt).toBe('2026-08-27T00:00:00.000Z');
    expect(prisma.device.update.calls).toHaveLength(0);
  });

  it('returns a stable unassigned page without implicitly publishing or rendering a draft', async () => {
    const result = await service.getForDevice(3);
    expect(result.content.url).toBe('/assets/publication-unassigned.svg');
    expect(result.nextTransitionAt).toBeNull();
    for (let i = 0; i < 100; i++) expect(await service.getForDevice(3)).toEqual(result);
    expect(prisma.device.update.calls).toHaveLength(0);
    expect(prisma.publicationRevision.create.calls).toHaveLength(0);
  });

  it('resolves the manifest before taking the writer and preserves a concurrent receipt', async () => {
    const saved = await service.getForDevice(3);
    const concurrent = { ...saved, revision: saved.revision + 1 };
    const device = await prisma.device.findUnique();
    let inTransaction = false, reads = 0;
    prisma.device.findUnique.mockImplementation(async () => {
      expect(inTransaction).toBe(false);
      reads++;
      return device;
    });
    const receipt = { findUniqueOrThrow: async () => ({ deviceId: 3, presentation: inTransaction ? concurrent : null }) };
    Object.assign(prisma.outboxDelivery, receipt);
    prisma.$transaction.mockImplementation(async (callback: any) => {
      inTransaction = true;
      try { return await callback({ ...prisma, $executeRaw: async () => 1 }); }
      finally { inTransaction = false; }
    });
    expect(await service.getForDevice(3, { deliveryId: 'delivery', signal: new AbortController().signal })).toEqual(concurrent);
    expect(reads).toBe(1);
    expect(prisma.outboxDelivery.update.calls).toHaveLength(0);
  });

  it('does not persist a presentation if cancellation arrives during resolution', async () => {
    const device = await prisma.device.findUnique();
    const abort = new AbortController();
    Object.assign(prisma.outboxDelivery, { findUniqueOrThrow: async () => ({ deviceId: 3, presentation: null }) });
    prisma.device.findUnique.mockImplementation(async () => { abort.abort(); return device; });
    await expect(service.getForDevice(3, { deliveryId: 'delivery', signal: abort.signal })).rejects.toThrow();
    expect(prisma.$transaction.calls).toHaveLength(0);
    expect(prisma.outboxDelivery.update.calls).toHaveLength(0);
  });

  it('uses the same device-themed dynamic artifact for the admin preview', async () => {
    const device = await prisma.device.findUnique();
    const content = { schemaVersion: 1, image: { png: Buffer.from('old').toString('base64'), width: 480, height: 480, sha256: sha256(Buffer.from('old')) } };
    const revision = { publicationId: 'p', publicationRevisionId: 'r', revision: 1, protocolVersion: '1.0', content,
      contentHash: sha256(canonicalJson(content)), publishedAt: new Date('2026-08-30'), createdAt: new Date('2026-08-30') };
    prisma.device.findUnique.mockResolvedValue({ ...device, configuration: { displayControl: { backgroundColor: '#000000' } },
      publicationState: { desiredSequence: 5, desiredRevision: revision } });
    const themed: import('../publications/publication-content').PublishedArtifact = { format: 'png', mimeType: 'image/png', width: 480, height: 480, colorSpace: 'rgb', bitDepth: 24,
      rotation: 0, bytes: Buffer.from('dark-preview'), sha256: sha256(Buffer.from('dark-preview')) };
    const resolver = { resolve: async (device: any) => ({
      configuration: resolveDeviceConfiguration(device.profile, device.deliveryPolicy, device.capabilitiesOverride),
      target: {}, revision, artifact: themed, fallback: false, rendererVersion: 'dynamic-device-design-v1',
    }) };
    service = new PresentationService(prisma as any, resolver as any, new PullArtifactLeaseService());

    expect(await service.preview(3)).toEqual(themed);
    const manifest = await service.getForDevice(3);
    expect(manifest.content.url).toEndWith(`/artifacts/${themed.sha256}`);
    expect(await service.artifact(3, themed.sha256)).toEqual(themed);
  });
});
