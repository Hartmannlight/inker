import { describe, expect, it } from 'bun:test';
import { parseDisplayControlInput, readDisplayControl, resolveDisplayControl } from './display-control';

const scheduled = {
  brightness: 90,
  scheduleEnabled: true,
  dimStartAt: '22:00',
  dimStopAt: '07:00',
  dimBrightness: 15,
  timezone: 'Europe/Berlin',
};

describe('LCD display control', () => {
  it('resolves a schedule that crosses midnight in its configured timezone', () => {
    const configuration = { displayControl: scheduled };
    expect(resolveDisplayControl(configuration, new Date('2026-01-15T21:30:00Z'))).toMatchObject({
      effectiveBrightness: 15,
      mode: 'scheduled-dim',
    });
    expect(resolveDisplayControl(configuration, new Date('2026-01-15T11:00:00Z'))).toMatchObject({
      effectiveBrightness: 90,
      mode: 'scheduled-day',
    });
  });

  it('uses manual brightness when scheduling is disabled', () => {
    expect(resolveDisplayControl({ displayControl: { ...scheduled, scheduleEnabled: false } })).toMatchObject({
      effectiveBrightness: 90,
      mode: 'manual',
    });
  });

  it('uses safe defaults for missing stored JSON and strictly rejects invalid API input', () => {
    expect(readDisplayControl(null)).toMatchObject({ brightness: 100, scheduleEnabled: false, dimBrightness: 20 });
    expect(() => parseDisplayControlInput({ ...scheduled, brightness: 101 })).toThrow('brightness');
    expect(() => parseDisplayControlInput({ ...scheduled, timezone: 'Not/A_Timezone' })).toThrow('timezone');
    expect(() => parseDisplayControlInput({ ...scheduled, foregroundColor: 'white' })).toThrow('foregroundColor');
  });
});
