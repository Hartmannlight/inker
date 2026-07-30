/**
 * 1-bit (monochrome) Windows BMP encoder.
 *
 * TRMNL "OG" devices on the older / DIY firmware line (e.g. the Seeed Studio
 * TRMNL 7.5 OG DIY Kit, firmware 1.6.x / 1.8.x) expect a 1-bit BMP image rather
 * than the 8-bit grayscale PNG that Inker serves for firmware 1.7.8. Sharp cannot
 * write BMP, so we encode it by hand here. See issue #31.
 *
 * The input is single-channel (1 byte/pixel) grayscale data — typically the
 * Floyd-Steinberg dithered output where each pixel is already 0 (black) or 255
 * (white). Any value >= `threshold` (default 128) is treated as white.
 *
 * Output is a standard uncompressed (BI_RGB) bottom-up BMP with a 2-colour
 * palette (index 0 = black, index 1 = white). White pixels map to bit 1.
 */

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const PALETTE_SIZE = 8; // 2 entries * 4 bytes (BGRA)
const PIXEL_DATA_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE + PALETTE_SIZE; // 62

export interface EncodeBmp1bitOptions {
  /** Grayscale value at/above which a pixel is considered white (bit 1). Default 128. */
  threshold?: number;
  /** Invert bit/colour mapping (white pixel -> bit 0). Default false. */
  invert?: boolean;
}

/**
 * Encode single-channel grayscale pixel data as a 1-bit BMP.
 *
 * @param gray   - width*height bytes, one grayscale value per pixel, row-major, top-to-bottom
 * @param width  - image width in pixels
 * @param height - image height in pixels
 * @returns a Buffer containing a complete .bmp file
 */
export function encodeBmp1bit(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
  options: EncodeBmp1bitOptions = {},
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }
  if (gray.length < width * height) {
    throw new Error(
      `Pixel buffer too small for ${width}x${height}: got ${gray.length}, need ${width * height}`,
    );
  }

  const threshold = options.threshold ?? 128;
  const whiteBit = options.invert ? 0 : 1;

  // Each row is packed to a 4-byte boundary (BMP requirement).
  const rowBytes = Math.ceil(width / 8);
  const rowStride = (rowBytes + 3) & ~3; // round up to multiple of 4
  const pixelDataSize = rowStride * height;
  const fileSize = PIXEL_DATA_OFFSET + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // --- BITMAPFILEHEADER (14 bytes) ---
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6); // reserved
  buf.writeUInt32LE(PIXEL_DATA_OFFSET, 10);

  // --- BITMAPINFOHEADER (40 bytes) ---
  buf.writeUInt32LE(INFO_HEADER_SIZE, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up rows
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(1, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // compression = BI_RGB
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38); // ~72 DPI horizontal (pixels/metre)
  buf.writeInt32LE(2835, 42); // ~72 DPI vertical
  buf.writeUInt32LE(2, 46); // colours used
  buf.writeUInt32LE(2, 50); // important colours

  // --- Palette (BGRA): index 0 = black, index 1 = white ---
  // index 0
  buf.writeUInt8(0x00, 54);
  buf.writeUInt8(0x00, 55);
  buf.writeUInt8(0x00, 56);
  buf.writeUInt8(0x00, 57);
  // index 1
  buf.writeUInt8(0xff, 58);
  buf.writeUInt8(0xff, 59);
  buf.writeUInt8(0xff, 60);
  buf.writeUInt8(0x00, 61);

  // --- Pixel data (bottom-up, MSB = leftmost pixel) ---
  for (let y = 0; y < height; y++) {
    // BMP stores the bottom row first.
    const rowStart = PIXEL_DATA_OFFSET + (height - 1 - y) * rowStride;
    const srcRow = y * width;
    for (let x = 0; x < width; x++) {
      const isWhite = gray[srcRow + x] >= threshold;
      const bit = isWhite ? whiteBit : whiteBit ^ 1;
      if (bit) {
        const byteIndex = rowStart + (x >> 3);
        buf[byteIndex] |= 0x80 >> (x & 7);
      }
    }
  }

  return buf;
}

// --- 4-bit (16-level) grayscale BMP, for TRMNL X (10.3", 1872x1404, 16 grays) ---

