# Sources, Snapshots und Connectorbetrieb

Dieses Runbook beschreibt den implementierten WP-21-Stand. Es ist kein
Abnahmeprotokoll: ausgeführte Prüfungen und Messergebnisse stehen beim Paket in
[WORK_PACKAGES.md](../architecture/WORK_PACKAGES.md) und im
[Foundation-Fortschritt](../architecture/FOUNDATION_PROGRESS.md).

## Geltungsbereich und Prozessgrenze

Die eingebauten Testconnectoren `fixture`, `slow` und `failure` führen keine
Netzwerk-, Dateisystem- oder Providerzugriffe aus. Zusätzlich ist der
registrierte `grafana`-Connector als Beta verfügbar: ausschließlich der
Source-Worker verwendet sein write-only verschlüsseltes Viewer-Token für
begrenzte Grafana-API- und Render-Anfragen. Mail, Home Assistant und andere
produktive Connectoren sind nicht implementiert. Ein URL-Feld oder ein
Legacy-Plugin aktiviert keinen Provider. Unbekannter beziehungsweise nicht
abbrechbarer Erweiterungscode benötigt die separate Isolationsgrenze aus WP-22
und ADR-010.

Die API nimmt Konfiguration und Secrets entgegen, liest persistierte Daten und
schreibt Refresh-Absichten gemeinsam mit Outbox-Metadaten in SQLite. Nur der
Worker führt Connectoren aus. Renderer und Displayabrufe starten keinen Refresh.
Die Aufgabentrennung folgt [ADR-007](../architecture/adr/007-snapshot-only-rendering.md)
und [ADR-006](../architecture/adr/006-api-worker-separation.md).

## Admin-API und Commands

Alle folgenden Routen erfordern eine gültige Adminsession. Bei Cookie-Sessions
benötigen schreibende Requests zusätzlich den sessiongebundenen Header
`X-CSRF-Token`. Device-Credentials sind keine Adminberechtigung.

Erfolgreiche Source- und Publication-Antworten sind durch den globalen
`TransformInterceptor` in **`{ "data": ... }`** eingebettet. Auf der HTTP-Ebene
liegen beispielsweise `data.definition`, `data.snapshot` und `data.eventId`;
die Listenroute liefert `{ "data": [ ... ] }`. Die PowerShell-Beispiele unten
entfernen diesen äußeren Wrapper unmittelbar mit `.data`. Das innere
`snapshot.data` enthält weiterhin die eigentlichen Quelldaten. Fehlerantworten
haben keinen Erfolgswrapper, sondern unter anderem `statusCode` und `message`.

| Methode und Pfad | Wirkung |
|---|---|
| `GET /api/sources` | Bis zu 1.000 Definitionen mit Zustand und jeweils neuestem Snapshot, nach Erstellzeit aufsteigend. Keine Pagination implementiert. |
| `GET /api/sources/:id` | Eine Definition, Scheduling-/Fehlerzustand und neuester Snapshot; vor dem ersten Ergebnis `snapshot: null`. |
| `GET /api/sources/:id/snapshots/:snapshotId` | Eine konkrete persistierte Snapshot-Version; fremde Source-Zuordnung ergibt 404. |
| `POST /api/sources` | Neue Definition, optional neues verschlüsseltes Secret und bei aktivierter Source ein dauerhafter Refresh-Auftrag. |
| `PUT /api/sources/:id` | Vollständiger Konfigurationscommand mit `expectedDefinitionVersion`; kein partieller Patch. |
| `POST /api/sources/:id/refresh` | Refresh anfordern; bestehende aktive Arbeit derselben Definitionsversion wird zusammengeführt. |

Eine `eventId` bestätigt eine gespeicherte Absicht, kein fertiges Ergebnis.
`POST` liefert regulär HTTP 201, `PUT` HTTP 200. Zum Anhalten `enabled: false`
per versionsgeprüftem `PUT` setzen. Eine Source-DELETE-API existiert nicht.
`POST /api/sources` besitzt keinen Idempotency-Key: nach unklarem Transportausgang
zuerst vorhandene Definitionen prüfen, nicht blind erneut anlegen.

### Beispiel: Fixture anlegen und lesen

