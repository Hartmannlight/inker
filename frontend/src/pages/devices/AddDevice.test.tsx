import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationProvider } from '../../contexts/NotificationContext';
import { AddDevice } from './AddDevice';

const { create, createEnrollment, getContentAssignmentChoices } = vi.hoisted(() => ({
  create: vi.fn(),
  createEnrollment: vi.fn(),
  getContentAssignmentChoices: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  deviceService: { create, createEnrollment, getContentAssignmentChoices },
}));

vi.mock('../../utils/qrcode', () => ({
  generateQRCodeDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
}));

vi.mock('../../components/layout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('AddDevice pairing action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({
      id: 7,
      name: 'Touch panel',
      deviceType: 'web-display',
      externalId: 'touch-panel',
      profileId: 'esp32-touch-reference-480x480',
    });
    createEnrollment.mockResolvedValue({
      enrollmentId: 'enrollment-7',
      deviceId: 7,
      code: 'ABCDE-FGHJK',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    getContentAssignmentChoices.mockResolvedValue({ screens: [], playlists: [] });
  });

  it('lets an admin choose a profile and creates the short-code enrollment after the device', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NotificationProvider>
          <AddDevice />
        </NotificationProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Device name'), 'Touch panel');
    await user.selectOptions(screen.getByLabelText('Device profile'), 'esp32-touch-reference-480x480');
    await user.click(screen.getByRole('button', { name: 'Create and pair' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Touch panel',
      deviceType: 'web-display',
      profileId: 'esp32-touch-reference-480x480',
      width: 480,
      height: 480,
    })));
    expect(await screen.findByText('ABCDE-FGHJK')).toBeInTheDocument();
    expect(createEnrollment).toHaveBeenCalledWith('7');
  });
});
