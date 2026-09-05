import { ServiceUnavailableException } from '@nestjs/common';
import type { PublicationRevision } from '@prisma/client';
import type { Sharp } from 'sharp';
import { sharp } from '../common/utils/sharp.util';
import { encodeBmp1bit } from '../common/utils/bmp1bit.util';
import { publicationArtifacts, type PublishedArtifact } from '../publications/publication-content';
import { sha256 } from '../common/utils/content-hash.util';
import { MAX_RENDER_BYTES, MAX_RENDER_PIXELS, MAX_SNAPSHOT_BYTES, RENDER_MIME_TYPES, validateRenderTarget, type RenderTarget } from './render-input';
import { QUEUE_POLICIES } from '../jobs/queue-policy';

const sharpOptions = { limitInputPixels: MAX_RENDER_PIXELS, animated: false, failOn: 'warning' as const };
const unavailable = () => new ServiceUnavailableException('Snapshot rendering unavailable');

/** Only the standard uncompressed 1-bit BMP produced by our encoder is accepted. */
function decodeBmp1(bytes: Buffer, width: number, height: number): Buffer {
  const stride = Math.ceil(width / 32) * 4;
  if (bytes.length < 62 || bytes.toString('ascii', 0, 2) !== 'BM' || bytes.readUInt32LE(2) !== bytes.length ||
    bytes.readUInt32LE(10) !== 62 || bytes.readUInt32LE(14) !== 40 || bytes.readInt32LE(18) !== width ||
    bytes.readInt32LE(22) !== height || bytes.readUInt16LE(26) !== 1 || bytes.readUInt16LE(28) !== 1 ||
    bytes.readUInt32LE(30) !== 0 || bytes.readUInt32LE(34) !== stride * height || bytes.length !== 62 + stride * height ||
    !bytes.subarray(54, 62).equals(Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]))) throw unavailable();
  const gray = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const row = 62 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) gray[y * width + x] = bytes[row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
  }
  return gray;
}

function quantize(value: number, bits: number): number {
  const levels = 2 ** bits - 1;
  return Math.round(Math.round(value * levels / 255) * 255 / levels);
}

function quantizePixels(pixels: Buffer, target: RenderTarget): void {
  if (target.colorSpace !== 'rgb' && target.bitDepth === 1) {
    const width = target.width;
    let currentError = new Float32Array(width + 2);
    let nextError = new Float32Array(width + 2);
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const value = Math.max(0, Math.min(255, pixels[index] + currentError[x + 1]));
        const quantized = value < 128 ? 0 : 255;
        pixels[index] = quantized;
        const error = value - quantized;
        currentError[x + 2] += error * 7 / 16;
        nextError[x] += error * 3 / 16;
        nextError[x + 1] += error * 5 / 16;
        nextError[x + 2] += error / 16;
      }
      currentError = nextError;
      nextError = new Float32Array(width + 2);
    }
  } else if (target.colorSpace !== 'rgb') {
    for (let i = 0; i < pixels.length; i++) pixels[i] = quantize(pixels[i], target.bitDepth);
  } else if (target.bitDepth < 24) {
    const bits = target.bitDepth === 16 ? [5, 6, 5] : [3, 3, 2];
    for (let i = 0; i < pixels.length; i++) pixels[i] = quantize(pixels[i], bits[i % 3]);
  }
}

/** Store-boundary verification also protects against faulty/injected renderers. */
export async function validateRenderedArtifact(artifact: PublishedArtifact, target: RenderTarget): Promise<void> {
  validateRenderTarget(target);
  if (!artifact || !Buffer.isBuffer(artifact.bytes) || !artifact.bytes.length || artifact.bytes.length > MAX_RENDER_BYTES ||
    artifact.format !== target.format || artifact.mimeType !== RENDER_MIME_TYPES[target.format] ||
    artifact.width !== target.width || artifact.height !== target.height || artifact.colorSpace !== target.colorSpace ||
    artifact.bitDepth !== target.bitDepth || artifact.rotation !== target.rotation || artifact.sha256 !== sha256(artifact.bytes)) throw unavailable();
  if (target.format === 'bmp1') {
    decodeBmp1(artifact.bytes, target.width, target.height);
    return;
  }
  try {
    const image = sharp(artifact.bytes, sharpOptions);
    const metadata = await image.metadata();
    if (metadata.format !== target.format || metadata.width !== target.width || metadata.height !== target.height ||
      (metadata.pages ?? 1) !== 1 || metadata.hasAlpha || metadata.orientation !== undefined) throw unavailable();
    const pixels = await image.toColourspace('srgb').removeAlpha().raw().toBuffer();
    // Lossless formats must contain only the promised panel colour levels. JPEG
    // is deliberately limited to unquantized RGB24/grayscale8 by target validation.
    for (let i = 0; i < pixels.length; i += 3) {
      if (target.colorSpace !== 'rgb') {
        if (pixels[i] !== pixels[i + 1] || pixels[i] !== pixels[i + 2] ||
          pixels[i] !== quantize(pixels[i], target.bitDepth)) throw unavailable();
      } else if (target.bitDepth < 24) {
        const bits = target.bitDepth === 16 ? [5, 6, 5] : [3, 3, 2];
        for (let channel = 0; channel < 3; channel++) if (pixels[i + channel] !== quantize(pixels[i + channel], bits[channel])) throw unavailable();
      }
    }
  } catch { throw unavailable(); }
}