Die folgenden PowerShell-Befehle sind Bedienbeispiele für eine eigene
Testinstallation, keine hier ausgeführte Prüfung. `$Base`, `$Session` und
`$CsrfToken` müssen zur eigenen Installation gehören. Die Session entsteht über
`POST /api/auth/login` mit dem Adminpasswort; Cookie im Speicher behalten und
`X-CSRF-Token` aus der Antwort übernehmen. `GET /api/auth/session` liefert einen
neu rotierten CSRF-Token. Passwörter, Sessioncookies und CSRF-Token nicht in
Skripte, Shell-History, Logs oder Tickets schreiben. Für entfernten Zugriff HTTPS
verwenden; lokales HTTP nur gemäß [ADR-009](../architecture/adr/009-local-http-policy.md).

```powershell
# Vorhandene, authentifizierte WebRequestSession und CSRF-Token verwenden.
$Base = 'https://statuspanel.example' # eigene Installation einsetzen
$Headers = @{ 'X-CSRF-Token' = $CsrfToken }
$Command = @{
  protocolVersion = '1.0'
  name = 'WP21 fixture'
  connectorType = 'fixture'
  schemaVersion = '1'
  configuration = @{ data = @{ fixtureArtifacts = @('mono-800x480-white-png') } }
  refreshIntervalSeconds = 60
  timeoutMs = 1000
  concurrencyGroup = 'test-fixtures'
  enabled = $true
}
$Created = (Invoke-RestMethod -Method Post -Uri "$Base/api/sources" `
  -WebSession $Session -Headers $Headers -ContentType 'application/json' `
  -Body ($Command | ConvertTo-Json -Depth 20)).data
$SourceId = $Created.definition.sourceDefinitionId
$State = (Invoke-RestMethod -Uri "$Base/api/sources/$SourceId" -WebSession $Session).data

# Bei Bedarf anfordern; dies wartet nicht auf den Connector.
$Refresh = (Invoke-RestMethod -Method Post -Uri "$Base/api/sources/$SourceId/refresh" `
  -WebSession $Session -Headers $Headers).data

# Nach Worker-Verarbeitung erneut lesen, nicht aus eventId auf Erfolg schließen.
$State = (Invoke-RestMethod -Uri "$Base/api/sources/$SourceId" -WebSession $Session).data
```

Ein `PUT` muss alle Pflichtfelder erneut enthalten. Für die gerade angelegte,
ansonsten unveränderte Testdefinition kann `$Command.Clone()` als Grundlage
dienen; `expectedDefinitionVersion` stammt aus einem aktuellen `GET`:

```powershell
$State = (Invoke-RestMethod -Uri "$Base/api/sources/$SourceId" -WebSession $Session).data
$Update = $Command.Clone()
$Update.expectedDefinitionVersion = $State.definition.definitionVersion
$Update.enabled = $false
$Updated = (Invoke-RestMethod -Method Put -Uri "$Base/api/sources/$SourceId" `
  -WebSession $Session -Headers $Headers -ContentType 'application/json' `
  -Body ($Update | ConvertTo-Json -Depth 20)).data
