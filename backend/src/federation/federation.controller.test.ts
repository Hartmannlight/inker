import 'reflect-metadata';
import { describe, expect, mock, test } from 'bun:test';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { FederationController } from './federation.controller';
import type { FederationFeedService } from './federation-feed.service';
import { FederationTransportGuard } from './federation-transport.guard';
import type { ShareCredentialService } from './share-credential.service';

function response() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: undefined as unknown, ended: false };
  const reply = {
    setHeader: mock((name: string, value: unknown) => { state.headers[name] = value; }),
    set: mock((headers: Record<string, unknown>) => { Object.assign(state.headers, headers); }),
    vary: mock((value: string) => { state.headers.Vary = value; }),
    type: mock((value: string) => { state.headers['Content-Type'] = value; return reply; }),
    status: mock((value: number) => { state.status = value; return reply; }),
    json: mock((value: unknown) => { state.body = value; return reply; }),
    send: mock((value: unknown) => { state.body = value; return reply; }),
    end: mock(() => { state.ended = true; return reply; }),
  };
  return { state, reply, res: reply as unknown as Response };
}

function setup() {
  const calls: string[] = [];
  const principal = { credentialId: 'share-one', publicationId: 'publication-one' };
  const body = { protocolVersion: '1.0', publicationId: 'publication-one' };
  const createdShare = {
    credentialId: 'new-share', token: 'once-only-secret', publicationId: 'publication-one',
    createdAt: '2026-08-28T12:00:00.000Z', expiresAt: null, revokedAt: null, createdByAdminId: 'admin-one',
  };
  const shares = {
    authenticate: mock(async (_headers: unknown, _publicationId: string) => { calls.push('authenticate'); return principal; }),
    revalidate: mock(async (_principal: unknown) => { calls.push('revalidate'); }),
    create: mock(async (_id: string, _body: unknown, _admin: string) => createdShare),
    list: mock(async (_id: string) => ({ credentials: [], truncated: false })),
    revoke: mock(async (_id: string, _credentialId: string) => ({ revoked: true })),
  };
  const feed = {
    capabilities: mock(async () => { calls.push('capabilities'); return { body: { protocolVersion: '1.0' }, etag: '"capabilities"' }; }),
    read: mock(async (_id: string) => { calls.push('read'); return { body, etag: '"feed"' }; }),
    artifact: mock(async (_id: string, _revision: string, _hash: string) => {
      calls.push('artifact'); return { bytes: Buffer.from('artifact'), mimeType: 'image/png', etag: '"artifact"' };
    }),
  };
  const controller = new FederationController(shares as unknown as ShareCredentialService, feed as unknown as FederationFeedService);
  return { controller, calls, shares, feed, principal, body, createdShare };
}

