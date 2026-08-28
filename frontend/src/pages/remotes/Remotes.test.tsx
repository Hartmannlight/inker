import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSubscriptionView } from '@inker/contracts';
import { Remotes } from './Remotes';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('../../services/api', () => ({ default: client }));
vi.mock('../../components/layout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const at = '2026-08-28T12:00:00.000Z';
const token = 'sp_share_' + 'a'.repeat(64);
const fixture = (id = '1'): RemoteSubscriptionView => ({ subscriptionId: `subscription-${id}`, name: `Remote ${id}`, baseUrl: `https://remote${id}.example`,
  serverId: '29787fe4-97d8-4393-9065-efbb9d30bd61', remotePublicationId: `remote-pub-${id}`, enabled: true, trust: 'trusted',
  status: 'stale', lastAttemptAt: at, lastSuccessAt: at, nextSyncAt: at, lastErrorCode: 'REMOTE_UNAUTHORIZED',
  remoteRevision: 2, localPublicationId: `local-${id}`, localPublicationRevisionId: `cached-${id}`, deviceIds: [] });
const wrapped = (data: unknown) => ({ data: { data } });
let rows: RemoteSubscriptionView[];
beforeEach(() => {
  vi.resetAllMocks(); rows = [fixture()];
  client.get.mockImplementation(async (path: string) => wrapped(path === '/remote-subscriptions' ? rows : { items: [{ id: 7, name: 'Kitchen display' }], total: 1 }));
  client.post.mockResolvedValue(wrapped({ scheduled: true })); client.patch.mockResolvedValue(wrapped(fixture())); client.put.mockResolvedValue(wrapped({ assigned: true }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function loaded() {
  render(<StrictMode><Remotes /></StrictMode>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
}

describe('remote publication admin page', () => {
  it('distinguishes two trusted remotes, cached local copies and revocation/protocol diagnostics', async () => {
    rows = [fixture(), { ...fixture('2'), lastErrorCode: 'REMOTE_PROTOCOL_MISMATCH' }];
    await loaded();
    const first = screen.getByRole('article', { name: 'Remote Remote 1' });
    expect(within(first).getByText('https://remote1.example')).toBeInTheDocument();
    expect(within(first).getByText('local-1')).toBeInTheDocument();
    expect(within(first).getByText('REMOTE_UNAUTHORIZED')).toBeInTheDocument();
    expect(within(first).getByText(/expired or been revoked/)).toBeInTheDocument();
    expect(screen.getByText('REMOTE_PROTOCOL_MISMATCH')).toBeInTheDocument();
    expect(screen.getAllByText('Stale · using local cache')).toHaveLength(2);
    expect(within(first).getByText(/A verified copy is stored/)).toBeInTheDocument();
    expect(first.querySelectorAll('time')).toHaveLength(3);
    expect(first.querySelector('time')).toHaveAttribute('datetime', at);
  });

  it('requires explicit trust, clears the submitted token and prevents duplicate creation', async () => {
    rows = [];
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await loaded();
    const form = screen.getByRole('form', { name: 'Create remote subscription' });
    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'Friend' } });
    fireEvent.change(screen.getByLabelText('HTTPS base URL'), { target: { value: 'https://friend.example/' } });
    fireEvent.change(screen.getByLabelText('Expected remote server ID'), { target: { value: fixture().serverId } });
    fireEvent.change(screen.getByLabelText('Remote publication ID'), { target: { value: 'remote-pub-1' } });
    fireEvent.change(screen.getByLabelText('Share token'), { target: { value: token } });
    expect(screen.getByRole('button', { name: 'Create subscription' })).toBeDisabled();
    fireEvent.submit(form); expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    let complete!: (value: unknown) => void;
    client.post.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    fireEvent.submit(form); fireEvent.submit(form);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith('/remote-subscriptions', expect.objectContaining({ baseUrl: 'https://friend.example', trust: true, token }), expect.anything());
    expect(screen.getByLabelText('Share token')).toHaveValue('');
    expect(storage).not.toHaveBeenCalled();
    rows = [fixture()];
    await act(async () => complete(wrapped(fixture())));
    expect(await screen.findByText('Subscription created. Synchronisation is pending.')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(token);
  });

  it('locks sync requests, pauses/enables and assigns the cached publication with explicit server acknowledgements', async () => {
    await loaded();
    let complete!: (value: unknown) => void;
    client.post.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const sync = screen.getByRole('button', { name: 'Sync now' }); fireEvent.click(sync); fireEvent.click(sync);
    expect(client.post).toHaveBeenCalledTimes(1); expect(sync).toBeDisabled();
    await act(async () => complete(wrapped({ scheduled: true })));
    expect(await screen.findByText(/Synchronisation scheduled/)).toBeInTheDocument();
    client.patch.mockImplementation(async () => { rows = [{ ...fixture(), enabled: false, status: 'disabled' }]; return wrapped(rows[0]); });
    fireEvent.click(screen.getByRole('button', { name: 'Pause subscription' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable subscription' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Local device'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign local copy' }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/remote-subscriptions/subscription-1/devices/7', {}, expect.anything()));
    expect(await screen.findByText('Local cached publication assigned to the device.')).toBeInTheDocument();
  });

  it('clears replacement tokens even after a failed command and never displays raw server diagnostics', async () => {
    await loaded();
    client.patch.mockRejectedValue({ isAxiosError: true, response: { status: 403, data: { message: token } } });
    fireEvent.change(screen.getByLabelText('Replacement share token'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(screen.getByLabelText('Replacement share token')).toHaveValue('');
    expect(await screen.findByRole('alert')).toHaveTextContent('This action was denied');
    expect(document.body.innerHTML).not.toContain(token);
  });

  it('shows explicit 404 failure without fake subscriptions or enabled create controls', async () => {
    client.get.mockRejectedValue({ isAxiosError: true, response: { status: 404, data: { message: token } } });
    render(<Remotes />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable on this server (404)');
    expect(screen.queryByText('No remote subscriptions configured.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remote name')).toBeDisabled();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('preserves clearly marked last known state during a failed status refresh and disables assignment without a cache', async () => {
    rows = [{ ...fixture(), status: 'pending', remoteRevision: null, localPublicationRevisionId: null, lastSuccessAt: null, lastErrorCode: null }];
    await loaded();
    expect(screen.getByRole('button', { name: 'Assign local copy' })).toBeDisabled();
    expect(screen.getByText(/No verified local copy yet/)).toBeInTheDocument();
    client.get.mockRejectedValue(new Error(token));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('displayed status may be out of date');
    expect(screen.getByRole('article')).toBeInTheDocument(); expect(document.body.innerHTML).not.toContain(token);
  });

  it('aborts in-flight reads on unmount, including StrictMode setup cleanup', async () => {
    const signals: AbortSignal[] = [];
    client.get.mockImplementation((_path: string, options: { signal: AbortSignal }) => { signals.push(options.signal); return new Promise(() => {}); });
    const page = render(<StrictMode><Remotes /></StrictMode>);
    expect(signals).toHaveLength(2); expect(signals[0].aborted).toBe(true);
    page.unmount(); expect(signals[1].aborted).toBe(true);
  });

  it('refreshes metadata every fifteen seconds only while visible and not executing a command', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { render(<Remotes />); });
    const initial = client.get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(14999); });
    expect(client.get).toHaveBeenCalledTimes(initial);
    rows = [{ ...fixture(), status: 'fresh', lastErrorCode: null }];
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Fresh')).toBeInTheDocument();
    expect(client.get).toHaveBeenCalledTimes(initial + 2);
    visibility.mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(client.get).toHaveBeenCalledTimes(initial + 2);
    visibility.mockReturnValue('visible');
    client.post.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(client.get).toHaveBeenCalledTimes(initial + 2);
  });
});
