import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { INestApplication, Injectable, Logger } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { parsePresentationManifest } from '@inker/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { PinAuthGuard } from '../auth/guards/pin-auth.guard';
import { AdminSessionService } from '../auth/admin-session.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { hashToken } from '../common/utils/crypto.util';
import { BUILTIN_DELIVERY_POLICIES, BUILTIN_DEVICE_PROFILES } from './device-configuration.catalog';
import { DeviceConfigurationService } from './device-configuration.service';
import { ProfileResolverService } from './profile-resolver.service';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { ConnectedDeliveryPolicy, ResponsivePullDeliveryPolicy, SleepyDeliveryPolicy } from './delivery-policies';
import { HttpPullTransportAdapter } from './http-pull.transport-adapter';
import { TransportAdapterRegistry } from './transport-adapter.registry';
import { PullContentController, matchesIfNoneMatch } from './pull-content.controller';
import { PullContentService } from './pull-content.service';
import { PullDeviceAuthService } from './pull-device-auth.service';
import { PullLastSeenService } from './pull-last-seen.service';
import { RegisterTransportAdapter } from './device-extension.contracts';
import { TimersController } from './timers.controller';
import { TimerService } from '../timers/timer.service';

@Injectable()
@RegisterTransportAdapter()
class FixturePullAdapter {
  readonly adapterId = 'fixture-pull';
  readonly transportMode = 'fixture-transport';
  pullProtocolVersion: string | undefined = '1.0';
}

const token = 'device-secret-for-pull-only';
const apiKey = 'legacy-secret-for-pull-only';
const fixtureContent = { fixtureArtifacts: ['mono-800x480-white-bmp', 'mono-800x480-white-png'] };

