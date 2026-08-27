import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Liquid } from 'liquidjs';
import { isJsonValue } from '@inker/contracts';
import { redactLogValue } from '../config/secret-redaction';
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
  private readonly liquid: Liquid;

  constructor(
    readonly screenRenderer: ScreenRendererService,
  ) {
    this.liquid = new Liquid({
      strictVariables: false,
      strictFilters: false,
      ownPropertyOnly: true,
    });
    this.registerTrmnlFilters();
  }

  /**
   * Register TRMNL-compatible Liquid filters (ported from trmnl-liquid gem)
   */
  private registerTrmnlFilters() {
    // number_with_delimiter: {{ 1234567 | number_with_delimiter }} → "1,234,567"
    this.liquid.registerFilter('number_with_delimiter', (value: any, delimiter = ',', separator = '.') => {
      if (value == null) return '';
      const parts = String(value).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
      return parts.join(separator);
    });

    // number_to_currency: {{ 10420 | number_to_currency: "£" }} → "£10,420.00"
    this.liquid.registerFilter('number_to_currency', (value: any, unit = '$', delimiter = ',', separator = '.', precision = 2) => {
      if (value == null) return '';
      const num = Number(value);
      if (isNaN(num)) return String(value);
      const fixed = num.toFixed(precision);
      const parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
      return `${unit}${parts.join(separator)}`;
    });

    // days_ago: {{ 3 | days_ago }} → "2026-03-23"
    this.liquid.registerFilter('days_ago', (value: any, _timezone = 'UTC') => {
      const days = Number(value) || 0;
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().split('T')[0];
    });

    // pluralize: {{ "book" | pluralize: 2 }} → "2 books"
    this.liquid.registerFilter('pluralize', (singular: any, count: any, options?: any) => {
      const n = Number(count) || 0;
      const plural = options?.plural || `${singular}s`;
      return `${n} ${n === 1 ? singular : plural}`;
    });

    // group_by: {{ items | group_by: "category" }}
    this.liquid.registerFilter('group_by', (collection: any, key: string) => {
      if (!Array.isArray(collection)) return {};
      const groups: Record<string, any[]> = {};
      for (const item of collection) {
        const k = String(item?.[key] ?? '');
        if (!groups[k]) groups[k] = [];
        groups[k].push(item);
      }
      return groups;
    });

    // find_by: {{ items | find_by: "name", "Ryan" }}
    this.liquid.registerFilter('find_by', (collection: any, key: string, value: any, fallback?: any) => {
      if (!Array.isArray(collection)) return fallback ?? null;
      return collection.find(item => item?.[key] == value) ?? fallback ?? null;
    });

    // json: {{ data | json }}
    this.liquid.registerFilter('json', (value: any) => {
      try { return JSON.stringify(value); } catch { return ''; }
    });

    // parse_json: {% assign obj = data | parse_json %}
    this.liquid.registerFilter('parse_json', (value: any) => {
      try { return JSON.parse(String(value)); } catch { return null; }
    });

    // append_random: {{ "chart-" | append_random }} → "chart-a3f1"
    this.liquid.registerFilter('append_random', (value: any) => {
      const hex = Math.random().toString(16).slice(2, 6);
      return `${value ?? ''}${hex}`;
    });

    // sample: {{ items | sample }} → random element
    this.liquid.registerFilter('sample', (arr: any) => {
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr[Math.floor(Math.random() * arr.length)];
    });

    // map_to_i: {{ "5, 4, 3" | split: ", " | map_to_i }}
    this.liquid.registerFilter('map_to_i', (arr: any) => {
      if (!Array.isArray(arr)) return arr;
      return arr.map(v => parseInt(String(v), 10) || 0);
    });

    // ordinalize: {{ "2025-10-02" | ordinalize: "%A, %B <<ordinal_day>>, %Y" }}
    this.liquid.registerFilter('ordinalize', (value: any, format?: string) => {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) return String(value);
      const day = d.getDate();
      const suffix = [11,12,13].includes(day % 100) ? 'th'
        : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
      if (!format) return `${day}${suffix}`;
      const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return format
        .replace('<<ordinal_day>>', `${day}${suffix}`)
        .replace('%A', weekdays[d.getDay()])
        .replace('%B', months[d.getMonth()])
        .replace('%Y', String(d.getFullYear()))
        .replace('%y', String(d.getFullYear()).slice(-2))
        .replace('%m', String(d.getMonth() + 1).padStart(2, '0'))
        .replace('%d', String(day).padStart(2, '0'));
    });

    // l_date: {{ "2025-01-11" | l_date: "%y %b" }}
    this.liquid.registerFilter('l_date', (value: any, format?: string, locale = 'en') => {
      let d: Date;
      if (value === 'now' || value === 'today') d = new Date();
      else if (typeof value === 'number' && value > 1e9) d = new Date(value * 1000);
      else d = new Date(String(value));
      if (isNaN(d.getTime())) return String(value);
      if (!format) return d.toLocaleDateString(locale);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const fullMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return format
        .replace('%Y', String(d.getFullYear()))
        .replace('%y', String(d.getFullYear()).slice(-2))
        .replace('%B', fullMonths[d.getMonth()])
        .replace('%b', months[d.getMonth()])
        .replace('%A', ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()])
        .replace('%a', weekdays[d.getDay()])
        .replace('%m', String(d.getMonth() + 1).padStart(2, '0'))
        .replace('%d', String(d.getDate()).padStart(2, '0'))
        .replace('%H', String(d.getHours()).padStart(2, '0'))
        .replace('%M', String(d.getMinutes()).padStart(2, '0'))
        .replace('%S', String(d.getSeconds()).padStart(2, '0'))
        .replace('%I', String(d.getHours() % 12 || 12).padStart(2, '0'))
        .replace('%p', d.getHours() >= 12 ? 'PM' : 'AM');
    });

    // where_exp: {{ items | where_exp: "item", "item.active == true" }}
    this.liquid.registerFilter('where_exp', () => {
      throw new ServiceUnavailableException('PLUGIN_ISOLATION_REQUIRED');
    });
  }

  /**
   * Render a plugin's Liquid template with data to HTML string
   */
  async renderToHtml(
    markup: string,
    locals: Record<string, any>,
    _settings: Record<string, any> = {},
  ): Promise<string> {
    if (!isJsonValue(locals) || !locals || typeof locals !== 'object' || Array.isArray(locals)) {
      throw new ServiceUnavailableException('SOURCE_SNAPSHOT_INVALID');
    }
    if (/\|\s*where_exp\b/.test(markup) || /\{%-?\s*(?:include|render|layout)\b/.test(markup)) {
      throw new ServiceUnavailableException('PLUGIN_ISOLATION_REQUIRED');
    }
    try {
      // Settings are configuration and may contain credentials. Templates see
      // only normalized persisted data, never a settings or OAuth object.
      const context = { ...(redactLogValue(locals) as Record<string, unknown>), settings: {} };
      return await this.liquid.parseAndRender(markup, context);
    } catch {
      // Liquid error text may contain supplied data; do not return or log it.
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
  ): Promise<Buffer> {
    const innerHtml = await this.renderToHtml(markup, locals, settings);
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
