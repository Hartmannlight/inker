# Observability-Betrieb (WP-28)

Status: WP-28 am 2026-08-28 abgenommen. Maßgeblich bleiben der Paket-Handoff in
`WORK_PACKAGES.md` und die noch ausstehende Foundation-Freigabe nach WP-29.

## Diagnosezugang und Health

Die Adminseite `/operations` liest `/api/operations` alle 15 Sekunden, solange
sie sichtbar ist. Parallele Abfragen werden zusammengeführt; die UI bricht einen
Request nach 8 Sekunden ab. Ein fehlgeschlagener Abruf kennzeichnet den letzten
Stand als veraltet. Bei 401/403 wird die bisherige Diagnoseansicht entfernt.
Diese Oberfläche führt keine fachlichen Änderungen oder Remote-Requests aus.

`/api/operations` und `/api/operations/metrics` erfordern eine normale gültige
Adminsession und antworten mit `Cache-Control: no-store`. Ein Gerätecredential
berechtigt nicht zum Zugriff. Metrics ist Prometheus-Textformat 0.0.4, kein JSON.
Ein externer Collector muss diesen geschützten Zugriff unterstützen; es gibt
keinen öffentlichen Scrape-Endpunkt und keinen statischen Monitoring-Token.
Sessionrotation und -ablauf bleiben wirksam. Keine Credentials in URLs setzen.

| Endpunkt | Bedeutung |
| --- | --- |
| `/live` | API-Prozess antwortet; keine Abhängigkeitsprüfung. |
| `/ready` | SQLite-Probe entscheidet über API-Bereitschaft. Worker-/Redis-Ausfall wird separat als `background: degraded` gemeldet. |
| `/health` | Bisherige SQLite-Healthprüfung; Compose prüft diesen Endpunkt. |
| Worker `127.0.0.1:3001/live` | Nur im Container: Worker-Prozess lebt, beim Herunterfahren 503. |
| Worker `127.0.0.1:3001/ready` | Nur im Container: SQLite, Queue-Verbindungen und frische Worker-Präsenz. |

`healthy`, `degraded` und `unavailable` in Operations sind keine zusätzlichen
Schreibzustände. Bei ausgefallenem Hintergrunddienst kann die API weiterhin
bereit sein und vorhandene lokale Artefakte liefern. Ein Fehler beim Lesen von
Diagnosemetadaten ist `METRICS_UNAVAILABLE`, nicht automatisch ein DB-Ausfall.

## Messung, Alter und Grenzen

Der Diagnose-Sampler verwendet ausschließlich einzelne Leseabfragen ohne
interaktive SQLite-Transaktion und ohne `BEGIN IMMEDIATE`. Ein vollständiger
Scan und eine unabhängige `SELECT 1`-Probe dürfen jeweils nur einmal laufen.
Nach 2 Sekunden wird die Antwort auf unbekannte Metadaten begrenzt. Bereits
laufende ORM-Abfragen sind nicht abbrechbar: Ihr Slot bleibt bis zum tatsächlichen
Ende belegt; weitere Batches werden nach dem Abbruchsignal nicht gestartet.
Auch bei einem frühen Fehler werden die anderen gestarteten Batch-Abfragen
abgewartet, bevor der Slot wieder frei wird.

Diese Metadaten sind eine zeitnahe Bestandsaufnahme, keine transaktional
gleichzeitige Sicht. Inkonsistente Collection-Zählungen werden nicht mit
künstlich erhöhten Gesamtzahlen repariert, sondern als fehlende Messung behandelt.
Antworten sind höchstens eine Sekunde gecacht, niemals über die Worker-TTL hinaus.

Worker liefern alle zwei Sekunden ausschließlich feste Metrikfamilien über
privates Redis. Maximal 16 Worker und 64 KiB pro Sample sind zulässig; ein Sample
ist nach 8 Sekunden abgelaufen. Maximal 2 Sekunden Uhrvorlauf sind toleriert.
Die API prüft das Alter nach Redis-I/O, nach anderen Diagnoseabfragen und vor der
Ausgabe. Fehlende oder unvollständige Worker-Samples ergeben unbekannte Werte,
nicht Null. Die betroffenen Prometheus-Familien fehlen dann und
`statuspanel_worker_sample_available` ist 0.

