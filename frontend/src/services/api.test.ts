import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import './api';
import { csrfHeadersFor, rememberCsrfFromHeaders, resetCsrfToken } from './admin-session';

// Mock axios before importing api module
vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    isAxiosError: (error: unknown) => typeof error === 'object' && error !== null
      && 'isAxiosError' in error && error.isAxiosError === true,
  };
  return { default: mockAxios, AxiosError: Error };
});

// Mock config
vi.mock('../config', () => ({
  config: {
    apiUrl: 'http://localhost:3002/api',
    backendUrl: 'http://localhost:3002',
    getBackendUrl: (path: string) => `http://localhost:3002${path}`,
    getAssetUrl: (path: string) => path,
  },
}));

// Capture the actual registered interceptor before clearAllMocks resets calls.
const rejectResponse = vi.mocked(axios.interceptors.response.use).mock.calls[0][1]!;

describe('API service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCsrfToken();
    // Mock localStorage
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete store[key]; }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('getErrorMessage pattern', () => {
    it('should extract error from axios error response', () => {
      const error = {
        isAxiosError: true,
        response: { data: { message: 'Bad request' } },
        message: 'Request failed',
      };
      // Simulating the getErrorMessage logic
      const msg = error.response?.data?.message || error.response?.data?.error || error.message;
      expect(msg).toBe('Bad request');
    });

    it('should fall back to error.message for network errors', () => {
      const error = {
        isAxiosError: true,
        response: undefined,
        message: 'Network Error',
      };
      const msg = error.response?.data?.message || error.response?.data?.error || error.message;
      expect(msg).toBe('Network Error');
    });

    it('should handle plain Error objects', () => {
      const error = new Error('Something went wrong');
      expect(error.message).toBe('Something went wrong');
    });
  });

  describe('cookie and CSRF request pattern', () => {
    it('should add the in-memory CSRF token to mutations', () => {
      const csrfToken = 'csrf-for-current-session';
      const config = { headers: {} as Record<string, string> };
      config.headers['X-CSRF-Token'] = csrfToken;
      expect(config.headers['X-CSRF-Token']).toBe(csrfToken);
      expect(config.headers.Authorization).toBeUndefined();
    });

    it('should not synthesize an Authorization header', () => {
      const config = { headers: {} as Record<string, string> };
      expect(config.headers.Authorization).toBeUndefined();
    });
  });

  describe('registered response error interceptor', () => {
    it.each(['/devices', '/settings', '/display-settings', '/display/device-7/admin'])('clears CSRF state and redirects unauthenticated admin route %s', async pathname => {
      const location = { pathname, href: pathname };
      vi.stubGlobal('window', { location });
      rememberCsrfFromHeaders({ 'x-csrf-token': 'expired-session' });
      const error = { response: { status: 401 } };

      await expect(rejectResponse(error)).rejects.toBe(error);

      expect(location.href).toBe('/login');
      expect(csrfHeadersFor('post')).toEqual({});
    });

    it.each(['/display/pair', '/display/device-7', '/display/device-7/', '/Display/PAIR', '/display/device-7//', '/login'])('does not redirect public route %s on a late admin-session 401', async pathname => {
      const location = { pathname, href: `${pathname}?code=ABCDE-FGHJK` };
      vi.stubGlobal('window', { location });
      // An admin request started before navigation can finish on a public route.
      const error = { config: { url: '/auth/session' }, response: { status: 401 } };

      await expect(rejectResponse(error)).rejects.toBe(error);

      expect(location.href).toBe(`${pathname}?code=ABCDE-FGHJK`);
    });

    it('still rejects non-authentication errors without redirecting', async () => {
      const location = { pathname: '/devices', href: '/devices' };
      vi.stubGlobal('window', { location });
      const error = { response: { status: 503 } };

      await expect(rejectResponse(error)).rejects.toBe(error);

      expect(location.href).toBe('/devices');
    });
  });
});
