import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrafanaPanelSource } from './GrafanaPanelSource';

const api = vi.hoisted(() => ({ post: vi.fn().mockResolvedValue({ data: { definition: { sourceDefinitionId: 'source-1' } } }), get: vi.fn() }));
vi.mock('../../services/api', () => ({ default: api }));
vi.mock('../../components/layout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../../contexts/NotificationContext', () => ({ useNotification: () => ({ success: vi.fn(), error: vi.fn() }) }));

describe('GrafanaPanelSource', () => {
  beforeEach(() => { api.post.mockReset(); api.get.mockReset(); });

  it('submits a write-only token only to the Inker source command', async () => {
    api.post.mockResolvedValue({ data: { definition: { sourceDefinitionId: 'source-1' } } });
    const user = userEvent.setup();
    render(<MemoryRouter><GrafanaPanelSource /></MemoryRouter>);
    await user.type(screen.getByLabelText('Source name'), 'Panel');
    await user.type(screen.getByLabelText('Grafana base URL'), 'https://grafana.example');
    await user.type(screen.getByLabelText('Viewer service-account token'), 'viewer-token');
    await user.type(screen.getByLabelText('Dashboard UID'), 'dash');
    await user.type(screen.getByLabelText('Panel ID'), '1');
    await user.click(screen.getByRole('button', { name: 'Queue panel refresh' }));
    expect(api.post).toHaveBeenCalledWith('/sources', expect.objectContaining({ connectorType: 'grafana', secret: 'viewer-token', configuration: expect.objectContaining({ operation: 'render', dashboardUid: 'dash', panelId: 1 }) }));
    expect(screen.getByText('Panel source queued: source-1')).toBeInTheDocument();
  });

  it('creates a publication draft only from a persisted successful source snapshot', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValueOnce({ data: { definition: { sourceDefinitionId: 'source-1' } } })
      .mockResolvedValueOnce({ data: { revision: 1 } });
    api.get.mockResolvedValueOnce({ data: { snapshot: { snapshotId: 'snapshot-1', freshness: { state: 'fresh' } } } })
      .mockRejectedValueOnce({ response: { status: 404 } });
    render(<MemoryRouter><GrafanaPanelSource /></MemoryRouter>);
    await user.type(screen.getByLabelText('Source name'), 'Panel');
    await user.type(screen.getByLabelText('Grafana base URL'), 'https://grafana.example');
    await user.type(screen.getByLabelText('Viewer service-account token'), 'viewer-token');
    await user.type(screen.getByLabelText('Dashboard UID'), 'dash');
    await user.type(screen.getByLabelText('Panel ID'), '1');
    await user.click(screen.getByRole('button', { name: 'Queue panel refresh' }));
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    await user.click(screen.getByRole('button', { name: 'Create publication draft' }));
    expect(api.post).toHaveBeenLastCalledWith('/publications/grafana-source-1/publish', expect.objectContaining({
      expectedRevision: 0, deviceIds: [], draft: { sourceSnapshotId: 'snapshot-1' },
    }));
    expect(JSON.stringify(api.post.mock.calls.at(-1))).not.toContain('viewer-token');
    expect(screen.getByText('Publication draft revision 1 is ready for device assignment.')).toBeInTheDocument();
  });
});
