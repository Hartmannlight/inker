import { useEffect, useMemo, useState } from 'react';
import { TIMER_LIMITS } from '@inker/contracts';
import { TimerClient, type TimerAction, type TimerClientState } from './timer-client';

interface Props { apiUrl: string; externalId: string; credential: string; connected: boolean; refreshSignal: number; onUnauthorized: () => void; }
export function TimerTestPanel({ apiUrl, externalId, credential, connected, refreshSignal, onUnauthorized }: Props) {
  const [state, setState] = useState<TimerClientState>({ feed: null, context: null, status: 'loading', busy: false, retryAvailable: false, message: 'Timer werden geladen…' });
  const [seconds, setSeconds] = useState(60), [shared, setShared] = useState(true);
  const [, tick] = useState(0);
  const client = useMemo(() => new TimerClient(apiUrl, externalId, credential, setState, onUnauthorized), [apiUrl, externalId, credential, onUnauthorized]);
  useEffect(() => { client.activate(); return () => client.dispose(); }, [client]);
  useEffect(() => { client.setConnected(connected); if (connected) void client.refresh(); }, [client, connected, refreshSignal]);
  useEffect(() => {
    const interval = setInterval(() => tick(value => (value + 1) % 1_000_000), 250);
    return () => clearInterval(interval);
  }, []);
  const disabled = !connected || state.status !== 'ready' || state.busy || state.retryAvailable;
  const actionButton = (action: TimerAction, label: string, timerId: string, expectedVersion: number) => client.allowed(action) && (
    <button type="button" disabled={disabled} onClick={() => void client.command(action, { version: 1, timerId, expectedVersion })}
      className="rounded border border-white/40 px-3 py-2 disabled:opacity-40">{label}</button>
  );
  return <section aria-label="Timer-Test" className="absolute inset-x-4 top-4 z-20 mx-auto max-h-[90vh] max-w-2xl overflow-auto rounded-xl border border-white/30 bg-black/95 p-5 text-white shadow-xl">
    <h2 className="text-xl font-semibold">Timer-Test</h2>
    <p role="status" className="my-2 text-sm">{state.message || (connected ? 'Verbunden – Countdown lokal berechnet.' : 'Offline – letzter bestätigter Zustand.')}</p>
    {client.allowed('timer.create') && <form onSubmit={event => {
      event.preventDefault();
      if (Number.isInteger(seconds) && seconds >= 1 && seconds <= TIMER_LIMITS.durationMaxMs / 1000)
        void client.command('timer.create', { version: 1, durationMs: seconds * 1000, visibility: shared ? 'shared' : 'private' });
    }} className="my-4 flex flex-wrap items-end gap-3">
      <label>Dauer (Sekunden)<input className="ml-2 w-24 rounded bg-white p-2 text-black" type="number" min={1}
        max={TIMER_LIMITS.durationMaxMs / 1000} step={1} value={seconds} onChange={event => setSeconds(Number(event.target.value))} /></label>
      <label className="py-2"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} /> Geteilt</label>
      <button className="rounded bg-white px-4 py-2 font-semibold text-black disabled:opacity-40" disabled={disabled}>Timer erstellen</button>
    </form>}
    {!state.context?.allowedActions.some(item => item.action.startsWith('timer.')) && <p className="my-3 text-sm text-white/70">Diese Veröffentlichung erlaubt keine Timerbefehle.</p>}
    {state.retryAvailable && <button type="button" disabled={!connected || state.busy} onClick={() => void client.retry()} className="my-2 rounded border px-3 py-2">Denselben Befehl wiederholen</button>}
    <button type="button" disabled={!connected || state.busy} onClick={() => void client.refresh()} className="my-2 ml-2 rounded border border-white/40 px-3 py-2">Zustand aktualisieren</button>
    <ul className="space-y-3">{state.feed?.timers.map(timer => <li key={timer.timerId} className="rounded border border-white/25 p-3">
      <div className="flex justify-between gap-3"><span>{timer.visibility === 'shared' ? 'Geteilter Timer' : 'Privater Timer'}</span>
        <strong aria-label="Restzeit">{Math.ceil(client.remaining(timer) / 1000)} s</strong></div>
      <p className="my-1 text-sm text-white/70">{timer.status === 'running' && client.remaining(timer) <= 0 ? 'Abschluss ausstehend' : timer.status} · Version {timer.version}</p>
      <div className="flex flex-wrap gap-2">
        {timer.status === 'running' && actionButton('timer.pause', 'Pausieren', timer.timerId, timer.version)}
        {timer.status === 'paused' && actionButton('timer.resume', 'Fortsetzen', timer.timerId, timer.version)}
        {['running', 'paused'].includes(timer.status) && actionButton('timer.cancel', 'Abbrechen', timer.timerId, timer.version)}
        {timer.status === 'completed' && !timer.acknowledgedAt && actionButton('timer.acknowledge', 'Quittieren', timer.timerId, timer.version)}
      </div>
    </li>)}</ul>
    {state.feed?.timers.length === 0 && <p className="my-3">Keine offenen Timer.</p>}
  </section>;
}