```

Bei zwischenzeitlichen Änderungen die vollständige aktuelle Konfiguration
übernehmen. `409 SOURCE_VERSION_CONFLICT` bedeutet neu lesen und Änderungen
abgleichen. Jedes erfolgreiche `PUT` erhöht `definitionVersion`, setzt den
Fehlerzähler/Circuit zurück und ersetzt anstehende Arbeit der alten Version.
Bereits laufende alte Jobs dürfen nach dem Versionswechsel kein neues Ergebnis
festschreiben. Vorhandene Snapshots bleiben erhalten.

### Zulässige Konfiguration und Secrets

Pflichtfelder sind `protocolVersion: "1.0"`, `name`, `connectorType`,
`schemaVersion: "1"`, `configuration`, `refreshIntervalSeconds`, `timeoutMs` und
`concurrencyGroup`. Der Name enthält 1–120 Zeichen und darf nicht nur aus
Leerraum bestehen. `enabled` ist optional und standardmäßig `true`.
`refreshIntervalSeconds` ist eine ganze Zahl von 1 bis 86.400, `timeoutMs` von
50 bis 7.500. Die Gruppe hat 1–128 ASCII-Zeichen, beginnt alphanumerisch und darf
danach zusätzlich `.`, `_`, `:`, `-` enthalten. Unbekannte Commandfelder sind
unzulässig; eine öffentliche Definition nicht unverändert als Command senden.

| Connector | `configuration` | Ergebnis |
|---|---|---|
| `fixture` | `{ "data": <JSON> }` | Validierte Kopie der Daten, `connectorVersion: "builtin-fixture-v1"`. |
| `slow` | `{ "data": <JSON>, "delayMs": 2000 }` | Abbrechbare Wartezeit, dann Daten; `delayMs` ganzzahlig 0–60.000, ohne Angabe 60.000. |
| `failure` | `{ "data": <JSON>, "failuresBeforeSuccess": 2 }` | Versuche 1–2 schlagen fehl, danach Erfolg; ohne Feld dauerhafter Testfehler. |
| `grafana` (Beta) | `{ "baseUrl", "operation", "dashboardUid?", "panelId?", "width?", "height?", "allowLocalNetwork" }` | Worker-only Dashboard-/Panel-Metadaten oder ein validiertes PNG/JPEG-Panel. Der Viewer-Token wird ausschließlich über das write-only Commandfeld `secret` verschlüsselt gespeichert. |

`failuresBeforeSuccess` erlaubt ganze Zahlen 0–100, aber ein einzelner
Refresh-Auftrag hat höchstens fünf dauerhafte Versuche. Der Zähler bezieht sich
auf den Auftrag, nicht auf die Lebenszeit der Source. Der Slow-Default liegt
absichtlich über dem maximalen Source-Timeout. Die eingebauten Connectoren
erfinden keine `sourceTimestamp`; ohne echte Quellzeit fehlt dieses optionale Feld.

`data` ist auf 64 KiB serialisiertes UTF-8-JSON und 16 Container-Ebenen begrenzt.
Nicht endliche Zahlen, Zyklen, Accessor-/Prototypfelder, Proxyobjekte und
Schlüssel für Zugangsdaten sind unzulässig. Konfiguration und Ergebnisse werden
vor Ausführung beziehungsweise Persistenz erneut validiert. Secrets gehören
auch unter anders benannten Feldern nicht in `data` oder `configuration`.

Das optionale Commandfeld `secret` ist schreibbar, aber nicht lesbar:

- Nicht angegeben: bei `PUT` bisherige Referenz behalten.
- Nicht leerer String mit maximal 4.096 Zeichen: neue Secret-Zeile verschlüsselt
  speichern und referenzieren; nie den Wert in die Antwort übernehmen.
- `null`: Referenz entfernen. Alte Ciphertext-Zeilen werden nicht automatisch gelöscht.

Antworten enthalten ausschließlich `definition.secretReferences.provider` als
opake ID beziehungsweise `{}`. Der Client kann keine beliebige Secret-ID als
Command eintragen. Entschlüsselung für die Ausführung findet im Connector-Worker
statt. Die Testconnectoren verwenden das Secret nicht zur Datenerzeugung und
verweigern Ergebnisse, die den übergebenen Secretwert enthalten.

## Freshness, Fehler und unveränderliche Versionen

Definitionsversion, Snapshot-Revision und Publication-Revision sind getrennt.
Jeder gespeicherte Connector-Ausgang erhält eine neue Snapshot-ID und eine
Source-bezogene `revision`; `(refreshEventId, attempt)` verhindert doppelte
Snapshot-Schreibvorgänge bei Wiederholung desselben Versuchs. Snapshots enthalten
Schema-/Connector-Version, Erstellzeit, optional Quellzeit, Datenhash und
Freshness-/Fehlerdaten. SQL-Trigger verbieten Änderung und Löschung.

| Zustand | Bedeutung |
|---|---|
| `fresh` | Gültige Daten; die Gültigkeitsdauer ist noch nicht überschritten. |
| `stale` | Die letzten gültigen Daten sind gealtert oder ein neuer Abruf schlug fehl. |
| `error` | Abruf fehlgeschlagen, ohne zuvor gültige Daten; `data` ist `null`. |

Bei Erfolg zeigen `latestSnapshotId` und `latestValidSnapshotId` auf das neue
Ergebnis. Bei Fehler bleibt `latestValidSnapshotId` erhalten; der neue
Fehlersnapshot übernimmt dessen Daten, Datenalter und gegebenenfalls Quellzeit.
Eine neue Fehlerzeit macht alte Daten nicht frisch. Ohne letzten gültigen
Snapshot entstehen keine erfundenen Ersatzdaten.

Ein Read projiziert gespeichertes `fresh` nach Ablauf von
`validDataCreatedAt + staleAfterSeconds` als `stale`, ohne den Snapshot zu ändern
oder Arbeit anzustoßen. `staleAfterSeconds` entspricht dem Refreshintervall des
Snapshots. Hashabweichungen ergeben `503 SOURCE_SNAPSHOT_UNAVAILABLE`.
Nach Definitionsänderungen kann der letzte gültige Snapshot noch zur vorherigen
Definitionsversion gehören; `snapshot.definitionVersion` sichtbar mitprüfen.

### Snapshot explizit veröffentlichen

WP-21 bindet nur das vorhandene Fixture-Artefaktschema an Publications, keinen
neuen datengetriebenen Widgetrenderer. Veröffentlichbar sind gültige `fresh`-
oder `stale`-Snapshots mit Schema `1`, deren `data` genau das Feld
`fixtureArtifacts` enthält. Unterstützte IDs sind
`mono-800x480-white-png`, `mono-800x480-white-bmp` und
`mono-800x480-black-bmp`; leerer Inhalt, Duplikate und andere Datenformen werden
abgewiesen. Allgemeine Fixture-JSON-Daten sind speicherbar, deshalb aber noch
nicht als Bild veröffentlichbar.

Beispielbody für `POST /api/publications/wp21-source/publish`, geschützt durch
dieselbe Adminsession und CSRF:

```json
{
  "idempotencyKey": "0836fb3b-8f01-49ae-ab37-f0789d405468",
  "expectedRevision": 0,
  "draft": { "sourceSnapshotId": "<snapshotId aus GET /api/sources/:id>" },
  "deviceIds": []
}
```

Neue UUID pro beabsichtigtem Command erzeugen; bei Transportwiederholung dieselbe
UUID und denselben Body verwenden. `expectedRevision: 0` gilt nur für eine neue
Publication. `deviceIds: []` veröffentlicht ohne Zuweisung; für Auslieferung
bewusst vorhandene aktive Zielgeräte wählen oder später eine vorhandene Revision
über `PUT /api/publications/devices/:deviceId/desired` zuweisen.

Die Publication fixiert Source-ID, Snapshot-ID/Revision, Datenhash und
Connector-Version sowie die konkreten Fixture-Inputs. Neue Source-Ergebnisse
ändern diese Publication nicht. Erst ein weiterer expliziter Publish-Command
erzeugt eine neue Revision. Source-Versionen gehen in den Render-Key ein;
Source-Freshness und Artefaktbereitschaft sind unterschiedliche Zustände. Siehe
[Render-Cache-Betrieb](RENDER_CACHE.md).

## Scheduling, Budgets und Wiederanlauf

`nextRefreshAt` und die Refresh-Absicht sind dauerhaft gespeichert. Der Worker
sucht regelmäßig fällige aktivierte Sources; die Dispatcher-Pollperiode ist
500 ms, keine garantierte Startlatenz. Das Scheduling schreibt `source.refresh.due`
und `source_refresh_jobs` in derselben Transaktion. Bereits aktive Arbeit wird
nicht dupliziert. Eine deterministische Event-ID und dauerhafte Outbox-Receipts
verhindern die Wiederanlage abgeschlossener Identitäten.

| Grenze | Implementierter Wert |
|---|---:|
| Source-Queue: lokale Worker-Concurrency / globale Concurrency | 2 / 4 |
| Gleichzeitig reservierte Jobs insgesamt / pro `concurrencyGroup` | 4 / 2 |
| Gleichzeitig reservierte Jobs pro Connector-Typ / Source | 2 / 1 |
| Queue-Limiter | 8 Jobs pro Sekunde |
| Einzelner Source-Timeout / äußerer Queue-Timeout | 50–7.500 ms / 8.000 ms |
| SQLite-Claim-Lease | 30 Sekunden |
| Dauerhafte Versuche pro Refresh-Auftrag | höchstens 5 |
| Circuit nach aufeinanderfolgenden Fehlern | ab 3 Fehlern, 30 Sekunden Sperre |

Die Gruppe ist in WP-21 ein konfigurierbarer Budgetschlüssel, keine automatische
Erkennung eines realen Providers. Die Budgets werden bei der Claim-Reservierung
gemeinsam in einer SQLite-Schreibtransaktion geprüft, auch bei mehreren Workern.
Queue-Metadaten tragen keine Credentials oder Snapshot-Daten; Redis bleibt
Transport, SQLite die maßgebliche Quelle für Arbeit und Ergebnis.

Retries verwenden exponentiell 1, 2, 4, 8 … Sekunden, begrenzt auf 60 Sekunden
vor zusätzlichem Jitter von 0–20 %. Redis multipliziert dieses Budget nicht:
pro Claim gibt es einen Transportversuch. Transportfehler können das dauerhafte
Versuchsbudget verbrauchen, ohne dass ein Connector-Ergebnis entstanden ist.

Ab dem dritten aufeinanderfolgenden gespeicherten Fehler werden Wiederholungen
und nächste Refreshes mindestens bis `circuitOpenUntil` verschoben. Jeder weitere
Fehler kann die 30-Sekunden-Sperre erneuern. Ein manueller Refresh umgeht sie
nicht. Erfolg setzt Fehlerzähler und Circuit zurück. Ein bewusstes `PUT` erzeugt
eine neue Definitionsversion und setzt sie ebenfalls zurück; nicht als
automatischen Retry-Mechanismus missbrauchen.

Beim fünften Fehler oder einem nicht wiederholbaren Secretfehler wird der
Auftrag `dead-letter`. Eine aktivierte Source bleibt dennoch periodisch geplant;
Dead Letter beendet den Auftrag, nicht automatisch die Source. Zum dauerhaften
Stoppen deaktivieren. Der letzte gültige Snapshot bleibt lesbar.

Source-Abbruch und Shutdown verhindern verspätete Erfolgsschreibvorgänge.
Fehlermetadaten dürfen weiter gespeichert werden, um alte Daten als `stale`
auszuweisen. Abgelaufene Claims werden nach Neustart wieder aufgenommen; die
BullMQ-Lock-/Stalled-Prüfung kann über die erste SQLite-Lease hinaus dauern.
Details zu Readiness, Shutdown und Redis-Ausfällen stehen in
[WORKER_OPERATIONS.md](WORKER_OPERATIONS.md).

## Diagnose

Zuerst `GET /api/sources/:id` ansehen: `enabled`, `state.nextRefreshAt`,
`lastAttemptAt`, `lastSuccessAt`, `consecutiveFailures`, `circuitOpenUntil` und
`snapshot.error`. Fehlermeldungen enthalten einen festen Text, keine
Providerantworten oder Secrets. Der relevante Outbox-Datensatz ist über
`eventId` beziehungsweise `aggregateId = sourceDefinitionId` zuordenbar.
Die Codes eines gespeicherten Connectorfehlers stehen in
`data.snapshot.error.code` der HTTP-Antwort; ein lesbarer `stale`-/`error`-Snapshot
kann dabei regulär mit HTTP 200 zurückkommen. Diese Codes sind keine eigenen
HTTP-Statuscodes.

Commandfehler verwenden HTTP 400 (`SOURCE_INVALID_COMMAND`,
`SOURCE_INVALID_CONFIGURATION`, `SOURCE_SECRET_IN_PUBLIC_CONFIGURATION`),
Versionskonflikte beziehungsweise deaktivierte Refreshes HTTP 409 und fehlende
Sources/Snapshots HTTP 404 (`SOURCE_NOT_FOUND`, `SOURCE_SNAPSHOT_NOT_FOUND`).
Fehlende oder abgelaufene Adminsessions ergeben 401, ein ungültiger CSRF-Token
bei Cookie-Commands 403. Die unten ausdrücklich mit 503 bezeichneten Fehler
betreffen nicht verfügbare Reads oder Schreibkapazität.

| Befund/Code | Nächster Schritt |
|---|---|
| `snapshot: null`, Auftrag `pending` | Worker-/Redis-Readiness und fällige Zeit prüfen; keinen Read als Refreshersatz verwenden. |
| `SOURCE_TIMEOUT` | Slow-Konfiguration und Source-Budget prüfen; ein höherer Wert als 7.500 ms ist unzulässig. |
| `SOURCE_REFRESH_FAILED` | Connector-Konfiguration, Failure-Testverhalten und Versuchszahl prüfen; Details nicht durch Rohdatenlogging erzwingen. |
| `SOURCE_ABORTED` | Worker-Shutdown oder äußeren Queue-Abbruch mit Outboxzustand korrelieren. |
| `SOURCE_SECRET_UNAVAILABLE` | Passendes Instance-Key-Backup und Zugriff prüfen; Auftrag ist nicht wiederholbar, kein Ersatzschlüssel erzeugen. |
| `SOURCE_STALE_CLAIM` | Lease-/Owner-/Tokenwechsel; alte Ausführung darf nicht committen. Wiederanlauf und laufende neue Claims prüfen. |
| `SOURCE_DISABLED` (409) | Source bewusst aktivieren oder deaktiviert belassen. |
| `SOURCE_WRITE_CAPACITY` (503) | Schreiblast reduzieren; API-Schreibwarteschlange ist auf 1.024 Vorgänge pro Client begrenzt. |
| `SOURCE_SNAPSHOT_UNAVAILABLE` (503) | Fehlenden oder beschädigten gespeicherten Input untersuchen; kein Live-Fetch als Umgehung. |

SQLite-Schreibkonflikte werden nur nach vollständig zurückgerollter Transaktion
bis zu zweimal mit kurzer Verzögerung wiederholt. Connectoren laufen nicht in
diesen Transaktionswiederholungen. SQL-Zustand, Claims, Hashes und Receipts nicht
manuell ändern; Redis nicht leeren, um einen Rückstau zu verdecken.

## Bewusste Änderungen an Legacy-Verhalten

Diese Änderungen erhalten gespeicherte Daten, schalten aber implizite
Live-Abfragen ab:

- `GET /api/device-images/design/:id` und
  `GET /api/device-images/device/:id` liefern konstant **410
  `PUBLICATION_REQUIRED`**, ohne Existenzprüfung, Rendering oder Standardbild als
  Ersatz. Admin-Vorschauen oder alte Clients mit diesen URLs müssen auf die
  autorisierte Publication-Auslieferung umgestellt werden. `/api/display` wurde
  dadurch nicht abgeschaltet; Foundation-Pull, Manifest und Artefaktpfade bleiben
  getrennt von diesen alten Direktbildrouten.
- Weather-/GitHub-Widgets ohne persistierte Source-Bindung, Remote-Bilder und
  URL-Screenshots im Legacy-Renderer liefern **503
  `SOURCE_SNAPSHOT_UNAVAILABLE`**. Es gibt keinen RAM-Cache als Ersatz für einen
  SourceSnapshot und keinen Fetch bei einem Cache-Miss.
- Lokale beziehungsweise eingebettete PNG/JPEG/WebP/GIF-Rasterdaten bleiben
  renderbar, begrenzt auf 16 MiB und 16.777.216 Pixel. Verknüpfbare SVG-Dokumente
  sind keine zulässigen Rasterinputs. HTML-Rendering deaktiviert JavaScript,
  blockiert externe Bild-/CSS-/Font-/Frame-Anfragen und verweigert unvollständige
  oder nicht dekodierbare Bilder mit 503 statt eines erfolgreichen Teilbilds.
- Custom-Widget-Daten und Plugin-Instanzdaten werden nur aus gespeicherten
  Ergebnissen gelesen. Fehlende Ergebnisse führen zu 503. Legacy-Plugin-Widgets
  ohne Instanz-/Snapshotbindung erlauben nur statisches Markup; `polling` und
  `webhook` werden abgewiesen. Templates erhalten keine Provider-Credentials.
- Alte DataSource-Test-/Refreshpfade, Provider-/Recipe-Abfragen und
  URL-Screenshotpfade außerhalb des Snapshot-Renderers liefern **503
  `SOURCE_REFRESH_REQUIRES_CONNECTOR`**. Nicht freigegebene Plugin-Ausführung kann
  **503 `PLUGIN_ISOLATION_REQUIRED`** liefern. Diese Pfade nicht durch direkte
  HTTP-Aufrufe oder Aktivierung alter Poller wieder öffnen.

## Backup, Restore und Aufbewahrung

WP-21 benötigt kein neues Volume. Die folgenden Tabellen sind dauerhafter
Fachzustand innerhalb der vorhandenen SQLite-Datenbank:

| Tabelle | Zu erhaltender Inhalt |
|---|---|
| `source_definitions` | Konfiguration, Versionszähler, Secretreferenz, Scheduling, Circuit und Zeiger auf neuesten/letzten gültigen Snapshot. |
| `source_secrets` | AES-256-GCM-Ciphertexte; ohne passenden externen Instance-Key nicht entschlüsselbar. |
| `source_snapshots` | Unveränderliche gültige und fehlerhafte Versionen einschließlich Daten, Hash, Herkunft und Freshness. |
| `source_refresh_jobs` | Persistierte Zuordnung von Event, Definitionsversion, Connector und Budgetgruppe. |
| `outbox_events`, `outbox_effects` | Laufende/terminale Arbeit sowie dauerhafte Deduplizierungsreceipts. |
| Publication-/Render-Tabellen | Veröffentlichte Source-Referenzen, fixe Bildinputs und Geräte-/Artefaktbindungen. |

Keine selektiven Tabellenexporte als vollständigen Restore behandeln. Den
gesamten Container einschließlich API und Worker stoppen und den in
[DATABASE_BACKUP.md](DATABASE_BACKUP.md) beschriebenen zusammengehörigen Satz
sichern: `/app/uploads` einschließlich SQLite/WAL-Zustand und Uploads,
separat geschütztes `/app/secrets` sowie `/app/render-cache`.

Der Default-Key liegt lokal in `./secrets/instance.json`, im Container in
`/app/secrets/instance.json`; `INKER_INSTANCE_SECRET_PATH` muss zwischen den
Prozessen übereinstimmen. Beim Restore die passende `version`/`keyId` und
Linux-Rechte (Verzeichnis `0700`, Datei `0600`) erhalten. Den Schlüssel nicht aus
`ADMIN_PIN` ableiten, neu erzeugen oder durch einen anderen ersetzen. Automatische
Mehrschlüsselrotation und Neuverschlüsselung sind nicht implementiert.

Nach einem Restore zuerst Readiness prüfen, dann Definitionen und konkrete
Snapshot-IDs/Hashes, letzten gültigen Inhalt, veröffentlichte Referenzen und
autorisierte Artefaktlesbarkeit vergleichen. Einen kontrollierten Refresh nur
auf einer eigenen Testsource auslösen und neue Ergebnisrevision sowie Verhalten
bei Fehler prüfen. Redis kann Transport neu aufbauen, ersetzt aber keine der
gesicherten Tabellen oder Pixeldateien.

SourceSnapshots sind im WP-21-Stand nicht automatisch löschbar; auch ausgetauschte
Secret-Zeilen haben keine automatische Bereinigung. Speicherwachstum beobachten.
Outbox-Retention entfernt keine Snapshotdaten oder deren Integritätsnachweise.
Keine Trigger entfernen oder Tabellen leeren, um Speicher zurückzugewinnen.

## Prüfungen wiederholen und spätere Provider

Relevante vorhandene Prüfungen sind die Connector-Tests
`backend/src/sources/connectors.test.ts`, die persistenz-/workerbezogenen
`backend/test/sources.integration.ts` und die Browsergrenze in
`backend/src/screen-designer/services/screen-renderer.service.test.ts`.
Sie sind mit der gepinnten Toolchain aus
[TOOLCHAIN_BASELINE.md](../architecture/TOOLCHAIN_BASELINE.md) auszuführen.
Container-, Last-, Restart-, Backup-/Restore- und Hardware-Abnahmen sind anhand
des aktuellen Paket-Handoffs zu beurteilen, nicht aus diesem Runbook abzuleiten.

Ein späterer produktiver Connector benötigt registrierten Typ und versionierte
normalisierte Ergebnisse, begrenzte Daten-/Zeitbudgets, wirksamen Abort,
Providergruppen-/Ratenlimits, ausschließlich workerinternen Secretzugriff und
Tests für Fehler, Stale-Daten und Wiederanlauf. Beliebige URL-/Scriptausführung
ist kein Ersatz für diese Schnittstelle. Hardware- und produktive
Providerprüfungen werden durch die drei Testconnectoren nicht nachgewiesen.
