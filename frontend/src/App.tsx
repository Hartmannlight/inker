import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AdminAuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ErrorBoundary, ToastContainer } from './components/common';
import { Landing } from './pages/auth/Landing';
import { Extensions } from './pages/extensions';
import { Integrations } from './pages/integrations';

// Pages are route-level boundaries. Loading them lazily keeps unrelated editors,
// integrations and CodeMirror code out of the initial application bundle.
const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const DevicesList = lazy(() => import('./pages/devices/DevicesList').then(module => ({ default: module.DevicesList })));
const DeviceDetail = lazy(() => import('./pages/devices/DeviceDetail').then(module => ({ default: module.DeviceDetail })));
const DeviceForm = lazy(() => import('./pages/devices/DeviceForm').then(module => ({ default: module.DeviceForm })));
const AddDevice = lazy(() => import('./pages/devices/AddDevice').then(module => ({ default: module.AddDevice })));
const ScreensList = lazy(() => import('./pages/screens/ScreensList').then(module => ({ default: module.ScreensList })));
const ScreenDetail = lazy(() => import('./pages/screens/ScreenDetail').then(module => ({ default: module.ScreenDetail })));
const ScreenForm = lazy(() => import('./pages/screens/ScreenForm').then(module => ({ default: module.ScreenForm })));
const ScreenDesigner = lazy(() => import('./pages/screens/ScreenDesigner').then(module => ({ default: module.ScreenDesigner })));
const PlaylistsList = lazy(() => import('./pages/playlists/PlaylistsList').then(module => ({ default: module.PlaylistsList })));
const PlaylistDetail = lazy(() => import('./pages/playlists/PlaylistDetail').then(module => ({ default: module.PlaylistDetail })));
const PlaylistForm = lazy(() => import('./pages/playlists/PlaylistForm').then(module => ({ default: module.PlaylistForm })));
const Settings = lazy(() => import('./pages/settings/Settings').then(module => ({ default: module.Settings })));
const DataSourceForm = lazy(() => import('./pages/data-sources').then(module => ({ default: module.DataSourceForm })));
const CustomWidgetForm = lazy(() => import('./pages/custom-widgets').then(module => ({ default: module.CustomWidgetForm })));
const CustomWidgetPreview = lazy(() => import('./pages/custom-widgets').then(module => ({ default: module.CustomWidgetPreview })));
const GrafanaPanelSource = lazy(() => import('./pages/integrations').then(module => ({ default: module.GrafanaPanelSource })));
const PluginCreator = lazy(() => import('./pages/plugins').then(module => ({ default: module.PluginCreator })));
const PluginInstanceForm = lazy(() => import('./pages/plugins').then(module => ({ default: module.PluginInstanceForm })));
const OAuthCallback = lazy(() => import('./pages/plugins').then(module => ({ default: module.OAuthCallback })));
const WebDisplay = lazy(() => import('./pages/display/WebDisplay').then(module => ({ default: module.WebDisplay })));
const Remotes = lazy(() => import('./pages/remotes/Remotes').then(module => ({ default: module.Remotes })));
const Operations = lazy(() => import('./pages/operations/Operations').then(module => ({ default: module.Operations })));

/**
 * Main App component with routing
 * Per scaling-up-with-reducer-and-context.md, we wrap the app with context providers
 * ErrorBoundary catches any runtime errors and displays a fallback UI
 */
