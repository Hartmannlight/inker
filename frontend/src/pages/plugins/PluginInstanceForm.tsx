import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout';
import { Button, LoadingSpinner } from '../../components/common';
import { useApi, useMutation } from '../../hooks/useApi';
import { useNotification } from '../../contexts/NotificationContext';

import { config } from '../../config';
import apiClient, { pluginService } from '../../services/api';

interface Plugin {
  id: number;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  category: string;
  source: string;
  isBuiltin: boolean;
  oauthProvider?: string;
  settingsSchema?: SettingsField[];
  _count?: { instances: number };
}

interface SettingsField {
  key: string;
  label: string;
  type: 'text' | 'select' | 'toggle' | 'number' | 'multi_select' | 'date' | 'password';
  description?: string;
  required?: boolean;
  encrypted?: boolean;
  default?: any;
  options?: { label: string; value: string }[];
}

interface PluginInstance {
  id: number;
  pluginId: number;
  name?: string;
  settings: Record<string, any>;
  plugin: Plugin;
  oauthToken?: string;
  lastFetchedAt?: string;
  lastError?: string;
}

export function PluginInstanceForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const notification = useNotification();
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [previewTimestamp, setPreviewTimestamp] = useState(Date.now());
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const fetchInstance = useCallback(
    () => apiClient.get<{ data: PluginInstance }>(`/plugins/instances/${id}`).then((res) => res.data.data),
    [id]
  );

  const { data: instance, isLoading } = useApi<PluginInstance>(fetchInstance);

  const saveMutation = useMutation<PluginInstance, Record<string, any>>(
    (settings) => apiClient.put<{ data: PluginInstance }>(`/plugins/instances/${id}`, { settings }).then((res) => res.data.data),
    {
      successMessage: 'Settings saved',
      onSuccess: () => {
        setPreviewTimestamp(Date.now());
      },
    }
  );

  // Initialize form values from instance settings
  useEffect(() => {
    if (instance) {
      // For Grafana child instances, use actual settings directly (not schema defaults)
      if (instance.plugin.slug === 'grafana_panel' && instance.settings?.parentInstanceId) {
        setFormValues({ ...instance.settings });
      } else {
        const schema = instance.plugin.settingsSchema || [];
        const defaults: Record<string, any> = {};
        for (const field of schema) {
          defaults[field.key] = instance.settings[field.key] ?? field.default ?? '';
        }
        setFormValues(defaults);
      }
    }
  }, [instance]);

  // Mark as initialized after first form population (skip auto-save on load)
  useEffect(() => {
    if (instance && Object.keys(formValues).length > 0 && !initialized) {
      // Delay to ensure we don't trigger on the initial population
      const timer = setTimeout(() => setInitialized(true), 100);
      return () => clearTimeout(timer);
    }
  }, [formValues, instance, initialized]);

  // Debounced auto-save + preview refresh on any settings change (skip for Grafana — has own save logic)
  const isGrafanaPlugin = instance?.plugin?.slug === 'grafana_panel';
  useEffect(() => {
    if (!initialized || isGrafanaPlugin) return;
    const timer = setTimeout(() => {
      apiClient.put(`/plugins/instances/${id}`, { settings: formValues })
        .then(() => setPreviewTimestamp(Date.now()))
        .catch(() => notification.error('Failed to save settings'));
    }, 800);
    return () => clearTimeout(timer);
  }, [formValues, initialized, id]);

  const handleFieldChange = (key: string, value: any) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleMultiSelectToggle = (key: string, optionValue: string) => {
    setFormValues((prev) => {
      const current: string[] = Array.isArray(prev[key]) ? prev[key] : [];
      const next = current.includes(optionValue)
        ? current.filter((v: string) => v !== optionValue)
        : [...current, optionValue];
      return { ...prev, [key]: next };
    });
  };

  const handleSave = () => {
    saveMutation.mutate(formValues);
  };

  const handleOAuthConnect = async () => {
    setOauthConnecting(true);
    try {
      const res = await apiClient.get<{ data: { url: string } }>(`/plugins/instances/${id}/oauth/authorize`);
      window.open(res.data.data.url, 'oauth', 'width=600,height=700');
    } catch {
      notification.error('Failed to start OAuth flow');
    } finally {
      setOauthConnecting(false);
    }
  };

  const handleOAuthDisconnect = async () => {
    try {
      await apiClient.post(`/plugins/instances/${id}/oauth/disconnect`);
      notification.success('OAuth disconnected');
    } catch {
      notification.error('Failed to disconnect');
    }
  };

  // Show notification if we just completed OAuth
  useEffect(() => {
    if (searchParams.get('oauth') === 'connected') {
      notification.success('OAuth connected successfully');
    }
  }, []);

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex justify-center items-center py-20">
          <LoadingSpinner size="lg" />
        </div>
      </MainLayout>
    );
  }

  if (!instance) {
    return (
      <MainLayout>
        <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light py-16 px-8 text-center">
          <h3 className="text-lg font-semibold text-text-primary mb-2">Plugin instance not found</h3>
          <Button onClick={() => navigate('/plugins')}>Back to Plugin Library</Button>
        </div>
      </MainLayout>
    );
  }

  // Legacy Grafana plugin instances are migrated to the worker-owned source
  // flow. Never let this editor load dashboards or create child instances.
  if (instance.plugin.slug === 'grafana_panel') {
    return <Navigate to="/integrations/grafana" replace />;
  }

  const schema = instance.plugin.settingsSchema || [];
  const previewUrl = `${config.apiUrl}/plugins/instances/${id}/render?mode=einkPreview&t=${previewTimestamp}`;
  const isGrafanaParent = instance.plugin.slug === 'grafana_panel' && !instance.settings?.parentInstanceId;

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Back Button + Header */}
        <div>
          <button
            onClick={() => {
              const from = searchParams.get('from');
              if (from) navigate(from);
              else navigate(-1);
            }}
            className="inline-flex items-center text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
          >
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <h1 className="text-3xl font-bold text-text-primary">{instance.plugin.name}</h1>
          {instance.name && (
            <p className="mt-1 text-text-muted">{instance.name}</p>
          )}
        </div>

        {/* Error Banner */}
        {instance.lastError && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
                {instance.lastError.startsWith('[settings]') ? 'Configuration Required' :
                 instance.lastError.startsWith('[network]') ? 'Network Error' :
                 instance.lastError.startsWith('[ruby]') ? 'Plugin Error' :
                 instance.lastError.startsWith('[template]') ? 'Template Error' : 'Plugin Error'}
              </h3>
              <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                {instance.lastError.replace(/^\[(settings|network|ruby|template)\]\s*/, '')}
              </p>
              <p className="text-xs text-red-500 dark:text-red-400 mt-2">
                {instance.lastError.startsWith('[settings]') ? 'Fill in the required settings below and save.' :
                 instance.lastError.startsWith('[network]') ? 'Check your API key or try refreshing the preview.' :
                 instance.lastError.startsWith('[ruby]') ? 'This plugin may not be fully compatible yet.' :
                 'Try refreshing the preview.'}
              </p>
            </div>
          </div>
        )}

        {/* Two-Column Layout */}
        <div className={`grid grid-cols-1 ${isGrafanaParent ? '' : 'lg:grid-cols-3'} gap-6`}>
          {/* Left: Settings Form */}
          <div className={isGrafanaParent ? '' : 'lg:col-span-2'}>
            <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-6">
              <h2 className="text-xl font-semibold text-text-primary mb-6">Settings</h2>

              {/* OAuth Connect Section */}
              {instance.plugin.oauthProvider && (
                <div className="mb-6 p-4 rounded-lg border border-border-light bg-bg-muted">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-medium text-text-primary">
                        {instance.oauthToken ? 'Connected' : 'Authentication Required'}
                      </h3>
                      <p className="text-xs text-text-muted mt-1">
                        This plugin requires {instance.plugin.oauthProvider} authorization
                      </p>
                    </div>
                    {instance.oauthToken ? (
                      <button
                        onClick={handleOAuthDisconnect}
                        className="px-3 py-1.5 text-sm text-red-600 hover:text-red-700 border border-red-200 rounded-lg transition-colors"
                      >
                        Disconnect
                      </button>
                    ) : (
                      <Button onClick={handleOAuthConnect} disabled={oauthConnecting}>
                        {oauthConnecting ? 'Connecting...' : `Connect ${instance.plugin.oauthProvider}`}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {instance.plugin.slug === 'grafana_panel' ? (
                <GrafanaSettings
                  instanceId={instance.id}
                  pluginId={instance.pluginId}
                  formValues={formValues}
                  onChange={handleFieldChange}
                  onSave={handleSave}
                  saving={saveMutation.isLoading}
                  schema={schema}
                  isChild={!!instance.settings?.parentInstanceId}
                  parentInstanceId={instance.settings?.parentInstanceId}
                />
              ) : schema.length === 0 ? (
                <p className="text-text-muted">This plugin has no configurable settings.</p>
              ) : (
                <div className="space-y-5">
                  {schema.map((field) => (
                    <SettingsFieldRenderer
                      key={field.key}
                      field={field}
                      value={formValues[field.key]}
                      onChange={(value) => handleFieldChange(field.key, value)}
                      onMultiSelectToggle={(optionValue) => handleMultiSelectToggle(field.key, optionValue)}
                    />
                  ))}

                  <div className="pt-4 border-t border-border-light">
                    <Button onClick={handleSave} disabled={saveMutation.isLoading}>
                      {saveMutation.isLoading ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                      ) : (
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      Save Settings
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right: Preview + Info (hidden for Grafana parent) */}
          {!isGrafanaParent && <div className="space-y-6">
            {/* Preview Panel */}
            <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-text-primary">Preview</h3>
                <button
                  onClick={() => setPreviewTimestamp(Date.now())}
                  className="inline-flex items-center text-sm text-accent hover:text-accent/80 transition-colors"
                >
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh Preview
                </button>
              </div>
              <div className="bg-bg-muted rounded-lg overflow-hidden border border-border-light cursor-pointer" onClick={() => window.open(previewUrl, '_blank')}>
                <img
                  src={previewUrl}
                  alt="Plugin preview"
                  className="w-full h-auto"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            </div>

            {/* Plugin Info */}
            <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-4">
              <h3 className="text-base font-semibold text-text-primary mb-3">Plugin Info</h3>
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-text-muted">Category</dt>
                  <dd>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-bg-muted text-text-secondary border border-border-light">
                      {instance.plugin.category}
                    </span>
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-text-muted">Source</dt>
                  <dd className="text-text-secondary font-medium">{instance.plugin.source}</dd>
                </div>
                {instance.plugin.description && (
                  <div>
                    <dt className="text-text-muted mb-1">Description</dt>
                    <dd className="text-text-secondary">{instance.plugin.description}</dd>
                  </div>
                )}
                {instance.lastFetchedAt && (
                  <div className="flex items-center justify-between">
                    <dt className="text-text-muted">Last fetched</dt>
                    <dd className="text-text-secondary">{formatRelativeTime(instance.lastFetchedAt)}</dd>
                  </div>
                )}
                {instance.lastError && (
                  <div>
                    <dt className="text-text-muted mb-1">Last error</dt>
                    <dd className="text-red-600 dark:text-red-400 text-xs bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
                      {instance.lastError}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>}
        </div>
      </div>
    </MainLayout>
  );
}

// ========================
// Grafana dynamic settings
// ========================

interface GrafanaDashboard {
  uid: string;
  title: string;
}

interface GrafanaPanel {
  id: number | string;
  title: string;
  type: string;
  section: string | null;
}

interface GrafanaSettingsProps {
  instanceId: number;
  pluginId: number;
  formValues: Record<string, any>;
  onChange: (key: string, value: any) => void;
  onSave: () => void;
  saving: boolean;
  schema: SettingsField[];
  isChild: boolean;
  parentInstanceId?: number;
}

function GrafanaSettings({ instanceId, pluginId, formValues, onChange, onSave, saving, schema, isChild, parentInstanceId }: GrafanaSettingsProps) {
  if (isChild) {
    return (
      <GrafanaChildSettings
        instanceId={instanceId}
        parentInstanceId={parentInstanceId!}
        formValues={formValues}
        onChange={onChange}
        onSave={onSave}
        saving={saving}
        schema={schema}
      />
    );
  }

  return (
    <GrafanaParentSettings
      instanceId={instanceId}
      pluginId={pluginId}
      formValues={formValues}
      onChange={onChange}
      onSave={onSave}
      saving={saving}
    />
  );
}

/** Parent mode: connection settings + generate screen */
function GrafanaParentSettings({ instanceId, formValues, onChange }: {
  instanceId: number; pluginId: number;
  formValues: Record<string, any>; onChange: (key: string, value: any) => void;
  onSave: () => void; saving: boolean;
}) {
  const navigate = useNavigate();
  const notification = useNotification();
  const [dashboards, setDashboards] = useState<GrafanaDashboard[]>([]);
  const [panels, setPanels] = useState<GrafanaPanel[]>([]);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [loadingPanels, setLoadingPanels] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [screenDashboard, setScreenDashboard] = useState('');
  const [screenPanel, setScreenPanel] = useState('');
  const [screenTimeRange, setScreenTimeRange] = useState('now-6h');
  const [screenWidth, setScreenWidth] = useState(800);
  const [screenHeight, setScreenHeight] = useState(480);
  const [screenName, setScreenName] = useState('');
  const [childScreens, setChildScreens] = useState<any[]>([]);

  const inputClasses =
    'w-full px-3 py-2.5 rounded-lg border border-border-light bg-bg-input text-text-primary placeholder-text-placeholder focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all';

  const MASK = '••••••••';
  const apiKeyIsSet = formValues.api_key === MASK;
  const [editingApiKey, setEditingApiKey] = useState(false);
  const canConnect = formValues.grafana_url && (apiKeyIsSet || (formValues.api_key && formValues.api_key !== MASK));
  const hasConnection = dashboards.length > 0;

  // Fetch child screens and clean up stale __preview__ instances
  const fetchChildScreens = useCallback(async () => {
    try {
      const all = await pluginService.getAllInstances();
      const children = all.filter((i: any) => i.settings?.parentInstanceId === instanceId);
      // Clean up any stale __preview__ instances
      for (const child of children) {
        if (child.name === '__preview__') {
          try { await pluginService.deleteInstance(child.id); } catch { /* ignore */ }
        }
      }
      setChildScreens(children.filter((i: any) => i.name !== '__preview__'));
    } catch { /* ignore */ }
  }, [instanceId]);

  useEffect(() => { fetchChildScreens(); }, [fetchChildScreens]);

  const fetchDashboards = async () => {
    // Save connection first
    await apiClient.put(`/plugins/instances/${instanceId}`, { settings: formValues });
    setLoadingDashboards(true);
    setError('');
    setDashboards([]);
    setPanels([]);
    try {
      const resp = await apiClient.post('/plugins/grafana/dashboards', { instanceId });
      const data = resp.data.data || resp.data;
      setDashboards(data);
      if (data.length === 0) setError('No dashboards found in Grafana');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to connect to Grafana');
    } finally {
      setLoadingDashboards(false);
    }
  };

  const fetchPanels = async (uid: string) => {
    if (!uid) { setPanels([]); return; }
    setLoadingPanels(true);
    setPanels([]);
    try {
      const resp = await apiClient.post('/plugins/grafana/panels', { instanceId, dashboard_uid: uid });
      const data = resp.data.data || resp.data;
      setPanels(data);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Failed to load panels');
    } finally {
      setLoadingPanels(false);
    }
  };

  const handleDashboardChange = (uid: string) => {
    setScreenDashboard(uid);
    setScreenPanel('');
    fetchPanels(uid);
  };

  // Live preview: create a temporary child to preview, then generate for real
  const [previewInstanceId, setPreviewInstanceId] = useState<number | null>(null);
  const [previewTimestamp, setPreviewTimestamp] = useState(Date.now());
  const [showGenerator, setShowGenerator] = useState(false);

  // When panel selection changes, create/update a temp preview instance
  useEffect(() => {
    if (!screenDashboard || !screenPanel || !showGenerator) return;
    const timer = setTimeout(async () => {
      try {
        if (previewInstanceId) {
          // Update existing preview instance
          await apiClient.put(`/plugins/instances/${previewInstanceId}`, {
            settings: { parentInstanceId: instanceId, dashboard_uid: screenDashboard, panel_id: (screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel)), time_range: screenTimeRange, screen_width: screenWidth, screen_height: screenHeight },
          });
        } else {
          // Create temp preview instance
          const resp = await apiClient.post('/plugins/grafana/generate-screen', {
            parentInstanceId: instanceId,
            dashboard_uid: screenDashboard,
            panel_id: (screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel)),
            time_range: screenTimeRange,
            screen_width: screenWidth,
            screen_height: screenHeight,
            name: '__preview__',
          });
          const data = resp.data.data || resp.data;
          setPreviewInstanceId(data.id);
        }
        setPreviewTimestamp(Date.now());
      } catch { /* ignore preview errors */ }
    }, 500);
    return () => clearTimeout(timer);
  }, [screenDashboard, screenPanel, screenTimeRange, screenWidth, screenHeight, showGenerator]);

  const handleGenerateScreenFinal = async () => {
    if (!screenDashboard || !screenPanel) return;
    setGenerating(true);
    try {
      const dashTitle = dashboards.find(d => d.uid === screenDashboard)?.title || '';
      const panelTitle = panels.find(p => String(p.id) === screenPanel)?.title || '';
      const finalName = screenName || `${dashTitle} — ${panelTitle}`;

      if (previewInstanceId) {
        // Rename the preview instance to finalize it
        await apiClient.put(`/plugins/instances/${previewInstanceId}`, {
          name: finalName,
          settings: { parentInstanceId: instanceId, dashboard_uid: screenDashboard, panel_id: (screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel)), time_range: screenTimeRange, screen_width: screenWidth, screen_height: screenHeight },
        });
      } else {
        await apiClient.post('/plugins/grafana/generate-screen', {
          parentInstanceId: instanceId,
          dashboard_uid: screenDashboard,
          panel_id: (screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel)),
          time_range: screenTimeRange,
          screen_width: screenWidth,
          screen_height: screenHeight,
          name: finalName,
        });
      }
      notification.success('Screen generated!');
      navigate('/screens');
    } catch (e: any) {
      notification.error(e.response?.data?.message || 'Failed to generate screen');
    } finally {
      setGenerating(false);
    }
  };

  const handleCancelGenerator = async () => {
    // Delete the preview instance if it exists
    if (previewInstanceId) {
      try { await pluginService.deleteInstance(previewInstanceId); } catch { /* ignore */ }
      setPreviewInstanceId(null);
    }
    setScreenDashboard('');
    setScreenPanel('');
    setScreenName('');
    setPanels([]);
    setShowGenerator(false);
  };

  return (
    <div className="space-y-5">
      {/* Connection settings */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wider">Connection</h3>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Grafana URL <span className="text-red-500">*</span>
          </label>
          <input type="text" value={formValues.grafana_url ?? ''} onChange={(e) => onChange('grafana_url', e.target.value)} className={inputClasses} placeholder="http://localhost:3000" />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            API Key <span className="text-red-500">*</span>
          </label>
          {apiKeyIsSet && !editingApiKey ? (
            <div className="flex items-center gap-2">
              <div className={`${inputClasses} flex items-center gap-2 text-text-muted`}>
                <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                API key is configured
              </div>
              <button onClick={() => { setEditingApiKey(true); onChange('api_key', ''); }}
                className="shrink-0 px-3 py-2.5 rounded-lg text-sm font-medium border border-border-light text-text-secondary hover:bg-bg-muted transition-colors">
                Change
              </button>
            </div>
          ) : (
            <input type="password" value={formValues.api_key === MASK ? '' : (formValues.api_key ?? '')} onChange={(e) => onChange('api_key', e.target.value)} className={inputClasses} placeholder="Enter API key" />
          )}
        </div>
        <button onClick={fetchDashboards} disabled={!canConnect || loadingDashboards}
          className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50">
          {loadingDashboards ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" /> :
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
          {hasConnection ? 'Refresh Dashboards' : 'Connect to Grafana'}
        </button>
      </div>

      {error && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">{error}</div>}

      {/* Generated screens list */}
      {childScreens.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-border-light">
          <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wider">Generated Screens</h3>
          {childScreens.map((child: any) => (
            <div key={child.id} onClick={() => navigate(`/plugins/instances/${child.id}`)}
              className="flex items-center justify-between p-3 rounded-lg border border-border-light bg-bg-muted hover:bg-bg-accent cursor-pointer transition-colors">
              <div>
                <p className="text-sm font-medium text-text-primary">{child.name || 'Grafana Screen'}</p>
                <p className="text-xs text-text-muted">Panel {child.settings?.panel_id} — {child.settings?.time_range || 'now-6h'}</p>
              </div>
              <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </div>
          ))}
        </div>
      )}

      {/* Generate Screen button / section */}
      {hasConnection && !showGenerator && (
        <div className="pt-4 border-t border-border-light">
          <button onClick={() => setShowGenerator(true)}
            className="w-full inline-flex items-center justify-center px-4 py-3 rounded-lg text-sm font-medium bg-text-primary text-text-inverse hover:opacity-90 transition-opacity">
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Generate Screen
          </button>
        </div>
      )}

      {showGenerator && (
        <div className="pt-4 border-t border-border-light space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wider">New Screen</h3>
            <button onClick={handleCancelGenerator} className="text-sm text-text-muted hover:text-text-primary transition-colors">Cancel</button>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Dashboard</label>
            <select value={screenDashboard} onChange={(e) => handleDashboardChange(e.target.value)} className={inputClasses}>
              <option value="">Choose a dashboard...</option>
              {dashboards.map((d) => <option key={d.uid} value={d.uid}>{d.title}</option>)}
            </select>
          </div>

          {loadingPanels && <div className="flex items-center gap-2 text-sm text-text-muted"><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading panels...</div>}

          {panels.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Panel</label>
              <PanelSelect panels={panels} value={screenPanel} onChange={setScreenPanel} className={inputClasses} />
            </div>
          )}

          {screenPanel && (
            <>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Time Range</label>
                <select value={screenTimeRange} onChange={(e) => setScreenTimeRange(e.target.value)} className={inputClasses}>
                  <option value="now-5m">Last 5 minutes</option>
                  <option value="now-15m">Last 15 minutes</option>
                  <option value="now-30m">Last 30 minutes</option>
                  <option value="now-1h">Last 1 hour</option>
                  <option value="now-3h">Last 3 hours</option>
                  <option value="now-6h">Last 6 hours</option>
                  <option value="now-12h">Last 12 hours</option>
                  <option value="now-24h">Last 24 hours</option>
                  <option value="now-2d">Last 2 days</option>
                  <option value="now-7d">Last 7 days</option>
                  <option value="now-30d">Last 30 days</option>
                  <option value="now-90d">Last 90 days</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Resolution</label>
                <div className="flex items-center gap-2">
                  <input type="number" value={screenWidth} onChange={(e) => setScreenWidth(Number(e.target.value) || 800)} className={inputClasses} min={100} max={3840} />
                  <span className="text-text-muted shrink-0">x</span>
                  <input type="number" value={screenHeight} onChange={(e) => setScreenHeight(Number(e.target.value) || 480)} className={inputClasses} min={100} max={2160} />
                  <span className="text-xs text-text-muted shrink-0">px</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Screen Name (optional)</label>
                <input type="text" value={screenName} onChange={(e) => setScreenName(e.target.value)} className={inputClasses} placeholder="Auto-generated from dashboard/panel" />
              </div>

              {/* Live preview */}
              {previewInstanceId && (
                <GrafanaPreview instanceId={previewInstanceId} timestamp={previewTimestamp} />
              )}

              <button onClick={handleGenerateScreenFinal} disabled={generating}
                className="w-full inline-flex items-center justify-center px-4 py-3 rounded-lg text-sm font-medium bg-text-primary text-text-inverse hover:opacity-90 transition-opacity disabled:opacity-50">
                {generating ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" /> :
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                Save Screen
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Panel select with optgroup sections */
function PanelSelect({ panels, value, onChange, className }: {
  panels: GrafanaPanel[]; value: string; onChange: (v: string) => void; className: string;
}) {
  // Group panels by section
  const sections = new Map<string, GrafanaPanel[]>();
  const ungrouped: GrafanaPanel[] = [];

  for (const p of panels) {
    if (p.section) {
      if (!sections.has(p.section)) sections.set(p.section, []);
      sections.get(p.section)!.push(p);
    } else {
      ungrouped.push(p);
    }
  }

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Choose a panel...</option>
      {ungrouped.map((p) => (
        <option key={p.id} value={p.id}>{p.title}{p.type !== 'dashboard' ? ` (${p.type})` : ''}</option>
      ))}
      {Array.from(sections.entries()).map(([section, sectionPanels]) => (
        <optgroup key={section} label={section}>
          {sectionPanels.map((p) => (
            <option key={p.id} value={p.id}>
              {p.type === 'row' ? `▸ Entire section` : `${p.title} (${p.type})`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Preview with loading spinner */
function GrafanaPreview({ instanceId, timestamp }: { instanceId: number; timestamp: number }) {
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setHasError(false);
  }, [timestamp]);

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">Preview</label>
      <div className="bg-bg-muted rounded-lg overflow-hidden border border-border-light relative" style={{ minHeight: loading ? '200px' : undefined }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
          </div>
        )}
        {!hasError && (
          <img
            src={`${config.apiUrl}/plugins/instances/${instanceId}/render?mode=einkPreview&t=${timestamp}`}
            alt="Screen preview"
            className={`w-full h-auto ${loading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setHasError(true); }}
          />
        )}
        {hasError && (
          <div className="flex items-center justify-center py-8 text-sm text-text-muted">
            Preview unavailable
          </div>
        )}
      </div>
    </div>
  );
}

/** Child mode: edit dashboard/panel/time range for an existing screen */
function GrafanaChildSettings({ parentInstanceId, formValues, onChange, onSave, saving }: {
  instanceId: number; parentInstanceId: number;
  formValues: Record<string, any>; onChange: (key: string, value: any) => void;
  onSave: () => void; saving: boolean; schema: SettingsField[];
}) {
  const [dashboards, setDashboards] = useState<GrafanaDashboard[]>([]);
  const [panels, setPanels] = useState<GrafanaPanel[]>([]);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [loadingPanels, setLoadingPanels] = useState(false);
  const [error, setError] = useState('');

  const inputClasses =
    'w-full px-3 py-2.5 rounded-lg border border-border-light bg-bg-input text-text-primary placeholder-text-placeholder focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all';

  // Auto-load dashboards and panels on mount
  const initialDashboardUid = formValues.dashboard_uid;
  useEffect(() => {
    (async () => {
      setLoadingDashboards(true);
      try {
        const resp = await apiClient.post('/plugins/grafana/dashboards', { instanceId: parentInstanceId });
        const data = resp.data.data || resp.data;
        setDashboards(data);
        // If we already have a dashboard selected, load its panels
        if (initialDashboardUid) {
          setLoadingPanels(true);
          const pResp = await apiClient.post('/plugins/grafana/panels', { instanceId: parentInstanceId, dashboard_uid: initialDashboardUid });
          setPanels(pResp.data.data || pResp.data);
          setLoadingPanels(false);
        }
      } catch (e: any) {
        setError(e.response?.data?.message || 'Failed to load from Grafana');
      } finally {
        setLoadingDashboards(false);
      }
    })();
  }, [parentInstanceId, initialDashboardUid]);

  const handleDashboardChange = async (uid: string) => {
    onChange('dashboard_uid', uid);
    onChange('panel_id', '');
    if (!uid) { setPanels([]); return; }
    setLoadingPanels(true);
    try {
      const resp = await apiClient.post('/plugins/grafana/panels', { instanceId: parentInstanceId, dashboard_uid: uid });
      setPanels(resp.data.data || resp.data);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Failed to load panels');
    } finally {
      setLoadingPanels(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">{error}</div>}

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">Dashboard</label>
        {loadingDashboards ? <div className="text-sm text-text-muted">Loading dashboards...</div> : (
          <select value={formValues.dashboard_uid ?? ''} onChange={(e) => handleDashboardChange(e.target.value)} className={inputClasses}>
            <option value="">Choose a dashboard...</option>
            {dashboards.map((d) => <option key={d.uid} value={d.uid}>{d.title}</option>)}
          </select>
        )}
      </div>

      {loadingPanels && <div className="flex items-center gap-2 text-sm text-text-muted"><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading panels...</div>}

      {panels.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Panel</label>
          <PanelSelect panels={panels} value={String(formValues.panel_id ?? '')} onChange={(v) => {
            const val = v.startsWith('row-') || v === 'full' ? v : (v ? Number(v) : '');
            onChange('panel_id', val);
          }} className={inputClasses} />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">Time Range</label>
        <select value={formValues.time_range ?? 'now-6h'} onChange={(e) => onChange('time_range', e.target.value)} className={inputClasses}>
                  <option value="now-5m">Last 5 minutes</option>
                  <option value="now-15m">Last 15 minutes</option>
                  <option value="now-30m">Last 30 minutes</option>
                  <option value="now-1h">Last 1 hour</option>
                  <option value="now-3h">Last 3 hours</option>
                  <option value="now-6h">Last 6 hours</option>
                  <option value="now-12h">Last 12 hours</option>
                  <option value="now-24h">Last 24 hours</option>
                  <option value="now-2d">Last 2 days</option>
                  <option value="now-7d">Last 7 days</option>
                  <option value="now-30d">Last 30 days</option>
                  <option value="now-90d">Last 90 days</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">Resolution</label>
        <div className="flex items-center gap-2">
          <input type="number" value={formValues.screen_width ?? 800} onChange={(e) => onChange('screen_width', Number(e.target.value) || 800)} className={inputClasses} min={100} max={3840} />
          <span className="text-text-muted shrink-0">x</span>
          <input type="number" value={formValues.screen_height ?? 480} onChange={(e) => onChange('screen_height', Number(e.target.value) || 480)} className={inputClasses} min={100} max={2160} />
          <span className="text-xs text-text-muted shrink-0">px</span>
        </div>
      </div>

      <div className="pt-4 border-t border-border-light">
        <Button onClick={onSave} disabled={saving}>
          {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" /> :
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
          Save Settings
        </Button>
      </div>
    </div>
  );
}

interface SettingsFieldRendererProps {
  field: SettingsField;
  value: any;
  onChange: (value: any) => void;
  onMultiSelectToggle: (optionValue: string) => void;
}

function SettingsFieldRenderer({ field, value, onChange, onMultiSelectToggle }: SettingsFieldRendererProps) {
  const inputClasses =
    'w-full px-3 py-2.5 rounded-lg border border-border-light bg-bg-input text-text-primary placeholder-text-placeholder focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all';

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-xs text-text-muted mb-2">{field.description}</p>
      )}

      {/* Text / Password */}
      {(field.type === 'text' || field.type === 'password' || field.encrypted) && (
        <input
          type={field.encrypted || field.type === 'password' ? 'password' : 'text'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
          placeholder={`Enter ${field.label.toLowerCase()}`}
        />
      )}

      {/* Number */}
      {field.type === 'number' && !field.encrypted && (
        <input
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className={inputClasses}
          placeholder={`Enter ${field.label.toLowerCase()}`}
        />
      )}

      {/* Date */}
      {field.type === 'date' && (
        <input
          type="date"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      )}

      {/* Select */}
      {field.type === 'select' && (
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        >
          <option value="">Select {field.label.toLowerCase()}</option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {/* Toggle */}
      {field.type === 'toggle' && (
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-bg-muted border border-border-light peer-focus:ring-2 peer-focus:ring-accent/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent" />
        </label>
      )}

      {/* Multi Select (Checkboxes) */}
      {field.type === 'multi_select' && (
        <div className="space-y-2">
          {field.options?.map((opt) => {
            const selected: string[] = Array.isArray(value) ? value : [];
            return (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => onMultiSelectToggle(opt.value)}
                  className="rounded border-border-light text-accent focus:ring-accent/20"
                />
                <span className="text-sm text-text-secondary">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
