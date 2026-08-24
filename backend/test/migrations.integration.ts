import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const backendRoot = resolve(import.meta.dir, "..");
const prismaDirectory = join(backendRoot, "prisma");
const migrationScript = join(backendRoot, "scripts", "migrate-database.ts");
const createdDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inker-migration-test-"));
  createdDirectories.push(directory);
  return directory;
}

function databaseUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function applySql(databasePath: string, sqlPaths: string[]): void {
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    for (const sqlPath of sqlPaths) {
      database.exec(readFileSync(sqlPath, "utf8"));
    }
  } finally {
    database.close();
  }
}

async function deploy(
  databasePath: string,
  schemaPath = join(prismaDirectory, "schema.prisma"),
): Promise<{ exitCode: number; output: string }> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, migrationScript],
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(databasePath),
      PRISMA_SCHEMA_PATH: schemaPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

async function compareWithDatamodel(databasePath: string): Promise<{
  exitCode: number;
  output: string;
}> {
  const subprocess = Bun.spawn({
    cmd: [
      "node",
      join(backendRoot, "node_modules", "prisma", "build", "index.js"),
      "migrate",
      "diff",
      "--exit-code",
      "--from-url",
      databaseUrl(databasePath),
      "--to-schema-datamodel",
      join(prismaDirectory, "schema.prisma"),
    ],
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
  return { exitCode, output: stdout + stderr };
}

function inspect(databasePath: string) {
  return new Database(databasePath, { readonly: true, strict: true });
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Prisma migration baseline", () => {
  test("installs a fresh database and is idempotent on restart", async () => {
    const databasePath = join(createTemporaryDirectory(), "fresh.db");

    const firstRun = await deploy(databasePath);
    const secondRun = await deploy(databasePath);

    expect(firstRun.exitCode, firstRun.output).toBe(0);
    expect(secondRun.exitCode, secondRun.output).toBe(0);
    const schemaComparison = await compareWithDatamodel(databasePath);
    expect(schemaComparison.exitCode, schemaComparison.output).toBe(0);

    const database = inspect(databasePath);
    try {
      const migrations = database
        .query<
          { migration_name: string },
          []
        >("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name")
        .all();
      expect(migrations.map(({ migration_name }) => migration_name)).toEqual([
        "20260824000000_inker_0_6_0_baseline",
        "20260824001000_device_platform_schema",
        "20260824002000_normalize_device_profiles_credentials",
        "20260824003000_publication_outbox_state",
        "20260824004000_device_enrollments",
      ]);
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM device_profiles").get()?.count,
      ).toBe(3);
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM delivery_policies").get()?.count,
      ).toBe(4);
      expect(
        database
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM publications")
          .get()?.count,
      ).toBe(0);
      const publicationIndexes = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('publication_revisions', 'outbox_events') ORDER BY name",
        )
        .all()
        .map(({ name }) => name);
      expect(publicationIndexes).toContain(
        "publication_revisions_publication_id_revision_key",
      );
      expect(publicationIndexes).toContain(
        "outbox_events_status_available_at_idx",
      );
      expect(
        database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'device_enrollments'",
        ).get()?.count,
      ).toBe(1);
      expect(
        database.query<{ name: string }, []>(
          "PRAGMA table_info('device_enrollments')",
        ).all().map(({ name }) => name),
      ).toEqual([
        'enrollment_id',
        'device_id',
        'code_hash',
        'expires_at',
        'used_at',
        'attempt_count',
        'created_at',
      ]);
      expect(
        database
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('publications_prevent_update', 'publication_revisions_prevent_update')")
          .get()?.count,
      ).toBe(2);
      expect(
        database
          .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
          .get()?.journal_mode,
      ).toBe("wal");
    } finally {
      database.close();
    }
  }, 30_000);

  test("upgrades an anonymized 0.6.0 database without losing data", async () => {
    const databasePath = join(createTemporaryDirectory(), "upgrade.db");
    applySql(databasePath, [
      join(
        prismaDirectory,
        "migrations",
        "20260824000000_inker_0_6_0_baseline",
        "migration.sql",
      ),
      join(import.meta.dir, "fixtures", "inker-0.6.0-data.sql"),
    ]);

    const result = await deploy(databasePath);
    expect(result.exitCode, result.output).toBe(0);

    const database = inspect(databasePath);
    try {
      const device = database
        .query<
          {
            label: string;
            device_type: string;
            transport: string;
            mac_address: string;
            profile_id: string;
            delivery_policy_id: string;
          },
          []
        >(
          "SELECT label, device_type, transport, mac_address, profile_id, delivery_policy_id FROM devices WHERE id = 1",
        )
        .get();
      expect(device).toEqual({
        label: "Fixture Device",
        device_type: "trmnl",
        transport: "pull",
        mac_address: "02:00:00:00:00:01",
        profile_id: "trmnl-byod-7.5-mono",
        delivery_policy_id: "reference-sleepy",
      });
      expect(
        database.query<{ format: string; bit_depth: number }, []>(
          "SELECT json_extract(capabilities_override, '$.display.renderFormats[0]') AS format, json_extract(capabilities_override, '$.display.bitDepth') AS bit_depth FROM devices WHERE id = 1",
        ).get(),
      ).toEqual({ format: "png", bit_depth: 1 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  }, 30_000);

  test("adopts an anonymized current db-push database without replaying DDL", async () => {
    const databasePath = join(createTemporaryDirectory(), "adopt-current.db");
    applySql(databasePath, [
      join(
        prismaDirectory,
        "migrations",
        "20260824000000_inker_0_6_0_baseline",
        "migration.sql",
      ),
      join(
        prismaDirectory,
        "migrations",
        "20260824001000_device_platform_schema",
        "migration.sql",
      ),
      join(import.meta.dir, "fixtures", "inker-0.6.0-data.sql"),
      join(import.meta.dir, "fixtures", "device-platform-data.sql"),
    ]);

    const result = await deploy(databasePath);
    expect(result.exitCode, result.output).toBe(0);

    const database = inspect(databasePath);
    try {
      expect(
        database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM devices")
          .get()?.count,
      ).toBe(2);
      expect(
        database
          .query<
            { credential_id: string; token_hash: string },
            []
          >("SELECT credential_id, token_hash FROM device_credentials")
          .get(),
      ).toEqual({
        credential_id: "legacy-00000001",
        token_hash: "fixture-sha256-hash-not-a-credential",
      });
      expect(
        database.query<{ profile_id: string; width: number; height: number }, []>(
          "SELECT profile_id, json_extract(capabilities_override, '$.display.width') AS width, json_extract(capabilities_override, '$.display.height') AS height FROM devices WHERE id = 2",
        ).get(),
      ).toEqual({ profile_id: "browser-hd-1920x1080", width: 1280, height: 720 });
    } finally {
      database.close();
    }
  }, 30_000);

  test("returns a failure when a migration is invalid", async () => {
    const directory = createTemporaryDirectory();
    const isolatedPrisma = join(directory, "prisma");
    cpSync(prismaDirectory, isolatedPrisma, { recursive: true });
    const brokenMigration = join(
      isolatedPrisma,
      "migrations",
      "20260824003000_broken_test",
    );
    mkdirSync(brokenMigration);
    writeFileSync(
      join(brokenMigration, "migration.sql"),
      "THIS IS NOT VALID SQL;\n",
    );

    const result = await deploy(
      join(directory, "broken.db"),
      join(isolatedPrisma, "schema.prisma"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Fatal migration error");
  }, 30_000);
});
