import axios from 'axios';
import { createSafeHttpAgent, createSafeHttpsAgent, validateUrlSafety } from '../common/utils/url-safety';
import { grafanaRequestUrl, parseGrafanaDashboards, parseGrafanaPanels, validateGrafanaPanelConfiguration } from './grafana-connector';
import type { ConnectorContext, ConnectorResult } from './connectors';
import { sharp } from '../common/utils/sharp.util';

const MAX_RENDER_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_PIXELS = 4_194_304;

function fail(code: string): never { throw new Error(code); }
function errorCode(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401) return 'GRAFANA_AUTH_INVALID';
    if (error.response?.status === 403) return 'GRAFANA_PERMISSION_DENIED';
    if (error.response?.status === 404) return 'GRAFANA_RENDERER_UNAVAILABLE';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'GRAFANA_TIMEOUT';
    if (error.code?.startsWith('ERR_TLS') || error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'GRAFANA_TLS_FAILED';
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'GRAFANA_DNS_FAILED';
  }
  return error instanceof Error ? error.message : 'GRAFANA_REQUEST_FAILED';
}

/** Executes only in SourceWorkerService after it decrypts the write-only token. */
export async function runGrafanaConnector(configInput: unknown, context: ConnectorContext): Promise<ConnectorResult> {
  if (!context.secret) fail('GRAFANA_TOKEN_MISSING');
  const config = validateGrafanaPanelConfiguration(configInput);
  try {
    await validateUrlSafety(config.baseUrl, { allowLocalNetwork: config.allowLocalNetwork });
  } catch { fail('GRAFANA_NETWORK_BLOCKED'); }
  const request = axios.create({ timeout: 20_000, maxRedirects: 0, maxContentLength: MAX_RENDER_BYTES,
    maxBodyLength: MAX_RENDER_BYTES, httpAgent: createSafeHttpAgent({ allowLocalNetwork: config.allowLocalNetwork }),
    httpsAgent: createSafeHttpsAgent({ allowLocalNetwork: config.allowLocalNetwork }),
    headers: { Authorization: `Bearer ${context.secret}`, Accept: 'application/json' }, signal: context.signal,
    validateStatus: status => status >= 200 && status < 300,
  });
  try {
    if (config.operation === 'dashboards') {
      const dashboards = (await request.get(grafanaRequestUrl(config.baseUrl, '/api/search?type=dash-db'))).data;
      return { connectorVersion: 'grafana-v1', data: { grafanaDashboards: parseGrafanaDashboards(dashboards) } };
    }
    if (config.operation === 'panels') {
      const dashboard = (await request.get(grafanaRequestUrl(config.baseUrl, `/api/dashboards/uid/${config.dashboardUid}`))).data;
      return { connectorVersion: 'grafana-v1', data: { grafanaPanels: parseGrafanaPanels(dashboard) } };
    }
    const dashboard = (await request.get(grafanaRequestUrl(config.baseUrl, `/api/dashboards/uid/${config.dashboardUid}`))).data;
    if (!parseGrafanaPanels(dashboard).some(panel => panel.id === config.panelId!)) fail('GRAFANA_PANEL_NOT_FOUND');
    const path = `/render/d-solo/${config.dashboardUid}?panelId=${config.panelId}&width=${config.width}&height=${config.height}`;
    const response = await request.get<ArrayBuffer>(grafanaRequestUrl(config.baseUrl, path), { responseType: 'arraybuffer', headers: { Accept: 'image/png,image/jpeg' } });
    const bytes = Buffer.from(response.data);
    if (bytes.length === 0 || bytes.length > MAX_RENDER_BYTES || !/^image\/(?:png|jpeg)$/i.test(String(response.headers['content-type']).split(';')[0])) fail('GRAFANA_RENDER_INVALID');
    const normalized = await sharp(bytes, { limitInputPixels: MAX_RENDER_PIXELS, animated: false }).rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
    if (!normalized.info.width || !normalized.info.height || normalized.data.length > MAX_RENDER_BYTES) fail('GRAFANA_RENDER_INVALID');
    return { connectorVersion: 'grafana-v1', data: { grafanaPanel: { png: normalized.data.toString('base64'), width: normalized.info.width, height: normalized.info.height } } };
  } catch (error) { fail(errorCode(error)); }
}
