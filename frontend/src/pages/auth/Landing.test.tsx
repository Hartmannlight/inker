import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Landing } from './Landing';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

const exchangeResult = {
  data: {
    credential: 'new-device-credential',
    credentialId: 'credential-7',
    device: {
      id: 7,
      name: 'Display 7',
      externalId: 'display-7',
      profileId: 'browser-hd-1920x1080',
    },
  },
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function renderLanding(path = '/?mode=pair') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<><Landing /><LocationProbe /></>} />
        <Route path="/display/:externalId" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('Landing display pairing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a manual code, stores only the credential, and navigates to the display', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(response(200, exchangeResult));
    vi.stubGlobal('fetch', fetchMock);
    renderLanding();

    await user.type(screen.getByLabelText('Pairing code'), 'abcd-o 1l23z');
    await user.click(screen.getByRole('button', { name: 'Pair display' }));

    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/display/display-7'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/device-enrollments/exchange',
      expect.objectContaining({ body: JSON.stringify({ code: 'ABCD01123Z' }) }),
    );
    expect(localStorage.getItem('inker_display_display-7')).toBe('new-device-credential');
    expect(screen.getByLabelText('location').textContent).not.toContain('new-device-credential');
  });

  it('exchanges a QR code automatically, removes it from history, and preserves diagnostic flags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, exchangeResult));
    vi.stubGlobal('fetch', fetchMock);

    renderLanding('/?mode=pair&code=ABCDE-FGHJK&test=timers');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/display/display-7?test=timers'));
    expect(screen.getByLabelText('location').textContent).not.toContain('ABCDE');
    expect(localStorage.getItem('inker_display_display-7')).toBe('new-device-credential');
  });

  it.each([
    [400, 'This code is invalid, expired, or has already been used.'],
    [403, 'Pairing requires HTTPS.'],
    [429, 'Too many attempts. Wait one minute and try again.'],
  ])('keeps an existing credential when exchange returns HTTP %s', async (status, expectedMessage) => {
    localStorage.setItem('inker_display_display-7', 'keep-me');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status, { message: 'opaque error' })));

    renderLanding('/?mode=pair&code=ABCDE-FGHJK');

    expect(await screen.findByText(expectedMessage, { exact: false })).toBeInTheDocument();
    expect(localStorage.getItem('inker_display_display-7')).toBe('keep-me');
    expect(screen.getByLabelText('location').textContent).not.toContain('code=');
  });

  it('validates locally and reports an unreachable server without replacing a credential', async () => {
    const user = userEvent.setup();
    localStorage.setItem('inker_display_display-7', 'keep-me');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderLanding();

    await user.type(screen.getByLabelText('Pairing code'), 'short');
    await user.click(screen.getByRole('button', { name: 'Pair display' }));
    expect(await screen.findByText('Enter a valid ten-character pairing code.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Pairing code'));
    await user.type(screen.getByLabelText('Pairing code'), 'ABCDE-FGHJK');
    await user.click(screen.getByRole('button', { name: 'Pair display' }));
    expect(await screen.findByText('Inker is not reachable. Check the network connection.')).toBeInTheDocument();
    expect(localStorage.getItem('inker_display_display-7')).toBe('keep-me');
  });
});
