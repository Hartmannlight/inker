import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Login } from './Login';
import { useAuth } from '../../contexts/AuthContext';
import {
  exchangeDeviceEnrollment,
  normalizePairingBaseUrl,
  normalizePairingCode,
  PairingExchangeError,
} from '../display/pairing';

type LandingMode = 'admin' | 'pair';

function pairingMessage(error: unknown): string {
  if (!(error instanceof PairingExchangeError)) return 'Pairing could not be completed. Try again.';
  switch (error.kind) {
    case 'validation': return error.message;
    case 'invalid': return 'This code is invalid, expired, or has already been used.';
    case 'forbidden': return 'Pairing requires HTTPS. Use the HTTPS address, or an administrator can explicitly set PAIRING_ALLOW_INSECURE_HTTP=true and restart Inker for a trusted local network.';
    case 'rate-limited': return 'Too many attempts. Wait one minute and try again.';
    case 'offline': return 'Inker is not reachable. Check the network connection.';
    default: return 'Inker returned an invalid pairing response.';
  }
}

export function Landing({ defaultMode = 'admin' }: { defaultMode?: LandingMode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryMode = params.get('mode') === 'pair' ? 'pair' : defaultMode;
  const [mode, setMode] = useState<LandingMode>(queryMode);
  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const automaticPairingCode = useRef<string | null>(null);

  const pairDisplay = useCallback(async (
    pairingCode: string,
    pairingBaseUrl: string,
    destinationSearch = '',
  ) => {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await exchangeDeviceEnrollment(pairingBaseUrl, pairingCode);
      localStorage.setItem(`inker_display_${result.device.externalId}`, result.credential);
      navigate(
        `/display/${encodeURIComponent(result.device.externalId)}${destinationSearch}`,
        { replace: true },
      );
    } catch (error) {
      setMessage(pairingMessage(error));
    } finally {
      setSubmitting(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate('/dashboard', { replace: true });
  }, [isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    const suppliedCode = params.get('code');
    if (!suppliedCode) return;
    // A QR may carry the one-time code, but the browser history must not retain it.
    setCode(suppliedCode);
    const remainingParams = new URLSearchParams(params);
    remainingParams.delete('code');
    setParams(remainingParams, { replace: true });

    if (automaticPairingCode.current === suppliedCode) return;
    automaticPairingCode.current = suppliedCode;
    const normalizedCode = normalizePairingCode(suppliedCode);
    if (!normalizedCode) {
      setMessage('Enter a valid ten-character pairing code.');
      return;
    }
    const displayParams = new URLSearchParams(remainingParams);
    displayParams.delete('mode');
    const query = displayParams.toString();
    void pairDisplay(
      normalizedCode,
      window.location.origin,
      query ? `?${query}` : '',
    );
  }, [pairDisplay, params, setParams]);

  const choose = (next: LandingMode) => {
    setMode(next);
    setMessage(null);
    setParams(next === 'pair' ? { mode: 'pair' } : {}, { replace: true });
  };

  const submitPairing = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedCode = normalizePairingCode(code);
    if (!normalizedCode) {
      setMessage('Enter a valid ten-character pairing code.');
      return;
    }
    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizePairingBaseUrl(advanced ? baseUrl : window.location.origin);
    } catch (error) {
      setMessage(pairingMessage(error));
      return;
    }
    await pairDisplay(normalizedCode, normalizedBaseUrl);
  };

  if (mode === 'admin') return <Login />;

  return (
    <main className="min-h-screen bg-bg-page px-6 py-12 text-text-primary">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-border-light bg-bg-card p-7 shadow-theme-lg">
        <button type="button" className="text-sm text-accent hover:underline" onClick={() => choose('admin')}>Admin sign in</button>
        <h1 className="mt-5 text-3xl font-bold">Pair display</h1>
        <p className="mt-2 text-text-muted">Enter the one-time code shown in Inker. This display uses the current Inker server by default.</p>
        <form className="mt-7 space-y-5" onSubmit={submitPairing}>
          <div>
            <label htmlFor="landing-pairing-code" className="block text-sm font-medium">Pairing code</label>
            <input id="landing-pairing-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="ABCDE-FGHJK" className="mt-2 w-full rounded-lg border border-border-light bg-bg-input px-3 py-3 font-mono text-lg uppercase tracking-widest" required />
          </div>
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => setAdvanced(value => !value)}>{advanced ? 'Use this Inker server' : 'Advanced: Pair with another Inker server'}</button>
          {advanced && <div>
            <label htmlFor="landing-base-url" className="block text-sm font-medium">Server base URL</label>
            <input id="landing-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="mt-2 w-full rounded-lg border border-border-light bg-bg-input px-3 py-3" required />
          </div>}
          {message && <p role="alert" className="rounded-lg border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text">{message}</p>}
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-accent px-4 py-3 font-semibold text-white disabled:opacity-50">{submitting ? 'Checking code…' : 'Pair display'}</button>
        </form>
      </div>
    </main>
  );
}
