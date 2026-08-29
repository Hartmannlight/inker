# UX remediation release notes

These notes describe the UX-00 through UX-10 remediation work. They are not a
deployment approval and do not replace the checked backup procedure in
[DATABASE_BACKUP.md](DATABASE_BACKUP.md).

## User-visible changes

- **Integrations** is the single entry point for external services. **Extensions**
  remains the separate area for presentation packages. The old visible Plugins
  navigation entry is gone.
- A device can receive one screen directly. A playlist remains optional when
  rotating content is wanted.
- Playlist items are added, removed, reordered, and given a duration directly on
  the playlist detail page. A one-item playlist is valid and must not cause a
  periodic download loop.
- Pairing uses the ten-character, one-time short code. The former long pairing
  link is no longer presented as a bootstrap workflow.
- Browser displays report only their available telemetry. Unknown battery,
  signal, and transport values are not displayed as measurements.
- Grafana is a beta integration. The worker alone reads its encrypted Viewer
  credential; the browser, renderer, templates, and devices do not receive it.

## Breaking changes and redirects

The legacy anonymous image routes `/api/device-images/design/:id` and
`/api/device-images/device/:id` continue to return `410 PUBLICATION_REQUIRED`.
Use an authenticated preview or publish content for a device instead; a GET does
not render or refresh content.

Legacy navigation remains available only as redirects:

| Old path | Destination |
| --- | --- |
| `/plugins` and `/plugins/installed` | `/extensions` |
| `/data-sources` | `/integrations?tab=data-sources` |

Bookmarks may therefore be updated without a data migration. Internal legacy
model names are not a public API contract.

## Credential rotation

Revoke a provider credential before replacing it. Enter the replacement only in
the integration command, where it is stored as an encrypted write-only secret.
Do not place provider credentials in URLs, screens, templates, fixtures, logs,
or browser storage. A real Grafana verification requires confirmation that an
earlier exposed credential has been revoked and a newly issued Viewer-only
credential.

Existing device credentials remain valid. A short pairing code is single-use;
create a new one rather than reusing an expired or consumed code.

## Upgrade, migration, and rollback

The database migrations are forward-only. Before upgrading, stop the complete
deployment and save one matching restore set: `/app/uploads`, `/app/secrets`,
and `/app/render-cache`. Preserve the instance-key permissions and record only
the non-secret key ID. This is required because SQLite state, encrypted provider
credentials, and publication artifacts are mutually dependent.

If an upgrade needs to be rolled back, restore that complete pre-upgrade volume
set into empty volumes and start the last known-good image. Do not edit Prisma
migration history, use `prisma db push`, or generate a replacement instance key.
Then verify `/ready`, worker readiness, an existing device credential, a
publication artifact, and a controlled test-source refresh. Full commands and
the legacy-installation transition are in [DATABASE_BACKUP.md](DATABASE_BACKUP.md).

## Short operating guides

### Device and one screen

Create or pair the device, upload or create a screen, open the device, select
**Change content**, and select that screen. Review the required preview when its
raster size is risky for the device profile, then publish the assignment.

### Rotating playlist

Create a playlist, choose **Add screens** on its detail page, then set each
item's order and duration in place. Publish the playlist only after the desired
rotation is complete, and assign it to the target device.

### Grafana

Under **Integrations**, create a Grafana source with its normalized base URL and
a dedicated, minimally privileged Viewer credential. Request or wait for the
worker refresh, check the persisted result, and publish it through the normal
source/publication flow. A source request is asynchronous; no renderer or
display request contacts Grafana. See [SOURCE_OPERATIONS.md](SOURCE_OPERATIONS.md).

### Trusted local HTTP pairing

HTTPS is the default. For a deliberately trusted local network only, set
`PAIRING_ALLOW_INSECURE_HTTP=true` in the deployment environment and restart the
container. Do not enable it from the browser. `PAIRING_TRUST_PROXY=true` is a
separate setting for a known TLS-terminating proxy; see
[ADR-009](../architecture/adr/009-local-http-policy.md).
