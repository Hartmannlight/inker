# Produkt-, UX- und Funktions-Reparaturplan

Stand: 29. August 2026
Repository: `C:\Users\Nathaniel\Documents\StatusPanel\inker`
Ausgangsbranch bei Erstellung: `codex/device-platform-spike` (`06e337b`)
Status: geplant, noch nicht implementiert

## Ansatz

Zuerst werden die drei blockierenden Funktionsketten Grafana, Publication/Rendering
und Pairing repariert. Danach wird das Bedienmodell vereinfacht: Ein einzelner
Screen kann direkt einem Gerät zugewiesen werden; Playlists bleiben eine optionale
Funktion für Rotation. Provider-Zugänge werden unter **Integrationen** verwaltet,
während die globalen Einstellungen nur installationsweite Optionen enthalten.

Inker bleibt dabei ein eigenständiges Produkt und wird weder zu einem Klon von
TRMNL Core noch von Terminus. **Integrationen** sind Inker-native, vertrauenswürdige
Verbindungen zu externen Diensten. **Extensions** sind davon getrennte
Darstellungspakete. Eine mögliche TRMNL-Kompatibilität wird ausschließlich als
begrenzte Import-/Übersetzungsschicht für deklarative Liquid-Rezepte untersucht;
sie darf SourceSnapshots, Workergrenzen, Secret-Isolation, Publications und
Geräteprofile nicht umgehen. Wegen des bewusst kleinen zusätzlichen
Entwicklungsbudgets gilt: erst messen und entscheiden, nicht vorsorglich einen
Marketplace oder eine zweite Plugin-Runtime bauen.

Die bestehende Sicherheitsarchitektur bleibt maßgeblich: Renderer lesen keine
Live-Provider, Geräte erhalten nur veröffentlichte unveränderliche Artefakte und
anonyme Legacy-Render-Endpunkte werden nicht wieder aktiviert.

## Scope

- **Im Scope:** Informationsarchitektur, Grafana-Connector, sichere Vorschauen und
  Publications, direkte Screen-Zuweisung, Playlist-UX, Auflösungsanpassung,
  optionale Gerätetelemetrie, Short-Code-Pairing, lokale HTTP-Diagnose,
  Keycloak-vorbereitete Auth-Grenze, englische Projekt-README, Tests,
  Betriebsdokumentation und eine begrenzte, evidenzbasierte Untersuchung
  deklarativer TRMNL-/`trmnlp`-Recipe-Kompatibilität.
- **Nicht im Scope:** vollständige Keycloak-Integration, generischer Plugin-
  Marketplace, vollständiger Terminus-/TRMNL-Core-Nachbau, Spiegelung des
  gehosteten TRMNL-Integrationskatalogs, Ruby-/ERB-Kompatibilität, beliebige
  Python-/Ruby-/PHP-/Node-Transforms, automatische Ausführung oder Aktualisierung
  fremden Codes, breite OAuth-Providerbibliothek, neue Hardware-Firmware und
  automatische Erkennung des physischen Netzwerkmediums ohne Gerätetelemetrie.

## Verbindliche Produktentscheidungen

| Thema | Entscheidung |
|---|---|
| Einzelner Screen | Wird direkt veröffentlicht und einem Gerät zugewiesen. Dafür ist keine sichtbare Playlist nötig. |
| Playlist | Ist nur für zwei oder mehr rotierende Inhalte, zeitgesteuerte Abfolge oder Touch-Weiterschaltung erforderlich. |
| Playlist mit einem Eintrag | Bleibt aus Kompatibilitätsgründen zulässig, erzeugt aber keine periodische Neuzuweisung und keinen unnötigen Download. |
| Auflösung | Alle Screens bleiben auswählbar. Exakte Treffer werden empfohlen; abweichende Formate werden markiert, für das Zielgerät gerendert und standardmäßig proportional mit `contain` eingepasst. |
| Unbekannte Werte | Akku, Signalstärke und Netzwerkmedium werden nicht erfunden. Unbekannt bedeutet `null`/nicht vorhanden und wird im UI nicht angezeigt. |
| Provider-Zugänge | Grafana und später nur gezielt ausgewählte weitere Dienste sind **Integrationen** mit je eigener verschlüsselter Verbindung. Sie gehören nicht in globale Settings. |
| Extensions | Bleiben als von Integrationen getrennter Produktbereich für Darstellungspakete erhalten. Eine Extension konsumiert nur validierte Inker-Snapshots und besitzt keine Provider-Secrets oder eigenen Netzwerkzugriff. |
| Plugin-Begriff | Bleibt nur interner Legacy- beziehungsweise externer Kompatibilitätsbegriff, etwa „Import TRMNL plugin/recipe“, und verschwindet als dritter konkurrierender Hauptbereich aus der Navigation. |
| Ökosystem-Kompatibilität | Geräteprotokoll und ein sicherer deklarativer Recipe-Teilstandard dürfen kompatibel sein; Source-, Secret-, Worker-, Render-, Publication- und Delivery-Runtime bleiben Inker-native. |
| Kompatibilitätsbudget | UX-09 ist zunächst eine Bestandsaufnahme mit höchstens kleinen Test-Fixtures. Ein produktiver Importer wird nur als separates Folgepaket freigegeben, wenn die dokumentierte Go/No-Go-Schwelle erreicht ist. |
| README-Sprache | Die öffentliche `README.md` wird vollständig auf Englisch gepflegt. Interne bestehende Architektur- und Betriebsdokumente müssen nicht allein für eine Sprachvereinheitlichung umgeschrieben werden. |
| Pairing | Der zehnstellige Einmalcode ist der einzige sichtbare Bootstrap. Der lange „Legacy pairing link“ wird entfernt. Bestehende bereits ausgegebene Geräte-Credentials bleiben gültig. |
| Login/Pairing | Eine gemeinsame Startseite bietet „Als Admin anmelden“ und „Display koppeln“. Beide verwenden getrennte Backend-Endpunkte und Berechtigungen. |
| Rendering | `410 PUBLICATION_REQUIRED` bleibt für die anonymen Legacy-Endpunkte bestehen. Das Admin-UI wird auf geschützte Preview-/Publication-Endpunkte umgestellt. |

## Warum die gemeldeten Fehler aktuell auftreten

- Grafana ist im UI sichtbar, aber der Backendpfad endet absichtlich mit
  `503 SOURCE_REFRESH_REQUIRES_CONNECTOR`. Produktive Netzwerk-Connectoren sind
  laut `docs/operations/SOURCE_OPERATIONS.md` noch nicht implementiert; der
  eingegebene Token kann diesen fehlenden Codepfad nicht aktivieren.
- `frontend/src/pages/Dashboard.tsx` und
  `frontend/src/pages/devices/DeviceDetail.tsx` rufen weiterhin
  `/api/device-images/design/:id` beziehungsweise
  `/api/device-images/device/:id` auf. Diese Routen liefern in
  `backend/src/api/api.controller.ts` bewusst `410 PUBLICATION_REQUIRED`.
- Die neue Publication-/Playback-Architektur existiert im Backend, wird von den
  normalen Screens-/Playlists-/Devices-Seiten aber noch nicht als durchgehender
  Benutzerworkflow angesteuert. Ein erstellter oder einer alten Playlist
  hinzugefügter Screen wird deshalb nicht automatisch zur gewünschten
  Publication eines Geräts.
- `frontend/index.html` bindet `/fonts/fonts.css` zusätzlich zu den bereits in
  `frontend/src/index.css` enthaltenen `@font-face`-Regeln ein. Die lokale
  `types`-Tabelle des nginx-Blocks `/fonts/` kennt derzeit nur Font-Endungen;
  dadurch kann `fonts.css` als `application/octet-stream` ausgeliefert werden.
- Browser-Telemetrie sendet momentan nur die Viewportgröße. Die alten
  Datenbankspalten `battery` und `wifi` haben jedoch den Default `0`, und die
  Dashboard-Seite interpretiert diesen Default als gemessenen Wert.
- Beim Short-Code-Austausch schützt `PairingTransportGuard` HTTP standardmäßig.
  Ohne `PAIRING_ALLOW_INSECURE_HTTP=true` antwortet der Server daher erwartbar
  mit `403`; die Oberfläche erklärt die konkrete Serverkonfiguration noch nicht.
- Parallel zum neuen Einmalcode erzeugen Device-Service und Detailseite noch den
  alten langen Bootstrap-Link. Dadurch existieren zwei sichtbare Pairingkonzepte.
- Der globale GitHub-Token in Settings wird außerhalb seines eigenen Test-
  Endpunkts derzeit nicht für eine funktionierende Integration verwendet.

## Sicherheitsmaßnahme vor Beginn

- [ ] Den im Chat offengelegten Grafana-Service-Account-Token in Grafana sofort
  widerrufen und einen neuen Token mit minimalen Viewer-Rechten erzeugen.
- [ ] Den Ersatz-Token ausschließlich in Inkers verschlüsseltem
  Integrations-Credential speichern; nie in diese Datei, Fixtures, Screenshots,
  URLs, Logs oder Commit-Nachrichten übernehmen.
- [ ] Vor einer Datenmigration SQLite **und** das passende Instanz-Secret gemeinsam
  nach `docs/operations/DATABASE_BACKUP.md` sichern.

## Paketindex und Reihenfolge

Die Reihenfolge ist verbindlich. Ein Paket wird erst abgehakt, wenn seine
Akzeptanzkriterien und Tests erfüllt und sein Handoff ergänzt sind.

| Status | Paket | Priorität | Ergebnis | Abhängigkeit |
|---|---|---:|---|---|
| [x] | UX-00 | P0 | Reproduzierbare Fehlerbaseline und Secret-Bereinigung | – |
| [x] | UX-01 | P1 | Klare Navigation und bereinigte Oberfläche | UX-00 |
| [ ] | UX-02 | P0 | Produktiver Grafana-Connector | UX-00, UX-01 |
| [x] | UX-03 | P0 | Durchgängige Publication-/Renderkette und fehlerfreie Vorschauen | UX-00 |
| [x] | UX-04 | P0 | Einheitliches Short-Code-Pairing auf der Startseite | UX-00 |
| [x] | UX-05 | P1 | Direkte Screen-Zuweisung ohne Pflicht-Playlist | UX-03 |
| [x] | UX-06 | P1 | Auflösungsbewusste Auswahl und sichere Anpassung | UX-03, UX-05 |
| [x] | UX-07 | P1 | Playlistbearbeitung ohne Doppelbestätigung | UX-05, UX-06 |
| [x] | UX-08 | P1 | Fähigkeits- und telemetriebasierte Geräteanzeige | UX-00 |
| [x] | UX-09 | P2 | Begrenztes TRMNL-Kompatibilitätsinventar mit Go/No-Go | UX-00, UX-01 |
| [ ] | UX-10 | P0/P1 | End-to-End-Abnahme, Migration und Dokumentation | UX-01 bis UX-09 |

---

## UX-00 – Fehlerbaseline und sichere Testdaten

**Ziel:** Jeder gemeldete Fehler ist ohne Geheimnisse reproduzierbar und besitzt
einen eindeutigen Korrelationspunkt zwischen Browser, API, Worker und Datenbank.

### Aufgaben

- [x] Einen frischen lokalen Testdatensatz mit je einem Browsergerät, Pull-Gerät,
  Upload-Screen, Design-Screen, Grafana-Verbindungsentwurf und einer Playlist mit
  einem Eintrag anlegen.
- [x] Die Antworten für Grafana-Dashboardliste, Design-Preview,
  Device-Preview, Pairing-Exchange und Display-Manifest mit HTTP-Status,
  Fehlercode und `X-Correlation-ID` dokumentieren; keine Headerwerte oder Bodies
  mit Credentials speichern.
- [x] Bestätigen, dass API- und Worker-Prozess laufen. Grafana darf nicht als
  „Token ungültig“ diagnostiziert werden, solange der Connector selbst fehlt.
- [x] Das aktuelle Verhalten einer Ein-Eintrag-Playlist mit Fake Clock messen:
  Anzahl Transitionen, `desiredSequence`, Renderrevision und Artefaktdownloads.
- [x] Den Font-MIME-Typ über nginx und den direkten Entwicklungsserver prüfen.
- [x] Einen fehlgeschlagenen HTTP- und einen erfolgreichen HTTPS-/explizit
  freigegebenen HTTP-Pairingfall getrennt festhalten.

### Betroffene Bereiche

- `backend/src/observability/`
- `backend/src/device-enrollment/`
- `backend/src/plugins/`, `backend/src/sources/`
- `backend/src/playback/`, `backend/src/publications/`
- `frontend/src/pages/display/`, `frontend/src/pages/devices/`

### Akzeptanz und Tests

- [x] Die Baseline enthält für jedes Symptom einen reproduzierbaren Schritt und
  den erwarteten aktuellen Fehlercode.
- [x] Secret-Redaction-Tests bleiben grün; eine Repository-Suche findet weder den
  widerrufenen noch den neuen Token.
- [x] `git status --short` und die verwendeten Fixture-IDs werden im Handoff
  notiert; fremde Änderungen bleiben unberührt.

### Handoff

- Ergebnis: Abgeschlossen. Reproduzierbare, secret-freie Baseline in
  `docs/architecture/UX-00_BASELINE.md` dokumentiert, einschließlich isolierter
  API-/Worker-/nginx-Laufzeitbelege sowie aktuellem Vite-MIME-Smoke.
