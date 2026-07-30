import { describe, it, expect } from 'bun:test';
import { encodeBmp1bit, encodeGray4Bmp, gray8ToLevel4 } from './bmp1bit.util';

/** Minimal helper: read the header fields we care about from a BMP buffer. */
function parseHeader(buf: Buffer) {
  return {
    magic: buf.toString('ascii', 0, 2),
    fileSize: buf.readUInt32LE(2),
    pixelOffset: buf.readUInt32LE(10),
    infoHeaderSize: buf.readUInt32LE(14),
    width: buf.readInt32LE(18),
    height: buf.readInt32LE(22),
    planes: buf.readUInt16LE(26),
    bitCount: buf.readUInt16LE(28),
    compression: buf.readUInt32LE(30),
    colorsUsed: buf.readUInt32LE(46),
  };
}

/** Read a single pixel (true = white) from an encoded 1-bit BMP, accounting for bottom-up rows. */
function readPixel(buf: Buffer, width: number, height: number, x: number, y: number): boolean {
  const rowBytes = Math.ceil(width / 8);
  const rowStride = (rowBytes + 3) & ~3;
  const pixelOffset = buf.readUInt32LE(10);
  const rowStart = pixelOffset + (height - 1 - y) * rowStride;
  const byte = buf[rowStart + (x >> 3)];
  const bit = (byte >> (7 - (x & 7))) & 1;
  return bit === 1; // palette index 1 = white
}

describe('bmp1bit.util', () => {
  describe('encodeBmp1bit', () => {
    it('produces a valid 1-bit BMP header for 800x480', () => {
      const gray = Buffer.alloc(800 * 480, 255);
      const bmp = encodeBmp1bit(gray, 800, 480);
      const h = parseHeader(bmp);

      expect(h.magic).toBe('BM');
      expect(h.infoHeaderSize).toBe(40);
      expect(h.width).toBe(800);
      expect(h.height).toBe(480);
      expect(h.planes).toBe(1);
      expect(h.bitCount).toBe(1);
      expect(h.compression).toBe(0); // BI_RGB, uncompressed
      expect(h.colorsUsed).toBe(2);
      expect(h.pixelOffset).toBe(62); // 14 + 40 + 8
      // 800px -> 100 bytes/row, already 4-byte aligned; 100 * 480 + 62
      expect(h.fileSize).toBe(62 + 100 * 480);
      expect(bmp.length).toBe(h.fileSize);
    });

    it('pads rows whose width is not a multiple of 32 to a 4-byte boundary', () => {
      // width 10 -> 2 bytes/row -> padded to 4
      const bmp = encodeBmp1bit(Buffer.alloc(10 * 3, 0), 10, 3);
      const pixelData = bmp.length - bmp.readUInt32LE(10);
      expect(pixelData).toBe(4 * 3);
    });

    it('maps white pixels to bit 1 and black to bit 0', () => {
      // 8x1: alternating black/white starting with white
      const gray = Buffer.from([255, 0, 255, 0, 255, 0, 255, 0]);
      const bmp = encodeBmp1bit(gray, 8, 1);
      for (let x = 0; x < 8; x++) {
        expect(readPixel(bmp, 8, 1, x, 0)).toBe(x % 2 === 0);
      }
    });

    it('stores rows bottom-up (first source row ends up last in the file)', () => {
      // 8x2: top row all white, bottom row all black
      const gray = Buffer.concat([Buffer.alloc(8, 255), Buffer.alloc(8, 0)]);
      const bmp = encodeBmp1bit(gray, 8, 2);
      // top row (y=0) white, bottom row (y=1) black
      expect(readPixel(bmp, 8, 2, 0, 0)).toBe(true);
      expect(readPixel(bmp, 8, 2, 0, 1)).toBe(false);
    });

    it('respects the invert option', () => {
      const gray = Buffer.from([255]);
      const normal = encodeBmp1bit(gray, 1, 1);
      const inverted = encodeBmp1bit(gray, 1, 1, { invert: true });
      expect(readPixel(normal, 1, 1, 0, 0)).toBe(true);
      expect(readPixel(inverted, 1, 1, 0, 0)).toBe(false);
    });

    it('throws on invalid dimensions or short buffers', () => {
      expect(() => encodeBmp1bit(Buffer.alloc(4), 0, 4)).toThrow();
      expect(() => encodeBmp1bit(Buffer.alloc(3), 2, 2)).toThrow();
    });
  });

  describe('gray8ToLevel4', () => {
    it('maps 0-255 into 16 evenly-spaced levels', () => {
      expect(gray8ToLevel4(0)).toBe(0);
      expect(gray8ToLevel4(255)).toBe(15);
      expect(gray8ToLevel4(128)).toBe(8);
      expect(gray8ToLevel4(17)).toBe(1);
    });
  });

  /** Read a 4-bit pixel's level (0-15) from a gray4 BMP, accounting for bottom-up rows. */
  function readLevel4(buf: Buffer, width: number, height: number, x: number, y: number): number {
    const rowBytes = Math.ceil(width / 2);
    const rowStride = (rowBytes + 3) & ~3;
    const pixelOffset = buf.readUInt32LE(10);
    const rowStart = pixelOffset + (height - 1 - y) * rowStride;
    const byte = buf[rowStart + (x >> 1)];
    return (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
  }

  describe('encodeGray4Bmp', () => {
    it('produces a valid 4-bit grayscale BMP header for 1872x1404 (TRMNL X)', () => {
      const w = 1872, h = 1404;
      const bmp = encodeGray4Bmp(Buffer.alloc(w * h, 128), w, h);
      const head = parseHeader(bmp);
      expect(head.magic).toBe('BM');
      expect(head.width).toBe(w);
      expect(head.height).toBe(h);
      expect(head.bitCount).toBe(4);
      expect(head.compression).toBe(0);
      expect(head.colorsUsed).toBe(16);
      expect(head.pixelOffset).toBe(118); // 14 + 40 + 16*4
      // ceil(1872/2)=936 bytes/row, already 4-byte aligned
      expect(bmp.length).toBe(118 + 936 * h);
    });

    it('has a 16-entry evenly-spaced grayscale palette', () => {
      const bmp = encodeGray4Bmp(Buffer.alloc(4, 0), 2, 2);
      for (let i = 0; i < 16; i++) {
        const off = 54 + i * 4;
        expect(bmp[off]).toBe(i * 0x11);     // B
        expect(bmp[off + 1]).toBe(i * 0x11); // G
        expect(bmp[off + 2]).toBe(i * 0x11); // R
      }
    });

    it('quantizes pixels to the right level and packs two per byte', () => {
      // 4x1: black, white, mid, near-white
      const gray = Buffer.from([0, 255, 128, 240]);
      const bmp = encodeGray4Bmp(gray, 4, 1);
      expect(readLevel4(bmp, 4, 1, 0, 0)).toBe(0);
      expect(readLevel4(bmp, 4, 1, 1, 0)).toBe(15);
      expect(readLevel4(bmp, 4, 1, 2, 0)).toBe(8);
      expect(readLevel4(bmp, 4, 1, 3, 0)).toBe(gray8ToLevel4(240));
    });

    it('preserves multiple gray levels (not just black/white)', () => {
      // a horizontal gradient
      const w = 16, h = 1;
      const gray = Buffer.from(Array.from({ length: w }, (_, i) => i * 17));
      const bmp = encodeGray4Bmp(gray, w, h);
      const levels = new Set<number>();
      for (let x = 0; x < w; x++) levels.add(readLevel4(bmp, w, h, x, 0));
      expect(levels.size).toBeGreaterThan(2);
    });
  });
});
