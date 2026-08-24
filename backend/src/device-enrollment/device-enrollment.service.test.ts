import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'bun:test';
import { hashToken } from '../common/utils/crypto.util';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';
import {
  DEVICE_CREDENTIAL_BYTES,
  ENROLLMENT_TTL_MS,
  DeviceEnrollmentService,
} from './device-enrollment.service';

describe('DeviceEnrollmentService', () => {
  let prisma: MockPrisma;
  let service: DeviceEnrollmentService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(async (operation: any) => operation(prisma));
    service = new DeviceEnrollmentService(prisma as any);
  });

  it('creates an admin enrollment with no plaintext code in persistence data', async () => {
    const before = Date.now();
    prisma.device.findUnique.mockResolvedValue({ id: 7, isActive: true });
    prisma.deviceEnrollment.updateMany.mockResolvedValue({ count: 0 });
    prisma.deviceEnrollment.create.mockImplementation(async ({ data }: any) => ({
      enrollmentId: 'enrollment-7',
      deviceId: data.deviceId,
      expiresAt: data.expiresAt,
      createdAt: new Date(),
    }));

    const result = await service.create(7);

    expect(result.enrollmentId).toBe('enrollment-7');
    expect(result.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ENROLLMENT_TTL_MS);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ENROLLMENT_TTL_MS);
    const persisted = prisma.deviceEnrollment.create.calls[0][0].data;
    expect(persisted.code).toBeUndefined();
    expect(persisted.credential).toBeUndefined();
    expect(persisted.codeHash).toBe(hashToken(result.code.replaceAll('-', '')));
  });

  it('rejects enrollment for a missing or inactive device', async () => {
    prisma.device.findUnique.mockResolvedValue(null);
    await expect(service.create(404)).rejects.toThrow(NotFoundException);

    prisma.device.findUnique.mockResolvedValue({ id: 7, isActive: false });
    await expect(service.create(7)).rejects.toThrow(BadRequestException);
  });

  it('claims once, revokes old credentials and stores only the new credential hash', async () => {
    prisma.deviceEnrollment.updateMany.mockResolvedValue({ count: 1 });
    prisma.deviceEnrollment.findUnique.mockResolvedValue({
      enrollmentId: 'enrollment-7',
      deviceId: 7,
      device: {
        id: 7,
        name: 'Office',
        externalId: 'display-7',
        profileId: 'browser-hd-1920x1080',
        isActive: true,
      },
    });
    prisma.deviceCredential.updateMany.mockResolvedValue({ count: 1 });
    prisma.deviceCredential.create.mockResolvedValue({ credentialId: 'credential-8' });

    const result = await service.exchange('7k4m-9q2d-xp');

    expect(Buffer.from(result.credential, 'base64url')).toHaveLength(DEVICE_CREDENTIAL_BYTES);
    expect(result).toMatchObject({
      credentialId: 'credential-8',
      device: {
        id: 7,
        externalId: 'display-7',
        profileId: 'browser-hd-1920x1080',
      },
    });
    const persisted = prisma.deviceCredential.create.calls[0][0].data;
    expect(persisted.tokenHash).toBe(hashToken(result.credential));
    expect(persisted.credential).toBeUndefined();
    expect(prisma.deviceCredential.updateMany.calls[0][0].where).toEqual({
      deviceId: 7,
      revokedAt: null,
    });
  });

  it('uses one constant response for malformed, expired and replayed codes', async () => {
    const errors: BadRequestException[] = [];
    let databaseCall = 0;
    prisma.deviceEnrollment.updateMany.mockImplementation(async () => ({
      count: databaseCall++ % 2 === 0 ? 1 : 0,
    }));

    for (const code of ['not-a-code', '7K4M-9Q2D-XP', '7K4M-9Q2D-XP']) {
      try {
        await service.exchange(code);
      } catch (error) {
        errors.push(error as BadRequestException);
      }
    }

    expect(errors).toHaveLength(3);
    expect(new Set(errors.map((error) => JSON.stringify(error.getResponse()))).size).toBe(1);
    expect(errors[0].getStatus()).toBe(400);
  });
});
