# SQLite migration, backup and restore

Inker stores its SQLite database at `/app/uploads/inker.db`. Schema changes are
forward-only Prisma migrations and run before the backend starts. A migration
failure therefore keeps `/ready` unavailable instead of starting against a
partially upgraded database.

## Required backup before an upgrade

Create and verify a backup before installing an image that contains new
migrations.

1. Stop the Inker container so no database or upload is changing.
2. Snapshot or archive the complete `/app/uploads` volume, not only `inker.db`.
3. Keep the snapshot until the upgraded container has started, `/ready` succeeds,
   and representative devices and screens have been checked.

Copying only `inker.db` while Inker is running is not a valid backup in WAL mode:
committed pages may still be in `inker.db-wal`. Use an SQLite online-backup tool
when downtime is impossible, or copy the database, `-wal` and `-shm` files as one
atomic storage snapshot. The complete uploads-volume backup is preferred because
it also keeps database references and uploaded artifacts consistent.

## Restore and rollback

1. Stop the container.
2. Preserve the failed volume separately for diagnosis.
3. Restore the complete pre-upgrade uploads snapshot into an empty volume.
4. Start the last image version known to work with that snapshot.
5. Confirm `/ready`, then check devices, playlists, screens and settings.

Do not edit `_prisma_migrations`, rerun a failed SQL statement manually or use
`prisma db push` against a production database. Prisma migrations are forward-only;
rollback means restoring the matching data backup and application image.

## Existing installations

The first migration ID is `20260824000000_inker_0_6_0_baseline`. On first start,
an unmanaged database is compared structurally with the known 0.6.0 and current
pre-migration schemas before any migration is recorded as applied. Exact 0.6.0
databases then receive `20260824001000_device_platform_schema`; databases already
updated by the former `db push` path adopt both history entries. Unknown drift is
rejected and must be investigated from a copy of the pre-upgrade backup.
