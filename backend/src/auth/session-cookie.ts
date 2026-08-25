import type { CookieOptions, Request, Response } from 'express';
import { ADMIN_SESSION_IDLE_TTL_MS } from './admin-session.service';

export const ADMIN_SESSION_COOKIE = 'inker_admin_session';

export function requestUsesHttps(request: Pick<Request, 'secure' | 'protocol' | 'headers'>): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const forwardedProtocol = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  return request.secure || request.protocol === 'https' || forwardedProtocol === 'https';
}

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/api',
    maxAge: ADMIN_SESSION_IDLE_TTL_MS,
  };
}

export function setSessionCookie(response: Response, request: Request, token: string): void {
  response.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(requestUsesHttps(request)));
}

export function clearSessionCookie(response: Response, request: Request): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(requestUsesHttps(request));
  response.clearCookie(ADMIN_SESSION_COOKIE, options);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
