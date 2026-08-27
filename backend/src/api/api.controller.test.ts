import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Logger } from '@nestjs/common';
import request from 'supertest';
import { ApiController } from './api.controller';
import { DisplayService } from './display/display.service';
import { DefaultScreenService } from './display/default-screen.service';
import { SetupService } from './setup/setup.service';
import { LogService } from './log/log.service';
import { ScreenRendererService } from '../screen-designer/services/screen-renderer.service';
import { ConfigService } from '@nestjs/config';

describe('ApiController (e2e)', () => {
  let app: INestApplication;

  const mockDisplayService = {
    getDisplayContent: async () => ({
      status: 200,
      image_url: 'http://localhost:3002/test.png',
      firmware_url: null,
      refresh_rate: 900,
    }),
  };

  const mockSetupService = {
    provisionDevice: async () => ({
      api_key: 'test-api-key',
      friendly_id: 'test-device-1',
      image_url: 'http://localhost:3002/setup.bmp',
      message: 'Welcome to Inker!',
    }),
  };

  const mockLogService = {
    createLog: async () => ({
      status: 'ok',
    }),
  };

  const mockScreenRendererService = {
    renderScreenDesign: async () => Buffer.from('PNG'),
  };

  const mockDefaultScreenService = {
    getDefaultScreenBuffer: async () => Buffer.from('PNG'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        { provide: DisplayService, useValue: mockDisplayService },
        { provide: DefaultScreenService, useValue: mockDefaultScreenService },
        { provide: SetupService, useValue: mockSetupService },
        { provide: LogService, useValue: mockLogService },
        { provide: ScreenRendererService, useValue: mockScreenRendererService },
        { provide: ConfigService, useValue: { get: (key: string, defaultValue?: unknown) => defaultValue } },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /api/display', () => {
    it('does not leak any legacy credential header or credential prefix into logs', async () => {
      const debug = spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const secret = 'secret-legacy-value-never-log';
      try {
        for (const header of ['HTTP_ID', 'HTTP-ID', 'ID', 'X-Device-ID', 'Device-ID', 'Access-Token']) {
          const response = await request(app.getHttpServer()).get('/api/display').set(header, secret).expect(200);
          expect(response.text).not.toContain(secret);
        }
        expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(debug.mock.calls)).not.toContain(secret.slice(0, 8));
      } finally { debug.mockRestore(); }
    });
    it('should return 422 without HTTP_ID header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/display')
        .expect(422);

      expect(response.body.detail).toBe('Invalid device ID.');
      // Should NOT contain receivedHeaders (production hardening)
      expect(response.body.extensions?.receivedHeaders).toBeUndefined();
    });

    it('should return 200 with valid HTTP_ID header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/display')
        .set('HTTP_ID', 'test-api-key-12345678901234567890')
        .expect(200);

      expect(response.body).toHaveProperty('image_url');
      expect(response.body).toHaveProperty('refresh_rate');
    });
  });

  describe('GET /api/setup', () => {
    it('preserves the explicit legacy setup credential response contract', async () => {
      const response = await request(app.getHttpServer()).get('/api/setup').set('HTTP_ID', 'AA:BB:CC:DD:EE:FF').expect(200);
      expect(response.body.api_key).toBe('test-api-key');
      expect(response.body.friendly_id).toBe('test-device-1');
    });
    it('should return 422 without HTTP_ID header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/setup')
        .expect(422);

      expect(response.body.detail).toBe('Invalid request headers.');
      expect(response.body.extensions?.receivedHeaders).toBeUndefined();
    });
  });

  describe('POST /api/log', () => {
    it('should return 422 without HTTP_ID header', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/log')
        .send({ level: 'info', message: 'test log' })
        .expect(422);

      expect(response.body.detail).toBe('Device API key required');
      expect(response.body.extensions?.receivedHeaders).toBeUndefined();
    });
  });
});
