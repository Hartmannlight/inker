import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosClient, requestUse } = vi.hoisted(() => {
  const requestUse = vi.fn();
  const axiosClient = {
    interceptors: {
      request: { use: requestUse },
      response: { use: vi.fn() },
    },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { axiosClient, requestUse };
});

vi.mock('axios', () => ({
  default: {
    ...axiosClient,
    create: vi.fn(() => axiosClient),
    isAxiosError: (error: unknown) => !!error && typeof error === 'object' && 'isAxiosError' in error,
  },
  AxiosError: Error,
}));

vi.mock('../config', () => ({
  config: {
    apiUrl: 'https://inker.example/api',
    backendUrl: 'https://inker.example',
    getBackendUrl: (path: string) => `https://inker.example${path}`,
    getAssetUrl: (path: string) => path,
  },
}));

import { deviceService } from './api';
import { rememberCsrfFromHeaders, resetCsrfToken } from './admin-session';

describe('device enrollment admin API', () => {
  beforeEach(() => {
    axiosClient.post.mockReset();
    resetCsrfToken();
  });

  it('uses the unchanged protected endpoint without a request DTO', async () => {
    axiosClient.post.mockResolvedValue({
      data: {
        data: {
          enrollmentId: 'enrollment-7',
          deviceId: 7,
          code: 'ABCDE-FGHJK',
          expiresAt: '2026-08-25T10:10:00.000Z',
          createdAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });

    const result = await deviceService.createEnrollment('7');

    expect(axiosClient.post).toHaveBeenCalledWith('/devices/7/enrollments');
    expect(result).toEqual({
      enrollmentId: 'enrollment-7',
      deviceId: 7,
      code: 'ABCDE-FGHJK',
      expiresAt: '2026-08-25T10:10:00.000Z',
      createdAt: '2026-08-25T10:00:00.000Z',
    });
    expect(result).not.toHaveProperty('credential');
    expect(result).not.toHaveProperty('credentialId');
  });

  it('uses the HttpOnly cookie implicitly and adds the session-bound CSRF header', () => {
    rememberCsrfFromHeaders({ 'x-csrf-token': 'admin-csrf' });
    const requestInterceptor = requestUse.mock.calls[0][0] as (config: {
      method: string;
      headers: Record<string, string>;
    }) => {
      headers: Record<string, string>;
    };

    const result = requestInterceptor({ method: 'post', headers: {} });

    expect(result.headers['X-CSRF-Token']).toBe('admin-csrf');
    expect(result.headers.Authorization).toBeUndefined();
  });
});
