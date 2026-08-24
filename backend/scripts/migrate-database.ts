import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BASELINE_MIGRATION = "20260824000000_inker_0_6_0_baseline";
const DEVICE_PLATFORM_MIGRATION = "20260824001000_device_platform_schema";

const adoptionStates = [
  {
    description: "current pre-migration device-platform schema",
    migrations: [BASELINE_MIGRATION, DEVICE_PLATFORM_MIGRATION],
  },
  {
    description: "Inker 0.6.0 schema",
    migrations: [BASELINE_MIGRATION],
  },
] as const;

const backendRoot = resolve(import.meta.dir, "..");
const schemaPath = resolve(
  process.env.PRISMA_SCHEMA_PATH ??
    join(backendRoot, "prisma", "schema.prisma"),
);
const migrationsDirectory = join(dirname(schemaPath), "migrations");
const prismaCli = join(
  backendRoot,
  "node_modules",
  "prisma",
  "build",
  "index.js",
);
const nodeBinary = process.env.INKER_NODE_BINARY ?? "node";

function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(
      "WP-05 supports only the SQLite file: datasource from ADR-001",
    );
  }

  let rawPath = decodeURIComponent(
    databaseUrl.slice("file:".length).split("?")[0],
  );
  if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(rawPath)) {
    rawPath = rawPath.slice(1);
  }

  return isAbsolute(rawPath) ? rawPath : resolve(dirname(schemaPath), rawPath);
}

function sqliteUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

async function runPrisma(
  args: string[],
  quiet = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn({
    cmd: [nodeBinary, prismaCli, ...args],
    cwd: backendRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (!quiet || exitCode === 1) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  return { exitCode, stdout, stderr };
}

function readApplicationTables(databasePath: string): string[] {
  if (!existsSync(databasePath)) return [];

  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map(({ name }) => name);
  } finally {
    database.close();
  }
}

function createReferenceDatabase(migrations: readonly string[]): {
  directory: string;
  databaseUrl: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "inker-migration-reference-"));
  const databasePath = join(directory, "reference.db");
  const database = new Database(databasePath, { create: true, strict: true });

  try {
    for (const migration of migrations) {
      const sqlPath = join(migrationsDirectory, migration, "migration.sql");
      database.exec(readFileSync(sqlPath, "utf8"));
    }
  } finally {
    database.close();
  }

  return { directory, databaseUrl: sqliteUrl(databasePath) };
}

async function adoptExistingDatabase(databaseUrl: string): Promise<void> {
  for (const state of adoptionStates) {
    const reference = createReferenceDatabase(state.migrations);
    try {
      const comparison = await runPrisma(
        [
          "migrate",
          "diff",
          "--exit-code",
          "--from-url",
          databaseUrl,
          "--to-url",
          reference.databaseUrl,
        ],
        true,
      );

      if (comparison.exitCode === 2) continue;
      if (comparison.exitCode !== 0) {
        throw new Error(
          `Could not verify the existing database (${comparison.exitCode})`,
        );
      }

      console.log(
        `[database] Verified ${state.description}; recording migration history.`,
      );
      for (const migration of state.migrations) {
        const resolved = await runPrisma([
          "migrate",
          "resolve",
          "--applied",
          migration,
          "--schema",
          schemaPath,
        ]);
        if (resolved.exitCode !== 0) {
          throw new Error(`Could not record baseline migration ${migration}`);
        }
      }
      return;
    } finally {
      rmSync(reference.directory, { recursive: true, force: true });
    }
  }

  throw new Error(
    "Existing SQLite schema does not match a supported Inker baseline. " +
      "Restore the pre-upgrade backup and follow docs/operations/DATABASE_BACKUP.md.",
  );
}

function configureSQLite(databasePath: string): void {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    const journalMode = database
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
      .get();
    if (journalMode?.journal_mode.toLowerCase() !== "wal") {
      throw new Error(
        `SQLite refused WAL mode (${journalMode?.journal_mode ?? "unknown"})`,
      );
    }

    database.exec("PRAGMA busy_timeout = 5000");
    const timeout = database
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get();
    if (timeout?.timeout !== 5000) {
      throw new Error(
        `SQLite refused busy_timeout=5000 (${timeout?.timeout ?? "unknown"})`,
      );
    }

    const foreignKeyErrors = database.query("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length > 0) {
      throw new Error(
        `SQLite foreign-key check found ${foreignKeyErrors.length} violation(s)`,
      );
    }
  } finally {
    database.close();
  }
}

function ensureSQLiteFile(databasePath: string): void {
  if (existsSync(databasePath)) return;
  mkdirSync(dirname(databasePath), { recursive: true });
  closeSync(openSync(databasePath, "a"));
}

export async function migrateDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const databasePath = databasePathFromUrl(databaseUrl);
  // Prisma's Windows schema engine cannot reliably create a missing SQLite
  // file in every supported path. Creating the empty file is equivalent to
  // SQLite's normal first connection and keeps fresh installs deterministic.
  ensureSQLiteFile(databasePath);
  const tables = readApplicationTables(databasePath);

  if (tables.length > 0 && !tables.includes("_prisma_migrations")) {
    await adoptExistingDatabase(databaseUrl);
  }

  console.log("[database] Applying versioned Prisma migrations...");
  const deployment = await runPrisma([
    "migrate",
    "deploy",
    "--schema",
    schemaPath,
  ]);
  if (deployment.exitCode !== 0) {
    throw new Error(`prisma migrate deploy failed (${deployment.exitCode})`);
  }

  configureSQLite(databasePath);
  console.log(
    "[database] Migrations applied; SQLite WAL and busy_timeout=5000 verified.",
  );
}

if (import.meta.main) {
  migrateDatabase().catch((error) => {
    console.error(
      `[database] Fatal migration error: ${(error as Error).message}`,
    );
    process.exit(1);
  });
}
