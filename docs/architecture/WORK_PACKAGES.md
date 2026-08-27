# StatusPanel – Geordnete Arbeitspakete

Stand: 24. August 2026  
Zugehöriges Zielbild: [`ARCHITECTURE_PLAN.md`](ARCHITECTURE_PLAN.md)

## 1. Zweck dieser Datei

Diese Datei zerlegt den Architekturplan in abgeschlossene Arbeitspakete. Jedes
Paket soll in einem neuen Chat ohne vorherigen Gesprächskontext bearbeitbar sein.
Der neue Chat benötigt nur Zugriff auf das Repository und diese beiden Dateien.

Ein Paket ist fertig, wenn sein Ergebnis implementiert, getestet und dokumentiert
ist. Es soll nicht nebenbei mit einem späteren Paket begonnen werden. Offene
Probleme werden als Handoff notiert und nicht durch unvereinbarte Zusatzarchitektur
gelöst.

## 2. Regeln für jeden neuen Chat

Der folgende Block gilt für alle Pakete:

1. Lies zuerst dieses Arbeitspaket vollständig und danach nur die darin genannten
   Abschnitte aus `ARCHITECTURE_PLAN.md`.
2. Prüfe vor Änderungen Repository, Branch, `git status`, vorhandene Anweisungen
   und bereits abgeschlossene Abhängigkeiten.
3. Erhalte fremde und uncommittierte Änderungen. Lösche, verschiebe oder überschreibe
   nichts außerhalb des Paket-Scopes ohne ausdrückliche Freigabe.
4. Implementiere nur den angegebenen Scope. Neue Erkenntnisse für spätere Pakete
   kommen in den Handoff.
5. Ergänze oder aktualisiere Tests proportional zum Risiko.
6. Führe die im Paket genannten Prüfungen aus. Wenn eine Laufzeit fehlt, dokumentiere
   das exakt und führe die größtmögliche statische Prüfung aus.
7. Aktualisiere nach erfolgreichem Abschluss die Checkbox im Paketindex und den
   Handoff des Pakets.
8. Erstelle keinen Git-Commit, solange der Benutzer nicht ausdrücklich darum bittet.

### Universeller Startauftrag für einen neuen Chat

```text
Bearbeite ausschließlich Arbeitspaket WP-XX aus
C:\Users\Nathaniel\Documents\StatusPanel\inker\docs\architecture\WORK_PACKAGES.md.
Lies das Paket vollständig, prüfe seine Voraussetzungen und lies die dort
referenzierten Abschnitte aus ARCHITECTURE_PLAN.md. Implementiere das Paket
vollständig, führe die angegebenen Tests aus und aktualisiere danach Paketstatus
und Handoff. Bewahre vorhandene uncommittierte Änderungen und beginne kein
Folgepaket. Erstelle keinen Commit, außer ich fordere ihn ausdrücklich an.
```

`WP-XX` wird durch die gewünschte Paketnummer ersetzt.

## 3. Reihenfolge und Abhängigkeiten

Die Reihenfolge ist verbindlich, sofern im Paket nicht ausdrücklich parallele
Bearbeitung erlaubt wird. Die Spalte „Gate“ zeigt, welche Pakete abgeschlossen sein
müssen.

| Status | Paket | Ergebnis | Gate |
|---|---|---|---|
| [x] | WP-00 | Eindeutiges Repository und gesicherter Ausgangsstand | – |
| [x] | WP-01 | Reproduzierbare Toolchain und grüne Baseline-Prüfungen | WP-00 |
| [x] | WP-02 | Verbindliche Architecture Decision Records | WP-01 |
| [x] | WP-03 | Frameworkunabhängiger Contracts-Bereich | WP-02 |
| [x] | WP-04 | Versionierte Device-, Presentation-, Source- und Interaction-Verträge | WP-03 |
| [x] | WP-05 | Prisma-Migrationsbaseline und sicherer Containerstart | WP-01, WP-02 |
| [x] | WP-06 | Bereinigtes Device-/Profile-/Credential-Datenmodell | WP-04, WP-05 |
| [x] | WP-07 | Publication-, Outbox- und Zustandsmodelle | WP-04, WP-05 |
| [x] | WP-08 | Reparierter Browser-Credential-Lebenszyklus | WP-01 |
| [x] | WP-09 | Short-Code-Pairing im Backend | WP-06, WP-08 |
| [x] | WP-10 | Pairing-UI mit Code und QR | WP-09 |
| [ ] | WP-11 | Sichere Instanz-Secrets und verbotene Defaults | WP-05 |
| [x] | WP-12 | Sichere Admin-Session statt langlebigem Local-Storage-Token | WP-11 |
| [x] | WP-13 | Saubere Profile-, Transport- und Delivery-Abstraktionen | WP-04, WP-06 |
| [ ] | WP-14 | Pull-Auslieferung mit Manifest, ETag und Delivery Policy | WP-07, WP-13 |
| [ ] | WP-15 | Gehärteter WebSocket-Transport und gedrosselte Telemetrie | WP-08, WP-13 |
| [ ] | WP-16 | Transaktions-Outbox und zuverlässiger Event-Dispatcher | WP-07, WP-13 |
| [ ] | WP-17 | Unveränderliche Publications und read-only PresentationManifest | WP-07 |
| [ ] | WP-18 | Deterministische Playlist-/Rotationszustandsmaschine | WP-17 |
| [ ] | WP-19 | Render-Deduplizierung, Artefaktcache und Fallback | WP-14, WP-17, WP-18 |
| [ ] | WP-20 | Getrennter Worker-Bootstrap und verbindliche Queue-Policies | WP-16 |
| [ ] | WP-21 | SourceDefinition, SourceSnapshot und Resilienz-Testconnectoren | WP-20 |
| [ ] | WP-22 | Isolationsgrenze für blockierenden/unbekannten Plugin-Code | WP-20, WP-21 |
| [ ] | WP-23 | Versionierte, idempotente Interaction-/Command-Pipeline | WP-04, WP-15, WP-16 |
| [ ] | WP-24 | Persistente Timer-Domäne | WP-23 |
| [ ] | WP-25 | Timer-Scheduling, Neustart-Recovery und Multi-Display-Updates | WP-20, WP-24 |
| [ ] | WP-26 | Föderationsvertrag und read-only Share-Credentials | WP-04, WP-12, WP-17 |
| [ ] | WP-27 | Remote-Abonnement, sichere Synchronisation und lokaler Fallback | WP-20, WP-26 |
| [ ] | WP-28 | Strukturierte Logs, Metriken und Betriebszustände | WP-20 |
| [ ] | WP-29 | Last-, Fault-, Backup- und Security-Freigabegate | WP-19, WP-21, WP-25, WP-27, WP-28 |

### Grobe Etappen

- **Etappe A – Arbeitsfähigkeit:** WP-00 bis WP-04
- **Etappe B – Persistenz und Sicherheit:** WP-05 bis WP-12
- **Etappe C – Geräte und Auslieferung:** WP-13 bis WP-19
- **Etappe D – Hintergrundarbeit und Sources:** WP-20 bis WP-22
- **Etappe E – Touch und Timer:** WP-23 bis WP-25
- **Etappe F – Mehrere Server:** WP-26 bis WP-27
- **Etappe G – Betriebsfreigabe:** WP-28 bis WP-29

## 4. Arbeitspakete

## WP-00 – Repository und Ausgangsstand ordnen

**Ziel:** Es existiert genau ein eindeutig benanntes Code-Repository mit einem
wiederherstellbaren Ausgangsstand. Die Architekturunterlagen gehören sichtbar zu
diesem Projekt.

**Kontext:** Aktuell ist `StatusPanel` ein commitloses äußeres Repository. Darin
liegen der Fork `inker`, eine zweite Upstream-Arbeitskopie und ungetrackte
Konzeptdokumente. Der eigentliche Fork enthält einen großen uncommittierten Spike.

**Voraussetzungen:** Keine.

**Scope:** Git-Topologie, Ignore-Regeln, Dokumentablage, Bestandsaufnahme und
Sicherungsstrategie. Keine fachlichen Codeänderungen.

**Aufgaben:**

- [x] Prüfe alle drei Git-Arbeitsbereiche, Remotes, Branches und uncommittierten
  Dateien erneut.
- [x] Empfiehl und dokumentiere die Zieltopologie. Standardempfehlung:
  `StatusPanel/inker` bleibt das Code-Repository; die äußere Hülle ist nur ein
  Workspace und `upstream/inker` bleibt außerhalb des Code-Repositories.
- [x] Verschiebe die Architekturunterlagen in einen versionierbaren
  `docs/architecture/`-Bereich des Ziel-Repositories, sofern das ohne Datenverlust
  möglich ist.
- [x] Aktualisiere nach einem Verschieben alle relativen Links und den absoluten
  Pfad im universellen Startauftrag. Hinterlasse am bisherigen Ort mindestens
  einen eindeutigen Weiterleitungshinweis, damit spätere Chats die Arbeitsliste
  weiterhin finden.
- [x] Lege sinnvolle Ignore-Regeln für lokale Referenzcheckouts und temporäre
  Artefakte fest.
- [x] Erstelle eine genaue Liste der vorhandenen Spike-Themen und ihrer Dateien.
- [x] Nimm keine rekursive Löschung und keinen Commit ohne ausdrückliche Freigabe
  vor.

**Abnahme:** Ein neuer Chat kann eindeutig sagen, welches Verzeichnis das Projekt
ist, was Upstream-Referenz ist und welche Änderungen zum Spike gehören.

**Validierung:** `git status`, `git remote -v`, `git branch -vv` und Pfadprüfung in
allen betroffenen Verzeichnissen.

**Handoff:** Ziel-Repository, Zielbranch, verbleibende uncommittierte Gruppen und
bewusst nicht verschobene Dateien notieren.

### Abschluss WP-00

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Verbindliches Code-Repository ist
  `C:\Users\Nathaniel\Documents\StatusPanel\inker`, Basisbranch `main`;
  Sicherungsbranch ist `codex/device-platform-spike`. Die äußere
  Hülle ist als lokaler Workspace und `upstream\inker` als saubere, read-only zu
  behandelnde Upstream-Referenz dokumentiert. Alle sechs Architekturunterlagen
  liegen unter `docs/architecture/`; am alten Ort bestehen Weiterleitungen. Die
  vollständige Topologie, Wiederherstellungsstrategie und Spike-Dateiliste stehen
  in `docs/architecture/REPOSITORY_BASELINE.md`.
- Geänderte Kernpfade: `docs/architecture/`, `README.md`, `.gitignore` im
  Code-Repository sowie Weiterleitungsdateien und `.gitignore` in der äußeren
  Workspace-Hülle.
- Ausgeführte Tests: `git status`, `git remote -v` und `git branch -vv` in äußerer
  Hülle, Fork und Upstream-Referenz; Existenzprüfung aller Ziel-/Weiterleitungspfade;
  lokale Markdown-Linkprüfung; `git apply --check --cached` für den binären
  Sicherungspatch; exakter Vergleich aller 26 ZIP-Einträge mit der ungetrackten
  Dateiliste. SHA-256: `tracked-spike.patch` =
  `08B1EDDBD1BFF0CB1222F9F3298D5D832270C6DA28783BDF399BA5D887A28B81`,
  `untracked-files.zip` =
  `1BB42E8CC11BE2172BCA8369523E236DF00FC27D2A0BF1974B9D4AAEA97A4DE5`.
- Nicht ausführbare Tests und Grund: Backend-Bun-Tests nicht ausführbar, weil Bun
  nicht im `PATH` liegt. Als Ersatz liefen Backend-Typecheck und Prisma-Validierung;
  Frontend-Typecheck und die Days-Until-Tests waren grün.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Die äußere Hülle enthält weiterhin ein commitloses
  `.git`-Verzeichnis; es wurde entsprechend der Löschsperre nicht entfernt. Die
  WP-00-Sicherung ist lokal und kein Ersatz für einen später freigegebenen Commit.
- Relevante Hinweise für WP-01: Die zwei vorgefundenen Spike-Gruppen
  Geräteplattform/Browser-WebDisplay und „Days Until“ sowie die WP-00-Dokumente
  sind auf `codex/device-platform-spike` in getrennten Commits gesichert.
  `upstream\inker` und das äußere `.git` wurden bewusst nicht verschoben. Die
  Lockfile-Diffs in `backend/bun.lock`, `backend/package-lock.json` und
  `frontend/package-lock.json` gehören zum vorgefundenen Spike und müssen bei der
  Paketmanagerentscheidung berücksichtigt werden.
- Git-Stand/Commit: Sicherungsbranch `codex/device-platform-spike`; Commits
  `e47de9f` (Architektur), `2f73a36` (Dependencies), `28f3382` (Device Platform)
  und `0054db3` (Days Until); Ausgangs-HEAD
  `83c72b0c590cca40df9da1c646c3d5693e0028df`.

## WP-01 – Toolchain und Testbaseline reproduzierbar machen

**Ziel:** Ein neuer Entwickler oder CI-Runner kann Backend und Frontend mit
festgelegten Versionen installieren, typprüfen, testen und bauen.

**Kontext:** Backendtests verwenden Bun; Bun war in der bisherigen Umgebung nicht
im `PATH`. Frontendtests und TypeScript-Prüfungen waren grün. Zwei Lockfile-Systeme
erzeugen viel Diff-Rauschen.

**Voraussetzungen:** WP-00.

**Scope:** Runtime-Versionen, Paketmanagerentscheidung, Skripte, minimale CI und
Baseline-Bericht. Keine Architekturrefaktorierung.

**Aufgaben:**

- [x] Dokumentiere erforderliche Versionen von Bun, Node, Prisma, Redis und Docker.
- [x] Entscheide und dokumentiere pro Teilprojekt den kanonischen Paketmanager und
  Umgang mit `bun.lock`/`package-lock.json`.
- [x] Vereinheitliche nicht-destruktive Skripte für Typecheck, Test, Build und
  Prisma-Validierung.
- [x] Verhindere, dass ein Lint-Prüfbefehl ungefragt Dateien mit `--fix` verändert.
- [x] Führe Backend- und Frontend-Baseline vollständig aus.
- [x] Lege einen minimalen CI-Workflow mit denselben Befehlen an oder aktualisiere
  den vorhandenen.
- [x] Dokumentiere bestehende, nicht durch dieses Paket verursachte Fehler separat.

**Abnahme:** Eine dokumentierte Befehlsfolge läuft lokal und in CI identisch; alle
vorhandenen Tests sind entweder grün oder mit reproduzierbarer Ursache erfasst.

**Validierung:** Clean install, Typecheck, Tests, Builds und `prisma validate`.

**Handoff:** Exakte Runtime-Versionen, kanonische Befehle und Baseline-Testzahlen
notieren.

### Abschluss WP-01

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Bun ist für Backend und Frontend als einziger Paketmanager auf
  `1.3.14` festgelegt; Node `22.22.3`, Prisma `6.19.3`, Redis `8.0.2`, Docker
  Engine `28.5.2` und Docker Compose `2.40.3` sind dokumentiert. Parallele
  npm-Lockfiles wurden entfernt, Prüfskripte vereinheitlicht, Lint von
  `lint:fix` getrennt und CI um die kanonische Baseline sowie einen
  Docker-Health-Smoke-Test ergänzt. Details stehen in
  `docs/architecture/TOOLCHAIN_BASELINE.md`.
- Geänderte Kernpfade: `.bun-version`, `.node-version`, `backend/package.json`,
  `frontend/package.json`, `backend/package-lock.json` (entfernt),
  `frontend/package-lock.json` (entfernt), `.gitignore`, `Dockerfile`,
  `.github/workflows/ci.yml`, `README.md` und
  `docs/architecture/TOOLCHAIN_BASELINE.md`.
- Ausgeführte Tests: echte Clean Installs mit
  `bun install --frozen-lockfile`; Backend-Typecheck; 443 Backendtests in 36
  Dateien; Backend-Build; `prisma validate`; Frontend-Typecheck; 21
  Frontendtests in 4 Dateien; Frontend-Build; `docker compose config --quiet`;
  Paketmanifest-Parsing und `git diff --check`. Alle genannten Prüfungen waren
  grün.