- Testbelege: Bun 1.3.14, 29.08.2026: Secret-/Source-Boundary 37 grün;
  Device-Enrollment-Integration 4 grün; Singleton-Playback 1 grün;
  HTTP-/Correlation-Integration 10 grün; Publication-/Manifest-Integration 2
  grün (716 Assertions); Playlist-/Design-/Device-Outbox-Integration 1 grün.
  Vite auf `127.0.0.1:5173`: Index 200
  mit referenzierter Fontdatei; `/fonts/fonts.css` 200 `text/css`.
  Temporäre Fixture-Präfixe:
  `inker-enrollment-test-*`, `inker-playback-*`, `inker-correlation-*`.
- Offene Abweichungen: Eine frische, flüchtige Docker-Instanz auf
  `127.0.0.1:18080` wurde nach bestandenem Ready-Smoketest wieder entfernt.
  Sie bestätigte den nginx-Defekt erneut: `/fonts/fonts.css` lieferte `200
  application/octet-stream`; der direkte Vite-Server liefert dagegen `200
  text/css`. Der gemeinsame authentifizierte Liveflow mit Upload-/Design-Screen,
  Ein-Eintrag-Playlist und Display-Manifest ist durch die gezielten
  Publication-/Manifest- und Playback-Integrationstests abgedeckt. Git-Status zu
  Paketbeginn: Änderungen an `Sidebar.tsx` und
  `Settings.tsx` sowie diese beiden untracked UX-Dokumente; alles wurde erhalten.
  Kein Grafana-Token wurde verwendet. Ein echter Grafana-Smoke bleibt bis zur
  bestätigten Sperrung des kompromittierten Tokens und einem neuen minimal
  berechtigten Token blockiert.

---

## UX-01 – Informationsarchitektur und Oberflächenbereinigung

**Ziel:** Normale Benutzer sehen verständliche Produktbegriffe und keine drei
konkurrierenden Stellen für Erweiterungen und Provider-Secrets.

### Zielstruktur

- **Integrationen:** konfigurierte externe Systeme und deren Zustand, zunächst
  Grafana; später nur bewusst ausgewählte GitHub-, Home-Assistant- oder andere
  Inker-native Connectoren.
- **Extensions:** installierte oder selbst erstellte Darstellungspakete mit
  Layouts und Konfigurationsschema. Sie dürfen Daten aus Integrationen verwenden,
  sind aber selbst keine Providerverbindung. Der Bereich bleibt auch ohne
  öffentlichen Katalog sinnvoll und sichtbar.
- **Datenquellen (erweitert):** normalisierte Datenströme/Snapshots. Dieser
  technische Bereich kann als Tab innerhalb Integrationen liegen.
- **Eigene Widgets:** visuelle Bausteine und Templates; erreichbar aus Screens/
  Designer, nicht als konkurrierende Erweiterungsplattform.
- **Settings:** Welcome Screen, Netzwerk-/Pairing-Sicherheit, Admin-Sessions und
  Serverdiagnose. Keine Provider-Tokens.
- **Plugins:** interner Legacy-/Kompatibilitätsname und keine primäre Navigation.
  Alte URLs erhalten zielgenaue Redirects, damit Bookmarks nicht sofort brechen.

### Aufgaben

- [x] In `frontend/src/components/layout/Sidebar.tsx` den Eintrag „Plugins“
  entfernen. Je einen klar beschriebenen Einstieg **Integrations** für externe
  Verbindungen und **Extensions** für Darstellungspakete behalten; aktive Routen
  korrekt behandeln.
- [x] Die Grafana-Verbindung auf eine Integrationsseite mit Tabs „Connections“
  und „Data sources (advanced)“ verschieben. `frontend/src/pages/extensions/`
  nicht allein für eine kosmetische Umbenennung mit diesem Bereich verschmelzen.
- [x] Den Extensions-Bereich auf vorhandene installierte/eigene
  Darstellungspakete begrenzen. Solange UX-09 keinen Importer freigibt, weder
  leeren Marketplace noch allgemeine TRMNL-Kompatibilität versprechen.
- [x] Alte `/plugins`, `/plugins/installed`, `/extensions` und
  `/data-sources`-Einstiege in `frontend/src/App.tsx` semantisch umleiten:
  Grafana/Connections zu Integrations, Library/Installed/Creator zu Extensions
  und Datenquellen zum Advanced-Tab. Bearbeitungsrouten und Prisma-Modellnamen
  dürfen intern zunächst bestehen bleiben; kein großflächiger Refactor nur für
  Terminologie.
- [x] `ApiSettings` aus `frontend/src/pages/settings/Settings.tsx` entfernen.
  Den ungenutzten globalen `github_token`, seinen Test-Endpunkt, DTOs, Typen und
  Tests entfernen oder mit einer Datenmigration kontrolliert bereinigen.
- [x] Künftige GitHub-Zugänge ausschließlich als eigene Integration mit
  schreibgeschützter/verschlüsselter Credential-Anzeige planen; keine automatische
  Übernahme des alten globalen Tokens.
- [x] „Buy Me a Coffee“ aus Sidebar und `README.md` entfernen und das danach
  unreferenzierte Bild-Asset löschen.
- [x] Die irreführende grüne „System Online“-Anzeige entfernen. Versionsnummer und
  ein tatsächlich festgestelltes „Update Available“ dürfen als getrennte,
  sachliche Information erhalten bleiben.
- [x] Texte und README korrigieren, die Grafana bereits als funktionsfähig
  bewerben, solange UX-02 noch nicht abgeschlossen ist.

### Akzeptanz und Tests

- [x] Es gibt genau einen sichtbaren Einstieg für externe Systeme.
- [x] Es gibt daneben genau einen klar getrennten Einstieg für
  Darstellungspakete; kein dritter sichtbarer Bereich „Plugins“ konkurriert mit
  Integrations und Extensions.
- [x] Unter Settings befindet sich kein GitHub- oder Grafana-Credential.
- [x] Sidebar enthält weder Coffee-Banner noch eine dauerhafte Pseudo-
  Verfügbarkeitsanzeige.
- [x] Routing-, Sidebar- und Settings-Komponententests decken neue und alte URLs
  ab; `rg` findet keine sichtbaren Altlabels oder Coffee-Referenzen mehr.

### Handoff

- Ergebnis: Abgeschlossen. Sidebar-Einstieg auf `Integrations` geändert, Coffee-Banner,
  Pseudo-Onlineanzeige und globaler GitHub-Token-Settingspfad entfernt. Neue
  geschützte Integrationsseite bietet `Connections` und `Data sources (advanced)`;
  Grafana ist bis UX-02 ausdrücklich `Planned` und nimmt keine Credentials im
  Browser entgegen.
- Geänderte Redirects: `/plugins` und `/plugins/installed` → `/extensions`;
  `/data-sources` → `/integrations?tab=data-sources`. Bearbeitungsrouten bleiben
  aus Kompatibilitätsgründen bestehen.
- Testbelege: 29.08.2026, Bun 1.3.14: Backend `typecheck` grün;
  Settings-Service/-Controller 20 grün; Frontend `typecheck` und Production-Build
  grün; `Integrations.test.tsx` 1 grün. `rg` findet
  keine Coffee-/globalen-GitHub-Settingsreferenz mehr; die verbleibende
  `GITHUB_TOKEN`-Umgebungsvariable im Legacy-Screen-Designer ist kein Settings-
  Credential und wird im passenden Source-/Rendererpaket behandelt.
- Routingtests decken `/plugins`, `/plugins/installed` und `/data-sources` ab;
  Sidebar-/Integrations-Komponententests decken die sichtbare Trennung ab.
  Interne Plugin-Begriffe bleiben ausschließlich in Legacy-URL-, Prisma- und
  Implementierungsnamen bestehen.

---

## UX-02 – Grafana als produktive Integration

**Ziel:** Eine Grafana-Verbindung kann getestet werden, Dashboards und Panels
werden geladen und ein Panel wird über die sichere Source-/Worker-/Publication-
Kette zu einem auslieferbaren Screen.

### Architektur

Providerzugriffe laufen ausschließlich im Worker. Die API legt Commands an und
liest gespeicherte Ergebnisse; sie ruft Grafana nicht synchron im Request und der
Renderer erhält nie den Token. Die Verbindung besteht aus normalisierter Basis-
URL, verschlüsseltem write-only Service-Account-Token, Zeitlimits und
Netzwerkfreigabe. Dashboard-/Panel-Metadaten und Renderergebnisse werden als
versionierte Resultate/Snapshots gespeichert.

### Aufgaben

- [ ] Einen eigenen eingebauten `grafana`-Connector ergänzen, statt die
  Testconnector-Datei unübersichtlich zu erweitern. Registrierung, Konfiguration,
  Jobrouting, Retry/Timeout/Abort und Resultatvalidierung in `backend/src/sources/`
  und Worker-Modulen implementieren.
- [ ] URL-Sicherheit zentral wiederverwenden: nur HTTP(S), DNS-Rebinding-Schutz,
  Redirectgrenzen, Größenlimits und explizite Freigabe privater Ziele. IDN-Hosts
  normalisieren; Zertifikatsfehler niemals still umgehen.
- [ ] Token verschlüsselt und write-only speichern. In API-Antworten nur
  `configured: true/false` und Metadaten liefern; Token nie an Frontend, Renderer,
  Snapshotdaten oder Logs zurückgeben.
- [ ] Einen asynchronen Verbindungstest bauen: Grafana-API erreichbar,
  Authentisierung gültig, Viewer-Rechte ausreichend, Dashboard-Suche möglich und
  Image-Renderer verfügbar. Fehlercodes mindestens für DNS/TLS/Timeout, 401,
  403, fehlenden Renderer und blockiertes Netzwerkziel unterscheiden.
- [ ] Dashboardliste über `/api/search?type=dash-db` und Panelmetadaten über die
  Dashboard-UID normalisieren. Verschachtelte Rows und Library Panels in
  deterministischer Reihenfolge behandeln.
- [ ] Panelbilder über Grafanas Render-API im Worker abrufen. Headerauth bleibt im
  Connector; empfangene Bytes werden auf MIME, Pixelzahl und Größe validiert,
  normalisiert und als Render-/Publication-Artefakt persistiert.
- [x] Die bisherigen Controller-Stubs in
  `backend/src/plugins/plugins.controller.ts`, die immer
  `SOURCE_REFRESH_REQUIRES_CONNECTOR` werfen, durch Commands/Resultatabfragen der
  neuen Integration ersetzen oder nach Migration entfernen.
- [x] Die bisherigen `GrafanaConnectionModal`- und `GrafanaGeneratorModal`-
  Einstiege aus dem Nutzerfluss entfernen und den workerbasierten
  Integrations-Command mit Status, konkreten Fehlerhilfen und Retry verwenden.
- [x] Beim „Save Screen“ einen echten Screen-/Publication-Entwurf erzeugen, keine
  nur als Screen dargestellte Plugin-Child-Instance. Bestehende Child-Instances
  mit einer dokumentierten, idempotenten Migration übernehmen.
- [x] Periodische Aktualisierung so anbinden, dass ein neues Grafana-Artefakt nur
  bei geändertem Inhalt eine neue Render-/Publication-Revision und Geräteausgabe
  auslöst.

### Betroffene Kernpfade

- `backend/src/sources/`, `backend/src/plugins/`, `backend/src/render-cache/`
- `backend/src/publications/`, `backend/src/config/`
- `frontend/src/components/plugins/GrafanaConnectionModal.tsx`
- `frontend/src/components/plugins/GrafanaGeneratorModal.tsx`
- `frontend/src/services/api.ts`
- `docs/operations/SOURCE_OPERATIONS.md`

### Akzeptanz und Tests

- [x] Ein falscher Token ergibt eine verständliche 401-Diagnose; ein fehlender
  Connectorcode ist im Benutzerflow nicht mehr sichtbar.
- [ ] Mit einem neu erzeugten Viewer-Token der angegebenen Grafana-Instanz werden
  Dashboards und Panels geladen und mindestens ein Panel gerendert.
- [x] Connector-Unit- und Integrationstests prüfen Auth, SSRF, Redirects,
  Rebinding, Abbruch, Timeout, Größenlimit, Secret-Redaction und Rendererfehler.
- [x] Keine Netzwerkabfrage findet im API-, Display- oder Rendererprozess statt.
- [x] Ein unverändertes Panel verursacht keinen neuen Gerätedownload.

### Handoff

- Ergebnis: In Arbeit. Ein eingebauter `grafana`-Connector ist im Source-Worker
  registriert. Seine öffentliche Konfiguration enthält nur Basis-URL,
  Dashboard-UID, Panel-ID, Pixelmaße und eine explizite
  `allowLocalNetwork`-Freigabe; öffentliche Antworten enthalten nur
  `secretConfigured: true/false` und leere Legacy-Secret-Referenzen, niemals
  den Secret-Speicher-Identifier. Das write-only Token bleibt weiterhin im
  verschlüsselten `SourceSecret` und wird ausschließlich beim Worker-Job
  entschlüsselt. Der Connector nutzt die zentrale URL-Sicherheitsprüfung und
  deren Rebinding-sichere HTTP(S)-Agents, folgt keinen Redirects, akzeptiert
  nur begrenzte PNG/JPEG-Rendererantworten und persistiert nach einer
  Sharp-Normalisierung ein versioniertes Panel-Snapshot. Dashboard-Suche und
  Panelmetadaten sind eigene asynchrone Source-Job-Operationen und führen
  keinen Provider-Request im API-Prozess aus. Gleiches
  Grafana-Pixelmaterial erzeugt keine neue Source-Revision und damit keinen
  neuen Render-/Geräte-Download.
