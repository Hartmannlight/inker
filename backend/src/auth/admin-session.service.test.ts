import { beforeEach, describe, expect, test } from 'bun:test';
import { AdminSessionService } from './admin-session.service';
import { createMockPrisma } from '../test/mocks/prisma.mock';

describe('AdminSessionService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: AdminSessionService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.adminSession.updateMany.mockResolvedValue({ count: 1 });
    service = new AdminSessionService(prisma as never);
  });

  test('persists only token and CSRF hashes and returns opaque secrets once', async () => {
    prisma.adminSession.create.mockImplementation(async ({ data }: any) => ({
      ...data,
      sessionId: 'session-1',
    }));

    const created = await service.create('admin-1', {
      userAgent: 'test browser',
      ipAddress: '127.0.0.1',
    });
    const data = prisma.adminSession.create.calls[0][0].data;

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.csrfTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(data)).not.toContain(created.token);
    expect(JSON.stringify(data)).not.toContain(created.csrfToken);
  });

  test('expires idle sessions and revokes them server-side', async () => {
    prisma.adminSession.findUnique.mockResolvedValue({
      sessionId: 'session-1',
      adminId: 'admin-1',
      tokenHash: 'hash',
      csrfTokenHash: 'csrf-hash',
      issuedAt: new Date(),
      createdAt: new Date(),
      lastSeenAt: new Date(Date.now() - 31 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
      userAgent: null,
      ipAddressHash: null,
    });

    expect(await service.validate('raw-session-token')).toBeNull();
    expect(prisma.adminSession.updateMany.calls[0][0]).toMatchObject({
      where: { sessionId: 'session-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  test('rotates an old token while preserving the session identity', async () => {
    prisma.adminSession.findUnique.mockResolvedValue({
      sessionId: 'session-1',
      adminId: 'admin-1',
      tokenHash: 'hash',
      csrfTokenHash: 'csrf-hash',
      issuedAt: new Date(Date.now() - 16 * 60 * 1000),
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
      userAgent: null,
      ipAddressHash: null,
    });
    const validated = await service.validate('old-session-token');

    expect(validated?.sessionId).toBe('session-1');
    expect(validated?.rotatedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prisma.adminSession.updateMany.calls[0][0].data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not return a losing token from a concurrent rotation', async () => {
    prisma.adminSession.findUnique.mockResolvedValue({
      sessionId: 'session-1',
      adminId: 'admin-1',
      tokenHash: 'hash',
      csrfTokenHash: 'csrf-hash',
      issuedAt: new Date(Date.now() - 16 * 60 * 1000),
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
      userAgent: null,
      ipAddressHash: null,
    });
    prisma.adminSession.updateMany.mockResolvedValue({ count: 0 });
    expect((await service.validate('old-session-token'))?.rotatedToken).toBeUndefined();
  });
});
