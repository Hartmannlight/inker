/**
 * Portable JSON snapshot → SQLite importer.
 *
 * Reads the db-export.json produced by writeSnapshot() (src/jobs/db-snapshot.ts) and replays
 * every table into SQLite with explicit ids, in foreign-key-safe order. After each table the
 * SQLite autoincrement counter is advanced past the imported max id so newly created rows
 * don't collide. The whole import runs in a single transaction: any failure rolls back to an
 * empty database so the boot can be retried cleanly.
 *
 * Used by the one-time boot migrator (prisma/migrate-to-sqlite.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { EXPORT_FILENAME, resolveExportDir } from './db-snapshot';

/**
 * [Prisma model, client delegate, SQLite table name] in FK-safe order (parents first).
 * MUST stay in sync with EXPORT_STEPS in src/jobs/db-snapshot.ts.
 */
const IMPORT_ORDER: ReadonlyArray<readonly [string, string, string]> = [
  ['Model', 'model', 'models'],
  ['Playlist', 'playlist', 'playlists'],
  ['Screen', 'screen', 'screens'],
  ['Device', 'device', 'devices'],
  ['DeviceLog', 'deviceLog', 'device_logs'],
  ['Extension', 'extension', 'extensions'],
  ['DataSource', 'dataSource', 'data_sources'],
  ['CustomWidget', 'customWidget', 'custom_widgets'],
  ['Firmware', 'firmware', 'firmware'],
  ['WidgetTemplate', 'widgetTemplate', 'widget_templates'],
  ['ScreenDesign', 'screenDesign', 'screen_designs'],
  ['ScreenWidget', 'screenWidget', 'screen_widgets'],
  ['DeviceScreenAssignment', 'deviceScreenAssignment', 'device_screen_assignments'],
  ['Setting', 'setting', 'settings'],
  ['BlockedDevice', 'blockedDevice', 'blocked_devices'],
  ['Plugin', 'plugin', 'plugins'],
  ['PluginInstance', 'pluginInstance', 'plugin_instances'],
  ['PlaylistItem', 'playlistItem', 'playlist_items'],
];

export interface ImportResult {
  total: number;
  counts: Record<string, number>;
}

/**
 * Import a db-export.json into the given (SQLite) Prisma client. Throws on a count mismatch,
 * rolling the transaction back. `prisma` is typed loosely because this glue runs outside the
 * compiled build and may receive either generated client.
 */
export async function importSnapshot(
  prisma: any,
  exportDir: string = resolveExportDir(),
): Promise<ImportResult> {
  const file = path.join(exportDir, EXPORT_FILENAME);
  if (!fs.existsSync(file)) {
    throw new Error(`Snapshot not found: ${file}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tables: Record<string, any[]> = snapshot.tables || {};
  const expectedCounts: Record<string, number> = snapshot.counts || {};
  const counts: Record<string, number> = {};

  await prisma.$transaction(
    async (tx: any) => {
      for (const [table, delegate, dbTable] of IMPORT_ORDER) {
        const rows = tables[table] || [];
        if (rows.length > 0) {
          await tx[delegate].createMany({ data: rows });
          // Advance the autoincrement counter past the imported max id. sqlite_sequence has
          // no row for a table until an autoincrement insert happens, and we insert explicit
          // ids — so set it manually (delete-then-insert is safe whether or not a row exists).
          await tx.$executeRawUnsafe(
            `DELETE FROM sqlite_sequence WHERE name = '${dbTable}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO sqlite_sequence(name, seq) SELECT '${dbTable}', MAX(id) FROM "${dbTable}"`,
          );
        }
        counts[table] = rows.length;
      }

      // Verify counts before committing — guards against any silent partial insert.
      for (const [table, delegate] of IMPORT_ORDER) {
        const actual = await tx[delegate].count();
        const expected = expectedCounts[table] ?? counts[table];
        if (actual !== expected) {
          throw new Error(
            `Count mismatch for ${table}: imported ${actual}, expected ${expected}`,
          );
        }
      }
    },
    { timeout: 120000, maxWait: 120000 },
  );

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, counts };
}

// Allow manual CLI use: `bun run prisma/import-db.ts`
if (import.meta.main) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const r = await importSnapshot(prisma);
    console.log(`[import-db] Imported ${r.total} rows into SQLite.`);
  } catch (err) {
    console.error('[import-db] Import failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