- Testevidenz: `bun run typecheck` (Backend) erfolgreich;
  `bun test ./src/sources/connectors.test.ts ./src/sources/grafana-connector.test.ts`
  erfolgreich (19 Tests); `bun test ./src/sources/grafana-worker-connector.test.ts`
  erfolgreich (3 lokale Loopback-Stub-Tests für Bearer-Auth, 401,
  Renderer-404, Abbruch und explizit blockiertes privates Ziel);
  `bun test ./test/sources.integration.ts` erfolgreich (15
  SQLite-Source-Worker-Integrationstests, einschließlich der lokalen
  Loopback-Evidenz für unveränderte Grafana-Pixel ohne neue
  Snapshot-Revision); Frontend `bun run typecheck` und
  `bun run test -- ./src/App.test.tsx` erfolgreich (4 Tests). Der alte,
  nicht funktionsfähige Generator-Pfad leitet nach `/integrations` weiter.
  Der neue Beta-Einstieg `/integrations/grafana` erzeugt nur einen
  verschlüsselten Source-Command und liest Status/Retry ausschließlich über
  gespeicherte Source-Ergebnisse; 401, 403, Renderer-, DNS-, TLS-, Timeout-
  und Netzwerkpolicy-Codes werden als konkrete, nicht geheime Hinweise
  dargestellt. Frontend `bun run typecheck` sowie
  `bun run test -- ./src/App.test.tsx ./src/pages/integrations/Integrations.test.tsx`
  sind grün (5 Tests).
  `bun run test -- ./src/pages/integrations/GrafanaPanelSource.test.tsx`
  bestätigt zusätzlich den write-only Browser-Command an `/sources` (1 Test,
  keine Provider-Abfrage).
  Alle Tests liefen ohne echte Grafana-Instanz und ohne Provider-Secret.
  Der gezielte Test „definition, separately encrypted secret …“ bestätigt
  zusätzlich, dass weder Ciphertext noch interne Secret-ID öffentlich werden.
- Unterstützte Grafana-Version/Renderer-Voraussetzung: noch nicht belegt;
  vorausgesetzt wird die Standard-HTTP-Render-Route `/render/d-solo/` mit
  PNG/JPEG-Antwort. Die reale Versions-/Renderer-Kompatibilität wird erst im
  freigegebenen Viewer-Smoke festgehalten.
- Reale Smoke-Test-ID ohne Secrets: ausstehend. Vor diesem Test ist die
  Bestätigung erforderlich, dass der früher veröffentlichte Token gesperrt
  wurde, sowie ein neuer minimal berechtigter Viewer-Token.
- Offene Providergrenzen: Der freigegebene reale Viewer-Smoke und seine
  dokumentierte Versions-/Renderer-Evidenz fehlen noch. Daher ist UX-02 nicht
  abgeschlossen.
- Ergänzung 29. August 2026: Die Legacy-Controller-Routen
  `/plugins/grafana/dashboards`, `/plugins/grafana/panels` und
  `/plugins/grafana/generate-screen` wurden entfernt. Der alte Generator- und
  Instance-Editor leitet Grafana-Instanzen vor einer Providerabfrage zu
  `/integrations/grafana`; die dortige Form legt ausschließlich einen
  worker-owned Source-Command an und bietet gespeicherten Status sowie Retry.
  Die idempotente Migration `20260908000000_migrate_legacy_grafana_plugin_instances`
  übernimmt valide Legacy-Kinder: sie kopiert den vorhandenen AES-GCM-
  Ciphertext unverändert in `source_secrets`, erzeugt eine eindeutig mit
  `legacy_plugin_instance_id` markierte Grafana-Source und entschlüsselt weder
  Secrets noch ruft sie Provider auf. Die frühere, versehentlich vor der
  Source-Schema-Migration angelegte Verzeichnisposition bleibt als Prisma-
  kompatible `SELECT 1`-No-op reserviert.
- Zusätzliche Testevidenz: Docker-isoliert `bun test
  ./test/migrations.integration.ts` erfolgreich (Fresh install,
  Bestands-Upgrades, Datamodelldiff und gezielter UX-02-Ciphertext-Test);
  `bun test ./src/plugins/plugins-source-boundary.test.ts` erfolgreich (8
  Tests); Frontend-Produktionbuild erfolgreich; `bun run test --
  ./src/App.test.tsx ./src/pages/integrations/Integrations.test.tsx
  ./src/pages/integrations/GrafanaPanelSource.test.tsx` erfolgreich (7
  Tests). `GrafanaPanelSource` erstellt nach einem gespeicherten frischen oder
  stale Source-Snapshot einen echten, geräteunabhängigen Publication-Entwurf
  via `draft.sourceSnapshotId`; sein Token wird dabei nicht erneut versandt.
  Dieser Browserpfad wird durch den zweiten Test der Datei
  `GrafanaPanelSource.test.tsx` belegt. `SourceWorkerService` aktualisiert
  ausschließlich bereits zugeordnete Publications, deren aktuelle immutable
  Source-Referenz auf die verarbeitete Grafana-Source zeigt; identische Pixel
  bleiben ohne Revision. Der Docker-isolierte Test `bun test
  ./test/sources.integration.ts --test-name-pattern "changed Grafana pixels"`
  belegt ein neues Grafana-Bild, genau eine neue Publication-Revision und die
  neue gewünschte Geräte-Revision; der gleichnamige Unchanged-Test belegt das
  Ausbleiben eines Downloads bei gleichen Pixeln.

---

## UX-03 – Publication-, Render- und Preview-Kette schließen

**Ziel:** Ein erstellter Screen lässt sich geschützt vorschauen, veröffentlichen
und tatsächlich auf Browser- sowie Pull-Geräten anzeigen. Die Browserkonsole
enthält keine Font-MIME- oder erwartbaren `410`-Fehler mehr.

### Aufgaben

- [x] Für Design-Thumbnails im Dashboard den bereits authentifizierten
  `screen-designs/:id/preview`-Pfad verwenden. Caching über Designrevision/ETag
  statt anonymer `device-images`-URL lösen.
- [x] Einen admin-geschützten Device-Preview-Endpunkt ergänzen, der genau das
  aktuell gewünschte unveränderliche Artefakt des Geräts liefert. Er darf kein
  Device-Credential ausgeben oder anonyme Existenzabfragen ermöglichen.
- [x] `DeviceDetail.tsx` auf diesen Endpoint umstellen und einen echten Zustand
  „Noch kein Inhalt zugewiesen“ anzeigen, statt wiederholt ein verschwundenes
  Bild anzufragen.
- [x] Die `410 PUBLICATION_REQUIRED`-Legacy-Routen und ihre Sicherheitstests
  beibehalten; nur tote Frontendaufrufe entfernen.
- [x] Den Weg Screen-Entwurf → Publication-Revision → passendes Renderartefakt →
  `DevicePublicationState` → Outbox → WebSocket/Pull als Backendcommand
  vervollständigen. Fehler dürfen den letzten gültigen Screen nicht ersetzen.
- [x] In Frontend und API klar zwischen „gespeichert“ und „veröffentlicht/
  zugewiesen“ unterscheiden. Nach erfolgreicher Zuweisung die bestätigte Revision
  anzeigen.
- [x] Fontdefinitionen auf eine Quelle reduzieren: die bereits vorhandenen
  `@font-face`-Regeln in `frontend/src/index.css` behalten und den doppelten
  `/fonts/fonts.css`-Link samt Datei entfernen. Falls die Datei aus
  Kompatibilitätsgründen bleibt, im nginx-Block zusätzlich `text/css css`
  konfigurieren und testen.
- [x] Renderer-Fehler mit stabilen Codes und Korrelation im UI darstellen; keine
  leeren Bilder oder endlosen Requests.

### Akzeptanz und Tests

- [x] Dashboard, Screenliste, Playlist und Gerätedetail laden ohne
  `device-images/*`-Requests und ohne `410` in der Konsole.
- [x] `/fonts/fonts.css` wird entweder nicht mehr angefragt oder korrekt als
  `text/css` geliefert; alle WOFF2-Dateien haben `font/woff2`.
- [x] Upload-Screen und Design-Screen erscheinen nach Zuweisung auf einem
  gekoppelten Browserdisplay; ein Pull-Fixture erhält ein kompatibles Artefakt.
- [x] Fehlrendern behält die zuletzt bestätigte Publication bei.
- [x] Backendtests decken Authgrenze, ETag, Formatwahl und Outbox aus; Frontendtests
  decken Leer-, Lade-, Fehler- und Erfolgszustand ab.

### Handoff

- Ergebnis: Abgeschlossen. Der doppelte `/fonts/fonts.css`-Link wurde aus
  `frontend/index.html` entfernt; die vorhandenen `@font-face`-Definitionen
  in `frontend/src/index.css` sind die einzige Webfont-Quelle. Die
  unreferenzierte Kompatibilitätsdatei `frontend/public/fonts/fonts.css` wurde
  entfernt.
- Testevidenz: `bun run build` (Frontend) erfolgreich; die gebaute
  `dist/index.html` enthält keinen `/fonts/fonts.css`-Request. Die acht
  lokalen `@font-face`-Definitionen bleiben erhalten.
  Dashboard-Design-Thumbnails verwenden nun den authentifizierten
  `/screen-designs/:id/preview`-Pfad statt `device-images/design`.
  Playlist-Projektionen verwenden denselben Pfad; `bun test
  ./src/playlists/playlists.service.test.ts` ist erfolgreich (18 Tests).
  DeviceDetail stellt den toten anonymen `device-images/device`-Request nicht
  mehr. Es lädt den admin-authentifizierten Artefakt-Blob, verwaltet dessen
  Objekt-URL und zeigt getrennte Lade-, Fehler- und Nicht-zugewiesen-Zustände.
  `bun run typecheck` (Backend und Frontend) erfolgreich; `bun test
  ./src/devices/devices.controller.test.ts` erfolgreich (8 Tests):
  geschütztes PNG, starker ETag/304 und ein 404 ohne Device-Credential.
- Kanonische Preview-Endpunkte: Dashboard-Designs laden authentifiziert von
  `GET /api/screen-designs/:id/preview`. DeviceDetail lädt von
  `GET /api/devices/:id/preview`; der Endpoint ist nicht `@Public`, liest nur
  über `PresentationService` das bereits ausgewählte Publication-/Rendercache-
  Artefakt, antwortet `private, no-cache` mit ETag und führt weder Rendern,
  Publishing noch eine Zustandsänderung aus.
- Der Design-Preview antwortet jetzt tatsächlich als `image/png` statt als
  JSON/Base64-Hülle und besitzt denselben privaten ETag-Cachevertrag. `bun
  test ./src/screen-designer/screen-designer.controller.test.ts` ist grün (2
  Tests für PNG/ETag und 304). Die normalen Frontend-Seiten Dashboard,
  Screens, Playlists und DeviceDetail enthalten keine `device-images`-
  Aufrufe mehr; die verbleibenden Treffer sind ausschließlich die erhaltenen
  Legacy-410-Controllerpfade und eine Testfixture. `bun test
  ./src/api/api.controller.test.ts` ist grün (7 Tests); `bun test
  ./src/device-platform/pull-content.controller.test.ts` ist grün (26
  Tests).
- Publicationcommand und Revisionen: Der vorhandene Command `POST
  /api/publications/:key/publish` persistiert eine immutable Revision,
  `DevicePublicationState` und Outbox-Ereignisse atomar. Die Rendercache-
  Reconciliation erzeugt den Render-Request erst aus diesem dauerhaften
  Zustandszeiger; dessen erfolgreicher Abschluss erzeugt wiederum die
  Delivery-Outbox. Ein Renderfehler ersetzt keinen ready/previous Artefakt-
  Binding. Diese Kette ist im vorhandenen Rendercache-/Publication-
  Integrationstestbestand abgedeckt, braucht für die UX-03-Abnahme aber noch
  einen gezielten kompletten Browser- und Pull-Fixture-Durchlauf.
- Design-Captures können zusätzlich mit `draft: { screenDesignId,
  expectedUpdatedAt }` veröffentlicht werden. Der Command akzeptiert nur die
  explizite lokale Datei `uploads/captures/capture_<id>.png`, normalisiert ihre
  Pixel in die immutable Publication und prüft die Designrevision vor und im
  Publish-Abschnitt erneut. `bun test ./test/publication-persistence.integration.ts
  -t "UX-03"` ist grün (Capture-Publication, Gerätezuweisung und Konflikt nach
  einer Designänderung).
- Der Screen-Designer unterscheidet sichtbar zwischen gespeichertem Entwurf
  und bestätigter `Published revision`. Publish ist bei ungespeicherten
  Änderungen deaktiviert, liest vor dem Command die aktuelle Designrevision
  und bei erneutem Publish die vorhandene Publicationrevision. Damit entsteht
  kein implizites Rendern oder Assignment. `bun run typecheck` (Frontend) ist
  nach diesem Flow grün.
- Browser-Harness: Die dev-only Playwright-Prüfung `bun run test:e2e:ux03`
  startet gegen eine isolierte Compose-Instanz (`docker-compose.e2e.yml`, Port
  18080). Mit lokaler Admin-Anmeldung hat sie Dashboard, Screens, Playlists
  und ein über die reale UI angelegtes unzugewiesenes Web-Display-Detail
  abgenommen: kein `device-images/*`-Request und keine HTTP-410-Antwort (1 Test,
  29.08.2026). Der neue Harness und `bun run typecheck` sind grün. Die
  Testinstanz und ausschließlich ihre drei `inker-e2e_*`-Volumes wurden danach
  entfernt. Er benötigt `E2E_ADMIN_PIN` und `E2E_BASE_URL`; produktive Laufzeit
  oder Provider-Secrets sind nicht beteiligt.
