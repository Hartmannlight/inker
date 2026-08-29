import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export const ADMIN_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
export const ADMIN_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const ADMIN_SESSION_ROTATION_MS = 15 * 60 * 1000;
export const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionClient {
  userAgent?: string;
  ipAddress?: string;
}

export interface CreatedAdminSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ValidatedAdminSession {
  sessionId: string;
  adminId: string;
  expiresAt: Date;
  rotatedToken?: string;
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sanitizeUserAgent(value: string | undefined): string | null {
  if (!value) return null;
  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .slice(0, 256);
  return sanitized || null;
}

@Injectable()
export class AdminSessionService {
  private readonly pendingTouches = new Set<string>();
  constructor(private readonly prisma: PrismaService) {}

  private touch(session: { sessionId: string; tokenHash: string; lastSeenAt: Date }, now: Date): void {
    if (this.pendingTouches.has(session.sessionId)) return;
    this.pendingTouches.add(session.sessionId);
    // Presence persistence is technical metadata. It must never hold an
    // authenticated request behind SQLite's single writer; idle validity was
    // already decided from the durable timestamp above.
    void Promise.resolve().then(() => this.prisma.adminSession.updateMany({
      where: { sessionId: session.sessionId, tokenHash: session.tokenHash, revokedAt: null, lastSeenAt: session.lastSeenAt },
      data: { lastSeenAt: now },
    })).catch(() => undefined).finally(() => this.pendingTouches.delete(session.sessionId));
  }

  async create(adminId: string, client: SessionClient): Promise<CreatedAdminSession> {
    const now = new Date();
    const token = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_TTL_MS);
    const session = await this.prisma.adminSession.create({
      data: {
        adminId,
        tokenHash: hashSecret(token),
        csrfTokenHash: hashSecret(csrfToken),
        issuedAt: now,
        lastSeenAt: now,
        expiresAt,
        userAgent: sanitizeUserAgent(client.userAgent),
        ipAddressHash: client.ipAddress
          ? hashSecret(`${token}:${client.ipAddress}`)
          : null,
      },
    });
    return { sessionId: session.sessionId, token, csrfToken, expiresAt };
  }

  async validate(token: string, now = new Date()): Promise<ValidatedAdminSession | null> {
    if (!token || token.length > 128) return null;
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: hashSecret(token) },
    });
    if (!session || session.revokedAt) return null;

    const idleExpiresAt = session.lastSeenAt.getTime() + ADMIN_SESSION_IDLE_TTL_MS;
    if (session.expiresAt.getTime() <= now.getTime() || idleExpiresAt <= now.getTime()) {
      await this.prisma.adminSession.updateMany({
        where: { sessionId: session.sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      return null;
    }

    let rotatedToken: string | undefined;
    let rotationCandidate: string | undefined;
    const rotationDue = session.issuedAt.getTime() + ADMIN_SESSION_ROTATION_MS <= now.getTime();
    const touchDue = session.lastSeenAt.getTime() + ADMIN_SESSION_TOUCH_INTERVAL_MS <= now.getTime();
    const validated = {
      sessionId: session.sessionId,
      adminId: session.adminId,
      expiresAt: session.expiresAt,
    };
    if (!rotationDue) {
      if (touchDue) this.touch(session, now);
      return validated;
    }
    const data: Record<string, unknown> = { lastSeenAt: now };
    rotationCandidate = opaqueToken();
    data.tokenHash = hashSecret(rotationCandidate);
    data.issuedAt = now;
    let update: { count: number };
    try {
      update = await this.prisma.adminSession.updateMany({
        where: { sessionId: session.sessionId, tokenHash: session.tokenHash, revokedAt: null, lastSeenAt: session.lastSeenAt },
        data,
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError
        && ['P1008', 'P2028', 'P2034'].includes(error.code))) throw error;
      return validated;
    }
    if (rotationCandidate && update.count === 1) rotatedToken = rotationCandidate;
    return {
      sessionId: session.sessionId,
      adminId: session.adminId,
      expiresAt: session.expiresAt,
      rotatedToken,
    };
  }

  async verifyCsrf(sessionId: string, token: string): Promise<boolean> {
    if (!token || token.length > 128) return false;
    const session = await this.prisma.adminSession.findUnique({
      where: { sessionId },
      select: { csrfTokenHash: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return false;
    const expected = Buffer.from(session.csrfTokenHash, 'hex');
    const actual = Buffer.from(hashSecret(token), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const csrfToken = opaqueToken();
    await this.prisma.adminSession.update({
      where: { sessionId },
      data: { csrfTokenHash: hashSecret(csrfToken) },
    });
    return csrfToken;
  }

  async revoke(sessionId: string, adminId: string): Promise<boolean> {
    const result = await this.prisma.adminSession.updateMany({
      where: { sessionId, adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count === 1;
  }

  async revokeAll(adminId: string): Promise<number> {
    const result = await this.prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async list(adminId: string, currentSessionId: string) {
    const sessions = await this.prisma.adminSession.findMany({
      where: {
        adminId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        lastSeenAt: { gt: new Date(Date.now() - ADMIN_SESSION_IDLE_TTL_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        sessionId: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        userAgent: true,
      },
    });
    return sessions.map((session) => ({
      ...session,
      current: session.sessionId === currentSessionId,
    }));
  }
}
