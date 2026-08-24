import { act, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebDisplay } from './WebDisplay';

const DISPLAY_ID = 'display-7';
const STORAGE_KEY = `inker_display_${DISPLAY_ID}`;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor(url: string | URL) {
    this.url = url.toString();
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverClose(code: number, reason: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

function renderDisplay(path: string) {
  window.history.replaceState({}, '', path);
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/display/:externalId" element={<WebDisplay />} />
      </Routes>
    </BrowserRouter>,
  );
}

function response(ok: boolean, body: unknown) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('WebDisplay credential lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('prioritizes an explicit pairing token and replaces an existing credential only after pairing succeeds', async () => {
    localStorage.setItem(STORAGE_KEY, 'old-credential');
    let finishPairing!: (value: Response) => void;
    const pairingResponse = new Promise<Response>((resolve) => {
      finishPairing = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pairingResponse);
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay(`/display/${DISPLAY_ID}?theme=dark&pair=rotation-token#status`);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/web-displays\/pair$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ externalId: DISPLAY_ID, pairingToken: 'rotation-token' }),
      }),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe('old-credential');
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe(`/display/${DISPLAY_ID}?theme=dark#status`);

    finishPairing(response(true, { data: { credential: 'rotated-credential' } }));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('rotated-credential'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => MockWebSocket.instances[0].open());
    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(
      expect.stringContaining('rotated-credential'),
    );
  });

  it('keeps the existing credential and shows an expired-link error without retrying', async () => {
    localStorage.setItem(STORAGE_KEY, 'still-valid-until-rotated');
    const fetchMock = vi.fn().mockResolvedValue(response(false, { message: 'Pairing link has expired' }));
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay(`/display/${DISPLAY_ID}?pair=expired-token`);

    expect(await screen.findByText('Pairing link has expired')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('still-valid-until-rotated');
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(window.location.search).toBe('');
  });

  it('keeps the existing credential after a pairing network failure and does not loop', async () => {
    localStorage.setItem(STORAGE_KEY, 'existing-credential');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay(`/display/${DISPLAY_ID}?pair=unreachable-token`);

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('existing-credential');
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(window.location.search).toBe('');
  });

  it('removes the active credential after a 4401 rejection and does not reconnect', async () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, 'revoked-credential');
    vi.stubGlobal('fetch', vi.fn());

    renderDisplay(`/display/${DISPLAY_ID}`);
    await act(async () => undefined);
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      MockWebSocket.instances[0].serverClose(4401, 'Authentication failed');
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByText('Pairing is no longer valid. Generate a new pairing link.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('retains the credential and reconnects after a non-authentication network close', async () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    vi.stubGlobal('fetch', vi.fn());

    renderDisplay(`/display/${DISPLAY_ID}`);
    await act(async () => undefined);
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      MockWebSocket.instances[0].serverClose(1006, 'Network unavailable');
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe('valid-credential');
    expect(screen.getByText('Connection lost. Reconnecting…')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