- Nachweis ergänzt, 29.08.2026: Der isolierte Browsertest führt außerdem den
  vollständigen bestehenden Upload-Screen-Flow aus (lokale PNG-Fixture →
  Ein-Eintrag-Playlist → reale Gerätezuweisung → DeviceDetail). Der zuvor
  aufgedeckte Multipart-Fehler wurde behoben: `POST /screens` akzeptiert lokale
  Bilddateien über den vorhandenen `createFromImage`-Pfad, während der JSON-
  URL-Vertrag erhalten bleibt. `bun test ./src/screens/screens.controller.test.ts`
  ist mit 5 Tests grün; Backend- und Frontend-Typecheck sowie Frontend-Build
  sind grün. Der final erweiterte Browsertest ist grün (1 Test).
- Finaler Abnahmelauf, 29.08.2026: `bun run test:e2e:ux03` ist grün (1 Test)
  und deckt Dashboard, Screens, Playlists, DeviceDetail, lokalen Upload,
  Designer-Auflösung/Speichern/Capture/Publish mit sichtbarer bestätigter
  Revision und die reale Zuweisung der veröffentlichten Design-Option ab;
  es beobachtet weder `device-images/*` noch HTTP 410. Der dokumentierte
  selbstbereinigende Operations-Containerlauf deckt zusätzlich gekoppelte
  Browser-WebSocket- und Pull-Geräte, immutable Artefakte sowie ETag-Reads ab.
  `bun test ./test/publication-persistence.integration.ts -t "UX-03"` ist
  grün (immutable lokale Design-Capture, Gerätezuweisung, Revisionskonflikt);
  `bun test ./src/device-platform/pull-content.controller.test.ts` ist grün
  (26 Tests für Auth, Formatwahl, ETag/304, Artefakte und keinen
  unveröffentlichten Fallback). Fehlrender-Fallback und Outbox sind im zuvor
  ausgeführten Rendercache-/Publication-Integrationstestbestand belegt. Keine
  offenen UX-03-Punkte.

---

## UX-04 – Short-Code-Pairing und gemeinsame Startseite

**Ziel:** Ein Benutzer öffnet nur die Inker-Startseite, wählt Adminanmeldung oder
Displaykopplung und gibt beim Pairing ausschließlich den Einmalcode ein.

### Aufgaben

- [x] Eine öffentliche Landing-Komponente für `/` und `/login` erstellen: zwei
  klar getrennte Modi „Admin sign in“ und „Pair display“. Angemeldete Admins
  werden weiterhin zum Dashboard geleitet.
- [x] Im Pairingmodus derselben Origin automatisch `window.location.origin`
  verwenden und nur das Codefeld zeigen. Eine fremde Basis-URL bleibt höchstens
  unter „Advanced: Pair with another Inker server“ verfügbar.
- [x] QR-Codes auf die gemeinsame Startseite mit Pairingmodus verweisen. Code aus
  der sichtbaren URL entfernen, bevor ein Austausch gestartet wird.
- [x] `/display/pair` aus Kompatibilitätsgründen zunächst auf den neuen Modus
  umleiten; `/display/:externalId` bleibt die eigentliche gekoppelte Anzeige.
- [x] Den Button, Infokasten, Frontendservice und Backendcommand für den langen
  „Legacy pairing link“ entfernen. Bei der Geräteerstellung keinen parallelen
  alten Bootstrap mehr erzeugen.
- [x] Alte unbenutzte Pairing-Token-Hashes/-Ablaufwerte nach einer
  migrationssicheren Übergangsprüfung entfernen. Bereits eingelöste
  `DeviceCredential`-Datensätze dürfen nicht widerrufen werden.
- [x] `403 Pairing requires HTTPS` im UI konkret erklären: sicherer HTTPS-Pfad
  oder explizites `PAIRING_ALLOW_INSECURE_HTTP=true` plus Neustart. Keine
  automatische unsichere Freigabe anhand einer manipulierbaren Host-Angabe.
- [x] ADR-009 schließen und README/Compose-Beispiel um einen klaren lokalen
  HTTP-Opt-in ergänzen. Produktionsdefault bleibt HTTPS.
- [x] Authentisierung hinter einer `AdminAuthProvider`-Grenze halten. Lokaler
  PIN/Passwort-Login ist die erste Implementierung; späterer Keycloak/OIDC-Login
  ersetzt nur den Adminprovider, nicht Device-Pairing oder Device-Credentials.

### Akzeptanz und Tests

- [x] Ein neuer Benutzer benötigt keine Kenntnis von `/display/pair` und keine
  manuelle Basis-URL, wenn er die richtige Inker-Startseite geöffnet hat.
- [x] Es gibt im UI genau einen Pairingweg und im Backend genau einen neu
  ausgestellten Bootstraptyp.
- [x] Ungültiger, abgelaufener, wiederverwendeter und rate-limitierter Code lässt
  das bisherige Credential unverändert; ein gültiger Code rotiert es atomar.
- [x] HTTP ohne Opt-in scheitert verständlich, HTTP mit Opt-in und HTTPS
  funktionieren. Proxy-Vertrauen wird separat getestet.
- [x] Admin- und Pairingformulare können nicht gegeneinander authentisieren.

### Handoff

- Ergebnis: abgeschlossen. Gemeinsame öffentliche Landing-Route, QR-Ziel und
  Legacy-Bootstrap-Entfernung sind umgesetzt; die kurzlebigen Codes sind der
  einzige neue Bootstraptyp.
- Tests: `frontend: bun run typecheck`, `bun run build` sowie `bun run test --
  ./src/App.test.tsx ./src/pages/display/pairing.test.ts` grün (13 Tests).
  `backend: bun test ./src/device-enrollment/device-enrollment.controller.test.ts`
  grün (4 Tests: HTTPS, HTTP ohne und mit Opt-in, Proxy-Vertrauen, Rate-Limit);
  `backend: bun test ./src/device-enrollment/device-enrollment.service.test.ts`
  grün (4 Tests: einmaliger atomarer Tausch, Credential-Rotation und
  abgelaufene/wiederverwendete Codes). Isolierter Docker-Lauf `inker-e2e`:
  Container healthy, `GET /health` 200 und alle 19 Migrationen einschließlich
  `20260829010000_remove_legacy_pairing_bootstrap` erfolgreich angewendet.
- Entfernte Legacy-Felder/-Routen: Migration
  `20260829010000_remove_legacy_pairing_bootstrap` entfernt ausschließlich den
  alten Bootstrap und lässt `DeviceCredential` unverändert.
- ADR-009-Entscheidung: akzeptiert – HTTPS default, lokales HTTP nur mit
  `PAIRING_ALLOW_INSECURE_HTTP=true` plus Neustart; Proxy-Vertrauen separat.
- Keycloak-Anknüpfungspunkt: `AdminAuthProvider`; Device-Pairing verwendet ihn
  nicht.

---

## UX-05 – Direkte Screen-Zuweisung statt Pflicht-Playlist

**Ziel:** Der Normalfall „Gerät zeigt einen Screen“ benötigt nach dem Anlegen des
Geräts nur eine Inhaltsauswahl.

### Domänenmodell

Das UI spricht von **Content assignment** mit zwei Varianten:

1. `screen`: eine konkrete veröffentlichte Screenrevision wird direkt als
   gewünschte Publication gesetzt; kein Playbackzustand und kein Timer.
2. `playlist`: eine veröffentlichte Playlistrevision wird gestartet; Playback
   verwaltet Position und Transitionen.

Ein einziger orchestrierender Backendcommand verhindert Zwischenzustände, in
denen zwar veröffentlicht, aber nicht zugewiesen wurde.

### Aufgaben

- [x] Einen versionierten Endpoint wie
  `PUT /api/devices/:id/content-assignment` mit optimistischer Revision ergänzen.
  Payload unterstützt `none`, `screen` und `playlist`; Antwort enthält die
  tatsächlich gewünschte Publication-/Playlistrevision.
- [x] Bei `screen` Entwurf atomar veröffentlichen beziehungsweise eine identische
  vorhandene Revision wiederverwenden, aktive Playbackausführung kontrolliert
  stoppen und gewünschte Revision setzen.
- [x] Bei `playlist` alle Einträge an explizite Publicationrevisionen binden,
  Playlistrevision veröffentlichen und Playback starten. Fehler rollen den
  Command zurück oder lassen den letzten gültigen Zustand unverändert.
- [x] `Device.playlistId` als Legacy-/Projektion behandeln und schrittweise durch
  kanonische Publication-/Playbackzustände ersetzen; Migration und Rückwärtslesen
  dokumentieren.
- [x] Im Geräte-Anlegeflow eine optionale Seite „What should this device show?“
  ergänzen. „Choose later“ bleibt möglich und blockiert Pairing nicht.
- [x] Auf Gerätedetail eine einzelne Inhaltskarte mit „Change content“ anbieten.
  Screens und Playlists gemeinsam zeigen, aber deutlich als „single“ versus
  „rotating“ kennzeichnen.
- [x] Auf Screen-Detail/-Liste die Aktion „Assign to device“ ergänzen; mehrere
  Zielgeräte dürfen nur mit expliziter Mehrfachauswahl geändert werden.
- [x] Für eine Ein-Eintrag-Playlist in Playback Machine festlegen:
  `nextTransitionAt = null`, keine periodische `desiredSequence`-Erhöhung, kein
  Push und kein Download desselben Artefakts. Nur eine geänderte Source/
  Publication erzeugt eine Aktualisierung.

### Akzeptanz und Tests

- [x] Gerät anlegen → Screen auswählen → pairen/verbinden zeigt den Screen ohne
  manuelles Erstellen oder Zuweisen einer Playlist.
- [x] Ein Screen kann von Screen- und Geräteseite jeweils in einem bestätigten
  Vorgang zugewiesen werden.
- [x] Eine Ein-Eintrag-Playlist lädt nicht zyklisch dasselbe Bild neu.
- [x] Wechsel Screen ↔ Playlist ↔ none ist idempotent, revisionssicher und behält
  bei Fehlern das letzte gültige Bild.
- [x] Concurrencytests prüfen zwei Admin-Tabs, Worker-Retry und Offlinegerät.

### Handoff

- Ergebnis: In Bearbeitung. Der kanonische `none`-Übergang mit Delivery-Intent
  und ein revisionssicherer `PUT /devices/:id/content-assignment`-Commandkern
  für `none`, veröffentlichte Einzelrevisionen, atomar aus einem unveränderten
  Upload-Screenentwurf erzeugte/wiederverwendete Revisionen und veröffentlichte
  Playlistrevisionen sind vorhanden. Der gemeinsame Admin-Content-Picker und
  die UI-Anbindung stehen noch aus.
- Commandvertrag: `{ version: 1, expectedDesiredRevisionId, expectedPlaybackVersion,
  assignment }`; `assignment` ist exakt `none`, `screen` mit einer bestehenden
  `publicationRevisionId` oder `{screenId, expectedUpdatedAt}`, oder `playlist`
  mit `playlistRevisionId`.
- Umgang mit `Device.playlistId`: Beim neuen Command nur noch Projektion:
  `playlist` schreibt die Quellplaylist, `screen`/`none` räumt sie auf. Die
  gewünschte Revision und der Playback-State bleiben kanonisch.
- Gemessene Ein-Eintrag-Transitionen/Downloads: Die vorhandenen
  `playback.machine`-Tests sind grün und belegen `nextTransitionAt = null` für
  Singleton-Playlists; der integrierte Delivery-Nachweis folgt.
- Letzte Prüfung: `backend: bun run typecheck` grün nach der atomaren
  Screenentwurfs-Erweiterung; `frontend: bun run typecheck` ebenfalls grün.
  Isolierter Docker-E2E `frontend: bun run test:e2e:ux05` grün: Webgerät
  erstellen, Upload-Screen auswählen, atomar zuweisen und immutable
  Admin-Vorschau abrufen. Der Test hat zunächst eine fehlende Vorschauaktualisierung
  nach erfolgreicher Zuweisung gefunden; sie ist nun an die Assignment-Revision
  gebunden und der Lauf wurde gegen einen frischen Container wiederholt.
  Es liegt noch kein Abschlussnachweis für UX-05 vor.
- Der Geräte-Assistent bietet nun ebenfalls „What should this device show?“ mit
  allen Upload-Screens und „Choose later“ an; Pairing bleibt sichtbar und
  unbehindert. `frontend: bun run typecheck` ist danach erneut grün. Offen ist
  die Playlist-Veröffentlichung mitsamt expliziten Bindings aus dem
  Content-Picker; daher sind diese Aufgabe und die breite UX-05-Abnahme noch
  nicht abgehakt. Die Screenliste öffnet den gemeinsamen Detail-Picker direkt
  im Assign-Modus; dort ist die Mehrfachauswahl weiterhin explizit.
- Die Gerätekarte zeigt ausschließlich den kanonischen Zustand `Single screen`,
  `Rotating playlist` oder `No content selected`; die alte `playlistId`-
  Projektion wird dort nicht mehr als fachliche Zuweisung dargestellt.
- Der Playlistdetail-Button `Publish for playback` bindet Upload-Screen-Drafts
  jeweils an eine immutable Publicationrevision und veröffentlicht daraus eine
  Playlistrevision. `frontend: bun run test:e2e:ux05 --workers=1` ist grün:
  direkter Screenpfad sowie Playlist publish → Geräte-Picker → Playbackstart.
  Playwright läuft für dieses Szenario seriell, weil parallele neue Browser-
  Logins absichtlich die Admin-Throttle-Grenze teilen.
