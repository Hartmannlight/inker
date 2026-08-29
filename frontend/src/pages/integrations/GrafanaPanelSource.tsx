import { useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../../services/api';
import { MainLayout } from '../../components/layout';
import { useNotification } from '../../contexts/NotificationContext';

const input = 'w-full rounded-lg border border-border-light bg-bg-input px-3 py-2.5 text-text-primary';
const sourceHelp: Record<string, string> = {
  GRAFANA_AUTH_INVALID: 'Grafana rejected the Viewer token (401). Create or enter a valid Viewer token.',
  GRAFANA_PERMISSION_DENIED: 'The token is authenticated but lacks Viewer access (403).',
  GRAFANA_RENDERER_UNAVAILABLE: 'Grafana Image Renderer is unavailable for this panel.',
  GRAFANA_NETWORK_BLOCKED: 'The target is blocked by the network policy. Enable private-network access only for a trusted local host.',
  GRAFANA_DNS_FAILED: 'The Grafana hostname could not be resolved.',
  GRAFANA_TLS_FAILED: 'Grafana TLS validation failed. Inker does not bypass certificate errors.',
  GRAFANA_TIMEOUT: 'Grafana did not respond before the worker timeout.',
};

function responseMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Creates a durable worker source; it never probes Grafana from the browser. */
export function GrafanaPanelSource() {
  const notification = useNotification();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publicationResult, setPublicationResult] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', baseUrl: '', token: '', dashboardUid: '', panelId: '', width: '800', height: '480', allowLocalNetwork: false });
  const set = (key: keyof typeof form, value: string | boolean) => setForm(previous => ({ ...previous, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const panelId = Number(form.panelId), width = Number(form.width), height = Number(form.height);
    if (!form.name.trim() || !form.baseUrl.trim() || !form.token || !form.dashboardUid || !Number.isSafeInteger(panelId) || panelId < 1) {
      notification.error('Enter a source name, URL, Viewer token, dashboard UID and positive panel ID.'); return;
    }
    setSaving(true); setResult(null);
    try {
      const response = await apiClient.post('/sources', { protocolVersion: '1.0', name: form.name.trim(), connectorType: 'grafana', schemaVersion: '1',
        configuration: { operation: 'render', baseUrl: form.baseUrl.trim(), dashboardUid: form.dashboardUid.trim(), panelId, width, height, allowLocalNetwork: form.allowLocalNetwork },
        secret: form.token, refreshIntervalSeconds: 300, timeoutMs: 7500, concurrencyGroup: 'grafana', enabled: true });
      const id = response.data?.definition?.sourceDefinitionId ?? response.data?.data?.definition?.sourceDefinitionId;
      setForm(previous => ({ ...previous, token: '' }));
      setSourceId(typeof id === 'string' ? id : null); setSnapshotId(null); setStatus(null); setPublicationResult(null);
      setResult(id ? `Panel source queued: ${id}` : 'Panel source queued.');
      notification.success('Grafana panel refresh queued.');
    } catch (error: unknown) {
      const code = responseMessage(error);
      notification.error(code === 'SOURCE_INVALID_CONFIGURATION' ? 'Check the URL, panel and image dimensions.' : 'Could not queue the Grafana panel source.');
    } finally { setSaving(false); }
  }

  async function checkStatus() {
    if (!sourceId) return;
    try {
      const response = await apiClient.get(`/sources/${encodeURIComponent(sourceId)}`);
      const source = response.data?.data ?? response.data;
      const snapshot = source?.snapshot;
      const code = snapshot?.error?.code;
      setSnapshotId(!code && (snapshot?.freshness?.state === 'fresh' || snapshot?.freshness?.state === 'stale') && typeof snapshot?.snapshotId === 'string'
        ? snapshot.snapshotId : null);
      setStatus(code ? (sourceHelp[code] ?? `Last refresh failed: ${code}`) : snapshot ? `Last refresh: ${snapshot.freshness?.state ?? 'available'}` : 'Refresh is queued or waiting for a worker.');
    } catch { setStatus('Status is currently unavailable.'); }
  }
  async function retry() {
    if (!sourceId) return;
    try { await apiClient.post(`/sources/${encodeURIComponent(sourceId)}/refresh`); setStatus('Refresh retry queued.'); }
    catch { setStatus('Could not queue a retry.'); }
  }
  async function createPublication() {
    if (!sourceId || !snapshotId) return;
    setPublishing(true); setPublicationResult(null);
    const publicationKey = `grafana-${sourceId}`;
    try {
      let expectedRevision = 0;
      try {
        const existing = await apiClient.get(`/publications/${publicationKey}`);
        const publication = existing.data?.data ?? existing.data;
        expectedRevision = Math.max(0, ...(Array.isArray(publication?.revisions) ? publication.revisions.map((item: { revision?: unknown }) =>
          Number.isSafeInteger(item.revision) ? item.revision as number : 0) : []));
      } catch (error: unknown) {
        if (responseStatus(error) !== 404) throw error;
      }
      const response = await apiClient.post(`/publications/${publicationKey}/publish`, {
        idempotencyKey: crypto.randomUUID(), expectedRevision, deviceIds: [], allowedActions: [], draft: { sourceSnapshotId: snapshotId },
      });
      const result = response.data?.data ?? response.data;
      setPublicationResult(`Publication draft revision ${result?.revision ?? 'created'} is ready for device assignment.`);
      notification.success('Grafana publication draft created.');
    } catch {
      setPublicationResult('Could not create the publication draft. Refresh status and try again.');
    } finally { setPublishing(false); }
  }

  return <MainLayout><div className="mx-auto max-w-2xl space-y-6">
    <div><Link to="/integrations" className="text-sm text-accent hover:underline">← Integrations</Link>
      <h1 className="mt-3 text-2xl font-bold text-text-primary">Grafana panel source</h1>
      <p className="mt-1 text-sm text-text-muted">Beta. The Viewer token is write-only and used only by the Inker source worker.</p></div>
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border-light bg-bg-card p-6">
      <label className="block text-sm">Source name<input className={input} value={form.name} onChange={e => set('name', e.target.value)} /></label>
      <label className="block text-sm">Grafana base URL<input className={input} inputMode="url" value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder="https://grafana.example" /></label>
      <label className="block text-sm">Viewer service-account token<input className={input} type="password" autoComplete="new-password" value={form.token} onChange={e => set('token', e.target.value)} /></label>
      <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm">Dashboard UID<input className={input} value={form.dashboardUid} onChange={e => set('dashboardUid', e.target.value)} /></label>
        <label className="block text-sm">Panel ID<input className={input} type="number" min="1" value={form.panelId} onChange={e => set('panelId', e.target.value)} /></label></div>
      <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm">Width<input className={input} type="number" min="1" max="2048" value={form.width} onChange={e => set('width', e.target.value)} /></label>
        <label className="block text-sm">Height<input className={input} type="number" min="1" max="2048" value={form.height} onChange={e => set('height', e.target.value)} /></label></div>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={form.allowLocalNetwork} onChange={e => set('allowLocalNetwork', e.target.checked)} />
        <span>Allow this source to reach a private-network Grafana host.</span></label>
      <button disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-inverse disabled:opacity-50">{saving ? 'Queueing…' : 'Queue panel refresh'}</button>
      {result && <p className="text-sm text-status-success-text">{result}</p>}
      {sourceId && <div className="flex flex-wrap items-center gap-3 border-t border-border-light pt-4">
        <button type="button" onClick={checkStatus} className="rounded-lg border border-border-light px-3 py-2 text-sm">Check status</button>
        <button type="button" onClick={retry} className="rounded-lg border border-border-light px-3 py-2 text-sm">Retry refresh</button>
        {snapshotId && <button type="button" onClick={createPublication} disabled={publishing} className="rounded-lg border border-border-light px-3 py-2 text-sm disabled:opacity-50">{publishing ? 'Creating draft…' : 'Create publication draft'}</button>}
        {status && <span className="text-sm text-text-muted">{status}</span>}
      </div>}
      {publicationResult && <p className="text-sm text-text-muted">{publicationResult}</p>}
    </form>
    <p className="text-xs text-text-muted">The source worker validates the connection and renderer asynchronously. 401, 403, DNS, TLS, timeout, blocked-network and renderer errors are recorded as source status.</p>
  </div></MainLayout>;
}