function App() {
  return (
    <ErrorBoundary>
      <AdminAuthProvider>
        <NotificationProvider>
          <Router>
            <Suspense fallback={<div className="p-6 text-center text-gray-500" role="status">Seite wird geladen…</div>}>
            <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Landing defaultMode="admin" />} />
            <Route path="/display/pair" element={<Navigate to="/?mode=pair" replace />} />
            <Route path="/display/:externalId" element={<WebDisplay />} />

            {/* Protected routes */}
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />

            {/* Devices */}
            <Route
              path="/devices"
              element={
                <ProtectedRoute>
                  <DevicesList />
                </ProtectedRoute>
              }
            />
            <Route
              path="/devices/new"
              element={
                <ProtectedRoute>
                  <AddDevice />
                </ProtectedRoute>
              }
            />
            <Route
              path="/devices/:id"
              element={
                <ProtectedRoute>
                  <DeviceDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/devices/:id/edit"
              element={
                <ProtectedRoute>
                  <DeviceForm />
                </ProtectedRoute>
              }
            />

            {/* Screens */}
            <Route
              path="/screens"
              element={
                <ProtectedRoute>
                  <ScreensList />
                </ProtectedRoute>
              }
            />
            <Route
              path="/screens/new"
              element={
                <ProtectedRoute>
                  <ScreenForm />
                </ProtectedRoute>
              }
            />
            <Route
              path="/screens/designer"
              element={
                <ProtectedRoute>
                  <ScreenDesigner />
                </ProtectedRoute>
              }
            />
            <Route
              path="/screens/designer/:id"
              element={
                <ProtectedRoute>
                  <ScreenDesigner />
                </ProtectedRoute>
              }
            />
            <Route
              path="/screens/:id"
              element={
                <ProtectedRoute>
                  <ScreenDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/screens/:id/edit"
              element={
                <ProtectedRoute>
                  <ScreenForm />
                </ProtectedRoute>
              }
            />

            {/* Playlists */}
            <Route
              path="/playlists"
              element={
                <ProtectedRoute>
                  <PlaylistsList />
                </ProtectedRoute>
              }
            />
            <Route
              path="/playlists/new"
              element={
                <ProtectedRoute>
                  <PlaylistForm />
                </ProtectedRoute>
              }
            />
            <Route
              path="/playlists/:id"
              element={
                <ProtectedRoute>
                  <PlaylistDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/playlists/:id/edit"
              element={
                <ProtectedRoute>
                  <PlaylistForm />
                </ProtectedRoute>
              }
            />

            {/* Settings */}
            <Route path="/remotes" element={<ProtectedRoute><Remotes /></ProtectedRoute>} />
            <Route path="/operations" element={<ProtectedRoute><Operations /></ProtectedRoute>} />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />

            <Route path="/integrations" element={<ProtectedRoute><Integrations /></ProtectedRoute>} />
            <Route path="/integrations/grafana" element={<ProtectedRoute><GrafanaPanelSource /></ProtectedRoute>} />

            {/* Extensions - display packages and widgets */}
            <Route
              path="/extensions"
              element={
                <ProtectedRoute>
                  <Extensions />
                </ProtectedRoute>
              }
            />

            {/* OAuth callback (handles redirect from providers) */}
            <Route path="/plugins/oauth/callback" element={<OAuthCallback />} />

            {/* Legacy plugin URLs retain bookmark compatibility. */}
            <Route
              path="/plugins"
              element={<Navigate to="/extensions" replace />}
            />
            <Route
              path="/plugins/installed"
              element={<Navigate to="/extensions" replace />}
            />
            <Route
              path="/plugins/create"
              element={
                <ProtectedRoute>
                  <PluginCreator />
                </ProtectedRoute>
              }
            />
            <Route
              path="/plugins/:id/edit"
              element={
                <ProtectedRoute>
                  <PluginCreator />
                </ProtectedRoute>
              }
            />
            <Route
              path="/plugins/instances/:instanceId/generate"
              element={
                <ProtectedRoute>
                  <Navigate to="/integrations" replace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/plugins/instances/:id"
              element={
                <ProtectedRoute>
                  <PluginInstanceForm />
                </ProtectedRoute>
              }
            />

            {/* Data Sources - redirect list to extensions, keep forms */}
            <Route
              path="/data-sources"
              element={<Navigate to="/integrations?tab=data-sources" replace />}
            />
            <Route
              path="/data-sources/new"
              element={
                <ProtectedRoute>
                  <DataSourceForm />
                </ProtectedRoute>
              }
            />
            <Route
              path="/data-sources/:id/edit"
              element={
                <ProtectedRoute>
                  <DataSourceForm />
                </ProtectedRoute>
              }
            />

            {/* Custom Widgets - redirect list to extensions, keep forms */}
            <Route
              path="/custom-widgets"
              element={<Navigate to="/extensions" replace />}
            />
            <Route
              path="/custom-widgets/new"
              element={
                <ProtectedRoute>
                  <CustomWidgetForm />
                </ProtectedRoute>
              }
            />
            <Route
              path="/custom-widgets/:id/edit"
              element={
                <ProtectedRoute>
                  <CustomWidgetForm />
                </ProtectedRoute>
              }
            />
            <Route
              path="/custom-widgets/:id/preview"
              element={
                <ProtectedRoute>
                  <CustomWidgetPreview />
                </ProtectedRoute>
              }
            />

            <Route path="/" element={<Landing />} />

            {/* 404 */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </Suspense>
          <ToastContainer />
        </Router>
      </NotificationProvider>
      </AdminAuthProvider>
    </ErrorBoundary>
  );
}

export default App;
