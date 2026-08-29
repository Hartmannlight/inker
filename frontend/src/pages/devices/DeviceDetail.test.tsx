import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceDetail } from './DeviceDetail';

const { assignContent, getPublishedPreview, useApi } = vi.hoisted(() => ({ assignContent: vi.fn(), getPublishedPreview: vi.fn().mockResolvedValue(null), useApi: vi.fn() }));

vi.mock('../../services/api', () => ({
  deviceService: {
    getById: vi.fn(), getContentAssignmentChoices: vi.fn(), getPublishedPreview,
    delete: vi.fn(), refresh: vi.fn(), assignContent, getLogs: vi.fn(), setModel: vi.fn(),
  },
  modelService: { getAll: vi.fn() },
}));

vi.mock('../../hooks/useApi', () => ({
  useApi,
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isLoading: false })),
}));

vi.mock('../../components/layout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../components/devices/DevicePairingPanel', () => ({ DevicePairingPanel: () => null }));
vi.mock('./DevicePublishedPreview', () => ({ DevicePublishedPreview: () => null }));
vi.mock('../../components/common', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
  LoadingSpinner: () => null, Modal: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: React.ReactNode }) => isOpen ? <section role="dialog" aria-label={title}>{children}</section> : null,
  BatteryIndicator: () => null, WifiIndicator: () => null, OnlineStatus: () => null,
}));
vi.mock('../../components/common/OnlineStatus', () => ({ OnlineStatusBadge: () => null }));

describe('DeviceDetail content compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApi.mockImplementation((factory: () => unknown) => {
      const source = factory.toString();
      if (source.includes('getById')) return { data: { id: 4, name: 'Browser', status: 'online', deviceType: 'web-display', transport: 'websocket', lastSeenAt: new Date().toISOString(), battery: 0, wifi: 0, userId: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, isLoading: false, error: null, refetch: vi.fn() };
      if (source.includes('getContentAssignmentChoices')) return { data: { current: { desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null }, target: { width: 1920, height: 1080, renderFormats: ['png'], backgroundColor: '#000000' }, screens: [{ id: 9, name: 'Small portrait', width: 480, height: 800, updatedAt: '2026-08-29T00:00:00.000Z', compatibility: { kind: 'risky', reason: 'The screen and device have different orientations.' } }], playlists: [] }, isLoading: false, refetch: vi.fn() };
      return { data: [], isLoading: false, error: null, refetch: vi.fn() };
    });
  });

  it('marks a risky screen semantically and requires a single review before assignment', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/devices/4']}><Routes><Route path="/devices/:id" element={<DeviceDetail />} /></Routes></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Change content' }));
    const choice = screen.getByRole('button', { name: /Small portrait.*Risky.*Single screen/i });
    expect(choice).toHaveAccessibleName(/Risky: The screen and device have different orientations/);
    await user.click(choice);
    expect(screen.getByRole('dialog', { name: 'Review screen fit' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Target device preview with safe area' })).toHaveStyle({ backgroundColor: 'rgb(0, 0, 0)' });
    expect(screen.getByRole('button', { name: 'Assign after review' })).toBeInTheDocument();
  });
});
