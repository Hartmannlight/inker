import { INTERACTION_LIMITS, parseCommandResult, parseTimerFeed, TIMER_FEED_LIMITS,
  type AllowedAction, type InteractionEvent, type JsonObject, type TimerFeed, type TimerSnapshot } from '@inker/contracts';

export type TimerAction = 'timer.create' | 'timer.pause' | 'timer.resume' | 'timer.cancel' | 'timer.acknowledge';
type Context = { deviceId: string; credentialId: string; publicationId: string | null; revision: string | null; allowedActions: AllowedAction[] };
export interface TimerClientState {
  feed: TimerFeed | null; context: Context | null; status: 'loading' | 'ready' | 'offline' | 'unauthorized';
  busy: boolean; retryAvailable: boolean; message: string;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const MAX_SERVER_TIME = 253_402_300_799_999;
function context(input: unknown, deviceId: string): Context {
  const value = input as Record<string, unknown> | null;
  if (!value || value.protocolVersion !== '1.0' || value.deviceId !== deviceId || !id(value.credentialId)
    || !(value.publicationId === null || id(value.publicationId))
    || !(value.revision === null || typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 128)
    || !Array.isArray(value.allowedActions) || value.allowedActions.length > 16) throw new Error();
  const allowedActions = value.allowedActions.map((entry): AllowedAction => {
    if (!entry || typeof entry !== 'object' || typeof entry.action !== 'string' || entry.action.length > 64
      || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(entry.action)
      || entry.payloadSchemaVersion !== '1.0' || entry.targetId !== undefined && !id(entry.targetId)) throw new Error();
    return { action: entry.action, payloadSchemaVersion: '1.0', ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }) };
  });
  return { deviceId, credentialId: value.credentialId, publicationId: value.publicationId, revision: value.revision, allowedActions };
}
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > limit || !response.body) {
    await response.body?.cancel().catch(() => undefined); throw new Error();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
const unwrap = (value: unknown): unknown => value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value;

/** One in-flight feed refresh and one command. No periodic network polling. */
export class TimerClient {
  private readonly apiUrl: string;
  private readonly deviceId: string;
  private readonly credential: string;
  private readonly notify: (state: TimerClientState) => void;
  private readonly unauthorized: () => void;
  private readonly requests = new Set<AbortController>();
  private disposed = false;
  private epoch = 0;
  private connected = false;
  private dirty = false;
  private refreshing?: Promise<void>;
  private etag?: string;
  private clock?: { server: number; performance: number };
  private pending?: { event: InteractionEvent; body: string };
  state: TimerClientState = { feed: null, context: null, status: 'loading', busy: false, retryAvailable: false, message: 'Timer werden geladen…' };
  constructor(apiUrl: string, deviceId: string, credential: string, notify: (state: TimerClientState) => void, unauthorized: () => void) {
    const base = new URL(apiUrl, window.location.origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('TIMER_ENDPOINT_INVALID');
    this.apiUrl = base.toString().replace(/\/$/, ''); this.deviceId = deviceId; this.credential = credential;
    this.notify = notify; this.unauthorized = unauthorized;
  }
  private update(patch: Partial<TimerClientState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.notify(this.state);
  }
  serverNow(): number | null {
    return this.clock ? Math.min(MAX_SERVER_TIME, this.clock.server + Math.max(0, performance.now() - this.clock.performance)) : null;
  }
  remaining(timer: TimerSnapshot): number {
    if (timer.status === 'paused') return timer.pausedRemainingMs!;
    const now = this.serverNow();
    // Server clock corrections cannot undo a persisted domain evaluation.
    return timer.status === 'running' && now !== null
      ? Math.max(0, Date.parse(timer.endsAt!) - Math.max(now, Date.parse(timer.evaluatedAt))) : 0;
  }
  setConnected(value: boolean) {
    if (this.disposed || this.connected === value) return;
    this.connected = value;
    if (!value) {
      this.epoch++; for (const request of this.requests) request.abort();
      this.refreshing = undefined; this.dirty = false;
      this.update({ status: 'offline', context: null, busy: false, retryAvailable: !!this.pending, message: 'Offline – letzter bestätigter Timerzustand.' });
    }
  }
  // React StrictMode repeats effect setup/cleanup on the same memoized instance.
  activate() { if (this.disposed) { this.disposed = false; this.connected = false; this.refreshing = undefined; this.dirty = false; } }
  dispose() { this.disposed = true; this.epoch++; for (const request of this.requests) request.abort(); this.requests.clear(); this.pending = undefined; }
  private async request(path: string, init: RequestInit = {}, limit = TIMER_FEED_LIMITS.maxBytes) {
    const epoch = this.epoch, abort = new AbortController(); this.requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 8000), started = performance.now();
    try {
      const response = await fetch(`${this.apiUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${this.credential}` },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal });
      if (this.disposed || epoch !== this.epoch) throw new Error();
      if (response.status === 401) {
        this.pending = undefined; this.clock = undefined; this.etag = undefined;
        this.connected = false; this.epoch++;
        this.update({ feed: null, context: null, status: 'unauthorized', busy: false, retryAvailable: false, message: 'Kopplung ist nicht mehr gültig.' });
        this.unauthorized(); throw new Error();
      }
      if (!response.ok && response.status !== 304) throw new Error();
      const data = response.status === 304 ? undefined : await boundedJson(response, limit);
      if (this.disposed || epoch !== this.epoch) throw new Error();
      return { response, data, started, received: performance.now() };
    } finally { clearTimeout(timeout); this.requests.delete(abort); }
  }
  refresh(): Promise<void> {
    if (this.disposed || !this.connected || this.state.status === 'unauthorized') return Promise.resolve();
    this.dirty = true;
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const running = (async () => {
      do {
        this.dirty = false;
        try {
          const loaded = await this.request('/timers', this.etag ? { headers: { 'If-None-Match': this.etag } } : {});
          const body = loaded.response.status === 304 ? this.state.feed : loaded.data;
          const serverTime = loaded.response.headers.get('X-Server-Time');
          const parsed = parseTimerFeed(serverTime && body && typeof body === 'object' ? { ...body, serverTime } : body);
          if (!parsed.success || loaded.response.status === 304 && !serverTime) throw new Error();
          this.clock = { server: Date.parse(parsed.data.serverTime) + Math.max(0, loaded.received - loaded.started) / 2, performance: loaded.received };
          const etag = loaded.response.headers.get('ETag');
          this.etag = etag && etag.length <= 128 && /^(?:W\/)?"[A-Za-z0-9_-]+"$/.test(etag) ? etag : undefined;
          this.update({ feed: parsed.data });
          const loadedContext = await this.request('/interactions/context', {}, INTERACTION_LIMITS.messageBytes);
          this.update({ context: context(unwrap(loadedContext.data), this.deviceId), status: 'ready', message: '' });
        } catch {
          if (!this.disposed && epoch === this.epoch && this.state.status !== 'unauthorized') this.update({ context: null, status: 'offline', message: 'Timerabruf fehlgeschlagen – letzter bestätigter Zustand.' });
        }
      } while (this.dirty && epoch === this.epoch && !this.disposed && this.connected && this.state.status !== 'unauthorized');
    })();
    this.refreshing = running;
    void running.finally(() => { if (this.refreshing === running) this.refreshing = undefined; });
    return running;
  }
  allowed(action: TimerAction): boolean { return !!this.state.context?.allowedActions.some(item => item.action === action && item.payloadSchemaVersion === '1.0'); }
  async command(action: TimerAction, payload: JsonObject): Promise<void> {
    const current = this.state.context, permission = current?.allowedActions.find(item => item.action === action);
    if (this.disposed || !this.connected || this.state.busy || this.pending || !current?.publicationId || !current.revision || !permission || this.serverNow() === null) return;
    const event: InteractionEvent = { protocolVersion: '1.0', eventId: uuid(), deviceId: current.deviceId, credentialId: current.credentialId,
      publicationId: current.publicationId, revision: current.revision, action, payload, occurredAt: new Date(this.serverNow()!).toISOString(),
      ...(permission.targetId === undefined ? {} : { targetId: permission.targetId }) };
    this.pending = { event, body: JSON.stringify(event) };
    await this.retry();
  }
  async retry(): Promise<void> {
    const pending = this.pending;
    const epoch = this.epoch;
    if (!pending || this.state.busy || !this.connected || this.disposed) return;
    this.update({ busy: true, retryAvailable: false, message: 'Befehl wird bestätigt…' });
    try {
      const loaded = await this.request('/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pending.body }, INTERACTION_LIMITS.messageBytes);
      const parsed = parseCommandResult(unwrap(loaded.data));
      if (!parsed.success || parsed.data.eventId !== pending.event.eventId || !id(parsed.data.commandId)) throw new Error();
      this.pending = undefined;
      this.update({ busy: false, retryAvailable: false, message: parsed.data.status === 'rejected' ? 'Befehl abgelehnt. Zustand wird aktualisiert.' : '' });
      await this.refresh();
    } catch {
      if (!this.disposed && epoch === this.epoch && this.state.status !== 'unauthorized') this.update({ busy: false, retryAvailable: !!this.pending,
        message: 'Bestätigung fehlt. Wiederholen verwendet denselben Befehl.' });
    }
  }
}
