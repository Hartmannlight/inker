[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/yellow_img.png)](https://buymeacoffee.com/wojo_o)

# Inker v0.6.0

Self-hosted e-ink device management server built for the homelab community. Works with [TRMNL](https://usetrmnl.com/) devices — including the 7.5″ **OG** (800×480, 1-bit) and the 10.3″ **TRMNL X** (1872×1404, 16-level grayscale) — and any BYOD e-ink display. Design screens, create custom widgets with live data from your local network, and manage your displays from a modern web interface.

Project architecture, research, and the ordered implementation packages live in
[`docs/architecture/`](docs/architecture/). Binding technical decisions and open
assumptions are indexed in the
[`Architecture Decision Records`](docs/architecture/adr/README.md).

Inker is heading in its own direction — focusing on homelab integrations like server monitoring, smart home dashboards, network stats, and self-hosted service displays. TRMNL device compatibility is maintained, but the plugin ecosystem will be Inker-native.

![Dashboard](https://github.com/user-attachments/assets/fd9affac-5c57-4448-9338-ea8f83add08a)

Support project that uses inker:
- https://3dpm.ru/en/open_projects/ESPHome-TRMNL_7+5/

## Features

- **Screen Designer** — Drag & drop widget placement, snap guides, freehand drawing, auto-fit zoom for any resolution
- **Built-in Widgets** — Clock, date, calendar, text, weather, countdown, days until, QR code, image, GitHub stars, battery, WiFi, device info
- **Calendar Widget** — Monthly calendar with localized month/day names, weekend highlight, dividing lines, and adjustable font size
- **Custom Widgets** — Connect to any JSON API or RSS feed (including local network sources), JavaScript transformations, grid layouts with word-wrapped cells
- **Plugins** — Grafana panel integration with dashboard picker, live preview, and section grid compositing. More homelab-native plugins coming soon!
- **TRMNL OG & X** — Automatic model detection; full **TRMNL X** support (10.3″, 1872×1404, 16-level grayscale) alongside the 7.5″ OG (800×480, 1-bit)
- **Playlists** — Rotate multiple screens on devices automatically, with optional **TRMNL X touch-bar** tap-to-advance (per playlist)
- **Multiple Device Types** — TRMNL-compatible pull devices and browser-based web displays share one playlist and rendering model
- **Realtime Web Displays** — Turn a PC, tablet, TV, or kiosk browser into a display with automatic WebSocket updates
- **Device Management** — Auto-provisioning, secure web-display pairing, real-time status, logs
- **BYOD Support** — Register any e-ink device manually with custom screen resolution
- **Custom Ports** — Run on any port with Docker port mapping (e.g. `800:80`)

## Screenshots

| Devices | Screens | Screen Designer |
|:-:|:-:|:-:|
| ![Devices](https://github.com/user-attachments/assets/e6ba89e7-7bac-419e-bb2e-54a1c0350e07) | ![Screens](https://github.com/user-attachments/assets/510c7d5c-730a-457d-af7d-50ee04b2dc43) | ![Screen Designer](https://github.com/user-attachments/assets/0e4fb32a-bde5-475f-8800-49b06cfce2e9) |

| List of sources | Custom Data Sources | Custom Widgets |
|:-:|:-:|:-:|
| ![Extensions](https://github.com/user-attachments/assets/534b5104-8f1c-4a42-8c58-f2cef74dbc92) | ![Custom data sources](https://github.com/user-attachments/assets/03ed0dc8-7ae0-44fa-ace7-890b5ec8f385) | ![Custom widgets](https://github.com/user-attachments/assets/0eb10812-568a-46db-b58e-7e82c19ea403) |

<div align="center">

| Grafana Plugin |
|:-:|
| <img width="735" height="559" alt="image" src="https://github.com/user-attachments/assets/4312d7c6-7b99-45d6-bb27-5b0f902f60c9" /> |

</div>

| #1 Example Grafana | #2 Example Grafana |
|:-:|:-:|
|<img width="800" height="480" alt="image" src="https://github.com/user-attachments/assets/4073360a-470b-4fd2-ae4c-362e71b3467e" />|<img width="800" height="480" alt="image" src="https://github.com/user-attachments/assets/224994f6-27e4-41c0-9a0c-7b88598b6c22" />|

## Quick start & Technical information

Set `ADMIN_PIN` to an installation-specific value in your shell or secret manager
before using these commands. The examples forward that value without embedding a
known PIN in the image or Compose file.

### Docker Run

```bash
docker run -d \
  --name inker \
  --restart unless-stopped \
  -p 80:80 \
  -e ADMIN_PIN \
  -v inker_uploads:/app/uploads \
  -v inker_secrets:/app/secrets \
  wojooo/inker:latest
```

### Docker Compose

```yaml
# docker-compose.yml
services:
  inker:
    image: wojooo/inker:latest
    container_name: inker
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - uploads_data:/app/uploads
      - secrets_data:/app/secrets
    environment:
      TZ: UTC
      ADMIN_PIN: "${ADMIN_PIN:?Set a unique ADMIN_PIN before starting Inker}"

volumes:
  uploads_data:
  secrets_data:
```

```bash
docker compose up -d
```

Open **http://your-server-ip** and log in with the PIN you configured. Inker
refuses to start when `ADMIN_PIN` is missing or still set to the known `1111`
default.

### Browser-based web display

1. Open **Devices → Add Device** and choose **Web Display**.
2. Enter a name and the target viewport size.
3. Open the generated one-time pairing link on the target PC or kiosk browser.
4. Assign a playlist. Screen edits and playlist transitions are pushed over a persistent WebSocket connection.

Pairing links expire after 15 minutes and are consumed after one use. The browser keeps a revocable device credential locally; only its SHA-256 hash is stored by Inker. A new link can be generated from the device detail page at any time, which revokes the previous browser credential when used.

TRMNL firmware continues to use the existing `/api/setup` and `/api/display` pull protocol. Device type and transport are independent internally, so additional hardware drivers can be added without changing playlist or rendering code.

> **Data and secrets:** Inker stores its embedded **SQLite** database at
> `/app/uploads/inker.db` and its versioned instance encryption key at
> `/app/secrets/instance.json`. Use separate persistent volumes for these paths
> and back up both before every upgrade; see the
> [backup and restore rules](docs/operations/DATABASE_BACKUP.md).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_PIN` | Required, installation-specific login PIN; `1111` is rejected | none |
| `INKER_INSTANCE_SECRET_PATH` | Versioned instance encryption key file | `/app/secrets/instance.json` in the image |
| `TZ` | Timezone for widgets | `UTC` |
| `INKER_PORT` | External port (for custom port mapping, e.g. `INKER_PORT=800`) | `80` |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated, or `*` for all) | same-origin |

Pass with `-e`:
```bash
docker run -d \
  --name inker \
  --restart unless-stopped \
  -p 80:80 \
  -e ADMIN_PIN \
  -e TZ=Europe/Warsaw \
  -v inker_uploads:/app/uploads \
  -v inker_secrets:/app/secrets \
  wojooo/inker:latest
```

### Instance secret lifecycle

On a fresh installation, the container creates a unique 256-bit encryption key
at `/app/secrets/instance.json` before creating the SQLite database. The file is
owner-readable only, contains format `version: 1` and a non-secret `keyId`, and is
reused unchanged on restart. The key and encrypted provider values are never
written to startup logs.

If the SQLite database exists but the matching secret file is missing, startup
stops. Restore the matching `/app/secrets` backup; do not generate a replacement.
For an upgrade from a legacy installation that never had a secret file, first
back up the installation and explicitly initialize a new key:

```bash
docker compose run --rm \
  --entrypoint bun inker run scripts/prepare-instance-secrets.ts --initialize-existing
```

Legacy encrypted plugin and OAuth settings cannot be decrypted with that new key
and must be entered again. Automatic re-encryption and multi-key rotation are not
supported yet. The version and `keyId` fields reserve that future rotation path.

### Build from source

```bash
git clone https://github.com/usetrmnl/inker.git
cd inker
docker compose up -d --build
```

## Raspberry Pi / ARM64 (beta)

Inker's Docker image is **multi-architecture** — the same tag runs on both x86-64 servers and 64-bit ARM boards like the Raspberry Pi. Docker automatically pulls the correct build for your hardware, so the install command is identical:

```bash
docker run -d \
  --name inker \
  --restart unless-stopped \
  -p 80:80 \
  -e ADMIN_PIN \
  -v inker_uploads:/app/uploads \
  -v inker_secrets:/app/secrets \
  wojooo/inker:latest
```

**Requirements:**
- A **64-bit** OS (Raspberry Pi OS 64-bit or Debian arm64) — 32-bit installs are **not** supported.
- Raspberry Pi 4 or 5 recommended (screen rendering runs a headless Chromium).

> **Beta:** ARM64 support is new and hasn't been fully verified on every Pi setup yet. If something doesn't work, please [open an issue](https://github.com/usetrmnl/inker/issues) with your Pi model and OS version — feedback is welcome.

## Updating

```bash
docker compose pull
docker compose up -d
```

All data and the matching instance key are preserved when both named volumes are
kept. Versioned database migrations are applied before the backend starts. A
failed migration or secret check keeps the container unready; restore both
pre-upgrade backups before retrying.

> **Warning:** Never use `docker compose down -v` to update — the `-v` flag deletes
> the data and secret volumes. Losing only the secret volume makes encrypted
> provider settings unrecoverable.

## Troubleshooting

If something isn't working after an update or on first run, reset the volumes and start fresh:

```bash
docker compose down -v
docker compose up -d
```

> **Note:** This removes the database, uploads, and instance secret. Only use it
> when you intend to erase the complete installation.

## Testing

```bash
cd backend
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run prisma:validate

cd ../frontend
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

The pinned tool versions, canonical package-manager policy, non-mutating lint
commands, and current baseline findings are documented in
[`docs/architecture/TOOLCHAIN_BASELINE.md`](docs/architecture/TOOLCHAIN_BASELINE.md).

## License

Source Available — see [LICENSE](LICENSE) for details.
