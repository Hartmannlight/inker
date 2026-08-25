import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminSessions } from './AdminSessions';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  logoutAll: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  authService: {
    listSessions: mocks.listSessions,
    revokeSession: mocks.revokeSession,
  },
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ logoutAll: mocks.logoutAll }),
}));

describe('AdminSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSessions.mockResolvedValue([
      {
        sessionId: 'current-session',
        createdAt: '2026-08-25T10:00:00.000Z',
        lastSeenAt: '2026-08-25T10:05:00.000Z',
        expiresAt: '2026-08-25T18:00:00.000Z',
        userAgent: 'Current Browser',
        current: true,
      },
      {
        sessionId: 'other-session',
        createdAt: '2026-08-25T09:00:00.000Z',
        lastSeenAt: '2026-08-25T09:05:00.000Z',
        expiresAt: '2026-08-25T17:00:00.000Z',
        userAgent: 'Other Browser',
        current: false,
      },
    ]);
    mocks.revokeSession.mockResolvedValue(undefined);
    mocks.logoutAll.mockResolvedValue(undefined);
  });

  test('shows metadata only and revokes another session', async () => {
    render(<AdminSessions />);
    expect(await screen.findByText(/Current Browser/)).toBeInTheDocument();
    expect(screen.getByText(/Other Browser/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/token|csrf|cookie|hash/i);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(mocks.revokeSession).toHaveBeenCalledWith('other-session');
    await waitFor(() => expect(screen.queryByText(/Other Browser/)).not.toBeInTheDocument());
  });

  test('offers logout-all without exposing a session secret', async () => {
    render(<AdminSessions />);
    await userEvent.click(await screen.findByRole('button', { name: 'Log out all' }));
    expect(mocks.logoutAll).toHaveBeenCalledOnce();
  });
});
