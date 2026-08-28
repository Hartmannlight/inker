import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ShareCredential } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cloneIsolatedJson } from '../isolation/isolation-contract';

export type SharePrincipal = Readonly<{ credentialId: string; publicationId: string }>;
export const SHARE_LIMITS = Object.freeze({ perPublication: 16, global: 128, auditDays: 180, list: 100 });
const publicationIdValid = (id: string) => /^[a-zA-Z0-9-]{1,100}$/.test(id);
const hash = (token: string) => createHash('sha256').update('share:v1:').update(token).digest('hex');
const metadata = (row: ShareCredential) => ({ credentialId: row.credentialId, publicationId: row.publicationId,
  createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null, createdByAdminId: row.createdByAdminId });
const unavailable = () => new ServiceUnavailableException('FEDERATION_UNAVAILABLE');
const unauthorized = () => new UnauthorizedException('SHARE_UNAUTHORIZED');

@Injectable()
export class ShareCredentialService {
  constructor(private readonly prisma: PrismaService) {}

  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof HttpException) throw error; throw unavailable(); }
  }

  async authenticate(headers: IncomingHttpHeaders, publicationId: string): Promise<SharePrincipal> {
    return this.guarded(async () => {
      const header = headers.authorization;
      const token = typeof header === 'string' && /^Bearer sp_share_[A-Za-z0-9_-]{64}$/.test(header) ? header.slice(7) : '';
      // Even malformed credentials use the same indexed lookup and error shape.
      const row = await this.prisma.shareCredential.findUnique({ where: { tokenHash: hash(token) } });
      if (!token || !publicationIdValid(publicationId) || !row || row.publicationId !== publicationId || row.revokedAt ||
        (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw unauthorized();
      return { credentialId: row.credentialId, publicationId: row.publicationId };
    });
  }

  async revalidate(principal: SharePrincipal): Promise<void> {
    await this.guarded(async () => {
      const row = await this.prisma.shareCredential.findUnique({ where: { credentialId: principal.credentialId } });
      if (!row || row.publicationId !== principal.publicationId || row.revokedAt ||
        (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw unauthorized();
    });
  }

  async create(publicationId: string, body: unknown, adminId: string) {
    if (!publicationIdValid(publicationId) || typeof adminId !== 'string' || !adminId) throw new BadRequestException('INVALID_SHARE');
    let expiresAt: Date | null = null;
    try {
      const value = cloneIsolatedJson(body, 1024);
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => key !== 'expiresAt')) throw new Error();
      if (value.expiresAt !== undefined && value.expiresAt !== null) {
        if (typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt)) throw new Error();
        expiresAt = new Date(value.expiresAt);
        if (expiresAt.toISOString() !== value.expiresAt || expiresAt.getTime() <= Date.now()) throw new Error();
      }
    } catch { throw new BadRequestException('INVALID_SHARE'); }
    return this.guarded(() => this.prisma.$transaction(async tx => {
      // Acquire SQLite's writer slot before checking quotas: parallel creators
      // cannot each observe a free final slot and exceed the limit.
      await tx.$executeRawUnsafe('UPDATE share_credentials SET revoked_at = revoked_at WHERE 1 = 0');
      const now = new Date();
      if (expiresAt && expiresAt <= now) throw new BadRequestException('INVALID_SHARE');
      if (!await tx.publication.findFirst({ where: { publicationId, revisions: { some: {} } }, select: { publicationId: true } }))
        throw new NotFoundException('PUBLICATION_NOT_FOUND');
      const active = { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
      if (await tx.shareCredential.count({ where: { ...active, publicationId } }) >= SHARE_LIMITS.perPublication ||
        await tx.shareCredential.count({ where: active }) >= SHARE_LIMITS.global) throw new ConflictException('SHARE_LIMIT');
      // Expired/revoked credentials retain audit metadata for 180 days. Cleanup
      // is command-side only, never a write on a Federation read path.
      const cutoff = new Date(now.getTime() - SHARE_LIMITS.auditDays * 86400_000);
      await tx.shareCredential.deleteMany({ where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] } });
      const token = `sp_share_${randomBytes(48).toString('base64url')}`;
      const row = await tx.shareCredential.create({ data: { publicationId, tokenHash: hash(token), createdAt: now, expiresAt, createdByAdminId: adminId } });
      return { ...metadata(row), token };
    }, { timeout: 8000 }));
  }

  async list(publicationId: string) {
    if (!publicationIdValid(publicationId)) throw new BadRequestException('INVALID_SHARE');
    return this.guarded(async () => {
      const rows = await this.prisma.shareCredential.findMany({ where: { publicationId }, orderBy: [{ createdAt: 'desc' }, { credentialId: 'desc' }], take: SHARE_LIMITS.list + 1 });
      return { credentials: rows.slice(0, SHARE_LIMITS.list).map(metadata), truncated: rows.length > SHARE_LIMITS.list };
    });
  }

  async revoke(publicationId: string, credentialId: string) {
    if (!publicationIdValid(publicationId) || !/^[0-9a-f-]{36}$/.test(credentialId)) throw new NotFoundException('SHARE_NOT_FOUND');
    return this.guarded(async () => {
      await this.prisma.shareCredential.updateMany({ where: { credentialId, publicationId, revokedAt: null }, data: { revokedAt: new Date() } });
      const row = await this.prisma.shareCredential.findFirst({ where: { credentialId, publicationId } });
      if (!row) throw new NotFoundException('SHARE_NOT_FOUND');
      return metadata(row);
    });
  }
}
