# Repository-Topologie und Ausgangsstand

Stand: 24. August 2026

## Verbindliche Topologie

- **Code-Repository und Projektwurzel:**
  `C:\Users\Nathaniel\Documents\StatusPanel\inker`
- **Zielbranch:** `main` auf Commit
  `83c72b0c590cca40df9da1c646c3d5693e0028df`
- **Fork-Remote:** `origin` → `https://github.com/Hartmannlight/inker.git`
- **Upstream-Remote im Fork:** `upstream` → `https://github.com/usetrmnl/inker.git`
- **Lokale Upstream-Referenz (read-only behandeln):**
  `C:\Users\Nathaniel\Documents\StatusPanel\upstream\inker`, `main` auf demselben
  Commit, `origin` → `https://github.com/usetrmnl/inker.git`
- **Äußere Hülle:** `C:\Users\Nathaniel\Documents\StatusPanel` ist nur ein
  lokaler Workspace. Das dort vorhandene commitlose Git-Repository ist nicht das
  Projekt-Repository und soll nicht als Ziel für Produkt-Commits verwendet werden.
- **Architekturunterlagen:** `docs/architecture/` im Code-Repository. Die
  bisherigen Dateien in der äußeren Hülle sind nur Weiterleitungen.

Damit existiert genau ein verbindliches Code-Repository. Der Referenzcheckout
bleibt außerhalb davon und wird weder verschoben noch rekursiv gelöscht.

## Wiederherstellung

Der unveränderte Ausgangscode ist über den oben genannten Commit und beide
Remotes reproduzierbar. Der uncommittierte Spike wird zusätzlich lokal unter
`C:\Users\Nathaniel\Documents\StatusPanel\.wp00-backups\2026-08-24` gesichert:

- `tracked-spike.patch`: binärer Full-Index-Patch aller Änderungen an getrackten
  Dateien;
- `untracked-files.zip`: Archiv aller ungetrackten Dateien des Code-Repositories.

Commit, Branches, Remotes und der vorgefundene Status stehen in diesem Dokument.
Die Prüfsummen werden bei der WP-00-Abnahme im Handoff festgehalten.

Die Sicherung ist bewusst lokal und durch die Workspace-Ignore-Regeln
ausgeschlossen. Sie ersetzt keinen später ausdrücklich freigegebenen Commit.

## Spike-Inventar

Die folgende Zuordnung ist vollständig für den bei WP-00 vorgefundenen
Arbeitsbaum. Dateien mit Querschnittsänderungen sind unter ihrem primären Thema
einsortiert.

### Geräteplattform und Browser-WebDisplay

- `README.md`
- `backend/bun.lock`
- `backend/package-lock.json`
- `backend/package.json`
- `backend/prisma/schema.prisma`
- `backend/prisma/seed.ts`
- `backend/src/api/api.module.ts`
- `backend/src/api/setup/setup.service.test.ts`
- `backend/src/api/setup/setup.service.ts`
- `backend/src/app.module.ts`
- `backend/src/common/utils/crypto.util.ts`
- `backend/src/dashboard/dto/dashboard-stats.dto.ts`
- `backend/src/device-platform/device-platform.module.ts`
- `backend/src/device-platform/device-update-coordinator.service.ts`
- `backend/src/device-platform/dto.ts`
- `backend/src/device-platform/presentation.service.test.ts`
- `backend/src/device-platform/presentation.service.ts`
- `backend/src/device-platform/presentation.types.ts`
- `backend/src/device-platform/web-display-auth.service.test.ts`
- `backend/src/device-platform/web-display-auth.service.ts`
- `backend/src/device-platform/web-display.gateway.ts`
- `backend/src/device-platform/web-displays.controller.ts`
- `backend/src/devices/devices.controller.ts`
- `backend/src/devices/devices.module.ts`
- `backend/src/devices/devices.service.test.ts`
- `backend/src/devices/devices.service.ts`
- `backend/src/devices/dto/create-device.dto.ts`
- `backend/src/devices/drivers/device-driver.registry.ts`
- `backend/src/devices/drivers/device-driver.ts`
- `backend/src/devices/drivers/trmnl-device.driver.ts`
- `backend/src/devices/drivers/web-display-device.driver.ts`
- `backend/src/screen-designer/screen-designer.service.ts`
- `backend/src/screen-designer/services/screen-renderer.service.ts`
- `backend/src/test/mocks/prisma.mock.ts`
- `docker/nginx.conf`
- `frontend/package-lock.json`
- `frontend/src/App.tsx`
- `frontend/src/pages/devices/AddDevice.tsx`
- `frontend/src/pages/devices/DeviceDetail.tsx`
- `frontend/src/pages/devices/DeviceForm.tsx`
- `frontend/src/pages/devices/DevicesList.tsx`
- `frontend/src/pages/display/WebDisplay.tsx`
- `frontend/src/services/api.ts`
- `frontend/src/types/index.ts`
- `frontend/vite.config.ts`

Inhaltlich umfasst diese Gruppe generische Gerätetypen und Transporte,
Device-Credentials und einmalige Pairing-Tokens, eine Treiberregistry,
Presentation-Manifeste, WebSocket-Push/Verbindungskoordination, die Browseranzeige,
Admin-UI-Anpassungen sowie Proxy-, Rendering- und Testintegration.

### „Days Until“-Widget

- `backend/src/screen-designer/services/days-until.util.test.ts`
- `backend/src/screen-designer/services/days-until.util.ts`
- `backend/src/screen-designer/services/widget-templates.service.ts`
- `frontend/src/components/screen-designer/WidgetRenderer.tsx`
- `frontend/src/components/screen-designer/WidgetSettingsPanel.tsx`
- `frontend/src/utils/daysUntil.test.ts`
- `frontend/src/utils/daysUntil.ts`

Diese Gruppe umfasst Kalender-/Arbeitstagsberechnung, Ziel- und Dauermodus,
mehrere Darstellungsvarianten, Konfiguration im Designer und Tests in Backend und
Frontend. `backend/prisma/schema.prisma`, `backend/prisma/seed.ts`,
`backend/src/screen-designer/services/screen-renderer.service.ts` und
`frontend/src/types/index.ts` enthalten zusätzlich Querschnittsanteile dieses
Widgets und sind oben bereits aufgeführt.

## Bewusst nicht verschoben

- `C:\Users\Nathaniel\Documents\StatusPanel\upstream\inker`: saubere lokale
  Upstream-Referenz; sie bleibt außerhalb des Code-Repositories.
- Das äußere `.git`-Verzeichnis: keine Löschung ohne ausdrückliche Freigabe.
- Sämtliche produktiven Spike-Dateien: WP-00 dokumentiert und sichert sie, nimmt
  aber keine fachlichen Codeänderungen vor.
