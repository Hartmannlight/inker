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

  it('loads immutable publication images with header auth and retains the last image on failure', async () => {
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) });
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.fn().mockReturnValue('blob:published-image');
    const revoke = vi.fn();
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    class PreloadedImage {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', PreloadedImage);
    const view = renderDisplay(`/display/${DISPLAY_ID}`);
    const socket = MockWebSocket.instances[0];
    const publication = (revision: number) => ({ protocolVersion: '1.0', type: 'presentation.changed', presentation: {
      deviceId: 7, externalId: DISPLAY_ID, revision, generatedAt: '2026-08-27T00:00:00.000Z', nextTransitionAt: null,
      viewport: { width: 800, height: 480 }, content: { kind: 'image', url: `/api/web-displays/${DISPLAY_ID}/artifacts/${'a'.repeat(64)}`,
        title: 'Published content', fit: 'contain', background: '#ffffff' },
    } });
    act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(publication(1)) })));
    await waitFor(() => expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:published-image'));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/api/web-displays/${DISPLAY_ID}/artifacts/`), {
      headers: { Authorization: 'Bearer valid-credential' }, credentials: 'omit', redirect: 'error',
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain('valid-credential');
    fetchMock.mockRejectedValue(new Error('private-error'));
    act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(publication(2)) })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:published-image');
    expect(revoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('valid-credential');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:published-image');
  });

  it('keeps the ready render when an older same-revision image or receipt arrives late', async () => {
    localStorage.setItem(STORAGE_KEY, 'valid-credential');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) });
    vi.stubGlobal('fetch', fetchMock);
    let created = 0;
    URL.createObjectURL = vi.fn(() => `blob:render-${++created}`);
    URL.revokeObjectURL = vi.fn();
    const images: Array<{ onload: (() => void) | null }> = [];
    class PendingImage {
      onload: (() => void) | null = null;
      set src(_value: string) { images.push(this); }
    }
    vi.stubGlobal('Image', PendingImage);
    renderDisplay(`/display/${DISPLAY_ID}`);
    const socket = MockWebSocket.instances[0];
    const send = (revision: number, renderRevision: number) => act(() => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      protocolVersion: '1.0', type: 'presentation.changed', presentation: {
        deviceId: 7, externalId: DISPLAY_ID, revision, renderRevision, generatedAt: '2026-08-27T00:00:00.000Z', nextTransitionAt: null,
        viewport: { width: 800, height: 480 }, content: { kind: 'image', title: 'Published content', fit: 'contain', background: '#ffffff',
          url: `/api/web-displays/${DISPLAY_ID}/artifacts/${String(renderRevision).repeat(64)}` },
      },
    }) })));
    send(1, 0);
    await waitFor(() => expect(images).toHaveLength(1));
    act(() => images[0].onload?.());
    expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:render-1');
    send(2, 0); // Fallback preload remains pending while the render finishes.
    await waitFor(() => expect(images).toHaveLength(2));
    send(2, 1);
    await waitFor(() => expect(images).toHaveLength(3));
    act(() => images[2].onload?.());
    expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:render-3');
    act(() => images[1].onload?.());
    expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:render-3');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:render-2');
    send(2, 0); // Late cached receipt cannot trigger another fetch or downgrade.
    send(1, 9);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    send(3, 0); // Desired revision remains the primary ordering component.
    await waitFor(() => expect(images).toHaveLength(4));
    act(() => images[3].onload?.());
    expect(screen.getByAltText('Published content')).toHaveAttribute('src', 'blob:render-4');
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
    expect(screen.getByText('Pairing is no longer valid. Open the Inker start page to pair again.')).toBeInTheDocument();
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
