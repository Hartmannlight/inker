import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MainLayout } from '../layout';
import { LoadingSpinner } from '../common';
import apiClient, { getErrorMessage, pluginService } from '../../services/api';
import { useNotification } from '../../contexts/NotificationContext';
import { config } from '../../config';
import type { PluginInstance } from '../../types';

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

const inputClasses =
  'w-full px-3 py-2.5 rounded-lg border border-border-light bg-bg-input text-text-primary placeholder-text-placeholder focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all';

export function GrafanaGeneratorPage() {
  const { instanceId: instanceIdParam } = useParams<{ instanceId: string }>();
  const instanceId = Number(instanceIdParam);
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
  const [customResolution, setCustomResolution] = useState(false);
  const [screenName, setScreenName] = useState('');

  const [previewInstanceId, setPreviewInstanceId] = useState<number | null>(null);
  const [previewTimestamp, setPreviewTimestamp] = useState(Date.now());
  const [childScreens, setChildScreens] = useState<PluginInstance[]>([]);
  const savedRef = useRef(false);

  const fetchChildScreens = useCallback(async () => {
    try {
      const all = await pluginService.getAllInstances();
      const children = all.filter((i) => i.settings.parentInstanceId === instanceId);
      for (const child of children) {
        if (child.name === '__preview__') {
          try { await pluginService.deleteInstance(child.id); } catch { /* ignore */ }
        }
      }
      setChildScreens(children.filter((i) => i.name !== '__preview__'));
    } catch { /* ignore */ }
  }, [instanceId]);

  useEffect(() => { fetchChildScreens(); }, [fetchChildScreens]);

  const fetchDashboards = useCallback(async () => {
    setLoadingDashboards(true);
    setError('');
    setDashboards([]);
    setPanels([]);
    try {
      const resp = await apiClient.post<{ data: GrafanaDashboard[] }>('/plugins/grafana/dashboards', { instanceId });
      const data = resp.data.data;
      setDashboards(data);
      if (data.length === 0) setError('No dashboards found in Grafana');
    } catch (error: unknown) {
      setError(getErrorMessage(error) || 'Failed to connect to Grafana');
    } finally {
      setLoadingDashboards(false);
    }
  }, [instanceId]);

  useEffect(() => { void fetchDashboards(); }, [fetchDashboards]);

  const fetchPanels = async (uid: string) => {
    if (!uid) { setPanels([]); return; }
    setLoadingPanels(true);
    setPanels([]);
    try {
      const resp = await apiClient.post<{ data: GrafanaPanel[] }>('/plugins/grafana/panels', { instanceId, dashboard_uid: uid });
      const data = resp.data.data;
      setPanels(data);
    } catch (error: unknown) {
      setError(getErrorMessage(error) || 'Failed to load panels');
    } finally {
      setLoadingPanels(false);
    }
  };

  const handleDashboardChange = (uid: string) => {
    setScreenDashboard(uid);
    setScreenPanel('');
    fetchPanels(uid);
  };

  useEffect(() => {
    if (!screenDashboard || !screenPanel) return;
    const timer = setTimeout(async () => {
      try {
        const panelId = screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel);
        if (previewInstanceId) {
          await apiClient.put(`/plugins/instances/${previewInstanceId}`, {
            settings: { parentInstanceId: instanceId, dashboard_uid: screenDashboard, panel_id: panelId, time_range: screenTimeRange, screen_width: screenWidth, screen_height: screenHeight },
          });
        } else {
          const resp = await apiClient.post<{ data: { id: number } }>('/plugins/grafana/generate-screen', {
            parentInstanceId: instanceId,
            dashboard_uid: screenDashboard,
            panel_id: panelId,
            time_range: screenTimeRange,
            screen_width: screenWidth,
            screen_height: screenHeight,
            name: '__preview__',
          });
          setPreviewInstanceId(resp.data.data.id);
        }
        setPreviewTimestamp(Date.now());
      } catch { /* ignore preview errors */ }
    }, 500);
    return () => clearTimeout(timer);
  }, [instanceId, previewInstanceId, screenDashboard, screenPanel, screenTimeRange, screenWidth, screenHeight]);

  const handleGenerate = async () => {
    if (!screenDashboard || !screenPanel) return;
    setGenerating(true);
    try {
      const dashTitle = dashboards.find(d => d.uid === screenDashboard)?.title || '';
      const panelTitle = panels.find(p => String(p.id) === screenPanel)?.title || '';
      const finalName = screenName || `${dashTitle} — ${panelTitle}`;
      const panelId = screenPanel === 'full' || screenPanel.startsWith('row-') ? screenPanel : Number(screenPanel);

      if (previewInstanceId) {
        await apiClient.put(`/plugins/instances/${previewInstanceId}`, {
          name: finalName,
          settings: { parentInstanceId: instanceId, dashboard_uid: screenDashboard, panel_id: panelId, time_range: screenTimeRange, screen_width: screenWidth, screen_height: screenHeight },
        });
      } else {
        await apiClient.post('/plugins/grafana/generate-screen', {
          parentInstanceId: instanceId,
          dashboard_uid: screenDashboard,
          panel_id: panelId,
          time_range: screenTimeRange,
          screen_width: screenWidth,
          screen_height: screenHeight,
          name: finalName,
        });
      }
      notification.success('Screen generated!');
      savedRef.current = true;
      setPreviewInstanceId(null);
      navigate('/screens');
    } catch (error: unknown) {
      notification.error(getErrorMessage(error) || 'Failed to generate screen');
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    return () => {
      if (previewInstanceId && !savedRef.current) {
        pluginService.deleteInstance(previewInstanceId).catch(() => {});
      }
    };
  }, [previewInstanceId]);

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <button
            onClick={() => navigate('/plugins')}
            className="inline-flex items-center text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
          >
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Plugins
          </button>
          <h1 className="text-3xl font-bold text-text-primary">Generate Grafana Screen</h1>
          <p className="mt-1 text-text-muted">Select a dashboard and panel to create a new screen for your e-ink display</p>
        </div>

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">{error}</div>
        )}

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Settings */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-6 space-y-5">
              <h2 className="text-lg font-semibold text-text-primary">New Screen</h2>

              {loadingDashboards ? (
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <LoadingSpinner size="sm" /> Connecting to Grafana...
                </div>
              ) : dashboards.length === 0 && !error ? (
                <div className="text-sm text-text-muted">
                  Could not load dashboards. Check your connection settings.
                </div>
              ) : dashboards.length > 0 && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1.5">Dashboard</label>
                    <select value={screenDashboard} onChange={(e) => handleDashboardChange(e.target.value)} className={inputClasses}>
                      <option value="">Choose a dashboard...</option>
                      {dashboards.map((d) => <option key={d.uid} value={d.uid}>{d.title}</option>)}
                    </select>
                  </div>

                  {loadingPanels && (
                    <div className="flex items-center gap-2 text-sm text-text-muted">
                      <LoadingSpinner size="sm" /> Loading panels...
                    </div>
                  )}

                  {panels.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1.5">Panel</label>
                      <PanelSelect panels={panels} value={screenPanel} onChange={setScreenPanel} className={inputClasses} />
                      <p className="mt-1.5 text-xs text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2">
                        For 800x480 resolution, individual panels are recommended. Entire sections work best at higher resolutions where multiple panels can be displayed in a grid.
                      </p>
                    </div>
                  )}

                  {screenPanel && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                          <select
                            value={customResolution ? 'custom' : `${screenWidth}x${screenHeight}`}
                            onChange={(e) => {
                              if (e.target.value === 'custom') {
                                setCustomResolution(true);
                              } else {
                                setCustomResolution(false);
                                const [w, h] = e.target.value.split('x').map(Number);
                                setScreenWidth(w);
                                setScreenHeight(h);
                              }
                            }}
                            className={inputClasses}
                          >
                            <option value="800x480">800 x 480 — Landscape</option>
                            <option value="480x800">480 x 800 — Portrait</option>
                            <option value="custom">Custom</option>
                          </select>
                          {customResolution && (
                            <div className="flex items-center gap-2 mt-2">
                              <input type="number" value={screenWidth} onChange={(e) => setScreenWidth(Number(e.target.value) || 800)} className={inputClasses} min={100} max={3840} placeholder="Width" />
                              <span className="text-text-muted shrink-0">x</span>
                              <input type="number" value={screenHeight} onChange={(e) => setScreenHeight(Number(e.target.value) || 480)} className={inputClasses} min={100} max={2160} placeholder="Height" />
                              <span className="text-xs text-text-muted shrink-0">px</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-text-primary mb-1.5">Screen Name (optional)</label>
                        <input type="text" value={screenName} onChange={(e) => setScreenName(e.target.value)} className={inputClasses} placeholder="Auto-generated from dashboard/panel" />
                      </div>

                      <button
                        onClick={handleGenerate}
                        disabled={generating}
                        className="w-full inline-flex items-center justify-center px-4 py-3 rounded-lg text-sm font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        {generating ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                        ) : (
                          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                        Save Screen
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: Preview + Existing Screens */}
          <div className="space-y-6">
            {/* Live Preview */}
            {previewInstanceId && (
              <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-4">
                <h3 className="text-base font-semibold text-text-primary mb-3">Preview</h3>
                <GrafanaPreview instanceId={previewInstanceId} timestamp={previewTimestamp} />
              </div>
            )}

            {/* Existing Screens */}
            {childScreens.length > 0 && (
              <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light p-4">
                <h3 className="text-base font-semibold text-text-primary mb-3">
                  Existing Screens
                  <span className="ml-2 text-xs font-normal text-text-muted">({childScreens.length})</span>
                </h3>
                <div className="rounded-lg border border-border-light overflow-hidden divide-y divide-border-light">
                  {childScreens.map((child) => {
                    const name = child.name || 'Grafana Screen';
                    const parts = name.split(' — ');
                    const dashboard = parts[0];
                    const panel = parts.length > 1 ? parts.slice(1).join(' — ') : null;
                    const timeRange = String(child.settings.time_range || 'now-6h');
                    const resolution = child.settings.screen_width && child.settings.screen_height
                      ? `${child.settings.screen_width}x${child.settings.screen_height}`
                      : null;

                    return (
                      <div key={child.id} className="flex items-center gap-3 px-3 py-2.5 bg-bg-muted/50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text-primary truncate">
                            {panel || dashboard}
                          </p>
                          <p className="text-xs text-text-muted truncate">
                            {panel ? dashboard : ''}{panel ? ' · ' : ''}{timeRange}{resolution ? ` · ${resolution}` : ''}
                          </p>
                        </div>
                        <button
                          onClick={() => navigate(`/plugins/instances/${child.id}?from=/plugins/instances/${instanceId}/generate`)}
                          className="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors"
                          title="Settings"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}

function PanelSelect({ panels, value, onChange, className }: {
  panels: GrafanaPanel[]; value: string; onChange: (v: string) => void; className: string;
}) {
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
              {p.type === 'row' ? `\u25B8 Entire section` : `${p.title} (${p.type})`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function GrafanaPreview({ instanceId, timestamp }: { instanceId: number; timestamp: number }) {
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setHasError(false);
  }, [timestamp]);

  return (
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
  );
}
