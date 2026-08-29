import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ScreenDesignerController } from './screen-designer.controller';

function response() {
  const value: any = {
    set: mock(() => value),
    vary: mock(() => value),
    status: mock(() => value),
    type: mock(() => value),
    send: mock(() => value),
    end: mock(() => value),
  };
  return value;
}

describe('ScreenDesignerController preview', () => {
  test('returns an authenticated PNG thumbnail with a stable ETag', async () => {
    const designs = { getScreenDesign: mock(async () => ({ id: 5 })) };
    const renderer = { renderPreview: mock(async () => Buffer.from('preview-pixels')) };
    const controller = new ScreenDesignerController(designs as any, {} as any, renderer as any);
    const result = response();
    await controller.getPreview(5, undefined, result);
    expect(result.type).toHaveBeenCalledWith('image/png');
    expect(result.send).toHaveBeenCalledWith(Buffer.from('preview-pixels'));
    expect(result.set.mock.calls[0][0]).toMatchObject({ 'Cache-Control': 'private, no-cache', ETag: expect.stringMatching(/^"[a-f0-9]{64}"$/) });
  });

  test('honours a matching ETag without sending pixels', async () => {
    const designs = { getScreenDesign: mock(async () => ({ id: 5 })) };
    const renderer = { renderPreview: mock(async () => Buffer.from('preview-pixels')) };
    const controller = new ScreenDesignerController(designs as any, {} as any, renderer as any);
    const result = response();
    const etag = createHash('sha256').update('preview-pixels').digest('hex');
    await controller.getPreview(5, `W/"${etag}"`, result);
    expect(result.status).toHaveBeenCalledWith(304);
    expect(result.send).not.toHaveBeenCalled();
  });
});
