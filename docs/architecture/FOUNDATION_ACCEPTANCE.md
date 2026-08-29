# Foundation-Freigabebericht (WP-29)

Stand: 2026-08-29. **Software-Foundation freigegeben; Hardwareprüfungen offen.**

Basis: WP-27 `456a343`, WP-28 `99f7747`, Branch `codex/device-platform-spike`.
Maßgeblich sind `WORK_PACKAGES.md`, `ARCHITECTURE_PLAN.md` §§9, 11, 12 und die ADRs.
Keine zusätzlichen Widgets, produktiven Connectoren, Firmware oder Deployments.

## Vorab festgelegtes Lastprofil

`backend/test/foundation-load.cjs` betreibt die bestehenden Produktionspfade
gegen drei eigene Docker-Container mit tatsächlichem TLS zwischen Home und Remotes.
Die geprüfte WP-27-Infrastruktur liefert Ownership-Labels, zufällige Ressourcennamen
und getrennte Volumes; sie wird nicht mit einem früheren laufenden Dienst geteilt.

- Home: 2 CPU, 1536 MiB Speicherlimit ohne zusätzlichen Swap.
- Der bestehende Fixturewert `THROTTLE_LIMIT=1000` gilt für die Last mit einer
  gemeinsamen Loopback-Adresse (Produktionsdefault: 100). Das individuelle
  Kurzcode-Limit bleibt unverändert fünf Einlösungen pro Minute; der Aufbau
  wartet regulär auf `Retry-After`. Die Kapazitätsaussage gilt nur für die hier
  dokumentierte Konfiguration, nicht pauschal für den Default oder reale Hardware.
- 20 dauerhafte Browser-WebSockets (1920×1080), ein weiterer Touch-WebSocket
  (480×480-Referenzprofil), je ein Batterie- und Fast-Pull-Gerät (800×480).
- Zwei weitere Remote-Publications bleiben lokal verfügbar, wenn beide Remotes
  ausgeschaltet werden. Displays sprechen ausschließlich mit dem Home-Server.
- Vier Sources mit vorherigem gültigem Snapshot: zwei 60-s-Slow-Connectoren mit
  tatsächlichem 4-s-Timeout sowie zwei absichtlich fehlerhafte Connectoren.
- Drei Renderprofile; die 20 gleichen Browser teilen genau einen Render-Key.
- Gleichzeitige Manifest-/Artefakt-/Conditional-Reads, idempotente doppelte
  Touchbefehle, Source-Jobs und neue Renderanforderungen.
- Abgeschlossene Touch-Timer werden erst quittiert, nachdem alle 21 verbundenen
  WS-Clients die Completion gesehen haben; die Produktquote von 32 bleibt bestehen.
  Drei besondere Recovery-Timer bleiben bis zum Nachweis ihres unveränderten
  Zustands auf fünf neu verbundenen Clients unquittiert.
- Accelerierte Pull-Prüfungen sind Softwarelast. Die zurückgegebenen
  Policywerte bleiben Batterie 900 s und Fast-Pull 60 s. Dies ist keine Aussage
  über ein physisch sicheres E-Ink-Refreshintervall.
- Mindestens 60 s stabile kombinierte Last, drei Worker-Ausfälle/-Neustarts,
  Redis-Ausfall, beide Remotes offline und fünf absichtlich getrennte/reconnectete
  WebSockets, danach mindestens 30 s Stabilitätsprüfung.

