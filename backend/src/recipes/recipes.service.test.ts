import { describe, expect, mock, test } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { prepareRecipeManifest } from './recipe-manifest';
import { RecipesService } from './recipes.service';

function storedRecipe(requiredConnectorType: string | null = 'http-json') {
  const prepared = prepareRecipeManifest({
    protocolVersion: '1.0', slug: 'status-card', name: 'Status card', source: 'trmnl',
    layouts: { full: '<div>{{ title }} {{ trmnl.plugin_settings.label }}</div>' },
    partials: {}, settingsSchema: [{ key: 'label', label: 'Label', type: 'text', required: true }],
    requiredConnectorType,
  });
  const { contentHash: _contentHash, ...manifest } = prepared;
  return { prepared, manifest };
}

describe('RecipesService immutable rendering boundary', () => {
  test('renders only a pinned manifest and latest valid source snapshot', async () => {
    const renderer = { renderToPng: mock(async () => Buffer.from('png')) };
    const service = new RecipesService({} as never, renderer as never);
    const { prepared, manifest } = storedRecipe();
    service.readBinding = mock(async () => ({
      recipeDefinitionId: 'recipe', recipeRevisionId: 'revision', settings: { label: 'Office' },
      revision: { recipeDefinitionId: 'recipe', contentHash: prepared.contentHash, manifest,
        layouts: prepared.layouts, settingsSchema: prepared.settingsSchema, requiredConnectorType: 'http-json' },
      sourceDefinition: { connectorType: 'http-json', latestValidSnapshot: { data: { title: 'Online' } } },
    })) as never;

    await expect(service.renderBinding('binding')).resolves.toEqual(Buffer.from('png'));
    expect(renderer.renderToPng).toHaveBeenCalledWith(prepared.layouts.full,
      { title: 'Online', trmnl: { plugin_settings: { label: 'Office' } } }, {}, 800, 480, 'device');
  });

  test('fails closed when immutable manifest bytes and their hash disagree', async () => {
    const renderer = { renderToPng: mock(async () => Buffer.from('png')) };
    const service = new RecipesService({} as never, renderer as never);
    const { prepared, manifest } = storedRecipe(null);
    service.readBinding = mock(async () => ({
      recipeDefinitionId: 'recipe', settings: {}, sourceDefinition: null,
      revision: { recipeDefinitionId: 'recipe', contentHash: '0'.repeat(64), manifest,
        layouts: prepared.layouts, settingsSchema: prepared.settingsSchema, requiredConnectorType: null },
    })) as never;

    await expect(service.renderBinding('binding')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(renderer.renderToPng).not.toHaveBeenCalled();
  });

  test('requires a compatible source and an immutable valid snapshot', async () => {
    const renderer = { renderToPng: mock(async () => Buffer.from('png')) };
    const service = new RecipesService({} as never, renderer as never);
    const { prepared, manifest } = storedRecipe();
    service.readBinding = mock(async () => ({
      recipeDefinitionId: 'recipe', settings: {},
      revision: { recipeDefinitionId: 'recipe', contentHash: prepared.contentHash, manifest,
        layouts: prepared.layouts, settingsSchema: prepared.settingsSchema, requiredConnectorType: 'http-json' },
      sourceDefinition: { connectorType: 'http-json', latestValidSnapshot: null },
    })) as never;

    await expect(service.renderBinding('binding')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(renderer.renderToPng).not.toHaveBeenCalled();
  });
});
