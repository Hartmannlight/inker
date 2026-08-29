import { describe, expect, test } from 'bun:test';
import { grafanaRequestUrl, normalizeGrafanaBaseUrl, parseGrafanaDashboards, parseGrafanaPanels, validateGrafanaPanelConfiguration } from './grafana-connector';

describe('Grafana connector normalization', () => {
  test('normalizes only credential-free HTTP(S) origins and bounded Grafana API paths', () => {
    expect(normalizeGrafanaBaseUrl('https://grafana.example/')).toBe('https://grafana.example');
    expect(grafanaRequestUrl('https://grafana.example/', '/api/search?type=dash-db')).toBe('https://grafana.example/api/search?type=dash-db');
    for (const input of ['ftp://grafana.example', 'https://user:pass@grafana.example', 'https://grafana.example/?token=x']) expect(() => normalizeGrafanaBaseUrl(input)).toThrow('GRAFANA_URL_INVALID');
    expect(() => grafanaRequestUrl('https://grafana.example', '/api/user')).toThrow('GRAFANA_PATH_INVALID');
    expect(() => grafanaRequestUrl('https://grafana.example', '/api/search?type=dash-db&x=1')).toThrow('GRAFANA_PATH_INVALID');
  });

  test('projects dashboard and nested-row panel metadata deterministically', () => {
    expect(parseGrafanaDashboards([{ uid: 'z', title: 'Zulu' }, { uid: 'a', title: 'Alpha' }])).toEqual([{ uid: 'a', title: 'Alpha' }, { uid: 'z', title: 'Zulu' }]);
    expect(parseGrafanaPanels({ panels: [{ id: 4, title: 'Root', type: 'graph' }, { type: 'row', title: 'Nested', collapsed: true, panels: [{ id: 2, title: 'Panel', type: 'stat' }] }] })).toEqual([{ id: 2, title: 'Panel', type: 'stat', row: 'Nested' }, { id: 4, title: 'Root', type: 'graph' }]);
    expect(() => parseGrafanaPanels({ panels: [{ id: 1, title: 'x', type: 'stat' }, { id: 1, title: 'y', type: 'stat' }] })).toThrow('GRAFANA_RESPONSE_INVALID');
  });

  test('keeps the token out of public panel configuration', () => {
    expect(validateGrafanaPanelConfiguration({ baseUrl: 'https://grafana.example', dashboardUid: 'main', panelId: 1, width: 800, height: 480, allowLocalNetwork: false }))
      .toEqual({ baseUrl: 'https://grafana.example', operation: 'render', dashboardUid: 'main', panelId: 1, width: 800, height: 480, allowLocalNetwork: false });
    expect(() => validateGrafanaPanelConfiguration({ baseUrl: 'https://grafana.example', dashboardUid: 'main', panelId: 1, width: 800, height: 480, allowLocalNetwork: false, token: 'never-public' })).toThrow('GRAFANA_CONFIG_INVALID');
  });

  test('allows bounded asynchronous dashboard and panel metadata jobs', () => {
    expect(validateGrafanaPanelConfiguration({ baseUrl: 'https://grafana.example', operation: 'dashboards', allowLocalNetwork: false }))
      .toMatchObject({ operation: 'dashboards' });
    expect(validateGrafanaPanelConfiguration({ baseUrl: 'https://grafana.example', operation: 'panels', dashboardUid: 'main', allowLocalNetwork: false }))
      .toMatchObject({ operation: 'panels', dashboardUid: 'main' });
    expect(() => validateGrafanaPanelConfiguration({ baseUrl: 'https://grafana.example', operation: 'panels', allowLocalNetwork: false })).toThrow('GRAFANA_CONFIG_INVALID');
  });
});
