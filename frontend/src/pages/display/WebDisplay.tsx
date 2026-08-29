import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { config } from '../../config';
import { comparePresentationRevisions, parseDeviceServerMessage, type WebDisplayManifest } from '@inker/contracts';
import { TimerTestPanel } from './TimerTestPanel';

type PresentationManifest = WebDisplayManifest;

type ConnectionState = 'connecting' | 'connected' | 'offline' | 'unpaired' | 'error';

const UNPAIRED_MESSAGE = 'Dieses Display ist noch nicht gekoppelt.';

export function WebDisplay() {
  const { externalId: routeExternalId = '' } = useParams<{ externalId: string }>();
  const initialExternalId = routeExternalId;
  const initialSearch = useRef(new URLSearchParams(window.location.search));
  const [timerTest] = useState(() => initialSearch.current.get('test') === 'timers');
  const [timerRefreshSignal, setTimerRefreshSignal] = useState(0);
  const [activeExternalId] = useState(initialExternalId);
  const initialStorageKey = initialExternalId ? `inker_display_${initialExternalId}` : null;
  const [credential, setCredential] = useState(() => initialStorageKey ? localStorage.getItem(initialStorageKey) : null);
  const [connectionApiUrl] = useState(config.apiUrl);
  const [presentation, setPresentation] = useState<PresentationManifest | null>(null);
  const displayedBlob = useRef<string | null>(null);
  const displayedRevision = useRef<Pick<WebDisplayManifest, 'revision' | 'renderRevision'>>({ revision: -1 });
  const displayedIdentity = useRef<string | null>(null);
  useEffect(() => () => { if (displayedBlob.current) URL.revokeObjectURL(displayedBlob.current); }, []);
  const [state, setState] = useState<ConnectionState>(credential ? 'connecting' : 'unpaired');
  const [message, setMessage] = useState(
    credential ? 'Connecting to Inker…' : UNPAIRED_MESSAGE,
  );
  const storageKey = activeExternalId ? `inker_display_${activeExternalId}` : null;

  const timerUnauthorized = useCallback(() => {
    if (storageKey && localStorage.getItem(storageKey) === credential) localStorage.removeItem(storageKey);
    setCredential(storageKey ? localStorage.getItem(storageKey) : null);
    setState('unpaired');
    setMessage('Pairing is no longer valid. Open the Inker start page to pair again.');
  }, [storageKey, credential]);

  useEffect(() => {
    if (!credential || !activeExternalId || !storageKey) return;
    const identity = `${new URL(connectionApiUrl, window.location.origin).toString()}|${activeExternalId}`;
    // Credential rotation/reconnect preserves the same device's last image. A
    // different device or server has its own revision namespace and private image.
    if (displayedIdentity.current !== identity) {
      displayedIdentity.current = identity;
      displayedRevision.current = { revision: -1 };
      if (displayedBlob.current) URL.revokeObjectURL(displayedBlob.current);
      displayedBlob.current = null;
      setPresentation(null);
    }
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let authenticated = false;
    let stopped = false;
    let attempt = 0;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => socket?.close(4408, 'Server heartbeat timeout'), 45_000);
    };

    const connect = () => {
      if (stopped) return;
      setState((current) => current === 'connected' ? current : 'connecting');
      const apiUrl = new URL(connectionApiUrl, window.location.origin);
      apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      apiUrl.pathname = `${apiUrl.pathname.replace(/\/$/, '')}/device-connect`;
      apiUrl.search = '';
      socket = new WebSocket(apiUrl.toString());

      socket.onopen = () => {
        armWatchdog();
        socket?.send(JSON.stringify({
          protocolVersion: '1.0',
          type: 'authenticate',
          externalId: activeExternalId,
          token: credential,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }));
      };
      socket.onmessage = (event) => {
        try {
          const parsed = parseDeviceServerMessage(JSON.parse(event.data));
          if (!parsed.success) throw new Error();
          const data = parsed.data;
          if (data.type === 'connected') {
            attempt = 0;
            authenticated = true;
            armWatchdog();
            setState('connected');
            setMessage('Connected');
            if (timerTest) setTimerRefreshSignal(value => value + 1);
          } else if (data.type === 'presentation.changed') {
            void preloadPresentation(data.presentation);
            if (timerTest) setTimerRefreshSignal(value => value + 1);
          } else if (data.type === 'timers.changed') {
            if (timerTest) setTimerRefreshSignal(value => value + 1);
          } else if (data.type === 'ping') {
            armWatchdog();
            socket?.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: data.nonce }));
          }
        } catch {
          socket?.close(4400, 'Unsupported device protocol');
        }
      };
      socket.onclose = (event) => {
        authenticated = false;
        if (watchdog) clearTimeout(watchdog);
        if (stopped) return;
        if (event.code === 4400) {
          stopped = true;
          setState('error');
          setMessage('Display protocol is incompatible. Reload or update this display.');
          return;
        }
        if (event.code === 4401) {
          const storedCredential = localStorage.getItem(storageKey);
          if (storedCredential === credential) {
            localStorage.removeItem(storageKey);
            setCredential(null);
          } else {
            setCredential(storedCredential);
          }
          setState('unpaired');
          setMessage('Pairing is no longer valid. Open the Inker start page to pair again.');
          return;
        }
        setState('offline');
        setMessage('Connection lost. Reconnecting…');
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    const preloadPresentation = async (next: PresentationManifest) => {
      if (comparePresentationRevisions(next, displayedRevision.current) <= 0) return;
      let blobUrl: string | null = null;
      try {
        let url = new URL(next.content.url, window.location.origin).toString();
        if (/^\/api\/web-displays\/[A-Za-z0-9_-]+\/artifacts\/[a-f0-9]{64}$/.test(next.content.url)) {
          // Device credentials stay in headers. Never put a token in an img URL,
          // use admin cookies, or forward authorization across a redirect.
          url = new URL(next.content.url, new URL(connectionApiUrl, window.location.origin)).toString();
          const response = await fetch(url, { headers: { Authorization: `Bearer ${credential}` }, credentials: 'omit', redirect: 'error' });
          if (!response.ok) throw new Error();
          blobUrl = URL.createObjectURL(await response.blob());
          url = blobUrl;
        }
        if (stopped) { if (blobUrl) URL.revokeObjectURL(blobUrl); return; }
        const image = new Image();
        image.onload = () => {
          if (stopped || comparePresentationRevisions(next, displayedRevision.current) <= 0) { if (blobUrl) URL.revokeObjectURL(blobUrl); return; }
          if (displayedBlob.current) URL.revokeObjectURL(displayedBlob.current);
          displayedBlob.current = blobUrl;
          displayedRevision.current = { revision: next.revision, renderRevision: next.renderRevision };
          setPresentation({ ...next, content: { ...next.content, url } });
        };
        image.onerror = () => {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          if (!stopped) setMessage('The next screen could not be loaded. Keeping the previous publication.');
        };
        image.src = url;
      } catch {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        if (!stopped) setMessage('The next screen could not be loaded. Keeping the previous publication.');
      }
    };

    connect();
    const reportViewport = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (authenticated && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ protocolVersion: '1.0', type: 'telemetry', payload: { width: window.innerWidth, height: window.innerHeight } }));
        }
      }, 750);
    };
    window.addEventListener('resize', reportViewport);
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearTimeout(watchdog);
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', reportViewport);
      socket?.close(1000, 'Display closed');
    };
  }, [activeExternalId, connectionApiUrl, credential, storageKey, timerTest]);

  return (
    <main className="fixed inset-0 overflow-auto" style={{ background: presentation?.content.background ?? '#050505' }}>
      {timerTest && credential && activeExternalId && <TimerTestPanel
        key={`${connectionApiUrl}|${activeExternalId}|${credential}`} apiUrl={connectionApiUrl} externalId={activeExternalId}
        credential={credential} connected={state === 'connected'} refreshSignal={timerRefreshSignal} onUnauthorized={timerUnauthorized} />}
      {presentation && (
        <img
          key={`${presentation.revision}:${presentation.renderRevision ?? 0}`}
          src={new URL(presentation.content.url, window.location.origin).toString()}
          alt={presentation.content.title}
          className="absolute inset-0 h-full w-full"
          style={{ objectFit: presentation.content.fit }}
        />
      )}
      {(!presentation || state !== 'connected') && (
        <div className="absolute inset-0 flex min-h-full items-center justify-center bg-black/80 text-white">
          <div className="w-full max-w-lg px-8 py-10 text-center">
            <div className={`mx-auto mb-5 h-3 w-3 rounded-full ${state === 'connected' ? 'bg-green-400' : state === 'error' || state === 'unpaired' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} />
            <h1 className="text-2xl font-semibold">Inker Web Display</h1>
            <p role="status" className="mt-3 text-sm text-white/70">{message}</p>

            {!credential && <a href="/?mode=pair" className="mt-6 inline-block rounded-lg bg-white px-4 py-3 font-semibold text-black">Open Inker start page to pair</a>}
          </div>
        </div>
      )}
    </main>
  );
}
