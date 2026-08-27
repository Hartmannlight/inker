import { describe, expect, test } from 'bun:test';
import { isDeviceOriginAllowed } from './websocket-origin';

const request = (headers: Record<string, string>, remoteAddress = '192.0.2.1', encrypted = false) => ({ headers, socket: { remoteAddress, encrypted } }) as any;
describe('device upgrade origin trust', () => {
  test('normalizes case/default port/IPv6 and requires a valid host without Origin', () => {
    expect(isDeviceOriginAllowed(request({ host: 'EXAMPLE.com:80', origin: 'http://example.com' }), {})).toBe(true);
    expect(isDeviceOriginAllowed(request({ host: 'example.com.', origin: 'http://example.com' }), {})).toBe(true);
    expect(isDeviceOriginAllowed(request({ host: '[::1]:80', origin: 'http://[::1]' }), {})).toBe(true);
    expect(isDeviceOriginAllowed(request({ host: 'local:3002' }), {})).toBe(true);
    for (const host of ['', 'user@evil', 'evil/path', 'one,two']) expect(isDeviceOriginAllowed(request({ host }), {})).toBe(false);
    for (const origin of ['null', 'https://example.com', 'http://example.com/evil', 'http://evil', 'http://user@example.com']) {
      expect(isDeviceOriginAllowed(request({ host: 'example.com', origin }), {})).toBe(false);
    }
  });
  test('explicit origin allowlist, no wildcard bypass and optional host allowlist', () => {
    expect(isDeviceOriginAllowed(request({ host: 'internal', origin: 'https://UI.example:443' }), { CORS_ORIGINS: 'https://ui.example' })).toBe(true);
    expect(isDeviceOriginAllowed(request({ host: 'internal', origin: 'https://evil' }), { CORS_ORIGINS: '*' })).toBe(false);
    expect(isDeviceOriginAllowed(request({ host: 'evil', origin: 'http://evil' }), { DEVICE_WS_ALLOWED_HOSTS: 'good' })).toBe(false);
  });
  test('forwarded authority only from explicitly trusted immediate proxy addresses', () => {
    const headers = { host: 'internal:3002', origin: 'https://public.example', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' };
    const env = { DEVICE_WS_TRUSTED_PROXIES: '127.0.0.1,::1' };
    expect(isDeviceOriginAllowed(request(headers), env)).toBe(false);
    expect(isDeviceOriginAllowed(request(headers, '::ffff:127.0.0.1'), env)).toBe(true);
    expect(isDeviceOriginAllowed(request({ ...headers, 'x-forwarded-host': 'public.example,evil' }, '127.0.0.1'), env)).toBe(false);
    expect(isDeviceOriginAllowed(request({ ...headers, 'x-forwarded-proto': 'https,http' }, '127.0.0.1'), env)).toBe(false);
  });
});
