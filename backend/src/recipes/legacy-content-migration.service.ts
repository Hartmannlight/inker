import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isJsonValue } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/services/encryption.service';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
import { prepareRecipeManifest, type RecipeSetting } from './recipe-manifest';

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const manifestSnapshot = (manifest: ReturnType<typeof prepareRecipeManifest>): Prisma.InputJsonObject => {
  const { contentHash: _contentHash, ...snapshot } = manifest;
  return snapshot as unknown as Prisma.InputJsonObject;
};

function legacySettings(value: Prisma.JsonValue | null): RecipeSetting[] {
  if (!Array.isArray(value)) return [];
  const result: RecipeSetting[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.encrypted === true || typeof raw.key !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.key) || seen.has(raw.key)) continue;
    seen.add(raw.key);
    const type = raw.type === 'number' ? 'number' : raw.type === 'boolean' || raw.type === 'checkbox' ? 'boolean'
      : raw.type === 'select' ? 'select' : raw.type === 'timezone' ? 'timezone' : 'text';
    const options = type === 'select' && Array.isArray(raw.options) ? raw.options.flatMap(option => {
      if (typeof option === 'string') return [{ label: option, value: option }];
      if (option && typeof option === 'object' && !Array.isArray(option) && typeof option.value === 'string') {
        return [{ label: typeof option.label === 'string' ? option.label : option.value, value: option.value }];
      }
      return [];
    }).slice(0, 100) : undefined;
    const defaultValue = ['string', 'number', 'boolean'].includes(typeof raw.default) ? raw.default as string | number | boolean : undefined;
    result.push({ key: raw.key, label: typeof raw.label === 'string' && raw.label ? raw.label : raw.key,
      type, required: raw.required === true, ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(options?.length ? { options } : {}) });
  }
  return result;
}

/** Idempotent bridge. Legacy rows remain readable until a later, separately
 * verified removal migration; all productive reads can move to the new IDs now. */
@Injectable()
export class LegacyContentMigrationService implements OnModuleInit {
  private readonly logger = new Logger(LegacyContentMigrationService.name);
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async onModuleInit() {
    try {
      const sources = await this.migrateDataSources();
      const recipes = await this.migratePlugins();
      if (sources || recipes) this.logger.log(`Compatibility bridge synchronized ${sources} source(s) and ${recipes} recipe binding(s)`);
    } catch (error) {
      this.logger.error('Compatibility bridge failed; legacy rows remain untouched', error);
    }
  }

  async migrateDataSources(): Promise<number> {
    const rows = await this.prisma.dataSource.findMany({ include: { customWidgets: { select: { id: true } } } });
    let migrated = 0;
    for (const row of rows) {
      const sourceId = `legacy-data-source-${row.id}`;
      const secretId = `legacy-data-source-secret-${row.id}`;
      const headers = row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
        ? row.headers as Record<string, unknown> : {};
      try {
        await this.prisma.$transaction(async tx => {
          const existing = await tx.sourceDefinition.findFirst({ where: { OR: [
            { sourceDefinitionId: sourceId }, { legacyDataSourceId: row.id },
          ] } });
          if (!existing) {
            const hasHeaders = Object.keys(headers).length > 0;
            if (hasHeaders) await tx.sourceSecret.create({ data: {
              id: secretId, ciphertext: this.encryption.encrypt(JSON.stringify(headers)),
            } });
            await tx.sourceDefinition.create({ data: {
              sourceDefinitionId: sourceId, legacyDataSourceId: row.id, name: row.name,
              connectorType: row.type === 'rss' ? 'http-feed' : 'http-json', schemaVersion: '1',
              configuration: { url: row.url, format: row.type === 'rss' ? 'rss' : 'json',
                method: ['GET', 'POST'].includes(row.method.toUpperCase()) ? row.method.toUpperCase() : 'GET',
                ...(row.jsonPath ? { jsonPath: row.jsonPath } : {}), allowLocalNetwork: false },
              secretId: hasHeaders ? secretId : null,
              refreshIntervalSeconds: clamp(row.refreshInterval, 1, 86400), timeoutMs: 7500,
              concurrencyGroup: 'legacy-http', enabled: row.isActive, nextRefreshAt: new Date(),
            } });
          }
          const source = existing ?? await tx.sourceDefinition.findUniqueOrThrow({ where: { sourceDefinitionId: sourceId } });
          if (row.lastData !== null && isJsonValue(row.lastData) && source.latestValidSnapshotId === null) {
            const snapshotId = `${source.sourceDefinitionId}-snapshot-1`;
            const createdAt = row.lastFetchedAt ?? row.updatedAt;
            await tx.sourceSnapshot.create({ data: {
              snapshotId, sourceDefinitionId: source.sourceDefinitionId, definitionVersion: source.definitionVersion,
              revision: 1, protocolVersion: '1.0', schemaVersion: '1', connectorVersion: 'legacy-cache-v1',
              createdAt, sourceTimestamp: row.lastFetchedAt, validDataCreatedAt: createdAt,
              freshnessState: 'fresh', staleAfterSeconds: clamp(row.refreshInterval, 1, 86400),
              data: row.lastData as Prisma.InputJsonValue, contentHash: sha256(canonicalJson(row.lastData)),
              refreshEventId: `${source.sourceDefinitionId}-migration`, attempt: 1,
            } });
            await tx.sourceDefinition.update({ where: { sourceDefinitionId: source.sourceDefinitionId }, data: {
              snapshotRevision: 1, latestSnapshotId: snapshotId, latestValidSnapshotId: snapshotId,
              lastAttemptAt: createdAt, lastSuccessAt: createdAt,
            } });
          }
          await tx.customWidget.updateMany({ where: { dataSourceId: row.id, sourceDefinitionId: null },
            data: { sourceDefinitionId: source.sourceDefinitionId } });
        });
        migrated++;
      } catch (error) {
        this.logger.warn(`Skipped legacy data source ${row.id}: ${error instanceof Error ? error.message : 'migration failed'}`);
      }
    }
    return migrated;
  }

