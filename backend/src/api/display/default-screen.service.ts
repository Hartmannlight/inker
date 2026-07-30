import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../../settings/settings.service';
import * as sharpModule from 'sharp';
// Handle both ESM and CJS imports for Bun compatibility
const sharp = (sharpModule as any).default || sharpModule;
import * as fs from 'fs/promises';
import * as path from 'path';
import { encodeBmp1bit, encodeGray4Bmp, quantizeGray16 } from '../../common/utils/bmp1bit.util';

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
 * Default Screen Service
 * Generates a default "Hello World" screen for devices without a playlist
 * Uses Sharp for pure image generation (no Puppeteer/browser dependency)
 */
@Injectable()
export class DefaultScreenService implements OnModuleInit {
  private readonly logger = new Logger(DefaultScreenService.name);
  private readonly assetsDir: string;
  private readonly defaultScreenPath: string;
  private readonly defaultScreenBmpPath: string;
  private defaultScreenGenerated = false;

  // Default TRMNL e-ink display dimensions (800x480)
  private readonly DEFAULT_WIDTH = 800;
  private readonly DEFAULT_HEIGHT = 480;

  constructor(
    private readonly config: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    this.assetsDir = path.join(process.cwd(), 'assets');
    this.defaultScreenPath = path.join(this.assetsDir, 'default-screen.png');
    this.defaultScreenBmpPath = path.join(this.assetsDir, 'default-screen.bmp');
  }

  /**
   * Generate default screen on module initialization
   * Always regenerates from config to ensure saved title/subtitle are applied
   */
  async onModuleInit() {
    try {
      await fs.mkdir(this.assetsDir, { recursive: true });
      await this.generateDefaultScreen();
      this.defaultScreenGenerated = true;
      this.logger.log(`Default screen generated at: ${this.defaultScreenPath}`);
    } catch (error) {
      this.logger.error('Failed to generate default screen:', error);
    }
  }

  /**
   * Ensure the default screen image exists
   * Generates it if not present
   */
  async ensureDefaultScreenExists(): Promise<void> {
    try {
      await fs.mkdir(this.assetsDir, { recursive: true });

      try {
        await fs.access(this.defaultScreenPath);
        this.defaultScreenGenerated = true;
        return;
      } catch {
        // File doesn't exist, generate it
      }

      await this.generateDefaultScreen();
      this.defaultScreenGenerated = true;
    } catch (error) {
      this.logger.error('Failed to ensure default screen exists:', error);
    }
  }

  /**
   * Generate the default screen image using Sharp
   * Reads title/subtitle from welcome screen config in settings
   */
  async generateDefaultScreen(
    width: number = this.DEFAULT_WIDTH,
    height: number = this.DEFAULT_HEIGHT,
  ): Promise<string> {
    this.logger.log(`Generating default screen: ${width}x${height}`);

    try {
      const welcomeConfig = await this.settingsService.getWelcomeScreenConfig();
      const svg = this.createDefaultScreenSvg(width, height, welcomeConfig.title, welcomeConfig.subtitle);

      // Convert SVG to e-ink optimized grayscale PNG (same pipeline as designed screens)
      // Standard 8-bit grayscale — firmware handles display color mapping
      const grayBuffer = await sharp(Buffer.from(svg))
        .grayscale()
        .normalise()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const dithered = this.applyFloydSteinbergDithering(
        grayBuffer.data, grayBuffer.info.width, grayBuffer.info.height, 140,
      );

      await sharp(dithered, {
        raw: { width: grayBuffer.info.width, height: grayBuffer.info.height, channels: 1 },
      })
        .toColorspace('b-w')
        .png({ compressionLevel: 9 })
        .toFile(this.defaultScreenPath);

      // Also write a 1-bit BMP variant for TRMNL OG / DIY-kit firmware that
      // rejects PNG (issue #31). Same dithered pixels, different container.
      await fs.writeFile(
        this.defaultScreenBmpPath,
        encodeBmp1bit(dithered, grayBuffer.info.width, grayBuffer.info.height),
      );

      this.logger.log(`Default screen saved to: ${this.defaultScreenPath} (+ .bmp)`);
      return this.defaultScreenPath;
    } catch (error) {
      this.logger.error('Failed to generate default screen:', error);
      throw error;
    }
  }