- Nicht ausführbare Tests und Grund: Docker-Image-Build und HTTP-Health-Smoke-Test
  lokal nicht ausführbar, weil Docker Desktop installiert, die Linux-Engine aber
  nicht gestartet war. Der identische Test ist im CI-Workflow hinterlegt.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Backend-Lint hat 46 Fehler/43 Warnungen und Frontend-Lint
  85 Fehler/9 Warnungen aus dem Bestand; Lint ist deshalb noch kein grünes
  CI-Gate. Prisma warnt vor der in Prisma 7 entfallenden
  `package.json#prisma`-Konfiguration. Frontend-Build warnt vor veralteten
  Browserslist-Daten und einem großen Bundle-Chunk. Alle Befunde sind separat im
  Baseline-Bericht erfasst.
- Relevante Hinweise für WP-02: Toolchain- und CI-Entscheidungen sind jetzt
  reproduzierbar dokumentiert; kanonische Befehle sind `bun run typecheck`,
  `bun run test`, `bun run build` und im Backend zusätzlich
  `bun run prisma:validate`. Folgepakete dürfen ausschließlich die vorhandenen
  `bun.lock`-Dateien aktualisieren.
- Git-Stand/Commit: Branch `codex/device-platform-spike`; dieser Handoff ist
  Bestandteil des WP-01-Commits auf Basis von `d4503a2`.

## WP-02 – Architecture Decision Records anlegen

**Ziel:** Die wichtigsten technischen Entscheidungen sind kurz, verbindlich und
für spätere Chats auffindbar dokumentiert.

**Kontext:** Das Zielbild steht in `ARCHITECTURE_PLAN.md`, ist aber noch kein Satz
einzelner, änderbarer Entscheidungen.

**Voraussetzungen:** WP-01.

**Scope:** Dokumentation; keine produktiven Codeänderungen.

**Aufgaben:**

- [x] Lege ein ADR-Template mit Status, Kontext, Entscheidung, Folgen und
  Alternativen an.
- [x] Erstelle ADRs für SQLite-Start/PostgreSQL-Grenze, Redis/BullMQ, explizites
  Publish-Modell, Hub-Föderation, Short-Code-Pairing und API-/Worker-Trennung.
- [x] Halte fest, dass Renderer nur Snapshots lesen und keine Provider abfragen.
- [x] Halte fest, dass dauerhafter Fachzustand nicht nur in RAM/Queue lebt.
- [x] Markiere offene Hardwaredetails als Annahme, nicht als feste Wahrheit.
- [x] Verlinke ADRs aus Architekturplan und README-Dokumentation.

**Abnahme:** Jede spätere Designfrage kann auf eine konkrete Entscheidung oder eine
explizit offene ADR verweisen.

**Validierung:** Linkprüfung und Review auf Widersprüche zum Architekturplan.

**Handoff:** ADR-Nummern und noch offene Entscheidungen notieren.

### Abschluss WP-02

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Ein versioniertes ADR-Verzeichnis mit Template, Statuskonventionen und
  Index wurde angelegt. ADR-001 bis ADR-007 dokumentieren verbindlich die
  SQLite-/PostgreSQL-Grenze, Redis/BullMQ, das Publish-Modell, Hub-Föderation,
  Short-Code-Pairing, API-/Worker-Trennung und Snapshot-only-Rendering. ADR-008 bis
  ADR-010 halten bewusst offene Annahmen und Entscheidungen fest. Architekturplan
  und Projekt-README verlinken den ADR-Index.
- Geänderte Kernpfade: `docs/architecture/adr/`,
  `docs/architecture/ARCHITECTURE_PLAN.md`, `README.md` und
  `docs/architecture/WORK_PACKAGES.md`.
- Ausgeführte Tests: repositoryweite Prüfung von 21 Markdown-Dateien und 28
  relativen Links; Struktur- und Indexprüfung aller zehn Entscheidungs-ADRs;
  automatisierte Stichwortprüfung der verbindlichen WP-02-Kernaussagen; manueller
  Widerspruchsreview gegen die für WP-02 relevanten Abschnitte des
  Architekturplans; Trailing-Whitespace-Prüfung der ADRs und `git diff --check`.
  Alle Prüfungen waren grün.
- Nicht ausführbare Tests und Grund: keine; produktive Build- und Laufzeittests
  waren wegen des reinen Dokumentationsscopes nicht erforderlich.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: ADR-008 lässt ESP32-Hardwaredetails,
  ESP32-Repositorygrenze und das minimale TRMNL-Refresh-Intervall bis zu realen
  Messungen offen. ADR-009 lässt die Richtlinie für lokales HTTP-Pairing bis zum
  Provisioning-Smoke-Test und Threat-Model-Review offen. ADR-010 lässt die konkrete
  Isolation von Drittanbieter-Erweiterungen bis zum adversarialen Test offen.
  Quantitative SQLite-Betriebsgrenzen sind noch im Last-/Betriebspaket festzulegen.
- Relevante Hinweise für WP-03: Netzwerk- und Domänenverträge müssen die
  versionierten Grenzen aus ADR-003 bis ADR-005 und ADR-007 ausdrücken und dürfen
  weder Providerzugriffe im Renderer noch dauerhaften Fachzustand in RAM oder Queue
  voraussetzen. Hardwarewerte bleiben Capabilities/Profile statt Produktkonstanten.
- Git-Stand/Commit: Bestandteil dieses WP-02-Commits auf Branch
  `codex/device-platform-spike`.

## WP-03 – Gemeinsamen Contracts-Bereich einrichten

**Ziel:** Netzwerk- und Domänenverträge liegen frameworkunabhängig an einer Stelle
und können von Backend, Frontend und später Firmware-Tools genutzt werden.

**Kontext:** Typen sind derzeit zwischen Frontend, Backend und WebDisplay lokal
dupliziert.

**Voraussetzungen:** WP-02.

**Scope:** Paket-/Ordnerstruktur, Build, Exports und Test-Harness; noch keine
vollständigen Fachverträge.

**Aufgaben:**

- [x] Wähle gemäß ADR einen `contracts`-Bereich innerhalb des bestehenden Projekts.
- [x] Richte TypeScript-Build ohne NestJS-, React- oder Prisma-Abhängigkeit ein.
- [x] Definiere Regeln für reine Typen, Laufzeitvalidierung und JSON-kompatible
  Werte.
- [x] Stelle Imports aus Backend und Frontend über einen stabilen Paketnamen bereit.
- [x] Lege Contract-Fixtures und einen Test-Harness an.
- [x] Migriere einen kleinen bestehenden Typ als Durchstich, ohne APIs zu brechen.

**Abnahme:** Backend und Frontend importieren denselben Beispielvertrag und alle
Builds bleiben grün.

**Validierung:** Contracts-Build, Backend-/Frontend-Typecheck und Fixture-Test.

**Handoff:** Paketpfad, Importname und Konventionen notieren.

### Abschluss WP-03

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Unter `contracts/` steht das eigenständige TypeScript-Paket
  `@inker/contracts` mit ESM-/CJS-Ausgabe und Deklarationen bereit. Reine Typen,
  seiteneffektfreie Laufzeitvalidatoren und die zulässige JSON-Wertemenge sind
  dokumentiert und getestet. `DeviceStatus` wurde als kleiner kompatibler
  Durchstich zentralisiert; Backend und Frontend importieren denselben Vertrag.
- Geänderte Kernpfade: `contracts/`, `backend/package.json`, `backend/bun.lock`,
  `backend/src/devices/entities/device.entity.ts`, `frontend/package.json`,
  `frontend/bun.lock`, `frontend/src/types/index.ts`, `Dockerfile`,
  `.github/workflows/ci.yml` und `docs/architecture/WORK_PACKAGES.md`.
- Ausgeführte Tests: Contracts-Frozen-Lock-Prüfung, Contracts-Typecheck, sieben
  Contract-/Fixture-Tests in zwei Dateien, Contracts-ESM-/CJS-Build und Import-
  Smokes für beide Ausgabeformate; Backend-Typecheck und -Build; Frontend-
  Typecheck und -Build; Frozen-Lock-Prüfung der beiden Consumer-Lockfiles,
  `docker compose config --quiet` und `git diff --check`. Alle genannten
  Prüfungen waren grün.
- Nicht ausführbare Tests und Grund: `docker build --check .` konnte nicht gegen
  Docker Desktop ausgeführt werden, weil die lokale Linux-Engine nicht gestartet
  ist. Der CI- und Docker-Buildpfad baut Contracts vor den beiden Consumern.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Das Contracts-Paket muss vor Backend und Frontend gebaut
  werden; CI und Dockerfile erzwingen diese Reihenfolge. Bun 1.3.14 konnte die
  lokale `file:`-Abhängigkeit im verwalteten Windows-Sandbox nicht direkt nach
  `node_modules` kopieren (`EPERM`); Lockfiles wurden frozen geprüft und die
  lokalen Consumer-Prüfungen über äquivalente Junctions ausgeführt. Vollständige
  versionierte Fachverträge bleiben bewusst Scope von WP-04.
- Relevante Hinweise für WP-04: Paketpfad ist `contracts/`, stabiler Importname
  `@inker/contracts`. Neue Verträge bleiben frameworkfrei, nehmen an
  Laufzeitgrenzen `unknown` entgegen und verwenden ausschließlich `JsonValue`-
  kompatible Felder; repräsentative JSON-Fixtures gehören in `contracts/fixtures/`
  und werden im Harness validiert. `DeviceStatus` ist der unversionierte
  Kompatibilitätsdurchstich, nicht bereits das Kernvertragsschema von WP-04.
- Git-Stand/Commit: nicht committed; Branch `codex/device-platform-spike`.

## WP-04 – Versionierte Kernverträge definieren

**Ziel:** Die drei Zielgeräte und zukünftige Daten-/Interaktionspfade lassen sich
ohne konkrete Widgettypen beschreiben.

**Kontext:** Lies `ARCHITECTURE_PLAN.md`, Abschnitte 3, 4 und 6.

**Voraussetzungen:** WP-03.

**Scope:** DeviceProfile, Capabilities, DeliveryPolicy, PresentationManifest,
SourceSnapshot, InteractionEvent und CommandResult inklusive Laufzeitvalidierung.

**Aufgaben:**

- [x] Definiere `protocolVersion` und Kompatibilitätsregeln.
- [x] Modelliere Display-, Transport-, Energie- und Interaction-Capabilities
  getrennt.
- [x] Lege Profile-Fixtures für Batterie-TRMNL, Netz-TRMNL, ESP32-Touch und
  Pi-Browser an.
- [x] Definiere ein widgetneutrales PresentationManifest mit Artefakten,
  Revision, Refresh-Hinweisen und erlaubten Aktionen.
- [x] Definiere SourceSnapshot sowie InteractionEvent/CommandResult minimal.
- [x] Ergänze Parser-/Validatoren mit verständlichen Fehlern.
- [x] Teste gültige, unbekannte und inkompatible Protokollversionen.

**Abnahme:** Alle vier Betriebsvarianten bestehen Contract-Tests; kein Vertrag
importiert React, NestJS, Prisma oder einen Widgettyp.

**Validierung:** Unit-/Fixture-Tests und Typechecks aller Consumer.

**Handoff:** Vertragsschemas, Version und bewusst vertagte Felder notieren.

### Abschluss WP-04

- Status: abgeschlossen am 2026-08-24
- Ergebnis: `@inker/contracts` stellt den Kernvertragssatz `1.0` für
  `DeviceProfile`, getrennte Display-/Transport-/Energie-/Interaction-
  Capabilities, `DeliveryPolicy`, `PresentationManifest`, `SourceSnapshot`,
  `InteractionEvent` und `CommandResult` bereit. Parser liefern strukturierte
  Fehler mit Code, JSON-Pfad und Meldung. Version `1.0` ist unterstützt; eine
  unbekannte Minor-Version derselben Major-Linie wird mit Warnung angenommen,
  eine andere Major-Version oder ungültige Syntax abgelehnt.
- Geänderte Kernpfade: `contracts/src/`, `contracts/fixtures/`,
  `contracts/test/core-contracts.test.ts`,
  `contracts/test/package-boundary.test.ts`, `contracts/README.md` und
  `docs/architecture/WORK_PACKAGES.md`.
- Ausgeführte Tests: Contracts-Typecheck; 23 Contract-/Fixture-Tests in drei
  Dateien, darunter alle vier Gerätevarianten sowie aktuelle, unbekannte Minor-,
  inkompatible Major- und ungültige Protokollversionen; ESM-/CJS-Contracts-Build
  und Export-Smokes; Backend-Typecheck und -Build; Frontend-Typecheck und -Build;
  statischer Framework-/Widget-Grenzscan und `git diff --check`. Alle Prüfungen
  waren grün.
- Nicht ausführbare Tests und Grund: keine.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Das ESP32-480×480-Profil sowie Poll-, Refresh- und
  E-Ink-Werte bleiben ausdrücklich Referenz-Fixtures statt verifizierter
  Produktdefaults. Parser tolerieren unbekannte Felder bei kompatiblen Minor-
  Versionen; die Nutzung neuer Features erfordert spätere Capability-
  Negotiation. `credentialId` referenziert nur das Transport-Credential; konkrete
  Autorisierung und Idempotenzpersistenz folgen in den vorgesehenen Paketen.
- Relevante Hinweise für WP-06/WP-13/WP-14/WP-21/WP-23: Kernversion ist `1.0`;
  alle Laufzeitgrenzen nehmen `unknown` an und liefern `ParseResult<T>`. Geräte-
  Persistenz referenziert `profileId` und hält Energie/Delivery getrennt.
  Manifeste bleiben widgetneutral und read-only, Renderer erhalten nur
  `SourceSnapshot.data`, und Interaction-Payloads sind JSON-Objekte ohne
  beliebige Serveraufrufe.
- Git-Stand/Commit: nicht committed; Branch `codex/device-platform-spike`,
  auf Basis des WP-03-Commits `24f5e44`.

## WP-05 – Prisma-Migrationsbaseline schaffen

**Ziel:** Schema-Upgrades sind reproduzierbar, getestet und stoppen den Start bei
Fehlern.

**Kontext:** Inker verwendet aktuell `prisma db push`; Fehler im Containerstart
werden nur gewarnt. Es gibt noch kein Migrationsverzeichnis.

**Voraussetzungen:** WP-01 und WP-02.

**Scope:** Baseline-Migration, Migrationsbefehle, Containerstart und Upgrade-Test.
Keine fachliche Neumodellierung über den aktuellen Schema-Stand hinaus.

**Aufgaben:**

- [x] Sichere ein anonymisiertes Testabbild des aktuellen Schemas.
- [x] Erzeuge eine nachvollziehbare Baseline für leere und bestehende Datenbanken.
- [x] Stelle Startskripte auf `prisma migrate deploy` um.
- [x] Entferne das Verschlucken von Migrationsfehlern.
- [x] Konfiguriere SQLite WAL, Busy Timeout und dokumentierte Backup-Regeln.
- [x] Ergänze Tests für Neuinstallation, Upgrade, Fehlerfall und erneuten Start.

**Abnahme:** Eine frische und eine bestehende Testdatenbank erreichen dasselbe
Schema; eine fehlerhafte Migration verhindert Readiness.

**Validierung:** Automatisierter Migrationstest plus Docker-Smoke-Test.

**Handoff:** Baseline-ID, Upgradepfad und Backuphinweis notieren.

### Abschluss WP-05

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Prisma Migrate ersetzt in beiden Containerstartpfaden `prisma db push`.
  Die Baseline `20260824000000_inker_0_6_0_baseline` bildet den veröffentlichten
  Inker-0.6.0-Stand ab; `20260824001000_device_platform_schema` übernimmt ohne
  fachliche Erweiterung die bereits im Fork vorhandenen Device-Platform-Felder.
  Unverwaltete Bestandsdatenbanken werden vor dem Eintragen der Historie exakt
  gegen diese bekannten Zustände geprüft. Unbekannter Drift oder eine fehlerhafte
  Migration stoppt den Backendstart und damit Readiness.
- Upgradepfad: Leere Datenbanken führen beide Migrationen aus. Exakte
  0.6.0-Datenbanken markieren nur die Baseline als angewandt und führen danach die
  Device-Platform-Migration aus. Bereits per `db push` aktualisierte Datenbanken
  übernehmen beide Historieneinträge ohne erneutes DDL. Alle künftigen Änderungen
  benötigen eine neue Vorwärtsmigration; vorhandene Migrationen dürfen nicht
  verändert werden.