| Messgröße | Gate vor Messung |
|---|---|
| Manifest-/Artefakt-/Conditional-Reads | p95 ≤ 500 ms, Maximum ≤ 2000 ms |
| Control-Requests (Touch, Editor, Login) | p95 ≤ 1000 ms, Maximum ≤ 5000 ms |
| Fälliges Queue-Alter in stabilen Phasen | ≤ 30 s; verzögerte Jobs ausgeschlossen |
| Drei normale Profilrender nach Publish | ≤ 10 s |
| Worker-/Redis-Recovery | ≤ 90 s einschließlich regulärer Claims/Retry-Zyklen |
| Home-cgroup-Speicher | < 1200 MiB, keine OOM-Kills |
| Browser-Renderdeduplizierung | 20 gleiche Clients, genau ein Render-Key/Job |
| Reine Reads bei gestopptem Worker | keine Publication-/Assignment-/Render-Writes |
| Secrets | kein Testsecret in Logs, Geräteantworten oder öffentlichen Metadaten |

Latenzen enthalten echte HTTP-Laufzeit einschließlich Verarbeitung, nicht Docker-
CLI-Start für Ownership-Prüfungen. SQLite-Trigger zählen betroffene Zeilen in allen
Anwendungstabellen (ohne SQLite-/Prisma-Systemtabellen und die Zähltabelle); sie
messen keine physischen SSD-I/O-Operationen. Ihr Zusatzaufwand bleibt im Test
enthalten. `memory.peak` erfasst auch Spitzen zwischen den 5-s-Stichproben und
enthält den gesamten Container einschließlich Diagnose-Kindprozess; Hardwarewerte des
Hostsystems und die tatsächlichen Ergebnisse werden nach dem finalen Lauf ergänzt.
Tatsächliche `JOB_STARTED`-/Endereignisse werden per Event-ID und Versuch
verbunden; nur überlappende abgeschlossene Slow-/Render-Ausführungen innerhalb
der aktiven Lastphase zählen. Queue-Claims allein reichen nicht. Jede stabile
Phase verlangt bekannte Messwerte für alle sechs Queues und erfolgreiche Touches.
Reproduktion und Release-Checkliste: `docs/operations/FOUNDATION_RELEASE.md`.

## Prüfmatrix und aktueller Nachweisstatus

| Gate | Nachweis | Status |
|---|---|---|
| Kombinierte Last und Ausfälle | `backend/test/foundation-load.cjs` | bestanden, Run `384725cad864707c` |
| Backup/Restore und Upgrade mit aktivem Zustand | `backend/test/foundation-backup-restore.cjs` | bestanden |
| Alle Contract-/Backend-/Frontendtests, Typechecks, Builds | vollständiger lokaler CI-Runner | 43/43 Gates bestanden |
| Alle realen SQLite-/Redis-Integrationen | dynamische Liste aller `.integration.ts` | bestanden |
| Docker-Startup, WS, Isolation, Auth, Federation, Remotes, Operations | vorhandene Containerfixtures, finales Image | bestanden |
| §9-Altlasten, gemeinsame Fachberechnung | DaysUntil-Kern und Regressionstests | geschlossen |
| Browser-Fachregression nach DaysUntil-Korrektur | tatsächliche Browserprüfung | bestanden |
| Hardware | ESP32/Controller, Pi/Kiosk, TRMNL-BYOD/Refresh | mangels Geräten offen |

## Zuordnung zu Architekturabschnitt 12

Die Paketbelege sind abgeschlossene frühere Prüfungen. Der maßgebliche aktuelle
WP-29-Lauf und seine Messwerte stehen im Abschlussnachweis unten und schließen
die Softwarezeilen dieser Matrix; Hardware bleibt separat offen.

