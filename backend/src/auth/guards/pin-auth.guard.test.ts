import { beforeEach, describe, expect, test } from 'bun:test';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PinAuthGuard } from './pin-auth.guard';
import { createMock } from '../../test/mocks/helpers';

describe('PinAuthGuard', () => {
  let reflector: any;
  let sessions: any;
  let guard: PinAuthGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: createMock().mockReturnValue(false) };
    sessions = {
      validate: createMock().mockResolvedValue({
        sessionId: 'session-1',
        adminId: 'admin-1',
        expiresAt: new Date(Date.now() + 1000),
      }),
      verifyCsrf: createMock().mockResolvedValue(true),
    };
    guard = new PinAuthGuard(reflector, sessions);
  });

  function context(options: { method?: string; headers?: Record<string, string> } = {}) {
    const request = {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      protocol: 'http',
      secure: false,
    } as any;
    const response = { cookie: createMock() };
    return {
      request,
      response,
      execution: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as any,
    };
  }

  test('leaves public and device-authenticated routes untouched', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(await guard.canActivate(context().execution)).toBe(true);
    expect(sessions.validate.calls.length).toBe(0);
  });

  test('accepts a valid HttpOnly cookie and attaches only session metadata', async () => {
    const ctx = context({ headers: { cookie: 'inker_admin_session=opaque-token' } });
    expect(await guard.canActivate(ctx.execution)).toBe(true);
    expect(sessions.validate.calls[0][0]).toBe('opaque-token');
    expect(ctx.request.adminSession).toMatchObject({ sessionId: 'session-1', adminId: 'admin-1' });
  });

  test('keeps the existing Bearer header as a controlled non-browser legacy path', async () => {
    const ctx = context({ method: 'POST', headers: { authorization: 'Bearer legacy-session-token' } });
    expect(await guard.canActivate(ctx.execution)).toBe(true);
    expect(sessions.validate.calls[0][0]).toBe('legacy-session-token');
    expect(sessions.verifyCsrf.calls.length).toBe(0);
  });

  test('rejects missing authentication', async () => {
    await expect(guard.canActivate(context().execution)).rejects.toThrow(UnauthorizedException);
  });

  test('rejects missing, wrong or foreign CSRF tokens for cookie mutations', async () => {
    for (const csrfToken of [undefined, 'wrong-token', 'token-from-another-session']) {
      sessions.verifyCsrf.mockResolvedValue(false);
      const headers: Record<string, string> = { cookie: 'inker_admin_session=opaque-token' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      await expect(guard.canActivate(context({ method: 'POST', headers }).execution))
        .rejects.toThrow(ForbiddenException);
    }
  });

  test('accepts a cookie mutation with the session-bound CSRF token', async () => {
    const ctx = context({
      method: 'PATCH',
      headers: {
        cookie: 'inker_admin_session=opaque-token',
        'x-csrf-token': 'matching-token',
      },
    });
    expect(await guard.canActivate(ctx.execution)).toBe(true);
    expect(sessions.verifyCsrf.calls[0]).toEqual(['session-1', 'matching-token']);
  });

  test('rotates the cookie when validation rotates the server-side token', async () => {
    sessions.validate.mockResolvedValue({
      sessionId: 'session-1',
      adminId: 'admin-1',
      expiresAt: new Date(Date.now() + 1000),
      rotatedToken: 'new-token',
    });
    const ctx = context({ headers: { cookie: 'inker_admin_session=old-token' } });
    await guard.canActivate(ctx.execution);
    expect(ctx.response.cookie.calls[0][0]).toBe('inker_admin_session');
    expect(ctx.response.cookie.calls[0][1]).toBe('new-token');
  });
});