- Backuphinweis: Vor jedem Upgrade den Container stoppen und das vollständige
  `/app/uploads`-Volume sichern. Eine laufende WAL-Datenbank darf nicht durch das
  alleinige Kopieren von `inker.db` gesichert werden. Restore und Rollback sind in
  `docs/operations/DATABASE_BACKUP.md` dokumentiert.
- Geänderte Kernpfade: `backend/prisma/migrations/`,
  `backend/scripts/migrate-database.ts`, `backend/test/`,
  `backend/src/prisma/prisma.service.ts`, `backend/docker-entrypoint.sh`,
  `docker/services.d/backend/run`, `Dockerfile`, `.gitattributes`,
  `.github/workflows/ci.yml`, `docs/operations/DATABASE_BACKUP.md`, `README.md` und
  `backend/package.json`.
- Ausgeführte Tests: Backend-Typecheck; 443 bestehende Backendtests in 36 Dateien;
  vier automatisierte Migrationstests für Neuinstallation, Neustart, anonymisiertes
  0.6.0-Upgrade, Übernahme des aktuellen `db push`-Schemas und ungültiges SQL;
  zusätzlicher Datamodel-Diff; Backend-Build; `prisma validate`;
  `docker compose config --quiet`; vollständiger Docker-Image-Build einschließlich
  Frontend-Build; positiver Docker-Smoke mit interner `/ready`-Antwort 200 und
  gesundem Container; negativer Docker-Smoke mit Prisma `P3018`, blockiertem
  Health-/Readiness-Pfad und nicht gestarteter Anwendung; `git diff --check`. Alle
  genannten Prüfungen waren grün.
- Nicht ausführbare Tests und Grund: keine.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Die automatische Übernahme ist absichtlich auf die beiden
  getesteten, exakt passenden Bestandszustände begrenzt; abweichende manuelle
  Schemata blockieren den Start und müssen aus einer Sicherung untersucht werden.
  Prisma warnt weiterhin vor der in Prisma 7 entfallenden
  `package.json#prisma`-Konfiguration; deren Umstellung ist nicht Teil von WP-05.
- Relevante Hinweise für WP-06: Eine Schemaänderung ist ausschließlich als neue
  Migration nach `20260824001000_device_platform_schema` zulässig. Die Baseline und
  der getestete Übernahmepfad sind unveränderlich; WP-06 muss seine Migrationsfälle
  sowohl auf einer frisch migrierten als auch auf einer Bestandsdatenbank ergänzen.
- Git-Stand/Commit: Branch `codex/device-platform-spike`; Arbeitsbaum enthält die
  uncommittierten WP-05-Änderungen. Es wurde kein Commit und kein Push erstellt.

## WP-06 – Device-, Profile- und Credential-Schema bereinigen

**Ziel:** Geräteprofil, Geräteinstanz, Policy, Capabilities-Override und Credentials
sind eindeutig persistiert.

**Kontext:** Das aktuelle Schema speichert Auflösung und Fähigkeiten teilweise
doppelt und verwendet freie Strings für Typ und Transport.

**Voraussetzungen:** WP-04 und WP-05.

**Scope:** Prisma-Modelle, Migration, Seed, Serialisierung und zugehörige Tests.

**Aufgaben:**

- [x] Entwirf `DeviceProfile`, `Device`, `DeviceCredential` und DeliveryPolicy
  entsprechend den Contracts.
- [x] Definiere klare Defaults und geprüfte Zustände.
- [x] Lege fest, welche Felder aus dem Profil stammen und wie Overrides funktionieren.
- [x] Migriere bestehende TRMNL- und Web-Display-Daten verlustfrei.
- [x] Aktualisiere Seed, DTOs, Serialisierung und Testmocks.
- [x] Entferne oder depreziere widersprüchliche Legacyfelder kontrolliert.
- [x] Ergänze Roundtrip- und Migrationsfälle für alle Zielprofile.

**Abnahme:** Aus jedem Gerät entsteht genau eine effektive Capability-Sicht; Profil
und Override können nicht still auseinanderlaufen.

**Validierung:** Prisma-, Service-, Serialisierungs- und Migrationstests.

**Handoff:** Neues Schema, Legacy-Kompatibilität und spätere Cleanup-Felder notieren.

### Abschluss WP-06

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Die neue Vorwärtsmigration
  `20260824002000_normalize_device_profiles_credentials` persistiert drei
  versionierte `DeviceProfile`-Definitionen und vier getrennte
  `DeliveryPolicy`-Definitionen gemäß `@inker/contracts`. Jedes `Device`
  referenziert verpflichtend genau ein Profil und eine Policy und speichert nur
  einen geprüften partiellen `capabilitiesOverride`; die effektive
  `DeviceCapabilities`-Sicht entsteht an einer gemeinsamen Laufzeitgrenze aus
  Profildefault und Override. Identitäts-/Protokollfelder und unbekannte
  Legacy-Keys sind nicht überschreibbar, inkompatible Profile, Policies,
  Energiequellen und Transporte werden abgelehnt. `DeviceCredential` besitzt
  zusätzlich eine stabile `credentialId` und ein optionales Ablaufdatum; Token
  bleiben ausschließlich gehasht und Hashes werden nicht serialisiert.
- Legacy-Kompatibilität: Bestehende TRMNL-Datensätze werden auf
  `trmnl-byod-7.5-mono`/`reference-sleepy`, Web-Displays auf
  `browser-hd-1920x1080`/`reference-connected-browser` abgebildet. Auflösung,
  Farbraum, Bit-Tiefe und PNG-/BMP-Format vorhandener `Model`-Zuordnungen werden
  als explizite Display-Overrides übernommen; Browser-Viewport-Overrides und
  bestehende gehashte Web-Display-Credentials bleiben erhalten. Die alte 0.6.0-
  Datenbank, der frühere Device-Platform-`db push`-Stand, eine Neuinstallation und
  ein Neustart erreichen dasselbe Prisma-Datamodel. Die Migrationen
  `20260824000000_inker_0_6_0_baseline` und
  `20260824001000_device_platform_schema` wurden nicht verändert.
- Geänderte Kernpfade: `backend/prisma/schema.prisma`,
  `backend/prisma/migrations/20260824002000_normalize_device_profiles_credentials/`,
  `backend/prisma/seed.ts`, `backend/src/device-platform/device-configuration*`,
  `backend/src/devices/`, `backend/src/api/setup/`,
  `backend/test/migrations.integration.ts`, `backend/scripts/migrate-database.ts`
  und `docs/architecture/WORK_PACKAGES.md`.
- Ausgeführte Tests: `prisma validate`; Backend-Typecheck; gezielter ESLint-Lauf
  über alle geänderten WP-06-Produktionsdateien; 454 Backendtests in 37 Dateien;
  neun Device-Konfigurations-/Roundtripfälle für Batterie-TRMNL, Netz-TRMNL,
  ESP32-Touch und Pi-Browser einschließlich inkompatibler Zustände und genau einer
  serialisierten effektiven Capability-Sicht; vier Migrationstests für
  Neuinstallation/Neustart, 0.6.0-Upgrade, Übernahme des bisherigen
  Device-Platform-Schemas und fehlerhafte Migration, jeweils einschließlich
  Datamodel- und Fremdschlüsselprüfung; zweimaliger Seed-Lauf gegen eine neue
  Datenbank mit anschließend bestätigten drei Profilen und vier Policies;
  Backend-Build; Contracts-Typecheck, 23 Contracttests und ESM-/CJS-Build;
  Frontend-Typecheck und -Build; `git diff --check`. Alle paketbezogenen Prüfungen
  waren grün.
- Nicht ausführbare Tests und Grund: keine. Der repositoryweite Befehl
  `bun run lint` ist weiterhin kein grünes Baseline-Gate: Die bestehende
  ESLint-Projektkonfiguration schließt Testdateien aus dem TypeScript-Projekt aus
  und meldet zusätzlich bereits vorhandene Fehler in nicht von WP-06 geänderten
  Produktionsdateien. Der auf alle geänderten WP-06-Produktionsdateien begrenzte
  ESLint-Lauf war grün.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Die Spalten `device_type`, `transport`, `capabilities`,
  `configuration`, `width`, `height` und das TRMNL-`api_key` bleiben kontrolliert
  deprecated und werden für bestehende Protokoll-/UI-Pfade gespiegelt; fachlich
  maßgeblich sind Profil, Policy und Override. `Model` bleibt bis zur Adapter-
  Trennung die Legacy-Quelle konkreter TRMNL-Renderformate. Bestehende TRMNL-
  API-Keys bleiben zur Firmware-Kompatibilität im bisherigen Klartext-Lookup;
  neue Browser-Credentials liegen nur gehasht in `DeviceCredential`. Das ESP32-
  Profil bleibt gemäß ADR-008 eine unverifizierte Referenzannahme. Die bereits in
  WP-05 dokumentierte Prisma-7-Warnung zur `package.json#prisma`-Konfiguration
  bleibt bestehen.
- Relevante Hinweise für WP-09/WP-13: Pairing und Geräteauthentisierung sollen
  `Device.profileId`, die stabile `DeviceCredential.credentialId` und gehashte
  Tokens verwenden; Credential-Hashes dürfen keine DTO-Grenze überschreiten.
  TransportAdapter und DeliveryPolicy müssen die effektive Capability-Sicht aus
  `device-configuration.ts` nutzen. WP-13 kann danach die gespiegelt gehaltenen
  Legacyfelder sowie die verbleibende `Model`-/Profil-Überlappung gezielt abbauen.
- Git-Stand/Commit: Bestandteil dieses WP-06-Abschlusscommits auf Branch
  `codex/device-platform-spike`, auf Basis von `6aa1005`. Es wurde kein Push
  erstellt.

## WP-07 – Publication-, Outbox- und Zustandsmodelle persistieren

**Ziel:** Veröffentlichungen, fachliche Ereignisse und gewünschter Gerätezustand
haben dauerhafte Quellen der Wahrheit.

**Kontext:** Der aktuelle WebSocket-Spike erzeugt Präsentationen direkt aus dem
Entwurfszustand und hält Übergangstimer im RAM.

**Voraussetzungen:** WP-04 und WP-05.

**Scope:** Datenmodelle und Basis-Repositories/Services, noch keine vollständige
Delivery- oder Renderlogik.

**Aufgaben:**

- [x] Modelliere unveränderliche Publication und PublicationRevision.
- [x] Modelliere gewünschte/zuletzt bestätigte Geräterevision getrennt.
- [x] Modelliere OutboxEvent mit Status, Attempts, Zeitpunkt und Payload-Version.
- [x] Definiere atomare Serviceoperationen für Fachänderung plus Outbox-Eintrag.
- [x] Ergänze Indizes, Aufbewahrung und Cleanup-Regeln.
- [x] Erstelle Migration, Tests und minimale Admin-/Debug-Abfragen.

**Abnahme:** Eine fachliche Änderung und ihr Event werden atomar gespeichert; ein
Neustart verliert den ausstehenden Event nicht.

**Validierung:** Transaktions-, Rollback-, Restart- und Schema-Tests.

**Handoff:** Eventtypen, Retention und noch nicht angeschlossene Producer notieren.

### Abschluss WP-07

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Die neue Vorwärtsmigration
  `20260824003000_publication_outbox_state` ergänzt unveränderliche
  `Publication`-Identitäten und append-only `PublicationRevision`-Snapshots.
  Datenbanktrigger verhindern Änderungen an beiden Historientabellen; alte,
  unreferenzierte Revisionen dürfen ausschließlich durch die definierte Retention
  gelöscht werden. `DevicePublicationState` hält gewünschte und zuletzt
  bestätigte Revision samt getrennten Zeitpunkten und Fremdschlüsseln auseinander,
  sodass eine Bestätigung bewusst hinter dem Sollzustand zurückliegen kann.
  `OutboxEvent` persistiert Status, Attempts, Verfügbarkeit, Ereignis-/Versuchs-/
  Abschlusszeit, versioniertes JSON-Payload und Diagnosefehler mit passenden
  Status-, Aggregat- und Zeitindizes.
- Atomare Operationen und Debug-Grenze: `PublicationPersistenceService` legt eine
  Publication mit erster Revision an, hängt Revisionen an, setzt die gewünschte
  Geräterevision und bestätigt eine Geräterevision. Jede Fachänderung und ihr
  Outbox-Ereignis werden in derselben kurzen Prisma-Transaktion gespeichert.
  Read-only-Abfragen liefern Publications mit Revisionen, den Gerätezustand,
  gefilterte/begrenzte Outbox-Ereignisse und Statuszähler für Admin-/Debug-Code.
- Eventtypen und Payload-Version: `publication.revision.created`,
  `device.publication.desired-revision.changed` und
  `device.publication.revision.acknowledged`, jeweils Payload-Version `1`.
  Neue Ereignisse starten mit Status `pending`, `attempts = 0` und identischem
  Ereignis-/Verfügbarkeitszeitpunkt. Zulässige Zustände sind `pending`,
  `processing`, `delivered` und `dead-letter`.
- Retention/Cleanup: `delivered`-Events werden 30 Tage, `dead-letter`-Events 90
  Tage aufbewahrt. `pending` und `processing` werden nie zeitbasiert gelöscht.
  Unreferenzierte Publication-Revisionen dürfen nach 90 Tagen entfernt werden;
  die jeweils neueste sowie gewünschte oder bestätigte Revisionen bleiben immer
  erhalten. Publication-Identitäten werden nicht automatisch gelöscht. Die
  Regeln sind als Konstanten und explizit aufrufbarer, transaktionaler
  `PublicationCleanupService` umgesetzt; zeitliche Einplanung gehört zur späteren
  Maintenance-/Worker-Anbindung.
- Geänderte Kernpfade: `backend/prisma/schema.prisma`,
  `backend/prisma/migrations/20260824003000_publication_outbox_state/`,
  `backend/src/publications/`, `backend/src/app.module.ts`,
  `backend/src/test/mocks/prisma.mock.ts`,
  `backend/test/publication-persistence.integration.ts`,
  `backend/test/migrations.integration.ts` und
  `docs/architecture/WORK_PACKAGES.md`. Die Migrationen
  `20260824000000_inker_0_6_0_baseline`,
  `20260824001000_device_platform_schema` und
  `20260824002000_normalize_device_profiles_credentials` wurden nicht verändert.
- Ausgeführte Tests: `prisma validate`; Backend-Typecheck; gezielter ESLint-Lauf
  über alle geänderten WP-07-Produktionsdateien; fünf reale SQLite-
  Integrationsfälle für atomaren Write, erzwungenen Rollback, getrennten Soll-/
  Bestätigungszustand, Retention/Schutz referenzierter Revisionen und Restart-
  Persistenz; vier Migrationstests für Neuinstallation/Neustart, 0.6.0-Upgrade,
  Übernahme des bisherigen Device-Platform-Schemas und fehlerhafte Migration,
  jeweils mit Datamodel-Diff sowie ergänzter Index-/Triggerprüfung; 454 bestehende
  Backendtests in 37 Dateien; Backend-Build und `git diff --check`. Alle
  paketbezogenen Prüfungen waren grün.
- Nicht ausführbare Tests und Grund: keine. Die bekannte Prisma-7-Warnung zur
  `package.json#prisma`-Konfiguration bleibt unverändert und außerhalb von WP-07.
- Bewusste Abweichungen vom Paket: keine.
- Noch nicht angeschlossene Producer/Folgearbeit: Die bestehenden Draft-, Screen-,
  Playlist-, WebSocket- und Legacy-`presentationRevision`-Pfade schreiben noch
  nicht in diese Modelle. Der vollständige explizite Publish-/Manifest-Pfad folgt
  in WP-17, die Delivery-Anbindung in WP-14 und Outbox-Dispatch, Statusübergänge,
  Retry/Deduplizierung sowie Maintenance-Scheduling in WP-16. WP-07 startet weder
  BullMQ-Jobs noch Render- oder Deliverylogik.