| Erfolgskriterium | Implementierung und vorhandene Nachweise | Abschließender WP-29-Nachweis |
|---|---|---|
| Drei Geräteklassen ohne Dashboard-Sonderlogik | Contracts-Fixtures, ProfileResolver und TransportAdapterRegistry; WP-04/06/13 | Vertrags-/Registrytests; Hardware separat offen |
| Batterie-Pull, Fast-Pull und WS erhalten denselben Zustand | Publication-/Rendercache-Persistenz und Container-Smoke; WP-14/15/17/19 | Aktuelle Revision und profilabhängiger Artefakthash auf allen Lastclients |
| 20 Displays ohne identische Mehrfachrender | `render-cache.integration.ts`, 20 Bindungen/ein Job, zwei Prozesse; WP-19 | 20 dauerhafte Browser, drei Profile, ein gemeinsamer Browser-Render-Key |
| Langsame Jobs blockieren API/Display nicht | Getrennte API/Worker, Source-Budgets/Timeouts, Isolation; WP-20/21/22/28 | Tatsächliche Slow-/Render-Überlappung und unveränderte Latenzgrenzen |
| Pairing mit URL und Einmalcode | Re-Pairing-UI, TTL/Hash/Consume/Rate-Limits; WP-08 bis WP-10/15 | Auth-/Enrollment-Integration und Browserregression |
| Widerrufbare getrennte Minimalcredentials | Adminsession/CSRF, Deviceauth, Sharecredential, verschlüsselte Source-/Remote-Secrets; WP-11/12/21/23/26/27 | Vollständige Auth-/Replay-/SSRF-/Redaction-Suite |
| Timer und ausstehende Aktionen überleben Neustarts | Timer-, Interaction-, Outbox-/Redis-Integrationen; WP-16/18/23–25 | Drei Worker-Recoveries, Redis-Ausfall und vollständiger Restore |
| Versionierte cachebare Publications und ETags | Immutable Publications, Auth vor 304, atomarer Cache; WP-17/19 | Authentifizierte Artefakte/304 unter Last, nach Ausfällen und Restore |
| Remote-Abonnement ohne direkten Gerätezugang | Zwei TLS-Remotes, Homecache, Scope-/Revocationprüfung; WP-26/27 | Beide Remotes gleichzeitig offline, unveränderte lokale Displaybytes |
| Datenbankänderungen nur über getestete Migrationen | Baseline-Adoption, Forward-Migrationen, Fail-closed-Startup; WP-05 bis WP-28 | Alle Migrationstests und tatsächlicher Vorgängerschema-Restore/Upgrade |
| Gemeinsame Browser-/Backendverträge und Fachlogik | Gemeinsame Contracts, DaysUntil-Kern und dünne Reexports | Alle Types/Contracts, DST-Grenzfälle, tatsächlicher Browser |
| Keine offenen §9-P1/P2 | Paketabgleich unten; DaysUntil-Korrektur im aktuellen Arbeitsbaum | Abschließende Regression/Review und dokumentierte Befundentscheidung |

### Abschnitt-9-Abgleich

| Ursprünglicher Befund | Zuständiger belegter Pfad / Paket |
|---|---|
| Neuer Pairing-Link ignoriert altes Credential | Explizites Bootstrap zuerst in `WebDisplay.tsx`, atomare Enrollment-Rotation; WP-08–10/15 |
| Timer/Zustellung nur im RAM | Persistierte Playback-/Timer-Anker, Outbox-/Consumerleases; WP-16/18/20/25. TCP-Sockets bleiben prozesslokal und rekonstruieren beim Reconnect. |
| Presentation-GET ändert Revision | `publication-persistence.integration.ts`, `playback.integration.ts`, `render-cache.integration.ts`: Read-only-Fachzustand; WP-14/17–19 |
| Unbehandelte Dispatcher-Promises | Abgewartete Verarbeitung, Fencing, Retrybudgets und Deadletters; `outbox.integration.ts`/Redis, WP-16/20 |
| Doppelte Screen-Design-Pushes | Ein logisches Outboxereignis mit deduplizierter Gerätemenge; WP-16/19. At-least-once bleibt ausdrücklich der Transportvertrag. |
| Ungesteuertes `db push` | Geprüfte Baseline und versionierte Forward-Migrationen, harter Startup-Abbruch; WP-05 ff. |
| Fest verdrahtete DriverRegistry | Discovery registrierter TransportAdapter-/ProfileResolver-/Policy-Provider; Dummyadaptertest, WP-13 |
| Widersprüchliche Capabilities | Ein Profil plus validierter expliziter Override und getrennte Energie-/DeliveryPolicy; WP-06/13 |
| Doppelte DaysUntil-Berechnung | Gemeinsamer begrenzter Contracts-Kern, dünne Reexports und bestandene Paritäts-/Browserregression; F29-01/02 geschlossen |
| Default-Secrets und ungetrennte Credentials | Externer zufälliger Schlüssel, gehashte Credentials, sichere Sessions, CSRF und zentrale Redaction; WP-11/12/15/26/28 |
| Plugincode im Serverprozess | QuickJS-WASM im frischen Kindprozess ohne Hostbindings/Secrets, harte CPU-/Wall-/IPC-/Linearspeichergrenzen; WP-21/22, ADR-010 |
| Verschachtelte Repository-Zuständigkeit | `REPOSITORY_BASELINE.md`: nur `inker` ist Produkt-/Commitziel, Referenzcheckout bleibt separat; WP-00/01 |

