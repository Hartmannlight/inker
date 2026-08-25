import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { APP_GUARD } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AdminCredentialService } from './admin-credential.service';
import { AdminSessionService } from './admin-session.service';

describe('AuthController security contract', () => {
  let app: INestApplication;
  const credentials = {
    authenticate: async (password: string) => password === 'correct password' ? 'admin-1' : null,
  };
  const sessions = {
    create: async () => ({
      sessionId: 'session-new',
      token: 'fresh-session-token',
      csrfToken: 'fresh-csrf-token',
      expiresAt: new Date('2030-01-01T08:00:00.000Z'),
    }),
    rotateCsrf: async () => 'rotated-csrf-token',
    revoke: async () => true,
    revokeAll: async () => 2,
    list: async () => [{
      sessionId: 'session-current',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2030-01-01T00:05:00.000Z'),
      expiresAt: new Date('2030-01-01T08:00:00.000Z'),
      userAgent: 'Browser',
      current: true,
    }],
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AdminCredentialService, useValue: credentials },
        { provide: AdminSessionService, useValue: sessions },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.adminSession = {
        sessionId: 'session-current',
        adminId: 'admin-1',
        authentication: 'cookie',
      };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  test('successful login replaces fixation input with a secure server session and no secret DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Cookie', 'inker_admin_session=attacker-fixed-value')
      .set('X-Forwarded-Proto', 'https')
      .set('User-Agent', 'Browser')
      .send({ password: 'correct password' })
      .expect(200);

    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain('inker_admin_session=fresh-session-token');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('attacker-fixed-value');
    expect(response.headers['x-csrf-token']).toBe('fresh-csrf-token');
    expect(JSON.stringify(response.body)).not.toContain('fresh-session-token');
    expect(JSON.stringify(response.body)).not.toContain('fresh-csrf-token');
    expect(JSON.stringify(response.body)).not.toContain('correct password');
  });

  test('failed login is generic and sets no cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ password: 'wrong password' })
      .expect(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('wrong password');
  });

  test('accepts legacy pin request shape without returning a bearer token', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ pin: 'correct password' })
      .expect(200);
    expect(response.body.token).toBeUndefined();
  });

  test('throttles repeated login attempts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ password: 'wrong' });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
  });

  test('refreshes CSRF on session reload without placing it in the DTO', async () => {
    const response = await request(app.getHttpServer()).get('/auth/session').expect(200);
    expect(response.headers['x-csrf-token']).toBe('rotated-csrf-token');
    expect(response.body).toMatchObject({ authenticated: true, sessionId: 'session-current' });
    expect(JSON.stringify(response.body)).not.toContain('rotated-csrf-token');
  });

  test('lists metadata only and supports logout, logout-all and single revocation', async () => {
    const overview = await request(app.getHttpServer()).get('/auth/sessions').expect(200);
    expect(overview.body[0]).toMatchObject({ sessionId: 'session-current', current: true });
    expect(JSON.stringify(overview.body)).not.toMatch(/token|hash|cookie|csrf/i);

    await request(app.getHttpServer()).delete('/auth/sessions/session-current').expect(200);
    const logout = await request(app.getHttpServer()).post('/auth/logout').expect(200);
    expect(logout.headers['set-cookie'][0]).toContain('inker_admin_session=;');
    const logoutAll = await request(app.getHttpServer()).post('/auth/logout-all').expect(200);
    expect(logoutAll.body).toMatchObject({ revokedSessions: 2 });
  });
});
