import type { RenderFormat } from './device';

export type ScreenCompatibilityKind = 'exact' | 'adaptable' | 'risky' | 'unknown';

export interface ScreenRasterMetadata {
  width?: number | null;
  height?: number | null;
  format?: RenderFormat | null;
}

export interface ScreenCompatibilityTarget {
  width: number;
  height: number;
  renderFormats: readonly RenderFormat[];
}

export interface ScreenCompatibility {
  kind: ScreenCompatibilityKind;
  reason: string;
}

const validDimension = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

/**
 * Classifies a raster without making device-specific hardware assumptions.
 * A 25% aspect-ratio delta is still usable with contain; larger deltas need
 * an explicit preview decision. The function intentionally has no UI/runtime
 * dependencies so commands and pickers use identical semantics.
 */
export function assessScreenCompatibility(
  screen: ScreenRasterMetadata,
  target?: ScreenCompatibilityTarget | null,
): ScreenCompatibility {
  if (!target || !validDimension(target.width) || !validDimension(target.height)
    || !Array.isArray(target.renderFormats) || target.renderFormats.length === 0
    || !validDimension(screen.width) || !validDimension(screen.height)) {
    return { kind: 'unknown', reason: 'Screen or target metadata is unavailable.' };
  }
  if (screen.format && !target.renderFormats.includes(screen.format)) {
    return { kind: 'risky', reason: 'The screen format is not supported by this device.' };
  }
  const screenLandscape = Number(screen.width) >= Number(screen.height);
  const targetLandscape = target.width >= target.height;
  if (screen.width === target.width && screen.height === target.height) {
    return { kind: 'exact', reason: 'Dimensions, orientation, and output format match.' };
  }
  if (screenLandscape !== targetLandscape) {
    return { kind: 'risky', reason: 'The screen and device have different orientations.' };
  }
  const ratioDelta = Math.abs((Number(screen.width) / Number(screen.height)) / (target.width / target.height) - 1);
  if (ratioDelta > 0.25 || Number(screen.width) < target.width || Number(screen.height) < target.height) {
    return { kind: 'risky', reason: ratioDelta > 0.25 ? 'The aspect ratios differ substantially.' : 'The raster is smaller than the device output.' };
  }
  return { kind: 'adaptable', reason: 'The screen will be centered proportionally with letterboxing.' };
}
