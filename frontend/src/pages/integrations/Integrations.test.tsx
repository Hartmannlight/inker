import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Integrations } from './Integrations';

vi.mock('../../components/layout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('Integrations', () => {
  it('separates beta provider connections from advanced data sources', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Integrations /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Grafana' })).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add Grafana panel' })).toHaveAttribute('href', '/integrations/grafana');
    expect(screen.queryByText('New Data Source')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Data sources (advanced)' }));
    expect(screen.getByRole('heading', { name: 'Advanced data sources' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create data source' })).toHaveAttribute('href', '/data-sources/new');
  });
});
