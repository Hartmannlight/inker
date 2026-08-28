# Isolation von Erweiterungscode – Betrieb (WP-22)

Stand: 2026-08-28. Dieses Dokument beschreibt die abgenommene Grenze.
Der Abschlussnachweis einschließlich Produktionscontainer, Integration und
verbleibender Sicherheitsgrenzen steht im
[Paket-Handoff](WORK_PACKAGES.md#wp-22--isolationsgrenze-für-plugin-blockiercode).
Die Entscheidung steht in [ADR-010](adr/010-extension-isolation.md).

## Unterstützte Vertrauensklassen

| Klasse | Ausführung und Berechtigungen |
|---|---|
| Eingebauter, geprüfter Connector | Registrierter Anwendungscode im Source-Worker. Nur die vorhandenen Testtypen `fixture`, `slow`, `failure`; kein produktiver Provider. Darf für die Connector-Ausführung ein workerintern entschlüsseltes Secret erhalten; Gastcode erhält es nie. |
| Deklaratives Liquid-Template | Liquid-Browserbibliothek und vorhandene Filter im QuickJS-Gast eines eigenen Prozesses. Nur normalisierte Daten, keine Plugin-Settings oder Credentials. |
| Unbekannter JavaScript-Transformationscode | QuickJS-Gast in einem frischen, beendbaren Bun-Kindprozess pro Ausführung. Nur JSON-Input und JSON-Output; keine Hostfunktionen, Module oder Provider-Rechte. |
| Native Plugins, beliebige npm-Module, ausführbare Dateien | Nicht unterstützt. Es gibt keinen Marketplace, Modul-Upload oder generischen Prozessstarter. |

Eine deklarative Vorlage ist nicht automatisch harmlos: Auch Schleifen und
Filter unterliegen der gleichen Prozess-, Laufzeit- und Speichergrenze. Renderer
bleiben gemäß [ADR-007](adr/007-snapshot-only-rendering.md) ohne Providerabrufe.
Die neue Ausführung erlaubt keine zusätzlichen Widgets oder Connectoren.

## Grenze und Datenfluss

`executeIsolated()` validiert den versionierten Auftrag und kopiert dessen Daten
über Property-Deskriptoren. Getter, Proxy-Traps und Serialisierungshooks werden
nicht ausgeführt. Nur danach folgen zentrale Secret-Redaction und JSON-Encoding.
Der Kindprozess erhält genau einen Auftrag über stdin und antwortet einmal über
stdout. Ergebnisse werden im Gast und erneut im Elternprozess validiert.

Der Kindprozess startet mit `process.execPath`, `env: {}` und unter Bun zusätzlich
`--no-env-file`. Sein Arbeitsverzeichnis ist das Verzeichnis des festen
Child-Einstiegspunkts. Dadurch werden weder die Umgebung des API-/Worker-Prozesses
noch Bun-`.env`-Dateien als Konfiguration geerbt. Kommandozeilenargumente enthalten
keinen Nutzercode, keine Daten und keine Credentials.

Der vertrauenswürdige Bun-Loader lädt die installierte QuickJS-WASM-Laufzeit und
bei Liquid ausschließlich deren festes lokales Browser-Bundle. Unbekannter Code
läuft **innerhalb QuickJS**, nicht als Bun-/Node-Code. Der Gast besitzt keine
Host-Handles, keinen Modul-Loader und keine Bindings für `process`, `require`,
`Bun`, Dateisystem, `fetch`, WebSocket oder andere Netzwerk-APIs. `Function` und
`eval` erzeugen ausschließlich Code in diesem Gast-Realm; sie sind kein Weg zu
Hostfunktionen. Der Proxy-Konstruktor ist deaktiviert, zentrale
Builtin-Prototypen sind eingefroren.

Zulässige Daten sind `null`, Boolean, endliche Zahlen, Strings, dichte Arrays
und einfache Objekte. Zyklen, eigene Symbole, nicht aufzählbare Felder,
Accessor-Felder, Funktionen und abweichende Prototypen sind unzulässig.
`__proto__`, `constructor`, `prototype`, `toJSON`, `toString` und `valueOf` sind
als Objektfelder ausgeschlossen. `undefined` ist kein JSON-Ergebnis.
`ScriptExecutorService` behandelt lediglich einen fehlenden Input weiterhin wie
`null`. Die JSON-Grenze ist keine allgemeine Transportoberfläche für Hostobjekte.

Secrets gehören niemals in öffentlichen Code oder Snapshot-Daten, auch nicht
unter unauffälligen Feldnamen. Die Redaction ist zusätzliche Absicherung, kein
Ersatz für die Connector-Secretreferenz. Source-Transformationen erhalten nur das
bereits validierte `result.data`, weder Source-Konfiguration, Referenzen noch den
Job. Der Source-Worker prüft das Ergebnis nochmals gegen den Connectorvertrag
und den dort bekannten Secretwert.

## Feste Ressourcenlimits

Die Werte stehen in
[`isolation-contract.ts`](../../backend/src/isolation/isolation-contract.ts).
Sie sind keine frei einstellbaren Umgebungsvariablen.

| Grenze | Wert / Bedeutung |
|---|---|
| Gast-Ausführungsbudget `cpuMs` | 1.000 ms; unterbricht anhand einer Zeitdeadline an QuickJS-Interruptpunkten. Keine OS-CPU-Quote. |
| Gesamte Ausführungsdeadline | 2.500 ms ab Einreihung nach Eingabevalidierung; umfasst Warteschlange, Prozessstart und Ausführung. |
| WASM-Linearspeicher | Fest 32 MiB, `initial = maximum = 512` Seiten à 64 KiB; neues Modul pro Auftrag. |
| QuickJS-Stacklimit | 512 KiB. |
| Gleichzeitige Kindprozesse | Höchstens 2 je API-/Worker-Elternprozess. |
| Wartende Aufträge | Höchstens 16 je Elternprozess; danach `ISOLATION_BUSY`. |
| JavaScript-Code | Höchstens 10.000 JavaScript-Stringzeichen. |
| Liquid-Code | Höchstens 128 KiB UTF-8. |
| Normalisierter Input / JavaScript-Output | Je höchstens 64 KiB serialisiertes JSON, maximal 16 Container-Ebenen. |
| Liquid-HTML | Höchstens 256 KiB; der Gast zählt die serialisierte Stringdarstellung, sodass Escapes das nutzbare HTML-Budget reduzieren können. |
| IPC-Anfrage / stdout-Antwort | Höchstens 256 KiB / 512 KiB. |
| stderr | Über 8 KiB wird der Prozess beendet; Inhalte werden nicht als Anwendungslogs übernommen. |
| Legacy-Custom-Widget-Grid | Höchstens 16 Zellen und 16 konfigurierte Zelleinträge; Scriptzellen werden nacheinander ausgeführt. |

`runtime.setMemoryLimit()` allein genügt bei der verwendeten QuickJS-WASM-
Variante nicht als Beleg für das aggregierte Speicherlimit. Deshalb wird der
gesamte WASM-Linearspeicher begrenzt und die tatsächlich verwendete Memory-Instanz
kontrolliert. Die 32 MiB umfassen auch interne Gastdaten und sind **kein Limit
für das gesamte RSS des Bun-Kindprozesses**. Bun, WASM-Loader, IPC-Puffer und
Elternprozess benötigen zusätzlichen Speicher. Mehrere API-/Worker-Prozesse
besitzen jeweils eigene Semaphore und können zusammen mehr als zwei Kinder haben.

Bei Abbruch, abgelaufener Deadline oder übergroßer IPC-Ausgabe beendet der Parent
das Kind mit `SIGKILL`. Der Aufruf wird erst nach dessen tatsächlichem `close`
abgeschlossen und der Slot dann freigegeben. Ein bloßes Promise-Timeout gilt
nicht als Prozess-Cleanup. Jeder folgende Auftrag startet ein neues Kind,
auch nach Absturz oder Speichermangel.

## Source-Transformation und Fehlerzustand

`POST /api/sources` und `PUT /api/sources/:id` akzeptieren zusätzlich zum
bestehenden Source-Command das optionale Feld `transformationCode`, zum Beispiel:

```json
{ "transformationCode": "return { doubled: $.value * 2 };" }
```

Dies ist nur ein Feldbeispiel, kein vollständiger Create-/Update-Body. Für
Adminsession, CSRF, vollständige Commands und Versionskonflikte gilt
[SOURCE_OPERATIONS.md](../operations/SOURCE_OPERATIONS.md). Bei `PUT` erhält ein
weggelassenes Feld den bisherigen Code; `null` entfernt ihn. Änderungen erzeugen
eine neue Definitionsversion. Code ist öffentliches Konfigurationsmaterial und
wird über den autorisierten Definitions-Read zurückgegeben: keine Secrets darin
eintragen. Die Source-Antwort liegt unter dem HTTP-Wrapper `data`.

Bei einem nicht mehr entschlüsselbaren bisherigen Secret bleiben gewöhnliche
öffentliche Änderungen mit `SOURCE_SECRET_UNAVAILABLE` gesperrt. Deaktivieren,
Secret löschen oder rotieren ist weiterhin möglich, wenn Name, Connector-Typ,
Schema, Konfiguration, Transformationscode, Intervall, Timeout und Concurrency-
Gruppe exakt dem gespeicherten Stand entsprechen. So entstehen unter fehlender
Altsecret-Prüfung keine neuen öffentlichen Daten. Ein neues Secret wird auch bei
dieser Reparatur gegen die erhaltenen öffentlichen Daten geprüft. Zuerst mit
unveränderten Feldern reparieren, danach gegebenenfalls Code oder Konfiguration
mit der neuen Definitionsversion ändern.

Die Transformation läuft nach dem Connector und vor dem Speichern des neuen
Snapshots innerhalb desselben Source-Timeouts. Dieser bleibt auf höchstens
7.500 ms begrenzt, der äußere Queue-Timeout beträgt 8.000 ms. Ein kürzeres
Source-Budget kann die Isolation bereits vor deren eigener Deadline abbrechen.
Erfolg ergänzt `connectorVersion` um `+pure-js-v1`.

| Isolationsfehler | Persistierter Source-Code |
|---|---|
| Gast-/Parent-Deadline oder abgelaufener Source-Timeout | `SOURCE_TIMEOUT` |
| Parent-Abbruch oder `ISOLATION_ABORTED` | `SOURCE_ABORTED` |
| Ungültige Ausgabe, Speicherfehler, Crash, Kapazitäts-/Startfehler und sonstige Transformationsfehler | `SOURCE_TRANSFORM_FAILED` |

Bei Fehler entsteht kein neuer erfolgreicher Snapshot. Der letzte gültige
Snapshot bleibt erhalten; ein neuer Fehlersnapshot übernimmt seine Daten mit
`stale`. Ohne letzten gültigen Stand entsteht `error` mit `data: null`.
Lease-/Definitions-Fencing verhindert verspätete Erfolgsschreibvorgänge.

Die Isolation wiederholt einen Auftrag nicht selbst. Source-/Outbox-Retries
behalten das bestehende Budget von höchstens fünf dauerhaften Versuchen,
exponentiellem Backoff und Jitter. Ab drei aufeinanderfolgenden Fehlern sperrt
der Circuit mindestens 30 Sekunden. Ein terminaler Auftrag deaktiviert nicht
automatisch die Source; für einen dauerhaften Stopp bewusst deaktivieren.
Details zu Retry, Recovery und Backup stehen in den
[Source-](../operations/SOURCE_OPERATIONS.md) und
[Worker-Betriebsunterlagen](../operations/WORKER_OPERATIONS.md).

## JavaScript-/Liquid-Kompatibilität

JavaScript liest Daten weiterhin über `$`. Im Value-Modus muss der Funktionsrumpf
einen JSON-Wert zurückgeben. Im Template-Modus werden wie bisher einfache
`var`-/`let`-/`const`-Namen gesammelt; Namen mit `__`-Präfix werden ausgelassen.
Dies ist die bestehende einfache Namensextraktion, kein vollständiger
JavaScript-Parser. Async-Hostdienste, Imports, Funktionen oder lebende Objekte als
Ergebnis gehören nicht zum Vertrag. Fehlende Scriptcodes und fehlgeschlagene
Gridzellen liefern keine erfolgreiche Platzhalter-/Fehleranzeige mehr.

Liquid behält die vorhandenen Filter, unter anderem Zahlenformatierung,
`pluralize`, `group_by`, `find_by`, `json`, `parse_json`, `l_date`, `ordinalize`,
`sample` und `append_random`. `settings` ist im Gast immer `{}`, auch wenn im
Input ein gleichnamiges Feld existiert. `where_exp`, `include`, `render` und
`layout` bleiben gesperrt; lokale Dateien werden nicht als Templates geladen.
Zeit-/Zufallsfilter sind weiterhin nicht deterministisch und keine Zusage für
reproduzierbare Render-Keys. Fehlende normale Liquid-Variablen behalten die
bisherige nicht-strikte Semantik; tatsächliche Ausführungsfehler werden nicht
als erfolgreiches HTML behandelt.

Das resultierende HTML durchläuft weiterhin den vorhandenen Renderer mit
deaktiviertem Browser-JavaScript und gesperrten externen Ressourcen. Die
Code-Isolation erlaubt keinen URL-Screenshot oder Provider-Fetch.

## Fehler und Diagnose

Der interne Executor liefert nur feste `IsolatedExecutionError.code`-Werte:

| Code | Diagnose |
|---|---|
| `ISOLATION_INVALID_INPUT` | Code-/Datenlimits, nicht erlaubte JSON-Form oder Protokoll prüfen. |
| `ISOLATION_BUSY` | Prozesslokale Warteschlange voll; Aufruferlast reduzieren. |
| `ISOLATION_TIMEOUT` | Code vereinfachen und Queue-/Source-Budget prüfen; keine unbegrenzten Limits aktivieren. |
| `ISOLATION_ABORTED` | Request-/Source-Abbruch beziehungsweise Shutdown zuordnen. |
| `ISOLATION_FAILED` | Gastfehler ohne Rohtext; auch abgefangener Speicherfehler kann diesen Code liefern. |
| `ISOLATION_INVALID_OUTPUT` | Nicht-JSON, Hooks, Prototypen, Tiefe oder IPC-Schema prüfen. |
| `ISOLATION_OUTPUT_LIMIT` | JSON-/HTML-/IPC-Menge reduzieren. |
| `ISOLATION_MEMORY_LIMIT` | VM-/Speicherfehler; keine pauschale Aussage über das Prozess-RSS. |
| `ISOLATION_CRASH` | Kindprozess unerwartet beendet; Runtime-/Containerzustand prüfen. |
| `ISOLATION_UNAVAILABLE` | Child-Einstiegspunkt, Runtime, installierte Assets und Startberechtigungen prüfen. |

`ScriptExecutorService` bewahrt `{ success, value?, variables?, error? }` als
asynchrones Ergebnis und gibt keine ursprüngliche Exception zurück.
Custom-Widget-Previews liefern bei Ausführungsfehlern HTTP 503
`SCRIPT_EXECUTION_FAILED`, bei zu großem Grid `SCRIPT_GRID_LIMIT_EXCEEDED`.
Der Plugin-Renderer liefert 503 `PLUGIN_TEMPLATE_UNAVAILABLE`, bei ungültigem
Input `SOURCE_SNAPSHOT_INVALID` und bei gesperrten Liquid-Funktionen
`PLUGIN_ISOLATION_REQUIRED`. Eine lesbare Source mit Fehlersnapshot kann dagegen
HTTP 200 liefern; ihren Code unter `data.snapshot.error.code` prüfen.

`isolationDiagnostics()` ist eine interne Funktion, kein öffentlicher
HTTP-Endpunkt. Sie enthält nur prozesslokale Zähler `started`, `completed`,
`failed`, `killed`, `active`, `pending` und eigene Child-PIDs. Nach Neustart beginnen
die Zähler neu. Keine Skripte, Daten, stderr-Inhalte oder Umgebungsvariablen zur
Fehleranalyse protokollieren. `killed` zählt angeforderte Beendigungen; erst
`active: 0` nach Abschluss bestätigt die geleerte aktive Prozessliste.

## Build, Shutdown und Wiederholungsprüfung

Der Backend-Webpack-Build erzeugt neben `main.js` und `worker.js` den festen
Einstieg `dist/isolation-child.js`. Die installierten QuickJS-/Liquid-Abhängigkeiten
müssen im Laufzeitimage vorhanden bleiben. Fehlende Dateien nicht durch einen
Fallback auf In-Process-Ausführung oder dynamisches Nachladen ersetzen.

`closeIsolatedExecution()` sperrt neue Aufträge, bricht wartende Aufträge ab,
beendet aktive Kinder und wartet auf deren Schließen. Die API ruft dies beim
geordneten Shutdown auf. Der Worker stoppt zuerst den Dispatcher und danach die
Isolation, bevor Redis und Nest geschlossen werden. Ein hartes Beenden des
gesamten Elternprozesses ist kein Ersatz für diesen Pfad; Prozessreste und
ausstehende Outbox-Claims bei Störungen mitprüfen.

Mit der [gepinnten Toolchain](TOOLCHAIN_BASELINE.md), aus `backend/`:

```sh
bun test src/isolation/guest-runtime.test.ts
bun test src/isolation/isolated-executor.test.ts
bun test src/custom-widgets/services/script-executor.service.test.ts src/custom-widgets/custom-widgets.service.test.ts src/plugins/plugin-renderer.service.test.ts
bun test test/sources.integration.ts
bun run typecheck
bun run build
```

Die Source-Integration benötigt ihre isolierten Testdatenbanken. Adversariale
Tests niemals gegen produktive Sources oder fremde Dienste richten. Zu prüfen
sind Endlosschleife, aggregierte Speicherlast, Token-/Hostzugriffsversuch, Getter/
Hooks, Ausgangsgröße, echter Prozessabsturz, Abbruch, Cleanup und anschließender
erfolgreicher Auftrag. Zusätzlich müssen der Produktionsbuild im Linuxcontainer,
API-Latenz während fehlerhafter Arbeit, Source-Stale/Retry und geordneter Shutdown
nachgewiesen werden. Dieser Abschnitt ist eine Prüfanleitung, kein Ergebnisprotokoll.

## Verbleibende Sicherheitsgrenzen

Dies ist **keine vollständige OS-Sandbox**: Der Bun-Kindprozess läuft unter
derselben UID und mit den Betriebssystemrechten seines Elternprozesses. Es gibt
keinen eigenen Netzwerk-Namespace, keine pro Kind gesetzte Dateisystem-ACL und
keine separate cgroup. Die Netzwerksperre gilt für die Fähigkeiten des QuickJS-
Gasts, nicht für einen bereits kompromittierten nativen Loaderprozess.

Fehler in QuickJS, dessen WASM-Build, Bun oder dem vertrauenswürdigen Loader
bleiben Teil des Bedrohungsmodells. Ein solcher Escape könnte auf Dateien oder
Netzwerk zugreifen, die der UID zugänglich sind; `env: {}` verhindert das nicht.
Container-/Hostrechte und bestehende Secretdatei-Berechtigungen deshalb nicht
aufweiten. Ungewöhnliche Last durch bereits übergroße Hostobjekte bleibt durch
vorgelagerte HTTP-/Connector-Eingabegrenzen zu begrenzen; die interne Funktion ist
kein Ersatz für diese Grenzen.

Native oder frei vernetzte Drittanbieter-Erweiterungen erfordern eine neue
Entscheidung zu separater UID, Dateisystem, Netzwerk und Ressourcenverwaltung
sowie erneute adversariale Abnahme. Diese Rechte werden durch WP-22 nicht
freigegeben. Ebenso gibt es keinen Nachweis für zusätzliche Hardware oder
produktive Provider.
