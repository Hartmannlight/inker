import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PresentationService } from '../device-platform/presentation.service';
import { ContentAssignmentService } from './content-assignment.service';
import { PinAuthGuard } from '../auth/guards/pin-auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';

describe('DevicesController (e2e)', () => {
  let app: INestApplication;

  const mockDevice = {
    id: 1,
    name: 'Test Device',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    apiKey: 'test-api-key',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockDevicesService = {
    create: async () => mockDevice,
    findAll: async () => ({
      items: [mockDevice],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    }),
    findOne: async () => mockDevice,
    update: async () => ({ ...mockDevice, name: 'Updated Device' }),
    remove: async () => ({ message: 'Device deleted successfully' }),
    regenerateApiKey: async () => ({ deviceId: 1, apiKey: 'new-api-key' }),
    getDeviceLogs: async () => [],
    triggerRefresh: async () => ({ message: 'Device refresh triggered', deviceId: 1 }),
    unassignPlaylist: async () => ({ message: 'Playlist unassigned successfully' }),
    getDisplayContent: async () => ({ deviceId: 1, screen: null }),
  };
  const preview = mock(async () => ({ sha256: 'a'.repeat(64), mimeType: 'image/png', bytes: Buffer.from('preview') }));
  const mockPresentations = { preview };
  const assignContent = mock(async () => ({ kind: 'none', publicationRevisionId: null, playlistRevisionId: null }));
  const readContent = mock(async () => ({
    current: { desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null },
    screens: [], playlists: [],
  }));
  const mockAssignments = { assign: assignContent, read: readContent };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: DevicesService, useValue: mockDevicesService },
        { provide: PresentationService, useValue: mockPresentations },
        { provide: ContentAssignmentService, useValue: mockAssignments },
      ],
    })
      .overrideGuard(PinAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /devices', () => {
    it('should return paginated list of devices', async () => {
      const response = await request(app.getHttpServer())
        .get('/devices')
        .expect(200);

      expect(response.body.data).toHaveProperty('items');
      expect(response.body.data).toHaveProperty('total');
    });
  });

  describe('GET /devices/:id', () => {
    it('should return a device by ID', async () => {
      const response = await request(app.getHttpServer())
        .get('/devices/1')
        .expect(200);

      expect(response.body.data).toHaveProperty('id', 1);
      expect(response.body.data).toHaveProperty('name', 'Test Device');
    });
  });

  describe('GET /devices/:id/preview', () => {
    it('returns the authenticated immutable artifact with an ETag', async () => {
      const response = await request(app.getHttpServer()).get('/devices/1/preview').expect(200);
      expect(response.headers.etag).toBe(`"${'a'.repeat(64)}"`);
      expect(response.headers['content-type']).toMatch(/^image\/png/);
      expect(response.body.toString()).toBe('preview');
    });

    it('honours a matching ETag without invoking a render path', async () => {
      await request(app.getHttpServer())
        .get('/devices/1/preview')
        .set('If-None-Match', `W/"${'a'.repeat(64)}"`)
        .expect(304);
    });

    it('reports no assigned preview without returning a device credential', async () => {
      preview.mockRejectedValueOnce(new NotFoundException('No published device content'));
      const response = await request(app.getHttpServer()).get('/devices/1/preview').expect(404);
      expect(JSON.stringify(response.body)).not.toContain('apiKey');
      expect(JSON.stringify(response.body)).not.toContain('credential');
    });
  });

  describe('POST /devices', () => {
    it('should create a new device', async () => {
      const response = await request(app.getHttpServer())
        .post('/devices')
        .send({ name: 'New Device', macAddress: 'AA:BB:CC:DD:EE:FF' })
        .expect(201);

      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('macAddress');
    });
  });

  describe('PATCH /devices/:id', () => {
    it('should update a device', async () => {
      const response = await request(app.getHttpServer())
        .patch('/devices/1')
        .send({ name: 'Updated Device' })
        .expect(200);

      expect(response.body.data).toHaveProperty('name', 'Updated Device');
    });
  });

  describe('PUT /devices/:id/content-assignment', () => {
    it('passes the complete optimistic command to the orchestrator', async () => {
      const command = { version: 1, expectedDesiredRevisionId: null, expectedPlaybackVersion: 0, assignment: { kind: 'none' } };
      await request(app.getHttpServer()).put('/devices/1/content-assignment')
        .send(command)
        .expect(200);
      expect(assignContent).toHaveBeenCalledWith(1, command);
    });
  });

  describe('GET /devices/:id/content-assignment', () => {
    it('returns the current optimistic revision and content choices', async () => {
      const response = await request(app.getHttpServer()).get('/devices/1/content-assignment').expect(200);
      expect(response.body.data.current).toEqual({ desiredPublicationRevisionId: null, playbackVersion: 0, playlistRevisionId: null });
      expect(readContent).toHaveBeenCalledWith(1);
    });
  });

  describe('DELETE /devices/:id', () => {
    it('should delete a device', async () => {
      const response = await request(app.getHttpServer())
        .delete('/devices/1')
        .expect(200);

      expect(response.body.data).toHaveProperty('message', 'Device deleted successfully');
    });
  });
});
