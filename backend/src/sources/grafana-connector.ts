/**
 * Pure Grafana response normalization. Network access and credentials remain in
 * the trusted source worker; this module deliberately accepts no token.
 */
export type GrafanaDashboard = Readonly<{ uid: string; title: string }>;
export type GrafanaPanel = Readonly<{ id: number; title: string; type: string; row?: string }>;
export type GrafanaPanelConfiguration = Readonly<{
  baseUrl: string; operation: 'dashboards' | 'panels' | 'render'; dashboardUid?: string; panelId?: number;
  width?: number; height?: number; allowLocalNetwork: boolean;
}>;

export function normalizeGrafanaBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('GRAFANA_URL_INVALID');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('GRAFANA_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GRAFANA_URL_INVALID');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseGrafanaDashboards(value: unknown): GrafanaDashboard[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('GRAFANA_RESPONSE_INVALID');
  const seen = new Set<string>();
  const result: GrafanaDashboard[] = [];
  for (const item of value) {
    const row = object(item);
    if (!row || typeof row.uid !== 'string' || !row.uid || row.uid.length > 160 || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 500) {
      throw new Error('GRAFANA_RESPONSE_INVALID');
    }
    if (!seen.has(row.uid)) { seen.add(row.uid); result.push({ uid: row.uid, title: row.title.trim() }); }
  }
  return result.sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
}

export function parseGrafanaPanels(value: unknown): GrafanaPanel[] {
  const dashboard = object(value);
  if (!dashboard || !Array.isArray(dashboard.panels)) throw new Error('GRAFANA_RESPONSE_INVALID');
  const result: GrafanaPanel[] = [];
  const visit = (panels: unknown[], row?: string) => {
    for (const item of panels) {
      const panel = object(item);
      if (!panel) throw new Error('GRAFANA_RESPONSE_INVALID');
      if (panel.type === 'row') {
        if (panel.collapsed === true && Array.isArray(panel.panels)) visit(panel.panels, typeof panel.title === 'string' ? panel.title : undefined);
        continue;
      }
      if (!Number.isSafeInteger(panel.id) || (panel.id as number) < 1 || typeof panel.title !== 'string' || panel.title.length > 500 || typeof panel.type !== 'string' || !panel.type || panel.type.length > 80) {
        throw new Error('GRAFANA_RESPONSE_INVALID');
      }
      result.push({ id: panel.id as number, title: panel.title, type: panel.type, ...(row ? { row } : {}) });
    }
  };
  visit(dashboard.panels);
  const ids = new Set<number>();
  for (const panel of result) { if (ids.has(panel.id)) throw new Error('GRAFANA_RESPONSE_INVALID'); ids.add(panel.id); }
  return result.sort((a, b) => a.id - b.id);
}

export function grafanaRequestUrl(baseUrl: string, path: string): string {
  let request: URL;
  try { request = new URL(path, 'https://grafana.invalid'); } catch { throw new Error('GRAFANA_PATH_INVALID'); }
  const dashboard = /^\/api\/dashboards\/uid\/[A-Za-z0-9_-]{1,160}$/.test(request.pathname) && !request.search;
  const search = request.pathname === '/api/search' && request.searchParams.get('type') === 'dash-db'
    && [...request.searchParams.keys()].every(key => key === 'type');
  const render = /^\/render\/d-solo\/[A-Za-z0-9_-]{1,160}$/.test(request.pathname)
    && ['panelId', 'width', 'height'].every(key => /^\d+$/.test(request.searchParams.get(key) ?? ''))
    && [...request.searchParams.keys()].every(key => ['panelId', 'width', 'height'].includes(key));
  if (!dashboard && !search && !render) throw new Error('GRAFANA_PATH_INVALID');
  return `${normalizeGrafanaBaseUrl(baseUrl)}${path}`;
}

/** Public configuration only. The service-account token is deliberately not a field here. */
export function validateGrafanaPanelConfiguration(value: unknown): GrafanaPanelConfiguration {
  const config = object(value);
  const operation = config?.operation === undefined ? 'render' : config.operation;
  if (!config || !['dashboards', 'panels', 'render'].includes(String(operation))
    || Object.keys(config).some(key => !['baseUrl', 'operation', 'dashboardUid', 'panelId', 'width', 'height', 'allowLocalNetwork'].includes(key))
    || typeof config.allowLocalNetwork !== 'boolean') throw new Error('GRAFANA_CONFIG_INVALID');
  const common = { baseUrl: normalizeGrafanaBaseUrl(config.baseUrl), operation: operation as GrafanaPanelConfiguration['operation'], allowLocalNetwork: config.allowLocalNetwork };
  if (operation === 'dashboards') return common;
  if (typeof config.dashboardUid !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(config.dashboardUid)) throw new Error('GRAFANA_CONFIG_INVALID');
  if (operation === 'panels') return { ...common, dashboardUid: config.dashboardUid };
  if (!Number.isSafeInteger(config.panelId) || (config.panelId as number) < 1
    || !Number.isSafeInteger(config.width) || (config.width as number) < 1 || (config.width as number) > 2048
    || !Number.isSafeInteger(config.height) || (config.height as number) < 1 || (config.height as number) > 2048) throw new Error('GRAFANA_CONFIG_INVALID');
  return { ...common, dashboardUid: config.dashboardUid, panelId: config.panelId as number, width: config.width as number, height: config.height as number };
}
