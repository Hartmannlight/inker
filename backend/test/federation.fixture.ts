import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShareCredentialService } from '../src/federation/share-credential.service';
import { FederationIdentityService } from '../src/federation/federation-identity.service';

const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.from(chunk);
  length += bytes.length;
  if (length > 4096) throw new Error('Federation fixture input too large');
  chunks.push(bytes);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url: string; publicationId: string };
const prisma = new PrismaClient({ datasources: { db: { url: input.url } } });
try {
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  const identity = new FederationIdentityService(prisma as PrismaService);
  await identity.onModuleInit();
  const serverId = await identity.serverId();
  try {
    const created = await new ShareCredentialService(prisma as PrismaService).create(input.publicationId, {}, 'fixture-admin');
    process.stdout.write(JSON.stringify({ serverId, credentialId: created.credentialId }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ serverId, error: (error as Error).message,
      status: (error as { getStatus(): number }).getStatus() }));
  }
} finally { await prisma.$disconnect(); }
