/**
 * Portable database snapshot writer.
 *
 * Reads every table via Prisma and writes a single JSON file to the persisted uploads
 * volume (default: uploads/.migration/db-export.json). This is the intermediate artifact the
 * one-time PostgreSQL → SQLite migrator imports — no database binaries needed to consume it.
 *
 * Used by prisma/migrate-to-sqlite.ts (reading the legacy Postgres client) and the standalone
 * prisma/export-db.ts CLI. Read-only: never modifies the source database.
 */
import type { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// Current export format version. Bump if the shape changes.
export const EXPORT_VERSION = 1;

export const EXPORT_FILENAME = 'db-export.json';

/** Directory the snapshot is written to (overridable via DB_EXPORT_DIR). */
export function resolveExportDir(): string {
  return (
    process.env.DB_EXPORT_DIR || path.join(process.cwd(), 'uploads', '.migration')
  );
}

/**
 * Tables in foreign-key-safe order (parents before children). The import replays them in
 * this same order so referential integrity always holds.
 */
function exportSteps(
  prisma: PrismaClient,
): { table: string; read: () => Promise<unknown[]> }[] {
  return [
    { table: 'Model', read: () => prisma.model.findMany() },
    { table: 'Playlist', read: () => prisma.playlist.findMany() },
    { table: 'Screen', read: () => prisma.screen.findMany() },
    { table: 'Device', read: () => prisma.device.findMany() },
    { table: 'DeviceLog', read: () => prisma.deviceLog.findMany() },
    { table: 'Extension', read: () => prisma.extension.findMany() },
    { table: 'DataSource', read: () => prisma.dataSource.findMany() },
    { table: 'CustomWidget', read: () => prisma.customWidget.findMany() },
    { table: 'Firmware', read: () => prisma.firmware.findMany() },
    { table: 'WidgetTemplate', read: () => prisma.widgetTemplate.findMany() },
    { table: 'ScreenDesign', read: () => prisma.screenDesign.findMany() },
    { table: 'ScreenWidget', read: () => prisma.screenWidget.findMany() },
    {
      table: 'DeviceScreenAssignment',
      read: () => prisma.deviceScreenAssignment.findMany(),
    },
    { table: 'Setting', read: () => prisma.setting.findMany() },
    { table: 'BlockedDevice', read: () => prisma.blockedDevice.findMany() },
    { table: 'Plugin', read: () => prisma.plugin.findMany() },
    { table: 'PluginInstance', read: () => prisma.pluginInstance.findMany() },
    { table: 'PlaylistItem', read: () => prisma.playlistItem.findMany() },
  ];
}

export interface SnapshotResult {
  path: string;
  total: number;
  counts: Record<string, number>;
}

/**
 * Read all tables and atomically write the snapshot JSON. Date fields serialize to ISO
 * strings; Json columns serialize as nested JSON. Returns row counts and the file path.
 */
export async function writeSnapshot(
  prisma: PrismaClient,
  exportDir: string = resolveExportDir(),
): Promise<SnapshotResult> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const step of exportSteps(prisma)) {
    const rows = await step.read();
    tables[step.table] = rows;
    counts[step.table] = rows.length;
  }

  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    tables,
  };

  fs.mkdirSync(exportDir, { recursive: true });

  // Atomic write: serialize to a temp file in the same dir, then rename.
  const exportPath = path.join(exportDir, EXPORT_FILENAME);
  const tmpPath = `${exportPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, exportPath);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { path: exportPath, total, counts };
}
