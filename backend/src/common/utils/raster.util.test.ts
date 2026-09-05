import { floydSteinbergDither } from './raster.util';

describe('floydSteinbergDither', () => {
  it('produces a deterministic binary raster', () => {
    const input = Buffer.from([0, 64, 128, 192, 255, 96]);
    const result = floydSteinbergDither(input, 3, 2);

    expect([...result]).toEqual([0, 0, 255, 255, 255, 0]);
    expect([...result].every((pixel) => pixel === 0 || pixel === 255)).toBe(true);
  });

  it('supports the legacy strict threshold boundary', () => {
    expect([...floydSteinbergDither(Buffer.from([128]), 1, 1)]).toEqual([255]);
    expect([
      ...floydSteinbergDither(Buffer.from([128]), 1, 1, { whiteAtThreshold: false }),
    ]).toEqual([0]);
  });

  it('rejects inconsistent dimensions', () => {
    expect(() => floydSteinbergDither(Buffer.from([0]), 2, 1)).toThrow(
      'Expected 2 grayscale pixels',
    );
  });
});
