import { beforeEach, describe, expect, it } from 'bun:test';
import { UnauthorizedException } from '@nestjs/common';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import { WebDisplayAuthService } from './web-display-auth.service';

describe('WebDisplayAuthService', () => {
  let prisma: MockPrisma;
  let service: WebDisplayAuthService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new WebDisplayAuthService(prisma as any,
      { resolvePersisted: () => ({ capabilities: {}, deliveryPolicy: { mode: 'connected', telemetryIntervalSeconds: 300 } }) } as any,
      { get: () => ({ selectTransport: () => 'test-transport' }) } as any,
      { get: () => ({ webSocketProtocolVersion: '1.0' }) } as any);
  });

  it('rejects a credential belonging to another display', async () => {
    prisma.deviceCredential.findUnique.mockResolvedValue({
      id: 1,
      revokedAt: null,
      deviceId: 7,
      device: { externalId: 'other', profileId: 'browser-hd-1920x1080', isActive: true },
    });
    await expect(service.authenticate('display-7', 'a'.repeat(64))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects expired credentials without writes', async () => {
    prisma.deviceCredential.findUnique.mockResolvedValue({
      id: 1, credentialId: 'id', revokedAt: null, expiresAt: new Date(Date.now() - 1), deviceId: 7,
      device: { id: 7, externalId: 'display-7', profileId: 'browser-hd-1920x1080', isActive: true },
    });
    await expect(service.authenticate('display-7', 'a'.repeat(64))).rejects.toThrow(UnauthorizedException);
    expect(prisma.device.update.calls).toHaveLength(0);
    expect(prisma.deviceCredential.update.calls).toHaveLength(0);
  });

  it('authenticates a capability-selected non-browser profile without writes and rechecks its credential ID', async () => {
    prisma.deviceCredential.findUnique.mockResolvedValue({
      credentialId: 'public-id', expiresAt: null, revokedAt: null,
      device: { id: 7, externalId: 'screen', profileId: 'third-party-profile', isActive: true },
    });
    const session = await service.authenticateConnection('screen', 'a'.repeat(64));
    expect(session.credentialId).toBe('public-id');
    expect(await service.revalidateConnection(session)).toEqual(session);
    expect(prisma.deviceCredential.findUnique.calls[1][0].where).toEqual({ credentialId: 'public-id' });
    expect(prisma.device.update.calls).toHaveLength(0);
    expect(prisma.deviceCredential.update.calls).toHaveLength(0);
  });
});
