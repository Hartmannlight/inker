import { Injectable, Logger } from '@nestjs/common';
import * as sharpModule from 'sharp';
// Handle both ESM and CJS imports for Bun compatibility
const sharp = (sharpModule as any).default || sharpModule;
import * as fs from 'fs/promises';
import * as path from 'path';
import { encodeBmp1bit, encodeGray4Bmp, quantizeGray16 } from '../../common/utils/bmp1bit.util';

type SleepFormat = 'png' | 'bmp';

/**
 * Escape XML special characters to prevent SVG corruption
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Sleep Screen Service
 *
 * Generates the screen shown on a device during its configured quiet hours
 * (when `showSleepScreen` is enabled). A clean, centered crescent-moon design
 * with the wake-up time, rendered as a 1-bit e-ink PNG via Sharp (no Puppeteer).
 *
 * Mirrors DefaultScreenService: same grayscale + Floyd-Steinberg pipeline, no
 * colour inversion (firmware handles display colour mapping). Generated images
 * are cached per resolution + wake time so the device gets a stable URL (and
 * caches it) for the whole night.
 */
@Injectable()
export class SleepScreenService {
  private readonly logger = new Logger(SleepScreenService.name);
  private readonly assetsDir: string;

  private readonly DEFAULT_WIDTH = 800;
  private readonly DEFAULT_HEIGHT = 480;

  constructor() {
    this.assetsDir = path.join(process.cwd(), 'assets');
  }

  /**
   * Build the cache filename for a given resolution + wake time + format.
   * e.g. sleep-800x480-0700.png or sleep-800x480-0700.bmp
   */
  private getFilename(width: number, height: number, wakeTime: string, format: SleepFormat = 'png'): string {
    const safeWake = wakeTime.replace(/[^0-9]/g, '') || '0000';
    return `sleep-${width}x${height}-${safeWake}.${format}`;
  }

  /**
   * Ensure the sleep screen for this resolution + wake time exists and return
   * its public URL path and filename. Generates the image on first request.
   *
   * @param format 'png' (default) or 'bmp' for TRMNL OG / DIY-kit firmware (issue #31)
   */
  async getSleepScreen(
    width: number,
    height: number,
    wakeTime: string,
    format: SleepFormat = 'png',
    bitDepth: number = 1,
  ): Promise<{ url: string; filename: string }> {
    const w = width > 0 ? width : this.DEFAULT_WIDTH;
    const h = height > 0 ? height : this.DEFAULT_HEIGHT;
    const filename = this.getFilename(w, h, wakeTime, format);
    const outputPath = path.join(this.assetsDir, filename);

    try {
      await fs.mkdir(this.assetsDir, { recursive: true });
      try {
        await fs.access(outputPath);
      } catch {
        await this.generate(w, h, wakeTime, bitDepth);
      }
    } catch (error) {
      this.logger.error('Failed to ensure sleep screen exists:', error);
    }

    return { url: `/assets/${filename}`, filename };
  }

  /**
   * Get the sleep screen as a base64-encoded string (for devices that request
   * inline image data via the BASE64 header).
   */
  async getSleepScreenBase64(
    width: number,
    height: number,
    wakeTime: string,
    format: SleepFormat = 'png',
    bitDepth: number = 1,
  ): Promise<string | undefined> {
    const w = width > 0 ? width : this.DEFAULT_WIDTH;
    const h = height > 0 ? height : this.DEFAULT_HEIGHT;
    const filename = this.getFilename(w, h, wakeTime, format);
    const outputPath = path.join(this.assetsDir, filename);
    try {
      await this.getSleepScreen(w, h, wakeTime, format, bitDepth);
      const buffer = await fs.readFile(outputPath);
      return buffer.toString('base64');
    } catch (error) {
      this.logger.warn('Failed to get sleep screen base64:', error);
      return undefined;
    }
  }

  /**
   * Get the sleep screen as a PNG buffer (for the admin "Current Screen" preview).
   */
  async getSleepScreenBuffer(
    width: number,
    height: number,
    wakeTime: string,
  ): Promise<Buffer> {
    const w = width > 0 ? width : this.DEFAULT_WIDTH;
    const h = height > 0 ? height : this.DEFAULT_HEIGHT;
    const filename = this.getFilename(w, h, wakeTime);
    const outputPath = path.join(this.assetsDir, filename);
    await this.getSleepScreen(w, h, wakeTime); // ensure generated
    return sharp(outputPath).png().toBuffer();
  }