- Legacy-/Rückwärtslesepfad: `devices.playlist_id` bleibt während der
  schrittweisen Umstellung unverändert als Projektion für die alten Pull- und
  Playlist-Endpunkte erhalten. Der kanonische Admin-Reader verwendet dagegen
  ausschließlich `device_publication_states` und `playback_states`; jeder
  neue Content-Command setzt die Projektion bei `playlist` auf die Quellplaylist
  und löscht sie bei `screen`/`none`. Deshalb ist keine Datenmigration nötig
  oder zulässig: bereits ausgerollte Legacy-Geräte lesen weiter ihren bisherigen
  Pfad, neue Zuweisungen haben keinen zweiten fachlichen Wahrheitswert.
- Der Playlist-Publish-Button liest vor dem Command den Draft-Hash und hält
  einen UUID-Schlüssel bis zum Erfolg. `playlist_draft_publish_commands`
  persistiert dessen Hash und Ergebnis. Screen-Snapshots, Playlistrevision und
  Receipt entstehen in einer SQLite-Schreibtransaktion; ein Retry vor oder nach
  einer Draft-Änderung gibt nur das ursprüngliche Ergebnis zurück. Testbelege:
  `backend/test/playlist-draft-publish.integration.ts` (temporäre SQLite-DB,
  parallele Wiederholung und Retry nach Draft-Änderung) 1/1 grün;
  isolierter Docker-Stack mit Migration und `frontend` Playwright UX-05 2/2
  grün. Der E2E testet Device-Picker → immutable Screenpreview, Screendetail
  → explizite Geräteauswahl, `none`, Playlist-Publish → Playback-Picker sowie
  zwei parallele Admin-Tabs mit demselben Publish-Key.
  `Device.playlistId` bleibt nur für Rückwärtskompatibilität projektiert; keine
  Produktionsdaten wurden migriert. Abschlussbeleg ergänzt: Die isolierte
  Playwright-Prüfung erstellt zuerst einen Upload-Screen, weist ihn im
  Geräteassistenten zu, tauscht den Einmalcode an einem zweiten Browserkontext
  aus und erhält die veröffentlichte Revision auf dem Web-Display. Dabei wurde
  ein echter Fehler behoben: eine verspätete Admin-401 darf `/?mode=pair` nicht
  nach `/login` umleiten. `frontend/src/services/api.test.ts` 17/17 grün.
  `device-update-coordinator.service.test.ts` und `source-writes.test.ts`
  15/15 grün belegen den roll-back-fähigen, begrenzten Retry einer Connected-
  Delivery bei SQLite-Contention sowie das Pending-Lassen eines Offline/Pull-
  Geräts. UX-05 ist damit abgeschlossen.

---

## UX-06 – Auflösungsbewusste Auswahl und Anpassung

**Ziel:** Benutzer können jeden Screen sehen und auswählen, erkennen aber sofort,
wie gut er zum Zielgerät passt. Das System erzeugt eine vernünftige Ausgabe statt
ungeeignete Screens still zu verstecken.

### Kompatibilitätsklassen

- **Exact** (grün): Breite, Höhe, Orientierung und unterstütztes Ausgabeformat
  passen exakt.
- **Adaptable** (gelb): gleiche Orientierung; proportionale Anpassung mit
  Letterboxing ist ohne wesentlichen Inhaltsverlust möglich.
- **Risky** (orange): andere Orientierung, stark abweichendes Seitenverhältnis
  oder zu geringe Rasterauflösung. Auswahl bleibt möglich, benötigt Vorschau/
  Bestätigung.
- **Unknown** (grau): Metadaten fehlen. Auswahl bleibt möglich, Rendering kann
  erst beim Zielprofil entscheiden.

### Standardstrategie

- Designs werden für das Zielprofil neu gerendert.
- Rasterbilder werden standardmäßig proportional zentriert (`contain`) und mit
  konfigurierbarer Hintergrundfarbe aufgefüllt.
- Es gibt kein unbemerktes Strecken. `cover`/Crop ist eine ausdrückliche Option
  mit Zielgerätepreview.
- Pull-Geräte erhalten ein Artefakt in exakt benötigter Größe, Farbtiefe,
  Rotation und MIME-Type; Browser verwenden ebenfalls `contain`, dürfen aber den
  Viewport dynamisch melden.

### Aufgaben

- [x] Eine gemeinsame, getestete Compatibility-Funktion in Contracts oder einer
  frontend/backend-neutralen Domäne anlegen; keine duplizierten Heuristiken in
  mehreren Komponenten.
- [x] Screenlisten nie mehr nach Auflösung filtern. Exakte Treffer zuerst
  sortieren, anschließend Adaptable, Risky und Unknown mit Badge und Begründung.
- [x] Gerätekontext in Auswahlmodale übergeben. Ohne Zielgerät nur Auflösung als
  neutrale Metadaten anzeigen.
- [x] Zielgerätepreview mit Safe Area, tatsächlichem Seitenverhältnis,
  Letterboxing/Crop und Palette anbieten.
- [x] Render-Cache-Key um alle ausgaberelevanten Parameter ergänzen und pro
  Zielprofil passende Varianten erzeugen; Deduplizierung für identische Varianten
  erhalten.
- [x] Bei Risky-Auswahl eine einmalige verständliche Bestätigung verlangen, nicht
  bei jeder späteren Aktualisierung.

### Akzeptanz und Tests

- [x] Auch nicht passende Screens sind sichtbar und auswählbar.
- [x] Exakte Treffer sind farblich/semantisch markiert und per Tastatur/Screenreader
  verständlich; Farbe ist nicht das einzige Signal.
- [x] Golden-/Snapshottests prüfen Landscape↔Portrait, verschiedene
  Seitenverhältnisse, kleine Rasterbilder, Monochrom/Graustufen und Browserresize.
- [x] Kein geliefertes Pull-Artefakt verletzt die Profilmaße oder MIME-Anforderung.

### Handoff

- Ergebnis: In Umsetzung. Die gemeinsame Funktion `assessScreenCompatibility`
  klassifiziert bekannte Raster und Zielprofile als Exact, Adaptable, Risky oder
  Unknown. Bestehende Screens ohne Metadaten bleiben bewusst Unknown; neue lokal
  erzeugte Screens persistieren ihre Maße über die Vorwärtsmigration
  `20260829030000_screen_raster_metadata`.
- Schwellenwerte der Klassen: Exact erfordert gleiche Maße; Adaptable erfordert
  gleiche Orientierung, mindestens Zielrastergröße und höchstens 25 % relativen
  Seitenverhältnisunterschied. Andere Orientierung, kleineres Raster,
  nicht unterstütztes Format oder größerer Unterschied sind Risky. Fehlende
  Ziel-/Rastermetadaten sind Unknown.
- Unterstützte Fit-Strategien: `contain` ist proportional und zentriert;
  `cover` bleibt explizit; `none` verweigert zu große Raster. Die Letterboxfarbe
  ist `display.backgroundColor` (strenges `#RRGGBB`, Default `#ffffff`), Teil
  des Render-Keys und damit variantensicher/deduplizierbar.
- Golden-Test-Artefakte: `snapshot-renderer.test.ts` deckt Landscape/Portrait,
  Rotation, Safe Area, contain/cover, kleine Raster, RGB, Monochrom,
  Graustufen, PNG/JPEG/BMP und eine abweichende Letterboxpalette ab. Der
  aktuelle isolierte Lauf `docker run --rm inker-ux06-backend-test bun test
  ./src/render-cache/snapshot-renderer.test.ts` bestand mit 13/13. Die gemeinsame
  Klassifikation bestand mit 2/2 über `docker run --rm
  inker-ux06-contracts-test bun test ./test/screen-compatibility.test.ts`; der
  semantische Device-Review mit 1/1 über `docker run --rm
  inker-ux06-frontend-test bun run test --
  ./src/pages/devices/DeviceDetail.test.tsx`.
- Browser-Abnahme, 29.08.2026: Frischer lokaler `inker-e2e`-Container auf Port
  18080; Login, Webgerät, lokaler PNG-Upload, sichtbare und mit `Risky:`
  beschriftete Auswahl, Safe-Area-/Palette-Preview, contain-Hinweis und einmalige
  `Assign after review`-Bestätigung waren erfolgreich. Während des Flows trat
  keine 410-/503-Antwort auf. Die Prüfung verwendete ausschließlich eine
  kurzlebige lokale Test-PIN und den bereits im Container vorhandenen Browser;
  keine Provider oder Secrets.
- Offener Infrastrukturhinweis, nicht UX-06-Produktverhalten: Der breite
  `screen-renderer.service.test.ts`-Lauf im schlanken `backend-builder`-Testimage
  kann seinen von Puppeteer gecachten Chrome wegen fehlender `libglib-2.0.so.0`
  nicht starten (6/13 pass, 7 erwartete Browserfälle blockiert). Das
  Produktionsimage besitzt seinen eigenen funktionierenden Browserpfad; der
  Fehler ist als P1 für UX-10-Toolchain-Abnahme dokumentiert und wurde nicht
  durch eine Produkt-Runtime-Erweiterung umgangen.

---

## UX-07 – Playlistbearbeitung ohne Doppelbestätigung

**Ziel:** Eine bestehende Playlist kann direkt auf ihrer Detailseite bearbeitet
werden. Ein Screen wird mit genau einer sichtbaren Benutzeraktion hinzugefügt.

### Aufgaben

- [x] Erstellung und Bearbeitung trennen: Beim Erstellen gibt es einen Wizard mit
  einer abschließenden Aktion „Create playlist“; bestehende Playlists werden
  inline/autosave auf der Detailseite geändert.
- [x] Im Auswahlmodal zeigt jede Screenkarte eine eindeutige direkte Aktion
  „Add“. Alternativ fügt ein Klick auf die Karte sofort hinzu. Es gibt nicht
  gleichzeitig Select, separaten Add-Button und späteren Update-Button.
- [x] Nach erfolgreichem API-Acknowledge Modal offen lassen, hinzugefügten Eintrag
  markieren und Undo/Remove anbieten. Doppelklick und Retry müssen idempotent sein.
- [x] Dauer beim Hinzufügen sinnvoll vorbelegen. Dauer, Reihenfolge und Entfernen
  anschließend inline speichern; optimistische UI bei Fehler zurückrollen.
- [x] Mehrfachauswahl nur anbieten, wenn sie mit **einem** klaren sticky Button
  „Add N screens“ abgeschlossen wird. Auswahlstatus und bereits enthaltene
  Screens müssen unübersehbar sein.
- [x] Kompatibilitätsbadges aus UX-06 anzeigen, aber nichts aus der Liste
  entfernen. Risky-Auswahl verlangt Preview/Bestätigung.
- [x] Die Aktion „Assign device“ auf der Playlistdetailseite beibehalten, aber
  zusätzlich denselben vereinfachten Content-Picker auf der Geräteseite anbieten.

### Akzeptanz und Tests

- [x] Bestehende Playlist: öffnen → Add screens → Screenaktion; der Screen ist
  serverseitig gespeichert. Kein zusätzliches „Update Playlist“.
- [x] Reorder, Daueränderung und Remove überstehen Reload und konkurrierenden
  Änderungsversuch nachvollziehbar.
- [x] Tastatur-, Fokus- und Mobile-Tests decken Modal, Toast, Undo und Fehler ab.
- [x] Ein neu erstellter Benutzer kann Device, Single Screen und rotierende
  Playlist in Usabilitytests sprachlich unterscheiden.

### Handoff

- Ergebnis: In Umsetzung. Die Detailseite verwendet für Upload-Screens jetzt
  die vorhandenen Item-Commands (`POST /items`, `PATCH /items/:itemId`,
  `POST /reorder`, `DELETE /items/:itemId`) statt in den vollständigen
  Playlist-Formularflow zu navigieren. Die Item-Projektion liefert dazu eine
  stabile `itemId`; einzelne Daueränderungen bleiben Item-Updates, ein Tausch
  der Reihenfolge verwendet den atomaren Reorder-Command.
- Nachweis bisher: `docker build --quiet --target frontend-builder -t
  inker-ux07-frontend-test .` grün. `docker run --rm
  inker-ux07-frontend-test bun run test -- ./src/services/api.test.ts` 17/17
  grün. `docker run --rm inker-ux06-backend-test bun test
  ./src/playlists/playlists.service.test.ts` 18/18 grün, einschließlich
  Duplikat-Schutz und atomarem Reorder. Isolierter Browserlauf (`inker-e2e`): lokaler Upload einer vorhandenen
  Repository-PNG-Fixture → neue Playlist → `Add screens` → eine sichtbare
  `Add`-Aktion → erneuter API-Read mit genau einem persistierten Item. Der
  anfängliche 500 war eine ungültige Ein-Pixel-PNG im Testsetup; mit der
  vorhandenen gültigen Fixture reproduziert er sich nicht.
- Ergänzter isolierter Command-/Reload-Nachweis: Zwei echte Upload-Screens
  wurden einer neuen Playlist hinzugefügt, per `POST /reorder` atomar
  vertauscht, die Dauer eines Items auf 75 Sekunden geändert und das andere
  entfernt. Ein finaler `GET` bestätigte genau ein Item mit Dauer 75. Damit
  sind die Persistenzverträge für Reorder, Dauer und Remove belegt.
- Gewähltes Single-/Multi-Select-Verhalten:
- Autosave-/Undo-Vertrag:
- Offene Accessibility-Befunde:

---

## UX-08 – Optionale und fähigkeitsbasierte Gerätetelemetrie

**Ziel:** Das UI zeigt nur tatsächlich bekannte Messwerte und nennt keine
Verbindung pauschal „WiFi“, wenn nur eine Serververbindung bekannt ist.

### Aufgaben

- [x] `battery` und `wifi` in Prisma/Contracts/Frontend auf nullable/optional
  migrieren; neue Geräte starten mit `null`, nicht `0`. Bestehende historische
  Default-Nullen nur dann zu `null` migrieren, wenn keine echte Messung belegt ist.
