import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashToken } from '../src/common/utils/crypto.util';
import {
  MAX_ENROLLMENT_ATTEMPTS,
  DeviceEnrollmentService,
} from '../src/device-enrollment/device-enrollment.service';

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

describe('device enrollment persistence boundary', () => {
  let prisma: PrismaClient;
  let service: DeviceEnrollmentService;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inker-enrollment-test-'));
    createdDirectories.push(directory);
    const path = join(directory, 'inker.db');
    await migrate(path);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(path) } } });
    await prisma.$connect();
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
    service = new DeviceEnrollmentService(prisma as any);
  }, 30_000);

  afterEach(async () => {
    await prisma?.$disconnect();
    for (const directory of createdDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function createDevice(suffix: string) {
    return prisma.device.create({
      data: {
        name: `Enrollment ${suffix}`,
        externalId: `enrollment-${suffix}`,
        profileId: 'browser-hd-1920x1080',
        deliveryPolicyId: 'reference-connected-browser',
      },
    });
  }

  test('persists only hashes, expires after ten minutes and rotates device credentials', async () => {
    const device = await createDevice('rotation');
    const oldCredential = 'previous-browser-credential';
    await prisma.deviceCredential.create({
      data: { deviceId: device.id, tokenHash: hashToken(oldCredential), kind: 'web-display' },
    });

    const enrollment = await service.create(device.id);
    expect(enrollment.expiresAt.getTime() - enrollment.createdAt.getTime()).toBeLessThanOrEqual(10 * 60 * 1000);
    const storedEnrollment = await prisma.deviceEnrollment.findUniqueOrThrow({
      where: { enrollmentId: enrollment.enrollmentId },
    });
    expect(storedEnrollment.codeHash).toBe(hashToken(enrollment.code.replaceAll('-', '')));
    expect(JSON.stringify(storedEnrollment)).not.toContain(enrollment.code);

    const exchanged = await service.exchange(` ${enrollment.code.toLowerCase()} `);
    const credentials = await prisma.deviceCredential.findMany({
      where: { deviceId: device.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(credentials).toHaveLength(2);
    expect(credentials[0].revokedAt).toBeInstanceOf(Date);
    expect(credentials[1]).toMatchObject({
      credentialId: exchanged.credentialId,
      tokenHash: hashToken(exchanged.credential),
      revokedAt: null,
    });
    expect(JSON.stringify(credentials)).not.toContain(exchanged.credential);

    const replay = service.exchange(enrollment.code);
    await expect(replay).rejects.toThrow('Pairing code is invalid or unavailable');
    const used = await prisma.deviceEnrollment.findUniqueOrThrow({
      where: { enrollmentId: enrollment.enrollmentId },
    });
    expect(used.usedAt).toBeInstanceOf(Date);
    expect(used.attemptCount).toBe(2);
  }, 30_000);

  test('returns the same error for expired, replayed and exhausted enrollments', async () => {
    const device = await createDevice('errors');
    const enrollment = await service.create(device.id);
    await prisma.deviceEnrollment.update({
      where: { enrollmentId: enrollment.enrollmentId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    const responses: string[] = [];
    for (let attempt = 0; attempt < MAX_ENROLLMENT_ATTEMPTS + 1; attempt += 1) {
      try {
        await service.exchange(enrollment.code);
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        responses.push(JSON.stringify((error as BadRequestException).getResponse()));
      }
    }

    expect(new Set(responses).size).toBe(1);
    expect((await prisma.deviceEnrollment.findUniqueOrThrow({
      where: { enrollmentId: enrollment.enrollmentId },
    })).attemptCount).toBe(MAX_ENROLLMENT_ATTEMPTS);
    expect(await prisma.deviceCredential.count({ where: { deviceId: device.id } })).toBe(0);
  }, 30_000);

  test('rolls code consumption and credential revocation back if issuance fails', async () => {
    const device = await createDevice('rollback');
    const oldCredential = await prisma.deviceCredential.create({
      data: {
        deviceId: device.id,
        tokenHash: hashToken('still-valid-after-rollback'),
        kind: 'device',
      },
    });
    const enrollment = await service.create(device.id);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_wp09_credential_insert
      BEFORE INSERT ON device_credentials
      WHEN NEW.device_id = ${device.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced credential failure');
      END;
    `);

    await expect(service.exchange(enrollment.code)).rejects.toThrow();

    expect(await prisma.deviceEnrollment.findUniqueOrThrow({
      where: { enrollmentId: enrollment.enrollmentId },
    })).toMatchObject({ usedAt: null, attemptCount: 0 });
    expect(await prisma.deviceCredential.findUniqueOrThrow({
      where: { id: oldCredential.id },
    })).toMatchObject({ revokedAt: null });
  }, 30_000);

  test('allows exactly one successful exchange under parallel requests', async () => {
    const device = await createDevice('race');
    const enrollment = await service.create(device.id);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => service.exchange(enrollment.code)),
    );
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(11);
    expect(await prisma.deviceCredential.count({ where: { deviceId: device.id } })).toBe(1);
    expect((await prisma.deviceEnrollment.findUniqueOrThrow({
      where: { enrollmentId: enrollment.enrollmentId },
    })).usedAt).toBeInstanceOf(Date);
  }, 30_000);
});
