# WP-01 – Toolchain- und Testbaseline

Stand der verbindlichen Versionen: 2026-09-16 (ursprüngliche Testbaseline: 2026-08-24)

## Verbindliche Versionen

| Werkzeug | Version | Verwendung |
|---|---:|---|
| Bun | `1.4.2` | Kanonische Runtime und Paketmanager für Backend und Frontend |
| Node.js | `22.23.2` | LTS-Hilfsruntime für Prisma im Container; kein Paketmanager |
| Prisma CLI/Client | `6.19.3` | Durch `backend/bun.lock` festgelegt |
| Redis | `8.0.2` (`5:8.0.2-3+deb13u2`) | Im Produktionsimage installierte Queue-Runtime |
| Docker Engine | `28.5.2` | Referenzversion für Build und Smoke-Test |
| Docker Compose | `2.40.3` | Referenzversion für lokale Compose-Prüfungen |

`.bun-version`, `.node-version`, die `packageManager`-/`engines`-Felder und die
vollständig qualifizierten Container-Tags halten lokale Entwicklung, CI und
Container-Build auf denselben Runtime-Linien. Das Produktionsimage installiert
Redis explizit, weil der vorhandene s6-Service `redis-server` startet.

## Paketmanagerentscheidung

Bun ist in `backend/` und `frontend/` der einzige kanonische Paketmanager.
`bun.lock` wird in beiden Teilprojekten versioniert und bei Installationen mit
`--frozen-lockfile` unverändert geprüft. Die parallelen `package-lock.json`-Dateien
wurden entfernt. `npm install`, `npm update` und `bun install` ohne bewusst
geprüften Lockfile-Diff sind nicht Teil des reproduzierbaren Workflows.

Node.js bleibt ausschließlich für Prisma im Container verfügbar. `bunx` wird nur
für interaktive Entwicklungsbefehle verwendet; die Prüfskripte lösen ihre lokal
gesperrten Binärdateien über `bun run` auf und laden nichts implizit nach.

## Sicherheitsupdates der Abhängigkeiten

Bun 1.4.2 unterstützt den gezielten `path-to-regexp`-Override für
`@nestjs/serve-static`. Express behält seine kompatible 0.1.x-Version; Nest
verwendet weiterhin 3.x. Ein globaler Router-Override würde diese APIs vermischen.
Die weiteren Overrides halten Prisma-Konfiguration, Uploads, YAML und HTTP-
Hilfsbibliotheken auf behobenen Versionen. Sharp 0.35.4 und die aktualisierten
Axios-, LiquidJS- und WebSocket-Pakete werden durch die vollständigen Produktions-,
Renderer-, Last- und Backup-Gates geprüft. Die Scan-Policy bleibt unverändert.

## Kanonische Prüfungen

Die folgenden Befehle sind in dieser Reihenfolge lokal und in CI auszuführen:

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

`bun run lint` ist in beiden Teilprojekten eine rein lesende Bestandsprüfung.
Automatische Änderungen sind ausschließlich über den ausdrücklich benannten
Befehl `bun run lint:fix` möglich. Lint ist wegen der unten dokumentierten
Altbefunde noch kein grünes CI-Gate.

Der Workflow `.github/workflows/ci.yml` führt dieselben Installations- und
Prüfbefehle aus und ergänzt einen Docker-Build mit HTTP-Health-Smoke-Test.

## Baseline-Ergebnis

Ausgeführt mit Bun `1.3.14` unter Windows am 2026-08-24:

| Teilprojekt | Prüfung | Ergebnis |
|---|---|---|
| Backend | Frozen install | grün |
| Backend | Typecheck | grün |
| Backend | Tests | grün: 443 Tests in 36 Dateien, 0 Fehler |
| Backend | Build | grün |
| Backend | `prisma validate` | grün, Prisma `6.19.3` |
| Frontend | Frozen install | grün |
| Frontend | Typecheck | grün |
| Frontend | Tests | grün: 21 Tests in 4 Dateien, 0 Fehler |
| Frontend | Build | grün |
| Docker | Compose-Konfiguration | grün |
| Docker | Image-/Health-Smoke-Test | lokal nicht ausgeführt; Docker-Engine war nicht gestartet |

## Bestehende, nicht durch WP-01 verursachte Befunde

- Backend-Lint: 46 Fehler und 43 Warnungen. Der Großteil der Fehler entsteht,
  weil Testdateien aus dem TypeScript-Projekt ausgeschlossen sind; weitere
  Bestandsfehler betreffen unter anderem `no-undef` und verbotene
  CommonJS-`require()`-Aufrufe.
- Frontend-Lint: 85 Fehler und 9 Warnungen. Die vorhandenen Befunde betreffen vor
  allem explizites `any`, Hook-Abhängigkeiten und synchrone State-Updates in
  Effects.
- Prisma meldet die bestehende `package.json#prisma`-Konfiguration als für Prisma
  7 veraltet. Die Umstellung gehört nicht zur WP-01-Baseline.
- Der Frontend-Build warnt vor veralteten lokalen Browserslist-Daten und vor einem
  Chunk über 500 kB; der Build ist dennoch erfolgreich.
- Der lokale Docker-Client war `28.5.1` mit Compose `2.40.3-desktop.1`, aber die
  Docker-Desktop-Engine war nicht erreichbar. Der identische Smoke-Test ist im
  CI-Workflow hinterlegt.