- Neue Risiken/Schulden: `PublicationRevision.content` ist bewusst ein
  versionierter, persistierter JSON-Snapshot als Basisgrenze; seine vollständige
  Publish-Validierung und Manifest-Zusammensetzung folgen in WP-17. Gleichzeitige
  Revisionserzeugung wird durch den eindeutigen `(publication_id, revision)`-
  Index sicher abgewiesen; ein fachlicher Idempotenz-/Retryvertrag ist Aufgabe des
  späteren Publish-Pfads.
- Git-Stand/Commit: Bestandteil dieses WP-07-Abschlusscommits auf Branch
  `codex/device-platform-spike`, auf Basis des WP-06-Commits `6399dcb`. Es wurde
  kein Push erstellt.

## WP-08 – Browser-Credential-Lebenszyklus reparieren

**Ziel:** Ein Web-Display kann nach Widerruf oder neuem Pairing-Link ohne manuelles
Löschen des Browser-Storage erneut gekoppelt werden.

**Kontext:** `WebDisplay.tsx` ignoriert `?pair=`, sobald ein altes Credential im
`localStorage` liegt. WebSocket-Code `4401` entfernt das ungültige Credential nicht.

**Voraussetzungen:** WP-01. Dieses Paket darf vor WP-06 als isolierter Bugfix
bearbeitet werden.

**Scope:** Bestehender Browser-Pairingflow und Tests; noch kein Short-Code-Pairing.

**Aufgaben:**

- [x] Schreibe zuerst Tests für neues Pairing trotz vorhandenem Credential.
- [x] Gib einem expliziten Pairing-Token Vorrang vor lokalem Credential.
- [x] Ersetze Storage erst nach erfolgreichem Pairing atomar.
- [x] Entferne widerrufene Credentials bei eindeutiger Auth-Ablehnung.
- [x] Verhindere Endlosschleifen und versehentliches Löschen bei Netzfehlern.
- [x] Bereinige Pairing-Parameter aus URL und Browserhistorie.

**Abnahme:** Rotation, abgelaufener Link, Netzfehler und `4401` besitzen getestete,
verständliche Zustände.

**Validierung:** Frontend-Komponenten-/Hook-Tests und manueller Browser-Smoke-Test.

**Handoff:** Storageformat und Migrationsverhalten für WP-10 notieren.

### Abschluss WP-08

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Ein expliziter bestehender `?pair=`-Token hat nun unabhängig von einem
  vorhandenen Browser-Credential Vorrang. Während des Pairings wird das alte
  Credential weder für WebSocket-Authentisierung verwendet noch vorzeitig
  überschrieben. Erst eine erfolgreiche Pairing-Antwort ersetzt den Storagewert
  und startet die Verbindung mit dem neuen Credential. Abgelaufene Links und
  Netzfehler zeigen einen stabilen Fehlerzustand, behalten aber das zuvor gültige
  Credential. Nur die eindeutige WebSocket-Ablehnung `4401` beendet den
  Reconnectpfad und entfernt wertgenau das abgelehnte Credential; ein inzwischen
  anderweitig rotierter Storagewert wird nicht gelöscht. Der Parameter `pair`
  wird vor dem Request per `history.replaceState` aus dem aktuellen
  History-Eintrag entfernt, während andere Query-Parameter und der Hash erhalten
  bleiben.
- Geänderte Kernpfade: `frontend/src/pages/display/WebDisplay.tsx`,
  `frontend/src/pages/display/WebDisplay.test.tsx` und
  `docs/architecture/WORK_PACKAGES.md`. Backend, Prisma-Schema und alle
  vorhandenen Migrationen blieben unverändert.
- Ausgeführte Tests: Testgetriebener Red-Lauf vor der Produktionsänderung mit vier
  erwarteten Fehlern und einem bereits grünen Netz-Reconnectfall; danach fünf
  gezielte Credential-Lebenszyklustests grün. Frontend-Typecheck, gezielter
  read-only ESLint-Lauf für `WebDisplay.tsx`, vollständige Frontend-Suite mit 26
  Tests in fünf Dateien und Produktionsbuild waren grün. `git diff --check` und
  die explizite Diffprüfung der vier bestehenden Migrationen waren ebenfalls
  grün. Der manuelle Browser-Smoke-Test lief mit dem echten Vite-Frontend und
  NestJS-/WebSocket-Backend gegen eine isolierte, anschließend entfernte
  SQLite-Datenbank: Erstkopplung, Rotation trotz vorhandenem Credential,
  abgelaufener Link mit erfolgreichem Reload, echter Backend-Ausfall mit
  erfolgreichem Reload sowie serverseitiger Widerruf mit `4401` und dauerhaftem
  Unpaired-Zustand waren erfolgreich; Pairing-Parameter waren in allen sichtbaren
  Ergebnis-URLs entfernt.
- Nicht ausführbare Tests und Grund: keine. Docker wurde nicht benötigt; die lokal
  installierte Docker-Desktop-Engine war nicht verfügbar, der vorgeschriebene
  Browser-Smoke-Test wurde vollständig mit den echten lokalen Prozessen
  ausgeführt.
- Bewusste Abweichungen vom Paket: keine. Insbesondere wurden weder
  Short-Code-Pairing noch WP-09-/WP-10-Endpunkte oder -UI implementiert.
- Neue Risiken/Schulden: Pairing-Fehler halten den expliziten Pairingversuch für
  die aktuelle Seiteninstanz bewusst im Vordergrund. Ein Reload ohne den bereits
  bereinigten Parameter verwendet das unverändert gespeicherte alte Credential;
  eine spätere Pairing-UI kann dafür eine explizite Wiederholungsaktion anbieten.
- Relevante Hinweise für WP-10: Das Browser-Storageformat bleibt unverändert:
  Schlüssel `inker_display_<externalId>`, Wert ein opakes langes
  Geräte-Credential. Für WP-10 ist deshalb keine Storage-Migration erforderlich.
  Der Short-Code-Flow muss nach erfolgreichem Austausch denselben atomaren
  Credential-Wechsel verwenden und darf den alten Wert bei Codeablauf,
  Validierungs- oder Netzfehlern nicht löschen. Der Bootstrap-Parameter wird aus
  URL und aktuellem History-Eintrag entfernt; dauerhafte Credentials dürfen weder
  in URL/QR-Code noch über DTO-Grenzen zurück zum Admin-UI gelangen.
- Git-Stand/Commit: Bestandteil dieses WP-08-Abschlusscommits auf Branch
  `codex/device-platform-spike`, auf Basis von `528c568`. Es wurde kein Push
  erstellt.

## WP-09 – Short-Code-Pairing im Backend implementieren

**Ziel:** Ein Gerät tauscht Basis-URL plus zehnstelligen Einmalcode gegen ein
langes, widerrufbares Credential.

**Kontext:** Lies `ARCHITECTURE_PLAN.md`, Abschnitt 7. Der kurze Code ist nur
Bootstrap, zehn Minuten gültig, gehasht, einmalig und rate-limitiert.

**Voraussetzungen:** WP-06 und WP-08.

**Scope:** Enrollment-Modell, Service, Admin-/Device-Endpunkte, atomarer Austausch,
Rate Limits und Tests. Keine UI.

**Aufgaben:**

- [x] Implementiere kryptografisch zufällige Crockford-Base32-Codes mit
  normalisierter Eingabe.
- [x] Speichere nur Hash, Ablauf, Verwendungsstatus und Versuchszähler.
- [x] Erzeuge Enrollment nur über Adminberechtigung.
- [x] Tausche gültigen Code atomar gegen ein hochentropisches DeviceCredential.
- [x] Begrenze Credentialrechte auf das betreffende Gerät.
- [x] Implementiere Rotation, Replay-Schutz und konstante Fehlerantworten.
- [x] Ergänze Rate-Limit-, Parallel-, Ablauf- und Entropietests.

**Abnahme:** Derselbe Code kann auch bei parallelen Requests nur einmal erfolgreich
verwendet werden; die Datenbank enthält weder Code noch Klartext-Credential.

**Validierung:** Unit-, Integration-, Race- und API-Tests.

**Handoff:** Endpunkte, DTOs, TTL und UI-Anforderungen für WP-10 notieren.

### Abschluss WP-09

- Status: abgeschlossen am 2026-08-24
- Ergebnis: Die neue Vorwärtsmigration
  `20260824004000_device_enrollments` ergänzt ein gerätegebundenes
  `DeviceEnrollment` mit ausschließlich `codeHash`, Ablaufzeit, `usedAt`,
  persistentem Versuchszähler und Zeitstempeln. Zehn kryptografisch zufällige,
  unverzerrte Crockford-Base32-Zeichen liefern 50 Bit Bootstrap-Entropie; Eingaben
  werden ohne Beachtung von Groß-/Kleinschreibung und manuellen Trennzeichen
  normalisiert, einschließlich der Crockford-Aliasse O/I/L. Der Service hält immer
  nur ein unverbrauchtes Enrollment pro Gerät und tauscht es per serialisierbarer
  Datenbanktransaktion genau einmal gegen ein zufälliges 48-Byte-Base64url-
  Credential. Dabei werden alle bisherigen Credentials desselben Geräts atomar
  widerrufen. Ein Insertfehler rollt Codeverbrauch, Versuchszähler und Widerruf
  vollständig zurück. Weder Klartextcode noch Klartext-Credential werden
  persistiert; generische Device-Serialisierung entfernt zusätzlich Enrollment-
  und Credential-Hashes.
- Endpunkte und DTOs: `POST /api/devices/:deviceId/enrollments` ist eine
  admin-geschützte Control-Plane-Route ohne Request-Body. Die einmalige Antwort
  enthält `enrollmentId`, `deviceId`, formatierten `code`, `expiresAt` und
  `createdAt`, aber weder Credential noch Hash. Der öffentliche Device-Endpunkt
  `POST /api/device-enrollments/exchange` akzeptiert ausschließlich
  `{ code: string }`. Seine einmalige Erfolgsantwort enthält `credential`,
  `credentialId` und `device` mit `id`, `name`, `externalId` und `profileId`, aber
  weder Code noch Hash. Ungültige, abgelaufene, bereits verwendete und
  ausgeschöpfte Codes liefern dieselbe Antwort `400 Pairing code is invalid or
  unavailable`.
- TTL und Limits: Ein Enrollment ist exakt zehn Minuten und damit höchstens die
  von ADR-005 erlaubten zehn Minuten gültig. Pro Enrollment werden höchstens fünf
  Einlöseversuche dauerhaft gezählt; der Device-Endpunkt ist zusätzlich auf fünf
  Requests pro Clientadresse und Minute begrenzt. HTTPS ist Standard. Unsicheres
  HTTP erfordert die explizite Administratoroption
  `PAIRING_ALLOW_INSECURE_HTTP=true`. Hinter genau einem geschützten,
  TLS-terminierenden Reverse Proxy muss `PAIRING_TRUST_PROXY=true` gesetzt werden,
  damit Protokoll und Clientadresse für HTTPS-Prüfung und Rate Limit übernommen
  werden; der Backendport darf dann nicht direkt exponiert sein.
- Geänderte Kernpfade: `backend/prisma/schema.prisma`,
  `backend/prisma/migrations/20260824004000_device_enrollments/`,
  `backend/src/device-enrollment/`, `backend/src/app.module.ts`,
  `backend/src/main.ts`, `backend/src/config/`,
  `backend/src/devices/entities/device.entity.ts`,
  `backend/test/device-enrollment.integration.ts`,
  `backend/test/migrations.integration.ts` und diese Paketdokumentation. Die vier
  ausdrücklich geschützten bestehenden Migrationen blieben unverändert.
- Ausgeführte Tests: testgetriebener Rotlauf wegen der zunächst fehlenden
  WP-09-Module; danach 11 gezielte Code-, Service- und API-Tests einschließlich
  10.000 kollisionsfreier Entropiestichproben, Adminschutz, HTTPS-Grenze und
  echtem 5/min-Rate-Limit; vier echte SQLite-Integrationsfälle für
  Hashpersistenz, TTL, Normalisierung, Rotation, Replay-/Versuchslimit,
  Transaktionsrollback und zwölf parallele Requests mit genau einem Erfolg;
  vier vollständige Neuinstallations-/Upgrade-/Adoptions-/Fehlermigrationstests;
  vollständige Backend-Suite mit 465 Tests in 40 Dateien; Backend-Typecheck,
  gezieltes ESLint über alle geänderten Produktionsdateien, Prisma-Validierung,
  Backend-Produktionsbuild und `git diff --check`. Alle paketbezogenen Prüfungen
  waren grün; nach dem zusätzlichen DTO-/Rollback-Härtungslauf waren die 35 direkt
  betroffenen Tests ebenfalls grün.
- Nicht ausführbare Tests und Grund: keine. Prismas Schema-Engine-Prüfsumme war in
  der eingeschränkten Netzwerksandbox nicht erreichbar; derselbe
  `prisma validate`-Lauf wurde mit freigegebenem Zugriff erfolgreich ausgeführt.
- Bewusste Abweichungen vom Paket: keine. Insbesondere wurden weder Pairing-UI,
  QR-Erzeugung noch andere Aufgaben aus WP-10 begonnen. Der bestehende lange
  Browser-Pairinglink aus WP-08 und sein Credential-Storageformat blieben
  unverändert.
- Neue Risiken/Schulden: Das zusätzliche Client-IP-Limit verwendet wie das
  vorhandene NestJS-Throttling pro Prozess flüchtigen Zustand; der persistente
  Pro-Code-Zähler bleibt auch über Neustarts erhalten. Vor mehreren API-Hosts ist
  gemäß ADR-001 ohnehin die PostgreSQL-Grenze zu bearbeiten und dabei auch ein
  gemeinsamer Rate-Limit-Store festzulegen. `PAIRING_TRUST_PROXY` setzt genau
  einen netzseitig geschützten Proxy-Hop voraus.
- Handoff an WP-10: Das Browser-Storageformat aus WP-08 bleibt zwingend Schlüssel
  `inker_display_<externalId>` mit dem opaken `credential` als Wert. Die UI darf
  den Admin-Erstellendpunkt verwenden, Basis-URL plus denselben zehnstelligen Code
  manuell oder als QR-Bootstrap darstellen und am Gerät ausschließlich den
  Exchange-Endpunkt aufrufen. Der Code darf nur in seiner einmaligen Admin-
  Erstellantwort und im absichtlich daraus erzeugten manuellen/QR-Bootstrap
  erscheinen, nicht in Logs, Telemetrie oder dauerhafter UI-Persistenz. Das
  dauerhafte Credential darf ausschließlich in seiner einmaligen Device-
  Erfolgsantwort erscheinen und niemals in URL, QR-Code, Admin-DTO, Logs oder
  Telemetrie gelangen. Erst nach vollständigem Exchange-Erfolg darf WP-10 den
  bisherigen Storagewert atomar durch das neue Credential ersetzen. Bei Ablauf,
  `400`/`403`/`429`, Validierungs- oder Netzfehler muss das alte Credential
  unverändert bleiben; dabei sind Bootstrap-Eingabe und Fehlerzustand kontrolliert
  zu behandeln. `externalId` aus der Erfolgsantwort bestimmt den bestehenden
  Browser-Storage-Schlüssel. Es ist keine Storage-Migration erforderlich.
- Git-Stand: Arbeitsbaum auf Branch `codex/device-platform-spike` auf Basis von
  `480b958`; gemäß Auftrag wurden weder Commit noch Push erstellt.

## WP-10 – Pairing-UI und QR-Flow umsetzen

**Ziel:** Geräte können mit Basis-URL plus kurzem Code oder QR-Code gekoppelt und
im Admin-UI verwaltet werden.

**Kontext:** Backendvertrag aus WP-09 und Browser-Lebenszyklus aus WP-08 verwenden.

**Voraussetzungen:** WP-09.

**Scope:** Admin-UI, WebDisplay-Eingabeseite, QR-Darstellung, Zustände und Tests.

**Aufgaben:**

- [x] Ergänze Admin-Aktion „Gerät koppeln“ mit Profilwahl und Ablaufanzeige.
- [x] Zeige formatierten Code, Basis-URL und QR-Code ohne Klartext in Logs.
- [x] Ergänze am WebDisplay eine Eingabe für Basis-URL und Code.
- [x] Zeige abgelaufen, bereits benutzt, rate-limited, offline und erfolgreich
  verständlich an.