Das JSON zeigt momentane Lifetime-Summen der aktuell sichtbaren Worker plus
lokaler API-Zähler. Diese Summen können bei Worker-Neustarts sinken. Prometheus
verwendet stattdessen monotone, pro API-Prozess akkumulierte beobachtete Deltas:
Ein neuer oder wieder auftauchender Worker liefert zuerst nur eine Baseline;
Arbeit vor dieser Baseline gehört nicht zum beobachteten Fenster. Folgende
Samples addieren Inkremente. Duplikate, ältere Samples und Counterrückgänge
setzen den Akkumulator nicht zurück. Redis-Lücken bewahren die Baselines;
ein bestätigter Ownerwechsel verwirft nur die zugehörige Baseline, nicht die
bisherigen festen Summen. Ein API-Prozessneustart ist ein normaler Counterreset.
Intern werden höchstens 16 Owner-Baselines gehalten; Owner sind niemals Labels.

| Familie | Typ und feste Dimensionen |
| --- | --- |
| `statuspanel_request_duration_seconds` | Histogramm: 11 Routengruppen × 5 HTTP-Statusklassen. |
| `statuspanel_job_duration_seconds` | Histogramm: 6 Queues × 5 Ergebnisse, beobachtete Worker-Inkremente. |
| `statuspanel_render_cache_total` | Counter: `hit`, `miss`, `fallback`, `rendered`, `failed`. |
| `statuspanel_websocket_events_total` | Counter: 10 fest definierte Gateway-Ereignisse. |
| `statuspanel_websocket_connections` | Gauge: authentifizierte und ausstehende Verbindungen. |
| `statuspanel_outbox_*` | Gauges je Queue: fällig, verzögert, in Bearbeitung, Dead Letters, abgelaufene Claims, ältestes fälliges/aktives Alter. |
| `statuspanel_device_*` | Gauges je Delivery-Modus: aktiviert, veraltet, ungesehen, ältestes Last-Seen-Alter. |
| `statuspanel_*_sample_available` | Gauges für bekannte/verfügbare Messfamilien. |

Histogrammgrenzen in Sekunden: 0,005; 0,01; 0,025; 0,05; 0,1; 0,25; 0,5;
1; 2; 5; 10; 20; +Inf. Zusammen mit Summe und Count ergeben sich höchstens
**1357 Zeitreihen** am API-Endpunkt. Keine Geräte-IDs, Source-Namen, URLs,
Fehlertexte, Correlation-IDs oder Worker-IDs werden als Metriklabels verwendet.
Ausgegeben werden höchstens 100 Sources und Geräte sowie 32 Remotes, jeweils
nach ihrer ID aufsteigend, und die 100 zuletzt abgeschlossenen Dead Letters.
Die Auswahl der Sources, Geräte und Remotes folgt nicht ihrer letzten Aktivität;
Gesamtzahl und Trunkierung bleiben sichtbar. Geräte-Gauges
zählen auch Zeilen jenseits der sichtbaren 100. Bei mehr als 100 Policies wird
diese Messfamilie ausdrücklich unbekannt.

## Schwellen und Fehlerdiagnose

Kandidaten für den Betrieb, noch keine WP-29-Kapazitätsfreigabe:

- Fälliges Queue-Alter ab 30 Sekunden oder ein abgelaufener Claim:
  `QUEUE_BACKLOG`. Absichtlich verzögerte Jobs zählen nicht als fälliger Stau.
- Vorhandene Dead Letters: `DEAD_LETTERS`. Die Ansicht enthält Event-ID,
  Correlation-ID, Queue, Versuchszahl und einen begrenzten Fehlercode, keinen Payload.
- Fehlgeschlagene aktive Sources: `SOURCE_ERRORS`. Letzter Versuch und letzter
  Erfolg bleiben getrennt; vorhandene letzte gute Daten bleiben erkennbar.
- Stale-/Fehlerzustand aktiver Remotes: `REMOTE_ERRORS`. Keine Remote-URL oder
  Zugangsdaten in der Diagnoseantwort.
