import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  test('WP-20 startup seed is repeatable and preserves existing configuration', async () => {
    const databasePath = join(createTemporaryDirectory(), 'wp20-seed.db');
    expect((await deploy(databasePath)).exitCode).toBe(0);
    async function seed() {
      const child = Bun.spawn({ cmd: [process.execPath, 'prisma/seed.ts'], cwd: backendRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl(databasePath) }, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, out + err).toBe(0);
      expect(out + err).not.toContain('Default PIN: 1111');
    }
    await seed();
    const database = new Database(databasePath);
    try {
      database.exec("UPDATE device_profiles SET label='Custom profile' WHERE profile_id='browser-hd-1920x1080'");
      database.exec("UPDATE delivery_policies SET definition='{}' WHERE policy_id='reference-connected-browser'");
      database.exec("UPDATE widget_templates SET label='Custom template' WHERE name='daysuntil'");
    } finally { database.close(); }
    await seed();
    const result = inspect(databasePath);
    try {
      expect(result.query("SELECT label FROM device_profiles WHERE profile_id='browser-hd-1920x1080'").get()).toEqual({ label: 'Custom profile' });
      expect(result.query("SELECT definition FROM delivery_policies WHERE policy_id='reference-connected-browser'").get()).toEqual({ definition: '{}' });
      expect(result.query("SELECT label FROM widget_templates WHERE name='daysuntil'").get()).toEqual({ label: 'Custom template' });
    } finally { result.close(); }
  }, 30_000);

  test('WP-19 preserves assigned state and adds empty immutable render storage', async () => {
    const databasePath = join(createTemporaryDirectory(), 'wp19-upgrade.db');
    const migrations = join(prismaDirectory, 'migrations');
    const latest = '20260830000000_render_cache';
    applySql(databasePath, readdirSync(migrations).filter(name => name < latest && name.startsWith('20')).sort().map(name => join(migrations, name, 'migration.sql')));
    const database = new Database(databasePath);
    try {
      database.exec(`INSERT INTO devices(id,label,external_id,profile_id,delivery_policy_id,presentation_revision,updated_at)
        VALUES(10,'render-upgrade','render-upgrade','browser-hd-1920x1080','reference-connected-browser',42,CURRENT_TIMESTAMP);
        INSERT INTO publications(publication_id,publication_key) VALUES('publication','render-upgrade');
        INSERT INTO publication_revisions(publication_revision_id,publication_id,revision,protocol_version,content,content_hash)
          VALUES('revision','publication',1,'1.0','{}','legacy-hash');
        INSERT INTO device_publication_states(device_id,desired_publication_revision_id,desired_sequence,updated_at)
          VALUES(10,'revision',42,CURRENT_TIMESTAMP);`);
      const desired = database.query('SELECT * FROM device_publication_states').all();
      database.exec(readFileSync(join(migrations, latest, 'migration.sql'), 'utf8'));
      expect(database.query('SELECT * FROM device_publication_states').all()).toEqual(desired);
      expect(database.query('SELECT presentation_revision, render_revision FROM devices').get()).toEqual({ presentation_revision: 42, render_revision: 0 });
      expect(database.query('SELECT * FROM render_requests').all()).toEqual([]);
      expect(database.query('SELECT * FROM render_bindings').all()).toEqual([]);
      database.exec(`INSERT INTO render_requests(key,publication_revision_id,target,renderer_version) VALUES('${'a'.repeat(64)}','revision','{}','test');`);
      expect(() => database.exec("UPDATE render_requests SET target = '{\"changed\":true}'")).toThrow('immutable');
      expect(() => database.exec("UPDATE render_requests SET artifact_hash = 'bad'")).toThrow();
      expect(() => database.exec(`UPDATE render_requests SET artifact_hash = '${'b'.repeat(64)}'`)).toThrow();
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { database.close(); }
    const comparison = await compareWithDatamodel(databasePath);
    expect(comparison.exitCode, comparison.output).toBe(0);
  });
  test('WP-18 upgrades WP-17 without adopting drafts or changing desired state, credentials or outbox', async () => {
    const databasePath = join(createTemporaryDirectory(), 'wp18-upgrade.db');
    const migrations = join(prismaDirectory, 'migrations');
    const latest = '20260829000000_playlist_playback';
    applySql(databasePath, readdirSync(migrations).filter(name => name < latest && name.startsWith('20')).sort().map(name => join(migrations, name, 'migration.sql')));
    const database = new Database(databasePath);
    try {
      database.exec(`
        INSERT INTO devices(id,label,external_id,profile_id,delivery_policy_id,presentation_revision,updated_at)
          VALUES(10,'upgrade','upgrade','browser-hd-1920x1080','reference-connected-browser',42,CURRENT_TIMESTAMP);
        INSERT INTO publications(publication_id,publication_key) VALUES('publication','upgrade');
        INSERT INTO publication_revisions(publication_revision_id,publication_id,revision,protocol_version,content,content_hash)
          VALUES('revision','publication',1,'1.0','{"fixtureArtifacts":["mono-800x480-white-png"]}','legacy-hash');
        INSERT INTO device_publication_states(device_id,desired_publication_revision_id,desired_sequence,updated_at)
          VALUES(10,'revision',42,CURRENT_TIMESTAMP);
        INSERT INTO playlists(id,name,updated_at) VALUES(1,'draft',CURRENT_TIMESTAMP);
      `);
      const desired = database.query('SELECT * FROM device_publication_states').all();
      const devices = database.query('SELECT * FROM devices').all();
      database.exec(readFileSync(join(migrations, latest, 'migration.sql'), 'utf8'));
      expect(database.query('SELECT * FROM device_publication_states').all()).toEqual(desired);
      expect(database.query('SELECT * FROM devices').all()).toEqual(devices);
      expect(database.query('SELECT * FROM playback_states').all()).toEqual([]);
      expect(database.query('SELECT * FROM published_playlists').all()).toEqual([]);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { database.close(); }
    // Historical WP-18 assertions above remain against its exact migration.
    // Compare the current schema only after subsequent forward migrations.
    applySql(databasePath, readdirSync(migrations).filter(name => name > latest && name.startsWith('20')).sort().map(name => join(migrations, name, 'migration.sql')));
    const comparison = await compareWithDatamodel(databasePath);
    expect(comparison.exitCode, comparison.output).toBe(0);
  });
  test('WP-17 preserves published state and delivery identity while invalidating only legacy retry snapshots', async () => {
    const databasePath = join(createTemporaryDirectory(), 'wp17-upgrade.db');
    const migrations = join(prismaDirectory, 'migrations');
    const latest = '20260828000000_explicit_publications';
    applySql(databasePath, readdirSync(migrations).filter(name => name < latest && name.startsWith('20')).sort().map(name => join(migrations, name, 'migration.sql')));
    const database = new Database(databasePath);
    try {
      database.exec(`
        INSERT INTO devices(id,label,external_id,profile_id,delivery_policy_id,presentation_revision,updated_at)
          VALUES(10,'upgrade','upgrade','browser-hd-1920x1080','reference-connected-browser',42,CURRENT_TIMESTAMP);
        INSERT INTO publications(publication_id,publication_key) VALUES('publication','upgrade');
        INSERT INTO publication_revisions(publication_revision_id,publication_id,revision,protocol_version,content,content_hash)
          VALUES('revision','publication',1,'1.0','{"fixtureArtifacts":["mono-800x480-white-png"]}','legacy-hash');
        INSERT INTO device_publication_states(device_id,desired_publication_revision_id,acknowledged_publication_revision_id,updated_at)
          VALUES(10,'revision','revision',CURRENT_TIMESTAMP);
        INSERT INTO outbox_effects(key,event_id) VALUES('effect','event');
        INSERT INTO outbox_deliveries(delivery_id,effect_key,device_id,presentation)
          VALUES('delivery','effect',10,'{"revision":42,"content":{"url":"/api/device-images/design/1"}}');
      `);
      database.exec(readFileSync(join(migrations, latest, 'migration.sql'), 'utf8'));
      expect(database.query('SELECT desired_publication_revision_id, acknowledged_publication_revision_id, desired_sequence FROM device_publication_states').get()).toEqual({
        desired_publication_revision_id: 'revision', acknowledged_publication_revision_id: 'revision', desired_sequence: 42,
      });
      expect(database.query('SELECT delivery_id, effect_key, presentation FROM outbox_deliveries').get()).toEqual({ delivery_id: 'delivery', effect_key: 'effect', presentation: null });
      expect(database.query('SELECT content_hash FROM publication_revisions').get()).toEqual({ content_hash: 'legacy-hash' });
      expect(database.query('SELECT * FROM publication_commands').all()).toEqual([]);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { database.close(); }
    // Compare the latest datamodel only after applying later forward migrations.
    applySql(databasePath, readdirSync(migrations).filter(name => name > latest && name.startsWith('20')).sort().map(name => join(migrations, name, 'migration.sql')));
    const comparison = await compareWithDatamodel(databasePath);
    expect(comparison.exitCode, comparison.output).toBe(0);
  });
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
        "20260825000000_admin_credentials_sessions",
        "20260827000000_outbox_dispatch",
        "20260828000000_explicit_publications",
        "20260829000000_playlist_playback",
        "20260830000000_render_cache",
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
      const adminTables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name);
      expect(adminTables).toEqual([
        "admin_accounts",
        "admin_credentials",
        "admin_sessions",
      ]);
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
