import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Response } from 'express';
import type { PrismaService } from '../prisma/prisma.service';
import type { EncryptionService } from '../common/services/encryption.service';
import type { OAuthService } from './oauth/oauth.service';
import type { PluginRendererService } from './plugin-renderer.service';
import { PluginsService } from './plugins.service';
import { PluginsController } from './plugins.controller';

describe('legacy plugin snapshot boundary', () => {
  afterEach(() => mock.restore());

  function harness(lastData: unknown = { temperature: 21 }) {
    const plugin = {
      id: 1, name: 'Legacy', slug: 'grafana_panel', refreshInterval: 1,
      dataTransform: 'while (true) {}', dataUrl: 'http://127.0.0.1/private',
      dataHeaders: { Authorization: 'Bearer provider-token' },
      settingsSchema: [{ key: 'customCredential', encrypted: true }],
      markupFull: '{{ temperature }}', oauthProvider: 'example',
    };
    const instance = {
      id: 2, pluginId: 1, name: 'Stored', plugin,
      settings: { title: 'Stored title', customCredential: 'plaintext-value', dashboard_uid: 'd1', panel_id: 1 },
      settingsEncrypted: { customCredential: 'encrypted-value' },
      oauthToken: 'encrypted-access', oauthRefreshToken: 'encrypted-refresh',
      lastData, lastFetchedAt: new Date('2020-01-01T00:00:00Z'),
      lastError: 'arbitrary old provider-secret',
    };
    const prisma = {
      plugin: {
        findUnique: mock(async () => ({ ...plugin, instances: [instance] })),
        findMany: mock(async () => [{ ...plugin, instances: [instance] }]),
        upsert: mock(async () => plugin), deleteMany: mock(async () => ({ count: 0 })),
      },
      pluginInstance: {
        findUnique: mock(async () => instance), findMany: mock(async () => [instance]),
        update: mock(async () => instance), create: mock(async () => instance),
      },
    };
    const renderer = {
      selectMarkup: mock(() => plugin.markupFull),
      renderToPng: mock(async (..._args: unknown[]) => Buffer.from('test-render')),
    };
    const encryption = {
      decryptObject: mock(() => { throw new Error('unexpected decryption'); }),
      encryptObject: mock(() => ({ customCredential: 'new-ciphertext' })),
    };
    const oauth = { getAccessToken: mock(async () => { throw new Error('unexpected OAuth'); }) };
    const network = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected request'); });
    const service = new PluginsService(prisma as unknown as PrismaService,
      renderer as unknown as PluginRendererService, encryption as unknown as EncryptionService,
      oauth as unknown as OAuthService);
    const controller = new PluginsController(service, oauth as unknown as OAuthService);
    return { service, controller, instance, plugin, prisma, renderer, encryption, oauth, network };
  }

  test('expired cache is available without writes, decryption, OAuth or requests', async () => {
    const h = harness();
    const before = JSON.stringify(h.instance);
    expect(await h.service.fetchData(2)).toEqual({ temperature: 21 });
    expect(await h.controller.fetchData(2)).toEqual({ temperature: 21 });
    expect(JSON.stringify(h.instance)).toBe(before);
    expect(h.prisma.pluginInstance.update).not.toHaveBeenCalled();
    expect(h.encryption.decryptObject).not.toHaveBeenCalled();
    expect(h.oauth.getAccessToken).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });

  test('missing or invalid cache fails with 503 rather than a placeholder', async () => {
    for (const value of [null, undefined, 'invalid', [], { value: undefined }]) {
      const h = harness(value);
      h.instance.lastData = value;
      await expect(h.service.fetchData(2)).rejects.toMatchObject({ status: 503, message: 'SOURCE_SNAPSHOT_UNAVAILABLE' });
      await expect(h.service.renderInstance(2)).rejects.toThrow('SOURCE_SNAPSHOT_UNAVAILABLE');
      expect(h.renderer.renderToPng).not.toHaveBeenCalled();
    }
  });

  test('Grafana rendering uses persisted data without settings or provider access', async () => {
    const h = harness({ temperature: 21, access_token: 'cached-secret' });
    await h.service.renderInstance(2, 'full', 'preview');
    expect(h.renderer.renderToPng.mock.calls[0]).toEqual([
      '{{ temperature }}', { temperature: 21, access_token: '[REDACTED]' }, {}, 800, 480, 'preview',
    ]);
    expect(h.network).not.toHaveBeenCalled();
    expect(h.encryption.decryptObject).not.toHaveBeenCalled();
  });

  test('unregistered refresh, JS adapters and all provider proxies fail explicitly', async () => {
    const h = harness();
    await expect(h.service.fetchDataForPlugin(1)).rejects.toThrow('PLUGIN_ISOLATION_REQUIRED');
    h.plugin.dataTransform = '';
    await expect(h.service.fetchDataForPlugin(1)).rejects.toThrow('SOURCE_REFRESH_REQUIRES_CONNECTOR');
    for (const operation of [
      () => h.controller.grafanaDashboards({ instanceId: 2 }),
      () => h.controller.grafanaPanels({ instanceId: 2, dashboard_uid: 'd1' }),
      () => h.controller.githubPlugin('chatgpt'),
      () => h.controller.recipes(), () => h.controller.recipe('1'),
      () => h.controller.recipeCategories(),
      () => h.controller.recipeImage('http://127.0.0.1/?trmnl', {} as Response),
      () => h.service.handleWebhook('legacy', { untrusted: true }),
    ]) await expect(operation()).rejects.toMatchObject({ status: 503, message: 'SOURCE_REFRESH_REQUIRES_CONNECTOR' });
    expect(h.network).not.toHaveBeenCalled();
    expect(h.prisma.pluginInstance.update).not.toHaveBeenCalled();
    expect(h.encryption.decryptObject).not.toHaveBeenCalled();
  });

  test('all instance response projections exclude ciphertexts, tokens and raw errors', async () => {
    const h = harness();
    const outputs = [await h.service.findAllPlugins(), await h.service.findPluginById(1),
      await h.service.findAllInstances(), await h.service.findInstanceByIdMasked(2),
      await h.service.createInstance({ pluginId: 1, settings: {} }),
      await h.service.updateInstance(2, { name: 'New name' })];
    for (const output of outputs) {
      const serialized = JSON.stringify(output);
      for (const secret of ['plaintext-value', 'encrypted-value', 'encrypted-access', 'encrypted-refresh', 'provider-secret', 'provider-token']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain('settingsEncrypted');
      expect(serialized).not.toContain('oauthRefreshToken');
    }
  });

  test('startup retains legacy definitions and customized builtin configuration', async () => {
    const h = harness();
    await h.service.cleanupStalePlugins();
    await h.service.seedBuiltinPlugins();
    expect(h.prisma.plugin.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.plugin.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  test('plugin preview requires persisted data and does not synthesize a card', async () => {
    const h = harness();
    await expect(h.service.previewPlugin(h.plugin)).rejects.toThrow('SOURCE_SNAPSHOT_UNAVAILABLE');
    expect(h.renderer.renderToPng).not.toHaveBeenCalled();
    await h.service.previewPlugin({ ...h.plugin, instances: [h.instance] });
    expect(h.renderer.renderToPng).toHaveBeenCalledTimes(1);
  });
});
