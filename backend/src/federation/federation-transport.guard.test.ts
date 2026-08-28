import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FederationTransportGuard, federationProxyAddresses } from './federation-transport.guard';

function context(peer: string, proto: unknown, encrypted = false) {
  const headers: Record<string, string> = {};
  const value = { switchToHttp: () => ({ getRequest: () => ({ secure: true, protocol: 'https',
    socket: { remoteAddress: peer, encrypted }, headers: { 'x-forwarded-proto': proto } }),
  getResponse: () => ({ setHeader: (key: string, value: string) => { headers[key] = value; } }) }) } as unknown as ExecutionContext;
  return { value, headers };
}

describe('Federation TLS trust boundary', () => {
  test('accepts actual TLS without trusting arbitrary forwarding headers', () => {
    const guard = new FederationTransportGuard(new ConfigService());
    expect(guard.canActivate(context('203.0.113.10', 'http', true).value)).toBe(true);
  });
  test('rejects global Express trust and pairing HTTP exceptions', () => {
    const guard = new FederationTransportGuard(new ConfigService({ pairing: { trustProxy: true, allowInsecureHttp: true } }));
    const request = context('127.0.0.1', 'https');
    expect(() => guard.canActivate(request.value)).toThrow('FEDERATION_HTTPS_REQUIRED');
    expect(request.headers['Cache-Control']).toBe('no-store');
  });
  test('requires an exact allowlisted immediate peer and one HTTPS header', () => {
    const guard = new FederationTransportGuard(new ConfigService({ federation: { trustedProxies: '127.0.0.1,::1' } }));
    for (const peer of ['127.0.0.1', '::1']) expect(guard.canActivate(context(peer, 'https').value)).toBe(true);
    for (const peer of ['::ffff:127.0.0.1', '127.0.0.2', '203.0.113.8', ''])
      expect(() => guard.canActivate(context(peer, 'https').value)).toThrow('FEDERATION_HTTPS_REQUIRED');
    for (const proto of ['http', 'HTTPS', 'https,http', 'https, https', undefined, ['https'], ' https'])
      expect(() => guard.canActivate(context('127.0.0.1', proto).value)).toThrow('FEDERATION_HTTPS_REQUIRED');
  });
  test('rejects unbounded, malformed and network-wide trust configuration', () => {
    for (const value of ['*', '127.0.0.0/8', 'localhost', '127.0.0.1,', 'https://127.0.0.1', Array(33).fill('127.0.0.1').join(',')])
      expect(() => federationProxyAddresses(value)).toThrow('Invalid FEDERATION_TRUSTED_PROXIES');
    expect([...federationProxyAddresses(' 127.0.0.1, ::1 ')]).toEqual(['127.0.0.1', '::1']);
    expect(federationProxyAddresses('').size).toBe(0);
  });
});
