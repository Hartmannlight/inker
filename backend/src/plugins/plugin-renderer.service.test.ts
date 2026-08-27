import { describe, expect, mock, test } from 'bun:test';
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
