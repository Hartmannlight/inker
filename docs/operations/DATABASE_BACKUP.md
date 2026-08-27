# SQLite migration, backup and restore

Inker stores its SQLite database at `/app/uploads/inker.db` and the instance
encryption key at `/app/secrets/instance.json`. These paths must use separate
persistent volumes. Schema changes are forward-only Prisma migrations and run
after the instance-secret startup check. A missing, malformed, or overly
permissive secret and a migration failure both keep `/ready` unavailable.

## Required backup before an upgrade

Create and verify a backup before installing an image that contains new
migrations.

Since WP-19, also include the private `/app/render-cache` (`render_data`) volume
in the stopped backup/restore set. Its hash files are referenced by SQLite and
must match that snapshot. See [render-cache operations](RENDER_CACHE.md) for
retention, corruption handling and the distinction between temporary files and
successfully published artifacts. The separate database/secret trust boundary
below is unchanged; the two original snapshots alone no longer include all pixels.

1. Stop the entire Inker container, including both API and worker, so no database
   or upload is changing. Stopping only the worker does not stop API writes.
2. Snapshot or archive the complete `/app/uploads` volume, not only `inker.db`.
3. Separately snapshot `/app/secrets`, preserving owner-only file permissions.
4. Record the non-secret `keyId` from `instance.json` with the backup inventory,
   but never copy the `encryptionKey` into logs, tickets, or backup labels.
5. Include the matching private render-cache snapshot in this restore set.
6. Keep all three snapshots until the upgraded container has started, `/ready` succeeds,
   and representative devices and screens have been checked.

Copying only `inker.db` while Inker is running is not a valid backup in WAL mode:
committed pages may still be in `inker.db-wal`. Use an SQLite online-backup tool
when downtime is impossible, or copy the database, `-wal` and `-shm` files as one
atomic storage snapshot. The complete uploads-volume backup is preferred because
it also keeps database references and uploaded artifacts consistent.

The three snapshots form one restore set. Copying only the SQLite file does not make
encrypted plugin, connector, or OAuth fields usable because the encryption key is
outside the database. Conversely, a secret backup without its matching database
is not a complete installation backup. Encrypt and access-control the secret
backup as a credential.

## Restore and rollback

1. Stop the container.
2. Preserve the failed volume separately for diagnosis.
3. Restore the complete pre-upgrade uploads snapshot into an empty data volume.
4. Restore the matching secret snapshot into an empty secret volume and preserve
   directory mode `0700` and file mode `0600` on Linux.
5. Confirm that `instance.json` still contains the expected `version` and `keyId`.
6. Restore the matching private render-cache snapshot into an empty render volume.
7. Start the last image version known to work with that restore set.
8. Confirm API `/ready` and the separate worker readiness, then check devices, playlists, screens and encrypted provider
   settings.

Do not edit `_prisma_migrations`, rerun a failed SQL statement manually or use
`prisma db push` against a production database. Prisma migrations are forward-only;
rollback means restoring the matching data backup and application image.

Do not create a new instance key when a database already exists. Normal startup
refuses this state because silently replacing the key would make encrypted values
unrecoverable. Multi-key rotation and automatic re-encryption are not implemented;
`version: 1` and `keyId` only prepare a future rotation workflow.

## Existing installations

The first migration ID is `20260824000000_inker_0_6_0_baseline`. On first start,
an unmanaged database is compared structurally with the known 0.6.0 and current
pre-migration schemas before any migration is recorded as applied. Exact 0.6.0
databases then receive `20260824001000_device_platform_schema`; databases already
updated by the former `db push` path adopt both history entries. Unknown drift is
rejected and must be investigated from a copy of the pre-upgrade backup.

Installations created before the separate secret volume need a controlled one-time
transition before normal startup. Back up the current installation, mount an empty
`/app/secrets` volume, explicitly run
`scripts/prepare-instance-secrets.ts --initialize-existing`, and then re-enter any
legacy encrypted plugin or OAuth settings. The command creates a random key and
never derives it from `ADMIN_PIN`; it does not recover ciphertext written with the
old fallback key.