describe('versioned device pull HTTP boundary', () => {
  let app: INestApplication;
  let device: any;
  let credential: any;
  let revision: any;
  let prisma: any;
  let timerFeed: any;
  let timers: any;
  let adminValidate: ReturnType<typeof mock>;
  let log: ReturnType<typeof spyOn>;

  function setPolicy(index: number) {
    const definition = structuredClone(BUILTIN_DELIVERY_POLICIES[index]);
    device.deliveryPolicy = { policyId: definition.policyId, protocolVersion: '1.0', mode: definition.mode, definition };
  }

  beforeEach(async () => {
    const builtin = structuredClone(BUILTIN_DEVICE_PROFILES[0]);
    device = {
      id: 7, externalId: 'stable-device', apiKey, isActive: true, lastSeenAt: null,
      deviceType: 'deliberately-unrecognized', playlistId: 42,
      profile: { profileId: builtin.profile.profileId, protocolVersion: '1.0', definition: builtin.profile, defaultCapabilities: builtin.defaultCapabilities },
      capabilitiesOverride: null,
    };
    setPolicy(0);
    credential = { id: 9, deviceId: 7, tokenHash: hashToken(token), revokedAt: null, expiresAt: null, device };
    revision = {
      publicationId: 'publication-1', publicationRevisionId: 'revision-1', revision: 1,
      protocolVersion: '1.0', publishedAt: new Date('2026-08-24T12:00:00Z'),
      content: structuredClone(fixtureContent), contentHash: 'private-content-hash',
    };
    prisma = {
      deviceCredential: { findUnique: mock(async ({ where }: any) => where.tokenHash === credential?.tokenHash ? credential : null) },
      device: {
        findUnique: mock(async ({ where }: any) => where.apiKey === apiKey ? device : null),
        updateMany: mock(async ({ data }: any) => { device.lastSeenAt = data.lastSeenAt; return { count: 1 }; }),
      },
      devicePublicationState: { findUnique: mock(async () => revision ? { desiredRevision: revision } : null) },
    };
    adminValidate = mock(async () => { throw new Error('Device secrets must never enter admin authentication'); });
    timerFeed = { protocolVersion: '1.0', serverTime: '2026-08-28T12:00:00.000Z', timers: [] };
    timers = { listForAuthenticatedDevice: mock(async () => structuredClone(timerFeed)) };
    log = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const module = await Test.createTestingModule({
      imports: [DiscoveryModule], controllers: [PullContentController, TimersController],
      providers: [PullContentService, PullDeviceAuthService, PullLastSeenService, ProfileResolverService,
        DeviceConfigurationService, HttpPullTransportAdapter, FixturePullAdapter, TransportAdapterRegistry,
        { provide: PrismaService, useValue: prisma },
        { provide: TimerService, useValue: timers },
        { provide: DeliveryPolicyRegistry, useValue: new DeliveryPolicyRegistry([new SleepyDeliveryPolicy(), new ResponsivePullDeliveryPolicy(), new ConnectedDeliveryPolicy()]) },
        { provide: AdminSessionService, useValue: { validate: adminValidate } },
        { provide: APP_GUARD, useClass: PinAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => { await app?.close(); log?.mockRestore(); });
  const path = '/api/v1/device-content';
  const get = () => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  it('provides a raw bounded timer feed with fresh server time on conditional GET', async () => {
    const first = await request(app.getHttpServer()).get('/api/timers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(first.body).toEqual(timerFeed);
    expect(timers.listForAuthenticatedDevice).toHaveBeenLastCalledWith(device.id);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    timerFeed.serverTime = '2026-08-28T12:00:10.000Z';
    const cached = await request(app.getHttpServer()).get('/api/timers').set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', first.headers.etag).expect(304);
    expect(cached.headers['x-server-time']).toBe(timerFeed.serverTime);
    expect(cached.headers.etag).toBe(first.headers.etag);
    expect(cached.text).toBe('');
    credential.revokedAt = new Date();
    await request(app.getHttpServer()).get('/api/timers').set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', first.headers.etag).expect(401);
    expect(adminValidate).not.toHaveBeenCalled();
  });

  it('allows authenticated legacy pull reads without an externalId and denies admin-only or URL credentials', async () => {
    device.externalId = null;
    await request(app.getHttpServer()).get('/api/timers').set('HTTP_ID', apiKey).expect(200);
    for (const headers of [{}, { Cookie: 'inker_admin_session=admin-session' }, { Authorization: 'Bearer admin-session' }]) {
      await request(app.getHttpServer()).get(`/api/timers?credential=${token}`).set(headers).expect(401);
    }
    expect(timers.listForAuthenticatedDevice).toHaveBeenCalledTimes(1);
  });

  it('rechecks credentials after a timer read and never returns state or a 304 after revocation', async () => {
    timers.listForAuthenticatedDevice.mockImplementation(async () => { credential.revokedAt = new Date(); return timerFeed; });
    const result = await request(app.getHttpServer()).get('/api/timers').set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', '*').expect(401);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.timers).toBeUndefined();
  });

  it('puts timer state in pull manifests without invalidating artifacts or polling timers on image reads', async () => {
    const first = await get().expect(200);
    expect(first.body.timerState).toEqual(timerFeed);
    timerFeed.serverTime = '2026-08-28T12:00:30.000Z';
    const unchanged = await get().set('If-None-Match', first.headers.etag).expect(304);
    expect(unchanged.headers['x-server-time']).toBe(timerFeed.serverTime);
    timerFeed.timers = [{ timerId: '1f81373a-272b-4b9a-b349-611f3c601a62', version: 1, creatorDeviceId: 'owner', visibility: 'shared',
      status: 'running', durationMs: 60000, startedAt: timerFeed.serverTime, evaluatedAt: timerFeed.serverTime,
      endsAt: '2026-08-28T12:01:30.000Z', pausedRemainingMs: null, completedAt: null, cancelledAt: null,
      acknowledgedAt: null, acknowledgedByDeviceId: null }];
    const changed = await get().set('If-None-Match', first.headers.etag).expect(200);
    expect(changed.body.timerState.timers).toHaveLength(1);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(changed.body.artifacts).toEqual(first.body.artifacts);
    const count = timers.listForAuthenticatedDevice.mock.calls.length;
    await request(app.getHttpServer()).get(first.body.artifacts[0].url).set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', first.body.artifacts[0].etag).expect(304);
    expect(timers.listForAuthenticatedDevice.mock.calls).toHaveLength(count);
  });

  it('returns a valid, raw, secret-free manifest using device authentication only', async () => {
    const response = await get().set('Cookie', 'inker_admin_session=irrelevant').expect(200);
    expect(parsePresentationManifest(response.body).success).toBe(true);
    expect(response.body).toMatchObject({ publicationId: 'publication-1', revision: '1', refresh: { refreshAfterSeconds: 900 } });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(adminValidate).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toMatch(/device-secret|legacy-secret|tokenHash|private-content-hash|apiKey/);
    expect(response.body.artifacts[0].url).toMatch(/^\/api\/v1\/device-content\/artifacts\/[a-f0-9]{64}$/);
    expect(response.headers.vary).toContain('Authorization');
  });

  it('accepts an existing TRMNL API key, but never a MAC, cookie, URL token or admin Bearer', async () => {
    for (const header of ['HTTP_ID', 'Access-Token']) {
      await request(app.getHttpServer()).get(path).set(header, apiKey).expect(200);
    }
    for (const header of [{}, { HTTP_ID: 'AA:BB:CC:DD:EE:FF' }, { Authorization: 'Bearer admin-session' }, { Cookie: 'inker_admin_session=admin-session' }]) {
      await request(app.getHttpServer()).get(`${path}?credential=${token}`).set(header).expect(401);
    }
    expect(adminValidate).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(apiKey);
  });

  it('rejects malformed or ambiguous authentication without falling back to another credential', async () => {
    for (const authorization of ['Basic abc', 'Bearer', 'Bearer wrong extra', 'Bearer wrong']) {
      await request(app.getHttpServer()).get(path).set({ Authorization: authorization, HTTP_ID: apiKey }).expect(401);
    }
  });

  it('rejects revoked, expired and inactive device credentials before reading any content', async () => {
    credential.revokedAt = new Date(); await get().expect(401);
    credential.revokedAt = null; credential.expiresAt = new Date(0); await get().expect(401);
    credential.expiresAt = null; device.isActive = false; await get().expect(401);
    await request(app.getHttpServer()).get(path).set('HTTP_ID', apiKey).expect(401);
    expect(prisma.devicePublicationState.findUnique).not.toHaveBeenCalled();
    expect(prisma.device.updateMany).not.toHaveBeenCalled();
  });

  it('selects output from effective capabilities, independent of legacy device type', async () => {
    const bmp = await get().expect(200);
    expect(bmp.body.artifacts[0].mimeType).toBe('image/bmp');
    device.capabilitiesOverride = { display: { renderFormats: ['png'], mimeTypes: ['image/png'] } };
    const png = await get().expect(200);
    expect(png.body.artifacts[0].mimeType).toBe('image/png');
    expect(png.headers.etag).not.toBe(bmp.headers.etag);
  });

  it('uses the discovered HTTP pull adapter and rejects an unavailable pull implementation', async () => {
    const fixture = app.get(FixturePullAdapter);
    const getAdapter = spyOn(app.get(TransportAdapterRegistry), 'get').mockImplementation((mode) => {
      expect(mode).toBe('http-pull');
      return fixture as any;
    });
    try {
      await get().expect(200);
      fixture.pullProtocolVersion = undefined;
      await get().expect(406);
    } finally { getAdapter.mockRestore(); }
  });

  it('rejects unsupported format, MIME, dimensions, rotation and transport combinations', async () => {
    for (const display of [
      { renderFormats: ['jpeg'], mimeTypes: ['image/jpeg'] },
      { renderFormats: ['png'], mimeTypes: ['image/bmp'] },
      { width: 100 }, { rotation: 90 }, { colorSpace: 'rgb', bitDepth: 24 },
    ]) {
      device.capabilitiesOverride = { display };
      await get().expect(406);
    }
    device.capabilitiesOverride = { transport: { modes: ['websocket'] } };
    await get().expect(406);
  });

  it('has stable ETags and generatedAt across time and unchanged repeated reads', async () => {
    const first = await get().expect(200);
    const second = await get().expect(200);
    expect(first.headers.etag).toBe(second.headers.etag);
    expect(first.body).toEqual(second.body);
    expect(first.body.generatedAt).toBe(revision.publishedAt.toISOString());
  });

  it('changes the ETag on either a new content revision or different artifact bytes', async () => {
    const first = await get().expect(200);
    revision.revision = 2; revision.publicationRevisionId = 'revision-2';
    const next = await get().set('If-None-Match', first.headers.etag).expect(200);
    expect(next.headers.etag).not.toBe(first.headers.etag);
    revision.content.fixtureArtifacts = ['mono-800x480-black-bmp'];
    const changed = await get().set('If-None-Match', next.headers.etag).expect(200);
    expect(changed.headers.etag).not.toBe(next.headers.etag);
  });

  it('uses weak comparison for matching tags, lists and wildcard; 304 has no body', async () => {
    const first = await get().expect(200);
    for (const value of [first.headers.etag, first.headers.etag.replace('W/', ''), `"other", ${first.headers.etag}`, '*']) {
      const response = await get().set('If-None-Match', value).expect(304);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(response.headers.etag).toBe(first.headers.etag);
      expect(response.headers['x-refresh-after-seconds']).toBe('900');
    }
    for (const value of ['"different"', 'garbage', `${first.headers.etag}broken`, `"comma,inside", "different"`]) {
      await get().set('If-None-Match', value).expect(200);
    }
  });

  it('authenticates each conditional read, including a previously valid revoked token', async () => {
    const first = await get().expect(200);
    credential.revokedAt = new Date();
    const response = await get().set('If-None-Match', first.headers.etag).expect(401);
    expect(response.headers.etag).not.toBe(first.headers.etag);
    expect(response.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get(path).set('If-None-Match', '*').expect(401);
  });

  it('ignores empty entity-tag list elements without confusing commas inside opaque tags', async () => {
    expect(matchesIfNoneMatch(', "other",, W/"matching", ', '"matching"')).toBe(true);
    expect(matchesIfNoneMatch('"comma,inside", W/"matching"', '"matching"')).toBe(true);
    expect(matchesIfNoneMatch('"other""matching"', '"matching"')).toBe(false);
    expect(matchesIfNoneMatch(', ,', '"matching"')).toBe(false);
    const first = await get().expect(200);
    const response = await get().set('If-None-Match', `, ${first.headers.etag},,`).expect(304);
    expect(response.text).toBe('');
  });

  it('changes only delivery hints on a policy switch, including on 304', async () => {
    const first = await get().expect(200);
    const identity = [device.id, device.externalId, device.playlistId];
    setPolicy(1);
    const response = await get().set('If-None-Match', first.headers.etag).expect(304);
    expect(response.headers['x-refresh-after-seconds']).toBe('60');
    expect(response.headers['x-delivery-mode']).toBe('responsive-pull');
    expect([device.id, device.externalId, device.playlistId]).toEqual(identity);
    const manifest = await get().expect(200);
    expect(manifest.body.artifacts).toEqual(first.body.artifacts);
    expect(manifest.body.publicationId).toBe(first.body.publicationId);
    expect(manifest.body.profileId).toBe(first.body.profileId);
    expect(manifest.body.refresh.refreshAfterSeconds).toBe(60);
  });

  it('respects the effective recommended minimum refresh interval', async () => {
    setPolicy(1);
    device.capabilitiesOverride = { energy: { recommendedMinRefreshSeconds: 120 } };
    const response = await get().expect(200);
    expect(response.headers['x-refresh-after-seconds']).toBe('120');
  });

  it('does not produce or mutate publications on GET, and has no unpublished fallback', async () => {
    revision = null;
    await get().set('If-None-Match', '*').expect(404);
    await new Promise(setImmediate);
    expect(prisma.device.updateMany).toHaveBeenCalledTimes(1);
    expect(device.lastSeenAt).toBeInstanceOf(Date);
  });

  it('rejects unknown fixtures and incompatible publication versions with constant errors', async () => {
    revision.content = { fixtureArtifacts: [token], metadata: { credential: token } };
    let response = await get().expect(503);
    expect(response.text).not.toContain(token);
    revision.content = fixtureContent; revision.protocolVersion = '2.0';
    response = await get().expect(503);
    expect(response.text).not.toContain(token);
  });

  it('accepts compatible minor versions without forwarding unknown snapshot fields', async () => {
    revision.protocolVersion = '1.9';
    revision.content.secret = token;
    const response = await get().expect(200);
    expect(response.body.protocolVersion).toBe('1.0');
    expect(response.text).not.toContain(token);
  });

  it('never emits secret-bearing database errors from credential lookup', async () => {
    const errors = spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      prisma.deviceCredential.findUnique.mockRejectedValue(new Error(`lookup ${token}`));
      const response = await get().expect(503);
      expect(response.text).not.toContain(token);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
    } finally { errors.mockRestore(); }
  });

  it('serves authenticated artifact bytes with a hash ETag and conditional GET', async () => {
    const manifest = await get().expect(200);
    const artifact = manifest.body.artifacts[0];
    const image = await request(app.getHttpServer()).get(artifact.url).set('Authorization', `Bearer ${token}`).expect(200);
    expect(image.headers.etag).toBe(artifact.etag);
    expect(image.body.length).toBe(artifact.sizeBytes);
    expect(hashToken(image.body)).toBe(artifact.sha256);
    const unchanged = await request(app.getHttpServer()).get(artifact.url).set({ Authorization: `Bearer ${token}`, 'If-None-Match': artifact.etag }).expect(304);
    expect(unchanged.text).toBe('');
    await request(app.getHttpServer()).get(artifact.url).set('If-None-Match', '*').expect(401);
    await request(app.getHttpServer()).get(`${path}/artifacts/${'0'.repeat(64)}`).set('Authorization', `Bearer ${token}`).expect(404);
    credential.revokedAt = new Date();
    await request(app.getHttpServer()).get(artifact.url).set({ Authorization: `Bearer ${token}`, 'If-None-Match': '*' }).expect(401);
  });

  it('throttles last-seen writes across unchanged polls and respects policy intervals', async () => {
    const first = await get().expect(200);
    for (let i = 0; i < 12; i++) await get().set('If-None-Match', first.headers.etag).expect(304);
    await new Promise(setImmediate);
    expect(prisma.device.updateMany).toHaveBeenCalledTimes(1);
    device.lastSeenAt = new Date(Date.now() - 400_000);
    await get().expect(200);
    expect(prisma.device.updateMany).toHaveBeenCalledTimes(1);
    setPolicy(1); await get().expect(200);
    await new Promise(setImmediate);
    expect(prisma.device.updateMany).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent last-seen updates and never blocks delivery on telemetry', async () => {
    let release!: () => void;
    prisma.device.updateMany.mockImplementation(() => new Promise<{count: number}>((resolve) => { release = () => resolve({count: 1}); }));
    try {
      await Promise.all(Array.from({ length: 8 }, () => get().expect(200)));
      expect(prisma.device.updateMany).toHaveBeenCalledTimes(1);
    } finally { release?.(); }
  });

  it('contains telemetry failures without exposing their possibly secret-bearing messages', async () => {
    prisma.device.updateMany.mockRejectedValue(new Error(token));
    await get().expect(200);
    await app.get(PullLastSeenService).onModuleDestroy();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });
});