describe('FederationController', () => {
  test('TLS applies to all routes; only read endpoints bypass the admin guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FederationController)).toBe('federation');
    expect(Reflect.getMetadata(GUARDS_METADATA, FederationController)).toContain(FederationTransportGuard);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, FederationController)).toBeUndefined();
    for (const handler of ['capabilities', 'publication', 'artifact'] as const) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, FederationController.prototype[handler])).toBe(true);
    }
    for (const handler of ['createShare', 'listShares', 'revokeShare'] as const) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, FederationController.prototype[handler])).toBeUndefined();
    }
  });

  test('public discovery is raw JSON with private cache headers and optional 304', async () => {
    const { controller, shares } = setup();
    const first = response();
    await controller.capabilities({}, first.res);
    expect(first.state.status).toBe(200);
    expect(first.state.body).toEqual({ protocolVersion: '1.0' });
    expect(first.state.headers).toEqual({ 'Cache-Control': 'private, no-cache', ETag: '"capabilities"', Vary: 'Authorization' });
    const second = response();
    await controller.capabilities({ 'if-none-match': 'W/"capabilities"' }, second.res);
    expect(second.state.status).toBe(304);
    expect(second.state.ended).toBe(true);
    expect(second.state.body).toBeUndefined();
    expect(shares.authenticate).not.toHaveBeenCalled();
  });

  test.each([undefined, '"other"'])('feed authorizes before and after reading with header %s', async conditional => {
    const { controller, calls, shares, principal, feed, body } = setup();
    const { state, res } = response();
    await controller.publication({ authorization: 'Bearer secret', 'if-none-match': conditional }, 'publication-one', res);
    expect(calls).toEqual(['authenticate', 'read', 'revalidate']);
    expect(feed.read).toHaveBeenCalledWith('publication-one');
    expect(shares.authenticate).toHaveBeenCalledWith({ authorization: 'Bearer secret', 'if-none-match': conditional }, 'publication-one');
    expect(shares.revalidate).toHaveBeenCalledWith(principal);
    expect(state.status).toBe(200);
    expect(state.body).toBe(body);
    expect(state.headers.ETag).toBe('"feed"');
    expect(state.headers.Vary).toBe('Authorization');
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  test.each(['"feed"', 'W/"feed"', '"other", W/"feed"', '*'])('feed 304 also revalidates %s', async conditional => {
    const { controller, calls } = setup();
    const { state, res } = response();
    await controller.publication({ 'if-none-match': conditional }, 'publication-one', res);
    expect(calls).toEqual(['authenticate', 'read', 'revalidate']);
    expect(state.status).toBe(304);
    expect(state.ended).toBe(true);
    expect(state.body).toBeUndefined();
  });

  test.each([undefined, '"feed"'])('revocation/expiry during feed I/O denies body and 304 %s', async conditional => {
    const { controller, shares, calls } = setup();
    shares.revalidate.mockImplementation(async () => { calls.push('revalidate'); throw new UnauthorizedException('FEDERATION_UNAUTHORIZED'); });
    const { state, res } = response();
    await expect(controller.publication({ 'if-none-match': conditional }, 'publication-one', res)).rejects.toThrow('FEDERATION_UNAUTHORIZED');
    expect(calls).toEqual(['authenticate', 'read', 'revalidate']);
    expect(state.status).toBe(0);
    expect(state.body).toBeUndefined();
    expect(state.headers).toEqual({ 'Cache-Control': 'no-store' });
  });

  test('invalid shares never reach database-backed feed or artifact lookup', async () => {
    const { controller, shares, feed } = setup();
    shares.authenticate.mockRejectedValue(new UnauthorizedException('FEDERATION_UNAUTHORIZED'));
    await expect(controller.publication({}, 'publication-other', response().res)).rejects.toThrow('FEDERATION_UNAUTHORIZED');
    await expect(controller.artifact({}, 'publication-other', '1', 'hash', response().res)).rejects.toThrow('FEDERATION_UNAUTHORIZED');
    expect(feed.read).not.toHaveBeenCalled();
    expect(feed.artifact).not.toHaveBeenCalled();
    expect(shares.revalidate).not.toHaveBeenCalled();
  });

  test('artifact bytes use same authentication fence and strict safe response headers', async () => {
    const { controller, calls, feed, shares, principal } = setup();
    const { state, res } = response();
    await controller.artifact({}, 'publication-one', '7', 'hash', res);
    expect(calls).toEqual(['authenticate', 'artifact', 'revalidate']);
    expect(feed.artifact).toHaveBeenCalledWith('publication-one', '7', 'hash');
    expect(shares.revalidate).toHaveBeenCalledWith(principal);
    expect(state.status).toBe(200);
    expect(state.body).toEqual(Buffer.from('artifact'));
    expect(state.headers).toEqual({
      'Cache-Control': 'private, no-cache', ETag: '"artifact"', Vary: 'Authorization',
      'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff',
    });
  });

  test('conditional artifact response verifies its current credential', async () => {
    const { controller, calls } = setup();
    const { state, res } = response();
    await controller.artifact({ 'if-none-match': 'W/"artifact"' }, 'publication-one', '1', 'hash', res);
    expect(calls).toEqual(['authenticate', 'artifact', 'revalidate']);
    expect(state.status).toBe(304);
    expect(state.ended).toBe(true);
    expect(state.body).toBeUndefined();
  });

  test.each([undefined, '"artifact"'])('artifact revocation during I/O denies body and 304 %s', async conditional => {
    const { controller, shares, calls } = setup();
    shares.revalidate.mockImplementation(async () => { calls.push('revalidate'); throw new UnauthorizedException('FEDERATION_UNAUTHORIZED'); });
    const { state, res } = response();
    await expect(controller.artifact({ 'if-none-match': conditional }, 'publication-one', '1', 'hash', res)).rejects.toThrow('FEDERATION_UNAUTHORIZED');
    expect(calls).toEqual(['authenticate', 'artifact', 'revalidate']);
    expect(state.status).toBe(0);
    expect(state.body).toBeUndefined();
    expect(state.headers).toEqual({ 'Cache-Control': 'no-store' });
  });

  test('admin operations delegate exact scope; credential response is never cacheable', async () => {
    const { controller, shares, feed, createdShare } = setup();
    const create = response();
    expect(await controller.createShare('publication-one', { expiresAt: null }, { adminSession: { adminId: 'admin-one' } } as never, create.res))
      .toEqual(createdShare);
    expect(shares.create).toHaveBeenCalledWith('publication-one', { expiresAt: null }, 'admin-one');
    expect(create.state.headers['Cache-Control']).toBe('no-store');
    const list = response();
    await controller.listShares('publication-one', list.res);
    expect(shares.list).toHaveBeenCalledWith('publication-one');
    expect(list.state.headers['Cache-Control']).toBe('no-store');
    const revoke = response();
    await controller.revokeShare('publication-one', 'share-one', revoke.res);
    expect(shares.revoke).toHaveBeenCalledWith('publication-one', 'share-one');
    expect(revoke.state.headers['Cache-Control']).toBe('no-store');
    expect(feed.read).not.toHaveBeenCalled();
  });

  test('share creation requires the guard-populated administrator identity', async () => {
    const { controller, shares } = setup();
    await expect(controller.createShare('publication-one', {}, {} as never, response().res)).rejects.toThrow('FEDERATION_ADMIN_REQUIRED');
    expect(shares.create).not.toHaveBeenCalled();
  });
});
