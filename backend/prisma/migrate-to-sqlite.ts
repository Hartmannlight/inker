/**
 * One-time PostgreSQL → SQLite boot migrator.
 *
 * Runs once, before the app starts, after `prisma db push` has created the (empty) SQLite
 * schema. Decides between three outcomes and is idempotent via a marker file:
 *
 *   1. Already migrated (marker present) → no-op.
 *   2. Existing PostgreSQL data found    → export it (writeSnapshot) and import into SQLite.
 *   3. No/empty/unreachable PostgreSQL   → fresh install: seed default data.
 *
 * The legacy PostgreSQL database is only ever read — never modified — so a failed run can be
 * retried by deleting the SQLite file. The Postgres-bound Prisma client is generated from
 * schema.postgres.prisma into node_modules/.prisma/client-postgres and lazy-loaded only when
 * a migration is actually attempted, so fresh installs never need it.
 *
 * Remove this script (and schema.postgres.prisma) in 0.6.0 once Postgres is gone.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { writeSnapshot, resolveExportDir } from './db-snapshot';
import { importSnapshot } from './import-db';

const MARKER_FILENAME = '.migrated';

const PG_CLIENT_PATH = '../node_modules/.prisma/client-postgres';

// Delegates to sum when deciding whether the source DB holds data. Per-table failures (e.g.
// "relation does not exist" on a never-initialized Postgres) are treated as zero.
const COUNT_DELEGATES = [
  'model', 'playlist', 'screen', 'device', 'deviceLog', 'extension', 'dataSource',
  'customWidget', 'firmware', 'widgetTemplate', 'screenDesign', 'screenWidget',
  'deviceScreenAssignment', 'setting', 'blockedDevice', 'plugin', 'pluginInstance',
  'playlistItem',
];

async function countAllRows(client: any): Promise<number> {
  let total = 0;
  for (const delegate of COUNT_DELEGATES) {
    try {
      total += await client[delegate].count();
    } catch {
      // Table absent on the source — ignore.
    }
  }
  return total;
}

async function main(): Promise<void> {
  const exportDir = resolveExportDir();
  const markerPath = path.join(exportDir, MARKER_FILENAME);

  if (fs.existsSync(markerPath)) {
    console.log('[migrate] SQLite already initialized — skipping migration.');
    return;
  }

  const sqlite = new PrismaClient();
  let migrated = false;

  try {
    // WAL persists in the DB file header; setting it once on first init is enough.
    // PRAGMA journal_mode returns the new mode as a row, so use the query variant
    // ($executeRawUnsafe rejects statements that return results on SQLite).
    await sqlite.$queryRawUnsafe('PRAGMA journal_mode=WAL');

    const pgUrl = process.env.POSTGRES_URL;

    if (pgUrl) {
      // Load the Postgres-read client. If POSTGRES_URL is set but the client is missing,
      // that's a build/deploy bug — fail loudly rather than silently seeding over real data.
      let mod: any;
      try {
        mod = await import(PG_CLIENT_PATH);
      } catch (err) {
        throw new Error(
          `POSTGRES_URL is set but the Postgres migration client is missing ` +
            `(${(err as Error).message}). Aborting to avoid seeding over existing data.`,
        );
      }

      const pg: any = new mod.PrismaClient();
      let total = 0;
      // A connection failure here is non-fatal (treated as a fresh install).
      try {
        total = await countAllRows(pg);
      } catch (err) {
        console.warn(
          `[migrate] PostgreSQL unreachable (${(err as Error).message}) — treating as fresh install.`,
        );
      }

      if (total > 0) {
        // Data found — import. A failure here is FATAL: we must NOT fall back to seeding and
        // mark the DB "migrated", which would silently drop the user's data. The error
        // propagates, no marker is written, and the next boot retries cleanly.
        console.log(`[migrate] Found ${total} rows in PostgreSQL — exporting…`);
        try {
          await writeSnapshot(pg as any, exportDir);
          console.log('[migrate] Importing snapshot into SQLite…');
          const r = await importSnapshot(sqlite, exportDir);
          console.log(`[migrate] Imported ${r.total} rows into SQLite.`);
          migrated = true;
        } finally {
          await pg.$disconnect().catch(() => undefined);
        }
      } else {
        console.log('[migrate] PostgreSQL reachable but empty — fresh install.');
        await pg.$disconnect().catch(() => undefined);
      }
    } else {
      console.log('[migrate] POSTGRES_URL not set — fresh SQLite install.');
    }

    if (!migrated) {
      console.log('[migrate] Seeding fresh SQLite database…');
      execSync('bun run prisma/seed.ts', { stdio: 'inherit', cwd: process.cwd() });
    }

    // Record success so subsequent boots skip straight to the app.
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString());
    console.log('[migrate] Database ready (SQLite).');
  } finally {
    await sqlite.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[migrate] Fatal migration error:', err);
  process.exit(1);
});