- [x] Lösche Code/URL nach Erfolg aus sichtbarer Historie, soweit möglich.
- [x] Ergänze Rotation/Widerruf im Gerätedetail.
- [x] Teste Tastatur-, Touch- und QR-Pfade.

**Abnahme:** Ein neuer Pi-Browser lässt sich ohne lange Zeichenfolge koppeln; ein
widerrufenes Display kann denselben Flow erneut durchführen.

**Validierung:** Frontendtests und End-to-End-Pairing-Smoke-Test.

**Handoff:** Bedienablauf und Anforderungen für ESP32-Referenzclient notieren.

### Abschluss WP-10

- Status: abgeschlossen am 2026-08-25
- Ergebnis: Das geschützte Admin-UI erstellt über
  `POST /api/devices/:deviceId/enrollments` einen zehn Minuten gültigen
  Einmalcode, zeigt Geräteprofil, Basis-URL, serverformatierten Code, lokalen
  QR-Code und Ablaufzeit und warnt sichtbar vor ausdrücklich freigegebenem HTTP.
  Die Profilwahl beim Anlegen unterstützt Browser-HD sowie das weiterhin als
  unbestätigte Hardwareannahme gekennzeichnete ESP32-Referenzprofil. Im
  Gerätedetail erzeugt derselbe Ablauf einen neuen Enrollment-Code; erst dessen
  erfolgreicher Austausch rotiert und widerruft das bisherige Credential
  atomar. Der bestehende lange `?pair=`-Bootstrap bleibt funktionsfähig und als
  Legacy-Aktion erreichbar.
- WebDisplay-Ablauf: Die neue öffentliche Route `/display/pair` akzeptiert
  Basis-URL und manuell normalisierten Crockford-Code oder startet denselben
  Austausch aus dem QR-Bootstrap. Sie verwendet unverändert
  `POST /api/device-enrollments/exchange`. Erst eine vollständig validierte
  Erfolgsantwort ersetzt per `localStorage.setItem` den Wert unter
  `inker_display_<externalId>`. Validierungs-, Ablauf-/Replay-, `400`-, `403`-,
  `429`-, Offline-, Netz- und Serverfehler verändern ein vorhandenes Credential
  nicht. Da WP-09 abgelaufene, verwendete und sonst ungültige Codes absichtlich
  mit derselben konstanten `400`-Antwort versieht, nennt die UI diese Fälle
  gemeinsam und ohne Informationsleck. Code und Basis-URL werden vor dem Request
  aus dem aktuellen History-Eintrag und nach Erfolg zusätzlich aus temporärem
  Formularzustand sowie der sichtbaren Ergebnis-URL entfernt.
- Sicherheitsgrenzen: Der QR-Code wird lokal erzeugt und enthält ausschließlich
  die gewählte Basis-URL, den WebDisplay-Bootstrappfad und den kurzlebigen Code.
  Das langlebige Credential erscheint nur in der einmaligen Device-Antwort und
  im bestehenden Browser-Storagewert; es gelangt weder in Admin-DTO/QR/URL noch
  in Logs oder Telemetrie. Der Admin-Aufruf verwendet weiterhin den gemeinsamen
  Bearer-Session-Interceptor; die Backend-API-Prüfung bestätigt den Adminschutz.
- Geänderte Kernpfade: `frontend/src/App.tsx`,
  `frontend/src/components/devices/DevicePairingPanel.tsx`,
  `frontend/src/pages/devices/AddDevice.tsx`,
  `frontend/src/pages/devices/DeviceDetail.tsx`,
  `frontend/src/pages/display/WebDisplay.tsx`,
  `frontend/src/pages/display/pairing.ts`, `frontend/src/services/api.ts`,
  `frontend/src/types/index.ts` und die zugehörigen Frontendtests. Backend,
  Contracts, Prisma-Schema und Migrationen blieben unverändert.
- Ausgeführte Tests: Der testgetriebene Rotlauf scheiterte zunächst an den noch
  fehlenden Pairing-Helfern, dem Adminpanel und der Profilwahl. Danach waren alle
  48 Frontendtests in neun Dateien grün, darunter 27 gezielte WP-10-/WP-08-Tests
  für Adminberechtigung und DTO-Grenze, Profilwahl, Ablaufanzeige, QR-Inhalt,
  Eingabenormalisierung, Tastatur-/Touch-/QR-Pfade, Erstkopplung, Rotation,
  `400`/`403`/`429`, Ablauf/Replay, Offline/Netzfehler, URL-/Logbereinigung und den
  vollständigen bisherigen WP-08-Credential-Lebenszyklus. Sieben gezielte
  Backend-Controller-/Servicetests für Adminschutz, HTTPS-Grenze, Rate Limit,
  konstante Fehler, Rotation und geheime Persistenz sowie vier echte
  SQLite-Integrationsfälle für TTL, Replay, Rollback und Parallelität waren
  ebenfalls grün. Frontend-Typecheck, gezielter ESLintlauf über die neuen Tests,
  Helfer und geänderten UI-Komponenten, Produktionsbuild und `git diff --check`
  waren grün. Der vollständige Frontend-Lint reproduziert unverändert die
  dokumentierte Baseline von 85 Fehlern und neun Warnungen an unveränderten
  Altzeilen und bleibt gemäß WP-01 kein grünes Gate.
- Browser-Smoke-Test: Mit echtem Vite-Frontend, NestJS-/WebSocket-Backend und
  einer anschließend vollständig entfernten isolierten SQLite-Datenbank wurden
  Adminlogin, Browserprofilwahl, Code-/QR-/Ablaufanzeige, sichtbare HTTP-Warnung,
  QR-Erstkopplung, verständlicher Fehler für einen ungültigen Code, erneute
  Verbindung mit erhaltenem altem Credential sowie erfolgreiche Rotation
  geprüft. Erfolgs- und Fehler-URLs enthielten danach keinen Code; Browserlogs
  enthielten keinen der Bootstrap-Codes und keine Warnungen oder Fehler. Die beim
  Smoke erzeugten temporären Datenbank- und Default-Screen-Artefakte wurden
  entfernt beziehungsweise auf den vorherigen Git-Stand zurückgesetzt.
- Nicht ausführbare Tests und Grund: keine.
- Bewusste Abweichungen vom Paket: keine. Insbesondere wurden keine Endpunkte
  verändert und kein Folgepaket begonnen.
- Neue Risiken/Schulden: Die konkrete sichere Credentialablage und die genaue
  Kamera-/QR-Integration eines ESP32 bleiben gerätespezifische Clientaufgaben.
  Das ESP32-Touchprofil bleibt gemäß ADR-008 eine unbestätigte Referenzannahme.
  HTTP-Pairing bleibt gemäß ADR-005/ADR-009 ausschließlich eine explizit
  serverseitig freigegebene und in beiden UIs sichtbar gewarnte Ausnahme.
- Handoff an den ESP32-Referenzclient: Der Client übernimmt eine kanonische
  Basis-URL und denselben zehnstelligen Crockford-Code manuell, per Touch oder aus
  dem QR-Bootstrap, entfernt Trennzeichen, normalisiert Groß-/Kleinschreibung und
  O/I/L-Aliasse und sendet ausschließlich `{ code: string }` an
  `POST /api/device-enrollments/exchange`. Bei Erfolg speichert er nur das opake
  `credential` sicher und ordnet es der zurückgegebenen `device.externalId` und
  `device.profileId` zu. Erst nach vollständig erfolgreicher Antwort darf er ein
  altes Credential atomar ersetzen; bei jedem Fehler bleibt es unverändert.
  Code und Credential dürfen weder in Diagnoseausgaben, Telemetrie noch URLs
  gelangen. QR und manuelle Eingabe sind nur zwei Eingabemethoden desselben
  Protokolls; Display-, Touch- und Netzwerkdetails dürfen nicht aus dem offenen
  Referenzprofil als verifizierte Hardwareeigenschaften abgeleitet werden.
- Git-Stand: Arbeitsbaum auf Branch `codex/device-platform-spike` auf Basis von
  WP-09-Commit `0064d24`; gemäß Auftrag wurden weder Commit noch Push erstellt.

## WP-11 – Instanz-Secrets und unsichere Defaults härten

**Ziel:** Eine Installation startet nicht mit bekannten Admin-/Verschlüsselungs-
Secrets; Instanzschlüssel liegen außerhalb der SQLite-Datenbank.

**Kontext:** Inker fällt derzeit auf Standard-PIN beziehungsweise einen konstanten
Verschlüsselungsschlüssel zurück.

**Voraussetzungen:** WP-05.

**Scope:** Secret-Erzeugung, Konfiguration, Startup-Checks, Rotation-Vorbereitung
und Dokumentation. Admin-Session folgt in WP-12.

**Aufgaben:**

- [x] Entferne konstante und aus PIN abgeleitete Encryption-Fallbacks.
- [x] Erzeuge beim kontrollierten Erstsetup einen zufälligen Instanzschlüssel.
- [x] Speichere Schlüssel in separatem Volume/Secret mit restriktiven Rechten.
- [x] Verweigere normalen Start bei fehlendem oder unsicherem Zustand.
- [x] Definiere Key-ID und Version für spätere Rotation.
- [x] Redigiere Secrets konsequent aus Logs und Fehlern.
- [x] Ergänze Setup-, Restart-, Missing-Secret- und Backup-Dokumentationstests.

**Abnahme:** Eine Default-Installation besitzt einen einzigartigen Schlüssel; das
Kopieren nur der SQLite-Datei liefert keine direkt nutzbaren Provider-Secrets.

**Validierung:** Startup-/Container-Tests und Secret-Redaction-Test.

**Handoff:** Secretpfad, Rotationseinschränkungen und Backupanforderungen notieren.

### Abschluss WP-11

- Status: abgeschlossen am 2026-08-25
- Ergebnis: Bekannte Admin- und Encryption-Defaults sind entfernt. `ADMIN_PIN`
  ist explizit erforderlich, `1111` wird in Compose, Setup und Anwendung
  abgelehnt, und der entfernte `ENCRYPTION_KEY`-Pfad kann nicht stillschweigend
  weiterverwendet werden. Ein frisches kontrolliertes Container-Setup erzeugt
  vor der SQLite-Datenbank einen zufälligen 256-Bit-Instanzschlüssel; bei einer
  bestehenden Datenbank ohne passenden Schlüssel stoppt der Backendstart vor
  Migration und Readiness, ohne einen Ersatzschlüssel anzulegen.
- Secretpfad und Rechte: Der Container verwendet
  `/app/secrets/instance.json` auf dem separaten `secrets_data`-Volume. Das
  Verzeichnis gehört `inker:inker` und hat Modus `0700`, die atomar publizierte
  Schlüsseldatei Modus `0600`. Lokale Starts können den Pfad über
  `INKER_INSTANCE_SECRET_PATH` konfigurieren. Der Schlüssel liegt nie in SQLite,
  URL, DTO oder Startlog.
- Schlüssel- und Ciphertextformat: Die JSON-Datei enthält `version: 1`, eine
  nicht geheime UUID als `keyId` und den zufälligen Base64-Schlüssel. Neue
  AES-256-GCM-Werte tragen `v1`, `keyId`, IV, Auth-Tag und Ciphertext. Der
  dreiteilige bisherige Ciphertext bleibt mit demselben Schlüssel lesbar; eine
  fremde `keyId`, unbekannte Version oder ungültige Authentisierung wird ohne
  Ausgabe von Key oder Ciphertext abgewiesen.
- Rotationseinschränkungen: `version` und `keyId` bereiten die Auswahl mehrerer
  Schlüssel vor, aber Multi-Key-Rotation und automatische Re-Encryption sind
  noch nicht implementiert. Eine verlorene Schlüsseldatei darf nicht ersetzt
  werden. Für Bestandsinstallationen ohne Secretdatei gibt es ausschließlich den
  expliziten Einmalpfad `prepare-instance-secrets.ts --initialize-existing`;
  dessen neuer Zufallsschlüssel kann alte, mit einem Fallback verschlüsselte
  Plugin-/OAuth-Werte nicht lesen, sodass diese anschließend neu einzugeben sind.
- Backupanforderungen: `/app/uploads` und `/app/secrets` sind getrennt zu sichern,
  bilden aber genau ein gemeinsames Restore-Set. Backups müssen Dateirechte und
  die Zuordnung zur nicht geheimen `keyId` bewahren und das Secretbackup selbst
  wie ein Credential verschlüsseln und zugriffsbeschränken. Eine allein kopierte
  SQLite-Datei reicht weder wegen WAL noch zum Entschlüsseln von Provider-Secrets.
- Secret-Redaction: Strukturierte und textuelle Logdaten redigieren insbesondere
  PINs, Passwörter, API-/Encryption-Keys, Tokens, Credentials, Authorization und
  Cookies. Startup- und HTTP-Fehler geben keine Schlüsselwerte aus; `keyId` darf
  als nicht geheime Diagnose- und Backupzuordnung erscheinen.
- Geänderte Kernpfade: `backend/src/config/instance-secrets.ts`,
  `backend/scripts/prepare-instance-secrets.ts`,
  `backend/src/common/services/encryption.service.ts`,
  `backend/src/config/secret-redaction.ts`, Startup-/Logger-Konfiguration,
  `backend/docker-entrypoint.sh`, `docker/services.d/backend/run`, `Dockerfile`,
  `docker-compose.yml`, `README.md` und
  `docs/operations/DATABASE_BACKUP.md`.
- Ausgeführte Tests: 480 Backend-Unit-/Controller-Tests in 44 Dateien; 15 gezielte
  Secret-, Konfigurations-, Encryption- und Redaction-Tests; vier
  Startup-/Restart-/Missing-Secret-/Dokumentations-Integrationstests; vier
  vollständige WP-05-Migrationsfälle; Backend-Typecheck; gezieltes ESLint aller
  geänderten, vom Projekt-TSConfig erfassten Produktionsdateien; Backend-Build;
  Compose-Konfiguration positiv mit sicherem PIN und negativ ohne PIN;
  vollständiger Docker-Image-Build; realer frischer Containerstart und Readiness;
  Prüfung von Format, 32-Byte-Schlüssel, `0700`/`0600`, Logausschluss und
  unveränderter `keyId` nach Restart; negativer Container-Smoke mit bestehender
  SQLite-Datei und leerem Secret-Volume sowie Default-PIN-Ablehnung. Alle
  genannten Prüfungen waren grün.
- Nicht ausführbare Tests und Grund: keine.
- Bewusste Abweichungen vom Paket: keine.
- Neue Risiken/Schulden: Bestandsinstallationen, die bisher den konstanten oder
  PIN-abgeleiteten Fallback benutzt haben, besitzen keinen wiederverwendbaren
  sicheren Instanzschlüssel und müssen verschlüsselte Einstellungen nach dem
  dokumentierten Übergang neu eingeben. Eine echte Key-Rotation bleibt ein
  Folgepaket und darf nicht durch Überschreiben von `instance.json` simuliert
  werden.
- Relevante Hinweise für WP-12: Die bestehende PIN-basierte Admin-Session wurde
  bewusst nicht verändert. WP-12 kann voraussetzen, dass kein Default-PIN mehr
  startet und dass Secret-/Fehlerwerte über die zentrale Redaction geschützt
  werden; die Instanzschlüsseldatei darf dabei weder in Session-DTOs noch in
  Authentisierungslogs gelangen.
- Git-Stand/Commit: Branch `codex/device-platform-spike`; WP-10 wurde als
  `d58a4df` committed. Der Arbeitsbaum enthält ausschließlich die uncommittierten
  WP-11-Änderungen. Es wurde kein Push erstellt.

## WP-12 – Sichere Admin-Session einführen

**Ziel:** Die langlebige Local-Storage-Bearer-Session wird durch eine serverseitig
kontrollierte Websession mit sicheren Cookies ersetzt.

**Kontext:** Erste Version bleibt Single-Admin; das Modell darf spätere Benutzer
nicht verhindern.

**Voraussetzungen:** WP-11.

**Scope:** Erstsetup/Admincredential, Sessionmodell, Cookies, CSRF, Login/Logout,
Frontend-Anpassung und Tests.

**Aufgaben:**