Die Isolation ist keine OS-Sandbox und erlaubt keine nativen oder frei vernetzten
Plugins. Echte Instanzschlüsselrotation/Re-Encryption ist nur durch Key-ID/Version
vorbereitet, nicht implementiert; das ist von geprüfter Credential-Rotation zu
unterscheiden. LAN-HTTP, Firmwaredetails und physische Refreshintervalle behalten
ihre ausdrücklich offenen ADR-/Hardwaregrenzen.

## Befunde

| ID | Priorität | Befund | Folgeschritt |
|---|---|---|---|
| F29-01 | P1 | DaysUntil kann mit sehr großer endlicher Dauer synchron proportional zur Tageszahl iterieren. | Geschlossen: begrenzte gemeinsame Arithmetik, adversariale Tests, finaler Build und Browserregression bestanden. |
| F29-02 | P2 | DaysUntil-Berechnung liegt in Frontend und Backend doppelt vor (§9/§12). | Geschlossen: Contracts-Kern, dünne Reexports und Paritätsprüfung bestanden. |
| F28-01 | P2 | Einmalige Operations-HTTP-Antwort bei Worker-Recovery, damaliger Status unbekannt; zwei Wiederholungen grün. | Geschlossen: Session-Touch-Fence und drei reale Recoveryzyklen im Lastlauf bestanden. |
| F29-03 | P1 | Restaurierter repräsentativer Datensatz: Init/Migration/Seed erfolgreich, API startet zunächst nicht. Vorstartdiagnose erfasst drei Prisma-Timeouts `P1008`, danach Readiness. | Geschlossen: unnötige Startupwrites entfernt; vollständiges Restore-/Upgrade-Gate auf finalem Image bestanden. |
| F29-04 | P1 | Per Base64url erzeugte Geräte-IDs können mit `_` oder `-` beginnen; Interaction-/Timer-Verträge wiesen diese eigenen IDs ab. Im behaltenen Restore-Quelldatensatz ist `timer.create` deshalb mit HTTP 400 gescheitert. | Geschlossen: gemeinsamer begrenzter Geräte-ID-Validator; Contracts, Timer, Interaktionen und finales Docker-Gate bestanden. |
| F29-05 | P1 | Zwölf parallele budgetierte Source-Claims über zwei Prisma-Clients erzeugen auf demselben Client mehrere `BEGIN IMMEDIATE`-Transaktionen; SQLite antwortet mit P1008, bevor die SQL-Budgetprüfung entscheidet. | Geschlossen: produktive `sourceWrite`-Serialisierung/Retry und unveränderter Konkurrenztest im vollständigen Lauf bestanden. |
| HOST-01 | P2 | Bekannter Windows-Bun-TLS-Toolchainfehler; Linux-Produktion bereits in WP-27 geprüft. | Finale Linux-/Containerprüfungen, separater reproduzierbarer Host-Toolchain-Folgecheck bei Runtimeupdate. |
| HOST-02 | P2 | Erneutes Bun-1.3.14-Installieren in einem bereits vorbereiteten Workspace entfernt `dist/index.d.ts` und `index.cjs` aus beiden kopierten `file:../contracts`-Paketen; Originalartefakte bleiben erhalten. | Frische isolierte CI-Arbeitskopie ohne Vorinstallation; alle Gates unverändert. Minimalreproduktion und Idempotenzprüfung bei nächstem Bun-Update, kein TypeScript-Alias oder Gate-Ausschluss. |

