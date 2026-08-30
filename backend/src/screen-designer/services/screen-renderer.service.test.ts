import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { ScreenRendererService } from './screen-renderer.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomWidgetsService } from '../../custom-widgets/custom-widgets.service';
import { SettingsService } from '../../settings/settings.service';

type Design = Parameters<ScreenRendererService['renderDesignAsHtml']>[0];
type Widget = Design['widgets'][number];
type InternalRenderer = {
  renderWidget(widget: Widget): Promise<Buffer>;
  generateWidgetHtml(widget: Widget): Promise<string>;
  renderImageFromUrl(url: string, width: number, height: number): Promise<Buffer>;
  processImageForEink(url: string): Promise<string>;
  processImageForEinkHtml(url: string): Promise<string>;
};

function widget(name: string, config: Widget['config']): Widget {
  return {
    id: 1, screenDesignId: 1, templateId: 1, x: 0, y: 0, width: 120, height: 80,
    rotation: 0, zIndex: 0, config, createdAt: new Date(0), updatedAt: new Date(0),
    template: {
      id: 1, name, label: name, description: null, category: 'test', defaultConfig: {},
      minWidth: 1, minHeight: 1, createdAt: new Date(0),
    },
  };
}

function design(widgets: Widget[]): Design {
  return {
    id: 1, name: 'isolated renderer test', description: null, width: 120, height: 80,
    background: '#fff', isTemplate: false, createdAt: new Date(0), updatedAt: new Date(0), widgets,
  };
}

