import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { config } from '../../config';

interface PresentationManifest {
  revision: number;
  nextTransitionAt: string | null;
  content: { kind: 'image'; url: string; title: string; fit: 'contain' | 'cover' | 'fill'; background: string };
  viewport: { width: number; height: number };
}

type ConnectionState = 'pairing' | 'connecting' | 'connected' | 'offline' | 'unpaired' | 'error';

export function WebDisplay() {
  const { externalId = '' } = useParams<{ externalId: string }>();
  const storageKey = `inker_display_${externalId}`;
  const [credential, setCredential] = useState(() => localStorage.getItem(storageKey));
  const [presentation, setPresentation] = useState<PresentationManifest | null>(null);
  const [state, setState] = useState<ConnectionState>(credential ? 'connecting' : 'pairing');
  const [message, setMessage] = useState('Connecting to Inker…');
  const pairingStarted = useRef(false);

  useEffect(() => {
    const pairingToken = new URLSearchParams(window.location.search).get('pair');
    if (credential || !pairingToken || pairingStarted.current) {
      if (!credential && !pairingToken) {
        setState('unpaired');
        setMessage('This browser is not paired with the display. Create a new pairing link in Inker.');
      }
      return;
    }
    pairingStarted.current = true;
    setState('pairing');
    fetch(`${config.apiUrl}/web-displays/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId, pairingToken }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'Pairing failed');
        return body.data ?? body;
      })
      .then((result: { credential: string }) => {
        localStorage.setItem(storageKey, result.credential);
        window.history.replaceState({}, '', window.location.pathname);
        setCredential(result.credential);
        setState('connecting');
      })
      .catch((error) => {
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Pairing failed');
      });
  }, [credential, externalId, storageKey]);

  useEffect(() => {
    if (!credential) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;

    const connect = () => {
      if (stopped) return;
      setState((current) => current === 'connected' ? current : 'connecting');
      const apiUrl = new URL(config.apiUrl, window.location.origin);
      apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      apiUrl.pathname = `${apiUrl.pathname.replace(/\/$/, '')}/device-connect`;
      apiUrl.search = '';
      socket = new WebSocket(apiUrl.toString());

      socket.onopen = () => {
        attempt = 0;
        socket?.send(JSON.stringify({
          type: 'authenticate',
          externalId,
          token: credential,
          viewport: { width: window.innerWidth, height: window.innerHeight, userAgent: navigator.userAgent },
        }));
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') {
            setState('connected');
            setMessage('Connected');
          } else if (data.type === 'presentation.changed') {
            preloadPresentation(data.presentation);
          } else if (data.type === 'ping') {
            socket?.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
          } else if (data.type === 'error') {
            setMessage(data.message || 'Display connection failed');
          }
        } catch {
          setMessage('Received an invalid display update');
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        setState('offline');
        setMessage(event.code === 4401 ? 'Pairing is no longer valid. Generate a new pairing link.' : 'Connection lost. Reconnecting…');
        if (event.code === 4401) return;
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    const preloadPresentation = (next: PresentationManifest) => {
      const image = new Image();
      image.onload = () => setPresentation((current) => !current || next.revision >= current.revision ? next : current);
      image.onerror = () => setMessage('The next screen could not be loaded. Waiting for another update…');
      image.src = new URL(next.content.url, window.location.origin).toString();
    };

    connect();
    const reportViewport = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'telemetry', payload: { width: window.innerWidth, height: window.innerHeight, userAgent: navigator.userAgent } }));
      }
    };
    window.addEventListener('resize', reportViewport);
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('resize', reportViewport);
      socket?.close(1000, 'Display closed');
    };
  }, [credential, externalId]);

  return (
    <main className="fixed inset-0 overflow-hidden" style={{ background: presentation?.content.background ?? '#050505' }}>
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
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
          <div className="max-w-lg px-8 text-center">
            <div className={`mx-auto mb-5 h-3 w-3 rounded-full ${state === 'connected' ? 'bg-green-400' : state === 'error' || state === 'unpaired' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} />
            <h1 className="text-2xl font-semibold">Inker Web Display</h1>
            <p className="mt-3 text-sm text-white/70">{message}</p>
          </div>
        </div>
      )}
    </main>
  );
}