F29-03 ist intermittierend: Ein späterer identischer Restore-Diagnosepfad und
anschließender API-Neustart bestanden ohne Produktionsänderung. Das erklärt die
früheren Fehler nicht und schließt den Befund nicht. Die Vorstartdiagnose erfasste
`PrismaClientKnownRequestError`/`P1008` dreimal. Nur Prisma-interne Stackpositionen
waren für die ursprünglichen Fehler vorhanden. Eine getrennte Query-Probe belegt
die unten beschriebene vermeidbare Writersperre; sie identifiziert nicht
rückwirkend jede ursprüngliche Throw-Stelle. Keine Fehlermeldungen oder Secretwerte
werden ausgegeben.

Der dritte Diagnoseversuch erreichte den Restore noch nicht: Der erste Timer-
Create scheiterte an `$.deviceId`, nicht an Publish oder an einem Datenbanktimeout.
Sein eigener Quelldatensatz blieb für die unten dokumentierte gezielte Diagnose
erhalten und wurde danach kontrolliert entfernt. Keine Geräte-ID wurde
nachträglich umgeschrieben und kein Neuseed ersetzte den Fehlernachweis.
F29-04 erklärt diesen HTTP-400-Fehler, nicht den separaten Startfehler F29-03.

Eine unabhängige reale SQLite-Probe belegt eine vermeidbare Sperrquelle:
`Plugin.upsert(update: {})` verwendet auch bei vorhandener Zeile `BEGIN IMMEDIATE`,
während `findUnique` nur liest. Unter eigenem gehaltenem Writer scheitert das
leere Upsert mit P1008. Die Probe hat Exit 0; ein 200-ms-Busy-Timeout begrenzt
ausschließlich ihre isolierte Testdatenbank, der Produktwert bleibt 5000 ms.
Vorhandene Plugin-/Identitätsseeds lesen nun zuerst; DaysUntil aktualisiert nur
veränderte verwaltete Felder. Notwendige Initialisierung bei fehlenden Daten und
Consumerregistrierung bleiben bestehen. Dies belegt die Korrektur unnötiger
Startupwrites, nicht rückwirkend die konkrete Operation jedes alten Startfehlers.
Die vollständige Restore-/Recovery-Prüfung auf dem neuen Image bleibt erforderlich.

Gezielter Docker-Nachweis auf dem unveränderten Image `8e1d51fb89dd962900aba9a1d3cab077101d8a00ff6e80092096092225694c4b`:
Der erhaltene Fehlerdatensatz behält seine ursprüngliche `_`-Geräte-ID, erlaubt
Timeranlage und Feed, überlebt API-/Workerrestart und beantwortet das identische
Event mit Duplicate bei genau einem Timer. Secret-Audit und striktes Startup-
Loggate sind grün; eigener Cleanup vollständig. Dies ist kein vollständiger
Dreivolumen-Restore-/Upgrade-Nachweis. Log `goal-wp29-retained-production-recovery.log`.
Ein vorheriger HTTP-401-Abbruch war ein Fixturefehler: Die normale 15-minütige
Sessionrotation wurde nicht als Set-Cookie übernommen. Client-Cookiejar korrigiert,
Recovery ausdrücklich mit neuem Login; keine Produktions-TTL oder Authprüfung geändert.

