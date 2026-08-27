import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WinstonModule } from 'nest-winston';
import { WorkerModule } from './worker.module';
import { PrismaService } from './prisma/prisma.service';
import { OutboxDispatcher } from './events/outbox-dispatcher.service';
import { OutboxRedisService } from './events/outbox-redis.service';
import { createLoggerConfig } from './config/logger.config';
import { DEFAULT_INSTANCE_SECRET_PATH, loadInstanceSecrets } from './config/instance-secrets';

async function bootstrapWorker() {
  loadInstanceSecrets(resolve(process.env.INKER_INSTANCE_SECRET_PATH || DEFAULT_INSTANCE_SECRET_PATH));
  const port = Number(process.env.WORKER_HEALTH_PORT || 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('WORKER_INVALID_HEALTH_PORT');
  const logger = WinstonModule.createLogger(createLoggerConfig());
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger });
  const prisma = app.get(PrismaService), redis = app.get(OutboxRedisService), dispatcher = app.get(OutboxDispatcher);
  let stopping = false;
  const server = createServer(async (request, response) => {
    if (request.url !== '/ready' || request.method !== 'GET') { response.writeHead(404).end(); return; }
    try {
      await prisma.$queryRaw`SELECT 1`;
      const background = await redis.backgroundStatus();
      const ready = !stopping && redis.workerReady() && background.status === 'ready';
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'degraded', role: 'worker', background }));
    } catch { response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"unavailable","code":"WORKER_DATABASE_UNAVAILABLE"}'); }
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      // Stop and drain before Nest destroys Prisma/Redis providers.
      const guard = setTimeout(() => process.exit(1), 27_000);
      guard.unref();
      try {
        await dispatcher.stop();
        await redis.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await app.close();
        clearTimeout(guard);
        process.exit(0);
      } catch { logger.error({ code: 'WORKER_SHUTDOWN_FAILED' }); process.exit(1); }
    })();
  });
  logger.log({ code: 'WORKER_STARTED', healthPort: port });
}

void bootstrapWorker().catch(() => { console.error('WORKER_START_FAILED'); process.exit(1); });
