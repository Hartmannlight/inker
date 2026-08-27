import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { type Plugin, type PluginInstance } from '@prisma/client';
import { isJsonValue, type JsonObject } from '@inker/contracts';
import { redactLogValue, redactSecretText } from '../config/secret-redaction';
import { PrismaService } from '../prisma/prisma.service';
import { PluginRendererService, PluginLayout } from './plugin-renderer.service';
import { EncryptionService } from '../common/services/encryption.service';
import { OAuthService } from './oauth/oauth.service';
import {
  CreatePluginDto,
  UpdatePluginDto,
  CreatePluginInstanceDto,
  UpdatePluginInstanceDto,
} from './dto/create-plugin.dto';

const SETTINGS_MASK = '••••••••';
type StoredPlugin = Plugin & { instances?: StoredInstance[]; _count?: { instances: number } };
type StoredInstance = PluginInstance & { plugin?: Plugin };

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pluginRenderer: PluginRendererService,
    private readonly encryption: EncryptionService,
    private readonly oauthService: OAuthService,
  ) {}

  // ========================
  // Plugin CRUD
  // ========================

  async findAllPlugins() {
    const plugins = await this.prisma.plugin.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { instances: true } },
        instances: { orderBy: { id: 'asc' } },
      },
    });
    return plugins.map((plugin) => this.publicPlugin(plugin));
  }

  async findPluginById(id: number) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { id },
      include: { instances: true },
    });
    if (!plugin) throw new NotFoundException(`Plugin ${id} not found`);
    return this.publicPlugin(plugin);
  }

  async findPluginBySlug(slug: string) {
    return this.prisma.plugin.findUnique({ where: { slug } });
  }

  async createPlugin(dto: CreatePluginDto) {
    return this.publicPlugin(await this.prisma.plugin.create({ data: dto }));
  }

  async updatePlugin(id: number, dto: UpdatePluginDto) {
    return this.publicPlugin(await this.prisma.plugin.update({ where: { id }, data: dto }));
  }

  async deletePlugin(id: number) {
    return this.prisma.plugin.delete({ where: { id } });
  }

  // ========================
  // Install / Uninstall
  // ========================

  async installPlugin(id: number) {
    return this.prisma.plugin.update({
      where: { id },
      data: { isInstalled: true },
    });
  }

  async uninstallPlugin(id: number) {
    return this.prisma.plugin.update({
      where: { id },
      data: { isInstalled: false },
    });
  }

  // ========================
  // Plugin Instances
  // ========================

  async findAllInstances() {
    const instances = await this.prisma.pluginInstance.findMany({
      include: { plugin: true },
      orderBy: { createdAt: 'desc' },
    });
    return instances.map((i) => this.maskEncryptedSettings(i));
  }

  async findInstanceById(id: number) {
    const instance = await this.prisma.pluginInstance.findUnique({
      where: { id },
      include: { plugin: true },
    });
    if (!instance) throw new NotFoundException(`Plugin instance ${id} not found`);
    return instance;
  }

  async createInstance(dto: CreatePluginInstanceDto) {
    const plugin = await this.findPluginById(dto.pluginId);
    const { plain, encrypted } = this.separateEncryptedFields(
      dto.settings || {},
      (plugin.settingsSchema as any[]) || [],
    );

    return this.maskEncryptedSettings(await this.prisma.pluginInstance.create({
      data: {
        pluginId: dto.pluginId,
        name: dto.name,
        settings: plain,
        settingsEncrypted: encrypted,
      },
      include: { plugin: true },
    }));
  }

  async updateInstance(id: number, dto: UpdatePluginInstanceDto) {
    const instance = await this.prisma.pluginInstance.findUnique({
      where: { id },
      include: { plugin: true },
    });
    if (!instance) throw new NotFoundException(`Plugin instance ${id} not found`);

    if (dto.settings) {
      const existingEncrypted = (instance.settingsEncrypted || {}) as Record<string, string>;
      const schema = (instance.plugin.settingsSchema as any[]) || [];
      const encryptedKeys = new Set(schema.filter(f => f.encrypted).map(f => f.key));

      for (const key of encryptedKeys) {
        if (dto.settings[key] === SETTINGS_MASK && existingEncrypted[key]) {
          delete dto.settings[key];
        }
      }

      const { plain, encrypted } = this.separateEncryptedFields(dto.settings, schema);

      return this.maskEncryptedSettings(await this.prisma.pluginInstance.update({
        where: { id },
        data: {
          name: dto.name,
          settings: plain,
          settingsEncrypted: { ...existingEncrypted, ...encrypted },
        },
        include: { plugin: true },
      }));
    }

    return this.maskEncryptedSettings(await this.prisma.pluginInstance.update({
      where: { id },
      data: { name: dto.name },
      include: { plugin: true },
    }));
  }

  async findInstanceByIdMasked(id: number) {
    const instance = await this.findInstanceById(id);
    return this.maskEncryptedSettings(instance);
  }

  private separateEncryptedFields(
    settings: Record<string, any>,
    schema: any[],
  ): { plain: Record<string, any>; encrypted: Record<string, string> } {
    const encryptedKeys = new Set(schema.filter(f => f.encrypted).map(f => f.key));
    const plain: Record<string, any> = {};
    const toEncrypt: Record<string, any> = {};

    for (const [key, value] of Object.entries(settings)) {
      if (encryptedKeys.has(key) && value !== undefined && value !== null && value !== '') {
        toEncrypt[key] = value;
      } else {
        plain[key] = value;
      }
    }

    const encrypted = Object.keys(toEncrypt).length > 0
      ? this.encryption.encryptObject(toEncrypt)
      : {};

    return { plain, encrypted };
  }

  private maskEncryptedSettings(instance: StoredInstance, schema = instance.plugin?.settingsSchema) {
    const encrypted = (instance.settingsEncrypted || {}) as Record<string, string>;
    const maskedSettings = { ...(redactLogValue(instance.settings) as JsonObject) };
    if (Array.isArray(schema)) {
      for (const field of schema) {
        if (field && typeof field === 'object' && !Array.isArray(field) &&
            field.encrypted === true && typeof field.key === 'string' && field.key in maskedSettings) {
          maskedSettings[field.key] = SETTINGS_MASK;
        }
      }
    }
    for (const key of Object.keys(encrypted)) {
      maskedSettings[key] = SETTINGS_MASK;
    }

    return {
      id: instance.id,
      pluginId: instance.pluginId,
      name: instance.name,
      settings: maskedSettings,
      oauthConnected: Boolean(instance.oauthToken || instance.oauthRefreshToken),
      oauthExpiresAt: instance.oauthExpiresAt,
      lastData: redactLogValue(instance.lastData),
      lastFetchedAt: instance.lastFetchedAt,
      lastError: instance.lastError ? 'LEGACY_SOURCE_ERROR' : null,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      ...(instance.plugin ? { plugin: this.publicPlugin(instance.plugin) } : {}),
    };
  }

  private publicPlugin(plugin: StoredPlugin) {
    return {
      id: plugin.id, name: plugin.name, slug: plugin.slug,
      description: plugin.description, icon: plugin.icon, category: plugin.category,
      dataStrategy: plugin.dataStrategy, dataUrl: plugin.dataUrl ? redactSecretText(plugin.dataUrl) : null,
      dataMethod: plugin.dataMethod, dataHeaders: redactLogValue(plugin.dataHeaders),
      dataPath: plugin.dataPath, dataTransform: plugin.dataTransform,
      refreshInterval: plugin.refreshInterval,
      markupFull: plugin.markupFull, markupHalfHorizontal: plugin.markupHalfHorizontal,
      markupHalfVertical: plugin.markupHalfVertical, markupQuadrant: plugin.markupQuadrant,
      settingsSchema: plugin.settingsSchema, oauthProvider: plugin.oauthProvider,
      oauthScopes: plugin.oauthScopes, isInstalled: plugin.isInstalled,
      isBuiltin: plugin.isBuiltin, source: plugin.source, sourceUrl: plugin.sourceUrl,
      sourceHash: plugin.sourceHash, version: plugin.version,
      createdAt: plugin.createdAt, updatedAt: plugin.updatedAt,
      ...(plugin._count ? { _count: plugin._count } : {}),
      ...(plugin.instances ? { instances: plugin.instances.map((instance) => this.maskEncryptedSettings(instance, plugin.settingsSchema)) } : {}),
    };
  }

  async deleteInstance(id: number) {
    return this.prisma.pluginInstance.delete({ where: { id } });
  }

  /** Read the last persisted result, including stale data, without provider I/O. */
  async fetchData(instanceId: number): Promise<JsonObject> {
    const instance = await this.findInstanceById(instanceId);
    return this.persistedData(instance);
  }

  private persistedData(instance: { lastFetchedAt: Date | null; lastData: unknown }): JsonObject {
    if (!instance.lastFetchedAt || !isJsonValue(instance.lastData) ||
        !instance.lastData || typeof instance.lastData !== 'object' || Array.isArray(instance.lastData)) {
      throw new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE');
    }
    return redactLogValue(instance.lastData) as JsonObject;
  }

  /** Legacy definitions cannot trigger unregistered provider code in the API. */
  async fetchDataForPlugin(pluginId: number, _settings: Record<string, unknown> = {}): Promise<JsonObject> {
    const plugin = await this.findPluginById(pluginId);
    throw new ServiceUnavailableException(plugin.dataTransform
      ? 'PLUGIN_ISOLATION_REQUIRED' : 'SOURCE_REFRESH_REQUIRES_CONNECTOR');
  }

  // ========================
  // Rendering
  // ========================

  /**
   * Preview a plugin using an existing persisted instance result.
   */
  async previewPlugin(
    plugin: any,
    layout: PluginLayout = 'full',
  ): Promise<Buffer> {
    const { width, height } = this.getDimensionsForLayout(layout);

    const instance = (plugin.instances || []).find((candidate: StoredInstance) =>
      candidate.lastFetchedAt && candidate.lastData && typeof candidate.lastData === 'object');
    if (!instance) throw new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE');
    const markup = this.pluginRenderer.selectMarkup(plugin, layout);
    if (!markup) throw new ServiceUnavailableException('PLUGIN_TEMPLATE_UNAVAILABLE');
    return this.pluginRenderer.renderToPng(markup, this.persistedData(instance), {}, width, height, 'preview');
  }

  /**
   * Preview raw Liquid markup with explicitly provided data (no provider or mock fallback).
   */
  async previewMarkup(markup: string, data: Record<string, any> = {}): Promise<Buffer> {
    return this.pluginRenderer.renderToPng(markup, data, {}, 800, 480, 'preview');
  }

  /**
   * Render a plugin instance to PNG for device display.
   */
  async renderInstance(
    instanceId: number,
    layout: PluginLayout = 'full',
    mode: 'device' | 'preview' | 'einkPreview' = 'device',
  ): Promise<Buffer> {
    const instance = await this.findInstanceById(instanceId);
    const plugin = instance.plugin;
    const { width, height } = this.getDimensionsForLayout(layout);
    const locals = this.persistedData(instance);

    // Liquid rendering (for custom plugins with markup in DB)
    const markup = this.pluginRenderer.selectMarkup(plugin, layout);
    if (!markup) {
      throw new NotFoundException(`Plugin ${plugin.slug} has no template for layout ${layout}`);
    }

    return this.pluginRenderer.renderToPng(markup, locals, {}, width, height, mode);
  }

  // ========================
  // Webhooks
  // ========================

  async handleWebhook(slug: string, _data: Record<string, any>): Promise<{ updated: number }> {
    const plugin = await this.findPluginBySlug(slug);
    if (!plugin) throw new NotFoundException(`Plugin "${slug}" not found`);

    throw new ServiceUnavailableException('SOURCE_REFRESH_REQUIRES_CONNECTOR');
  }

  // ========================
  // Helpers
  // ========================

  private getDimensionsForLayout(layout: PluginLayout): { width: number; height: number } {
    switch (layout) {
      case 'full': return { width: 800, height: 480 };
      case 'half_horizontal': return { width: 800, height: 240 };
      case 'half_vertical': return { width: 400, height: 480 };
      case 'quadrant': return { width: 400, height: 240 };
      default: return { width: 800, height: 480 };
    }
  }

  // ========================
  // Diagnostics
  // ========================

  async diagnosePlugins(): Promise<any[]> {
    const plugins = await this.prisma.plugin.findMany({
      orderBy: { name: 'asc' },
    });

    return plugins.map(plugin => {
      const schema = (plugin.settingsSchema as any[]) || [];
      const hasEncrypted = schema.some(f => f.encrypted);
      const hasRequired = schema.some(f => f.required);
      const configRequirement = (plugin as any).oauthProvider
        ? 'oauth'
        : (hasEncrypted || hasRequired) ? 'api_key' : 'none';
      const hasMarkup = !!(plugin.markupFull || (plugin as any).dataUrl);

      return {
        slug: plugin.slug,
        name: plugin.name,
        id: plugin.id,
        status: hasMarkup ? (configRequirement !== 'none' ? 'needs_config' : 'ready') : 'no_template',
        configRequirement,
        settingsCount: schema.length,
      };
    });
  }

  // ========================
  // Widget Templates Integration
  // ========================

  async getAsWidgetTemplates(): Promise<any[]> {
    const plugins = await this.prisma.plugin.findMany({
      where: { isInstalled: true },
    });

    return plugins.map((plugin) => ({
      id: 20000 + plugin.id,
      name: plugin.name,
      description: plugin.description || '',
      category: 'Plugins',
      icon: plugin.icon || 'puzzle',
      config: {
        type: 'plugin',
        pluginId: plugin.id,
        pluginSlug: plugin.slug,
      },
    }));
  }

  // ========================
  // Grafana helpers
  // ========================

  async getGrafanaConnectionById(instanceId: number): Promise<never> {
    await this.findInstanceById(instanceId);
    throw new ServiceUnavailableException('SOURCE_REFRESH_REQUIRES_CONNECTOR');
  }

  // ========================
  // Builtin Plugins
  // ========================

  async seedBuiltinPlugins(): Promise<void> {
    const builtins = [this.grafanaPluginDefinition()];
    for (const def of builtins) {
      await this.prisma.plugin.upsert({
        where: { slug: def.slug },
        create: def,
        update: {},
      });
    }
    this.logger.log(`Seeded ${builtins.length} builtin plugin(s)`);
  }

  private grafanaPluginDefinition() {
    return {
      name: 'Grafana Panel',
      slug: 'grafana_panel',
      description: 'Display a Grafana dashboard panel on your e-ink screen. Requires the Grafana Image Renderer plugin.',
      icon: 'grafana',
      category: 'monitoring',
      source: 'inker',
      isBuiltin: true,
      dataStrategy: 'polling',
      refreshInterval: 300,
      version: '1.0.0',

      settingsSchema: [
        {
          key: 'grafana_url',
          label: 'Grafana URL',
          type: 'text',
          required: true,
          description: 'Base URL of your Grafana instance (e.g. http://localhost:3000)',
        },
        {
          key: 'api_key',
          label: 'API Key / Service Account Token',
          type: 'password',
          required: true,
          encrypted: true,
          description: 'Grafana API key or service account token with Viewer role',
        },
        {
          key: 'dashboard_uid',
          label: 'Dashboard UID',
          type: 'text',
          required: false,
          description: 'Found in the dashboard URL: /d/<uid>/...',
        },
        {
          key: 'panel_id',
          label: 'Panel ID',
          type: 'number',
          required: false,
          description: 'Found in panel URL parameter: viewPanel=<id>',
        },
        {
          key: 'time_range',
          label: 'Time Range',
          type: 'select',
          default: 'now-6h',
          options: [
            { label: 'Last 1 hour', value: 'now-1h' },
            { label: 'Last 6 hours', value: 'now-6h' },
            { label: 'Last 12 hours', value: 'now-12h' },
            { label: 'Last 24 hours', value: 'now-24h' },
            { label: 'Last 7 days', value: 'now-7d' },
            { label: 'Last 30 days', value: 'now-30d' },
          ],
        },
      ],

      dataTransform: [
        '// Rendering is handled by Puppeteer screenshot of Grafana panel URL',
        'return { dashboard_uid: settings.dashboard_uid, panel_id: settings.panel_id };',
      ].join('\n'),

      markupFull: [
        '<div class="view view--full">',
        '  <div class="layout" style="padding:0; justify-content:center; align-items:center;">',
        '    {% if image_base64 %}',
        '      <img src="{{ image_base64 }}" style="width:800px; height:452px; object-fit:contain;" />',
        '    {% else %}',
        '      <div style="text-align:center; padding:32px;">',
        '        <div class="title" style="font-size:24px;">Grafana Panel</div>',
        '        <div class="label" style="margin-top:8px;">Configure your Grafana connection in plugin settings</div>',
        '      </div>',
        '    {% endif %}',
        '  </div>',
        '  <div class="title_bar">',
        '    <span class="title">Grafana</span>',
        '    <span class="instance">{{ dashboard_uid }} / panel {{ panel_id }}</span>',
        '  </div>',
        '</div>',
      ].join('\n'),
    };
  }

  // ========================
  // Cleanup
  // ========================

  async cleanupStalePlugins(): Promise<void> {
    // Legacy definitions and instance configuration are retained. Disabling an
    // unsafe execution path must never delete the user's stored configuration.
  }
}
