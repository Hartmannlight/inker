import { describe, expect, it } from 'bun:test';
import type { PublicationRevision } from '@prisma/client';
import sharp from 'sharp';
import { PULL_FIXTURE_ARTIFACTS } from '../device-platform/pull-fixture-artifacts';
import { canonicalJson, sha256, type PublishedArtifact } from '../publications/publication-content';
import { MAX_RENDER_BYTES, MAX_RENDER_PIXELS, type RenderTarget } from './render-input';
import { renderSnapshot, validateRenderedArtifact } from './snapshot-renderer';

function revision(content: PublicationRevision['content']): PublicationRevision {
  return { publicationId: 'p', publicationRevisionId: 'r', revision: 1, protocolVersion: '1.0', content,
    contentHash: sha256(canonicalJson(content)), createdAt: new Date(0), publishedAt: new Date(0) };
}
function target(overrides: Partial<RenderTarget> = {}): RenderTarget {
  return { profileId: 'test', width: 12, height: 8, colorSpace: 'rgb', bitDepth: 24, rotation: 0,
    format: 'png', scaling: 'contain', safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, ...overrides };
}
async function snapshot(width = 4, height = 2, pixels?: Buffer): Promise<PublicationRevision> {
  const bytes = await (pixels ? sharp(pixels, { raw: { width, height, channels: 3 } })
    : sharp({ create: { width, height, channels: 3, background: { r: 97, g: 148, b: 209 } } })).png().toBuffer();
  return revision({ schemaVersion: 1, image: { width, height, png: bytes.toString('base64'), sha256: sha256(bytes) } });
}
async function rgb(artifact: PublishedArtifact): Promise<Buffer> {
  return sharp(artifact.bytes).toColourspace('srgb').removeAlpha().raw().toBuffer();
}

