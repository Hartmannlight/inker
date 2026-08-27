import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../common/utils/crypto.util';
import { DEVICE_CONFIGURATION_INCLUDE } from './device-configuration.service';

/** Read-only device authentication. No admin session or pairing lifecycle changes. */
@Injectable()
export class PullDeviceAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async authenticate(headers: IncomingHttpHeaders) {
    try {
      return await this.lookup(headers);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      // Prisma errors may contain the lookup argument. Do not pass them to HTTP/logging.
      throw new ServiceUnavailableException('Device authentication unavailable');
    }
  }

  private async lookup(headers: IncomingHttpHeaders) {
    const reject = () => new UnauthorizedException('Invalid device credentials');
    const authorization = headers.authorization;
    const legacy = headers.http_id ?? headers['access-token'];
    // Reject ambiguous input; never fall back after a failed authentication.
    if (authorization !== undefined) {
      if (legacy !== undefined) throw reject();
      const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(authorization);
      if (!match) throw reject();
      const credential = await this.prisma.deviceCredential.findUnique({
        where: { tokenHash: hashToken(match[1]) },
        include: { device: { include: DEVICE_CONFIGURATION_INCLUDE } },
      });
      if (!credential || credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) ||
        !credential.device.isActive) throw reject();
      return credential.device;
    }
    if (headers.http_id !== undefined && headers['access-token'] !== undefined) throw reject();
    if (typeof legacy !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(legacy)) throw reject();
    // The existing TRMNL API-key lookup stays intact. MAC addresses cannot authenticate here.
    const device = await this.prisma.device.findUnique({
      where: { apiKey: legacy }, include: DEVICE_CONFIGURATION_INCLUDE,
    });
    if (!device?.isActive) throw reject();
    return device;
  }
}