Der Linux-Harness wurde gebaut. Docker-Desktop-Hostnetwork erreichte die
publizierten Loopback-Ports nicht; die begrenzte Nonce-Probe über einen reinen
TCP-Relay auf `host.docker.internal` bestand. Dieser zusätzliche Netzwerkweg
ändert keine Test-URLs, TLS-Prüfungen oder Geräteprotokolle und bleibt in
Latenzmessungen enthalten. Der vollständige Lauf ist weiterhin offen. Der frische
Linux-Lauf bestand Prepare, alle statischen Gates, den Produktionsbuild und die
ersten 14 Integrationssuiten. `render-cache.integration.ts` brach mit 10 bestandenen
und zwei fehlgeschlagenen Tests ab: Die Node-Renderfixture vermischte Nest-Logs mit
ihrer JSON-IPC-Antwort. Ausschließlich Fixturelogs gehen nun nach stderr; die
Integrationsassertionen und das Produktionslogging bleiben unverändert. Die
isolierte vollständige Linux-Wiederholung besteht mit 12 Tests / 283 Assertions.
Der Fehlerlauf `.tmp/goal-wp29-linux-ci-clean-full.log` bleibt als solcher erhalten.
Der nächste Gesamtlauf übernahm außerdem die vervollständigte Session-Cookiejar,
striktes Startup-Loggate und den initialen Timerfeed beim WS-Reconnect. Diese
Fixturekorrekturen ersetzen keinen bestandenen kombinierten Lauf. Er bestand die
statischen Gates und 15 Integrationsdateien, stoppte aber bei Sources mit 27/36:
Acht Assertions erwarteten noch die vor WP-28 verwendete Fehlerkorrelation; ein
neunter Fehler ist F29-05. Last, Restore und Browser wurden nicht erreicht. Die
vollständige Rohdiagnose steht in `.tmp/goal-wp29-sources-linux-diagnostic.log`.

### Präzisierung der gemeinsamen Datumsberechnung

Normale Wochentags-, Rundungs- und Zieltagsemantik bleibt erhalten. Die neue
zivile Datumsarithmetik übernimmt zwei historische Zeitzonenfehler bewusst nicht:
Eine am DST-Übergang fehlende Mitternachtsstunde wird nicht auf spätere Zieltage
verschleppt; ein vollständig übersprungenes lokales Zieldatum wird abgewiesen.
Kalendertage über eine Datumsgrenze zählen zivile Datumsnummern statt erfolgreiche
`setDate`-Iterationen. Gezielt geprüft werden São Paulo 2018 und Apia 2011;
keine pauschale bitgleiche Parität für diese alten Randfehler wird behauptet.

## Maßgeblicher Abschlussnachweis

Der frische Linux-Lauf `inker-wp29-ci-release-hostnet` endete auf dem eingefrorenen
Arbeitsstand mit **43 von 43 bestandenen Gates**. Der Produktionskandidat ist
`sha256:9b57638e189b3d9f5c34f1ba51775aa341c189dab04d2a76e3e7498ee81117b6`,
der Harness
`sha256:9dcec5a7ab8f0b477819457fc55a60f185da3bf75e2af5f155e4a2d7f41f4424`.
Der lokale, ignorierte Gatebeleg liegt unter
`.tmp/goal-wp29-linux-ci-release-hostnet.log`; er enthält 43 abgeschlossene
`passed`-Ergebnisse und keine übersprungenen Gates. Zu den Zählwerten gehören
Contracts **95/2244**, Backend-Units **1160/6987**, Outbox **20/112**, Render
**13/295**, Sources **36/585** sowie alle Types, Builds und Frontendtests.

Der finale Lastlauf `384725cad864707c` verwendete 2 CPU und 1536 MiB. Seine
maßgeblichen Messwerte bleiben deutlich innerhalb der vorab gesetzten Grenzen:

