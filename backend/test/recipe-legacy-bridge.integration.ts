import { afterEach, describe, expect, mock, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LegacyContentMigrationService } from '../src/recipes/legacy-content-migration.service';

const backendRoot = resolve(import.meta.dir, '..');
const migrationScript = join(backendRoot, 'scripts', 'migrate-database.ts');
const directories: string[] = [];
const databaseUrl = (path: string) => `file:${path.replaceAll('\\', '/')}`;

async function migrate(path: string) {
  const child = Bun.spawn({ cmd: [process.execPath, migrationScript], cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl(path) }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('recipe legacy compatibility bridge', () => {
  test('migrates sources, recipes and playlists idempotently without copying credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inker-recipe-bridge-'));
    directories.push(directory);
    const databasePath = join(directory, 'inker.db');
    await migrate(databasePath);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
    await prisma.$connect();
    try {
      const legacySource = await prisma.dataSource.create({ data: {
        name: 'Legacy feed', type: 'json', url: 'https://example.test/status', method: 'GET',
        headers: { Authorization: 'Bearer migration-secret' }, refreshInterval: 60,
        lastData: { title: 'Persisted status' }, lastFetchedAt: new Date('2026-09-01T10:00:00.000Z'),
      } });
      const widget = await prisma.customWidget.create({ data: {
        name: 'Legacy widget', dataSourceId: legacySource.id, displayType: 'value', config: {},
      } });
      const plugin = await prisma.plugin.create({ data: {
        name: 'Legacy recipe', slug: 'legacy-recipe', dataStrategy: 'static',
        markupFull: '<div>{{ trmnl.plugin_settings.label }}</div>',
        settingsSchema: [
          { key: 'label', label: 'Label', type: 'text', required: true },
          { key: 'token', label: 'Token', type: 'text', encrypted: true },
        ],
      } });
      const instance = await prisma.pluginInstance.create({ data: {
        pluginId: plugin.id, name: 'Office', settings: { label: 'Ready' },
        settingsEncrypted: { token: 'ciphertext-that-must-not-migrate' },
      } });
      const playlist = await prisma.playlist.create({ data: {
        name: 'Legacy playlist', items: { create: { pluginInstanceId: instance.id, order: 0, duration: 60 } },
      }, include: { items: true } });
      const encrypt = mock((_plaintext: string) => 'opaque-source-secret');
      const bridge = new LegacyContentMigrationService(prisma as never, { encrypt } as never);

      expect(await bridge.migrateDataSources()).toBe(1);
      expect(await bridge.migratePlugins()).toBe(1);
      expect(await bridge.migrateDataSources()).toBe(1);
      expect(await bridge.migratePlugins()).toBe(1);

      const source = await prisma.sourceDefinition.findUniqueOrThrow({
        where: { legacyDataSourceId: legacySource.id }, include: { latestValidSnapshot: true, secret: true },
      });
      expect(source.connectorType).toBe('http-json');
      expect(source.latestValidSnapshot?.data).toEqual({ title: 'Persisted status' });
      expect(source.secret?.ciphertext).toBe('opaque-source-secret');
      expect(encrypt).toHaveBeenCalledTimes(1);
      expect(await prisma.customWidget.findUniqueOrThrow({ where: { id: widget.id } }))
        .toMatchObject({ dataSourceId: legacySource.id, sourceDefinitionId: source.sourceDefinitionId });

      const binding = await prisma.recipeBinding.findUniqueOrThrow({
        where: { legacyPluginInstanceId: instance.id }, include: { revision: true },
      });
      expect(binding.settings).toEqual({ label: 'Ready' });
      expect(JSON.stringify(binding)).not.toContain('ciphertext-that-must-not-migrate');
      expect(binding.revision.settingsSchema).toEqual([
        { key: 'label', label: 'Label', type: 'text', required: true },
      ]);
      expect(await prisma.recipeDefinition.count({ where: { legacyPluginId: plugin.id } })).toBe(1);
      expect(await prisma.recipeRevision.count({ where: { recipeDefinitionId: binding.recipeDefinitionId } })).toBe(1);
      expect(await prisma.playlistItem.findUniqueOrThrow({ where: { id: playlist.items[0].id } }))
        .toMatchObject({ pluginInstanceId: instance.id, recipeBindingId: binding.recipeBindingId });

      await prisma.plugin.update({ where: { id: plugin.id }, data: { markupFull: '<div>changed</div>' } });
      await bridge.migratePlugins();
      const advanced = await prisma.recipeBinding.findUniqueOrThrow({ where: { legacyPluginInstanceId: instance.id } });
      expect(advanced.recipeRevisionId).not.toBe(binding.recipeRevisionId);
      expect(await prisma.recipeRevision.count({ where: { recipeDefinitionId: binding.recipeDefinitionId } })).toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);
});
