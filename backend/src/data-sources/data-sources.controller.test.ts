import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSourcesController } from './data-sources.controller';
import { DataSourcesService, SOURCE_REFRESH_REQUIRES_CONNECTOR, SOURCE_SNAPSHOT_UNAVAILABLE } from './data-sources.service';
import { PinAuthGuard } from '../auth/guards/pin-auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { createMockPrisma } from '../test/mocks/prisma.mock';

describe('DataSourcesController (e2e)', () => {
  let app: INestApplication;

  const mockDataSource = {
    id: 1,
    name: 'Test API',
    description: 'A test data source',
    type: 'json',
    url: 'https://api.example.com/data',
    method: 'GET',
    isActive: true,
    refreshInterval: 300,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockDataSourcesService = {
    create: async () => mockDataSource,
    findAll: async () => ({
      items: [mockDataSource],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    }),
    findOne: async () => mockDataSource,
    update: async () => ({ ...mockDataSource, name: 'Updated API' }),
    remove: async () => ({ message: 'Data source deleted successfully' }),
    testUrl: async () => ({ success: true, data: {}, fields: [] }),
    testFetch: async () => ({ success: true, data: {}, fields: [] }),
    refresh: async () => ({ success: true, data: {}, dataSource: mockDataSource }),
    getCachedData: async () => ({ key: 'value' }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DataSourcesController],
      providers: [
        { provide: DataSourcesService, useValue: mockDataSourcesService },
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

  describe('GET /data-sources', () => {
    it('should return paginated list of data sources', async () => {
      const response = await request(app.getHttpServer())
        .get('/data-sources')
        .expect(200);

      expect(response.body.data).toHaveProperty('items');
      expect(response.body.data).toHaveProperty('total');
    });
  });

  describe('GET /data-sources/:id', () => {
    it('should return a data source by ID', async () => {
      const response = await request(app.getHttpServer())
        .get('/data-sources/1')
        .expect(200);

      expect(response.body.data).toHaveProperty('id', 1);
      expect(response.body.data).toHaveProperty('name', 'Test API');
    });
  });

  describe('POST /data-sources', () => {
    it('should create a new data source', async () => {
      const response = await request(app.getHttpServer())
        .post('/data-sources')
        .send({ name: 'New API', type: 'json', url: 'https://api.example.com/new' })
        .expect(201);

      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('url');
    });
  });

  describe('DELETE /data-sources/:id', () => {
    it('should delete a data source', async () => {
      const response = await request(app.getHttpServer())
        .delete('/data-sources/1')
        .expect(200);

      expect(response.body.data).toHaveProperty('message', 'Data source deleted successfully');
    });
  });
});

describe('DataSourcesController WP21 boundary (real service)', () => {
  let app: INestApplication;
  const prisma = createMockPrisma();
  const service = new DataSourcesService(prisma as any, {} as any);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DataSourcesController],
      providers: [{ provide: DataSourcesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  beforeEach(() => {
    for (const method of Object.values(prisma.dataSource)) method.mockReset();
    for (const method of Object.values(prisma.outboxEvent)) method.mockReset();
    prisma.$transaction.mockReset();
  });
  afterAll(async () => { await app?.close(); });

  function expectNoWrites() {
    for (const operation of ['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const) {
      expect(prisma.dataSource[operation].calls).toHaveLength(0);
      expect(prisma.outboxEvent[operation].calls).toHaveLength(0);
    }
    expect(prisma.$transaction.calls).toHaveLength(0);
  }

  it('GET data serves persisted stale data without network or SQL writes', async () => {
    prisma.dataSource.findUnique.mockResolvedValue({ lastData: { value: 'persisted' }, lastFetchedAt: new Date(0) });
    const provider = spyOn(service, 'fetchDataFromSource').mockImplementation(() => { throw new Error('Unexpected HTTP access'); });
    try {
      const response = await request(app.getHttpServer()).get('/data-sources/1/data').expect(200);
      expect(response.body.data).toEqual({ value: 'persisted' });
      expect(prisma.dataSource.findUnique.calls[0][0]).toEqual({ where: { id: 1 }, select: { lastData: true } });
      expect(provider).not.toHaveBeenCalled();
      expectNoWrites();
    } finally { provider.mockRestore(); }
  });

  it('GET data reports an absent snapshot without initializing or fetching it', async () => {
    prisma.dataSource.findUnique.mockResolvedValue({ lastData: null });
    const response = await request(app.getHttpServer()).get('/data-sources/1/data').expect(503);
    expect(response.body.code).toBe(SOURCE_SNAPSHOT_UNAVAILABLE);
    expectNoWrites();
  });

  it('GET data preserves not-found semantics without writes', async () => {
    prisma.dataSource.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/data-sources/1/data').expect(404);
    expectNoWrites();
  });

  for (const path of ['test-url', '1/test', '1/refresh']) {
    it(`POST ${path} rejects live provider access with a stable 503 code`, async () => {
      const secret = 'test-provider-secret-for-boundary';
      const response = await request(app.getHttpServer()).post(`/data-sources/${path}`)
        .send(path === 'test-url' ? { type: 'json', url: 'https://provider.invalid/data', headers: { Authorization: `Bearer ${secret}` } } : {})
        .expect(503);
      expect(response.body.code).toBe(SOURCE_REFRESH_REQUIRES_CONNECTOR);
      expect(response.body.message).toBe(SOURCE_REFRESH_REQUIRES_CONNECTOR);
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(prisma.dataSource.findUnique.calls).toHaveLength(0);
      expectNoWrites();
    });
  }

  it('POST create persists configuration but does not auto-test or update cache status', async () => {
    prisma.dataSource.create.mockImplementation(async ({ data }) => ({ id: 1, ...data, lastData: null, lastFetchedAt: null, lastError: null }));
    const response = await request(app.getHttpServer()).post('/data-sources')
      .send({ name: 'Preserved configuration', type: 'json', url: 'https://provider.invalid/data' }).expect(201);
    expect(response.body.data.url).toBe('https://provider.invalid/data');
    expect(response.body.data.lastFetchedAt).toBeNull();
    expect(response.body.data.lastData).toBeNull();
    expect(prisma.dataSource.create.calls).toHaveLength(1);
    expect(prisma.dataSource.update.calls).toHaveLength(0);
    expect(prisma.outboxEvent.create.calls).toHaveLength(0);
  });
});
