import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';
import { PluginRendererService } from './plugin-renderer.service';

describe('plugin template boundary', () => {
  function harness() {
    const screen = {
      renderHtmlToPng: mock(async () => Buffer.from('png')),
      getBrowser: mock(async () => { throw new Error('unexpected external browser access'); }),
    };
    return { screen, renderer: new PluginRendererService(screen as unknown as ScreenRendererService) };
  }

  test('templates see normalized data but never configuration or OAuth values', async () => {
    const { renderer } = harness();
    const html = await renderer.renderToHtml(
      '{{ title }}|{{ settings.customCredential }}|{{ access_token }}|{{ settings | json }}',
      { title: 'Snapshot title', settings: { customCredential: 'injected-secret' }, access_token: 'cached-secret' },
      { customCredential: 'config-secret' },
    );
    expect(html).toBe('Snapshot title||[REDACTED]|{}');
    for (const secret of ['injected-secret', 'cached-secret', 'config-secret']) expect(html).not.toContain(secret);
  });

  test('removes opaque settings before real child stdin without reading settings accessors or proxies', async () => {
    const { renderer } = harness();
    const realSpawn = childProcess.spawn;
    const readInputs: Array<() => string> = [];
    const restorePipes: Array<() => void> = [];
    const observeSpawn = ((command: string, args: readonly string[] | childProcess.SpawnOptions = [], options: childProcess.SpawnOptions = {}) => {
      const child = Array.isArray(args) ? realSpawn(command, args, options)
        : realSpawn(command, args as childProcess.SpawnOptions);
      if (Array.isArray(args) && args.some(argument => /isolation-child\.(?:ts|js)$/.test(argument)) && child.stdin) {
        const end = spyOn(child.stdin, 'end');
        readInputs.push(() => String(end.mock.calls[0]?.[0]));
        restorePipes.push(() => end.mockRestore());
      }
      return child;
    }) as typeof childProcess.spawn;
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(observeSpawn);
    let invoked = 0;
    const hidden = 'synthetic-provider-value-with-an-opaque-key';
    const settingsProxy = new Proxy({}, { ownKeys() { invoked++; throw new Error('must not inspect settings'); } });
    const locals = [
      { title: 'safe', settings: { opaque: hidden } },
      Object.defineProperty({ title: 'safe' }, 'settings', { enumerable: true, get() { invoked++; throw new Error('must not read settings'); } }),
      { title: 'safe', settings: settingsProxy },
    ];
    try {
      for (const input of locals) {
        expect(await renderer.renderToHtml('{{ title }}|{{ settings | json }}', input, { opaque: hidden })).toBe('safe|{}');
      }
      expect(invoked).toBe(0);
      const inputs = readInputs.map(read => read());
      expect(inputs).toHaveLength(locals.length);
      for (const input of inputs) {
        expect(input).not.toContain(hidden);
        expect(JSON.parse(input).data).toEqual({ title: 'safe', settings: {} });
      }
    } finally {
      for (const restore of restorePipes) restore();
      spawn.mockRestore();
    }
  });

  test('preserves existing Liquid filters in the actual child runtime', async () => {
    const { renderer } = harness();
    const html = await renderer.renderToHtml(
      '{{ amount | number_with_delimiter }}|{{ amount | number_to_currency: "$" }}|{{ "book" | pluralize: count }}|{{ items | find_by: "id", 2 | json }}|{{ "2025-01-11" | l_date: "%Y-%m-%d" }}',
      { amount: 1234.5, count: 2, items: [{ id: 1 }, { id: 2 }] },
    );
    expect(html).toBe('1,234.5|$1,234.50|2 books|{"id":2}|2025-01-11');
  });

  test('never invokes getter, proxy or serialization hooks on raw caller input', async () => {
    const { renderer } = harness();
    let invoked = 0;
    const data = Object.defineProperty({}, 'title', { enumerable: true, get() { invoked++; return 'private-getter-value'; } });
    const proxy = new Proxy({}, { ownKeys() { invoked++; return []; } });
    const hooks = { toJSON() { invoked++; return { title: 'private-hook-value' }; } };
    for (const input of [data, proxy, hooks]) {
      await expect(renderer.renderToHtml('{{ title }}', input))
        .rejects.toMatchObject({ status: 503, message: 'SOURCE_SNAPSHOT_INVALID' });
    }
    expect(invoked).toBe(0);
  });

  test('forwards aborts and does not paint an aborted template as a successful PNG', async () => {
    const { renderer, screen } = harness();
    const abort = new AbortController();
    abort.abort();
    await expect(renderer.renderToPng('{{ title }}', { title: 'Snapshot' }, {}, 120, 80, 'preview', abort.signal))
      .rejects.toMatchObject({ status: 503, message: 'PLUGIN_TEMPLATE_UNAVAILABLE' });
    expect(screen.renderHtmlToPng).not.toHaveBeenCalled();
  });

  test('where_exp cannot execute JavaScript or produce a successful fallback', async () => {
    const { renderer, screen } = harness();
    await expect(renderer.renderToPng('{{ items | where_exp: "item", "globalThis.process.exit()" }}',
      { items: [1] })).rejects.toMatchObject({ status: 503, message: 'PLUGIN_ISOLATION_REQUIRED' });
    expect(screen.renderHtmlToPng).not.toHaveBeenCalled();
  });

  test('malformed templates and non-JSON input fail without leaking parser details', async () => {
    const { renderer, screen } = harness();
    await expect(renderer.renderToPng('{% unknown_secret_tag %}', {}))
      .rejects.toMatchObject({ status: 503, message: 'PLUGIN_TEMPLATE_UNAVAILABLE' });
    await expect(renderer.renderToHtml('{{ value }}', { value: new Date() }))
      .rejects.toMatchObject({ status: 503, message: 'SOURCE_SNAPSHOT_INVALID' });
    expect(screen.renderHtmlToPng).not.toHaveBeenCalled();
  });

  test('external URL screenshots fail before opening Chromium or receiving headers', async () => {
    const { renderer, screen } = harness();
    await expect(renderer.renderUrlToPng('http://127.0.0.1/private', { Authorization: 'Bearer secret' }))
      .rejects.toMatchObject({ status: 503, message: 'SOURCE_REFRESH_REQUIRES_CONNECTOR' });
    expect(screen.getBrowser).not.toHaveBeenCalled();
    expect(screen.renderHtmlToPng).not.toHaveBeenCalled();
  });

  test('templates cannot read local files using Liquid include, render or layout', async () => {
    const { renderer } = harness();
    for (const tag of ['include', 'render', 'layout']) {
      await expect(renderer.renderToHtml(`{% ${tag} '/app/secrets/instance-secrets.json' %}`, {}))
        .rejects.toMatchObject({ status: 503, message: 'PLUGIN_ISOLATION_REQUIRED' });
    }
  });
});
