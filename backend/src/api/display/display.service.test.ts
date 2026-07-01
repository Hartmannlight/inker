import { describe, it, expect, beforeEach } from 'bun:test';
import { DisplayService } from './display.service';
import { createMockPrisma } from '../../test/mocks/prisma.mock';
import { createMock } from '../../test/mocks/helpers';

describe('DisplayService', () => {
  let service: DisplayService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockConfig: any;
  let mockDefaultScreenService: any;
  let mockSleepScreenService: any;
  let mockScreenRendererService: any;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    mockConfig = {
      get: createMock().mockImplementation((key: string) =>
        key === 'defaultTimezone' ? 'UTC' : 'http://localhost:3002',
      ),
    };
    mockDefaultScreenService = {
      getDefaultScreenUrl: createMock().mockReturnValue('/uploads/default-screen.png'),
      getDefaultScreenBase64: createMock().mockResolvedValue('base64data'),
      getDefaultScreenBuffer: createMock().mockResolvedValue(Buffer.from('PNG')),
      getDefaultScreenPreviewBuffer: createMock().mockResolvedValue(Buffer.from('PNG')),
      ensureDefaultScreenExists: createMock().mockResolvedValue(undefined),
    };
    mockSleepScreenService = {
      getSleepScreen: createMock().mockResolvedValue({
        url: '/assets/sleep-800x480-0700.png',
        filename: 'sleep-800x480-0700.png',
      }),
      getSleepScreenBase64: createMock().mockResolvedValue('base64sleep'),
      getSleepScreenBuffer: createMock().mockResolvedValue(Buffer.from('SLEEPPNG')),
    };
    mockScreenRendererService = {
      renderScreenDesign: createMock().mockResolvedValue(Buffer.from('PNG')),
    };
    service = new DisplayService(
      mockPrisma as any,
      mockConfig,
      mockDefaultScreenService,
      mockSleepScreenService,
      mockScreenRendererService,
    );
  });

  describe('getCurrentScreen (private)', () => {
    const getCurrentScreen = (items: any[], lastScreenId: string | null = null, screenStartedAt: Date | null = null) =>
      (service as any).getCurrentScreen(items, lastScreenId, screenStartedAt);

    it('should return null for empty items', () => {
      expect(getCurrentScreen([], null, null)).toBeNull();
      expect(getCurrentScreen(null as any, null, null)).toBeNull();
    });

    it('should return single item without screen change', () => {
      const items = [{ id: 1, duration: 60 }];
      const result = getCurrentScreen(items);
      expect(result.item.id).toBe(1);
      expect(result.screenChanged).toBe(false);
    });

    it('should start at first item when no previous screen', () => {
      const items = [
        { id: 1, screenDesign: { id: 1 }, duration: 300 },
        { id: 2, screenDesign: { id: 2 }, duration: 60 },
      ];
      const result = getCurrentScreen(items, null, null);
      expect(result.item.id).toBe(1);
      expect(result.screenChanged).toBe(true);
    });

    it('should keep current screen when duration not expired', () => {
      const items = [
        { id: 1, screenDesign: { id: 1 }, duration: 300 },
        { id: 2, screenDesign: { id: 2 }, duration: 60 },
      ];
      // Screen started 100 seconds ago, duration is 300
      const startedAt = new Date(Date.now() - 100_000);
      const result = getCurrentScreen(items, 'design-1', startedAt);
      expect(result.item.id).toBe(1);
      expect(result.screenChanged).toBe(false);
    });

    it('should advance to next screen when duration expired', () => {
      const items = [
        { id: 1, screenDesign: { id: 1 }, duration: 300 },
        { id: 2, screenDesign: { id: 2 }, duration: 60 },
      ];
      // Screen started 301 seconds ago, duration is 300
      const startedAt = new Date(Date.now() - 301_000);
      const result = getCurrentScreen(items, 'design-1', startedAt);
      expect(result.item.id).toBe(2);
      expect(result.screenChanged).toBe(true);
    });

    it('should wrap around to first screen after last', () => {
      const items = [
        { id: 1, screenDesign: { id: 1 }, duration: 300 },
        { id: 2, screenDesign: { id: 2 }, duration: 60 },
      ];
      // On screen 2, duration expired
      const startedAt = new Date(Date.now() - 61_000);
      const result = getCurrentScreen(items, 'design-2', startedAt);
      expect(result.item.id).toBe(1);
      expect(result.screenChanged).toBe(true);
    });

    it('should start at first item when lastScreenId not found in playlist', () => {
      const items = [
        { id: 1, screenDesign: { id: 1 }, duration: 300 },
        { id: 2, screenDesign: { id: 2 }, duration: 60 },
      ];
      const result = getCurrentScreen(items, 'design-99', new Date());
      expect(result.item.id).toBe(1);
      expect(result.screenChanged).toBe(true);
    });
  });

  describe('hasClockWidget (private)', () => {
    const hasClock = (design: any) => (service as any).hasClockWidget(design);

    it('should return false for no widgets', () => {
      expect(hasClock(null)).toBe(false);
      expect(hasClock({ widgets: [] })).toBe(false);
    });

    it('should return true when clock exists', () => {
      expect(hasClock({ widgets: [{ template: { name: 'clock' } }] })).toBe(true);
    });

    it('should return false for countdown (not clock)', () => {
      expect(hasClock({ widgets: [{ template: { name: 'countdown' } }] })).toBe(false);
    });
  });

  describe('getRefreshRateForScreen (private)', () => {
    const getRate = (screen: any, deviceRate: number) =>
      (service as any).getRefreshRateForScreen(screen, deviceRate);

    it('should return device refresh rate for normal screens', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'text' } }] } };
      expect(getRate(screen, 900)).toBe(900);
    });

    it('should return device refresh rate for countdown widgets (no override)', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'countdown' } }] } };
      expect(getRate(screen, 900)).toBe(900);
    });

    it('should return device refresh rate for date widgets (not time-sensitive)', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'date' } }] } };
      expect(getRate(screen, 900)).toBe(900);
    });

    it('should calculate clock refresh based on seconds until next minute', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'clock' } }] } };
      const rate = getRate(screen, 900);
      expect(rate).toBeGreaterThanOrEqual(4);
      expect(rate).toBeLessThanOrEqual(63);
    });

    it('should enforce 10 second floor', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'text' } }] } };
      expect(getRate(screen, 5)).toBe(10);
    });
  });

  describe('getNextRefreshTimestamp', () => {
    it('should return device refresh rate ms from now for normal screens', () => {
      const screen = { screenDesign: { widgets: [{ template: { name: 'text' } }] } };
      const ts = service.getNextRefreshTimestamp(screen, 900);
      const diff = ts! - Date.now();
      // Should be approximately 900 seconds from now
      expect(diff).toBeGreaterThan(899000);
      expect(diff).toBeLessThan(901000);
    });
  });

  describe('getFirmwareUpdateUrl (private)', () => {
    const getFirmware = (version?: string) =>
      (service as any).getFirmwareUpdateUrl(version);

    it('should return empty string when no current version', async () => {
      expect(await getFirmware(undefined)).toBe('');
    });

    it('should return empty string when no stable firmware exists', async () => {
      mockPrisma.firmware.findFirst.mockResolvedValue(null);
      expect(await getFirmware('1.0.0')).toBe('');
    });

    it('should return empty string when versions match', async () => {
      mockPrisma.firmware.findFirst.mockResolvedValue({ version: '1.0.0', downloadUrl: 'http://fw.bin' });
      expect(await getFirmware('1.0.0')).toBe('');
    });

    it('should return download URL when version differs', async () => {
      mockPrisma.firmware.findFirst.mockResolvedValue({ version: '2.0.0', downloadUrl: 'http://fw.bin' });
      expect(await getFirmware('1.0.0')).toBe('http://fw.bin');
    });
  });

  describe('getDisplayContent', () => {
    it('should return reset_firmware with all expected fields when device not found', async () => {
      mockPrisma.device.findFirst.mockResolvedValue(null);
      const result = await service.getDisplayContent('unknown-key');
      expect(result.reset_firmware).toBe(true);
      expect(result.status).toBe(0);
      expect(result.image_url).toBe('');
      expect(result.filename).toBe('');
      expect(result.firmware_url).toBe('');
      expect(result.update_firmware).toBe(false);
      expect(result.refresh_rate).toBe(0);
    });

    it('should return default screen when no playlist', async () => {
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test', playlist: null, refreshRate: 900, refreshPending: false,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: null, wifi: null });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key');
      expect(result.image_url).toContain('default-screen');
      expect(result.refresh_rate).toBe(900);
      expect(result.status).toBe(0);
      expect(result.update_firmware).toBe(false);
      expect(result.reset_firmware).toBe(false);
    });

    it('should return default screen when playlist has no items', async () => {
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test', playlist: { items: [] }, refreshRate: 900, refreshPending: false,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: null, wifi: null });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key');
      expect(result.image_url).toContain('default-screen');
      expect(result.status).toBe(0);
      expect(result.reset_firmware).toBe(false);
    });

    it('should use normal refresh_rate even when refreshPending is true', async () => {
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test', playlist: null, refreshRate: 900, refreshPending: true,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: 80, wifi: -51 });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key', false, { battery: 80, wifi: -51 });
      expect(result.refresh_rate).toBe(900);
    });

    it('should update device metrics', async () => {
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test', playlist: null, refreshRate: 900, refreshPending: false,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: 85, wifi: -45 });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      await service.getDisplayContent('test-key', false, { battery: 85, wifi: -45 });

      const updateCall = mockPrisma.device.update.calls[0];
      expect(updateCall[0].data.battery).toBe(85);
      expect(updateCall[0].data.wifi).toBe(-45);
    });
  });

  describe('getCurrentScreenImage', () => {
    it('should throw NotFoundException when device not found', async () => {
      mockPrisma.device.findUnique.mockResolvedValue(null);
      await expect(service.getCurrentScreenImage(999)).rejects.toThrow('Device not found');
    });

    it('should return default buffer when no playlist', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({ id: 1, playlist: null });
      const result = await service.getCurrentScreenImage(1);
      expect(result).toBeInstanceOf(Buffer);
    });

    it('should render screen design in preview mode', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: 1,
        name: 'Test',
        battery: 80,
        wifi: -51,
        playlist: {
          items: [{
            duration: 60,
            screenDesign: { id: 5, widgets: [] },
            screen: null,
          }],
        },
      });
      await service.getCurrentScreenImage(1);
      expect(mockScreenRendererService.renderScreenDesign.calls.length).toBe(1);
      // Second arg is deviceContext, third is preview=true
      expect(mockScreenRendererService.renderScreenDesign.calls[0][2]).toBe(true);
    });

    it('returns the sleep screen during quiet hours when showSleepScreen is true', async () => {
      const hhmm = (offsetMin: number) => {
        const now = new Date();
        const total = ((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMin) % 1440 + 1440) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      mockPrisma.device.findUnique.mockResolvedValue({
        id: 1, name: 'Test', width: 800, height: 480,
        sleepStartAt: hhmm(-60), sleepStopAt: hhmm(120), showSleepScreen: true,
        playlist: { items: [{ duration: 60, screenDesign: { id: 5, widgets: [] } }] },
      });
      const result = await service.getCurrentScreenImage(1);
      expect(mockSleepScreenService.getSleepScreenBuffer.calls.length).toBe(1);
      expect(mockScreenRendererService.renderScreenDesign.calls.length).toBe(0);
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('getImageFilename (private)', () => {
    const getFilename = (url: string) => (service as any).getImageFilename(url);

    it('should extract filename from URL path', () => {
      expect(getFilename('/uploads/screens/test.png')).toBe('test.png');
    });

    it('should handle full URLs', () => {
      expect(getFilename('http://localhost/uploads/test.png')).toBe('test.png');
    });
  });

  describe('parseTimeToSeconds (private)', () => {
    const parse = (v: string) => (service as any).parseTimeToSeconds(v);

    it('parses valid HH:MM values', () => {
      expect(parse('00:00')).toBe(0);
      expect(parse('07:00')).toBe(25200);
      expect(parse('22:30')).toBe(81000);
      expect(parse('23:59')).toBe(86340);
    });

    it('returns null for invalid values', () => {
      expect(parse('24:00')).toBeNull();
      expect(parse('7:00')).toBeNull();
      expect(parse('12:60')).toBeNull();
      expect(parse('foo')).toBeNull();
    });
  });

  describe('getQuietHoursSeconds (private)', () => {
    const quiet = (device: any) => (service as any).getQuietHoursSeconds(device);
    // Build an "HH:MM" string offset by a number of minutes from current UTC time.
    const hhmmFromNowOffset = (offsetMin: number) => {
      const now = new Date();
      const total = ((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMin) % 1440 + 1440) % 1440;
      const h = Math.floor(total / 60);
      const m = total % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    it('returns null when sleep times are missing', () => {
      expect(quiet({ sleepStartAt: null, sleepStopAt: null })).toBeNull();
      expect(quiet({ sleepStartAt: '22:00', sleepStopAt: null })).toBeNull();
    });

    it('returns null when start equals stop', () => {
      expect(quiet({ sleepStartAt: '07:00', sleepStopAt: '07:00' })).toBeNull();
    });

    it('returns null when now is outside the window', () => {
      const device = {
        sleepStartAt: hhmmFromNowOffset(120),
        sleepStopAt: hhmmFromNowOffset(240),
      };
      expect(quiet(device)).toBeNull();
    });

    it('returns seconds-until-wake when now is inside the window', () => {
      const device = {
        sleepStartAt: hhmmFromNowOffset(-60), // started 1h ago
        sleepStopAt: hhmmFromNowOffset(120), // ends in 2h
      };
      const result = quiet(device);
      expect(result).not.toBeNull();
      // ~2h until wake (+60s buffer), with slack for the current seconds-in-minute
      expect(result).toBeGreaterThan(2 * 3600 - 120);
      expect(result).toBeLessThanOrEqual(2 * 3600 + 120);
    });

    it('handles windows that wrap past midnight and caps at 24h', () => {
      const device = {
        sleepStartAt: hhmmFromNowOffset(-30),
        sleepStopAt: hhmmFromNowOffset(30),
      };
      const result = quiet(device);
      expect(result).not.toBeNull();
      expect(result).toBeLessThanOrEqual(86400);
    });
  });

  describe('getDisplayContent - quiet hours', () => {
    const windowAroundNow = () => {
      const hhmm = (offsetMin: number) => {
        const now = new Date();
        const total = ((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMin) % 1440 + 1440) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      return { start: hhmm(-60), stop: hhmm(120) };
    };

    it('serves the sleep screen during quiet hours when showSleepScreen is true', async () => {
      const { start, stop } = windowAroundNow();
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test', playlist: null, refreshRate: 900, refreshPending: false,
        width: 800, height: 480, sleepStartAt: start, sleepStopAt: stop, showSleepScreen: true,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: 80, wifi: -50 });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key');
      expect(result.image_url).toContain('/assets/sleep-');
      expect(mockSleepScreenService.getSleepScreen.calls.length).toBe(1);
      expect(result.update_firmware).toBe(false);
      expect(result.refresh_rate).toBeGreaterThan(2 * 3600 - 120);
    });

    it('freezes the current screen during quiet hours when showSleepScreen is false', async () => {
      const { start, stop } = windowAroundNow();
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test',
        playlist: { items: [{ duration: 60, screen: { id: 9, name: 'S', imageUrl: '/uploads/s.png' } }] },
        refreshRate: 900, refreshPending: false,
        width: 800, height: 480, sleepStartAt: start, sleepStopAt: stop, showSleepScreen: false,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: 80, wifi: -50 });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key');
      // Keeps the current screen (no sleep screen) ...
      expect(result.image_url).toContain('/uploads/s.png');
      expect(mockSleepScreenService.getSleepScreen.calls.length).toBe(0);
      // ... but sleeps until the wake time (long refresh rate)
      expect(result.refresh_rate).toBeGreaterThan(2 * 3600 - 120);
    });

    it('uses normal refresh_rate outside quiet hours', async () => {
      const hhmm = (offsetMin: number) => {
        const now = new Date();
        const total = ((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMin) % 1440 + 1440) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      mockPrisma.device.findFirst.mockResolvedValue({
        id: 1, name: 'Test',
        playlist: { items: [{ duration: 120, screen: { id: 9, name: 'S', imageUrl: '/uploads/s.png' } }] },
        refreshRate: 900, refreshPending: false,
        width: 800, height: 480, sleepStartAt: hhmm(120), sleepStopAt: hhmm(240), showSleepScreen: true,
      });
      mockPrisma.device.update.mockResolvedValue({ id: 1, battery: 80, wifi: -50 });
      mockPrisma.firmware.findFirst.mockResolvedValue(null);

      const result = await service.getDisplayContent('test-key');
      expect(result.image_url).toContain('/uploads/s.png');
      expect(mockSleepScreenService.getSleepScreen.calls.length).toBe(0);
      expect(result.refresh_rate).toBe(120);
    });
  });
});
