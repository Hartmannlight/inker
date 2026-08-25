import { describe, expect, test } from 'bun:test';
import { ADMIN_SESSION_IDLE_TTL_MS } from './admin-session.service';
import { sessionCookieOptions } from './session-cookie';

describe('admin session cookie contract', () => {
  test('uses HttpOnly, SameSite=Strict and the idle timeout over HTTP', () => {
    expect(sessionCookieOptions(false)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api',
      maxAge: ADMIN_SESSION_IDLE_TTL_MS,
    });
  });

  test('adds Secure when the browser request is HTTPS', () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
  });
});