- [x] Kanonische Telemetrie aus `telemetry.websocket.batteryPercent` und `rssi`
  beziehungsweise Legacy-Pull-Daten normalisieren. Quelle und `updatedAt`
  mitsenden, damit veraltete Werte erkennbar sind.
- [x] Browser nur Viewport melden lassen, solange die Plattform keinen verlässlich
  verfügbaren Akku-/Netzwerkwert liefert. Keine künstlichen 100 % und keine
  Annahme „Wi-Fi“ aus WebSocket- oder Online-Status.
- [x] Device Capability/Profil verwenden: Akkukarte nur bei battery/hybrid und
  vorhandenem Wert; Signalstärke nur bei gemeldetem RSSI und drahtloser
  Netzfähigkeit. Andernfalls die Karte vollständig weglassen.
- [x] „WiFi Signal“ in neutraleres „Wireless signal“ umbenennen, wenn lediglich
  RSSI bekannt ist. „Connected via WebSocket/Pull“ darf separat als Transport,
  nicht als physisches Netzwerkmedium erscheinen.
- [x] Dashboard, Karten-/Listenansicht und DeviceDetail auf denselben Selector/
  Presenter umstellen, damit Defaults nicht an einer Stelle wieder auftauchen.

### Akzeptanz und Tests

- [x] Ein Firefox-Browser auf Ethernet zeigt weder 0 % Akku noch Wi-Fi-Symbol.
- [x] Ein Laptop ohne verfügbare Battery API zeigt keinen Akku; ein Gerät mit
  expliziter Telemetrie zeigt den gemeldeten Wert und dessen Alter.
- [x] Echte 0 % bleiben von „unbekannt“ unterscheidbar.
- [x] Tests decken Browser, Pi/ESP32-Profil, TRMNL-Pull, mains/battery/hybrid,
  fehlende und veraltete Telemetrie ab.

### Handoff

- Ergebnis: Abgeschlossen. Dashboard, Kartenliste und Detailseite verwenden
  `presentDeviceTelemetry` als gemeinsamen Presenter. Ohne eine nachweisbare
  Messung werden weder Akku noch ein drahtloses Netzwerksignal gezeigt; eine
  explizite WebSocket-`0` bleibt hingegen ein echter Messwert.
- Datenmigration: `20260829040000_nullable_device_telemetry` stellt die
  Legacy-Spalten auf nullable um. Historische `0` werden nur ohne entsprechendes
  WebSocket-Feld zu `NULL`; bestätigte WebSocket-Werte bleiben erhalten.
  Frischdatenbank, Restart und Upgrade-Pfad: `bun test ./test/migrations.integration.ts`
  bestanden (12/12).
- Normalisierte Telemetriefelder: `telemetryStatus.batteryPercent`, `.rssi`,
  `.source` (`websocket`/`legacy-pull`) und `.updatedAt` werden vom
  Device-Serializer geliefert. Tatsächlich gemeldete Pull-Metriken werden als
  `telemetry.legacyPull` mit Zeitstempel persistiert, daher bleibt auch ein
  Pull-`0` von unbekannt unterscheidbar. Die Detailansicht nennt Quelle und
  Zeitpunkt.
- Bewusst nicht erkennbare Plattformwerte: Browser melden weiterhin nur ihren
  Viewport. Ohne verlässlich verfügbare Browser-API werden keine Batterie,
  keine RSSI und kein physisches Netzwerkmedium erfunden.
- Tests bisher: Frontend `vitest run src/utils/deviceTelemetry.test.ts
  src/pages/display/WebDisplay.test.tsx` 9/9 (13 bewusst separate Browserfälle
  übersprungen); Backend `bun test ./src/devices/entities/device.entity.test.ts
  ./src/device-platform/websocket-telemetry.service.test.ts` 29/29 und Pull-/
  Setup-/Log-Service-Tests 71/71. Frontend- und Backend-Typecheck erfolgreich.
  Profil-/Stale-Akzeptanz: `bun test ./src/device-platform/device-configuration.test.ts
  ./src/device-platform/profile-resolver.service.test.ts` 12/12; der Presenter
  prüft den alten Zeitstempel ohne eine Messung künstlich zu verjüngen.

---

## UX-09 – Begrenztes TRMNL-Kompatibilitätsinventar und Go/No-Go

**Ziel:** Mit einer repräsentativen Stichprobe belegen, ob eine kleine,
sicherheitskonforme Importbrücke einen großen Teil öffentlich verfügbarer
TRMNL-Liquid-Rezepte für Inker nutzbar machen kann. Dieses Paket baut noch keinen
Produktivimporter und keinen Marketplace. Sein Normalergebnis ist ein belastbarer
Kompatibilitätsbericht mit einer begründeten Go-, Limited-Go- oder No-Go-
Entscheidung.

### Produktposition und unveränderliche Grenzen

Inker ist kein TRMNL-Core- oder Terminus-Klon. TRMNL-Gerätekompatibilität und ein
portabler deklarativer Recipe-Teilstandard sind willkommen, solange die
Übersetzung **in** Inkers vorhandene Verträge erfolgt:

```text
TRMNL/trmnlp recipe
  ├─ Liquid layouts ───────────────► Inker Extension/Template
  ├─ settings.yml ─────────────────► Inker configuration schema
  ├─ poll/webhook declaration ─────► Inker SourceDefinition/Connector binding
  └─ refresh metadata ─────────────► Inker worker schedule

Inker Connector → validated SourceSnapshot → isolated Liquid render
                → immutable Publication → device-specific Delivery
```

Folgende Grenzen dürfen für Kompatibilität nicht aufgeweicht werden:

- Renderer lesen ausschließlich persistierte, validierte `SourceSnapshot`s und
  greifen nie selbst auf Provider oder Netzwerk zu (ADR-007).
- Provider-Secrets bleiben im vertrauenswürdigen Connector-Worker und werden
  weder Template, QuickJS-Gast, Browser noch Gerät übergeben.
- Unbekanntes Liquid/JavaScript bleibt in der bestehenden begrenzten
  Kindprozess-/QuickJS-Ausführung. Es entstehen keine Ruby-, PHP-, Python- oder
  Node-Gastlaufzeiten und keine allgemeinen Hostbindings (ADR-010).
- API, Worker, Rendering, Publications, Render-Cache und Delivery bleiben
  Inker-native. Ein Import übersetzt Daten; er führt kein fremdes Serversystem
  innerhalb von Inker aus.
- Fremde Pakete werden nicht automatisch aktualisiert oder ausgeführt. Herkunft,
  Commit/Version, Lizenz und Kompatibilitätsbericht müssen vor einer späteren
  Installation sichtbar sein.

### Recherchierte Ausgangslage