  /**
   * Create SVG content for the default screen
   * Clean, centered design optimized for e-ink displays
   */
  private createDefaultScreenSvg(
    width: number,
    height: number,
    title: string = 'Hello World',
    subtitle: string = 'This is Inker!',
  ): string {
    const centerX = width / 2;
    const centerY = height / 2;
    const safeTitle = escapeXml(title);
    const safeSubtitle = escapeXml(subtitle);

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>

        <text
          x="${centerX}"
          y="${centerY - 40}"
          font-family="Arial, Helvetica, sans-serif"
          font-size="64"
          font-weight="bold"
          fill="black"
          text-anchor="middle"
          dominant-baseline="middle"
        >${safeTitle}</text>

        <text
          x="${centerX}"
          y="${centerY + 40}"
          font-family="Arial, Helvetica, sans-serif"
          font-size="32"
          fill="black"
          text-anchor="middle"
          dominant-baseline="middle"
        >${safeSubtitle}</text>

        <line
          x1="${centerX - 200}"
          y1="${centerY - 100}"
          x2="${centerX + 200}"
          y2="${centerY - 100}"
          stroke="black"
          stroke-width="2"
        />

        <line
          x1="${centerX - 200}"
          y1="${centerY + 100}"
          x2="${centerX + 200}"
          y2="${centerY + 100}"
          stroke="black"
          stroke-width="2"
        />
      </svg>
    `.trim();
  }

  /**
   * Get the URL path for the default screen
   */
  getDefaultScreenUrl(): string {
    return '/assets/default-screen.png';
  }

  /**
   * Get the filesystem path to the default screen
   */
  getDefaultScreenPath(): string {
    return this.defaultScreenPath;
  }

  /**
   * Get the URL path for the 1-bit BMP default screen (issue #31)
   */
  getDefaultScreenBmpUrl(): string {
    return '/assets/default-screen.bmp';
  }

  /**
   * Ensure the BMP default screen exists, generating it (alongside the PNG) if
   * missing — e.g. after an upgrade where only the PNG was present.
   */
  async ensureDefaultScreenBmpExists(): Promise<void> {
    try {
      await fs.mkdir(this.assetsDir, { recursive: true });
      try {
        await fs.access(this.defaultScreenBmpPath);
        return;
      } catch {
        // BMP doesn't exist yet, (re)generate both variants
      }
      await this.generateDefaultScreen();
    } catch (error) {
      this.logger.error('Failed to ensure default screen BMP exists:', error);
    }
  }

  /**
   * Get the BMP default screen as a base64 encoded string
   */
  async getDefaultScreenBmpBase64(): Promise<string> {
    await this.ensureDefaultScreenBmpExists();
    const buffer = await fs.readFile(this.defaultScreenBmpPath);
    return buffer.toString('base64');
  }

  /**
   * Get the 1-bit BMP default screen as a buffer (issue #31 fallback)
   */
  async getDefaultScreenBmpBuffer(): Promise<Buffer> {
    await this.ensureDefaultScreenBmpExists();
    return fs.readFile(this.defaultScreenBmpPath);
  }

  // --- Device-sized default screens (needed for non-800x480 panels, e.g. TRMNL X 1872x1404) ---

  /** URL for a default screen matching a device's exact resolution + format. */
  getDefaultScreenUrlForSize(width: number, height: number, format: 'png' | 'bmp'): string {
    return `/assets/default-screen-${width}x${height}.${format}`;
  }

  /** Filesystem path for a sized default screen. */
  private sizedDefaultScreenPath(width: number, height: number, format: 'png' | 'bmp'): string {
    return path.join(this.assetsDir, `default-screen-${width}x${height}.${format}`);
  }

  /**
   * Ensure a default screen exists at the given resolution + format + bit depth, generating it if
   * missing. `bitDepth >= 4` emits a 16-level grayscale BMP (TRMNL X); otherwise a 1-bit image
   * (PNG or BMP). The image is always rendered at the device's native size so it fills the panel.
   */
  async ensureDefaultScreenForSize(
    width: number,
    height: number,
    format: 'png' | 'bmp',
    bitDepth: number,
  ): Promise<void> {
    const outputPath = this.sizedDefaultScreenPath(width, height, format);
    try {
      await fs.mkdir(this.assetsDir, { recursive: true });
      try {
        await fs.access(outputPath);
        return;
      } catch {
        // needs generating
      }

      const welcomeConfig = await this.settingsService.getWelcomeScreenConfig();
      const svg = this.createDefaultScreenSvg(width, height, welcomeConfig.title, welcomeConfig.subtitle);

      const grayBuffer = await sharp(Buffer.from(svg))
        .grayscale()
        .normalise()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { data, info } = grayBuffer;

      let buffer: Buffer;
      if (bitDepth >= 4) {
        // 16-level grayscale: compressed PNG by default, 4-bit BMP only if explicitly requested.
        const quantized = quantizeGray16(data);
        if (format === 'bmp') {
          buffer = encodeGray4Bmp(quantized, info.width, info.height);
        } else {
          buffer = await sharp(quantized, {
            raw: { width: info.width, height: info.height, channels: 1 },
          })
            .toColorspace('b-w')
            .png({ compressionLevel: 9 })
            .toBuffer();
        }
      } else {
        const dithered = this.applyFloydSteinbergDithering(data, info.width, info.height, 140);
        if (format === 'bmp') {
          buffer = encodeBmp1bit(dithered, info.width, info.height);
        } else {
          buffer = await sharp(dithered, {
            raw: { width: info.width, height: info.height, channels: 1 },
          })
            .toColorspace('b-w')
            .png({ compressionLevel: 9 })
            .toBuffer();
        }
      }

      await fs.writeFile(outputPath, buffer);
      this.logger.log(`Generated sized default screen: ${outputPath} (bitDepth=${bitDepth})`);
    } catch (error) {
      this.logger.error(`Failed to ensure sized default screen (${width}x${height}):`, error);
    }
  }

  /** Base64 of a sized default screen (for devices requesting inline image data). */
  async getDefaultScreenBase64ForSize(
    width: number,
    height: number,
    format: 'png' | 'bmp',
    bitDepth: number,
  ): Promise<string | undefined> {
    try {
      await this.ensureDefaultScreenForSize(width, height, format, bitDepth);
      const buffer = await fs.readFile(this.sizedDefaultScreenPath(width, height, format));
      return buffer.toString('base64');
    } catch {
      return undefined;
    }
  }

  /**
   * Check if default screen has been generated
   */
  isReady(): boolean {
    return this.defaultScreenGenerated;
  }

  /**
   * Force regeneration of the default screen
   * Useful if dimensions or content need to change
   */
  async regenerate(
    width: number = this.DEFAULT_WIDTH,
    height: number = this.DEFAULT_HEIGHT,
  ): Promise<string> {
    this.logger.log('Force regenerating default screen...');
    return this.generateDefaultScreen(width, height);
  }

  /**
   * Generate a custom default screen for a specific device model
   * @param modelWidth Device screen width
   * @param modelHeight Device screen height
   * @returns Path to the generated screen
   */
  async generateForModel(
    modelWidth: number,
    modelHeight: number,
  ): Promise<string> {
    const filename = `default-screen-${modelWidth}x${modelHeight}.png`;
    const outputPath = path.join(this.assetsDir, filename);

    // Check if this resolution already exists
    try {
      await fs.access(outputPath);
      return outputPath;
    } catch {
      // Generate new resolution
    }

    this.logger.log(`Generating default screen for model: ${modelWidth}x${modelHeight}`);

    const welcomeConfig = await this.settingsService.getWelcomeScreenConfig();
    const svg = this.createDefaultScreenSvg(modelWidth, modelHeight, welcomeConfig.title, welcomeConfig.subtitle);

    const grayBuffer = await sharp(Buffer.from(svg))
      .grayscale()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const dithered = this.applyFloydSteinbergDithering(
      grayBuffer.data, grayBuffer.info.width, grayBuffer.info.height, 140,
    );

    await sharp(dithered, {
      raw: { width: grayBuffer.info.width, height: grayBuffer.info.height, channels: 1 },
    })
      .toColorspace('b-w')
      .png({ compressionLevel: 9 })
      .toFile(outputPath);

    return outputPath;
  }

  /**
   * Floyd-Steinberg dithering for 1-bit e-ink output
   */
  private applyFloydSteinbergDithering(
    data: Buffer, width: number, height: number, threshold: number,
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
        if (x + 1 < width) pixels[idx + 1] += error * 7 / 16;
        if (y + 1 < height) {
          if (x - 1 >= 0) pixels[(y + 1) * width + (x - 1)] += error * 3 / 16;
          pixels[(y + 1) * width + x] += error * 5 / 16;
          if (x + 1 < width) pixels[(y + 1) * width + (x + 1)] += error * 1 / 16;
        }
      }
    }

    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = Math.max(0, Math.min(255, Math.round(pixels[i])));
    }
    return result;
  }

  /**
   * Get the default screen as base64 encoded string
   */
  async getDefaultScreenBase64(): Promise<string> {
    await this.ensureDefaultScreenExists();

    const buffer = await fs.readFile(this.defaultScreenPath);
    return buffer.toString('base64');
  }

  /**
   * Get the default screen as a buffer (negated for device)
   */
  async getDefaultScreenBuffer(): Promise<Buffer> {
    await this.ensureDefaultScreenExists();

    return fs.readFile(this.defaultScreenPath);
  }

  /**
   * Get the default screen as a buffer for browser preview
   */
  async getDefaultScreenPreviewBuffer(): Promise<Buffer> {
    await this.ensureDefaultScreenExists();

    return sharp(this.defaultScreenPath)
      .png()
      .toBuffer();
  }
}
