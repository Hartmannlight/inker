import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimerTestPanel } from './TimerTestPanel';

const at = '2026-08-28T12:00:00.000Z';
const timer = { timerId: '9435c24b-b254-4bde-8439-e5a08f8a313a', version: 1, creatorDeviceId: 'display', visibility: 'shared', status: 'running',
  durationMs: 60000, startedAt: at, endsAt: '2026-08-28T12:01:00.000Z', evaluatedAt: at, pausedRemainingMs: null,
  completedAt: null, cancelledAt: null, acknowledgedAt: null, acknowledgedByDeviceId: null };
const feed = { protocolVersion: '1.0', serverTime: at, timers: [timer] };
const context = { protocolVersion: '1.0', deviceId: 'display', credentialId: 'credential-id', publicationId: 'publication', revision: '1',
  allowedActions: [{ action: 'timer.create', payloadSchemaVersion: '1.0' }, { action: 'timer.pause', payloadSchemaVersion: '1.0' }] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const props = { apiUrl: '/api', externalId: 'display', credential: 'synthetic-token', connected: true, refreshSignal: 1, onUnauthorized: vi.fn() };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opt-in timer test panel', () => {
  it('renders authorized controls under StrictMode, counts locally and refreshes on invalidation', async () => {
    let mono = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const fetcher = vi.fn(async (url: string) => response(url.endsWith('/timers') ? feed : { data: context }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<StrictMode><TimerTestPanel {...props} /></StrictMode>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Timer erstellen' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Pausieren' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).not.toBeInTheDocument();
    const before = fetcher.mock.calls.length;
    mono = 10000;
    await waitFor(() => expect(screen.getByLabelText('Restzeit')).toHaveTextContent('50 s'));
    expect(fetcher).toHaveBeenCalledTimes(before);
    view.rerender(<StrictMode><TimerTestPanel {...props} refreshSignal={2} /></StrictMode>);
    await waitFor(() => expect(fetcher.mock.calls.length).toBe(before + 2));
    view.rerender(<StrictMode><TimerTestPanel {...props} refreshSignal={2} connected={false} /></StrictMode>);
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.queryByRole('button', { name: 'Timer erstellen' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Restzeit')).toBeInTheDocument();
  });
  it('submits a bounded create and locks the visible controls until confirmation', async () => {
    let complete!: (value: Response) => void;
    let body = '';
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { body = String(init.body); return new Promise<Response>(resolve => { complete = resolve; }); }
      return Promise.resolve(response(url.endsWith('/timers') ? feed : { data: context }));
    });
    vi.stubGlobal('fetch', fetcher);
    render(<TimerTestPanel {...props} />);
    const create = await screen.findByRole('button', { name: 'Timer erstellen' });
    fireEvent.change(screen.getByLabelText('Dauer (Sekunden)'), { target: { value: '5' } });
    fireEvent.click(create); fireEvent.click(create);
    expect(create).toBeDisabled(); expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const event = JSON.parse(body); expect(event.payload).toEqual({ version: 1, durationMs: 5000, visibility: 'shared' });
    await act(async () => complete(response({ data: { protocolVersion: '1.0', eventId: event.eventId, commandId: 'command', status: 'accepted', serverTime: at } })));
    await waitFor(() => expect(create).toBeEnabled());
    expect(document.body.innerHTML).not.toContain('synthetic-token');
  });
});
