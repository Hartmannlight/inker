import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../services/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api')>(), authService: mocks,
}));

function Harness() {
  const auth = useAuth();
  return (
    <div>
      <span>{auth.isLoading ? 'loading' : auth.isAuthenticated ? 'authenticated' : 'anonymous'}</span>
      <button onClick={() => auth.login('admin password')}>login</button>
      <button onClick={() => auth.logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider cookie session lifecycle', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/devices');
    vi.clearAllMocks();
    mocks.validate.mockResolvedValue(undefined);
    mocks.login.mockResolvedValue(undefined);
    mocks.logout.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  test('reload validates the HttpOnly cookie and never reads a bearer token', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    render(<AuthProvider><Harness /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
    expect(mocks.validate).toHaveBeenCalledOnce();
    expect(getItem).not.toHaveBeenCalledWith('inker_session');
  });

  test.each(['/display/pair', '/display/pair?code=ABCDE-FGHJK', '/display/device-7', '/display/device-7/', '/Display/PAIR', '/display/device-7//'])('does not require an admin session on public route %s', async path => {
    window.history.replaceState({}, '', path);
    mocks.validate.mockRejectedValue(new Error('Admin session absent'));
    render(<AuthProvider><Harness /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(path.split('?')[0]);
  });

  test.each(['/devices', '/settings', '/display-settings', '/display/device-7/admin'])('still validates admin state for %s', async path => {
    window.history.replaceState({}, '', path);
    render(<AuthProvider><Harness /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
    expect(mocks.validate).toHaveBeenCalledOnce();
  });

  test('login and logout update state without writing an admin token', async () => {
    mocks.validate.mockRejectedValueOnce(new Error('no session'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<AuthProvider><Harness /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'login' }));
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
    expect(setItem).not.toHaveBeenCalledWith('inker_session', expect.anything());

    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
  });
});
