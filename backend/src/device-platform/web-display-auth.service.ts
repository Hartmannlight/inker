import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../common/utils/crypto.util';
import { ProfileResolverService } from './profile-resolver.service';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { TransportAdapterRegistry } from './transport-adapter.registry';
import type { Prisma } from '@prisma/client';

type AuthCredential = Prisma.DeviceCredentialGetPayload<{ include: { device: { include: { profile: true; deliveryPolicy: true } } } }>;
export interface DeviceConnectionSession {
  credentialId: string;
  device: AuthCredential['device'];
  telemetryIntervalSeconds: number;
}

@Injectable()
export class WebDisplayAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileResolverService,
    private readonly policies: DeliveryPolicyRegistry,
    private readonly transports: TransportAdapterRegistry,
  ) {}

  async authenticate(externalId: string, token: string) {
    return (await this.authenticateConnection(externalId, token)).device;
  }

  async authenticateConnection(externalId: string, token: string): Promise<DeviceConnectionSession> {
    if (typeof externalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(externalId) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new UnauthorizedException('Invalid device credentials');
    }
    const credential = await this.prisma.deviceCredential.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { device: { include: { profile: true, deliveryPolicy: true } } },
    });
    return this.validate(credential, externalId);
  }

  async revalidateConnection(session: DeviceConnectionSession): Promise<DeviceConnectionSession> {
    const credential = await this.prisma.deviceCredential.findUnique({
      where: { credentialId: session.credentialId },
      include: { device: { include: { profile: true, deliveryPolicy: true } } },
    });
    const current = this.validate(credential, session.device.externalId!);
    if (current.device.id !== session.device.id) throw new UnauthorizedException('Invalid device credentials');
    return current;
  }

  private validate(credential: AuthCredential | null, externalId: string): DeviceConnectionSession {
    if (
      !credential ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) ||
      credential.device.externalId !== externalId ||
      !credential.device.isActive
    ) {
      throw new UnauthorizedException('Invalid device credentials');
    }
    try {
      const configuration = this.profiles.resolvePersisted(credential.device);
      const policy = this.policies.get(configuration.deliveryPolicy.mode);
      const adapter = this.transports.get(policy.selectTransport(configuration.capabilities));
      if (adapter.webSocketProtocolVersion !== '1.0') throw new Error();
      return { credentialId: credential.credentialId, device: credential.device,
        telemetryIntervalSeconds: Math.max(60, configuration.deliveryPolicy.telemetryIntervalSeconds) };
    } catch {
      throw new UnauthorizedException('Invalid device credentials');
    }
  }
}
