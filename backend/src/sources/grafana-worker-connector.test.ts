import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import * as sharpModule from 'sharp';
import type sharpFactory from 'sharp';
import { runGrafanaConnector } from './grafana-worker-connector';

const sharp = ((sharpModule as unknown as { default?: typeof sharpFactory }).default ?? sharpModule) as typeof sharpFactory;
let server: Server | undefined;

afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

async function endpoint(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return `http://127.0.0.1:${address.port}`;
}
function config(baseUrl: string) { return { baseUrl, dashboardUid: 'test', panelId: 1, width: 4, height: 2, allowLocalNetwork: true }; }
function context(secret = 'test-token') { return { signal: new AbortController().signal, attempt: 1, secret }; }

describe('Grafana worker connector', () => {
  test('uses worker-only bearer auth and returns normalized pixels', async () => {
    const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const baseUrl = await endpoint((request, response) => {
      if (request.headers.authorization !== 'Bearer test-token') { response.writeHead(401).end(); return; }
      if (request.url?.startsWith('/api/dashboards/uid/test')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ panels: [{ id: 1, title: 'Panel', type: 'stat' }] }));
      else if (request.url?.startsWith('/render/d-solo/test')) response.writeHead(200, { 'content-type': 'image/png' }).end(png);
      else response.writeHead(404).end();
    });
    const result = await runGrafanaConnector(config(baseUrl), context());
    expect(result.connectorVersion).toBe('grafana-v1');
    expect(result.data).toMatchObject({ grafanaPanel: { width: 4, height: 2 } });
    expect(JSON.stringify(result.data)).not.toContain('test-token');
  });

  test('maps authentication, unavailable renderer, abort and blocked targets to stable codes', async () => {
    const unauthorized = await endpoint((_request, response) => response.writeHead(401).end());
    await expect(runGrafanaConnector(config(unauthorized), context())).rejects.toThrow('GRAFANA_AUTH_INVALID');
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const missingRenderer = await endpoint((request, response) => {
      if (request.url?.startsWith('/api/dashboards/')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ panels: [{ id: 1, title: 'Panel', type: 'stat' }] }));
      else response.writeHead(404).end();
    });
    await expect(runGrafanaConnector(config(missingRenderer), context())).rejects.toThrow('GRAFANA_RENDERER_UNAVAILABLE');
    const controller = new AbortController(); controller.abort();
    await expect(runGrafanaConnector(config(missingRenderer), { signal: controller.signal, attempt: 1, secret: 'test-token' })).rejects.toThrow();
    await expect(runGrafanaConnector({ ...config('http://127.0.0.1:1'), allowLocalNetwork: false }, context())).rejects.toThrow('GRAFANA_NETWORK_BLOCKED');
  });

  test('loads dashboard and panel metadata only through worker jobs', async () => {
    const baseUrl = await endpoint((request, response) => {
      if (request.url?.startsWith('/api/search')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ uid: 'a', title: 'Alpha' }]));
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ panels: [{ id: 2, title: 'Panel', type: 'stat' }] }));
    });
    await expect(runGrafanaConnector({ baseUrl, operation: 'dashboards', allowLocalNetwork: true }, context())).resolves.toMatchObject({ data: { grafanaDashboards: [{ uid: 'a' }] } });
    await expect(runGrafanaConnector({ baseUrl, operation: 'panels', dashboardUid: 'a', allowLocalNetwork: true }, context())).resolves.toMatchObject({ data: { grafanaPanels: [{ id: 2 }] } });
  });
});
