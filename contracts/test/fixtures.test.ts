import { describe, expect, it } from 'bun:test';
import { isDeviceStatus, isJsonValue } from '../src';

interface DeviceStatusFixture {
  contract: string;
  valid: unknown[];
  invalid: unknown[];
}

const fixture = (await Bun.file(
  new URL('../fixtures/device-status.json', import.meta.url),
).json()) as DeviceStatusFixture;

describe('DeviceStatus fixture', () => {
  it('is itself JSON-compatible', () => {
    expect(isJsonValue(fixture)).toBe(true);
  });

  it('accepts every valid example', () => {
    expect(fixture.contract).toBe('DeviceStatus');
    expect(fixture.valid.every(isDeviceStatus)).toBe(true);
  });

  it('rejects every invalid example', () => {
    expect(fixture.invalid.every((value) => !isDeviceStatus(value))).toBe(true);
  });
});

describe('JSON contract boundary', () => {
  it('rejects values that JSON would omit or coerce', () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
  });

  it('rejects cyclic values without rejecting shared non-cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    const shared = { value: 1 };
    expect(isJsonValue({ first: shared, second: shared })).toBe(true);
  });
});
