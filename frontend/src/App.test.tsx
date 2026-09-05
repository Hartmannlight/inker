import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./contexts/AuthContext', () => ({ AdminAuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./contexts/NotificationContext', () => ({ NotificationProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./components/ProtectedRoute', () => ({ ProtectedRoute: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./components/common', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => children, ToastContainer: () => null }));
vi.mock('./pages/extensions', () => ({ Extensions: () => <div>Extensions route</div> }));
vi.mock('./pages/integrations', () => ({ Integrations: () => <div>Integrations route</div>, GrafanaPanelSource: () => <div>Grafana route</div> }));
vi.mock('./pages/auth/Landing', () => ({ Landing: () => <div>Landing</div> }));
vi.mock('./pages/Dashboard', () => ({ Dashboard: () => <div>Dashboard</div> }));
vi.mock('./pages/devices/DevicesList', () => ({ DevicesList: () => null }));
vi.mock('./pages/devices/DeviceDetail', () => ({ DeviceDetail: () => null }));
vi.mock('./pages/devices/DeviceForm', () => ({ DeviceForm: () => null }));
vi.mock('./pages/devices/AddDevice', () => ({ AddDevice: () => null }));
vi.mock('./pages/screens/ScreensList', () => ({ ScreensList: () => null }));
vi.mock('./pages/screens/ScreenDetail', () => ({ ScreenDetail: () => null }));
vi.mock('./pages/screens/ScreenForm', () => ({ ScreenForm: () => null }));
vi.mock('./pages/screens/ScreenDesigner', () => ({ ScreenDesigner: () => null }));
vi.mock('./pages/playlists/PlaylistsList', () => ({ PlaylistsList: () => null }));
vi.mock('./pages/playlists/PlaylistDetail', () => ({ PlaylistDetail: () => null }));
vi.mock('./pages/playlists/PlaylistForm', () => ({ PlaylistForm: () => null }));
vi.mock('./pages/settings/Settings', () => ({ Settings: () => null }));
vi.mock('./pages/data-sources', () => ({ DataSourceForm: () => null }));
vi.mock('./pages/custom-widgets', () => ({ CustomWidgetForm: () => null, CustomWidgetPreview: () => null }));
vi.mock('./pages/plugins', () => ({ PluginCreator: () => null, PluginInstanceForm: () => null, OAuthCallback: () => null }));
vi.mock('./pages/display/WebDisplay', () => ({ WebDisplay: () => null }));
vi.mock('./pages/remotes/Remotes', () => ({ Remotes: () => null }));
vi.mock('./pages/operations/Operations', () => ({ Operations: () => null }));

const { default: App } = await import('./App');

describe('legacy navigation redirects', () => {
  beforeEach(() => window.history.replaceState({}, '', '/'));

  it.each([
    ['/plugins', 'Extensions route'],
    ['/plugins/installed', 'Extensions route'],
    ['/data-sources', 'Integrations route'],
    ['/plugins/instances/42/generate', 'Integrations route'],
  ])('redirects %s semantically', async (path, expected) => {
    window.history.replaceState({}, '', path);
    render(<App />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('keeps pairing on the common start page', async () => {
    window.history.replaceState({}, '', '/display/pair');
    render(<App />);
    expect(await screen.findByText('Landing')).toBeInTheDocument();
    expect(window.location.search).toBe('?mode=pair');
  });
});
