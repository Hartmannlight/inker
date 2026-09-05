export interface FloydSteinbergOptions {
  /** Grayscale split point. Values above it become white. */
  threshold?: number;
  /** Preserve the legacy `> threshold` behaviour instead of `>= threshold`. */
  whiteAtThreshold?: boolean;
  /** Snap near-black and near-white input before diffusing errors. */
  contrastSnap?: { low: number; high: number };
  /** Clamp neighbours after each diffusion step. */
  clampDiffusion?: boolean;
}

/**
 * Convert a single-channel, row-major grayscale buffer to black/white pixels
 * using Floyd-Steinberg error diffusion.
 */
export function floydSteinbergDither(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  options: FloydSteinbergOptions = {},
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid raster dimensions: ${width}x${height}`);
  }
  if (data.length !== width * height) {
    throw new Error(
      `Expected ${width * height} grayscale pixels for ${width}x${height}, got ${data.length}`,
    );
  }

  const threshold = options.threshold ?? 128;
  const whiteAtThreshold = options.whiteAtThreshold ?? true;
  const pixels = new Float32Array(data.length);

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    const snap = options.contrastSnap;
    pixels[i] = snap && value > snap.high ? 255 : snap && value < snap.low ? 0 : value;
  }

  const diffuse = (index: number, error: number, weight: number) => {
    const value = pixels[index] + (error * weight) / 16;
    pixels[index] = options.clampDiffusion ? Math.max(0, Math.min(255, value)) : value;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const oldPixel = pixels[index];
      const isWhite = whiteAtThreshold ? oldPixel >= threshold : oldPixel > threshold;
      const newPixel = isWhite ? 255 : 0;
      pixels[index] = newPixel;
      const error = oldPixel - newPixel;

      if (x + 1 < width) diffuse(index + 1, error, 7);
      if (y + 1 < height) {
        if (x > 0) diffuse((y + 1) * width + x - 1, error, 3);
        diffuse((y + 1) * width + x, error, 5);
        if (x + 1 < width) diffuse((y + 1) * width + x + 1, error, 1);
      }
    }
  }

  const result = Buffer.alloc(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    result[i] = Math.max(0, Math.min(255, Math.round(pixels[i])));
  }
  return result;
}