  async migratePlugins(): Promise<number> {
    const plugins = await this.prisma.plugin.findMany({ include: { instances: true } });
    let bindings = 0;
    for (const plugin of plugins) {
      if (!plugin.markupFull) continue;
      try {
        const existingDefinition = await this.prisma.recipeDefinition.findUnique({ where: { legacyPluginId: plugin.id }, include: { activeRevision: true } });
        const sourceTypes = await this.prisma.sourceDefinition.findMany({
          where: { legacyPluginInstanceId: { in: plugin.instances.map(instance => instance.id) } },
          select: { legacyPluginInstanceId: true, connectorType: true },
        });
        const requiredConnectorType = plugin.dataStrategy === 'static' ? null
          : sourceTypes[0]?.connectorType ?? (plugin.dataUrl ? 'http-json' : null);
        const manifest = prepareRecipeManifest({
          protocolVersion: '1.0', slug: plugin.slug, name: plugin.name, description: plugin.description,
          source: plugin.source, sourceUrl: plugin.sourceUrl, license: null,
          layouts: { full: plugin.markupFull, halfHorizontal: plugin.markupHalfHorizontal,
            halfVertical: plugin.markupHalfVertical, quadrant: plugin.markupQuadrant }, partials: {},
          settingsSchema: legacySettings(plugin.settingsSchema), requiredConnectorType,
        });
        const recipe = await this.prisma.$transaction(async tx => {
          let definition = existingDefinition ?? await tx.recipeDefinition.create({ data: {
            recipeDefinitionId: `legacy-plugin-${plugin.id}`, legacyPluginId: plugin.id, slug: plugin.slug,
            name: plugin.name, description: plugin.description, source: plugin.source, sourceUrl: plugin.sourceUrl,
          }, include: { activeRevision: true } });
          let revision = definition.activeRevision;
          if (!revision || revision.contentHash !== manifest.contentHash) {
            const latest = await tx.recipeRevision.findFirst({ where: { recipeDefinitionId: definition.recipeDefinitionId }, orderBy: { revision: 'desc' } });
            revision = await tx.recipeRevision.create({ data: {
              recipeRevisionId: `legacy-plugin-${plugin.id}-r${(latest?.revision ?? 0) + 1}`,
              recipeDefinitionId: definition.recipeDefinitionId, revision: (latest?.revision ?? 0) + 1,
              contentHash: manifest.contentHash, manifest: manifestSnapshot(manifest),
              layouts: manifest.layouts as unknown as Prisma.InputJsonObject,
              partials: {}, settingsSchema: manifest.settingsSchema as unknown as Prisma.InputJsonArray,
              requiredConnectorType: manifest.requiredConnectorType,
            } });
            definition = await tx.recipeDefinition.update({ where: { recipeDefinitionId: definition.recipeDefinitionId },
              data: { activeRevisionId: revision.recipeRevisionId, name: plugin.name, description: plugin.description,
                source: plugin.source, sourceUrl: plugin.sourceUrl }, include: { activeRevision: true } });
          }
          return { definition, revision: revision! };
        });
        for (const instance of plugin.instances) {
          const source = sourceTypes.find(candidate => candidate.legacyPluginInstanceId === instance.id);
          const sourceDefinition = source ? await this.prisma.sourceDefinition.findUnique({ where: { legacyPluginInstanceId: instance.id } }) : null;
          const bindingId = `legacy-plugin-instance-${instance.id}`;
          const bindingData = {
            recipeDefinitionId: recipe.definition.recipeDefinitionId,
            recipeRevisionId: recipe.revision.recipeRevisionId,
            sourceDefinitionId: sourceDefinition?.sourceDefinitionId,
            name: instance.name,
            settings: instance.settings as Prisma.InputJsonValue,
          };
          await this.prisma.recipeBinding.upsert({ where: { legacyPluginInstanceId: instance.id }, update: bindingData, create: {
            recipeBindingId: bindingId, legacyPluginInstanceId: instance.id,
            ...bindingData,
          } });
          await this.prisma.playlistItem.updateMany({ where: { pluginInstanceId: instance.id, recipeBindingId: null },
            data: { recipeBindingId: bindingId } });
          bindings++;
        }
      } catch (error) {
        this.logger.warn(`Skipped legacy plugin ${plugin.id}: ${error instanceof Error ? error.message : 'migration failed'}`);
      }
    }
    return bindings;
  }
}