- [x] Definiere Password-/Passkey-fähiges Adminmodell ohne Multi-Tenant-Scope.
- [x] Speichere Passwort nur mit geeignetem adaptivem Hash und Parametern.
- [x] Implementiere kurzlebige, widerrufbare Sessions.
- [x] Setze HttpOnly, Secure in HTTPS, SameSite und sinnvolle Rotation.
- [x] Implementiere CSRF-Schutz für zustandsändernde Browserrequests.
- [x] Migriere Frontend weg vom langlebigen Auth-Token in `localStorage`.
- [x] Ergänze Login-Throttling, Logout-all und Sessionübersicht.
- [x] Teste CSRF, Fixation, Ablauf, Rotation und Rückwärtskompatibilität.

**Abnahme:** Im Browser-Storage liegt kein Admin-Bearer-Token; gestohlene alte
Sessions sind einzeln widerrufbar.

**Validierung:** Backend-, Frontend- und Security-Integrationstests.

**Handoff (abgeschlossen am 2026-08-25):**

- Credential-Setup und Modell: Die Vorwärtsmigration
  `20260825000000_admin_credentials_sessions` ergänzt genau einen
  installationsweiten `AdminAccount`, Password-/Passkey-fähige
  `AdminCredential`-Datensätze sowie persistente `AdminSession`-Datensätze. Beim
  ersten Start einer noch nicht initialisierten Datenbank wird das gemäß
  WP-11 weiterhin verpflichtende `ADMIN_PIN` einmalig als Adminpasswort
  übernommen und ausschließlich als versionierter scrypt-Hash mit
  `N=32768`, `r=8`, `p=2`, 32-Byte-Schlüssel, 16-Byte-Zufallssalz und 64 MiB
  Speichergrenze gespeichert. Bei späteren Starts bleibt das persistierte
  Credential maßgeblich; es gibt weder Defaultcredential noch
  Multi-Tenant-Scope. Das Schema kann Passkey-Credentials aufnehmen, die
  WebAuthn-Registrierungs- und Assertion-Ceremony ist in WP-12 nicht aktiviert.
- Sessionvertrag: Adminsessions haben acht Stunden absolute und 30 Minuten
  inaktive Laufzeit. Der zufällige Sessiontoken wird nach erfolgreichem Login
  neu erzeugt, nach spätestens 15 Minuten atomar rotiert und nur als SHA-256-
  Hash persistiert. Einzelwiderruf, Logout und Logout-all wirken serverseitig
  unmittelbar. Die Sessionübersicht liefert nur ID, Zeitstempel,
  bereinigten User-Agent, gehashte IP-Metadaten und Kennzeichnung der aktuellen
  Session; Session- und CSRF-Secrets werden nicht ausgegeben.
- Cookie- und CSRF-Vertrag: `inker_admin_session` ist `HttpOnly`,
  `SameSite=Strict`, auf `/api` begrenzt und unter HTTPS einschließlich
  vertrauenswürdig weitergereichtem HTTPS mit `Secure` gesetzt; unter reinem
  HTTP bleibt `Secure` für lokale Entwicklung aus. Browser-Mutationsrequests
  müssen zusätzlich den zur Session gehörenden `X-CSRF-Token` senden. Der
  CSRF-Wert wird nur als Hash persistiert, bei Login beziehungsweise
  `GET /api/auth/session` im Responseheader rotiert und im Frontend nur im
  Arbeitsspeicher gehalten. Fehlende, falsche und zu einer anderen Session
  gehörende Werte werden abgelehnt.
- Browser- und API-Pfade: `POST /api/auth/login`, `GET /api/auth/session`,
  `POST /api/auth/logout`, `POST /api/auth/logout-all`,
  `GET /api/auth/sessions` und `DELETE /api/auth/sessions/:sessionId` bilden den
  neuen Vertrag; Login ist auf fünf Versuche pro Minute gedrosselt. Axios,
  Form-Data-Requests und SSE verwenden Cookies statt Bearerwerten. Das
  Frontend liest oder schreibt keinen Admin-Bearer-Token mehr in
  `localStorage` und entfernt den historischen Schlüssel `inker_session` beim
  Start. Reload, Login, Logout, Logout-all und Sessionübersicht wurden im
  gebauten Produktionscontainer per Browser-Smoke-Test verifiziert.
- Kontrollierte Legacy-Kompatibilität: `POST /api/auth/login` akzeptiert neben
  `password` vorübergehend das alte Requestfeld `pin`, liefert aber keinen
  Bearertoken mehr. `POST /api/auth/validate`, `PinAuthService` und die
  Bearer-Erkennung des Guards bleiben für vorhandene Nicht-Browser-Aufrufer
  erhalten; der Browser verwendet diese Ausnahme nicht. Cookie-authentisierte
  zustandsändernde Requests können CSRF nicht über diesen Pfad umgehen.
- Migration und Regression: Die neue Migration folgt unverändert auf die
  vorhandenen Prisma-Migrationen; Fresh-Install, Upgrade und Adoption einer
  bestehenden Datenbank wurden geprüft. Backend (484 Tests), Frontend (54
  Tests), Admin-/Migrationsintegration, Device-Enrollment und Pairing,
  Publication sowie die WP-11-Instanzsecret-, Backup- und Redaction-Verträge
  sind grün. Prisma-Validierung, Backend- und Frontend-Typechecks,
  zielgerichtetes Linting, beide Produktionsbuilds, Compose-Konfiguration und
  Container-Healthcheck sind ebenfalls grün. Im Smoke-Log wurden keine
  Passwort-, Cookie-, CSRF- oder Bearerwerte gefunden. Der bereits bestehende
  optionale Fresh-Install-Seed warnt im finalen Runtime-Image weiterhin über
  eine dort nicht enthaltene TypeScript-Katalogdatei; der Startupvertrag und
  WP-12 funktionieren anschließend, und dieser paketfremde Packagingpfad wurde
  nicht verändert.

## WP-13 – Profile, TransportAdapter und DeliveryPolicy trennen

**Ziel:** Gerätetyp, Displayprofil, Energieverhalten und Transport sind unabhängige
Erweiterungspunkte.

**Kontext:** Die aktuelle Driver-Registry ist fest mit TRMNL und WebDisplay
verdrahtet und beschreibt überwiegend Default-Capabilities.

**Voraussetzungen:** WP-04 und WP-06.

**Scope:** Backend-Abstraktionen, Providerregistrierung und Migration bestehender
Gerätepfade. Noch keine neue Protokollfunktion.

**Aufgaben:**

- [x] Definiere ProfileResolver, TransportAdapter und DeliveryPolicy als getrennte
  Interfaces.
- [x] Registriere Adapter über NestJS-Multi-Provider/Discovery statt zentralem
  Hardcoding.
- [x] Verschiebe TRMNL- und WebDisplay-Defaults in Profile.
- [x] Lass DevicesService nur orchestrieren und nicht transportspezifisch handeln.
- [x] Ergänze unbekannter-Adapter-, Override- und Capability-Tests.
- [x] Halte optionale spätere MQTT-Erweiterung als Contract-Test fest, ohne sie zu
  implementieren.

**Abnahme:** Ein Dummy-Adapter kann in einem Test registriert werden, ohne
DevicesService oder Dashboardcode zu ändern.

**Validierung:** Unit-, DI- und bestehende Gerätetests.

**Handoff (abgeschlossen am 2026-08-26):**

- `ProfileResolver`, `TransportAdapter` und `DeliveryPolicy` sind getrennte
  Erweiterungsverträge. Eingebaute Transportadapter sind normale Nest-Provider mit
  `@RegisterTransportAdapter()`; `TransportAdapterRegistry` entdeckt sie über
  `DiscoveryService` und Metadaten. Doppelte Modi verhindern den Start, ein
  angeforderter unbekannter Modus wird kontrolliert abgelehnt. Der DI-Test
  registriert einen Dummy-`mqtt`-Adapter ohne Änderung an `DevicesService` oder
  Dashboardcode; ein MQTT-Protokoll, -Client oder -Credential wurde nicht
  implementiert.
- TRMNL-, ESP32-Referenz- und Browser-Defaults einschließlich Legacy-Gerätetyp,
  Delivery Policy und nötiger Kompatibilitäts-Overrides liegen im eingebauten
  Profilkatalog. Der Resolver führt Profil, Policy, Capability-Overrides und
  Dimensionen zusammen; fremde Profile müssen ihre Policy explizit angeben.
  Persistierte Profilverträge und das Prisma-Schema bleiben unverändert, daher ist
  keine Migration nötig.
- `sleepy` und `responsive-pull` wählen HTTP-Pull ohne unmittelbaren Dispatch;
  `connected` wählt WebSocket mit unmittelbarem Dispatch. Die effektiven
  WP-06-Capabilities validieren die Auswahl. `DevicesService` und
  `DeviceUpdateCoordinator` orchestrieren Resolver, Policy und Adapter, ohne die
  migrierten Pfade anhand von Profil-IDs oder Transportstrings zu verzweigen.
- Der HTTP-Pull-Adapter bewahrt TRMNL-MAC-Prüfung und API-Key-Erzeugung. Der
  WebSocket-Adapter bewahrt externe Display-ID, 15-minütiges Pairing-Bootstrap,
  ausschließlich persistierten Token-Hash, Rotation und Gateway-Dispatch. Die in
  WP-08 bis WP-10 festgelegten Credential- und Pairing-Lebenszyklen wurden nicht
  geändert.
- Verbleibende Legacy-Sonderfälle: `SetupService` bleibt der explizite
  TRMNL-Firmware-Einstieg, löst Profil, Policy und Adapter nun aber über die neuen
  Verträge auf. `DisplayService`/`getDisplayContent` und `regenerateApiKey` bleiben
  bestehende Pull-APIs für WP-14. `WebDisplayGateway` bleibt die konkrete
  WebSocket-Implementierung hinter dem Adapter. Die aus WP-06 übernommenen
  Datenbankspiegel (`deviceType`, `transport`, `capabilities`, Dimensionen und
  `Model`) sowie die ESP32-Annahmen aus ADR-008 bleiben bewusst bestehen.
- Validiert mit 501 Backend-Tests, 23 Contract-Tests, Backend- und
  Contract-Typechecks, ESLint der geänderten Produktionsdateien, Builder- und
  vollständigem Produktionsimage sowie einem Runtime-DI/API-Smoke für Pull und
  WebSocket. Der Smoke fand keine Adapterfehler und keine Credentials in Logs. Die
  bereits bestehende optionale Seed-Warnung zum im Runtime-Image nicht enthaltenen
  TypeScript-Katalog bleibt paketfremd unverändert.

## WP-14 – Pull-Auslieferung mit ETag und Policies

**Ziel:** Batterie- und Netz-TRMNL erhalten denselben veröffentlichten Zustand mit
unterschiedlicher Aktualisierungsrichtlinie und ohne unnötige Downloads.

**Kontext:** Lies `ARCHITECTURE_PLAN.md`, Abschnitte 3, 6.3 und 6.4.

**Voraussetzungen:** WP-07 und WP-13.

**Scope:** Pull-Manifest/Content-Endpunkt, Conditional GET, Telemetrie und
DeliveryPolicy. Keine Rendercache-Implementierung über minimale Fixture-Artefakte
hinaus.

**Aufgaben:**

- [x] Implementiere einen versionierten authentifizierten Device-Content-Endpunkt.
- [x] Wähle Ausgabe anhand effektiver Capabilities statt Gerätetyp-Switch.
- [x] Erzeuge stabiles `ETag` aus Inhaltsrevision und Artefakthash.
- [x] Antworte korrekt auf `If-None-Match` mit `304` ohne Body.
- [x] Liefere Refresh-Hinweise für `sleepy` und `responsive-pull`.
- [x] Aktualisiere Last-Seen gedrosselt statt pro unverändertem Poll synchron.
- [x] Bewahre die bestehende TRMNL-Kompatibilität über Adaptertests.

**Abnahme:** Unveränderte Geräte laden kein Bild erneut; Batterie- und Netzmodus
ändern nur Policy, nicht Geräteidentität oder Dashboard.

**Validierung:** HTTP-, Auth-, ETag-, Policy- und TRMNL-Kompatibilitätstests.

**Handoff:** Firmwareannahmen und praktisch zu messende Refresh-Untergrenzen
notieren.

### Abschluss WP-14

- Status: abgeschlossen am 2026-08-27. Voraussetzungen WP-07 (`528c568`) und
  WP-13 (`79f14eb`) sowie WP-11 (`e1a7bee`) und WP-12 (`2052430`) sind im
  Ausgangsstand enthalten. Aus dem Architekturplan wurden ausschließlich die
  referenzierten Abschnitte 3, 6.3 und 6.4 verwendet; ADRs und Handoffs WP-04
  bis WP-13 bleiben verbindlich.
- Endpunkte: `GET /api/v1/device-content` liefert ein unverpacktes
  `PresentationManifest` mit `protocolVersion: "1.0"`.
  `GET /api/v1/device-content/artifacts/:sha256` liefert die referenzierten
  Bildbytes. Beide authentisieren vor Inhaltsabfrage und Conditional GET.
  `Authorization: Bearer <credential>` verwendet ausschließlich den bestehenden
  `DeviceCredential`-Hash, prüft Widerruf, Ablauf und aktives Gerät und begrenzt
  Zugriff auf dessen gewünschte Revision. Alternativ akzeptiert der Legacy-Pfad
  den bestehenden TRMNL-API-Key in `HTTP_ID` oder `Access-Token`, niemals eine
  MAC-Adresse. Mehrdeutige Credentials werden abgelehnt, fehlgeschlagene Bearer-
  Authentisierung fällt nicht auf einen anderen Header zurück. Admin-Cookies,
  Admin-Bearer und Queryparameter authentisieren kein Gerät; Browser-CSRF und
  Adminsessions werden im Devicepfad nicht aufgerufen. Credentialausgabe,
  Pairing, Rotation und Widerruf bleiben unverändert. HTTPS ist weiterhin die
  sichere Betriebsannahme; der neue Readpfad erzeugt keinen HTTP-Pairing-Fallback.
- Veröffentlichter Zustand und Scope: Maßgeblich ist ausschließlich
  `DevicePublicationState.desiredRevision`, nicht die neueste Revision und nicht
  ein Draft, eine Playlistrotation oder `presentationRevision`. GET verändert
  weder Publications noch Soll-/Bestätigungszustand oder Outbox. Ohne gewünschte
  Revision folgt `404`, bei inkompatibler Gerätekonfiguration/Ausgabe `406`, bei
  fehlenden Fixture-Referenzen oder inkompatibler Publication-Version `503`.
  Kompatible Minor-Versionen nutzen nur bekannte Felder. Als minimale interne
  Übergabe dient `PublicationRevision.content.fixtureArtifacts`, eine Liste der
  IDs `mono-800x480-white-bmp`, `mono-800x480-black-bmp` und/oder
  `mono-800x480-white-png`. Der feste Katalog enthält ausschließlich diese echten
  800×480-Monochrom-Fixtures mit SHA-256; es gibt keinen Renderer, Rendercache,
  beliebigen Dateizugriff, Providerabruf oder externen Artefakt-URL-Passthrough.
  Allgemeines Publishing/Rendering und zusätzliche Formate bleiben Folgearbeit.
- Capability-/Adaptergrenze: `ProfileResolver` löst Profil und Overrides auf,
  `DeliveryPolicy` liefert Transportauswahl und `pullHints`, und die vorhandene
  Nest-Discovery liefert den Adapter mit `pullProtocolVersion`. Formatpräferenz,
  MIME-Type, Dimensionen, Farbraum, Bit-Tiefe und Rotation bestimmen das passende
  vorhandene Artefakt. Kein Gerätetyp-Switch und keine neue zentrale Transportliste
  wurden eingeführt; ein zusätzlicher Testadapter funktioniert über Discovery.
  `connected` ohne Pull-Policy ist hier nicht implementiert; WebDisplay behält
  seine bestehenden HTTP-/WebSocket-Pfade.
