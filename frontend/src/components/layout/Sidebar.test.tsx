import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

vi.mock('../../services/api', () => ({
  dashboardService: { checkForUpdate: vi.fn().mockReturnValue(new Promise(() => {})) },
}));
vi.mock('../../contexts/NotificationContext', () => ({
  useNotification: () => ({ success: vi.fn(), error: vi.fn() }),
}));

describe('Sidebar', () => {
  it('keeps integrations and extensions separate without legacy plugin or coffee navigation', () => {
    render(<MemoryRouter initialEntries={['/integrations']}><Sidebar /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/integrations');
    expect(screen.getByRole('link', { name: 'Extensions' })).toHaveAttribute('href', '/extensions');
    expect(screen.queryByRole('link', { name: 'Plugins' })).not.toBeInTheDocument();
    expect(screen.queryByText(/buy me a coffee/i)).not.toBeInTheDocument();
    expect(screen.queryByText('System Online')).not.toBeInTheDocument();
  });
});
