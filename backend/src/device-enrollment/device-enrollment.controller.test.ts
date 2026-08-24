import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { afterEach, describe, expect, it } from 'bun:test';
import request from 'supertest';
import { PinAuthGuard } from '../auth/guards/pin-auth.guard';
import { PinAuthService } from '../auth/pin-auth.service';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { DeviceEnrollmentController } from './device-enrollment.controller';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { PairingTransportGuard } from './pairing-transport.guard';

describe('DeviceEnrollmentController (API)', () => {
  let app: INestApplication | undefined;
  let rejectExchange = false;

  async function createApp() {
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
      ],
      controllers: [DeviceEnrollmentController],
      providers: [
        PairingTransportGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: unknown) =>
              key === 'pairing.trustProxy' ? true : fallback,
          },
        },
        {
          provide: PinAuthService,
          useValue: { validateSession: (token: string) => token === 'admin-session' },
        },
        {
          provide: DeviceEnrollmentService,
          useValue: {
            create: async (deviceId: number) => ({
              enrollmentId: 'enrollment-7',
              deviceId,
              code: '7K4M-9Q2D-XP',
              expiresAt: new Date('2026-08-24T12:10:00.000Z'),
              createdAt: new Date('2026-08-24T12:00:00.000Z'),
            }),
            exchange: async () => {
              if (rejectExchange) {
                throw new BadRequestException('Pairing code is invalid or unavailable');
              }
              return {
                credential: 'one-time-device-credential',
                credentialId: 'credential-8',
                device: {
                  id: 7,
                  name: 'Office',
                  externalId: 'display-7',
                  profileId: 'browser-hd-1920x1080',
                },
              };
            },
          },
        },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: PinAuthGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  }

  afterEach(async () => {
    rejectExchange = false;
    await app?.close();
    app = undefined;
  });

  it('requires admin authentication to create an enrollment', async () => {
    await createApp();
    await request(app!.getHttpServer())
      .post('/devices/7/enrollments')
      .expect(401);

    const response = await request(app!.getHttpServer())
      .post('/devices/7/enrollments')
      .set('Authorization', 'Bearer admin-session')
      .expect(201);

    expect(response.body.data).toMatchObject({
      enrollmentId: 'enrollment-7',
      deviceId: 7,
      code: '7K4M-9Q2D-XP',
    });
    expect(response.body.data.credential).toBeUndefined();
    expect(response.body.data.codeHash).toBeUndefined();
  });

  it('allows a public HTTPS device exchange and rejects insecure HTTP by default', async () => {
    await createApp();
    const response = await request(app!.getHttpServer())
      .post('/device-enrollments/exchange')
      .set('X-Forwarded-Proto', 'https')
      .send({ code: '7k4m-9q2d-xp' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      credential: 'one-time-device-credential',
      credentialId: 'credential-8',
    });
    expect(response.body.data.code).toBeUndefined();
    expect(response.body.data.tokenHash).toBeUndefined();

    await request(app!.getHttpServer())
      .post('/device-enrollments/exchange')
      .send({ code: '7K4M-9Q2D-XP' })
      .expect(403);
  });

  it('strictly limits exchange attempts to five per minute and client address', async () => {
    rejectExchange = true;
    await createApp();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app!.getHttpServer())
        .post('/device-enrollments/exchange')
        .set('X-Forwarded-Proto', 'https')
        .send({ code: '7K4M-9Q2D-XP' });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });
});