/** Reads immutable PublicationRevision bytes only; no URLs, disk reads or providers. */
export async function renderSnapshot(revision: PublicationRevision, target: RenderTarget, signal?: AbortSignal): Promise<PublishedArtifact> {
  signal?.throwIfAborted();
  const deadline = Date.now() + QUEUE_POLICIES.render.timeoutMs;
  const bounded = (pipeline: Sharp) => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    return pipeline.timeout({ seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) });
  };
  validateRenderTarget(target);
  const artifacts = publicationArtifacts(revision);
  const native = artifacts.find(artifact => 'fixtureId' in artifact && artifact.format === target.format && artifact.width === target.width &&
    artifact.height === target.height && artifact.colorSpace === target.colorSpace && artifact.bitDepth === target.bitDepth &&
    artifact.rotation === target.rotation && [target.safeArea.top, target.safeArea.right, target.safeArea.bottom, target.safeArea.left].every(value => value === 0));
  if (native) {
    await validateRenderedArtifact(native, target);
    return { ...native, bytes: Buffer.from(native.bytes) };
  }
  const source = artifacts.find(artifact => artifact.format === target.format) ?? artifacts.find(artifact => artifact.format === 'png') ?? artifacts[0];
  if (!source || source.bytes.length > MAX_SNAPSHOT_BYTES || source.width * source.height > MAX_RENDER_PIXELS) throw unavailable();
  try {
    let image: Sharp;
    if (source.format === 'bmp1') {
      image = sharp(decodeBmp1(source.bytes, source.width, source.height), { raw: { width: source.width, height: source.height, channels: 1 } });
    } else {
      image = sharp(source.bytes, sharpOptions);
      const metadata = await image.metadata();
      if (metadata.format !== 'png' || metadata.width !== source.width || metadata.height !== source.height || (metadata.pages ?? 1) !== 1) throw unavailable();
    }
    const { top, right, bottom, left } = target.safeArea;
    const width = target.width - left - right;
    const height = target.height - top - bottom;
    const rotation = (target.rotation - source.rotation + 360) % 360;
    const swapped = rotation === 90 || rotation === 270;
    const sourceWidth = swapped ? source.height : source.width;
    const sourceHeight = swapped ? source.width : source.height;
    if (target.scaling === 'none' && (sourceWidth > width || sourceHeight > height)) throw unavailable();
    const background = target.backgroundColor ?? '#ffffff';
    image = image.rotate(rotation).flatten({ background }).toColourspace('srgb');
    if (target.scaling === 'none') {
      const padX = width - sourceWidth;
      const padY = height - sourceHeight;
      image = image.extend({ left: Math.floor(padX / 2), right: Math.ceil(padX / 2), top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2), background });
    } else image = image.resize(width, height, { fit: target.scaling, background, kernel: 'lanczos3' });
    // Materialize before safe-area padding: Sharp applies each operation only once.
    const intermediate = await bounded(image.png()).toBuffer();
    image = sharp(intermediate, sharpOptions).extend({ top, right, bottom, left, background });
    const grayscale = target.colorSpace !== 'rgb';
    if (grayscale) image = image.toColourspace('b-w');
    const { data: pixels, info } = await bounded(image.removeAlpha().raw()).toBuffer({ resolveWithObject: true });
    if (info.width !== target.width || info.height !== target.height || info.channels !== (grayscale ? 1 : 3)) throw unavailable();
    quantizePixels(pixels, target);
    let bytes: Buffer;
    if (target.format === 'bmp1') bytes = encodeBmp1bit(pixels, target.width, target.height);
    else {
      image = sharp(pixels, { raw: { width: target.width, height: target.height, channels: grayscale ? 1 : 3 } });
      if (grayscale) image = image.toColourspace('b-w');
      bytes = target.format === 'jpeg'
        ? await bounded(image.jpeg({ quality: 90, chromaSubsampling: '4:4:4', progressive: false })).toBuffer()
        : await bounded(image.png({ compressionLevel: 9, adaptiveFiltering: false, ...(grayscale && target.bitDepth < 8 ? { palette: true, colours: 2 ** target.bitDepth, dither: 0 } : {}) })).toBuffer();
    }
    const artifact: PublishedArtifact = { format: target.format, mimeType: RENDER_MIME_TYPES[target.format], width: target.width,
      height: target.height, colorSpace: target.colorSpace, bitDepth: target.bitDepth, rotation: target.rotation, bytes, sha256: sha256(bytes) };
    await validateRenderedArtifact(artifact, target);
    return artifact;
  } catch { throw unavailable(); }
}
