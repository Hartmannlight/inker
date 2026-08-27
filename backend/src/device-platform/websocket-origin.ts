import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

function origin(value: string): string | undefined {
  try {
    if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) return;
    const url = new URL(value);
    if (url.username || url.password) return;
    url.hostname = url.hostname.replace(/\.$/, '');
    return url.origin;
  } catch { return; }
}
function authority(value: string, scheme: string): string | undefined {
  if (!value || /[\s,@/\\?#]/.test(value)) return;
  return origin(`${scheme}://${value}`);
}
function ip(value: string): string { return value.toLowerCase().replace(/^::ffff:/, ''); }

/** Trust only the immediate peer, never a user-supplied forwarding chain. */
export function isDeviceOriginAllowed(request: IncomingMessage, env: Record<string, string | undefined> = process.env): boolean {
  const headers = request.headers;
  const single = (name: string) => typeof headers[name] === 'string' ? headers[name] as string : undefined;
  let scheme = (request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  let host = single('host');
  if (!host || !authority(host, scheme)) return false;
  const peers = (env.DEVICE_WS_TRUSTED_PROXIES ?? '').split(',').map(v => ip(v.trim())).filter(v => isIP(v));
  const trusted = peers.includes(ip(request.socket.remoteAddress ?? ''));
  if (trusted) {
    if (headers['x-forwarded-proto'] !== undefined) {
      const forwarded = single('x-forwarded-proto');
      if (forwarded !== 'http' && forwarded !== 'https') return false;
      scheme = forwarded;
    }
    if (headers['x-forwarded-host'] !== undefined) {
      host = single('x-forwarded-host');
      if (!host) return false;
    }
  }
  const expected = authority(host, scheme);
  if (!expected) return false;
  const hosts = (env.DEVICE_WS_ALLOWED_HOSTS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (hosts.length && !hosts.some(h => authority(h, scheme) === expected)) return false;
  if (headers.origin === undefined) return true; // Embedded devices do not send browser Origin.
  const actual = single('origin');
  const normalized = actual && origin(actual);
  if (!normalized) return false;
  return normalized === expected || (env.CORS_ORIGINS ?? '').split(',').some(v => origin(v.trim()) === normalized);
}
