import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONS_QUEUE_NAMES, type OperationsStatus } from '@inker/contracts';
import { Operations } from './Operations';
import { OperationsApiError, operationsErrorMessage, readOperations } from './operations-api';
import { ProtectedRoute } from '../../components/ProtectedRoute';

const client = vi.hoisted(() => ({ get: vi.fn(), checkForUpdate: vi.fn(), authenticated: true }));
vi.mock('../../services/api', () => ({ default: { get: client.get }, dashboardService: { checkForUpdate: client.checkForUpdate } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: client.authenticated, isLoading: false, logout: vi.fn() }) }));
vi.mock('../../contexts/NotificationContext', () => ({ useNotification: () => ({ success: vi.fn(), error: vi.fn() }) }));

const at = '2026-08-28T12:00:00.000Z';
const id = '8f57dc36-9426-4432-847d-e40c81bda602';
const secret = 'synthetic-secret-header-cookie-payload';
function fixture(): OperationsStatus {
  return {
    protocolVersion: '1.0', generatedAt: at, status: 'healthy', reasons: [],
    health: { apiReady: true, database: 'ready', redis: 'ready', workers: { status: 'ready', count: 1, sampledAt: at } },
    queues: OPERATIONS_QUEUE_NAMES.map(queue => ({ queue, sampledAt: at, pending: 0, delayed: 0, processing: 0,
      deadLetters: 0, expiredClaims: 0, oldestDueAgeSeconds: 0, oldestProcessingAgeSeconds: 0 })),
    renderCache: { sampledAt: at, hits: 12, misses: 1, fallbacks: 2, rendered: 1, failures: 0 },
    websocket: { sampledAt: at, authenticatedConnections: 20, pendingConnections: 0, livenessTimeouts: 0, authRejected: 0 },
    sources: { sampledAt: at, total: 1, truncated: false, items: [{ sourceDefinitionId: id, connectorType: 'fixture',
      enabled: true, lastAttemptAt: at, lastSuccessAt: at, ageSeconds: 0, freshness: 'fresh', errorCode: null, circuitOpenUntil: null }] },
    remotes: { sampledAt: at, total: 1, truncated: false, items: [{ subscriptionId: id, enabled: true,
      status: 'fresh', lastAttemptAt: at, lastSuccessAt: at, nextSyncAt: at, ageSeconds: 0, circuitOpenUntil: null, errorCode: null }] },
    devices: { sampledAt: at, total: 1, truncated: false, items: [{ deviceId: 7, deliveryMode: 'connected', enabled: true,
      connection: 'connected', lastSeenAt: at, lastConnectedAt: at, acknowledgedAt: at, ageSeconds: 0,
      state: 'active', publicationState: 'current' }] },
    deadLetters: { sampledAt: at, total: 0, items: [], truncated: false },
  };
}
const wrapped = (data: unknown) => ({ data: { data } });
let data: OperationsStatus;
beforeEach(() => {
  vi.resetAllMocks(); client.authenticated = true; data = fixture();
  client.get.mockImplementation(async () => wrapped(data));
  client.checkForUpdate.mockRejectedValue(new Error('Offline update check'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function page() { return render(<MemoryRouter initialEntries={['/operations']}><Operations /></MemoryRouter>); }
async function loaded() {
  const result = page();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh diagnostics' })).toBeEnabled());
  return result;
}

describe('read-only operations diagnostics', () => {
  it('uses the existing accessible layout and shows health, all queues and source/device/remote activity', async () => {
    await loaded();
    expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { name: 'Operations', level: 1 }));
    expect(screen.getByRole('link', { name: 'Operations' })).toHaveAttribute('href', '/operations');
    expect(screen.getByRole('link', { name: 'Remote publications' })).toHaveAttribute('href', '/remotes');
    expect(screen.getByRole('region', { name: 'Service health' })).toHaveTextContent('Healthy');
    expect(screen.getByRole('table', { name: 'Queue state' }).querySelectorAll('tbody tr')).toHaveLength(6);
    expect(screen.getByRole('region', { name: 'Queue state table' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('table', { name: 'Source activity' })).toHaveTextContent(id);
    expect(screen.getByRole('table', { name: 'Device activity' })).toHaveTextContent('Device 7');
    expect(screen.getByRole('table', { name: 'Remote activity' })).toHaveTextContent('Fresh');
    expect(screen.getByRole('region', { name: 'WebSockets' })).toHaveTextContent('20');
    expect(screen.getByRole('region', { name: 'Render cache' })).toHaveTextContent('Hits12');
    expect(screen.getAllByText('2026-08-28 12:00:00 UTC')[0]).toHaveAttribute('datetime', at);
    expect(screen.queryByRole('button', { name: /replay|clear|delete/i })).not.toBeInTheDocument();
    expect(client.get).toHaveBeenCalledWith('/operations', expect.objectContaining({ timeout: 8000, signal: expect.any(AbortSignal) }));
  });

  it('keeps unknown samples and collections distinct from measured zero', async () => {
    data.status = 'degraded'; data.reasons = ['METRICS_UNAVAILABLE'];
    data.health.workers = { status: 'unknown', count: null, sampledAt: null };
    data.renderCache = { sampledAt: null, hits: null, misses: null, fallbacks: null, rendered: null, failures: null };
    data.sources = { sampledAt: null, total: null, items: [], truncated: false };
    data.queues[0] = { queue: 'source-refresh', sampledAt: null, pending: null, delayed: null, processing: null,
      deadLetters: null, expiredClaims: null, oldestDueAgeSeconds: null, oldestProcessingAgeSeconds: null };
    await loaded();
    const cache = screen.getByRole('region', { name: 'Render cache' });
    expect(within(cache).getAllByText('Unknown')).toHaveLength(5);
    expect(within(cache).queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Source activity' })).toHaveTextContent('Unknown: this collection has no measurement.');
    expect(screen.getByRole('region', { name: 'Dead letters' })).toHaveTextContent('Showing 0 of 0.');
    expect(screen.getByRole('region', { name: 'WebSockets' }).querySelectorAll('dd')[1]).toHaveTextContent('0');
    expect(screen.getByRole('table', { name: 'Queue state' }).querySelector('tbody tr')).toHaveTextContent('Unknown');
  });

  it('shows degraded reasons, disconnected devices, source failures, revoked remotes and bounded dead-letter diagnostics', async () => {
    data.status = 'degraded'; data.reasons = ['DEAD_LETTERS', 'SOURCE_ERRORS', 'REMOTE_ERRORS', 'STALE_DEVICES'];
    data.sources.items[0] = { ...data.sources.items[0], connectorType: 'slow', freshness: 'stale', errorCode: 'SOURCE_TIMEOUT', ageSeconds: 3600 };
    data.devices.items[0] = { ...data.devices.items[0], connection: 'disconnected', state: 'stale', publicationState: 'pending', ageSeconds: 86400 };
    data.remotes.items[0] = { ...data.remotes.items[0], status: 'stale', errorCode: 'REMOTE_UNAUTHORIZED', ageSeconds: 120 };
    data.queues[1].deadLetters = 1; data.queues[1].oldestDueAgeSeconds = 125;
    data.deadLetters = { sampledAt: at, total: 101, truncated: true, items: [{ eventId: 'render-event-1',
      correlationId: id, queue: 'render', occurredAt: at, processedAt: at, attempts: 5, errorCode: 'RENDER_FAILED' }] };
    await loaded();
    expect(screen.getByRole('region', { name: 'Service health' })).toHaveTextContent('Degraded');
    expect(screen.getByRole('table', { name: 'Device activity' })).toHaveTextContent('Disconnected');
    expect(screen.getByRole('table', { name: 'Source activity' })).toHaveTextContent('SOURCE_TIMEOUT');
    expect(screen.getByRole('table', { name: 'Remote activity' })).toHaveTextContent('REMOTE_UNAUTHORIZED');
    const dead = screen.getByRole('region', { name: 'Dead letters' });
    expect(dead).toHaveTextContent('Showing 1 of 101.'); expect(dead).toHaveTextContent('Truncated');
    expect(dead).toHaveTextContent('render-event-1'); expect(dead).toHaveTextContent(`Correlation: ${id}`);
    expect(dead).toHaveTextContent('RENDER_FAILED');
    expect(within(dead).queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks old individual samples even when a new snapshot was fetched successfully', async () => {
    data.renderCache.sampledAt = '2026-08-28T11:58:59.000Z';
    await loaded();
    expect(screen.getByRole('region', { name: 'Render cache' })).toHaveTextContent('Sample older than 60 s');
    expect(screen.getByRole('region', { name: 'WebSockets' })).not.toHaveTextContent('Sample older than 60 s');
  });

  it('shows an unavailable API without conflating worker or database readiness', async () => {
    data.status = 'unavailable'; data.reasons = ['API_DATABASE_UNAVAILABLE', 'WORKER_UNAVAILABLE'];
    data.health.apiReady = false; data.health.database = 'unavailable';
    data.health.workers = { status: 'unavailable', count: 0, sampledAt: at };
    await loaded();
    const health = screen.getByRole('region', { name: 'Service health' });
    expect(health).toHaveTextContent('Not ready');
    expect(health).toHaveTextContent('DatabaseUnavailable');
    expect(health).toHaveTextContent('RedisReady');
    expect(health).toHaveTextContent('WorkersUnavailable · 0');
  });

  it('retains explicitly stale last-known measurements after failure and recovers on manual refresh', async () => {
    await loaded();
    client.get.mockRejectedValueOnce(new Error(secret));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Last known measurements');
    expect(screen.getByText(/Stale view:/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Service health' })).toHaveTextContent('Last known: Healthy');
    expect(document.body.innerHTML).not.toContain(secret);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByText(/Stale view:/)).not.toBeInTheDocument();
  });

  it.each([401, 403])('clears old metadata and stops automatic polling after HTTP %s', async status => {
    vi.useFakeTimers(); await act(async () => { page(); });
    client.get.mockRejectedValue({ isAxiosError: true, response: { status, data: { message: secret } } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' })); });
    expect(screen.getByRole('alert')).toHaveTextContent(status === 401 ? 'session has expired' : 'authorized admin session');
    expect(screen.queryByRole('region', { name: 'Service health' })).not.toBeInTheDocument();
    const count = client.get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(client.get).toHaveBeenCalledTimes(count); expect(document.body.innerHTML).not.toContain(secret);
  });

  it('fails closed on an unavailable endpoint or an invalid DTO without rendering raw input', async () => {
    client.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404, data: { message: secret } } });
    await loaded(); expect(screen.getByRole('alert')).toHaveTextContent('unavailable on this server (404)');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    client.get.mockResolvedValue(wrapped({ ...data, payload: secret }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid operations metadata'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(document.body.innerHTML).not.toContain(secret);
  });

  it('polls only while visible, coalesces refreshes and cannot overwrite state after unmount', async () => {
    vi.useFakeTimers(); const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let component!: ReturnType<typeof page>; await act(async () => { component = page(); });
    expect(client.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(14999); }); expect(client.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(client.get).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(75000); }); expect(client.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Stale view:/)).toBeInTheDocument();
    let finish!: (value: unknown) => void;
    client.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(client.get).toHaveBeenCalledTimes(3);
    const signal = client.get.mock.calls[2][1].signal as AbortSignal;
    component.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { finish(wrapped(data)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(client.get).toHaveBeenCalledTimes(3);
  });

  it('aborts StrictMode discarded reads and rejects a late stale response', async () => {
    const responses: ((value: unknown) => void)[] = [], signals: AbortSignal[] = [];
    client.get.mockImplementation((_path: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal); return new Promise(resolve => { responses.push(resolve); });
    });
    const component = render(<StrictMode><MemoryRouter><Operations /></MemoryRouter></StrictMode>);
    expect(signals).toHaveLength(2); expect(signals[0].aborted).toBe(true);
    await act(async () => { responses[1](wrapped(data)); });
    await act(async () => { responses[0](wrapped({ ...data, status: 'degraded', reasons: ['DEAD_LETTERS'] })); });
    expect(screen.getByRole('region', { name: 'Service health' })).toHaveTextContent('Healthy');
    component.unmount();
  });

  it('does not mount diagnostics or request metadata for an unauthenticated protected route', () => {
    client.authenticated = false;
    render(<MemoryRouter initialEntries={['/operations']}><Routes>
      <Route path="/operations" element={<ProtectedRoute><Operations /></ProtectedRoute>} />
      <Route path="/login" element={<p>Sign in required</p>} />
    </Routes></MemoryRouter>);
    expect(screen.getByText('Sign in required')).toBeInTheDocument(); expect(client.get).not.toHaveBeenCalled();
  });
});

describe('operations HTTP boundary', () => {
  it('returns a detached parsed response and refuses secret-bearing unknown fields', async () => {
    const result = await readOperations(new AbortController().signal);
    data.renderCache.hits = 999;
    expect(result.renderCache.hits).toBe(12);
    client.get.mockResolvedValue(wrapped({ ...data, secret }));
    await expect(readOperations(new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('maps arbitrary transport/server errors to constant text', async () => {
    for (const failure of [new Error(secret), { isAxiosError: true, response: { status: 500, data: { message: secret } } }]) {
      client.get.mockRejectedValue(failure);
      await expect(readOperations(new AbortController().signal)).rejects.toEqual(new OperationsApiError('request-failed'));
      expect(operationsErrorMessage(failure)).toBe('Operations diagnostics could not be refreshed.');
    }
  });
});
