/**
 * Database → portable JSON export (manual CLI entrypoint).
 *
 * Thin wrapper around writeSnapshot() that dumps the current database (whatever DATABASE_URL
 * points at) to db-export.json — handy as a manual backup or to inspect contents.
 *
 * Read-only: never modifies the source database. Safe to run anytime.
 */
import { PrismaClient } from '@prisma/client';
import { writeSnapshot, resolveExportDir } from './db-snapshot';

const prisma = new PrismaClient();

writeSnapshot(prisma, resolveExportDir())
  .then((r) => {
    console.log(`[db-export] Wrote ${r.total} rows to ${r.path}`);
  })
  .catch((err) => {
    console.error('[db-export] Export failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
