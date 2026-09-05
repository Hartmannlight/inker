import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type RecipeRevision } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PluginRendererService, type PluginLayout } from '../plugins/plugin-renderer.service';
import { canonicalJson } from '../common/utils/content-hash.util';
import { prepareRecipeManifest, validateRecipeSettings, type PreparedRecipeManifest, type RecipeLayouts } from './recipe-manifest';

const layoutNames: Record<PluginLayout, keyof RecipeLayouts> = {
  full: 'full', half_horizontal: 'halfHorizontal', half_vertical: 'halfVertical', quadrant: 'quadrant',
};
const dimensions: Record<PluginLayout, { width: number; height: number }> = {
  full: { width: 800, height: 480 }, half_horizontal: { width: 800, height: 240 },
  half_vertical: { width: 400, height: 480 }, quadrant: { width: 400, height: 240 },
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('RECIPE_COMMAND_INVALID');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function manifestSnapshot(manifest: PreparedRecipeManifest): Prisma.InputJsonObject {
  const { contentHash: _contentHash, ...snapshot } = manifest;
  return snapshot as unknown as Prisma.InputJsonObject;
}

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService, private readonly renderer: PluginRendererService) {}

  async list() {
    const items = await this.prisma.recipeDefinition.findMany({
      include: { activeRevision: true, _count: { select: { bindings: true, revisions: true } } },
      orderBy: [{ name: 'asc' }, { recipeDefinitionId: 'asc' }],
    });
    return { items, total: items.length };
  }

  async read(id: string) {
    const recipe = await this.prisma.recipeDefinition.findUnique({
      where: { recipeDefinitionId: id }, include: { activeRevision: true, revisions: { orderBy: { revision: 'desc' } }, bindings: true },
    });
    if (!recipe) throw new NotFoundException('RECIPE_NOT_FOUND');
    return recipe;
  }

  async create(value: unknown) {
    const manifest = prepareRecipeManifest(value);
    if (await this.prisma.recipeDefinition.findUnique({ where: { slug: manifest.slug } })) throw new ConflictException('RECIPE_SLUG_CONFLICT');
    return this.prisma.$transaction(tx => this.createDefinition(tx, manifest));
  }

  async appendRevision(id: string, value: unknown) {
    const input = object(value);
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || !input.manifest) {
      throw new BadRequestException('RECIPE_COMMAND_INVALID');
    }
    const manifest = prepareRecipeManifest(input.manifest);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE recipe_definitions SET updated_at = updated_at WHERE recipe_definition_id = ${id}`;
      const definition = await tx.recipeDefinition.findUnique({ where: { recipeDefinitionId: id }, include: { activeRevision: true } });
      if (!definition) throw new NotFoundException('RECIPE_NOT_FOUND');
      if (definition.legacyPluginId !== null) throw new ConflictException('LEGACY_RECIPE_READ_ONLY');
      if (definition.activeRevision?.revision !== input.expectedRevision || manifest.slug !== definition.slug) {
        throw new ConflictException('RECIPE_REVISION_CONFLICT');
      }
      const existing = await tx.recipeRevision.findFirst({ where: { recipeDefinitionId: id, contentHash: manifest.contentHash } });
      if (existing) return { definition, revision: existing, replay: true };
      const revision = await this.createRevision(tx, id, Number(input.expectedRevision) + 1, manifest);
      const updated = await tx.recipeDefinition.update({ where: { recipeDefinitionId: id }, data: {
        name: manifest.name, description: manifest.description, source: manifest.source, sourceUrl: manifest.sourceUrl,
        license: manifest.license, activeRevisionId: revision.recipeRevisionId,
      } });
      return { definition: updated, revision, replay: false };
    });
  }

  async createBinding(definitionId: string, value: unknown) {
    const input = object(value);
    if (Object.keys(input).some(key => !['recipeRevisionId', 'sourceDefinitionId', 'name', 'settings'].includes(key))
      || input.recipeRevisionId !== undefined && !identifier(input.recipeRevisionId)
      || input.sourceDefinitionId !== undefined && input.sourceDefinitionId !== null && !identifier(input.sourceDefinitionId)
      || input.name !== undefined && input.name !== null && (typeof input.name !== 'string' || input.name.length > 120)) {
      throw new BadRequestException('RECIPE_COMMAND_INVALID');
    }
    return this.prisma.$transaction(async tx => {
      const definition = await tx.recipeDefinition.findUnique({ where: { recipeDefinitionId: definitionId }, include: { activeRevision: true } });
      if (!definition?.activeRevision) throw new NotFoundException('RECIPE_NOT_FOUND');
      const revisionId = input.recipeRevisionId ? String(input.recipeRevisionId) : definition.activeRevision.recipeRevisionId;
      const revision = revisionId === definition.activeRevision.recipeRevisionId ? definition.activeRevision
        : await tx.recipeRevision.findFirst({ where: { recipeRevisionId: revisionId, recipeDefinitionId: definitionId } });
      if (!revision) throw new NotFoundException('RECIPE_REVISION_NOT_FOUND');
      const sourceId = input.sourceDefinitionId === null || input.sourceDefinitionId === undefined ? null : String(input.sourceDefinitionId);
      await this.requireCompatibleSource(tx, revision, sourceId);
      const settings = validateRecipeSettings(revision.settingsSchema, input.settings);
      return tx.recipeBinding.create({ data: {
        recipeDefinitionId: definitionId, recipeRevisionId: revisionId, sourceDefinitionId: sourceId,
        name: input.name ? String(input.name).trim() : null, settings,
      }, include: { definition: true, revision: true, sourceDefinition: true } });
    });
  }

  async updateBinding(id: string, value: unknown) {
    const input = object(value);
    if (Object.keys(input).some(key => !['recipeRevisionId', 'sourceDefinitionId', 'name', 'settings', 'expectedUpdatedAt'].includes(key))
      || !identifier(input.recipeRevisionId) || input.sourceDefinitionId !== null && !identifier(input.sourceDefinitionId)
      || typeof input.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedUpdatedAt))) {
      throw new BadRequestException('RECIPE_COMMAND_INVALID');
    }
    return this.prisma.$transaction(async tx => {
      const binding = await tx.recipeBinding.findUnique({ where: { recipeBindingId: id } });
      if (!binding) throw new NotFoundException('RECIPE_BINDING_NOT_FOUND');
      if (binding.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ConflictException('RECIPE_BINDING_CONFLICT');
      if (binding.legacyPluginInstanceId !== null) throw new ConflictException('LEGACY_RECIPE_BINDING_READ_ONLY');
      const revision = await tx.recipeRevision.findFirst({ where: {
        recipeRevisionId: String(input.recipeRevisionId), recipeDefinitionId: binding.recipeDefinitionId,
      } });
      if (!revision) throw new NotFoundException('RECIPE_REVISION_NOT_FOUND');
      const sourceId = input.sourceDefinitionId === null ? null : String(input.sourceDefinitionId);
      await this.requireCompatibleSource(tx, revision, sourceId);
      return tx.recipeBinding.update({ where: { recipeBindingId: id }, data: {
        recipeRevisionId: revision.recipeRevisionId, sourceDefinitionId: sourceId,
        name: typeof input.name === 'string' ? input.name.trim().slice(0, 120) : null,
        settings: validateRecipeSettings(revision.settingsSchema, input.settings),
      }, include: { definition: true, revision: true, sourceDefinition: true } });
    });
  }

  async readBinding(id: string) {
    const binding = await this.prisma.recipeBinding.findUnique({ where: { recipeBindingId: id }, include: {
      definition: true, revision: true, sourceDefinition: { include: { latestValidSnapshot: true } },
    } });
    if (!binding) throw new NotFoundException('RECIPE_BINDING_NOT_FOUND');
    return binding;
  }

  async renderBinding(id: string, layout: PluginLayout = 'full', mode: 'device' | 'preview' | 'einkPreview' = 'device') {
    const binding = await this.readBinding(id);
    if (binding.revision.recipeDefinitionId !== binding.recipeDefinitionId) throw new ServiceUnavailableException('RECIPE_BINDING_INVALID');
    let storedManifest: PreparedRecipeManifest;
    try {
      storedManifest = prepareRecipeManifest(binding.revision.manifest);
    } catch {
      throw new ServiceUnavailableException('RECIPE_REVISION_INVALID');
    }
    if (storedManifest.contentHash !== binding.revision.contentHash
      || storedManifest.requiredConnectorType !== binding.revision.requiredConnectorType
      || canonicalJson(storedManifest.layouts) !== canonicalJson(binding.revision.layouts)
      || canonicalJson(storedManifest.settingsSchema) !== canonicalJson(binding.revision.settingsSchema)) {
      throw new ServiceUnavailableException('RECIPE_REVISION_INVALID');
    }
    const layouts = storedManifest.layouts;
    const markup = layouts[layoutNames[layout]] || layouts.full;
    if (typeof markup !== 'string' || !markup) throw new ServiceUnavailableException('RECIPE_TEMPLATE_UNAVAILABLE');
    const source = binding.sourceDefinition;
    if (binding.revision.requiredConnectorType && (!source || source.connectorType !== binding.revision.requiredConnectorType)) {
      throw new ServiceUnavailableException('RECIPE_SOURCE_UNAVAILABLE');
    }
    const data = source?.latestValidSnapshot?.data;
    if (source && data === undefined) throw new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE');
    const locals: Record<string, unknown> = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) } : data === undefined ? {} : { data };
    locals.trmnl = { plugin_settings: binding.settings };
    const size = dimensions[layout];
    return this.renderer.renderToPng(markup, locals, {}, size.width, size.height, mode);
  }

  async snapshotBinding(id: string, expectedUpdatedAt: string) {
    const binding = await this.readBinding(id);
    if (binding.updatedAt.toISOString() !== expectedUpdatedAt) throw new ConflictException('RECIPE_BINDING_CONFLICT');
    const bytes = await this.renderBinding(id, 'full', 'preview');
    const snapshot = binding.sourceDefinition?.latestValidSnapshot;
    return {
      bytes, width: 800, height: 480, bindingUpdatedAt: binding.updatedAt.toISOString(),
      recipeRevisionId: binding.recipeRevisionId,
      ...(snapshot ? { sourceSnapshot: {
        sourceId: snapshot.sourceDefinitionId, snapshotId: snapshot.snapshotId, revision: snapshot.revision,
        contentHash: snapshot.contentHash, connectorVersion: snapshot.connectorVersion,
      } } : {}),
    };
  }

  private async requireCompatibleSource(tx: Prisma.TransactionClient, revision: RecipeRevision, sourceId: string | null) {
    if (!sourceId) {
      if (revision.requiredConnectorType) throw new BadRequestException('RECIPE_SOURCE_REQUIRED');
      return;
    }
    const source = await tx.sourceDefinition.findUnique({ where: { sourceDefinitionId: sourceId } });
    if (!source) throw new NotFoundException('SOURCE_NOT_FOUND');
    if (revision.requiredConnectorType && revision.requiredConnectorType !== source.connectorType) {
      throw new BadRequestException('RECIPE_SOURCE_INCOMPATIBLE');
    }
  }

  private async createDefinition(tx: Prisma.TransactionClient, manifest: PreparedRecipeManifest) {
    const definition = await tx.recipeDefinition.create({ data: {
      slug: manifest.slug, name: manifest.name, description: manifest.description, source: manifest.source,
      sourceUrl: manifest.sourceUrl, license: manifest.license,
    } });
    const revision = await this.createRevision(tx, definition.recipeDefinitionId, 1, manifest);
    const updated = await tx.recipeDefinition.update({ where: { recipeDefinitionId: definition.recipeDefinitionId },
      data: { activeRevisionId: revision.recipeRevisionId } });
    return { definition: updated, revision };
  }

  private createRevision(tx: Prisma.TransactionClient, definitionId: string, revision: number, manifest: PreparedRecipeManifest) {
    return tx.recipeRevision.create({ data: {
      recipeDefinitionId: definitionId, revision, manifestVersion: 1, contentHash: manifest.contentHash,
      manifest: manifestSnapshot(manifest), layouts: manifest.layouts as unknown as Prisma.InputJsonObject, partials: manifest.partials,
      settingsSchema: manifest.settingsSchema as unknown as Prisma.InputJsonArray,
      requiredConnectorType: manifest.requiredConnectorType,
    } });
  }
}
