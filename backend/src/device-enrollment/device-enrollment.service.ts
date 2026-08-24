import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { generateToken, hashToken } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from './pairing-code';

export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const MAX_ENROLLMENT_ATTEMPTS = 5;
export const DEVICE_CREDENTIAL_BYTES = 48;
const CODE_COLLISION_RETRIES = 4;
const INVALID_CODE_MESSAGE = 'Pairing code is invalid or unavailable';

export interface ExchangeResult {
  credential: string;
  credentialId: string;
  device: {
    id: number;
    name: string;
    externalId: string | null;
    profileId: string;
  };
}

@Injectable()
export class DeviceEnrollmentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(deviceId: number) {
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      const canonicalCode = generatePairingCode();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);

      try {
        const enrollment = await this.prisma.$transaction(async (transaction) => {
          const device = await transaction.device.findUnique({
            where: { id: deviceId },
            select: { id: true, isActive: true },
          });
          if (!device) throw new NotFoundException('Device not found');
          if (!device.isActive) {
            throw new BadRequestException('Inactive devices cannot be enrolled');
          }

          await transaction.deviceEnrollment.updateMany({
            where: { deviceId, usedAt: null },
            data: { usedAt: now },
          });
          return transaction.deviceEnrollment.create({
            data: {
              deviceId,
              codeHash: hashToken(canonicalCode),
              expiresAt,
            },
            select: {
              enrollmentId: true,
              deviceId: true,
              expiresAt: true,
              createdAt: true,
            },
          });
        });

        return {
          ...enrollment,
          code: formatPairingCode(canonicalCode),
        };
      } catch (error) {
        if (this.isUniqueCollision(error)) continue;
        throw error;
      }
    }

    throw new Error('Could not allocate a unique pairing code');
  }

  async exchange(presentedCode: string): Promise<ExchangeResult> {
    const canonicalCode = normalizePairingCode(presentedCode);
    if (!canonicalCode) throw this.invalidCode();

    const codeHash = hashToken(canonicalCode);
    const credential = generateToken(DEVICE_CREDENTIAL_BYTES);
    const credentialHash = hashToken(credential);
    const now = new Date();

    let result: Omit<ExchangeResult, 'credential'> | null;
    try {
      result = await this.prisma.$transaction(async (transaction) => {
        const counted = await transaction.deviceEnrollment.updateMany({
          where: {
            codeHash,
            attemptCount: { lt: MAX_ENROLLMENT_ATTEMPTS },
          },
          data: { attemptCount: { increment: 1 } },
        });
        if (counted.count !== 1) return null;

        const claimed = await transaction.deviceEnrollment.updateMany({
          where: {
            codeHash,
            usedAt: null,
            expiresAt: { gt: now },
            attemptCount: { lte: MAX_ENROLLMENT_ATTEMPTS },
          },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) return null;

        const enrollment = await transaction.deviceEnrollment.findUnique({
          where: { codeHash },
          select: {
            deviceId: true,
            device: {
              select: {
                id: true,
                name: true,
                externalId: true,
                profileId: true,
                isActive: true,
              },
            },
          },
        });
        if (!enrollment?.device.isActive) return null;

        await transaction.deviceCredential.updateMany({
          where: { deviceId: enrollment.deviceId, revokedAt: null },
          data: { revokedAt: now },
        });
        const issuedCredential = await transaction.deviceCredential.create({
          data: {
            deviceId: enrollment.deviceId,
            kind: 'device',
            tokenHash: credentialHash,
          },
          select: { credentialId: true },
        });

        const { isActive: _isActive, ...device } = enrollment.device;
        return { credentialId: issuedCredential.credentialId, device };
      }, {
        maxWait: 10_000,
        timeout: 10_000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (this.isTransactionConflict(error)) throw this.invalidCode();
      throw error;
    }

    if (!result) throw this.invalidCode();
    return { credential, ...result };
  }

  private invalidCode(): BadRequestException {
    return new BadRequestException(INVALID_CODE_MESSAGE);
  }

  private isUniqueCollision(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private isTransactionConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P1008', 'P2028', 'P2034'].includes(error.code);
  }
}