- Ungesehene/veraltete Geräte oder getrennte aktive Connected-Displays:
  `STALE_DEVICES`. Alter richtet sich nach der jeweiligen Delivery-Policy.
- Noch ungelöste Renderfehler: `RENDER_ERRORS`; ein historischer kumulativer
  Fehlercounter allein hält diesen Zustand nicht dauerhaft aktiv.

Queue-Alter, Histogramme und letzte Aktivitäten gemeinsam auswerten. Ein
erfolgreicher Server-Sendecallback (`DEVICE_DELIVERED`) belegt das Versenden,
nicht die physische Darstellung. `acknowledgedAt` ist separat ausgewiesen.

Der genaue Zeitpunkt einer authentifizierten WebSocket-Verbindung wird gepuffert
und beim nächsten regulären Telemetrieflush als `lastConnectedAt` gespeichert.
Das erhöht die vorhandene Schreibquote nicht. Bis dahin kann die Diagnose schon
eine aktive Verbindung, aber noch keinen gespeicherten Verbindungszeitpunkt
zeigen. Reconnects verlängern oder umgehen die Schreibgrenze nicht; Shutdown
erzwingt keinen zusätzlichen Write.

## Logs und Correlation

API und Worker erzeugen standardmäßig JSON. `LOG_FORMAT=simple` ist eine
explizite lokale Debugoption. Die sichere Eingangsgrenze wirkt vor Nest/Winston-
Formatierung: keine Getter, Proxy-Konvertierungen, Stacks, Bodies, Header,
Cookies, Token, Pairingcodes, Source-Konfiguration oder Source-Secrets ausgeben.
Freigegebene Ereignisfelder und Codes sind begrenzt; unbekannte Fehler werden
auf feste Codes reduziert. Maximal 8 KiB Nachricht und 16 KiB Logrecord.

Jeder HTTP-Request erhält eine neue serverseitige UUID; ein eingehender
`X-Correlation-ID` ist nicht vertrauenswürdig und wird nicht übernommen.
Die Antwort enthält die UUID. Outbox-Intents persistieren sie, der Worker stellt
den Kontext wieder her und Delivery führt ihn fort. Unabhängige Scheduler-
Arbeit bekommt einen neuen Kontext. Alte Outbox-Zeilen bleiben unverändert und
verwenden einen deterministischen UUID-Fallback aus ihrer Event-ID.

Produktionsdateien unter `/app/logs`: getrennte API-/Worker-Streams für
`combined` und `error`, je 5 MiB × 3 Dateien, Dateimodus 0600. Das entspricht
nominal höchstens 60 MiB Dateilogbestand plus einer möglichen einzelnen
Grenzüberschreitung pro aktiver Datei beim Rotieren. Compose begrenzt zusätzlich
Docker-stdout/stderr mit `json-file` auf 10 MiB × 3. Keine zeitliche Retention
oder externe Logspeicherung wird eingerichtet. Beim Containerersatz gehen
nicht separat gesicherte Dateilogs verloren; das ist keine Datenbanksicherung.

## Reproduzierbare Abnahme

`backend/test/operations-container-fixture.cjs` bietet `setup`, `smoke` und
`cleanup` für genau einen eigenen Homecontainer, drei eigene Volumes und ein
eigenes Netzwerk. Ausschließlich Loopback-Port 18731 wird veröffentlicht.
Namen und Ownership-Labels werden vor jeder Aktion geprüft. Credentials stehen
nur in der ignorierten `.tmp/wp28-operations-fixture-state.json`, niemals im Log.

Der Smoke prüft Admin-/Gerätegrenzen, einen real langsamen Source-Job,
JSON-Logs, UUID vom Request über Outbox/Worker bis zum echten WebSocket-Send,
Display-Trennung, Worker- und Redis-Ausfall mit Cacheverfügbarkeit, Erholung,
Secret-Audit und Cleanup. `setup` hält nur für die anschließende Browserprüfung
an. Nach dieser Prüfung `cleanup` ausführen und die gelabelten Ressourcen sowie
die State-Datei auf vollständige Entfernung prüfen. Laufzeitnachweise und
offene Punkte werden in `FOUNDATION_PROGRESS.md` dokumentiert.
