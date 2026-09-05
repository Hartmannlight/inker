import { NestFactory } from '@nestjs/core';
import { closeIsolatedExecution } from './isolation/isolated-executor';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compressionModule from 'compression';
import type compressionFactory from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { createSafeLogger, logStartupFailure } from './config/logger.config';
import { observeRequest } from './observability/runtime-observability';
import {
  DEFAULT_INSTANCE_SECRET_PATH,
  loadInstanceSecrets,
  validateAdminPin,
} from './config/instance-secrets';
import { resolve } from 'node:path';
import { ApiDeliveryLifecycle } from './device-platform/api-delivery.module';
import { OutboxRedisService } from './events/outbox-redis.service';

const compression = (
  (compressionModule as unknown as { default?: typeof compressionFactory }).default ?? compressionModule
) as typeof compressionFactory;

async function bootstrap() {
  validateAdminPin(process.env.ADMIN_PIN);
  loadInstanceSecrets(resolve(
    process.env.INKER_INSTANCE_SECRET_PATH || DEFAULT_INSTANCE_SECRET_PATH,
  ));

  // Create logger instance
  const logger = createSafeLogger('api');

  const app = await NestFactory.create(AppModule, {
    logger,
  });
  app.use(observeRequest);

  // Get config service
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 3000);
  const environment = configService.get<string>('environment', 'development');

  // Pairing rate limits need the real client address behind one explicitly
  // trusted TLS-terminating reverse proxy. Direct deployments leave this off.
  if (configService.get<boolean>('pairing.trustProxy', false)) {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  // Security middleware - allow cross-origin resource loading for images
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: environment === 'production',
  }));
  app.use(compression());

  // Enable CORS - restrict origins via CORS_ORIGINS env (comma-separated)
  // Default: same-origin only (derived from request). Set CORS_ORIGINS=* to allow all.
  const corsOrigins = process.env.CORS_ORIGINS;
  const exposedHeaders = ['ETag', 'X-Server-Time', 'X-Correlation-ID', 'X-Refresh-After-Seconds', 'X-Delivery-Mode'];
  if (corsOrigins === '*') {
    app.enableCors({ exposedHeaders });
  } else if (corsOrigins) {
    app.enableCors({
      origin: corsOrigins.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders,
    });
  } else {
    // Default: allow same-origin requests only
    app.enableCors({
      origin: (origin, callback) => {
        // Allow requests with no Origin header (same-origin, curl, devices)
        if (!origin) return callback(null, true);
        // Reject cross-origin requests when CORS_ORIGINS is not configured
        callback(new Error('CORS not allowed'), false);
      },
      credentials: true,
      exposedHeaders,
    });
  }

  // All application APIs share one prefix. Health probes intentionally remain
  // at the root for container orchestrators.
  app.setGlobalPrefix('api', {
    exclude: ['live', 'health', 'ready'],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger documentation setup
  if (environment !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Inker API')
      .setDescription('API documentation for Inker e-ink device management server')
      .setVersion('0.6.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-Device-Key', in: 'header' }, 'device-key')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Graceful shutdown handling
  const shutdownSignals = ['SIGTERM', 'SIGINT'];
  let stopping = false;
  shutdownSignals.forEach((signal) => {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      logger.log(`Received ${signal}, starting graceful shutdown...`);
      try {
        await closeIsolatedExecution();
        await app.get(ApiDeliveryLifecycle).stop();
        await app.get(OutboxRedisService).close();
        await app.close();
        logger.log('Application closed successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    });
  });

  await app.listen(port, '0.0.0.0');
  logger.log(`Inker Server running in ${environment} mode on port ${port} (listening on all interfaces)`);

  if (environment !== 'production') {
    logger.log(`📚 API Documentation available at http://localhost:${port}/api/docs`);
  }
}

bootstrap().catch((error) => {
  logStartupFailure('api', error);
  process.exit(1);
});
