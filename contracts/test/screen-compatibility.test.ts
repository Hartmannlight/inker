import { describe, expect, it } from 'bun:test';
import { assessScreenCompatibility } from '../src/screen-compatibility';

const target = { width: 800, height: 480, renderFormats: ['png', 'bmp1'] as const };

describe('screen compatibility', () => {
  it('classifies exact, adaptable, risky, and unknown screens deterministically', () => {
    expect(assessScreenCompatibility({ width: 800, height: 480, format: 'png' }, target).kind).toBe('exact');
    expect(assessScreenCompatibility({ width: 1600, height: 960, format: 'png' }, target).kind).toBe('adaptable');
    expect(assessScreenCompatibility({ width: 480, height: 800, format: 'png' }, target).kind).toBe('risky');
    expect(assessScreenCompatibility({ width: 400, height: 240, format: 'png' }, target).kind).toBe('risky');
    expect(assessScreenCompatibility({ width: null, height: null }, target).kind).toBe('unknown');
  });

  it('does not imply compatibility when the target or output format is unavailable', () => {
    expect(assessScreenCompatibility({ width: 800, height: 480, format: 'jpeg' }, target).kind).toBe('risky');
    expect(assessScreenCompatibility({ width: 800, height: 480, format: 'png' }, null).kind).toBe('unknown');
  });
});