  /**
   * Generate the sleep screen image and write both PNG and BMP variants to disk.
   * Both share the same dithered pixels; the BMP variant supports TRMNL OG /
   * DIY-kit firmware that rejects PNG (issue #31).
   */
  private async generate(
    width: number,
    height: number,
    wakeTime: string,
    bitDepth: number = 1,
  ): Promise<void> {
    this.logger.log(`Generating sleep screen: ${width}x${height}, wake=${wakeTime}, bitDepth=${bitDepth}`);

    const svg = this.createSleepScreenSvg(width, height, wakeTime);

    const grayBuffer = await sharp(Buffer.from(svg))
      .grayscale()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = grayBuffer;

    const bmpPath = path.join(this.assetsDir, this.getFilename(width, height, wakeTime, 'bmp'));

    if (bitDepth >= 4) {
      // 16-level grayscale for TRMNL X — full resolution, no 1-bit dithering. Compressed PNG by
      // default (small); the caller's format governs whether a .bmp variant is written instead.
      const quantized = quantizeGray16(data);
      const pngPath = path.join(this.assetsDir, this.getFilename(width, height, wakeTime, 'png'));
      await sharp(quantized, { raw: { width: info.width, height: info.height, channels: 1 } })
        .toColorspace('b-w')
        .png({ compressionLevel: 9 })
        .toFile(pngPath);
      await fs.writeFile(bmpPath, encodeGray4Bmp(quantized, info.width, info.height));
      this.logger.log(`Sleep screen saved to: ${pngPath} (+ 4-bit .bmp, 16-level grayscale)`);
      return;
    }

    // 1-bit: grayscale → Floyd-Steinberg dithering → both PNG and 1-bit BMP variants.
    const dithered = this.applyFloydSteinbergDithering(data, info.width, info.height, 140);
    const pngPath = path.join(this.assetsDir, this.getFilename(width, height, wakeTime, 'png'));

    await sharp(dithered, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .toColorspace('b-w')
      .png({ compressionLevel: 9 })
      .toFile(pngPath);

    await fs.writeFile(bmpPath, encodeBmp1bit(dithered, info.width, info.height));

    this.logger.log(`Sleep screen saved to: ${pngPath} (+ .bmp)`);
  }

  /**
   * Centered crescent moon + "Sleeping until HH:MM" caption.
   * Pure SVG shapes only (no emoji) so it renders reliably for e-ink.
   */
  private createSleepScreenSvg(width: number, height: number, wakeTime: string): string {
    const centerX = width / 2;
    const moonR = Math.min(width, height) * 0.13;
    const moonCy = height / 2 - height * 0.08;
    // Crescent: a filled circle with an offset white circle carved out of it.
    const carveDx = moonR * 0.55;
    const carveDy = -moonR * 0.2;
    const carveR = moonR * 0.92;

    const captionSize = Math.max(16, Math.round(height * 0.06));
    const captionY = moonCy + moonR + captionSize * 1.8;
    const caption = escapeXml(`Sleeping until ${wakeTime}`);

    // A few simple 4-point stars around the moon.
    const star = (sx: number, sy: number, s: number) =>
      `<path d="M ${sx} ${sy - s} L ${sx + s * 0.28} ${sy - s * 0.28} L ${sx + s} ${sy} L ${sx + s * 0.28} ${sy + s * 0.28} L ${sx} ${sy + s} L ${sx - s * 0.28} ${sy + s * 0.28} L ${sx - s} ${sy} L ${sx - s * 0.28} ${sy - s * 0.28} Z" fill="black"/>`;

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <g>
          <circle cx="${centerX}" cy="${moonCy}" r="${moonR}" fill="black"/>
          <circle cx="${centerX + carveDx}" cy="${moonCy + carveDy}" r="${carveR}" fill="white"/>
        </g>
        ${star(centerX + moonR * 1.8, moonCy - moonR * 0.9, moonR * 0.18)}
        ${star(centerX + moonR * 2.4, moonCy + moonR * 0.2, moonR * 0.12)}
        ${star(centerX - moonR * 2.0, moonCy - moonR * 0.4, moonR * 0.14)}
        <text
          x="${centerX}"
          y="${captionY}"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${captionSize}"
          font-weight="bold"
          fill="black"
          text-anchor="middle"
          dominant-baseline="middle"
        >${caption}</text>
      </svg>
    `.trim();
  }

  /**
   * Floyd-Steinberg dithering for 1-bit e-ink output (matches DefaultScreenService).
   */
  private applyFloydSteinbergDithering(
    data: Buffer,
    width: number,
    height: number,
    threshold: number,
  ): Buffer {
    const pixels = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (val > 200) pixels[i] = 255;
      else if (val < 55) pixels[i] = 0;
      else pixels[i] = val;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldPixel = pixels[idx];
        const newPixel = oldPixel > threshold ? 255 : 0;
        pixels[idx] = newPixel;
        const error = oldPixel - newPixel;
        if (x + 1 < width) pixels[idx + 1] += (error * 7) / 16;
        if (y + 1 < height) {
          if (x - 1 >= 0) pixels[(y + 1) * width + (x - 1)] += (error * 3) / 16;
          pixels[(y + 1) * width + x] += (error * 5) / 16;
          if (x + 1 < width) pixels[(y + 1) * width + (x + 1)] += (error * 1) / 16;
        }
      }
    }

    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = Math.max(0, Math.min(255, Math.round(pixels[i])));
    }
    return result;
  }
}
