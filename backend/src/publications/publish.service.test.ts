import { describe, expect, it, mock } from 'bun:test';
import { PublishService } from './publish.service';

describe('PublishService design snapshots', () => {
  it('renders a designer screen when no browser capture exists', async () => {
    const updatedAt = new Date('2026-08-30T20:00:00.000Z');
    const renderScreenDesign = mock(async () => Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const prisma = {
      screenDesign: {
        findUnique: mock(async () => ({ id: 987654, name: 'Status', width: 800, height: 480,
          background: '#ffffff', updatedAt, widgets: [] })),
      },
    };
    const service = new PublishService(prisma as never, {} as never, { renderScreenDesign } as never);

    const snapshot = await service.snapshotDraft({ screenDesignId: 987654, expectedUpdatedAt: updatedAt.toISOString() });

    expect(renderScreenDesign).toHaveBeenCalledWith(987654, undefined, 'preview');
    expect(snapshot.content.image).toMatchObject({ width: 1, height: 1 });
    expect(snapshot.content.dynamicDesign).toEqual({
      screenDesignId: 987654,
      expectedUpdatedAt: updatedAt.toISOString(),
      refreshSeconds: 60,
    });
    expect(snapshot.content.designSnapshot).toEqual({
      version: 1, id: 987654, name: 'Status', width: 800, height: 480, background: '#ffffff', widgets: [],
    });
  });
});