describe('snapshot-only renderer', () => {
  it('preserves native fixture bytes and hashes without returning mutable catalog buffers', async () => {
    for (const fixture of PULL_FIXTURE_ARTIFACTS) {
      const output = await renderSnapshot(revision({ schemaVersion: 1, fixtureArtifacts: [fixture.fixtureId] }),
        target({ width: 800, height: 480, colorSpace: 'monochrome', bitDepth: 1, format: fixture.format as 'png' | 'bmp1' }));
      expect(output.bytes).toEqual(fixture.bytes);
      expect(output.bytes).not.toBe(fixture.bytes);
      expect(output.sha256).toBe(fixture.sha256);
    }
  });

  it('renders 20 independent targets deterministically at exact physical dimensions', async () => {
    const input = await snapshot();
    const outputs = await Promise.all(Array.from({ length: 20 }, () => renderSnapshot(input, target())));
    expect(new Set(outputs.map(output => output.sha256)).size).toBe(1);
    const metadata = await sharp(outputs[0].bytes).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', 12, 8]);
    expect(outputs[0].sha256).toBe(sha256(outputs[0].bytes));
  });

  it('writes real JPEG and lossless RGB565/RGB332 PNG with coherent metadata', async () => {
    const input = await snapshot();
    const jpeg = await renderSnapshot(input, target({ format: 'jpeg' }));
    expect((await sharp(jpeg.bytes).metadata()).format).toBe('jpeg');
    for (const bitDepth of [8, 16]) {
      const output = await renderSnapshot(input, target({ width: 4, height: 2, bitDepth }));
      expect(output.bitDepth).toBe(bitDepth);
      const pixels = await rgb(output);
      const expected = bitDepth === 16 ? [99, 150, 206] : [109, 146, 170];
      expect([...pixels.subarray(0, 3)]).toEqual(expected);
    }
  });

  it('quantizes actual monochrome/grayscale PNG and monochrome BMP pixels', async () => {
    const gradient = Buffer.from(Array.from({ length: 16 }, (_, index) => [index * 17, index * 17, index * 17]).flat());
    const input = await snapshot(16, 1, gradient);
    for (const bitDepth of [1, 2, 4, 8]) {
      const output = await renderSnapshot(input, target({ width: 16, height: 1, colorSpace: bitDepth === 1 ? 'monochrome' : 'grayscale', bitDepth }));
      const pixels = await rgb(output);
      const levels = new Set(Array.from({ length: 16 }, (_, index) => pixels[index * 3]));
      expect(levels.size).toBe(Math.min(16, 2 ** bitDepth));
      expect([...pixels].every((pixel, index) => pixel === pixels[index - index % 3])).toBe(true);
    }
    const bmp = await renderSnapshot(input, target({ width: 16, height: 1, colorSpace: 'monochrome', bitDepth: 1, format: 'bmp1' }));
    expect(bmp.bytes.toString('ascii', 0, 2)).toBe('BM');
    expect([bmp.bytes.readInt32LE(18), bmp.bytes.readInt32LE(22), bmp.bytes.readUInt16LE(28)]).toEqual([16, 1, 1]);
    expect([...bmp.bytes.subarray(62)]).toEqual([0, 255, 0, 0]);
  });

  it('rotates source pixels while keeping target dimensions, and respects safe-area', async () => {
    const input = await snapshot(2, 1, Buffer.from([255, 0, 0, 0, 0, 255]));
    const rotated = await renderSnapshot(input, target({ width: 1, height: 2, rotation: 90, scaling: 'none' }));
    expect([...(await rgb(rotated))]).toEqual([255, 0, 0, 0, 0, 255]);
    const safe = await renderSnapshot(input, target({ width: 4, height: 3, scaling: 'none', safeArea: { top: 1, bottom: 1, left: 1, right: 1 } }));
    const pixels = await rgb(safe);
    expect([...pixels.subarray(0, 12)]).toEqual(Array(12).fill(255));
    expect([...pixels.subarray(15, 21)]).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...pixels.subarray(24)]).toEqual(Array(12).fill(255));
  });

  it('handles 180/270 degree rotations and grayscale JPEG, flattening snapshot transparency', async () => {
    const input = await snapshot(2, 1, Buffer.from([255, 0, 0, 0, 0, 255]));
    for (const rotation of [180, 270] as const) {
      const output = await renderSnapshot(input, target({ width: rotation === 180 ? 2 : 1, height: rotation === 180 ? 1 : 2, rotation, scaling: 'none' }));
      expect([...(await rgb(output))]).toEqual([0, 0, 255, 255, 0, 0]);
    }
    const bytes = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const transparent = revision({ schemaVersion: 1, image: { width: 2, height: 1, png: bytes.toString('base64'), sha256: sha256(bytes) } });
    const output = await renderSnapshot(transparent, target({ width: 2, height: 1, colorSpace: 'grayscale', bitDepth: 8, format: 'jpeg' }));
    expect([...(await rgb(output))]).toEqual([255, 255, 255, 255, 255, 255]);
    expect((await sharp(output.bytes).metadata()).hasAlpha).toBe(false);
  });

  it('distinguishes contain/cover and refuses scaling:none when source does not fit', async () => {
    const input = await snapshot();
    const contained = await rgb(await renderSnapshot(input, target({ width: 4, height: 4 })));
    const covered = await rgb(await renderSnapshot(input, target({ width: 4, height: 4, scaling: 'cover' })));
    expect([...contained.subarray(0, 3)]).toEqual([255, 255, 255]);
    expect([...covered.subarray(0, 3)]).toEqual([97, 148, 209]);
    await expect(renderSnapshot(input, target({ width: 2, height: 1, scaling: 'none' }))).rejects.toThrow('Snapshot rendering unavailable');
  });

  it('converts a stored black BMP fixture to another target without URLs or draft reads', async () => {
    const output = await renderSnapshot(revision({ schemaVersion: 1, fixtureArtifacts: ['mono-800x480-black-bmp'] }), target({ width: 8, height: 4, scaling: 'cover' }));
    expect([...(await rgb(output))].every(pixel => pixel === 0)).toBe(true);
    await expect(renderSnapshot(revision({ schemaVersion: 1, image: { png: 'https://provider.invalid/private', width: 4, height: 2, sha256: 'a'.repeat(64) } }), target())).rejects.toThrow();
  });

  it('rejects corrupted hashes, dimension lies, malformed PNG and oversized targets', async () => {
    const input = await snapshot();
    await expect(renderSnapshot({ ...input, contentHash: 'wrong' }, target())).rejects.toThrow();
    const content = structuredClone(input.content) as { schemaVersion: number; image: { width: number; height: number; png: string; sha256: string } };
    content.image.width++;
    await expect(renderSnapshot(revision(content), target())).rejects.toThrow('Snapshot rendering unavailable');
    content.image.width = 4;
    content.image.png = Buffer.from('not a PNG').toString('base64');
    content.image.sha256 = sha256(Buffer.from(content.image.png, 'base64'));
    await expect(renderSnapshot(revision(content), target())).rejects.toThrow();
    await expect(renderSnapshot(input, target({ width: MAX_RENDER_PIXELS, height: 2 }))).rejects.toThrow('Unsupported render target');
  });

  it('store validator rejects forged metadata/hash/container/pixel precision and oversized bytes', async () => {
    const expected = target({ width: 4, height: 2 });
    const output = await renderSnapshot(await snapshot(), expected);
    for (const override of [{ width: 3 }, { height: 9 }, { mimeType: 'image/jpeg' }, { bitDepth: 16 }, { rotation: 90 }, { sha256: 'a'.repeat(64) }, { bytes: Buffer.alloc(MAX_RENDER_BYTES + 1) }]) {
      await expect(validateRenderedArtifact({ ...output, ...override }, expected)).rejects.toThrow();
    }
    await expect(validateRenderedArtifact({ ...output, colorSpace: 'monochrome', bitDepth: 1 }, target({ width: 4, height: 2, colorSpace: 'monochrome', bitDepth: 1 }))).rejects.toThrow();
    const brokenBytes = Buffer.from('not an image');
    await expect(validateRenderedArtifact({ ...output, bytes: brokenBytes, sha256: sha256(brokenBytes) }, expected)).rejects.toThrow();
  });

  it('store validator checks the BMP header, palette, dimensions and completeness', async () => {
    const expected = target({ colorSpace: 'monochrome', bitDepth: 1, format: 'bmp1' });
    const output = await renderSnapshot(await snapshot(), expected);
    for (const offset of [10, 14, 18, 22, 26, 28, 30, 34, 54]) {
      const bytes = Buffer.from(output.bytes);
      bytes[offset] ^= 1;
      await expect(validateRenderedArtifact({ ...output, bytes, sha256: sha256(bytes) }, expected)).rejects.toThrow();
    }
    const bytes = output.bytes.subarray(0, output.bytes.length - 1);
    await expect(validateRenderedArtifact({ ...output, bytes, sha256: sha256(bytes) }, expected)).rejects.toThrow();
  });
});
