import { Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FederationIdentityService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // An empty Prisma upsert may still acquire a writer lock. Existing identity
    // needs no mutation when the API restarts alongside the worker.
    if (await this.prisma.federationIdentity.findUnique({ where: { id: 1 }, select: { id: true } })) return;
    // Empty upsert update does not fire the immutable-identity UPDATE trigger.
    await this.prisma.federationIdentity.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }

  async serverId(): Promise<string> {
    try {
      const row = await this.prisma.federationIdentity.findUnique({ where: { id: 1 }, select: { serverId: true } });
      if (!row || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.serverId))
        throw new Error('Invalid identity');
      return row.serverId;
    } catch { throw new ServiceUnavailableException('FEDERATION_UNAVAILABLE'); }
  }
}
