import { beforeEach, describe, expect, it } from 'bun:test';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import { PresentationService } from './presentation.service';

describe('PresentationService', () => {
  let prisma: MockPrisma;
  let service: PresentationService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new PresentationService(prisma as any);
    prisma.device.update.mockResolvedValue({ presentationRevision: 4 });
  });

  it('creates a transport-neutral manifest for an uploaded screen', async () => {
    prisma.device.findUnique.mockResolvedValue({
      id: 3,
      name: 'Browser',
      externalId: 'browser-3',
      width: 1920,
      height: 1080,
      lastScreenId: null,
      screenStartedAt: null,
      playlist: {
        items: [{ id: 10, duration: 30, screen: { id: 5, name: 'Status', imageUrl: '/uploads/status.png' }, screenDesign: null, pluginInstance: null }],
      },
    });

    const result = await service.getForDevice(3);

    expect(result.content.url).toBe('/uploads/status.png');
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
    expect(result.nextTransitionAt).not.toBeNull();
    expect(prisma.device.update.calls[0][0].data.lastScreenId).toBe('screen-5');
  });

  it('uses the existing device preview endpoint when no playlist is assigned', async () => {
    prisma.device.findUnique.mockResolvedValue({
      id: 3,
      name: 'Browser',
      externalId: 'browser-3',
      width: 0,
      height: 0,
      lastScreenId: null,
      screenStartedAt: null,
      playlist: null,
    });

    const result = await service.getForDevice(3);
    expect(result.content.url).toContain('/api/device-images/device/3');
    expect(result.nextTransitionAt).toBeNull();
  });
});
