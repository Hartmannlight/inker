import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordHasherService } from './password-hasher.service';

@Injectable()
export class AdminCredentialService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly passwordHasher: PasswordHasherService,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.adminAccount.findUnique({
      where: { scopeKey: 'instance' },
      select: { adminId: true },
    });
    if (existing) return;

    const bootstrapPassword = this.config.get<string>('admin.pin');
    if (!bootstrapPassword) throw new Error('Admin credential setup is incomplete');
    const passwordHash = await this.passwordHasher.hash(bootstrapPassword);
    const adminId = randomUUID();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.adminAccount.create({
        data: { adminId, scopeKey: 'instance' },
      });
      await transaction.adminCredential.create({
        data: {
          credentialId: randomUUID(),
          adminId,
          kind: 'password',
          passwordHash,
        },
      });
    });
  }

  async authenticate(password: string): Promise<string | null> {
    const credential = await this.prisma.adminCredential.findFirst({
      where: { kind: 'password', revokedAt: null, admin: { scopeKey: 'instance' } },
      orderBy: { createdAt: 'desc' },
      select: { credentialId: true, adminId: true, passwordHash: true },
    });
    if (!credential?.passwordHash) return null;
    if (!await this.passwordHasher.verify(password, credential.passwordHash)) return null;
    await this.prisma.adminCredential.update({
      where: { credentialId: credential.credentialId },
      data: { lastUsedAt: new Date() },
    });
    return credential.adminId;
  }
}
