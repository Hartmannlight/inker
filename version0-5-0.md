# Inker v0.5.0

**Theme:** Migrate from bundled PostgreSQL to a single-file **SQLite** database — in one release,
with automatic data migration and no data loss.

Inker previously stored everything in a bundled PostgreSQL 17 cluster. 0.5.0 switches the runtime
to a single SQLite file on the uploads volume (`/app/uploads/inker.db`). On first launch it
**automatically migrates any existing PostgreSQL data into SQLite**, then runs entirely on SQLite.
Existing users upgrade once and keep all their data — no special ordering, no manual steps.

> The migration was originally planned as two releases (0.5.0 prep on Postgres, 0.6.0 switch). It
> was collapsed into a single 0.5.0 once it was clear Prisma 6 + SQLite are compatible and only two
> small schema/query issues needed fixing. **0.6.0 is now just image cleanup** (removing the now-idle
> bundled PostgreSQL).

---

## What's in 0.5.0

### 1. SQLite runtime
- `schema.prisma` switched to `provider = "sqlite"`; runtime `DATABASE_URL=file:/app/uploads/inker.db`
  with WAL journaling.
- Prisma 6.19.3 (the Json-on-SQLite support floor is 6.2).

### 2. Automatic, zero-loss data migration
On first boot, a one-time migrator (`prisma/migrate-to-sqlite.ts`) runs before the app starts:
- **Existing PostgreSQL data found** → exported and imported into SQLite (explicit ids,
  foreign-key-safe order, autoincrement counters advanced, row counts verified). The legacy
  database is only ever **read**, never modified, so the upgrade is safe to retry or roll back.
- **No/empty/unreachable PostgreSQL** → fresh install: default data is seeded.
- Idempotent via a marker file; subsequent boots go straight to the app.
- Reads the old database through a separate, Postgres-bound Prisma client generated from
  `schema.postgres.prisma` — used only during migration.
- **External Postgres:** set `EXTERNAL_POSTGRES=true` and `POSTGRES_URL` (or keep your existing
  `DATABASE_URL`); it's read once, then unused.

### 3. SQLite compatibility fixes
- Dropped the database-level `Json @default("{}")` on `CustomWidget.config`,
  `PluginInstance.settings`, and `PluginInstance.settingsEncrypted` (SQLite rejects the unquoted
  default at table creation). Behavior is unchanged — these values are always provided in app code.
- Rewrote the custom-widget cascade cleanup to filter `config.customWidgetId` in application code
  instead of via a Prisma JSON-path query (JSON filtering isn't supported on SQLite).

### 4. Housekeeping
- Removed the continuous DB-snapshot background service (its only purpose was bridging the old
  two-release plan).
- Docker image keeps bundled PostgreSQL 17 **for this release only**, as the migration source.
- `docker-compose.dev.yml` now runs on SQLite (no separate Postgres container).

---

## Upgrade notes (for users)

- **Just pull 0.5.0.** Your existing data migrates automatically on first launch; the app then runs
  on SQLite. Your old PostgreSQL volume is left untouched (safe rollback).
- Migrating from an external Postgres? Set `EXTERNAL_POSTGRES=true` and point `POSTGRES_URL` at it.

---

## Verification

- ✅ `prisma db push` against SQLite creates all tables (no `P1012`, no `DEFAULT {}` error).
- ✅ Export → import round-trip: row counts match and autoincrement continues past imported ids.
- ✅ Backend tests **394 pass**, frontend tests **19 pass**, `nest build` succeeds.

## Deferred to 0.6.0
Remove bundled PostgreSQL (and Redis) from the image, the s6 Postgres service, the Postgres-read
schema/client, and the migrator. Pure cleanup — no data logic.
