import { describe, expect, test } from 'bun:test';
import { materializePlaylistItems, parsePlaylistTargets } from './playlist-targets';

describe('playlist target normalization', () => {
  test('parses every supported target kind without sharing duplicate item metadata', () => {
    const parsed = parsePlaylistTargets([
      { screenId: '7', order: 1, duration: 10 },
      { screenId: 'design-8', order: 2, duration: 20 },
      { screenId: 'plugin-9', order: 3, duration: 30 },
      { screenId: 'recipe:binding-10', order: 4, duration: 50 },
      { screenId: '7', order: 4, duration: 40 },
    ]);
    expect(parsed.targets.map(({ kind, id, order, duration }) => ({ kind, id, order, duration }))).toEqual([
      { kind: 'regular', id: 7, order: 1, duration: 10 },
      { kind: 'design', id: 8, order: 2, duration: 20 },
      { kind: 'plugin', id: 9, order: 3, duration: 30 },
      { kind: 'recipe', id: 'binding-10', order: 4, duration: 50 },
      { kind: 'regular', id: 7, order: 4, duration: 40 },
    ]);
  });

  test('rejects partial, non-positive and overflowing database identifiers', () => {
    const parsed = parsePlaylistTargets([
      { screenId: '12junk' }, { screenId: 'design-0' }, { screenId: 'plugin-2147483648' },
    ]);
    expect(parsed.targets).toEqual([]);
    expect(parsed.invalid).toEqual(['12junk', 'design-0', 'plugin-2147483648']);
  });

  test('creates only existing polymorphic playlist records', () => {
    const parsed = parsePlaylistTargets([
      { screenId: '1' }, { screenId: 'design-2' }, { screenId: 'plugin-3' },
    ]);
    const result = materializePlaylistItems(11, parsed, {
      regularIds: new Set([1]), designIds: new Set(), pluginIds: new Set([3]), recipeIds: new Set(),
    });
    expect(result.items).toEqual([
      { playlistId: 11, screenId: 1, order: 0, duration: 60 },
      { playlistId: 11, pluginInstanceId: 3, order: 2, duration: 60 },
    ]);
    expect(result.missing.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: 'design', id: 2 }]);
  });

  test('normalizes the public zero-duration sentinel to the persisted untimed value', () => {
    const parsed = parsePlaylistTargets([{ screenId: '1', duration: 0 }]);
    const result = materializePlaylistItems(11, parsed, {
      regularIds: new Set([1]), designIds: new Set(), pluginIds: new Set(), recipeIds: new Set(),
    });
    expect(result.items[0]?.duration).toBeNull();
  });
});
