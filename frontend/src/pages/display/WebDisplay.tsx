import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { config } from '../../config';
import { parseDeviceServerMessage, type WebDisplayManifest } from '@inker/contracts';
import {
  exchangeDeviceEnrollment,
  normalizePairingBaseUrl,
  normalizePairingCode,
  PairingExchangeError,
} from './pairing';

type PresentationManifest = WebDisplayManifest;

type ConnectionState = 'pairing' | 'connecting' | 'connected' | 'offline' | 'unpaired' | 'error';

const UNPAIRED_MESSAGE = 'Dieses Display ist noch nicht gekoppelt.';

function replaceVisibleUrlWithout(...parameters: string[]) {
  const url = new URL(window.location.href);
  for (const parameter of parameters) url.searchParams.delete(parameter);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function shortPairingMessage(error: unknown): string {
  if (!(error instanceof PairingExchangeError)) {
    return 'Die Kopplung ist fehlgeschlagen. Bitte versuche es erneut.';
  }
  switch (error.kind) {
    case 'validation':
      return error.message.startsWith('Enter')
        ? 'Gib eine gültige HTTP- oder HTTPS-Basis-URL ein.'
        : 'Gib einen gültigen zehnstelligen Code ein.';
    case 'invalid':
      return 'Der Code ist ungültig, abgelaufen oder wurde bereits verwendet.';
    case 'forbidden':
      return 'Der Server hat die Kopplung abgelehnt. Prüfe HTTPS und die Serverfreigabe.';
    case 'rate-limited':
      return 'Zu viele Versuche. Bitte warte eine Minute und versuche es erneut.';
    case 'offline':
      return 'Inker ist nicht erreichbar. Prüfe Netzwerk und Basis-URL.';
    default:
      return 'Der Server hat keine gültige Kopplungsantwort geliefert.';
  }
}

export function WebDisplay() {
  const { externalId: routeExternalId = '' } = useParams<{ externalId: string }>();
  const initialExternalId = routeExternalId === 'pair' ? '' : routeExternalId;
  const initialSearch = useRef(new URLSearchParams(window.location.search));
  const initialShortCode = useRef(initialSearch.current.get('code'));
  const [activeExternalId, setActiveExternalId] = useState(initialExternalId);
  const initialStorageKey = initialExternalId ? `inker_display_${initialExternalId}` : null;
  const [credential, setCredential] = useState(() => initialStorageKey ? localStorage.getItem(initialStorageKey) : null);
  const [pairingToken, setPairingToken] = useState(() => initialExternalId ? initialSearch.current.get('pair') : null);
  const [pairingBaseUrl, setPairingBaseUrl] = useState(window.location.origin);
  const [pairingCode, setPairingCode] = useState(initialShortCode.current ?? '');
  const [connectionApiUrl, setConnectionApiUrl] = useState(config.apiUrl);
  const [presentation, setPresentation] = useState<PresentationManifest | null>(null);
  const [state, setState] = useState<ConnectionState>(
    pairingToken || initialShortCode.current ? 'pairing' : credential ? 'connecting' : 'unpaired',
  );
  const [message, setMessage] = useState(
    pairingToken || credential ? 'Connecting to Inker…' : initialShortCode.current ? 'Code wird geprüft…' : UNPAIRED_MESSAGE,
  );
  const longPairingStarted = useRef(false);
  const shortPairingStarted = useRef(false);
  const storageKey = activeExternalId ? `inker_display_${activeExternalId}` : null;

  const pairWithShortCode = useCallback(async (baseUrl: string, code: string) => {
    const normalizedCode = normalizePairingCode(code);
    if (!normalizedCode) {
      setState('error');
      setMessage('Gib einen gültigen zehnstelligen Code ein.');
      return;
    }

    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizePairingBaseUrl(baseUrl);
    } catch (error) {
      setState('error');
      setMessage(shortPairingMessage(error));
      return;
    }

    setState('pairing');
    setMessage('Code wird geprüft…');
    try {
      const result = await exchangeDeviceEnrollment(normalizedBaseUrl, normalizedCode);
      const nextStorageKey = `inker_display_${result.device.externalId}`;

      localStorage.setItem(nextStorageKey, result.credential);
      setActiveExternalId(result.device.externalId);
      setCredential(result.credential);
      setConnectionApiUrl(`${normalizedBaseUrl}/api`);
      setPairingCode('');
      setPairingBaseUrl('');
      setState('connecting');
      setMessage('Kopplung erfolgreich. Verbindung wird hergestellt…');
      window.history.replaceState(
        window.history.state,
        '',
        `/display/${encodeURIComponent(result.device.externalId)}`,
      );
    } catch (error) {
      setState('error');
      setMessage(shortPairingMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!initialShortCode.current || shortPairingStarted.current) return;
    shortPairingStarted.current = true;
    replaceVisibleUrlWithout('code', 'baseUrl');
    void pairWithShortCode(pairingBaseUrl, initialShortCode.current);
  }, [pairWithShortCode, pairingBaseUrl]);

  useEffect(() => {
    if (!pairingToken || longPairingStarted.current || !activeExternalId || !storageKey) return;
    longPairingStarted.current = true;
    replaceVisibleUrlWithout('pair');
    setState('pairing');
    fetch(`${config.apiUrl}/web-displays/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: activeExternalId, pairingToken }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'Pairing failed');
        return body.data ?? body;
      })
      .then((result: { credential: string }) => {
        localStorage.setItem(storageKey, result.credential);
        setPairingToken(null);
        setCredential(result.credential);
        setState('connecting');
      })
      .catch((error) => {
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Pairing failed');
      });
  }, [activeExternalId, pairingToken, storageKey]);

  useEffect(() => {
    if (!credential || pairingToken || !activeExternalId || !storageKey) return;
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
          } else if (data.type === 'presentation.changed') {
            preloadPresentation(data.presentation);
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
          setMessage('Pairing is no longer valid. Generate a new pairing link.');
          return;
        }
        setState('offline');
        setMessage('Connection lost. Reconnecting…');
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    const preloadPresentation = (next: PresentationManifest) => {
      const image = new Image();
      image.onload = () => { if (!stopped) setPresentation((current) => !current || next.revision >= current.revision ? next : current); };
      image.onerror = () => setMessage('The next screen could not be loaded. Waiting for another update…');
      image.src = new URL(next.content.url, window.location.origin).toString();
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
  }, [activeExternalId, connectionApiUrl, credential, pairingToken, storageKey]);

  const submitShortCode = (event: React.FormEvent) => {
    event.preventDefault();
    void pairWithShortCode(pairingBaseUrl, pairingCode);
  };

  const showPairingForm = !credential && !pairingToken;

  return (
    <main className="fixed inset-0 overflow-auto" style={{ background: presentation?.content.background ?? '#050505' }}>
      {presentation && (
        <img
          key={presentation.revision}
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

            {showPairingForm && (
              <form onSubmit={submitShortCode} className="mt-8 space-y-5 rounded-2xl border border-white/20 bg-white/10 p-5 text-left">
                <div>
                  <label htmlFor="pairing-base-url" className="block text-sm font-medium text-white">Basis-URL</label>
                  <input
                    id="pairing-base-url"
                    type="url"
                    value={pairingBaseUrl}
                    onChange={(event) => setPairingBaseUrl(event.target.value)}
                    placeholder="https://inker.example"
                    autoComplete="url"
                    required
                    className="mt-2 w-full rounded-lg border border-white/25 bg-black/50 px-3 py-3 text-base text-white outline-none focus:border-white"
                  />
                  {pairingBaseUrl.trim().toLowerCase().startsWith('http://') && (
                    <p role="alert" className="mt-2 rounded-lg border border-amber-300/50 bg-amber-300/10 p-2 text-xs text-amber-100">
                      <strong>Unsicheres HTTP:</strong> Code und ausgegebenes Credential sind auf dem Transportweg nicht verschlüsselt. Nur mit ausdrücklich freigegebenem, vertrauenswürdigem Netz verwenden.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="pairing-code" className="block text-sm font-medium text-white">Kopplungscode</label>
                  <input
                    id="pairing-code"
                    value={pairingCode}
                    onChange={(event) => setPairingCode(event.target.value)}
                    placeholder="ABCDE-FGHJK"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    required
                    className="mt-2 w-full rounded-lg border border-white/25 bg-black/50 px-3 py-3 font-mono text-lg uppercase tracking-widest text-white outline-none focus:border-white"
                  />
                </div>
                <button
                  type="submit"
                  disabled={state === 'pairing'}
                  className="min-h-12 w-full rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-50"
                >
                  {state === 'pairing' ? 'Code wird geprüft…' : 'Koppeln'}
                </button>
                <p className="text-xs text-white/60">Der alte Zugang bleibt bei ungültigem Code, Rate-Limit, Offline- oder Netzwerkfehler unverändert.</p>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
