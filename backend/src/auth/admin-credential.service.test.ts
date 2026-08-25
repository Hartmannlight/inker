import { beforeEach, describe, expect, test } from 'bun:test';
import { AdminCredentialService } from './admin-credential.service';
import { createMockPrisma } from '../test/mocks/prisma.mock';
import { createMock } from '../test/mocks/helpers';

describe('AdminCredentialService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let hasher: any;
  let service: AdminCredentialService;

  beforeEach(() => {
    prisma = createMockPrisma();
    hasher = {
      hash: createMock().mockResolvedValue('adaptive-password-hash'),
      verify: createMock().mockResolvedValue(true),
    };
    service = new AdminCredentialService(
      prisma as never,
      { get: () => 'bootstrap admin password' } as never,
      hasher,
    );
  });

  test('controlled first setup creates one instance admin with only a password hash', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
    await service.onModuleInit();
    expect(hasher.hash.calls[0][0]).toBe('bootstrap admin password');
    const credential = prisma.adminCredential.create.calls[0][0].data;
    expect(credential).toMatchObject({ kind: 'password', passwordHash: 'adaptive-password-hash' });
    expect(JSON.stringify(credential)).not.toContain('bootstrap admin password');
  });

  test('restart preserves an existing credential instead of replacing it from configuration', async () => {
    prisma.adminAccount.findUnique.mockResolvedValue({ adminId: 'admin-1' });
    await service.onModuleInit();
    expect(hasher.hash.calls.length).toBe(0);
    expect(prisma.adminCredential.create.calls.length).toBe(0);
  });

  test('successful and failed authentication use the stored adaptive hash', async () => {
    prisma.adminCredential.findFirst.mockResolvedValue({
      credentialId: 'credential-1',
      adminId: 'admin-1',
      passwordHash: 'stored-hash',
    });
    expect(await service.authenticate('candidate')).toBe('admin-1');
    hasher.verify.mockResolvedValue(false);
    expect(await service.authenticate('wrong')).toBeNull();
  });
});