- ETag-/304-Vertrag: Das schwache Manifest-ETag `W/"<sha256>"` berücksichtigt
  Protokoll, Publication, Inhaltsrevision, Profilvariante und Artefakthash;
  `generatedAt` stammt aus `publishedAt`, nicht aus der Pollzeit. Änderungen an
  Revision oder Artefakt ändern das ETag. Delivery-Hinweise sind bewusst nicht
  Teil dieses Inhaltsvalidators. Artefakte haben ein starkes Hash-ETag und eine
  relative, credentialfreie Hash-URL. `If-None-Match` verwendet schwachen
  Vergleich, akzeptiert Taglisten, leere Listenelemente und `*`; unpassende oder
  ungültige Tags liefern `200`. Die Listen-/Vergleichsregeln folgen
  [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).
  `304` hat keinen Body und behält ETag, `Cache-Control: private, no-cache`,
  `Vary: Authorization, HTTP_ID, Access-Token` sowie Refresh-Header. Fehler sind
  `no-store`. Auch ein passendes ETag umgeht keine Authentisierung. Ein Artefakt
  ist nur für die aktuell gewünschte, kompatible Variante abrufbar.
- Refresh-Policies: Die unveränderten Referenzpolicies liefern 900 Sekunden
  (`sleepy`) bzw. 60 Sekunden (`responsive-pull`), jeweils mindestens die
  effektive `recommendedMinRefreshSeconds`. Der Body enthält
  `refresh.refreshAfterSeconds`; auf **jeder** erfolgreichen Antwort, auch `304`,
  sind `X-Refresh-After-Seconds` und `X-Delivery-Mode` maßgeblich. Clients müssen
  diese Hinweise auch ohne neuen Manifestbody übernehmen. Ein Policywechsel
  erhält Profil, Geräte-ID, External-ID, Credential, Dashboardzuordnung,
  gewünschte Publication und Artefakte; das Inhalts-ETag bleibt gleich.
  Fixtures besitzen keine fachlichen Übergänge oder Interaktionen; entsprechende
  optionale Zeitangaben werden nicht erfunden und `allowedActions` bleibt leer.
- Last-Seen: Erfolgreich authentisierte Pulls beobachten Geräteaktivität ohne
  auf den Write zu warten. Persistierte `lastSeenAt`-Zeitstempel drosseln auf
  `telemetryIntervalSeconds` (Referenzen: 3600 bzw. 300 Sekunden; technische
  Untergrenze 60 Sekunden). Pro Gerät wird gleichzeitig nur ein Write gehalten;
  insgesamt höchstens 1024. Ein bedingtes Datenbankupdate schützt auch gegen
  konkurrierende/veraltete Beobachtungen. Neustarts rekonstruieren die Drosselung
  aus SQLite. Fehler verhindern keine Auslieferung und werden ohne Originalfehler
  protokolliert. Nur Telemetrie darf bei einem abrupten Prozessende verloren gehen;
  Authentisierung wird nicht gecacht und schreibt keine Credential-/Sessiondaten.
  Last-Seen bleibt damit eine gedrosselte Aktivitätsanzeige, keine neue
  Liveness-Garantie für die bestehende Online-/Offline-Anzeige.
- Legacy/Sicherheit: `/api/setup`, `/api/display`, API-Key-Erzeugung und deren
  bestehende Firmwareantworten bleiben erhalten. Gefundene Credential-/Prefix-
  Debugausgaben und fehlende Headerredaction im Legacy-Pullpfad sind durch Tests
  abgesichert und entfernt. Neue Antworten verwenden ausschließlich explizite
  Felder; Tokens, Credential-Hashes, Instanzschlüssel und beliebige Snapshot-Metadaten werden
  nicht übernommen. WP-08 bis WP-12 einschließlich Admin-Cookies/CSRF,
  Startup-/Backupvertrag und Secret-Redaction bleiben unverändert.
- Firmwareannahmen und offene Messungen: Für Downloadvermeidung muss Firmware
  den versionierten Pfad, gewähltes Bildformat, Headerauthentisierung,
  `If-None-Match`, `304` und Refresh-Header unterstützen und das letzte Bild lokal
  behalten. Fehlt es lokal, muss sie ohne Validator neu laden. Bei einem
  Publishwechsel zwischen Manifest- und Bildabruf kann die alte Hash-URL `404`
  liefern; dann ist das Manifest neu abzurufen. Unveränderte Legacy-Firmware nutzt
  weiter ihren bisherigen Pfad und erhält nicht automatisch diese Optimierung.
  **900/60 Sekunden und alle Referenz-/Capability-Untergrenzen sind nicht
  praktisch gemessene Firmwaregrenzen.** Insbesondere die zuverlässige minimale
  Poll-/Refreshzeit der TRMNL-BYOD-Firmware im Netzbetrieb, Timer-Clamping,
  Headerverarbeitung, Displayrefresh, WLAN-Wiederanlauf und Energiebedarf sind
  an realer Hardware zu messen. Es wurde kein physischer Firmwaretest behauptet.
- Validierung: 528 Backendtests (Baseline zuvor selbst mit 501 bestätigt),
  23 Contracttests, 54 Frontendtests und 23 reale Integrationsfälle aus Publication,
  Migration, Enrollment, Admin-Auth und Instanz-Secrets bestanden. Testgetriebene
  Rotläufe belegten zunächst fehlenden Pullpfad, Legacy-Secretlogs und den
  HTTP-Listenrandfall. SQLite-Tests bestätigen getrennten Sollzustand, unveränderte
  Outbox/Bestätigung, genau einen Last-Seen-Write bei 20 unveränderten Polls und
  Restart-/Policyverhalten. Backend-/Contract-/Frontend-Typechecks,
  Prisma-Validierung, gezieltes Produktions- und Testlinting, Backend-Builder,
  Produktionsimage und Compose-Prüfung bestanden. Testlinting verwendete wegen
  der bekannten TSConfig-Testausschlüsse eine temporäre Parserkonfiguration;
  Produktionslint meldet nur vier bestehende Legacy-Warnungen, keine Fehler.
  Das bekannte repositoryweite Lint-Baselineproblem wurde nicht erweitert oder
  paketfremd bereinigt.
- Runtime-Smoke: Echter Nginx-/Nest-/SQLite-Pfad mit Adminlogin, CSRF-Abweisung,
  Short-Code-Austausch, Pullmanifest/-artefakt, Auth vor `304`, Policywechsel,
  Last-Seen, TRMNL-Setup/Display sowie WebDisplay-Pairing, HTTP und WebSocket
  bestand. Secretwerte blieben im Testprozess im RAM; reguläre Anwendungslogs und
  Antworten außerhalb expliziter Credentialverträge enthielten keinen davon.
  Nach Containerneustart waren Geräte-ID, ETag und Key-ID identisch und Health
  grün. Der Bun-`ws`-Testclient behandelte HTTP 101 als unerwartete Antwort;
  derselbe Smoke bestand mit dem vorhandenen Node-Client. Die bekannte optionale
  Runtime-Seed-Warnung wegen `device-configuration.catalog` ist unverändert und
  verhindert Startup nicht. Auch die Prisma-7-Konfigurationswarnung bleibt
  unverändert. Windows-Sandbox-EPERM und blockierte Prisma-Prüfsummenabrufe wurden
  über freigegebene Wiederholungen erfolgreich geprüft.
- Schema/Git: Keine Schemaänderung, keine neue Migration und keine Änderung
  vorhandener Migrationen. Keine Implementierung von WP-15, WP-19 oder MQTT;
  keine Änderung von Geräte-/Pairing-Lebenszyklen. Dokumentation ausschließlich
  im WP-14-Status/Handoff ergänzt. Branch `codex/device-platform-spike`;
  Bestandteil des auf Benutzerwunsch erstellten WP-14-Abschlusscommits. Kein Push.

## WP-15 – WebSocket und Telemetrie härten

**Ziel:** ESP32-/Browser-Verbindungen erkennen tote Clients, validieren Nachrichten
und können nicht unbegrenzt Datenbankschreiblast erzeugen.

**Kontext:** Die aktuelle Gateway-Map und Heartbeats liegen im RAM; Telemetrie kann
pro Nachricht einen DB-Write auslösen.

**Voraussetzungen:** WP-08 und WP-13.

**Scope:** Gateway-Protokoll, Auth, Schema, Heartbeat, Limits, Reconnectsemantik und
Telemetriepuffer. Dauerhafte Events folgen WP-16.

**Aufgaben:**

- [ ] Verwende versionierte Contracts für Auth, Ping/Pong, Manifest und Telemetrie.
- [ ] Implementiere echte Liveness-Erkennung mit Frist und sauberem Disconnect.
- [ ] Begrenze Nachrichtengröße, Frequenz und erlaubte Message-Typen.
- [ ] Normalisiere Origin-/Host-Prüfung für Proxybetrieb.
- [ ] Puffere/dedupliziere Telemetrie und schreibe sie höchstens in definierten
  Intervallen.
- [ ] Definiere Reconnect, Credential-Widerruf und Serverneustart eindeutig.
- [ ] Fange alle asynchronen Handlerfehler ab und redigiere Tokens aus Logs.

**Abnahme:** 20 simulierte Idle-Verbindungen verursachen keine permanenten
DB-Writes; tote Clients werden entfernt und ungültige Payloads geschlossen.

**Validierung:** Gateway-, Flood-, Liveness- und 20-Client-Smoke-Test.

**Handoff:** Connection-Metriken und Eventhooks für WP-16/WP-28 notieren.

## WP-16 – Transaktions-Outbox und Event-Dispatcher anschließen

**Ziel:** Fachänderungen führen zuverlässig, dedupliziert und mit sichtbarem
Fehlerpfad zu Geräteupdates.

**Kontext:** Der aktuelle RxJS-Subscriber startet `refreshDevices()` ohne Catch;
Screen-Design-Updates können doppelte Pushes auslösen.

**Voraussetzungen:** WP-07 und WP-13.

**Scope:** Outbox-Producer, Dispatcher, Redis-Verteilung, Retry/Deduplizierung und
Tests. Keine Source-Jobs.

**Aufgaben:**

- [ ] Ersetze relevante direkte In-Memory-Emits durch atomare Outbox-Einträge.
- [ ] Implementiere Claim/Dispatch/Ack/Retry mit begrenzten Versuchen.
- [ ] Dedupliziere Ereignisse nach Fachobjekt und Revision.
- [ ] Verteile Delivery-Hinweise über Redis an verbundene Adapterprozesse.
- [ ] Protokolliere Fehler mit Correlation-ID und ohne Payload-Secrets.
- [ ] Entferne doppelte Screen-Design-Pushes.
- [ ] Ergänze Crash-zwischen-Commit-und-Dispatch- sowie Redis-Ausfalltests.

**Abnahme:** Ein Event geht bei Prozess-/Redis-Unterbrechung nicht verloren und
führt pro Revision höchstens zu einem logischen Update.

**Validierung:** Integrations-, Restart-, Retry- und Deduplizierungstests.

**Handoff:** Outbox-Durchsatz, Retention und Monitoringanforderungen notieren.

## WP-17 – Unveränderliche Publications und read-only Manifeste

**Ziel:** Displays lesen eine explizit veröffentlichte, unveränderliche Revision;
Manifestabrufe mutieren keine fachliche Version.

**Kontext:** Der aktuelle PresentationService erhöht bei jedem Abruf
`presentationRevision` und schreibt Wiedergabestatus.

**Voraussetzungen:** WP-07.

**Scope:** Publish-Service, PublicationRevision, Manifest-Assembler und Migration
des aktuellen PresentationService. Playlistrotation folgt WP-18.

**Aufgaben:**

- [ ] Implementiere explizites Publish aus einem validierten Entwurf.
- [ ] Erzeuge unveränderliche Revisionen mit Inhaltschecksumme.
- [ ] Weise Geräten gewünschte PublicationRevision zu.
- [ ] Baue PresentationManifest ausschließlich aus persistiertem Zustand.
- [ ] Entferne Revision-Increment und sonstige fachliche Writes aus GET/Pull/Push.
- [ ] Definiere Fehler- und Fallbackverhalten bei fehlender Publication.
- [ ] Ergänze Idempotenz-, Parallelabruf- und unveränderlichkeits-Tests.

**Abnahme:** 100 Abrufe desselben Manifests verändern die Datenbankrevision nicht
und liefern denselben fachlichen Inhalt.

**Validierung:** Service-, API-, Concurrency- und DB-Write-Assertion-Tests.

**Handoff:** Publish-API und Übergangspunkte für Editor/Playlist notieren.

## WP-18 – Playlistrotation als Zustandsmaschine

**Ziel:** Playlistübergänge sind deterministisch, neustartfest und unabhängig vom
Manifestabruf.

**Kontext:** Heute wird der aktuelle Eintrag während `getForDevice()` anhand
`screenStartedAt` fortgeschaltet; WebSocket-Timer leben im RAM.

**Voraussetzungen:** WP-17.

**Scope:** Reine Zustandsmaschine, persistierter PlaybackState, Übergangsplanung
und Tests. Rendercache folgt WP-19.

**Aufgaben:**

- [ ] Definiere Zustände, Eingaben und Übergänge für Start, Advance, Playlist-
  Änderung, Pause und Neustart.
- [ ] Berechne Position aus stabiler Zeitbasis und persistiertem Anchor.
- [ ] Vermeide sekündliche Writes und Abruf-seitige Fortschaltung.
- [ ] Plane den nächsten Übergang über dauerhafte Ereignis-/Jobsemantik.
- [ ] Rekonstruiere Zustand nach Neustart deterministisch.
- [ ] Teste leere/einzelne Playlists, lange Downtime, Uhrgrenzen und Parallelität.

**Abnahme:** Zwei Prozesse berechnen aus demselben Zustand denselben Eintrag und
nächsten Übergang; ein Restart startet nicht erneut bei Element 1.

**Validierung:** Table-driven Unit-Tests mit Fake Clock und Restart-Integrationstest.

**Handoff:** Übergangsevents und Cache-Invalidierungsinputs für WP-19 notieren.

## WP-19 – Rendercache, Deduplizierung und Artefaktfallback

**Ziel:** Gleicher Inhalt wird einmal gerendert, atomar gespeichert und bei
Fehlern aus der letzten gültigen Version ausgeliefert.

**Kontext:** 20 Displays dürfen keine 20 Puppeteer-/Sharp-Jobs für identischen
Inhalt auslösen.

**Voraussetzungen:** WP-14, WP-17 und WP-18.

**Scope:** Render-Key, Queue-Deduplizierung, Artefaktmetadaten, Speicherung,
Fallback und Cacheinvalidierung.

**Aufgaben:**

- [ ] Definiere kanonischen Render-Key aus Publication, Profil, Snapshots und
  Renderer-Version.
- [ ] Dedupliziere parallele identische Renderanforderungen.
- [ ] Schreibe Artefakte temporär und veröffentliche sie atomar nach Validierung.
- [ ] Persistiere Hash, MIME-Type, Größe, Renderer-Version und Erstellzeit.
- [ ] Liefere während Renderfehlern das letzte gültige kompatible Artefakt.
- [ ] Invalidiere nur bei relevanten Versionsänderungen.
- [ ] Ergänze E-Ink-spezifische Format-/Refresh-Metadaten.
- [ ] Teste 20 parallele Requests, fehlerhaften Renderer und Prozessabbruch.

**Abnahme:** 20 identische Requests erzeugen genau einen Renderjob; ein kaputter
neuer Render entfernt das letzte gültige Artefakt nicht.

**Validierung:** Concurrency-, Cache-, Atomicity- und Fault-Tests.

**Handoff:** Cachepfade, Retention und beobachtbare Kennzahlen notieren.

## WP-20 – Worker-Bootstrap und Queue-Policies vereinheitlichen

**Ziel:** Langsame Hintergrundarbeit kann getrennt vom API-Prozess laufen und
folgt einheitlichen Resilienzregeln.

**Kontext:** BullMQ ist vorhanden, aber Jobs, In-Process-Cron und Fehlerbehandlung
sind uneinheitlich.

**Voraussetzungen:** WP-16.

**Scope:** Separater Bootstrap/Prozessmodus, Queue-Konfiguration, Jobbasis,
Shutdown und Health. Noch keine echte Source.

**Aufgaben:**

- [ ] Trenne API- und Worker-Bootstrap bei weiterhin einfachem Dockerbetrieb.
- [ ] Zentralisiere Queue-Namen, Redis-Konfiguration und Jobversionen.
- [ ] Definiere Standard für Timeout, Attempts, Backoff/Jitter, Retention und
  Idempotenz-Key.
- [ ] Implementiere graceful Shutdown und Job-Lease-Verhalten.
- [ ] Vereinheitliche Cron/Repeatable Jobs und entferne doppelte Cleanup-Wege.
- [ ] Ergänze Worker-Readiness und Queue-Degraded-Status.
- [ ] Teste API-Betrieb bei gestopptem, langsamem und neu startendem Worker.

