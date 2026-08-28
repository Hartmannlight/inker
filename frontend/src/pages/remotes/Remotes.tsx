import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { REMOTE_SUBSCRIPTION_LIMITS, type RemoteSubscriptionView } from '@inker/contracts';
import { MainLayout } from '../../components/layout';
import { Button, Input } from '../../components/common';
import { normalizeRemoteCreate, remoteApi, remoteErrorMessage, RemoteApiError, type RemoteCreateInput, type RemoteDeviceChoice } from './remote-api';

const card = 'bg-bg-card border border-border-light rounded-xl p-6 shadow-theme-sm';
const selectClass = 'w-full bg-bg-input border-2 border-border-light rounded-xl px-4 py-2.5 text-text-primary';
type Perform = (operation: (signal: AbortSignal) => Promise<unknown>, message: string) => Promise<boolean>;

function CreateRemote({ busy, full, perform }: { busy: boolean; full: boolean; perform: Perform }) {
  const [name, setName] = useState(''), [baseUrl, setBaseUrl] = useState(''), [serverId, setServerId] = useState('');
  const [publicationId, setPublicationId] = useState(''), [token, setToken] = useState('');
  const [interval, setInterval] = useState('300'), [trust, setTrust] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || full) return;
    let input: RemoteCreateInput;
    try { input = normalizeRemoteCreate({ name, baseUrl, serverId, publicationId, token, trust, refreshIntervalSeconds: Number(interval) }); }
    catch (error) { setError(remoteErrorMessage(error)); return; }
    setError(''); setToken('');
    if (await perform(signal => remoteApi.create(input, signal), 'Subscription created. Synchronisation is pending.')) {
      setName(''); setBaseUrl(''); setServerId(''); setPublicationId(''); setTrust(false);
    }
  };
  return <form className={card} onSubmit={event => { void submit(event); }} aria-label="Create remote subscription" autoComplete="off">
    <h2 className="text-xl font-bold text-text-primary">Add a trusted remote publication</h2>
    <p className="mt-2 text-sm text-text-muted">Verify the server ID with its operator using a separate trusted channel. Discovery does not grant trust. The home server must explicitly allow this HTTPS origin.</p>
    <fieldset disabled={busy || full} className="mt-5 space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="Remote name" value={name} onChange={e => setName(e.target.value)} required maxLength={100} />
        <Input label="HTTPS base URL" type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required maxLength={2048} placeholder="https://remote.example" />
        <Input label="Expected remote server ID" value={serverId} onChange={e => setServerId(e.target.value)} required maxLength={36} helperText="The remote's stable UUID, verified manually." />
        <Input label="Remote publication ID" value={publicationId} onChange={e => setPublicationId(e.target.value)} required maxLength={100} />
        <Input label="Share token" type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} required maxLength={73} helperText="Read-only access to this one publication. Never stored in this browser." />
        <Input label="Refresh interval (seconds)" type="number" min={60} max={86400} step={1} value={interval} onChange={e => setInterval(e.target.value)} required />
      </div>
      <label className="flex items-start gap-3 text-sm text-text-secondary"><input className="mt-1" type="checkbox" checked={trust} onChange={e => setTrust(e.target.checked)} required />
        I verified the server ID with its operator and trust this remote.</label>
      {error && <p role="alert" className="text-status-error-text">{error}</p>}
      <Button type="submit" disabled={!trust}>Create subscription</Button>
      {full && <p className="text-text-muted">The limit of {REMOTE_SUBSCRIPTION_LIMITS.maxRows} subscriptions has been reached.</p>}
    </fieldset>
  </form>;
}

