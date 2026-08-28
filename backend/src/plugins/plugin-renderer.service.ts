import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { types } from 'node:util';
import type { JsonValue } from '@inker/contracts';
import { executeIsolated, IsolatedExecutionError } from '../isolation/isolated-executor';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';
import { TRMNL_CSS } from './sync/trmnl-css';

export type PluginLayout = 'full' | 'half_horizontal' | 'half_vertical' | 'quadrant';

/**
 * Plugin Renderer Service
 * Renders plugin Liquid templates into e-ink PNG images using the existing
 * Puppeteer-based rendering pipeline from ScreenRendererService.
 */
@Injectable()
export class PluginRendererService {
  constructor(readonly screenRenderer: ScreenRendererService) {}

  /**
   * Render a plugin's Liquid template with data to HTML string
   */
  async renderToHtml(
    markup: string,
    locals: Record<string, any>,
    _settings: Record<string, any> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    if (!locals || typeof locals !== 'object' || types.isProxy(locals) || Array.isArray(locals)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(locals)) || Object.getOwnPropertySymbols(locals).length) {
      throw new ServiceUnavailableException('SOURCE_SNAPSHOT_INVALID');
    }
    if (typeof markup !== 'string') throw new ServiceUnavailableException('PLUGIN_TEMPLATE_UNAVAILABLE');
    if (/\|\s*where_exp\b/.test(markup) || /\{%-?\s*(?:include|render|layout)\b/.test(markup)) {
      throw new ServiceUnavailableException('PLUGIN_ISOLATION_REQUIRED');
    }
    try {
      // Drop settings descriptors before reading any value or serializing IPC.
      // Keep other descriptors intact so the execution boundary rejects accessors.
      const descriptors = Object.getOwnPropertyDescriptors(locals);
      delete descriptors.settings;
      const data = Object.create(null, descriptors);
      data.settings = {};
      // Only descriptor-validated, normalized data enters the guest. Settings
      // never cross the boundary; the Liquid guest always supplies settings={}.
      const html = await executeIsolated({
        version: 1, kind: 'liquid', code: markup, data: data as JsonValue,
      }, signal);
      if (typeof html !== 'string') throw new ServiceUnavailableException('PLUGIN_TEMPLATE_UNAVAILABLE');
      return html;
    } catch (error) {
      if (error instanceof IsolatedExecutionError && error.code === 'ISOLATION_INVALID_INPUT') {
        throw new ServiceUnavailableException('SOURCE_SNAPSHOT_INVALID');
      }
      // Guest text, parser details and supplied values must not enter errors/logs.
      throw new ServiceUnavailableException('PLUGIN_TEMPLATE_UNAVAILABLE');
    }
  }

  /**
   * Render a plugin instance to a full HTML page (with CSS) ready for Puppeteer
   */
  buildFullPage(innerHtml: string, width: number, height: number): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { width: ${width}px; height: ${height}px; }
  ${TRMNL_CSS}
</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
  }

  /**
   * Render a plugin to a PNG buffer using the existing Puppeteer pipeline
   */
  async renderToPng(
    markup: string,
    locals: Record<string, any>,
    settings: Record<string, any> = {},
    width: number = 800,
    height: number = 480,
    mode: 'device' | 'preview' | 'einkPreview' = 'device',
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const innerHtml = await this.renderToHtml(markup, locals, settings, signal);
    if (signal?.aborted) throw new ServiceUnavailableException('PLUGIN_TEMPLATE_UNAVAILABLE');
    const fullPage = this.buildFullPage(innerHtml, width, height);

    // Render HTML to raw PNG via Puppeteer
    const rawPng = await this.screenRenderer.renderHtmlToPng(fullPage, width, height);

    // For preview mode, return without e-ink processing
    if (mode === 'preview') {
      return rawPng;
    }

    // Apply e-ink processing (dithering + optional inversion)
    const shouldNegate = mode === 'device';
    return this.screenRenderer.applyEinkProcessing(rawPng, width, height, shouldNegate);
  }

  /**
   * Screenshot an external URL with custom headers (e.g. Grafana panel with auth)
   */
  async renderUrlToPng(
    _url: string,
    _headers: Record<string, string>,
    _width: number = 800,
    _height: number = 480,
    _mode: 'device' | 'preview' | 'einkPreview' = 'device',
    _evaluateScript?: string,
  ): Promise<Buffer> {
    throw new ServiceUnavailableException('SOURCE_REFRESH_REQUIRES_CONNECTOR');
  }

  /**
   * Select the appropriate template based on layout size
   */
  selectMarkup(
    plugin: {
      markupFull?: string | null;
      markupHalfHorizontal?: string | null;
      markupHalfVertical?: string | null;
      markupQuadrant?: string | null;
    },
    layout: PluginLayout = 'full',
  ): string | null {
    switch (layout) {
      case 'full':
        return plugin.markupFull || null;
      case 'half_horizontal':
        return plugin.markupHalfHorizontal || plugin.markupFull || null;
      case 'half_vertical':
        return plugin.markupHalfVertical || plugin.markupFull || null;
      case 'quadrant':
        return plugin.markupQuadrant || plugin.markupFull || null;
      default:
        return plugin.markupFull || null;
    }
  }
}
