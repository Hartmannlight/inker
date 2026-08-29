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

WP-21 adds source definitions, separately encrypted secrets, immutable snapshots
and durable refresh metadata to the same SQLite file. Preserve these with outbox,
publication and render state; no additional volume is needed. Restore checks
must also compare snapshot identities/hashes and verify a controlled refresh
with the matching instance key. See [source operations](SOURCE_OPERATIONS.md).

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

Installations created before the separate secret volume need an explicitly
authorized one-time transition before normal startup. This exception is **not** a
recovery procedure for a lost instance key in a newer installation. Restore that
installation's matching key backup instead; no key rotation is performed here.

Use the following POSIX-shell example only after confirming this is a legacy
installation. Replace every angle-bracket placeholder with a verified value.
First stop its entire container (API, worker and Redis), then create and verify the
stopped backup described above before running the initialization command:

```sh
set -e
docker stop --time 35 '<EXISTING_CONTAINER>'
docker inspect --format '{{range .Mounts}}{{println .Destination .Name}}{{end}}' '<EXISTING_CONTAINER>'
```

The inspection prints mount names, not secret contents. `<EXISTING_UPLOAD_VOLUME>`
must be that container's named volume mounted at `/app/uploads`.
Choose `<NEW_SECRET_VOLUME>` explicitly for this installation; do not guess a
project-prefixed name or reuse another installation's volume. Because the example
creates it outside Compose, replace only the deployment's top-level `secrets_data`
volume definition with the following mapping (leave uploads/render definitions
unchanged). Keep this mapping for subsequent starts with the same Compose project;
the existing service mount `secrets_data:/app/secrets` then uses this exact volume:

```yaml
volumes:
  secrets_data:
    external: true
    name: <NEW_SECRET_VOLUME>
```

For bind mounts, adapt the mount arguments to the verified absolute paths instead
of using the named-volume example below.

Select an already available, verified Foundation image by immutable image ID
(`<VERIFIED_FOUNDATION_IMAGE_ID>`, for example a recorded `sha256:...`). Supply the
installation's non-default `ADMIN_PIN` in the shell environment through the usual
protected credential mechanism; do not put its value in the command or logs.
Only after the backup and volume identities have been checked, explicitly create
the new secret volume and initialize it:

```sh
set -e
docker volume inspect --format '{{.Name}}' '<EXISTING_UPLOAD_VOLUME>'
docker volume create '<NEW_SECRET_VOLUME>'
docker run --rm --pull never --network none --user 0:0 --workdir /app \
  --env ADMIN_PIN \
  --env DATABASE_URL=file:/app/uploads/inker.db \
  --env INKER_INSTANCE_SECRET_PATH=/app/secrets/instance.json \
  --mount 'type=volume,src=<EXISTING_UPLOAD_VOLUME>,dst=/app/uploads,readonly' \
  --mount 'type=volume,src=<NEW_SECRET_VOLUME>,dst=/app/secrets' \
  --entrypoint /bin/sh '<VERIFIED_FOUNDATION_IMAGE_ID>' -ec '
    test -f /app/uploads/inker.db
    test -z "$(find /app/secrets -mindepth 1 -maxdepth 1 -print -quit)"
    chown inker:inker /app/secrets
    chmod 700 /app/secrets
    exec /command/s6-setuidgid inker /usr/local/bin/bun run scripts/prepare-instance-secrets.ts --initialize-existing
  '
```

Stop on any failure; do not delete an existing key or empty a volume to make the
checks pass. The helper bypasses normal service startup, has no network, mounts
uploads read-only and runs key creation as `inker`; only the empty secret directory
ownership is prepared as root. It creates a random key with mode `0600`, never
derives it from `ADMIN_PIN`, and does not decrypt legacy fallback-key ciphertext.
Back up the new secret volume separately, ensure normal Compose uses that exact
volume, then start the approved image and perform the readiness/restore checks.
Re-enter any legacy encrypted plugin or OAuth settings through their supported
configuration paths. Keep the original backup until this transition is verified.

## Foundation restore verification (WP-29)

Record the exact application image ID and one inventory for the complete restore
set. The inventory should contain each archive's size and SHA-256, file counts,
the non-secret instance `keyId`, and the intended schema version. Protect the
inventory against modification together with the backup. Check archive hashes
before extraction, restore only into new empty volumes, and verify file contents,
ownership and permissions before starting the application. A successful archive
command alone is not evidence of a usable backup.

After startup, check the API and worker separately. An overdue running timer must
complete once, retaining its original deadline as `completedAt`; future timers
must retain their deadlines. Pending outbox work must resume without creating a
second publication or interaction. Compare retained publication and source
snapshot IDs/content hashes, read an authenticated cached image with its ETag,
and perform a controlled source refresh to prove that the restored instance key
can still decrypt stored credentials. Verify an existing device credential, a
previously revoked credential, and an unused one-time enrollment independently.

A restore also restores the authorization state at backup time. Revocations,
password changes and newly consumed pairing codes after that time are not in the
backup. Before reconnecting an older restore to an untrusted network, reconcile
or rotate the affected admin/device/share credentials and invalidate outstanding
enrollments. Do not assume a database restore preserves later security changes.

The isolated regression fixture is run from the repository root:

```sh
INKER_SMOKE_IMAGE=inker:wp29-test node backend/test/foundation-backup-restore.cjs
```

The image must be explicitly selected and already exist locally; the fixture
never pulls an image and refuses to run without `INKER_SMOKE_IMAGE`. For release
evidence, pass the verified immutable `sha256:...` image ID. It creates only
randomly named resources with the `inker.wp29.backup` label, uses loopback ports
18741–18743, and runs its three application instances sequentially. Archive and
migration helpers have no network. Synthetic credentials are held only in the
ignored `.tmp/wp29-backup-fixture-state.json`; the archive containing the instance
key remains in an isolated, disposable Docker volume and is never printed.

The fixture checks both a direct restore and an isolated predecessor-schema
upgrade. The predecessor database is created with genuine Prisma migrations and
copied fixture application rows; migration history is never manually rewritten.
Normal application startup applies the missing migration, after which a Prisma
schema diff and real timer/outbox recovery are required. A separate negative
check requires startup preparation to reject an existing database without its
secret snapshot, without generating a replacement key. This is not a procedure
for downgrading a production database.

The fixture always attempts cleanup. After an interruption, run
`node backend/test/foundation-backup-restore.cjs cleanup` and verify that no
resources carrying its ownership label remain. Do not overlap this verification
with latency/load measurements. Record the completed exit status and results in
the Foundation release report; a started or interrupted fixture is not a pass.
