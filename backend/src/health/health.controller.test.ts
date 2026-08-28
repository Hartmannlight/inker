import { describe, expect, test } from 'bun:test';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { OutboxRedisService } from '../events/outbox-redis.service';
import type { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';

describe('API readiness and independent background health', () => {
  function controller(database = true, workers = 0, redis = true) {
    return new HealthController({} as HealthCheckService, {} as PrismaHealthIndicator,
      { $queryRaw: async () => { if (!database) throw new Error('do-not-expose-db-detail'); return [{ one: 1 }]; } } as unknown as PrismaService,
      { backgroundStatus: async () => ({ status: workers && redis ? 'ready' : 'degraded', workers,
        redis: redis ? 'ready' : 'unavailable' }) } as unknown as OutboxRedisService);
  }
  test('keeps read-serving API ready while workers are stopped', async () => {
    expect(await controller().ready()).toMatchObject({ status: 'ready', background: { status: 'degraded', workers: 0 } });
  });
  test('liveness does not query a failed database or queue', () => {
    expect(controller(false, 0, false).live()).toEqual({ status: 'alive', role: 'api' });
  });
  test('keeps API ready during queue loss and reports recovered background state', async () => {
    expect(await controller(true, 0, false).ready()).toMatchObject({ status: 'ready', background: { redis: 'unavailable' } });
    expect(await controller(true, 1).ready()).toMatchObject({ status: 'ready', background: { status: 'ready', workers: 1 } });
  });
  test('fails API readiness when its own database is unavailable', async () => {
    await expect(controller(false, 1).ready()).rejects.toThrow('API_DATABASE_UNAVAILABLE');
  });
});