const GRAY4_INFO_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE; // 54
const GRAY4_PALETTE_ENTRIES = 16;
const GRAY4_PALETTE_SIZE = GRAY4_PALETTE_ENTRIES * 4; // 64
const GRAY4_PIXEL_OFFSET = GRAY4_INFO_OFFSET + GRAY4_PALETTE_SIZE; // 118

/** Map an 8-bit grayscale value (0-255) to a 4-bit level (0-15). */
export function gray8ToLevel4(v: number): number {
  return Math.max(0, Math.min(15, Math.round((v / 255) * 15)));
}

/**
 * Posterize an 8-bit grayscale buffer to 16 evenly-spaced levels (0x00, 0x11, … 0xFF), matching
 * a 16-level (4-bit) panel. Returns a new 8-bit buffer — used for grayscale PNG output where the
 * container stays 8-bit but the content is limited to the panel's 16 grays (also compresses well).
 */
export function quantizeGray16(gray: Buffer | Uint8Array): Buffer {
  const out = Buffer.alloc(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = gray8ToLevel4(gray[i]) * 0x11;
  }
  return out;
}

/**
 * Encode single-channel grayscale pixel data as a 4-bit (16-level) grayscale BMP.
 *
 * TRMNL X panels are 16-level grayscale — sending them a matching 4-bit image (rather than the
 * 1-bit dithered output used for OG panels) preserves gradients. Sharp cannot write 4-bit
 * grayscale, so it is hand-encoded here, mirroring `encodeBmp1bit`.
 *
 * Each input pixel is quantized to one of 16 evenly-spaced gray levels (level i → 0x11*i, i.e.
 * 0x00, 0x11, … 0xFF). Output is an uncompressed (BI_RGB) bottom-up BMP with a 16-entry grayscale
 * palette; two pixels are packed per byte (high nibble = leftmost pixel).
 *
 * @param gray   - width*height bytes, one grayscale value per pixel, row-major, top-to-bottom
 * @param width  - image width in pixels
 * @param height - image height in pixels
 */
export function encodeGray4Bmp(
  gray: Buffer | Uint8Array,
  width: number,
  height: number,
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }
  if (gray.length < width * height) {
    throw new Error(
      `Pixel buffer too small for ${width}x${height}: got ${gray.length}, need ${width * height}`,
    );
  }

  // 4bpp: ceil(width/2) bytes/row, padded to a 4-byte boundary.
  const rowBytes = Math.ceil(width / 2);
  const rowStride = (rowBytes + 3) & ~3;
  const pixelDataSize = rowStride * height;
  const fileSize = GRAY4_PIXEL_OFFSET + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // --- BITMAPFILEHEADER ---
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(GRAY4_PIXEL_OFFSET, 10);

  // --- BITMAPINFOHEADER ---
  buf.writeUInt32LE(INFO_HEADER_SIZE, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(4, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(GRAY4_PALETTE_ENTRIES, 46);
  buf.writeUInt32LE(GRAY4_PALETTE_ENTRIES, 50);

  // --- Palette: 16 evenly-spaced grays (BGRA) ---
  for (let i = 0; i < GRAY4_PALETTE_ENTRIES; i++) {
    const v = i * 0x11; // 0..255 in 16 steps
    const off = GRAY4_INFO_OFFSET + i * 4;
    buf.writeUInt8(v, off);      // B
    buf.writeUInt8(v, off + 1);  // G
    buf.writeUInt8(v, off + 2);  // R
    buf.writeUInt8(0, off + 3);  // reserved
  }

  // --- Pixel data (bottom-up, high nibble = leftmost pixel) ---
  for (let y = 0; y < height; y++) {
    const rowStart = GRAY4_PIXEL_OFFSET + (height - 1 - y) * rowStride;
    const srcRow = y * width;
    for (let x = 0; x < width; x++) {
      const level = gray8ToLevel4(gray[srcRow + x]);
      const byteIndex = rowStart + (x >> 1);
      if ((x & 1) === 0) {
        buf[byteIndex] |= level << 4; // high nibble
      } else {
        buf[byteIndex] |= level; // low nibble
      }
    }
  }

  return buf;
}
