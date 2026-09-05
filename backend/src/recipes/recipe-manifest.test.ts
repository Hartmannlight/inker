import { describe, expect, test } from 'bun:test';
import { prepareRecipeManifest, validateRecipeSettings } from './recipe-manifest';

const manifest = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0', slug: 'safe-clock', name: 'Safe clock', source: 'inker',
  layouts: { full: '<main>{% render "shared" %}</main>' },
  partials: { shared: '<span>{{ trmnl.plugin_settings.timezone }}</span>' },
  settingsSchema: [{ key: 'timezone', label: 'Timezone', type: 'timezone', required: true }],
  requiredConnectorType: null,
  ...overrides,
});

describe('recipe manifest boundary', () => {
  test('resolves literal static partials and produces a stable immutable hash', () => {
    const first = prepareRecipeManifest(manifest());
    const second = prepareRecipeManifest(manifest());
    expect(first.layouts.full).toBe('<main><span>{{ trmnl.plugin_settings.timezone }}</span></main>');
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
  });

  test('rejects dynamic, missing, recursive and layout guest IO', () => {
    for (const input of [
      manifest({ layouts: { full: '{% render partial_name %}' } }),
      manifest({ layouts: { full: '{% render "missing" %}' } }),
      manifest({ partials: { shared: '{% render "shared" %}' } }),
      manifest({ layouts: { full: '{% layout "remote" %}' } }),
    ]) expect(() => prepareRecipeManifest(input)).toThrow('RECIPE_MANIFEST_INVALID');
  });

  test('accepts only declared, correctly typed non-secret binding settings', () => {
    const prepared = prepareRecipeManifest(manifest());
    expect(validateRecipeSettings(prepared.settingsSchema, { timezone: 'Europe/Berlin' }))
      .toEqual({ timezone: 'Europe/Berlin' });
    expect(() => validateRecipeSettings(prepared.settingsSchema, { timezone: 'Europe/Berlin', token: 'secret' }))
      .toThrow('RECIPE_MANIFEST_INVALID');
    expect(() => prepareRecipeManifest(manifest({ settingsSchema: [{ key: 'token', label: 'Token', type: 'text', encrypted: true }] })))
      .toThrow('RECIPE_MANIFEST_INVALID');
  });
});
