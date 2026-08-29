# Inker

Inker is a self-hosted platform for compatible pull devices and browser displays. It pairs devices, publishes immutable content, and renders each artifact for its selected profile.

## Fork notice

This fork is based on [`usetrmnl/inker` commit `83c72b0`](https://github.com/usetrmnl/inker/commit/83c72b0c590cca40df9da1c646c3d5693e0028df), verified locally on 2026-08-29. TRMNL device compatibility is maintained. Inker is **not** a clone of TRMNL Core or Terminus: its integrations, source snapshots, rendering, publication, delivery, and device runtime remain Inker-native.

## What this fork adds

| Capability | Status |
| --- | --- |
| Browser displays, WebSocket delivery, short-code pairing | available |
| Immutable publications, target-profile rendering, outbox delivery | available |
| Direct single-screen assignment and deterministic playlists | available |
| Worker-only encrypted provider credentials and source snapshots | available |
| Grafana panel source | beta |
| Declarative TRMNL recipe compatibility | limited — UX-09 is Limited Go |
| Recipe importer, marketplace, remote updates, foreign guest runtimes | planned / not included |

## Compatibility and limitations

TRMNL pull devices and browser displays are supported. Native Ruby, PHP, Python, and Node guest runtimes are not supported. No recipe catalog, marketplace, or automatic installer is included. Hardware coverage varies by device profile.

Grafana is beta. Use a new, minimally privileged Viewer token only after revoking any exposed token. Inker encrypts it; only the connector worker can decrypt it. Renderers, templates, browsers, and devices never receive provider secrets.

## Quick start

```bash
export ADMIN_PIN='choose-a-unique-secret'
docker compose up -d --build
```

Persist uploads (SQLite and assets), the instance-secret volume (`/app/secrets`), and render-cache volumes together. Back up the matching set before upgrades; see [backup and restore](docs/operations/DATABASE_BACKUP.md).

HTTPS is required for pairing by default. A trusted local installation may explicitly set `PAIRING_ALLOW_INSECURE_HTTP=true` and restart. Set `PAIRING_TRUST_PROXY=true` only behind a known TLS proxy.

## Common workflows

**Single screen:** create or pair a device, upload a screen, then select **Change content** and choose the screen. Risky raster fits require one preview confirmation.

**Playlist:** create a playlist, use **Add screens** on its detail page, edit duration/order inline, publish for playback, then assign it from the playlist or device picker.

**Browser display:** create a Web display, enter its pairing code in the target browser, then assign a single screen or playlist.

**Grafana:** create a source under **Integrations** with a dedicated Viewer token. The UI never reads the token back.

## Development and operations

```text
contracts: bun run typecheck && bun run test && bun run build
backend:   bun run typecheck && bun run lint && bun run test && bun run build && bun run prisma:validate
frontend:  bun run typecheck && bun run lint && bun run test && bun run build
container: docker compose config --quiet
```

See the [UX remediation release notes](docs/operations/UX_REMEDIATION_RELEASE_NOTES.md), [source operations](docs/operations/SOURCE_OPERATIONS.md), [worker operations](docs/operations/WORKER_OPERATIONS.md), [render cache](docs/operations/RENDER_CACHE.md), [backup/restore](docs/operations/DATABASE_BACKUP.md), and [ADRs](docs/architecture/adr/README.md).

## License

Inker is licensed under the [GNU Affero General Public License v3.0](LICENSE). Third-party components retain their own licenses.
