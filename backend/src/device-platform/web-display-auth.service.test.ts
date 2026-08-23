import { beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import { hashToken } from '../common/utils/crypto.util';
import { WebDisplayAuthService } from './web-display-auth.service';

describe('WebDisplayAuthService', () => {
  let prisma: MockPrisma;
  let service: WebDisplayAuthService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new WebDisplayAuthService(prisma as any);
  });

  it('exchanges a valid one-time pairing token and consumes it', async () => {
    const pairingToken = 'p'.repeat(48);
    prisma.device.findUnique.mockResolvedValue({
      id: 7,
      name: 'Office',
      deviceType: 'web-display',
      externalId: 'display-7',
      pairingTokenHash: hashToken(pairingToken),
      pairingExpiresAt: new Date(Date.now() + 60_000),
    });
    prisma.deviceCredential.updateMany.mockResolvedValue({ count: 0 });
    prisma.deviceCredential.create.mockResolvedValue({ id: 1 });
    prisma.device.update.mockResolvedValue({ id: 7 });

    const result = await service.pair('display-7', pairingToken);

    expect(result.externalId).toBe('display-7');
    expect(result.credential.length).toBeGreaterThan(32);
    expect(prisma.device.update.calls[0][0].data.pairingTokenHash).toBeNull();
  });

  it('rejects an expired pairing link', async () => {
    prisma.device.findUnique.mockResolvedValue({
      id: 7,
      deviceType: 'web-display',
      externalId: 'display-7',
      pairingTokenHash: hashToken('p'.repeat(48)),
      pairingExpiresAt: new Date(Date.now() - 1),
    });
    await expect(service.pair('display-7', 'p'.repeat(48))).rejects.toThrow(BadRequestException);
  });

  it('rejects a credential belonging to another display', async () => {
    prisma.deviceCredential.findUnique.mockResolvedValue({
      id: 1,
      revokedAt: null,
      deviceId: 7,
      device: { externalId: 'other', deviceType: 'web-display', isActive: true },
    });
    await expect(service.authenticate('display-7', 'credential')).rejects.toThrow(UnauthorizedException);
  });
});
