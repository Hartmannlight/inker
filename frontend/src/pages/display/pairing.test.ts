import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPairingBootstrapUrl,
  exchangeDeviceEnrollment,
  formatPairingCode,
  normalizePairingCode,
  PairingExchangeError,
} from './pairing';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('short-code pairing helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizes keyboard-friendly Crockford input and formats ten characters', () => {
    expect(normalizePairingCode(' abcd-o 1l23z ')).toBe('ABCD01123Z');
    expect(formatPairingCode('abcd-o1l23z')).toBe('ABCD0-1123Z');
    expect(normalizePairingCode('abcd-u12345')).toBeNull();
  });

  it('builds a QR bootstrap URL containing only the short code on the selected base URL', () => {
    const url = new URL(buildPairingBootstrapUrl('https://inker.example/base/', 'abcde-fghjk'));

    expect(url.origin).toBe('https://inker.example');
    expect(url.pathname).toBe('/base/display/pair');
    expect([...url.searchParams.keys()]).toEqual(['code']);
    expect(url.searchParams.get('code')).toBe('ABCDE-FGHJK');
    expect(url.toString()).not.toContain('credential');
  });

  it('posts only the normalized code to the unchanged exchange endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      data: {
        credential: 'opaque-long-lived-secret',
        credentialId: 'credential-9',
        device: {
          id: 9,
          name: 'Kitchen display',
          externalId: 'kitchen-display',
          profileId: 'browser-hd-1920x1080',
        },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeDeviceEnrollment('https://inker.example/', 'abcde-fghjk');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://inker.example/api/device-enrollments/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'ABCDEFGHJK' }),
      }),
    );
    expect(result.device.externalId).toBe('kitchen-display');
    expect(fetchMock.mock.calls[0][1]).not.toEqual(expect.objectContaining({ credential: expect.anything() }));
  });

  it.each([
    [400, 'invalid'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
  ] as const)('maps HTTP %s without exposing response secrets', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status, {
      message: 'Pairing code is invalid or unavailable',
    })));

    await expect(exchangeDeviceEnrollment('https://inker.example', 'ABCDE-FGHJK'))
      .rejects.toMatchObject({ kind, status });
  });

  it('does not send the code while the browser reports an offline state', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

    await expect(exchangeDeviceEnrollment('https://inker.example', 'ABCDE-FGHJK'))
      .rejects.toEqual(expect.objectContaining<Partial<PairingExchangeError>>({ kind: 'offline' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps network failures to the stable offline client state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(exchangeDeviceEnrollment('https://inker.example', 'ABCDE-FGHJK'))
      .rejects.toEqual(expect.objectContaining<Partial<PairingExchangeError>>({ kind: 'offline' }));
  });
});
