import { createHash } from 'node:crypto';
import type { RenderFormat } from '@inker/contracts';
import { encodeBmp1bit } from '../common/utils/bmp1bit.util';

// WP-14 fixtures only. No draft rendering, provider reads, disk cache or arbitrary URLs.
// These fixed bytes are created once, not during a device request.
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAyAAAAHgAQMAAABnyZu2AAAAA1BMVEX///+nxBvIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvBr1gAAHGkBofAAAAAElFTkSuQmCC', 'base64');

function fixture(fixtureId: string, format: RenderFormat, mimeType: string, bytes: Buffer) {
  return {
    fixtureId, format, mimeType, width: 800, height: 480,
    colorSpace: 'monochrome', bitDepth: 1, rotation: 0,
    bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
  } as const;
}

export const PULL_FIXTURE_ARTIFACTS = [
  fixture('mono-800x480-white-bmp', 'bmp1', 'image/bmp', encodeBmp1bit(Buffer.alloc(800 * 480, 255), 800, 480)),
  fixture('mono-800x480-black-bmp', 'bmp1', 'image/bmp', encodeBmp1bit(Buffer.alloc(800 * 480), 800, 480)),
  fixture('mono-800x480-white-png', 'png', 'image/png', whitePng),
] as const;

export type PullFixtureArtifact = typeof PULL_FIXTURE_ARTIFACTS[number];
