import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    status: ok ? 200 : 400,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function statusResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
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

  it('sends versioned auth without user-agent and answers correlated pings', () => {
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    renderDisplay(`/display/${DISPLAY_ID}`);
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ protocolVersion: '1.0', type: 'authenticate' });
    expect(socket.send.mock.calls[0][0]).not.toContain('userAgent');
    act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ protocolVersion: '1.0', type: 'ping', nonce: 'abc', timestamp: 1 }) })));
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ protocolVersion: '1.0', type: 'pong', nonce: 'abc' });
  });

  it('stops on incompatible protocol without deleting credentials or reflecting errors', () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    renderDisplay(`/display/${DISPLAY_ID}`);
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ protocolVersion: '2.0', type: 'error', message: 'secret-output' }) })));
    expect(screen.queryByText('secret-output')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('valid-credential');
  });

  it('debounces resize telemetry and reconnects when server heartbeats disappear', () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    renderDisplay(`/display/${DISPLAY_ID}`);
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ protocolVersion: '1.0', type: 'connected', deviceId: 7, heartbeatInterval: 30000, pongTimeout: 10000, telemetryInterval: 300000 }) })));
    act(() => { for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(1000); });
    expect(socket.send.mock.calls.filter(([value]) => JSON.parse(value).type === 'telemetry')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(46_000));
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('valid-credential');
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

  it('normalizes manual keyboard input and atomically stores a first short-code exchange', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(200, {
      data: {
        credential: 'new-device-credential',
        credentialId: 'credential-7',
        device: {
          id: 7,
          name: 'Display 7',
          externalId: DISPLAY_ID,
          profileId: 'browser-hd-1920x1080',
        },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay('/display/pair');
    await user.clear(screen.getByLabelText('Basis-URL'));
    await user.type(screen.getByLabelText('Basis-URL'), 'https://inker.example');
    await user.type(screen.getByLabelText('Kopplungscode'), 'abcd-o 1l23z');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('new-device-credential'));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://inker.example/api/device-enrollments/exchange',
      expect.objectContaining({ body: JSON.stringify({ code: 'ABCD01123Z' }) }),
    );
    expect(window.location.pathname).toBe(`/display/${DISPLAY_ID}`);
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('new-device-credential');
    expect(screen.getByText('Kopplung erfolgreich. Verbindung wird hergestellt…')).toBeInTheDocument();
  });

  it('supports the touch button path and replaces an old credential only after success', async () => {
    localStorage.setItem(STORAGE_KEY, 'old-credential');
    let finishExchange!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishExchange = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    renderDisplay('/display/pair');
    fireEvent.change(screen.getByLabelText('Kopplungscode'), { target: { value: 'ABCDE-FGHJK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Koppeln' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Code wird geprüft…'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('old-credential');

    finishExchange(statusResponse(200, {
      data: {
        credential: 'rotated-credential',
        credentialId: 'credential-8',
        device: { id: 7, name: 'Display 7', externalId: DISPLAY_ID, profileId: 'browser-hd-1920x1080' },
      },
    }));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('rotated-credential'));
  });

  it('automatically follows a QR bootstrap and removes its code from browser history before exchange', async () => {
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(200, {
      data: {
        credential: 'qr-credential',
        credentialId: 'credential-9',
        device: { id: 7, name: 'Display 7', externalId: DISPLAY_ID, profileId: 'browser-hd-1920x1080' },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay('/display/pair?code=ABCDE-FGHJK');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(window.location.search).toBe('');
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('qr-credential'));
    expect(window.location.href).not.toContain('ABCDE');
    expect(window.location.href).not.toContain('qr-credential');
    const logged = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain('ABCDE-FGHJK');
    expect(logged).not.toContain('qr-credential');
    for (const spy of logSpies) spy.mockRestore();
  });

  it.each([
    [400, 'Der Code ist ungültig, abgelaufen oder wurde bereits verwendet.'],
    [403, 'Der Server hat die Kopplung abgelehnt. Prüfe HTTPS und die Serverfreigabe.'],
    [429, 'Zu viele Versuche. Bitte warte eine Minute und versuche es erneut.'],
  ])('keeps the old credential for HTTP %s and shows a stable state', async (status, expectedMessage) => {
    localStorage.setItem(STORAGE_KEY, 'keep-me');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse(status, { message: 'opaque error' })));

    renderDisplay('/display/pair?code=ABCDE-FGHJK');

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('keep-me');
    expect(window.location.search).toBe('');
  });

  it('keeps the old credential for validation, offline and network errors', async () => {
    localStorage.setItem(STORAGE_KEY, 'keep-me');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    renderDisplay('/display/pair');
    expect(screen.getByRole('alert')).toHaveTextContent('Unsicheres HTTP');
    fireEvent.change(screen.getByLabelText('Kopplungscode'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Koppeln' }));
    expect(await screen.findByText('Gib einen gültigen zehnstelligen Code ein.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('keep-me');

    fireEvent.change(screen.getByLabelText('Kopplungscode'), { target: { value: 'ABCDE-FGHJK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Koppeln' }));
    expect(await screen.findByText('Inker ist nicht erreichbar. Prüfe Netzwerk und Basis-URL.')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('keep-me');
  });
});
