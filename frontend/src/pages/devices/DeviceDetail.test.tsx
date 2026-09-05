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
    updateDisplayControl: vi.fn(), updateDisplayTechnology: vi.fn(),
  },
  modelService: { getAll: vi.fn() },
  playlistService: { publishFromDraft: vi.fn() },
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
      if (source.includes('getContentAssignmentChoices')) return { data: { current: { desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null }, target: { width: 1920, height: 1080, renderFormats: ['png'], backgroundColor: '#000000' }, screens: [{ id: 9, name: 'Small portrait', width: 480, height: 800, updatedAt: '2026-08-29T00:00:00.000Z', compatibility: { kind: 'risky', reason: 'The screen and device have different orientations.' } }], playlists: [], unpublishedPlaylists: [] }, isLoading: false, refetch: vi.fn() };
      return { data: [], isLoading: false, error: null, refetch: vi.fn() };
    });
  });

  it('marks a risky screen semantically and requires a single review before assignment', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/devices/4']}><Routes><Route path="/devices/:id" element={<DeviceDetail />} /></Routes></MemoryRouter>);
    expect(screen.getByRole('button', { name: /E-ink/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('heading', { name: 'LCD display' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change content' }));
    const choice = screen.getByRole('button', { name: /Small portrait.*Risky.*Single screen/i });
    expect(choice).toHaveAccessibleName(/Risky: The screen and device have different orientations/);
    await user.click(choice);
    expect(screen.getByRole('dialog', { name: 'Review screen fit' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Target device preview with safe area' })).toHaveStyle({ backgroundColor: 'rgb(0, 0, 0)' });
    expect(screen.getByRole('button', { name: 'Assign after review' })).toBeInTheDocument();
  });

  it('shows an unpublished playlist as a publish-and-assign choice', async () => {
    useApi.mockImplementation((factory: () => unknown) => {
      const source = factory.toString();
      if (source.includes('getById')) return { data: { id: 4, name: 'Browser', status: 'online', deviceType: 'web-display', transport: 'websocket', lastSeenAt: new Date().toISOString(), battery: 0, wifi: 0, userId: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, isLoading: false, error: null, refetch: vi.fn() };
      if (source.includes('getContentAssignmentChoices')) return { data: { current: { desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null }, screens: [], playlists: [], unpublishedPlaylists: [{ playlistId: 7, name: 'Kitchen rotation', draftHash: 'a'.repeat(64) }] }, isLoading: false, refetch: vi.fn() };
      return { data: [], isLoading: false, error: null, refetch: vi.fn() };
    });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/devices/4']}><Routes><Route path="/devices/:id" element={<DeviceDetail />} /></Routes></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Change content' }));

    expect(screen.getByRole('button', { name: /Kitchen rotation.*Publish current draft and assign/i })).toBeInTheDocument();
  });

  it('shows device-level theme, brightness, and scheduled dimming controls only for RGB hardware', async () => {
    useApi.mockImplementation((factory: () => unknown) => {
      const source = factory.toString();
      if (source.includes('getById')) return { data: {
        id: 4, name: 'Kitchen LCD', status: 'online', deviceType: 'web-display', transport: 'websocket',
        profileId: 'esp32-touch-reference-480x480',
        capabilities: { profileId: 'esp32-touch-reference-480x480', display: { colorSpace: 'rgb' } },
        configuration: { displayControl: { brightness: 80, scheduleEnabled: true, dimStartAt: '22:00', dimStopAt: '07:00', dimBrightness: 10, timezone: 'Europe/Berlin' } },
        lastSeenAt: new Date().toISOString(), battery: 0, wifi: 0, userId: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, isLoading: false, error: null, refetch: vi.fn() };
      if (source.includes('getContentAssignmentChoices')) return { data: { current: { desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null }, screens: [], playlists: [], unpublishedPlaylists: [] }, isLoading: false, refetch: vi.fn() };
      return { data: [], isLoading: false, error: null, refetch: vi.fn() };
    });

    render(<MemoryRouter initialEntries={['/devices/4']}><Routes><Route path="/devices/:id" element={<DeviceDetail />} /></Routes></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'LCD display' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Display type' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LCD.*color/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Web-connected device')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Europe/Berlin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dark preset' }));
    expect(screen.getByLabelText('LCD background color')).toHaveValue('#000000');
    expect(screen.getByLabelText('LCD foreground color')).toHaveValue('#ffffff');
  });
});
