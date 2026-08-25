import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common';
import { deviceService, type DeviceEnrollment } from '../../services/api';
import { generateQRCodeDataUrl } from '../../utils/qrcode';
import { buildPairingBootstrapUrl } from '../../pages/display/pairing';

interface DevicePairingPanelProps {
  deviceId: string;
  deviceName: string;
  profileId: string;
  baseUrl?: string;
  autoStart?: boolean;
  now?: () => Date;
  tickMs?: number;
}

const defaultNow = () => new Date();

export function DevicePairingPanel({
  deviceId,
  deviceName,
  profileId,
  baseUrl = window.location.origin,
  autoStart = false,
  now = defaultNow,
  tickMs = 1_000,
}: DevicePairingPanelProps) {
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const bootstrapUrl = useMemo(() => {
    if (!enrollment || expired) return null;
    return buildPairingBootstrapUrl(baseUrl, enrollment.code);
  }, [baseUrl, enrollment, expired]);

  const createEnrollment = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setExpired(false);
    setQrDataUrl(null);
    try {
      const next = await deviceService.createEnrollment(deviceId);
      setEnrollment(next);
      setRemainingMs(Math.max(0, new Date(next.expiresAt).getTime() - now().getTime()));
    } catch (caught) {
      setEnrollment(null);
      setError(caught instanceof Error ? caught.message : 'Kopplungscode konnte nicht erstellt werden.');
    } finally {
      setIsCreating(false);
    }
  }, [deviceId, now]);

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void createEnrollment();
  }, [autoStart, createEnrollment, enrollment, error, isCreating]);

  useEffect(() => {
    if (!enrollment || expired) return;
    const updateRemaining = () => {
      const remaining = Math.max(0, new Date(enrollment.expiresAt).getTime() - now().getTime());
      setRemainingMs(remaining);
      if (remaining === 0) {
        setExpired(true);
        setQrDataUrl(null);
      }
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, tickMs);
    return () => window.clearInterval(timer);
  }, [enrollment, expired, now, tickMs]);

  useEffect(() => {
    if (!bootstrapUrl) return;
    let current = true;
    generateQRCodeDataUrl(bootstrapUrl, 240, { errorCorrection: 'M', margin: 2 })
      .then((value) => { if (current) setQrDataUrl(value); })
      .catch(() => { if (current) setError('QR-Code konnte nicht erzeugt werden. Der Code kann weiterhin manuell eingegeben werden.'); });
    return () => { current = false; };
  }, [bootstrapUrl]);

  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  const insecure = baseUrl.startsWith('http://');

  return (
    <section className="rounded-xl border border-border-light bg-bg-card p-5 space-y-4" aria-label="Gerät koppeln">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-text-primary">Gerät koppeln oder Zugang rotieren</h2>
          <p className="mt-1 text-sm text-text-muted">
            Ein erfolgreicher Austausch widerruft das bisherige Geräte-Credential atomar.
          </p>
        </div>
        <Button onClick={() => void createEnrollment()} isLoading={isCreating}>
          {enrollment ? 'Neuen Code erzeugen' : 'Gerät koppeln'}
        </Button>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">Geräteprofil</dt>
          <dd className="font-mono text-text-primary break-all">{profileId}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Basis-URL</dt>
          <dd className="font-mono text-text-primary break-all">{baseUrl}</dd>
        </div>
      </dl>

      {insecure && (
        <p role="alert" className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-sm text-status-warning-text">
          <strong>Unsicheres HTTP:</strong> Code und ausgegebenes Credential sind im lokalen Netz nicht verschlüsselt. Nur mit ausdrücklich freigegebenem, vertrauenswürdigem Netz verwenden.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-status-error-text">{error}</p>}
      {expired && <p role="status" className="font-semibold text-status-error-text">Code abgelaufen</p>}

      {enrollment && !expired && (
        <div className="grid items-center gap-5 sm:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div>
              <p className="text-sm text-text-muted">Einmaliger Kopplungscode</p>
              <p className="mt-1 font-mono text-3xl font-bold tracking-widest text-text-primary">{enrollment.code}</p>
            </div>
            <p role="timer" className="text-sm text-text-secondary">Verbleibend: {minutes}:{seconds}</p>
            <p className="text-xs text-text-muted">Code und QR werden nur vorübergehend angezeigt. Das langlebige Credential erscheint nie im Admin-UI.</p>
          </div>
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt={`QR-Code zum Koppeln von ${deviceName}`}
              className="h-48 w-48 rounded-lg border border-border-light bg-white p-2"
            />
          )}
        </div>
      )}
    </section>
  );
}
