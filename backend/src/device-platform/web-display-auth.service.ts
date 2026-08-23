import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateToken, hashToken, verifyToken } from '../common/utils/crypto.util';
import { DEVICE_TYPES } from '../devices/drivers/device-driver';

@Injectable()
export class WebDisplayAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async pair(externalId: string, pairingToken: string) {
    const device = await this.prisma.device.findUnique({ where: { externalId } });
    if (!device || device.deviceType !== DEVICE_TYPES.WEB_DISPLAY) {
      throw new NotFoundException('Web display not found');
    }
    if (!device.pairingTokenHash || !device.pairingExpiresAt) {
      throw new BadRequestException('This pairing link has already been used');
    }
    if (device.pairingExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Pairing link has expired');
    }
    if (!verifyToken(pairingToken, device.pairingTokenHash)) {
      throw new UnauthorizedException('Invalid pairing token');
    }

    const credential = generateToken(48);
    await this.prisma.$transaction([
      this.prisma.deviceCredential.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.deviceCredential.create({
        data: { deviceId: device.id, kind: 'web-display', tokenHash: hashToken(credential) },
      }),
      this.prisma.device.update({
        where: { id: device.id },
        data: { pairingTokenHash: null, pairingExpiresAt: null },
      }),
    ]);

    return { credential, externalId, deviceId: device.id, name: device.name };
  }

  async authenticate(externalId: string, token: string) {
    if (!externalId || !token) throw new UnauthorizedException('Device credentials required');
    const tokenHash = hashToken(token);
    const credential = await this.prisma.deviceCredential.findUnique({
      where: { tokenHash },
      include: { device: true },
    });
    if (
      !credential ||
      credential.revokedAt ||
      credential.device.externalId !== externalId ||
      credential.device.deviceType !== DEVICE_TYPES.WEB_DISPLAY ||
      !credential.device.isActive
    ) {
      throw new UnauthorizedException('Invalid device credentials');
    }
    await this.prisma.$transaction([
      this.prisma.deviceCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      }),
      this.prisma.device.update({
        where: { id: credential.deviceId },
        data: { lastSeenAt: new Date(), lastConnectedAt: new Date() },
      }),
    ]);
    return credential.device;
  }
}
