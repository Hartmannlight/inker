import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdminCredentialService } from '../src/auth/admin-credential.service';
import {
  ADMIN_SESSION_IDLE_TTL_MS,
  ADMIN_SESSION_ROTATION_MS,
  ADMIN_SESSION_TOUCH_INTERVAL_MS,
  AdminSessionService,
} from '../src/auth/admin-session.service';
import { PasswordHasherService } from '../src/auth/password-hasher.service';

const backendRoot = resolve(import.meta.dir, '..');
const migrationScript = join(backendRoot, 'scripts', 'migrate-database.ts');
const createdDirectories: string[] = [];

function databaseUrl(path: string) {
  return `file:${path.replaceAll('\\', '/')}`;
}

async function migrate(path: string) {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, migrationScript],
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl(path) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}

describe('WP-12 admin credential and session persistence', () => {
  let prisma: PrismaClient;
  let databasePath: string;
  let credentials: AdminCredentialService;
  let sessions: AdminSessionService;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inker-admin-auth-test-'));
    createdDirectories.push(directory);
    databasePath = join(directory, 'inker.db');
    await migrate(databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
    await prisma.$connect();
    credentials = new AdminCredentialService(
      prisma as never,
      { get: () => 'first setup password' } as never,
      new PasswordHasherService(),
    );
    sessions = new AdminSessionService(prisma as never);
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    for (const directory of createdDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('first setup stores only an adaptive hash and restart cannot replace it', async () => {
    await credentials.onModuleInit();
    const stored = await prisma.adminCredential.findFirstOrThrow();
    expect(stored.kind).toBe('password');
    expect(stored.passwordHash).toMatch(/^scrypt\$v=1\$/);
    expect(JSON.stringify(stored)).not.toContain('first setup password');
    expect(await credentials.authenticate('first setup password')).toBeTruthy();
    expect(await credentials.authenticate('wrong password')).toBeNull();

    const restarted = new AdminCredentialService(
      prisma as never,
      { get: () => 'replacement from environment' } as never,
      new PasswordHasherService(),
    );
    await restarted.onModuleInit();
    expect(await prisma.adminAccount.count()).toBe(1);
    expect(await prisma.adminCredential.count()).toBe(1);
    expect(await restarted.authenticate('replacement from environment')).toBeNull();
  });

  test('session secrets stay hashed and individual revocation is immediate', async () => {
    await credentials.onModuleInit();
    const admin = await prisma.adminAccount.findUniqueOrThrow({ where: { scopeKey: 'instance' } });
    const created = await sessions.create(admin.adminId, {
      userAgent: 'Integration Browser',
      ipAddress: '192.0.2.10',
    });
    const stored = await prisma.adminSession.findUniqueOrThrow({
      where: { sessionId: created.sessionId },
    });
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.csrfTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(JSON.stringify(stored)).not.toContain(created.csrfToken);
    expect(await sessions.verifyCsrf(created.sessionId, 'foreign-csrf')).toBe(false);
    expect(await sessions.verifyCsrf(created.sessionId, created.csrfToken)).toBe(true);
    expect(await sessions.validate(created.token)).toMatchObject({ sessionId: created.sessionId });

    const overview = await sessions.list(admin.adminId, created.sessionId);
    expect(overview[0]).toMatchObject({ sessionId: created.sessionId, current: true });
    expect(JSON.stringify(overview)).not.toMatch(/tokenHash|csrfTokenHash|ipAddressHash/i);
    expect(await sessions.revoke(created.sessionId, admin.adminId)).toBe(true);
    expect(await sessions.validate(created.token)).toBeNull();
  });

  test('idle expiry and token rotation invalidate the previous token server-side', async () => {
    await credentials.onModuleInit();
    const admin = await prisma.adminAccount.findUniqueOrThrow({ where: { scopeKey: 'instance' } });

    const idle = await sessions.create(admin.adminId, {});
    await prisma.adminSession.update({
      where: { sessionId: idle.sessionId },
      data: { lastSeenAt: new Date(Date.now() - ADMIN_SESSION_IDLE_TTL_MS - 1) },
    });
    expect(await sessions.validate(idle.token)).toBeNull();

    const rotating = await sessions.create(admin.adminId, {});
    await prisma.adminSession.update({
      where: { sessionId: rotating.sessionId },
      data: { issuedAt: new Date(Date.now() - ADMIN_SESSION_ROTATION_MS - 1) },
    });
    const rotated = await sessions.validate(rotating.token);
    expect(rotated?.rotatedToken).toBeTruthy();
    expect(await sessions.validate(rotating.token)).toBeNull();
    expect(await sessions.validate(rotated!.rotatedToken!)).toMatchObject({
      sessionId: rotating.sessionId,
    });
  });

  test('a contended technical touch never holds a valid admin request behind the SQLite writer', async () => {
    await credentials.onModuleInit();
    const admin = await prisma.adminAccount.findUniqueOrThrow({ where: { scopeKey: 'instance' } });
    const created = await sessions.create(admin.adminId, {});
    const now = new Date();
    await prisma.adminSession.update({ where: { sessionId: created.sessionId },
      data: { lastSeenAt: new Date(now.getTime() - ADMIN_SESSION_TOUCH_INTERVAL_MS) } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
    await locker.$connect();
    let locked!: () => void, release!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const holdLock = new Promise<void>(resolve => { release = resolve; });
    const transaction = locker.$transaction(async tx => {
      await tx.$executeRaw`UPDATE admin_sessions SET last_seen_at = last_seen_at WHERE session_id = ${created.sessionId}`;
      locked();
      await holdLock;
    }, { timeout: 10_000, maxWait: 5_000 });
    try {
      await lockReady;
      const started = performance.now();
      expect(await sessions.validate(created.token, now)).toMatchObject({ sessionId: created.sessionId });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      release();
      await transaction;
      await locker.$disconnect();
    }
    let touched = false;
    for (let attempt = 0; attempt < 100 && !touched; attempt++) {
      const row = await prisma.adminSession.findUniqueOrThrow({ where: { sessionId: created.sessionId } });
      touched = row.lastSeenAt.getTime() === now.getTime();
      if (!touched) await Bun.sleep(25);
    }
    expect(touched).toBe(true);
  }, 30_000);

  test('logout-all revokes every active session', async () => {
    await credentials.onModuleInit();
    const admin = await prisma.adminAccount.findUniqueOrThrow({ where: { scopeKey: 'instance' } });
    const first = await sessions.create(admin.adminId, {});
    const second = await sessions.create(admin.adminId, {});
    expect(await sessions.revokeAll(admin.adminId)).toBe(2);
    expect(await sessions.validate(first.token)).toBeNull();
    expect(await sessions.validate(second.token)).toBeNull();
  });
});