**Abnahme:** API und vorhandene Displays bleiben nutzbar, wenn der Worker gestoppt
oder neu gestartet wird; Jobs werden danach kontrolliert fortgesetzt.

**Validierung:** Prozess-, Redis-, Shutdown- und Docker-Integrationstests.

**Handoff:** Startbefehle, Queue-Defaults und Deploymentauswirkungen notieren.

## WP-21 – SourceSnapshot-Fundament und Resilienz-Connectoren

**Ziel:** Externe Abfragen schreiben versionierte Snapshots; Renderer starten keine
externen Requests.

**Kontext:** Es werden noch keine produktiven Mail-/HA-/Grafana-Connectoren gebaut.
Fixture-, Slow- und Failure-Connector prüfen nur die Architektur.

**Voraussetzungen:** WP-20.

**Scope:** SourceDefinition, Secret-Referenz, SourceSnapshot, Scheduling,
Freshness und drei Testconnectoren.

**Aufgaben:**

- [ ] Implementiere persistente SourceDefinition und SourceSnapshot entsprechend
  WP-04.
- [ ] Lege Secretwerte getrennt und write-only in API-Antworten ab.
- [ ] Plane Refresh-Jobs mit globaler/providerbezogener Concurrency.
- [ ] Implementiere Fixture-, absichtlich langsamen und absichtlich fehlerhaften
  Connector.
- [ ] Standardisiere Timeout, Abort, Retry, Circuit Breaker und Freshness.
- [ ] Bewahre letzten gültigen Snapshot mit `stale`-Status.
- [ ] Beweise per Test, dass Renderer/API nur persistierte Snapshots lesen.

**Abnahme:** Ein hängender Connector blockiert weder Login noch Manifest; ein
Fehler löscht den letzten gültigen Snapshot nicht.

**Validierung:** Queue-, Timeout-, Circuit-Breaker-, Stale- und Isolationstests.

**Handoff:** Connectorinterface und Anforderungen realer Provider notieren.

## WP-22 – Isolationsgrenze für Plugin-/Blockiercode

**Ziel:** Unbekannter oder nicht abbrechbarer Code läuft nicht im API-Prozess und
erhält keine Provider-Credentials.

**Kontext:** Der bestehende Plugin-Transformationscode kann per `AsyncFunction` im
Serverprozess laufen; ein Promise-Timeout stoppt ihn nicht zuverlässig.

**Voraussetzungen:** WP-20 und WP-21.

**Scope:** Vertrauensklassen, Prozess-/Worker-Isolation, Ressourcenlimits,
Secretgrenze und ein adversarial Testplugin. Kein Marketplace.

**Aufgaben:**

- [ ] Klassifiziere Built-in-Connector, deklarative Erweiterung und unbekannten
  Code getrennt.
- [ ] Definiere zulässige Inputs/Outputs ohne direkten Tokenzugriff.
- [ ] Verschiebe unbekannten Code in einen beendbaren Subprozess/Worker mit
  Zeit-, Speicher- und Netzwerkpolicy.
- [ ] Übergib nur normalisierte Daten und temporäre minimal notwendige Rechte.
- [ ] Töte hängenden Code zuverlässig und markiere Job/Source als fehlerhaft.
- [ ] Teste Endlosschleife, Speicherlast, Token-Exfiltrationsversuch und Crash.

**Abnahme:** Ein bösartiges Testplugin kann API/Worker nicht dauerhaft blockieren
und sieht kein Provider-Refresh-Token.

**Validierung:** Adversarial-, Timeout-, Prozess-Cleanup- und Secret-Tests.

**Handoff:** Unterstützte Erweiterungsklassen und verbleibende OS-Sandboxgrenzen
notieren.

## WP-23 – Interaction-/Command-Pipeline implementieren

**Ziel:** Touch-Geräte senden versionierte, authentifizierte und idempotente
Aktionen statt beliebiger API-Aufrufe.

**Kontext:** Timer folgt erst in WP-24. Dieses Paket baut die widgetneutrale
Pipeline mit einer harmlosen Testaktion wie `view.next`.

**Voraussetzungen:** WP-04, WP-15 und WP-16.

**Scope:** Endpunkt/WebSocket-Message, Validierung, AuthZ, Deduplizierung,
CommandResult und Audit.

**Aufgaben:**

- [ ] Akzeptiere InteractionEvent über den gemeinsamen Contract.
- [ ] Prüfe DeviceCredential und in Publication erlaubte Aktion.
- [ ] Speichere `eventId`/Resultat für idempotente Wiederholung.
- [ ] Begrenze Payload, Frequenz und Zeitfenster.
- [ ] Route zu registrierten CommandHandlern ohne Widget-Switch im Controller.
- [ ] Antworte synchron mit accepted/rejected/duplicate und Correlation-ID.
- [ ] Implementiere/teste `view.next` als vertikalen Durchstich.

**Abnahme:** Ein doppelter Touch erzeugt genau eine Zustandsänderung; nicht
publizierte Aktionen werden abgelehnt.

**Validierung:** Auth-, Replay-, Duplicate-, Rate-Limit- und Handler-Tests.

**Handoff:** Handlerregistrierung und Timerpayload-Anforderungen notieren.

## WP-24 – Persistente Timer-Domäne implementieren

**Ziel:** Timerzustand und Befehle sind fachlich korrekt und unabhängig von UI,
WebSocket und Queue modelliert.

**Kontext:** Lies `ARCHITECTURE_PLAN.md`, Abschnitt 6.7. Es gibt keine sekündlichen
DB-Writes; Restzeit wird aus `endsAt` berechnet.

**Voraussetzungen:** WP-23.

**Scope:** Timer-Schema, Zustandsautomat, CommandHandler und Fake-Clock-Tests.
Scheduling/Push folgt WP-25.

**Aufgaben:**

- [ ] Modelliere Timer, Sichtbarkeit, Erstellergerät und Zustände.
- [ ] Implementiere create, pause, resume, cancel und acknowledge idempotent.
- [ ] Verwende Serverzeit und persistiere `endsAt`/Restzeit statt Ticks.
- [ ] Definiere Berechtigungen für private/geteilte Timer.
- [ ] Erzeuge Outbox-Events bei fachlichen Zustandsänderungen.
- [ ] Teste Grenzwerte, ungültige Übergänge, Doppelbefehle und Uhrfortschritt.

**Abnahme:** Der Zustandsautomat ist mit kontrollierter Uhr deterministisch und
benötigt zwischen Start und Ende keinen periodischen Write.

**Validierung:** Table-driven Unit-, Prisma- und Command-Integrationstests.

**Handoff:** Timer-Events, nächste Fälligkeiten und UI-Datenmodell notieren.

## WP-25 – Timer planen, wiederherstellen und verteilen

**Ziel:** Timer enden zuverlässig nach Neustart und werden auf verbundenen sowie
später pollenden Displays konsistent sichtbar.

**Kontext:** Timerdomäne aus WP-24, Worker aus WP-20, Transport/Eventpfade aus
WP-14 bis WP-16 verwenden.

**Voraussetzungen:** WP-20 und WP-24.

**Scope:** Durable Jobs, Startup-Recovery, Completion, Serverzeit und minimale
ESP32-/Browser-Testoberfläche. Kein allgemeines Timer-Widgetdesign.

**Aufgaben:**

- [ ] Plane pro laufendem Timer einen idempotenten Abschlussjob.
- [ ] Rekonstruiere zukünftige Jobs und schließe überfällige Timer beim Start ab.
- [ ] Verhindere doppelte Completion bei Worker-Race/Retry.
- [ ] Push Timeränderungen an berechtigte verbundene Displays.
- [ ] Integriere Timerzustand in den nächsten Pull-Zustand für E-Ink.
- [ ] Liefere Serverzeit/Offset für lokale Countdownanzeige.
- [ ] Baue einen minimalen Testscreen zum Erstellen und Beobachten.
- [ ] Teste Neustart, Offline, Doppel-Tap, zwei Displays und Clock Skew.

**Abnahme:** Ein ESP32-/Browser-Client erstellt einen Timer, Pi-Browser sieht ihn
sofort, TRMNL beim nächsten Pull und ein Serverneustart ändert das Ergebnis nicht.

**Validierung:** End-to-End-, Restart-, Multi-Client- und Fake-Clock-Test.

**Handoff:** Referenzablauf und spätere Widget-/Benachrichtigungsfragen notieren.

## WP-26 – Föderationsvertrag und Share-Credentials

**Ziel:** Ein Remote-Server kann genau eine veröffentlichte Ansicht read-only und
widerrufbar teilen.

**Kontext:** Standard ist das Hub-Modell: Displays sprechen nur mit ihrem
Home-Server; dieser abonniert Remote-Publications.

**Voraussetzungen:** WP-04, WP-12 und WP-17.

**Scope:** Federation-Contract, Discovery/Capabilities, ShareCredential,
Publication-Feed und Tests. Noch kein Remote-Import-Worker.

**Aufgaben:**

- [ ] Definiere versionierten Federation-Capability- und Publication-Feed.
- [ ] Begrenze ShareCredential auf read-only, eine Publication und optionalen
  Ablauf.
- [ ] Speichere nur Credentialhash und Auditmetadaten.
- [ ] Liefere Manifest/Artefaktmetadaten mit ETag und stabiler Remote-Server-ID.
- [ ] Implementiere Widerruf und konstante Authfehler.
- [ ] Verhindere Zugriff auf Entwürfe, Sources, Secrets und Gerätebefehle.
- [ ] Ergänze Kompatibilitäts-, Scope- und Widerrufstests.

**Abnahme:** Ein ShareCredential kann ausschließlich die freigegebene Publication
lesen und keine lokalen Aktionen auslösen.

**Validierung:** Contract-, AuthZ-, ETag- und Negative-Security-Tests.

**Handoff:** Feed-Endpunkte, Version und Anforderungen an WP-27 notieren.

## WP-27 – Remote-Abonnements und lokales Fallback

**Ziel:** Der Home-Server synchronisiert sicher Publications mehrerer Remote-
Server, cached sie und bleibt bei Remote-Ausfall nutzbar.

**Kontext:** Beispiele sind lokales Smart Home, eigener Internetserver und Server
eines Freundes. Direkte Multi-Server-Verbindungen am Display sind nicht Scope.

**Voraussetzungen:** WP-20 und WP-26.

**Scope:** RemoteServer/Subscription-Modelle, sicherer Fetch-Worker, Cache,
Diagnostik und minimale Admin-UI.

**Aufgaben:**

- [ ] Persistiere kanonische Basis-URL, Remote-ID, Credentialreferenz und Status.
- [ ] Validiere HTTPS, DNS, Redirects, Zieladressen und Antwortgrößen gegen SSRF/
  Rebinding.
- [ ] Synchronisiere Manifest per Conditional GET mit begrenzter Concurrency.
- [ ] Lade Artefakte hashgeprüft und atomar in lokalen Cache.
- [ ] Liefere bei Remote-Ausfall die letzte gültige Version mit `stale`-Status.
- [ ] Zeige Vertrauen, letzte Synchronisation, Fehler und Widerruf im Admin-UI.
- [ ] Teste zwei Remotes, Ausfall, Credentialwiderruf und Protokollmismatch.

**Abnahme:** Zwei Remote-Publications bleiben nach Abschalten der Remote-Server aus
lokalem Cache sichtbar; Fehler sind eindeutig erkennbar.

**Validierung:** Integration-, SSRF-, Redirect-, ETag-, Offline- und Cachetests.

**Handoff:** Unterstützte Federation-Versionen und bewusst nicht unterstützte
direkte Displayverbindungen notieren.

## WP-28 – Observability und Betriebszustände

**Ziel:** Betreiber erkennen langsame Sources, Queue-Stau, Renderfehler,
Verbindungsprobleme und veraltete Displays ohne Secrets in Logs.

**Kontext:** Last-/Freigabetests in WP-29 benötigen messbare Grenzwerte.

**Voraussetzungen:** WP-20. Darf nach WP-20 parallel zu WP-21 bis WP-27 bearbeitet
werden, solange deren APIs nicht vorweggenommen werden.

**Scope:** Strukturierte Logs, Correlation-IDs, Metriken, Health/Readiness/Degraded
und minimale Diagnoseoberfläche.

**Aufgaben:**

- [ ] Definiere ein strukturiertes Logschema für Request, Job, Device und Event.
- [ ] Propagiere Correlation-ID über API, Outbox, Queue und Delivery.
- [ ] Redigiere Token, Codes, Cookies, Header und Source-Secrets zentral.
- [ ] Erfasse Queue-Alter, Jobdauer/-fehler, Rendercache, WebSockets und Device-Age.
- [ ] Trenne Liveness, Readiness und Degraded-Status.
- [ ] Zeige letzte erfolgreiche Source-/Device-/Remote-Aktivität im Admin-UI.
- [ ] Lege Retention und Cardinality-Grenzen fest.

**Abnahme:** Ein absichtlich langsamer Job und ein getrenntes Display sind anhand
von Metrik/Log/Status auffindbar; kein Testsecret erscheint in Ausgaben.

**Validierung:** Redaction-, Correlation-, Health- und Metriktests.

**Handoff:** Metriknamen, Schwellenkandidaten und externe Monitoringoptionen
notieren.

## WP-29 – Foundation-Freigabegate

**Ziel:** Die Foundation wird unter Last, Fehlern, Neustarts und Restore geprüft;
offene Blocker sind priorisiert dokumentiert.

**Kontext:** Dies ist kein Featurepaket, sondern die Abnahme der in
`ARCHITECTURE_PLAN.md`, Abschnitt 12 definierten Erfolgskriterien.

**Voraussetzungen:** WP-19, WP-21, WP-25, WP-27 und WP-28 sowie alle jeweiligen
Abhängigkeiten.

**Scope:** Last-, Fault-, Security-, Migration-, Backup-/Restore- und
End-to-End-Tests; gezielte kleine Fixes nur, wenn sie eindeutig im Testscope liegen.

**Aufgaben:**

- [ ] Simuliere mindestens 20 dauerhafte WebSocket-Displays.
- [ ] Kombiniere Batterie-Pull, schnellen Pull, WebSocket und Touchaktionen.
- [ ] Starte parallele Slow-/Failure-Sources und Renderanforderungen.
- [ ] Miss API-Latenz, Queue-Alter, Renderdeduplizierung, DB-Writes und Speicher.
- [ ] Unterbrich Worker, Redis, Remote-Server und WebSockets kontrolliert.
- [ ] Teste Backup/Restore und Migration mit aktiven Timern und Publications.
- [ ] Führe Auth-, Replay-, SSRF- und Secret-Redaction-Suite aus.
- [ ] Dokumentiere Grenzwerte, Ergebnisse und alle P0/P1/P2-Befunde.
- [ ] Aktualisiere Docker-/Betriebsdokumentation und Release-Checkliste.

**Abnahme:** Alle Foundation-Erfolgskriterien sind nachweislich erfüllt; kein
offener P0/P1-Befund bleibt und jeder P2-Befund besitzt einen Folgeschritt.

**Validierung:** Vollständiger CI-Lauf, Docker-End-to-End und veröffentlichter
Testbericht im Repository.

**Handoff:** Freigabeentscheidung, gemessene Kapazität und nächster Produkt-/Widget-
Backlog notieren.

## 5. Handoff-Format pro abgeschlossenem Paket

Am Ende jedes Pakets wird unter seinem Abschnitt oder in einer verlinkten
Handoff-Datei Folgendes ergänzt:

```markdown
### Abschluss WP-XX

- Status: abgeschlossen am YYYY-MM-DD
- Ergebnis:
- Geänderte Kernpfade:
- Ausgeführte Tests:
- Nicht ausführbare Tests und Grund:
- Bewusste Abweichungen vom Paket:
- Neue Risiken/Schulden:
- Relevante Hinweise für WP-YY:
- Git-Stand/Commit: nicht committed | <hash>
```

Die Paketcheckbox im Index wird erst auf `[x]` gesetzt, wenn Abnahme und
Validierung erfüllt sind. Teilfertige Arbeit bleibt `[ ]` und erhält einen klaren
Zwischenstand im Handoff.
