import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePairingPanel } from './DevicePairingPanel';

const { createEnrollment, generateQRCodeDataUrl } = vi.hoisted(() => ({
  createEnrollment: vi.fn(),
  generateQRCodeDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
}));

vi.mock('../../services/api', () => ({
  deviceService: { createEnrollment },
}));

vi.mock('../../utils/qrcode', () => ({
  generateQRCodeDataUrl,
}));

describe('DevicePairingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEnrollment.mockResolvedValue({
      enrollmentId: 'enrollment-7',
      deviceId: 7,
      code: 'ABCDE-FGHJK',
      createdAt: '2026-08-25T10:00:00.000Z',
      expiresAt: '2026-08-25T10:10:00.000Z',
    });
  });

  it('creates an admin enrollment and shows profile, base URL, formatted code, QR and expiry', async () => {
    render(
      <DevicePairingPanel
        deviceId="7"
        deviceName="Kitchen display"
        profileId="browser-hd-1920x1080"
        baseUrl="https://inker.example"
        now={() => new Date('2026-08-25T10:02:00.000Z')}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Gerät koppeln' }));

    await screen.findByText('ABCDE-FGHJK');
    expect(createEnrollment).toHaveBeenCalledWith('7');
    expect(screen.getByText('browser-hd-1920x1080')).toBeInTheDocument();
    expect(screen.getByText('https://inker.example')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'QR-Code zum Koppeln von Kitchen display' })).toHaveAttribute('src', 'data:image/png;base64,qr');
    const qrUrl = new URL(generateQRCodeDataUrl.mock.calls[0][0]);
    expect(qrUrl.origin).toBe('https://inker.example');
    expect([...qrUrl.searchParams.keys()]).toEqual(['mode', 'code']);
    expect(qrUrl.searchParams.get('mode')).toBe('pair');
    expect(qrUrl.searchParams.get('code')).toBe('ABCDE-FGHJK');
    expect(qrUrl.toString()).not.toContain('credential');
    expect(screen.getByText(/8:00/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('opaque-long-lived-secret');
  });

  it('marks an enrollment expired and removes code and QR from visible state', async () => {
    let current = new Date('2026-08-25T10:02:00.000Z');
    render(
      <DevicePairingPanel
        deviceId="7"
        deviceName="Kitchen display"
        profileId="browser-hd-1920x1080"
        baseUrl="https://inker.example"
        now={() => current}
        tickMs={10}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Gerät koppeln' }));
    await screen.findByText('ABCDE-FGHJK');
    current = new Date('2026-08-25T10:11:00.000Z');

    await waitFor(() => expect(screen.getByText('Code abgelaufen')).toBeInTheDocument());
    expect(screen.queryByText('ABCDE-FGHJK')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR-Code/ })).not.toBeInTheDocument();
  });

  it('warns visibly when an explicitly enabled HTTP base URL is used', async () => {
    render(
      <DevicePairingPanel
        deviceId="7"
        deviceName="Kitchen display"
        profileId="browser-hd-1920x1080"
        baseUrl="http://192.168.1.20"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Gerät koppeln' }));
    expect(await screen.findByText(/Unsicheres HTTP/)).toBeInTheDocument();
  });

  it('auto-starts exactly one enrollment in React strict mode', async () => {
    render(
      <StrictMode>
        <DevicePairingPanel
          deviceId="7"
          deviceName="Kitchen display"
          profileId="browser-hd-1920x1080"
          baseUrl="https://inker.example"
          autoStart
        />
      </StrictMode>,
    );

    await screen.findByText('ABCDE-FGHJK');
    expect(createEnrollment).toHaveBeenCalledTimes(1);
  });
});