| Phase | Display p95 / max | Control p95 / max | höchstes fälliges Queue-Alter | Speicherpeak |
|---|---:|---:|---:|---:|
| stabile Kombinationslast, 70,0 s | 41,2 / 66,4 ms | 85,1 / 125,9 ms | 0 s | 468.885.504 B |
| kombinierte Ausfälle, 90,0 s | 55,6 / 150,0 ms | 80,6 / 85,0 ms | 4,94 s | 468.885.504 B |
| Stabilität nach Recovery, 35,0 s | 22,3 / 44,0 ms | 80,2 / 80,2 ms | 0 s | 468.885.504 B |

Alle 20 dauerhaften Browser-WebSockets, Touch sowie Batterie-/Fast-Pull
konvergierten. 23 Clients über drei Profile erzeugten drei Renderrequests; die 20
Browser teilten genau einen Render-Key. Die drei Worker-Recoveries dauerten
4,23/4,53/4,57 s, Redis 3,69 s. Zwei langsame Source-Ausführungen überlappten
tatsächlich mit drei Renderausführungen; erwartete Source-Deadletters behielten
ihre letzten gültigen Daten. Fünf WebSockets verbanden sich neu und behielten drei
abgeschlossene Timer. Es gab keine WebSocketfehler, keinen OOM-Kill und der eigene
Cleanup bestand.

Der anschließende echte Dreivolumen-Test bestand vollständige gestoppte Archive,
exakte Hashes und Rechte, Restore in leere Volumes, Vorgängerschema-Import mit
unverändert wiederhergestellten Triggern, Forward-Migration, aktive Timer,
Publications, Sources, Sessions, widerrufene/aktuelle Credentials, Einmalcode und
fehlenden Instanzschlüssel. Alle eigenen Ressourcen wurden entfernt.

Die Browserabnahme lief gegen denselben Image-Digest: Administratorlogin,
Operations-Diagnostik und Queue-/Cache-/Source-/Deviceansichten ohne Console-Warnung
oder -Fehler, sichtbares Event-Progress-Widget im Designer sowie echte Kopplung des
isolierten Web-Displays. Das veröffentlichte Artefakt lud vollständig mit
1920×1080 Pixeln. Tabs und Fixture wurden danach entfernt.

F29-01 bis F29-05 und F28-01 sind durch die dokumentierten Korrekturen und den
vollständigen Abschlusslauf geschlossen. Die früheren Fehlerläufe bleiben als
Historie erhalten und werden nicht nachträglich als bestanden umgedeutet. Als
nicht blockierende P2-Schuld bleibt: Die abschließende negative
Publication-Cleanup-Abfrage kann bei sehr vielen geschützten alten Revisionen
mehr Kandidaten scannen, obwohl Ausgabe und Löschung begrenzt sind. Ein späterer
Folgeschritt soll `EXPLAIN` mit großem geschütztem Bestand prüfen und bei Bedarf
eine materialisierte Eligibility/geeignete Indexstrategie ergänzen. Korrektheit,
Rollback-Schutz und Löschgrenze sind davon nicht betroffen. HOST-01 und HOST-02
bleiben Host-Toolchain-Folgeprüfungen beim nächsten Bun-/Runtimeupdate.

## Freigabeentscheidung

Die **Software-Foundation bis einschließlich WP-29 ist freigegeben**. Sämtliche
Kriterien aus Abschnitt 12 sind durch den vollständigen aktuellen Lauf, echte
Last-/Ausfallpfade, Securityregression, Backup/Restore/Upgrade und Browserprüfung
belegt. Die Freigabe ist keine Deployment-, Merge- oder Hardwarefreigabe.

Nicht ausführbar mangels physischer Geräte bleiben ESP32-S3/Controller und
Netzwerkstack, Raspberry-Pi-/Kioskbetrieb, TRMNL-BYOD-Refreshgrenzen sowie reale
Energie-, Displaylebensdauer- und Funkmessungen. Diese Punkte bleiben ausdrücklich
offen und ändern den abgeschlossenen Software-Foundation-Scope nicht.