function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value} title={value}>{new Date(value).toLocaleString()}</time> : <>Never</>;
}
function SubscriptionCard({ value, devices, busy, perform }: {
  value: RemoteSubscriptionView; devices: RemoteDeviceChoice[]; busy: boolean; perform: Perform;
}) {
  const [token, setToken] = useState(''), [deviceId, setDeviceId] = useState('');
  const labels = { pending: 'Pending first sync', fresh: 'Fresh', stale: 'Stale · using local cache', error: 'Sync error', disabled: 'Paused' };
  const cached = value.localPublicationRevisionId !== null;
  const rotate = (event: FormEvent) => {
    event.preventDefault(); if (busy || !token) return;
    const replacement = token; setToken('');
    void perform(signal => remoteApi.update(value.subscriptionId, { token: replacement }, signal), 'Share token replaced. Sync again to verify access.');
  };
  return <article className={card} aria-label={`Remote ${value.name}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs uppercase tracking-wide text-text-muted">Remote · explicitly trusted</p><h2 className="mt-1 text-xl font-bold text-text-primary break-words">{value.name}</h2></div>
      <span className={`rounded-full px-3 py-1 text-sm font-semibold ${value.status === 'fresh' ? 'bg-status-success-bg text-status-success-text' : 'bg-bg-muted text-text-secondary'}`}>{labels[value.status]}</span>
    </div>
    <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
      <div className="min-w-0"><dt className="text-text-muted">Remote HTTPS origin</dt><dd className="break-all text-text-primary">{value.baseUrl}</dd></div>
      <div className="min-w-0"><dt className="text-text-muted">Trusted remote server ID</dt><dd className="break-all font-mono text-text-primary">{value.serverId}</dd></div>
      <div className="min-w-0"><dt className="text-text-muted">Remote publication / revision</dt><dd className="break-all text-text-primary">{value.remotePublicationId} / {value.remoteRevision ?? 'not synced'}</dd></div>
      <div className="min-w-0"><dt className="text-text-muted">Local cached publication</dt><dd className="break-all text-text-primary">{value.localPublicationId}</dd></div>
      <div><dt className="text-text-muted">Last attempt</dt><dd><Timestamp value={value.lastAttemptAt} /></dd></div>
      <div><dt className="text-text-muted">Last successful sync</dt><dd><Timestamp value={value.lastSuccessAt} /></dd></div>
      <div><dt className="text-text-muted">Next sync</dt><dd>{value.enabled ? <Timestamp value={value.nextSyncAt} /> : 'Paused'}</dd></div>
      <div><dt className="text-text-muted">Assigned local devices</dt><dd>{value.deviceIds.length ? value.deviceIds.map(id => devices.find(device => device.id === id)?.name ?? `Device ${id}`).join(', ') : 'None'}</dd></div>
    </dl>
    <p className="mt-4 text-sm text-text-muted">{cached ? 'A verified copy is stored on this home server. Displays use the local copy, even when the remote is unavailable.' : 'No verified local copy yet. Device assignment is unavailable until the first successful sync.'}</p>
    {value.lastErrorCode && <div className="mt-3 rounded-lg bg-bg-muted p-3 text-sm text-status-error-text">
      <p className="font-mono">{value.lastErrorCode}</p><p>{remoteErrorMessage(new RemoteApiError(value.lastErrorCode))}</p>
    </div>}
    <div className="mt-5 flex flex-wrap gap-3">
      <Button type="button" size="sm" disabled={busy || !value.enabled} onClick={() => { void perform(signal => remoteApi.sync(value.subscriptionId, signal), 'Synchronisation scheduled. Status will refresh automatically.'); }}>Sync now</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void perform(signal => remoteApi.update(value.subscriptionId, { enabled: !value.enabled }, signal), value.enabled ? 'Subscription paused. Its local cache is retained.' : 'Subscription enabled.'); }}>{value.enabled ? 'Pause subscription' : 'Enable subscription'}</Button>
    </div>
    <div className="mt-5 grid gap-5 border-t border-border-light pt-5 md:grid-cols-2">
      <form onSubmit={rotate} autoComplete="off" className="space-y-3">
        <Input id={`token-${value.subscriptionId}`} label="Replacement share token" type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} required maxLength={73} disabled={busy} />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !token}>Replace token</Button>
      </form>
      <div className="space-y-3">
        <label htmlFor={`device-${value.subscriptionId}`} className="block text-sm font-semibold text-text-secondary">Local device</label>
        <select id={`device-${value.subscriptionId}`} className={selectClass} value={deviceId} onChange={e => setDeviceId(e.target.value)} disabled={busy || !cached || !devices.length}>
          <option value="">Choose a local device</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name} (#{device.id})</option>)}
        </select>
        <Button type="button" size="sm" variant="outline" disabled={busy || !cached || !deviceId} onClick={() => { void perform(signal => remoteApi.assign(value.subscriptionId, Number(deviceId), signal), 'Local cached publication assigned to the device.'); }}>Assign local copy</Button>
        <p className="text-xs text-text-muted">Replaces the device’s current publication. The device never connects directly to the remote.</p>
      </div>
    </div>
  </article>;
}

export function Remotes() {
  const [rows, setRows] = useState<RemoteSubscriptionView[] | null>(null), [devices, setDevices] = useState<RemoteDeviceChoice[]>([]);
  const [deviceTotal, setDeviceTotal] = useState(0), [deviceError, setDeviceError] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const mounted = useRef(false), locked = useRef(false), requests = useRef(new Set<AbortController>()), currentRead = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    currentRead.current?.abort();
    const controller = new AbortController(); currentRead.current = controller; requests.current.add(controller);
    setLoading(true);
    try {
      const next = await remoteApi.list(controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setRows(next); setError('');
      try {
        const choices = await remoteApi.devices(controller.signal);
        if (!controller.signal.aborted && mounted.current) { setDevices(choices.items); setDeviceTotal(choices.total); setDeviceError(''); }
      } catch (error) { if (!controller.signal.aborted && mounted.current) setDeviceError(remoteErrorMessage(error)); }
    } catch (error) { if (!controller.signal.aborted && mounted.current) setError(remoteErrorMessage(error)); }
    finally {
      requests.current.delete(controller);
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = window.setInterval(() => { if (!locked.current && document.visibilityState === 'visible') void reload(); }, 15000);
    const activeRequests = requests.current;
    return () => { mounted.current = false; window.clearInterval(timer); for (const request of activeRequests) request.abort(); activeRequests.clear(); };
  }, [reload]);
  const perform: Perform = async (operation, successMessage) => {
    if (locked.current || !mounted.current) return false;
    currentRead.current?.abort(); setLoading(false);
    locked.current = true; setBusy(true); setError(''); setMessage('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted || !mounted.current) return false;
      setMessage(successMessage); await reload(); return true;
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setError(remoteErrorMessage(error));
      return false;
    } finally { requests.current.delete(controller); locked.current = false; if (mounted.current) setBusy(false); }
  };
  return <MainLayout><div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold text-text-primary">Remote publications</h1>
      <p className="mt-2 text-text-muted">Your home server imports trusted publications and serves verified local copies to its devices.</p></div>
      <Button variant="outline" disabled={busy || loading} onClick={() => { void reload(); }}>Refresh status</Button></div>
    {error && <div role="alert" className="rounded-xl border border-status-error-border p-4 text-status-error-text">{error}{rows !== null && <p>The displayed status may be out of date.</p>}</div>}
    {message && <p role="status" className="text-status-success-text">{message}</p>}
    {loading && rows === null && <p role="status">Loading remote subscriptions…</p>}
    {deviceError && <p role="alert" className="text-status-error-text">Device list: {deviceError}</p>}
    {deviceTotal > devices.length && <p className="text-sm text-text-muted">Showing the first {devices.length} of {deviceTotal} local devices.</p>}
    <CreateRemote busy={busy || rows === null} full={(rows?.length ?? 0) >= REMOTE_SUBSCRIPTION_LIMITS.maxRows} perform={perform} />
    {rows?.length === 0 && <p className="text-text-muted">No remote subscriptions configured.</p>}
    {rows?.map(value => <SubscriptionCard key={value.subscriptionId} value={value} devices={devices} busy={busy} perform={perform} />)}
  </div></MainLayout>;
}
