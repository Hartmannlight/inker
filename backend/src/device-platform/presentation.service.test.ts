import { beforeEach, describe, expect, it } from 'bun:test';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import { PresentationService } from './presentation.service';
import { BUILTIN_DEVICE_PROFILES, BUILTIN_DELIVERY_POLICIES } from './device-configuration.catalog';
import { canonicalJson, sha256 } from '../publications/publication-content';

describe('PresentationService', () => {
  let prisma: MockPrisma;
  let service: PresentationService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new PresentationService(prisma as any);
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
});