async function unavailable(action: Promise<unknown>): Promise<void> {
  try {
    await action;
    throw new Error('Expected source snapshot failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toBe('SOURCE_SNAPSHOT_UNAVAILABLE');
  }
}

describe('legacy renderer persisted-input boundary', () => {
  let service: ScreenRendererService;
  let internal: InternalRenderer;
  let directory: string;
  let localUrl: string;
  let inline: string;
  let remote: string;
  let requests = 0;
  let upgrades = 0;
  let png: Buffer;
  const plugin = {
    name: 'Static fixture', dataStrategy: 'static', markupFull: '<strong>LOCAL PLUGIN</strong>',
    markupHalfHorizontal: '<strong>LOCAL PLUGIN</strong>', markupHalfVertical: '<strong>LOCAL PLUGIN</strong>',
    markupQuadrant: '<strong>LOCAL PLUGIN</strong>',
  };
  const findPlugin = mock(async (_query: unknown) => plugin);
  const getWithData = mock(async (_id: number, _cachedOnly?: boolean) => ({
    widget: { config: {}, displayType: 'value' }, renderedContent: 'Persisted snapshot text',
  }));
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
  });
  server.on('upgrade', (_request, socket) => { upgrades++; socket.destroy(); });

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#222' } }).png().toBuffer();
    inline = `data:image/png;base64,${png.toString('base64')}`;
    await mkdir(join(process.cwd(), 'uploads'), { recursive: true });
    directory = await mkdtemp(join(process.cwd(), 'uploads', 'wp21-render-test-'));
    await writeFile(join(directory, 'local.png'), png);
    await writeFile(join(directory, 'linked.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://127.0.0.1/forbidden"/></svg>');
    localUrl = `/uploads/${basename(directory)}/local.png`;
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    remote = `http://127.0.0.1:${address.port}/private-token-image`;
    service = new ScreenRendererService(
      { plugin: { findUnique: findPlugin } } as unknown as PrismaService, { getWithData } as unknown as CustomWidgetsService,
      new ConfigService(), {} as SettingsService,
    );
    internal = service as unknown as InternalRenderer;
  });

  afterAll(async () => {
    await service?.onModuleDestroy();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    if (directory) {
      const root = resolve(process.cwd(), 'uploads');
      const target = resolve(directory);
      if (!relative(root, target).startsWith('wp21-render-test-')) throw new Error('Unsafe test cleanup');
      await rm(target, { recursive: true, force: true });
    }
  });

  it('fetches weather and GitHub only from their fixed public capture connectors', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) return new Response(JSON.stringify({
        current: { temperature_2m: 21, weather_code: 1, relative_humidity_2m: 55, wind_speed_10m: 8 },
        daily: { time: ['2026-08-30'], temperature_2m_max: [23], weather_code: [1] },
      }), { status: 200 });
      if (url.startsWith('https://api.github.com/repos/')) return new Response(JSON.stringify({
        stargazers_count: 42, full_name: 'private-owner/private-repo',
      }), { status: 200 });
      throw new Error(`Unexpected connector URL: ${url}`);
    });
    try {
      for (const name of ['weather', 'github']) {
        expect((await internal.renderWidget(widget(name, {}))).length).toBeGreaterThan(0);
        expect(await internal.generateWidgetHtml(widget(name, {}))).toContain(name === 'weather' ? '21' : '42');
        expect((await service.renderDesignAsHtml(design([widget(name, {})]))).length).toBeGreaterThan(0);
      }
      expect(await service.getGitHubStars('private-owner', 'private-repo')).toEqual({ stars: 42, name: 'private-owner/private-repo' });
      expect(fetch).toHaveBeenCalled();
      for (const [input] of fetch.mock.calls) {
        expect(String(input).startsWith('https://api.open-meteo.com/v1/forecast?') ||
          String(input).startsWith('https://api.github.com/repos/')).toBe(true);
      }
    } finally { fetch.mockRestore(); }
  });

  it('rejects remote URLs through every image helper without fetching or placeholder output', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    const browser = spyOn(service, 'getBrowser');
    try {
      for (const url of [remote, 'https://provider.invalid/image?token=secret', 'file:///etc/passwd']) {
        await unavailable(internal.renderWidget(widget('image', { url })));
        await unavailable(internal.generateWidgetHtml(widget('image', { url })));
        await unavailable(internal.renderImageFromUrl(url, 120, 80));
        await unavailable(internal.processImageForEink(url));
        await unavailable(internal.processImageForEinkHtml(url));
        await unavailable(service.renderUrlToPng(url, 120, 80));
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(browser).not.toHaveBeenCalled();
      expect(requests).toBe(0);
    } finally { fetch.mockRestore(); browser.mockRestore(); }
  });

  it('retains local and inline raster processing with real Sharp output', async () => {
    for (const url of [localUrl, inline]) {
      const buffer = await internal.renderWidget(widget('image', { url }));
      const metadata = await sharp(buffer).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', 120, 80]);
      expect(await internal.generateWidgetHtml(widget('image', { url }))).toContain('data:image/png;base64,');
      expect(await internal.processImageForEink(url)).toStartWith('data:image/png;base64,');
      expect(await internal.processImageForEinkHtml(url)).toStartWith('data:image/png;base64,');
      expect((await sharp(await internal.renderImageFromUrl(url, 64, 32)).metadata()).width).toBe(64);
    }
  });

  it('rejects missing, traversing, linked-document and malformed assets as failures', async () => {
    for (const url of [
      `/uploads/${basename(directory)}/missing.png`, '/uploads/../../package.json',
      `/uploads/${basename(directory)}/linked.svg`, 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png;base64,aW52YWxpZA==',
    ]) await unavailable(internal.processImageForEinkHtml(url));
  });

  it('propagates unavailable custom snapshots instead of painting the source error', async () => {
    getWithData.mockRejectedValueOnce(new ServiceUnavailableException('SOURCE_SNAPSHOT_UNAVAILABLE'));
    await unavailable(internal.generateWidgetHtml(widget('custom-widget-base', { customWidgetId: 1 })));
    getWithData.mockRejectedValueOnce(new Error('private-upstream-token'));
    await unavailable(internal.renderWidget(widget('custom-widget-base', { customWidgetId: 1 })));
    expect(getWithData.mock.calls.at(-1)).toEqual([1, true]);
  });

  it('rejects unbound provider plugin widgets and never selects provider credentials', async () => {
    for (const dataStrategy of ['polling', 'webhook']) {
      findPlugin.mockResolvedValueOnce({ ...plugin, dataStrategy });
      await unavailable(internal.renderWidget(widget('plugin', { pluginId: 1 })));
      findPlugin.mockResolvedValueOnce({ ...plugin, dataStrategy });
      await unavailable(internal.generateWidgetHtml(widget('plugin', { pluginId: 1 })));
    }
    for (const [query] of findPlugin.mock.calls) {
      expect(query).toEqual({ where: { id: 1 }, select: {
        name: true, dataStrategy: true, markupFull: true, markupHalfHorizontal: true,
        markupHalfVertical: true, markupQuadrant: true,
      } });
    }
  });

  it('retains static plugin text and propagates blocked image errors through plugin rendering', async () => {
    expect(await internal.generateWidgetHtml(widget('plugin', { pluginId: 1 }))).toContain('LOCAL PLUGIN');
    const buffer = await internal.renderWidget(widget('plugin', { pluginId: 1 }));
    expect((await sharp(buffer).metadata()).width).toBe(120);
    findPlugin.mockResolvedValueOnce({ ...plugin, markupQuadrant: `<img src="${remote}">` });
    await unavailable(internal.renderWidget(widget('plugin', { pluginId: 1 })));
    expect(requests).toBe(0);
  }, 20000);

  it('renders stored custom text without refreshing and without duplicate cache warmup', async () => {
    const count = getWithData.mock.calls.length;
    const buffer = await service.renderDesignAsHtml(design([widget('custom-widget-base', { customWidgetId: 1 })]));
    expect((await sharp(buffer).metadata()).width).toBe(120);
    expect(getWithData.mock.calls.length - count).toBe(1);
    expect(getWithData.mock.calls.at(-1)).toEqual([1, true]);
  }, 20000);

  it('renders real local text and raster pixels in both browser entry points', async () => {
    const textOnly = await service.renderDesignAsHtml(design([widget('text', { text: 'LOCAL', fontSize: 24 })]));
    const textStats = await sharp(textOnly).stats();
    expect(textStats.channels[0].min).toBeLessThan(100);
    expect(textStats.channels[0].max).toBeGreaterThan(240);
    const image = await service.renderDesignAsHtml(design([widget('image', { url: localUrl })]));
    expect((await sharp(image).metadata()).height).toBe(80);
    const html = await service.renderHtmlToPng(`<style>body{margin:0;background:white}</style><h1>LOCAL</h1><img src="${inline}">`, 120, 80);
    expect((await sharp(html).metadata()).width).toBe(120);
    expect(requests).toBe(0);
  }, 20000);

  it('blocks real browser image, CSS, font and frame traffic and rejects partial screenshots', async () => {
    for (const html of [
      `<img src="${remote}">`, `<style>body{background-image:url('${remote}')}</style>`,
      `<link rel="stylesheet" href="${remote}">`, `<iframe src="${remote}"></iframe>`,
      `<style>@font-face{font-family:remote;src:url('${remote}')}body{font-family:remote}</style>TEXT`,
    ]) await unavailable(service.renderHtmlToPng(html, 120, 80));
    expect(requests).toBe(0);
    expect((await (await service.getBrowser()).pages()).length).toBe(1);
  }, 20000);

  it('also rejects network dependencies in full design CSS without outbound requests', async () => {
    const configured = widget('text', { text: 'LOCAL', fontWeight: `normal;background-image:url('${remote}')` });
    await unavailable(service.renderDesignAsHtml(design([configured])));
    expect(requests).toBe(0);
  }, 20000);

  it('does not report an undecodable inline image as a successful screenshot', async () => {
    await unavailable(service.renderHtmlToPng('<img src="data:image/png;base64,aW52YWxpZA==">', 120, 80));
    expect(requests).toBe(0);
  }, 20000);

  it('disables active HTML including WebSocket/fetch and script mutation', async () => {
    const html = `<style>body{margin:0;background:white}</style><script>
      document.body.style.background='black';fetch('${remote}');new WebSocket('${remote.replace('http:', 'ws:')}');
    </script>`;
    const rendered = await service.renderHtmlToPng(html, 40, 40);
    const pixels = await sharp(rendered).removeAlpha().raw().toBuffer();
    expect(pixels.every(value => value === 255)).toBe(true);
    expect(requests).toBe(0);
    expect(upgrades).toBe(0);
  }, 20000);
});