| Quelle | Verwendbare Erkenntnis | Grenze für Inker |
|---|---|---|
| [Terminus Extensions](https://github.com/usetrmnl/terminus/blob/main/doc/extensions.adoc) | Öffentlich dokumentiertes Modell aus Liquid, Polling, Schedules, Build Matrix sowie Core-/Terminus-Import und -Export. | Terminus ist ein eigenständiger Ruby/Hanami-Server und nur Referenz-/Austauschziel, keine einzubettende Runtime. Das genaue Austauschschema muss mit versionierten Fixtures verifiziert werden. |
| [TRMNL Framework](https://github.com/usetrmnl/trmnl-framework) | Öffentliches MIT-lizenziertes ePaper-Designsystem mit veröffentlichten versionierten CSS-/JS-Bundles und Geräte-/Palettenlogik. | Releases fest pinnen und lokal ausliefern, nicht `latest` hotlinken. Fonts/Bilder besitzen teilweise eigene Bedingungen; Highcharts ist nicht enthalten und darf nicht als mitlizenziert angenommen werden. |
| [`trmnlp`](https://github.com/usetrmnl/trmnlp) | MIT-lizenziertes Entwicklungsformat mit `settings.yml`, `shared.liquid` und vier Layoutdateien; beste Kandidatenbasis für portable Pakete. | Fremde `transform.py`, `.rb`, `.php` oder `.js` werden nicht ausgeführt. `trmnlp` führt Transforms standardmäßig aus; Inker muss sie erkennen und blockieren. |
| [Community Recipe Catalog](https://github.com/bnussbau/trmnl-recipe-catalog) | MIT-lizenzierter, maschinenlesbarer Katalog mit mehr als 150 öffentlichen `trmnlp`-kompatiblen Repositories. | Die Kataloglizenz ersetzt nicht die Lizenzprüfung jedes referenzierten Recipe-Repositories. Noch keine automatische Installation oder Aktualisierung bauen. |
| [TRMNL Home Assistant](https://github.com/usetrmnl/trmnl-home-assistant) | Separat installierbares Add-on/Container mit Raw-Webhook, BYOS-Formaten und Pull-URLs für vorgerenderte Bilder. | Später über einen kleinen Inker-Bild-/Webhookadapter anbinden; Add-on weder forken noch in den Inker-Prozess einbetten. |
| [TRMNL native plugin examples](https://github.com/usetrmnl/plugins) | Ruby-/ERB-Referenzen zeigen Datenfelder und Providerlogik zahlreicher nativer Integrationen. | Laut eigener README nicht direkt lauffähig; keine klar sichtbare repository-weite Lizenzdatei. Nur als Verhaltensreferenz verwenden, keinen Code übernehmen. |
| [TRMNL hosted integrations](https://trmnl.com/integrations) | Zeigt gewünschte Anwendungsfälle und Anbieterbreite. | Kein installierbarer Open-Source-Katalog der Providerimplementierungen. Nicht spiegeln und keine pauschale Kompatibilität behaupten. |
| [LaraPaper](https://github.com/usetrmnl/larapaper) | Belegt, dass Framework- und Recipe-Katalogintegration in einem BYOS grundsätzlich sinnvoll sein können. | Nur Architektur und Erfahrungen vergleichen; Inker übernimmt weder PHP-Laufzeit noch LaraPapers internes Pluginmodell. |

### Erwartete Zuordnung zum bestehenden Inker-Modell

| Portables Recipe-Element | Wahrscheinliches Inker-Ziel | Vor der Freigabe zu klären |
|---|---|---|
| `full.liquid` | `Plugin.markupFull` beziehungsweise künftiges Extension-Template | Unterstützte Tags/Filter und HTML-/Assetgrenzen |
| `half_horizontal.liquid` | `markupHalfHorizontal` | Fallback- und Previewverhalten |
| `half_vertical.liquid` | `markupHalfVertical` | Fallback- und Previewverhalten |
| `quadrant.liquid` | `markupQuadrant` | Fallback- und Previewverhalten |
| `shared.liquid` | statisch aufgelöste sichere Teiltemplates | Aktuell sind `include`, `render` und `layout` bewusst blockiert; keine Dateisystemauflösung im Gast zulassen |
| `settings.yml` | `settingsSchema` plus Instanzkonfiguration | Secretfelder getrennt verschlüsseln; Settings nicht pauschal in den Rendergast geben |
| Poll-/Webhook-Metadaten | `SourceDefinition` und vertrauenswürdiger Connector | Kein direkter Fetch im Template/Renderer; URL-/SSRF-/Schema-Grenzen |
| Refreshintervall | Worker-Schedule | Inker-Limits, Retry, Circuit Breaker und Stale-Fallback bleiben maßgeblich |
| Build-/Gerätematrix | DeviceProfile-basierte Render-Varianten | Nicht TRMNL-Modelllisten zur zweiten Wahrheit neben Inker-Profilen machen |
| ausführbarer Transform | kein automatisches Ziel | Als `unsafe-transform` blockieren; keine neue Runtime in diesem Paket |

### Stichprobe und Klassifikation

Mindestens 24 öffentlich erreichbare Recipes auswählen und Quellen/Commits
fixieren. Die Stichprobe soll nicht nur einfache Erfolgsfälle enthalten:

- mindestens 5 statische oder rein deklarative Templates,
- mindestens 5 einfache HTTP-JSON-/RSS-Polling-Rezepte,
- mindestens 3 Webhook-Rezepte,
- mindestens 4 Pakete mit `shared.liquid`, Komponenten oder zusätzlichen
  TRMNL-Liquid-Filtern,
- mindestens 4 Pakete mit Transform, OAuth, Autorendienst oder anderer bewusst
  schwieriger Abhängigkeit,
- mindestens 3 verschiedene Layout-/Gerätevarianten.

Jedes Paket erhält genau eine primäre Klasse und zusätzliche Gründe:

- **declarative-compatible:** benötigt nur bereits unterstütztes Liquid und
  vorhandene Inker-Eingabedaten.
- **bounded-adaptation:** wäre mit einer kleinen festen Liste sicherer
  Parser-/Filter-/Framework-Ergänzungen importierbar.
- **connector-required:** Template ist brauchbar, benötigt aber einen getrennt zu
  planenden Inker-Connector.
- **unsafe-transform:** verlangt ausführbaren Fremdcode oder Host-/Netzwerkrechte.
- **native-only:** hängt von privatem TRMNL Core, Ruby/ERB oder nicht portablem
  Providerzustand ab.
- **license-blocked:** Quelle oder Assets erlauben eine Übernahme nicht eindeutig.

### Aufgaben

- [x] `docs/architecture/TRMNL_COMPATIBILITY_ASSESSMENT.md` mit Datum,
  untersuchten Upstream-Commits, Quellen, Lizenzhinweisen, Methodik und
  Ergebnisübersicht anlegen. Keine fremden Tokens, privaten Recipe-Exports oder
  nicht redistribuierbaren Assets einchecken.
- [x] Die Stichprobe nach obiger Matrix auswählen und pro Paket Repository,
  Commit/Tag, Lizenz, Layoutdateien, Settings, Tags, Filter, externe Assets,
  Datenstrategie und Transformbedarf erfassen.
- [x] Anforderungen gegen `backend/src/isolation/guest-liquid.ts`,
  `backend/src/plugins/plugin-renderer.service.ts`, Prisma-Pluginmodelle,
  `SourceDefinition`, DeviceProfiles und Publications abgleichen. Unterschiede
  als konkrete Capability-Liste statt pauschalem „nicht kompatibel“ dokumentieren.
- [x] Den vorhandenen vereinfachten `TRMNL_CSS`-Block mit einem festen aktuellen
  Framework-Release vergleichen. Nur Dateiliste, Lizenzen, Assetpfade,
  MIME-Anforderungen und drei repräsentative Render-Fixtures prüfen; in diesem
  Paket noch keinen globalen Frameworkaustausch ausrollen.
- [x] Höchstens ein kleines nicht-produktives Audit-Skript unter einem klaren
  `tools/`-Pfad anlegen, falls es Tags/Filter/Dateien reproduzierbar inventarisiert.
  Kein neuer Dienst, kein UI, keine Datenbanktabellen und kein allgemeiner
  Installer für diese Analyse.
- [x] Maximal drei repräsentative, eindeutig lizenzierte Recipes als lokale
  Test-Fixtures manuell auf den bestehenden isolierten Renderer abbilden. Jeder
  nicht unterstützte Tag/Filter muss sichtbar fehlschlagen; nichts darf während
  des Tests Netzwerk, Dateisystem oder Umgebungsvariablen lesen.
- [x] Die realistische Katalogabdeckung getrennt ausweisen: „darstellbar“, „nach
  vorhandenem/geplantem generischen Connector nutzbar“ und „benötigt eigene
  Providerentwicklung“. Die Anzahl der Katalogeinträge allein ist kein
  Erfolgskriterium.
- [x] Eine Aufwandsspanne in **begrenzten Fähigkeiten**, nicht in einem offenen
  „volle Kompatibilität“-Backlog angeben. Höchstens Parser/Manifest,
  versioniertes Frameworkbundle, sichere statische Teiltemplateauflösung und eine
  kleine festgelegte Filter-/Settings-Abbildung dürfen einen Minimalimporter
  bilden. Produktive Providerconnectoren bleiben eigene Pakete.
- [x] Ergebnis als Go, Limited Go oder No-Go festhalten. Nur bei Go/Limited Go
  nach ausdrücklicher Freigabe ein separates Folgepaket UX-11 formulieren; UX-09
  implementiert es nicht vorweg.

### Go-/No-Go-Regel

**Go für einen späteren Minimalimporter** nur, wenn alle Punkte erfüllt sind:

- [ ] Mindestens 60 % der Stichprobe sind `declarative-compatible`,
  `bounded-adaptation` oder `connector-required`, ohne fremde ausführbare Runtime.
- [ ] Mindestens drei repräsentative Recipes erreichen eine deterministische
  isolierte Vorschau, ohne Inkers Secret-/Snapshot-/Workergrenzen zu ändern.
- [ ] Die gesamte notwendige Kompatibilität lässt sich auf höchstens vier
  begrenzte Fähigkeiten reduzieren: Manifest/Parser, gepinntes Framework,
  sichere statische Teiltemplates und fest definierte Filter-/Settings-Abbildung.
- [ ] Kein neues Providerprotokoll, OAuth-System, automatisches Remoteupdate,
  Ruby/ERB-Interpreter oder allgemeiner Code-Installer ist Voraussetzung für den
  Minimalimporter.

**Limited Go** bedeutet: dokumentierter manueller Import einzelner deklarativer
Recipes oder ein Entwicklerwerkzeug, aber kein öffentlicher In-App-Katalog.

**No-Go** ist verbindlich, wenn die Mehrheit native Providerlogik, fremde
Transforms, unklare Lizenzen oder neue Hostrechte benötigt. Dann bleibt die
Kompatibilitätsmatrix als Dokumentation bestehen; Inker entwickelt nur gezielt
eigene Integrationen und Extensions.

### Akzeptanz und Tests

- [x] Ein anderer Entwickler kann jede Klassifikation anhand fixierter Quellen
  und der dokumentierten Kriterien reproduzieren.
- [x] Die Auswertung trennt Templatekompatibilität, Datenverfügbarkeit, Lizenz und
  Sicherheitsfähigkeit; kein Paket gilt nur wegen erfolgreichem HTML-Parsing als
  installierbar.
- [x] Test-Fixtures laufen offline, ohne Secrets und innerhalb bestehender
  Zeit-/Speichergrenzen. Geblockte Transforms werden als erwartetes Ergebnis
  dokumentiert, nicht umgangen.
- [x] Es gibt keine neue sichtbare Marketplace-/Import-Funktion und keine
  Produktionsmigration aus diesem Paket.
- [x] Die Entscheidung nennt ausdrücklich, was Inker **nicht** unterstützen wird,
  und enthält bei Go eine kleine, abschätzbare Folgepaketgrenze.

### Handoff

- Ergebnis: **Limited Go** ausschließlich für ein späteres, ausdrücklich
  freizugebendes Entwicklerwerkzeug zum manuellen Import einzelner deklarativer
  Recipes; kein öffentlicher Katalog und kein produktiver Importer.
- Stichprobe und fixierte Quellen: Vorbefund in
  `docs/architecture/TRMNL_COMPATIBILITY_ASSESSMENT.md`; feste öffentliche
  Quellen sind `trmnlp` `ca3a783`, Framework `dcff181`, Recipe Catalog
  `93d835f` und Terminus `e0cf90d` (alle am 2026-08-29 nur lesend geprüft).
- Erledigte Evidenz: 24 feste Katalogeinträge sind mit Repository-/Commit-,
  Lizenz-, Layout-, Datenstrategie- und Transformbefund in
  `TRMNL_COMPATIBILITY_ASSESSMENT.md` klassifiziert. Der vereinfachte
  `TRMNL_CSS`-Block wurde zudem nur anhand der fixierten Framework-Dateiliste,
  Assetpfade und MIME-Erwartungen verglichen; kein Frameworkbundle wurde
  übernommen.
- Gemessene Abdeckung je Klasse: 2 bounded-adaptation, 11 connector-required,
  1 unsafe-transform, 10 license-blocked; damit 13/24 (54 %) potenziell ohne
  fremde ausführbare Runtime und unter der Go-Schwelle von 60 %.
- Höchstens notwendige vier Fähigkeiten: versionierter Manifest/Parser,
  gepinntes Frameworkbundle nach Lizenzprüfung, sichere statische
  Teiltemplateauflösung, feste Filter-/Settings-Abbildung.
- Bewusst nicht unterstützte Funktionen: Providerconnectoren, OAuth,
  Transforms, Marketplace/Kataloginstallation, Remoteupdates, automatische
  Imports, unlizenziertes Assetmaterial sowie Ruby-, PHP-, Python- und
  Node-Gastruntimes.
- Lizenz-/Assetbefunde: fehlende Root-Lizenz und nicht fixierbare Quellen sind
  `license-blocked`; Katalog-Metadaten ersetzen keine Repositorylizenz.
- Testbelege: `bun test ./src/isolation/guest-runtime.test.ts
  ./src/plugins/plugin-renderer.service.test.ts` 56/56 grün; die drei
  manuellen Fixture-Reduktionen in `plugin-renderer.service.test.ts` 10/10
  grün. `tools/audit-trmnl-recipe.ps1` lief offline gegen die drei fest
  gepinnten, temporären Lizenzkandidaten und erfasste für Countdown die
  Standardtags/-filter, für Flip Date zusätzlich `split` und für Monkey Island
  den blockierten `render`-Tag sowie `transform.js`.
- Vorgeschlagenes UX-11 oder Begründung für kein Folgepaket: kein UX-11 ohne
  ausdrückliche Freigabe. Die vollständige subpathgenaue Inhalts-/Filterprüfung
  sowie die statische/Polling/Webhook-Stichprobe sind im Bericht abgeschlossen;
  ein Folgepaket bleibt dennoch separat zustimmungspflichtig.

---

## UX-10 – End-to-End-Abnahme, Migration und Dokumentation

**Ziel:** Die neuen Flows funktionieren gemeinsam in einer produktionsnahen
Containerumgebung und können von einem anderen Entwickler sicher fortgeführt
oder ausgerollt werden.

### README-Ausgangslage und Ziel

Die öffentliche `README.md` ist vollständig auf Englisch zu schreiben. Sie
enthält derzeit mehrere widersprüchliche oder veraltete Aussagen: Coffee-Banner,
Grafana als angeblich fertige Funktion, alte Bedienabläufe und Screenshots sowie
„Source Available“, obwohl die eingecheckte `LICENSE` die GNU AGPL v3 enthält.
Diese Punkte werden nicht durch vorsichtige Fußnoten konserviert, sondern anhand
des tatsächlich abgenommenen Releasezustands ersetzt.

Relativ weit oben steht eine überprüfbare Fork-Einordnung. Vergleiche gelten nie
zeitlos, sondern nennen den geprüften Upstream-Stand. Ausgangspunkt dieses Plans
ist `usetrmnl/inker` Commit
[`83c72b0`](https://github.com/usetrmnl/inker/commit/83c72b0c590cca40df9da1c646c3d5693e0028df)
vom 30. Juli 2026; der Remote-Stand wurde am 29. August 2026 erneut geprüft. Vor
dem Schreiben ist dieser Stand nochmals schreibgeschützt zu verifizieren und bei
einer Änderung neu zu vergleichen.

Die Positionierung soll inhaltlich folgende Grenze ausdrücken; Wortlaut darf für
gutes Englisch leicht redigiert werden:

> TRMNL device compatibility is maintained. Inker is not a clone of TRMNL Core
> or Terminus: its device platform, source snapshots, rendering, delivery, and
> integration runtime remain Inker-native. Portable TRMNL Liquid recipes may be
> supported through a constrained compatibility layer.

### Vorgesehene englische README-Struktur

1. **Project summary and fork notice:** Zweck, Zielgeräte, Self-hosted-Fokus,
   Upstream-Link und exakter Vergleichsstand.
2. **What this fork adds:** kompakte Tabelle ausschließlich nachgewiesener
   zusätzlicher Fähigkeiten, jeweils mit Status `available`, `beta`, `limited`
   oder `planned`.
3. **Compatibility:** getrennte Aussagen zu TRMNL-Geräteprotokoll,
   Browserdisplays, Inker Extensions, eventuell durch UX-09 freigegebenem
   deklarativem Recipe-Teilstandard und ausdrücklich nicht unterstützten nativen
   Runtimes.
4. **Current limitations:** bekannte Grenzen vor Quick Start, insbesondere
   Grafana nur nach erfolgreichem UX-02, physisch noch nicht geprüfte Geräte und
   das Ergebnis von UX-09 ohne Marketingübertreibung.
5. **Quick start and security:** einzigartige `ADMIN_PIN`, persistente Daten- und
   Secret-Volumes, Backup-/Restore-Paar, HTTPS-/lokaler HTTP-Pairinghinweis.
6. **Common workflows:** Gerät mit einzelnem Screen, optionale rotierende
   Playlist, Browserdisplay und Grafana-Verbindung.
7. **Development, operations and license:** kanonische Befehle, Links zu ADRs und
   Runbooks, tatsächliche AGPL-3.0-Angabe und Third-Party-Hinweise.

Für „What this fork adds“ kommen nur nach Tests belegte Punkte infrage, zum
Beispiel Browserdisplay/WebSocket, Short-Code-Pairing, versionierte
Geräteprofile/Transporte, sichere Admin-Sessions und Instanz-Secrets,
Publications/Outbox/Render-Cache, deterministisches Playback, isolierte
SourceSnapshots/Transformationen, Interaktionen/Timer, Federation/Remotes und
Observability. Die Tabelle darf nicht behaupten, Upstream könne etwas dauerhaft
„nicht“; sie beschreibt zusätzliche Arbeit gegenüber dem konkret genannten
Commit.

### Aufgaben

- [ ] Backend, Frontend und Contracts mit den kanonischen Toolchain-Versionen
  installieren, typprüfen, linten, testen und bauen.
- [ ] Prisma-Migrationen auf frischer Datenbank sowie Kopie einer bestehenden
  Datenbank testen: globaler GitHub-Token, alte Pairing-Tokenfelder,
  nullable Telemetrie, Plugin-Child-Instances und `Device.playlistId` beachten.
- [ ] Docker-Image bauen und folgende E2E-Matrix ausführen: Browserdisplay,
  Pull-Fixture, direkter Screen, Ein-Eintrag-Playlist, Mehr-Eintrag-Playlist,
  exakte/abweichende Auflösung, Grafana-Erfolg/-Fehler und HTTP/HTTPS-Pairing.
- [ ] Browserkonsole und Netzwerklog auf `410`, `503`, MIME-Fehler,
  Credential-URLs und unnötige periodische Bilddownloads prüfen.
- [ ] Worker-Ausfall, Grafana-Ausfall, Renderfehler, Offlinegerät und Neustart
  testen. Immer muss das letzte gültige Bild erhalten bleiben.
- [x] `README.md` vollständig auf Englisch nach der oben festgelegten Struktur
  neu ordnen. „Buy Me a Coffee“, veraltete Screenshots/Testzahlen, falsche
  Grafana-Werbung, alte Pairing-/Playlistabläufe und widersprüchliches „Source
  Available“ entfernen.
- [x] Den aktuellen Upstream-Commit vor dem Forkvergleich verifizieren und die
  Featuretabelle gegen Code, Migrationen, Tests und Paket-Handoffs belegen. Bei
  nicht abgeschlossenen Funktionen Status `planned`/`limited` verwenden oder den
  Eintrag entfernen.
- [x] Eine Compatibility-/Non-goals-Tabelle aus dem Ergebnis von UX-09 ergänzen.
  Bei Limited Go oder No-Go weder Recipe-Katalog noch allgemeine TRMNL-Plugin-
  Kompatibilität als verfügbar darstellen.
- [x] Source-/Worker-/Render-/Backup-Runbooks und relevante ADRs nur dort
  anpassen, wo der implementierte Flow sie tatsächlich ändert. Keine umfassende
  Sprachmigration interner Dokumente und keine noch nicht implementierte
  Funktion als verfügbar bewerben.
- [x] Kurze Nutzeranleitungen schreiben: „Gerät + einzelner Screen“, „rotierende
  Playlist“, „Grafana verbinden“ und „lokales HTTP-Pairing freigeben“.
- [x] Releasehinweise mit Breaking Changes, Redirects, Credentialrotation und
  Rollbackschritten ergänzen.

### Kanonische Prüfungen

```text
contracts: bun run typecheck && bun run test && bun run build
backend:   bun run typecheck && bun run lint && bun run test && bun run build && bun run prisma:validate
frontend:  bun run typecheck && bun run lint && bun run test && bun run build
container: docker compose config --quiet; Produktionsimage + Health/Ready/E2E-Smoke
```

Die Befehle einzeln ausführen, damit ein Fehlschlag eindeutig zugeordnet und im
Handoff dokumentiert werden kann.

### Abschlusskriterien

- [ ] Alle Paket-Checkboxen sind mit Beleg abgeschlossen oder eine Abweichung ist
  ausdrücklich akzeptiert und dokumentiert.
- [ ] Der neu erzeugte Grafana-Token taucht ausschließlich verschlüsselt in der
  vorgesehenen Credentialablage auf.
- [ ] Ein normaler Nutzer kann ohne Kenntnis interner Begriffe ein Gerät koppeln
  und einen einzelnen Screen anzeigen.
- [ ] Playlists sind als optionale Rotation verständlich; eine Ein-Eintrag-
  Playlist verursacht keine Wiederholungsschleife.
- [ ] Rollback aus gemeinsamer Datenbank-/Instanz-Secret-Sicherung wurde geprüft.
- [ ] Die README ist vollständig Englisch, nennt den verifizierten
  Upstream-Vergleichsstand, beschreibt Inkers eigene Architektur und enthält
  weder Coffee-Verweise noch unbelegte Verfügbarkeitsbehauptungen.
- [ ] README-Links und dokumentierte Shell-/Compose-Beispiele wurden geprüft;
  lokale relative Links funktionieren auf GitHub und enthalten keine absoluten
  Entwicklerpfade oder Secrets.

### Handoff

- Ergebnis: In Arbeit. Öffentliche README vollständig auf Englisch neu geordnet;
  die kurzen Bedienanleitungen, Breaking Changes, Redirects, Credentialrotation
  und Rollbackgrenzen stehen in
  `docs/operations/UX_REMEDIATION_RELEASE_NOTES.md`. Die Dokumentation folgt
  ADR-003, ADR-005, ADR-006, ADR-007 und ADR-009 und beschreibt keine neue
  Produktfunktion.
- README-/Secret-Volumen-Nachweis: Der Integrationsvertrag erwartet den
  kanonischen Pfad `/app/secrets` auch in der öffentlichen Betriebsbeschreibung.
  Die README nennt ihn jetzt explizit; `bun test
  ./test/instance-secrets.integration.ts` ist mit schreibgeschützten
  Repository-Mounts 4/4 grün.
- Vollständige Testbelege: 29.08.2026: Contracts `typecheck` grün, 97/97 Tests
  grün, Build grün. Frisches Frontend-Builder-Image: Typecheck grün,
  Production-Build grün; der vollständige Lauf wurde erneut ausgeführt:
  24 Testdateien / 127 Tests grün (13 bewusst übersprungen)
  und vollständiges Lint ohne Fehler (10 bestehende Warnings). Für die
  unverändert dynamischen Legacy-Plugin-/Widget-JSON-Editoren ist die
  `no-explicit-any`-Ausnahme lokal in `frontend/eslint.config.js` begrenzt;
  keine Regel wurde global abgeschaltet. Frisches Backend-Builder-Image: Typecheck, Build und
  Prisma-Validierung grün; Backend-Lint grün mit 34 vorbestehenden Warnings.
  `docker compose config --quiet` ist mit einem ausschließlich temporären
  nichtproduktiven `ADMIN_PIN` grün. Der bereits isolierte E2E-Stack auf
  `127.0.0.1:18080` ist healthy; `/health` und `/ready` antworten jeweils 200.
  Lokales Playwright gegen diesen Stack: UX-03 1/1 grün; UX-05 Playlist-
  Publication, direkte Einzel-Screen-Zuweisung und Browserdisplay-Pairing jeweils
  grün. Die UX-05-Spezifikation verwendet nun die aus UX-06 resultierende
  Risky-Karte im zugänglichen Namen sowie `E2E_BASE_URL` statt `localhost:80`.
  UX-06 deckte im alten laufenden Image eine fehlende semantische Vorschau auf;
  `TargetPreview` exponiert nun `role="img"` mit seinem vorhandenen Namen und
  das Review ist korrekt ein Dialog. Der frische Komponententest ist 1/1 grün;
  der Browser-E2E-Nachweis für genau diese DOM-Änderung wartet auf ein neues
  Produktionsimage.
  Der vollständige Backend-Lauf wurde im Builder mit dem erwarteten Repository-
  alias und read-only CI-Workflow wiederholt; die Foundation-Layoutprüfungen
  bestanden. Der echte Browserteil `screen-renderer.service.test.ts` läuft
  zudem in einem automatisch entfernten Container mit dem verifizierten
  Chromium-Library-Satz 13/13 grün. Das aktuelle `backend-builder`-Image mit
  diesen Bibliotheken wurde anschließend erfolgreich als
  `sha256:486fe717a8e4bcfe419aee2cf395f709af5e15d0cf20fb00a2b1675999c96cd4`
  gebaut. In genau diesem frischen Image sind Backend-Typecheck und Nest-Build
  grün; ESLint endet ohne Fehler (34 vorhandene Warnings). Der breite Lauf
  erreicht darin die Foundation- und Fachtests; die
  Testausgabe liefert in der lokalen Docker-Desktop-Sitzung jedoch keine
  verwertbare Abschlusszusammenfassung. Die gleiche Suite wurde deshalb
  verzeichnisweise, ohne Tests auszuschließen, unterhalb der lokalen
  30-Sekunden-Ausführungsgrenze geprüft: API 78/0, Device/Delivery/Playback/
  Playlist/Publication 229/0, Sources/Renderer/Screens/Settings 130/0, übrige
  Kernmodule 370/0, Firmware/Jobs/Models/Observability/Timers 138/0 und
  Federation 194/0. Die noch nicht in einen kurzen Lauf zerlegten
  `test/*.integration.ts`-Dateien bleiben ausdrücklich offen; der globale
  Backend-Befehl gilt deshalb weiterhin nicht als vollständiger Grünnachweis.
  Ein einzelner nicht-providerbezogener Maintenance-Fall (ursprünglicher
  Stunden-Cutoff bei verspäteter Ausführung) ist 1/1 grün. Die gezielte
  Grafana-Snapshot-Integration wurde nicht gestartet: Die Ausführungsumgebung
  behandelt sie wegen der fehlenden Bestätigung über die Sperrung des früher
  kompromittierten Tokens korrekt als potenziellen Echt-Smoke.
  Zwei davon unabhängige Source-Integrationstests sind einzeln grün: atomarer
  Definition-/verschlüsselter-Secret-/Outbox-Commit (1/1) sowie versionierter
  frischer Snapshot ohne SQL-Schreibvorgang oder Netzwerkzugriff beim Lesen
  (1/1). Die Abwehr kopierter Secrets in öffentlicher Konfiguration oder Namen
  (1/1) und das Beibehalten eines letzten gültigen Snapshots nach fehlgeschlagener
  neuer Definition (1/1) sind ebenfalls grün. Der lokale Connector-Timeout mit
  Parent-Abbruch (1/1) und die Deduplizierung bei doppelter Ausführung oder
  Crash vor Acknowledgement (1/1) sind ebenfalls grün. Gleichzeitige
  Refresh-Commands und Scheduler erzeugen außerdem genau einen unveränderlichen
  Job pro Source-Intervall (1/1).
  Der unabhängige Playlist-Draft-/Publish-Integrationstest ist ebenfalls 1/1
  grün. Der UX-03-Persistenzfall veröffentlicht einen unveränderlichen lokalen
  Design-Capture und weist eine veränderte Designrevision zurück (1/1 grün).
  Ein fehlgeschlagener zweiter Renderlauf bewahrt kompatible letzte gültige Bytes
  und das Manifest über einen Neustart (Render-Cache-Integration 1/1 grün).
  Ungültige Render-Bytes werden nie veröffentlicht; ein korruptes aktuelles
  Artefakt fällt ohne Schreibvorgang zurück (1/1 grün). Ein zeitüberschrittener
  Job darf keine späten Pixel veröffentlichen oder den letzten gültigen Zustand
  ersetzen (1/1 grün). Publication-APIs bewahren Admin-/CSRF- und Device-Auth
  auch vor 304 und liefern isolierte read-only Manifeste (1/1 grün). Eine
  Screen-Mutation, Refresh-Markierung, Revision und Outbox rollen gemeinsam
  atomar zurück (1/1 grün).
- Migrations-/Rollback-Ergebnis: `bun test ./test/migrations.integration.ts`
  im aktuellen Builder-Image erneut 12/12 grün, einschließlich UX-02-Migration gültiger Legacy-Grafana-Children
  zu worker-owned Sources ohne Credential-Entschlüsselung. Die bereits
  paketbezogen belegten frischen und Kopie-Migrationstests bleiben maßgeblich.
  Keine Migration auf Nutzerdaten und kein Restore auf echten Volumes durchgeführt.
  Release Notes verweisen auf den geprüften Dreivolumen-Rollback aus
  `DATABASE_BACKUP.md`.
- Bekannte P0/P1/P2: P1: vollständiger Backend-Gesamtlauf nach Builder-Library-Fix
  kann ohne Docker-Bereinigung nicht erneut als exportiertes Testimage erzeugt
  werden; die betroffene Renderer-Suite ist separat 13/13 grün. P2: Backend-Lint
  meldet 34 vorhandene Warnings; der Vite-Build warnt über einen >1-MB-Chunk und
  veraltete caniuse-Daten. Grafana-Echt-Smoke bleibt bis zur bestätigten Sperrung
  des früher kompromittierten Tokens blockiert. Zusätzlich kann Docker Desktop
  nach dem Builder-Build sein eigenes `docker system df` nicht mehr ausführen
  (`NotFound: snapshot extract-… does not exist`); ohne eine ausdrücklich
  genehmigte, potenziell bereinigende Docker-Desktop-Reparatur ist daher kein
  neues Produktionsimage für die verbleibenden Browser-E2E-Prüfungen erzeugbar.
- Release-/Commitstand: Branch `codex/device-platform-spike`, Ausgangscommit
  `06e337b5f0b0b50675382faeece2b0db85fbd170`; kein Commit und kein Push. Upstream
  `usetrmnl/inker` `83c72b0c590cca40df9da1c646c3d5693e0028df` lokal am
  29.08.2026 verifiziert. Docker-Export am 29.08.2026 blockiert durch lokale
  Kapazität: vor dem aktuellen Builder-Build 214.1 GB Images (195.6 GB
  reclaimable), 12.49 GB Container (12.46 GB reclaimable), 21.77 GB Build Cache
  (19.25 GB reclaimable). Danach meldet Docker Desktop beim Prüfen der
  Auslastung einen fehlenden internen Snapshot; es wurden keine Daten, Volumes,
  Images oder Container bereinigt.

## Offene Fragen vor den jeweils betroffenen Paketen

1. Soll der technische Bereich „Data sources“ für normale Benutzer sichtbar
   bleiben oder nur unter einem „Advanced“-Tab liegen? Standardannahme dieses
   Plans: Integrationsseite, Tab „Data sources (advanced)“.
2. Soll Risky-Auflösungsanpassung standardmäßig `contain` bleiben oder darf der
   Benutzer pro Zuweisung `cover` wählen? Standardannahme: `contain`; `cover` nur
   mit Preview und ausdrücklicher Auswahl.

## Universeller Fortsetzungsauftrag

```text
Bearbeite ausschließlich Paket UX-XX aus
C:\Users\Nathaniel\Documents\StatusPanel\inker\docs\architecture\PRODUCT_UX_REMEDIATION_PLAN.md.
Lies zuerst den Gesamtplan und danach das Paket vollständig. Prüfe Branch, git
status, vorhandene Änderungen und die Paketabhängigkeiten. Implementiere nur den
Paket-Scope, ergänze proportionale Tests und dokumentiere ausgeführte Prüfungen,
Abweichungen und Handoff direkt im Paket. Hake das Paket erst ab, wenn alle
Akzeptanzkriterien erfüllt sind. Erstelle keinen Commit und führe keine Migration
auf echten Nutzerdaten aus, außer der Benutzer fordert dies ausdrücklich an.
Für UX-09 ist der erwartete Abschluss ein Bericht mit Go/Limited-Go/No-Go, nicht
ein Produktivimporter. Implementiere ein dort eventuell vorgeschlagenes UX-11
erst nach ausdrücklicher Freigabe des Benutzers.
```
