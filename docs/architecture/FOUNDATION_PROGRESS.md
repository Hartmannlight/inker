# Foundation-Goal – Fortsetzungsstand

Stand: 2026-08-29. Verbindlicher Auftrag: WP-00 bis WP-29 und Abschnitt 12 des
Architekturplans vollständig verifizieren. Paketweise fortsetzen, lokale Commits
nach Abnahme; Push nur mit ausdrücklicher Freigabe, kein Merge oder Deployment.
Hardwaremessungen offen ausweisen.

## Abschlussstand (maßgeblich)

- WP-00 bis WP-29 und die Softwarekriterien aus Architekturabschnitt 12 sind am
  2026-08-29 abgenommen. Physische Hardwareprüfungen bleiben offen.
- Frischer finaler Linuxlauf: **43/43 Gates bestanden**, Container
  `inker-wp29-ci-release-hostnet`, Beleg
  `.tmp/goal-wp29-linux-ci-release-hostnet.log`. Kandidat
  `sha256:9b57638e189b3d9f5c34f1ba51775aa341c189dab04d2a76e3e7498ee81117b6`,
  Harness
  `sha256:9dcec5a7ab8f0b477819457fc55a60f185da3bf75e2af5f155e4a2d7f41f4424`.
- Lastlauf `384725cad864707c`: 20 dauerhafte Browser-WebSockets plus Touch,
  Batterie-/Fast-Pull und zwei Remotes; Display-p95 höchstens 55,6 ms, Maximum
  150,0 ms; Queue-Alter höchstens 4,94 s; Speicherpeak 468.885.504 B. Drei
  Worker-Recoveries höchstens 4,57 s, Redis 3,69 s; Renderdeduplizierung und
  Slow-Source-/Render-Überlappung belegt, Cleanup bestanden.
- Vollständiger gestoppter Dreivolumen-Backup-/Restore-/Vorgängerupgrade-Test
  bestanden. Offline-Import sichert und restauriert die echten Vorgängertrigger;
  Korrelations-IDs, Timer, Outbox, Publications, Sources, Sessions und Credentials
  bleiben erhalten. Fehlender Instanzschlüssel wird fail-closed abgewiesen.
- Browserprüfung gegen denselben Digest: Login, Operations ohne Consolefehler,
  Event-Progress-Katalog und gekoppeltes Display mit vollständig geladenem
  1920×1080-Artefakt. Eigene Tabs, Container, Volumes und Fixturezustände entfernt.
- F29-01 bis F29-05 und F28-01 geschlossen. Nicht blockierend verbleiben der
  dokumentierte Publication-Cleanup-Scan-Folgeschritt sowie HOST-01/HOST-02.
  Kein offener P0/P1; alle P2 besitzen einen Folgeschritt.
- Der Nutzer hat den Push des abgenommenen Branches an Hartmannlight ausdrücklich
  freigegeben. Merge und Deployment bleiben außerhalb des Auftrags.

## Ausgangsstand

- Repository: `StatusPanel/inker`, Branch `codex/device-platform-spike`,
  HEAD `096218c` (WP-18). Arbeitsbaum zu Beginn vollständig sauber.
- Keine zusätzlichen `AGENTS.md` im Repository oder den geprüften Elternpfaden.
- Die im Auftrag mit Escape genannten Dokumente heißen tatsächlich
  `docs/architecture/WORK_PACKAGES.md` und `ARCHITECTURE_PLAN.md`.
- Bun 1.3.14: `.tmp/bun-1.3.14/bun-windows-x64/bun.exe`; nicht im Host-PATH.
  Host-Node 24.14.0 weicht von Node 22.22.3 im Produktionsimage ab.
  Docker Client/Engine 28.5.1 erreichbar nach Sandbox-Freigabe.
- Vorhandene PrintHub-/Zebra-Container sind fremd und bleiben unberührt.
- Frische Baseline: Backend `bun test ./src`: 565 bestanden, 0 Fehler;
  Frontend `bun run test`: 58 bestanden, 0 Fehler. Logs `goal-baseline-*.log`
  sind lokale, ignorierte Prüfartefakte.

## Aktuell

- Sechster vollständiger Linuxlauf BEENDET (Exit 1): Root-Execsession **38148**, eigener
  Container `inker-wp29-ci-b53e61bf8a3344d0a0bca37938bdcd06`, Log
  `.tmp/goal-wp29-linux-ci-security-full.log`, State-Metadaten daneben. Frischer
  gehärteter Harness
  `sha256:015fc1d9c3ac52238afacedbd0a0b098b004779010cf2696f17d2abee10e7aa1`
  wurde mit Exit 0 gebaut; Buildbeleg
  `.tmp/goal-wp29-linux-ci-build-security.log`. Alle 43 Gates laufen neu ab
  Prepare. Sämtliche statischen Gates, alle 19 Integrationssuiten, Worker-
  Startup, WebSocket- und Föderations-Container-Smoke sind grün. Der nachfolgende
  Remote-Dreiserver-Smoke scheiterte nach 90,3 s; Operations, Last und Restore
  wurden nicht erreicht. Exakter Kandidat
  `sha256:ed23a79c5d9cd9ad07545b9b69da0bbd82223352281741f1b9446312cc1bf45c`.
  Isolierte Rohdiagnose auf genau diesem Image läuft; keine Abnahme und keine
  Fixbehauptung vor reproduzierter Ursache.
- Isolierter Remote-Dreiserver-Smoke auf demselben Image anschließend Exit 0 in
  155,2 s: Restart-Recovery 29,3 s, Conditional-304 A=2/B=3, Secretaudit und
  Cleanup grün (`.tmp/goal-wp29-remote-container-diagnostic.log`). Der frühere
  90-s-Fehler bleibt nicht reproduziert; kein Fix wird erfunden.
- Der erstmals erreichte gezielte Operations-Smoke reproduzierte dagegen F28-01:
  Exit 1 in Stage `worker restart, persisted correlation and actual WebSocket
  send`; `/api/operations` HTTP 500 nach 5009 ms, gleichzeitig feste Codes
  `OUTBOX_POLL_FAILED`/`JOB_FAILED`, eigener Cleanup vollständig. Der Admin-Guard
  schrieb bisher bei jeder authentifizierten Diagnoseabfrage synchron
  `lastSeenAt`. Als engste belastbare Ursache wird diese 5-s-SQLite-Writekollision
  behandelt: gewöhnliche Session-Touches sind nun mit atomarem `lastSeenAt`-
  Fence auf 60 s gedrosselt, Rotation/Idle-/Absolute-TTL unverändert. Unit 5/18
  grün; vollständiger Operations-Logaudit statt `--tail 10000`. Neues Produkt-
  Testimage `sha256:2e015acf0c925138f06a46f6e382a82dc404fae2e59490a4b6441d547ac24064`;
  drei echte Recovery-Wiederholungen stehen vor dem nächsten Gesamtlauf an.
- Fünfter vollständiger Linuxlauf KONTROLLIERT ABGEBROCHEN: Root-Execsession **60584**, eigener
  Container `inker-wp29-ci-3bfd82ad1f7e460b990889a8081ada69`, Log
  `.tmp/goal-wp29-linux-ci-retry-full.log`, State-Metadaten daneben. Harness
  unverändert `sha256:6a035956cda8a96a8dd515f9d9c2159668b547703416d56e66ec2ca98f1c1fde`;
  Prepare, statische Gates und die bis zum Abbruch beendeten Integrationen waren
  grün. Abbruchgrund war ein unabhängiges Reviewfinding vor dem noch nicht
  erreichten Restoregate, nicht ein Testfehler: der Missing-Secret-Negativtest
  akzeptierte jeden Exit != 0 und der Audit las nur die letzten 10.000 Logzeilen.
  Der eigene Container wurde nach Labelprüfung gestoppt; keine Resultate dieses
  unvollständigen Laufs werden als Endabnahme gewertet.
- Reviewhardening umgesetzt: Missing-Secret akzeptiert ausschließlich Exit 1 mit
  der exakten festen Refusal-Ursache und ohne erzeugten Schlüssel; der Restore-
  Audit liest den vollständigen, auf 16 MiB begrenzten Logstrom fail-closed.
  Der CI-Runner verwendet eine Toolchain-/Proxy-Allowlist statt der gesamten
  Hostumgebung. Die drei Third-Party-Actions sind auf die am 2026-08-29 aus den
  offiziellen Repositories aufgelösten v4/v4/v2-Commit-SHAs gepinnt. Gezielte
  Fixturetests 7/7, Runner-Sicherheitstests 10/74, Syntax und Diffcheck grün.
  Frischer Harnessbuild und vollständiger sechster Lauf folgen. Keine Freigabe
  vor Exit 0, Last-/Restore-Nachweisen, Browserprüfung und Cleanup.
- Vierter vollständiger Linuxlauf BEENDET (Exit 1): eigener Container
  `inker-wp29-ci-73e40e0ea5764c6a937a5101011bf3d1`, Log
  `.tmp/goal-wp29-linux-ci-final-full.log` und sichere `-state.json`-Metadaten.
  Sämtliche statischen Gates, alle 19 Integrationssuiten, Worker-Startup und der
  161-sekündige WebSocket-Container-Smoke sind grün. Der anschließende
  Föderations-Container-Smoke meldete nach 20,7 s nur den begrenzten Gatefehler;
  Last und Restore wurden deshalb nicht erreicht. Keine Abnahme.
- Exakter isolierter Wiederholungslauf des vollständigen Föderations-Smokes auf
  demselben unveränderlichen Produktionskandidaten
  `sha256:c783190a1849a7542d5936ac2fad3306cce315699c8db74cc67eb3fbf8d5b8a1`
  ist Exit 0: CA, HTTP-Spoof-Denial, Scope/Expiry/Revocation, ETags/Hashes,
  Read-only, Retention, Restart-Identität, Secretaudit und Cleanup bestanden.
  Beleg `.tmp/goal-wp29-federation-container-diagnostic.log`. Der CI-Fehler ist
  nicht reproduziert; keine Ursache oder Behebung wird behauptet.
- Ein fünfter vollständiger 43-Gate-Lauf wird mit neuer Evidenzkennung von Prepare
  an wiederholt. Eine Freigabe wird erst nach vollständigem Exit 0, Lastreport,
  Restore und anschließender Browserprüfung dokumentiert. Unabhängiges Read-only-
  Review aller WP-29-Produktänderungen findet keine neuen konkreten P0/P1/P2;
  kein Review ersetzt die Runtimegates.
- F29-05 gezielt korrigiert: budgetierte Source-Claims nutzen nun die bestehende
  `sourceWrite`-Serialisierung/Retry je Prisma-Client; SQL-Budgets und der zwölf-
  parallele Konkurrenztest bleiben unverändert. Acht WP-28-Korrelationsassertionen
  erwarten jetzt persistierte UUID plus Event-ID. Linux-Source-Suite **36/585**,
  Konkurrenzfall 3,00 s, Produkt-/Test-Typecheck und Lint grün. Kein Commit.
- Dritter vollständiger Linuxlauf BEENDET (Exit 1): frühere Root-Execsession **63267**, eigener
  Container `inker-wp29-ci-7e01ad68a6e34db185ec2a2f02212902`, Log
  `.tmp/goal-wp29-linux-ci-reviewed-full.log`, sichere Metadaten daneben mit
  Suffix `-state.json`. Frischer Harnessbuild Exit 0 in
  `goal-wp29-linux-ci-build-reviewed.log`. Alle 43 Gates unverändert erforderlich;
  kein Gesamtabschluss bis bestätigtem Exit und anschließender Browserprüfung.
  Alle Agentdateien sind eingefroren; für die laufende Source-Diagnose besitzt
  ausschließlich `isolation_review` das Dockerfenster.
  Statische Gates jetzt vollständig grün: Contracts **95/2244**, Backend
  **1134/6923**, alle Types und Builds, Frontendtests jeweils Exit 0.
  Neuer unveränderlicher Produktionskandidat:
  `sha256:c8eea25d5ed80bb1aa49842c3e473c78d547e42fec5bb6378dc89bdde8455784`.
  15 Integrationsdateien einschließlich der korrigierten Render-Cache-Suite sind
  grün. `sources.integration.ts` stoppte danach mit **27 pass / 9 fail / 510
  Assertions**. Last, Restore und Browser wurden nicht erreicht. Der Fehlerlauf
  bleibt unter `goal-wp29-linux-ci-reviewed-full.log` erhalten; eigener Container
  bleibt gestoppt. `isolation_review` reproduziert die Suite im frischen Linux-
  Harness mit Rohdiagnostik, ohne Produkt- oder Gateänderung. Keine Abnahme.
- Render-IPC-Korrektur gezielt Linux **12/283** grün, Assertionen unverändert.
  Die Lastfixture übernimmt nun Rollen-Cookiejar (auch expliziter Cookie beim
  CSRF-Negativtest), striktes Startup-Loggate, getrennte initiale Timerfeed-Belege
  auf fünf Reconnects und reguläre Acknowledgements erst nach 21 WS-Completion-
  Beobachtungen. Keine Quota/Timeouts erhöht. Fixturetests Node/Bun **14/14**,
  Syntax/ESLint grün; konkrete Bun-`node:test.mock`-Inkompatibilität wurde im
  Test durch lokal injizierte Stubs gelöst, nicht durch Testausschluss.
- Vorheriger WP-29-Lauf: `.tmp/goal-wp29-linux-ci-clean-full.log` beendet mit Exit 1.
  Frischer Linux-Harness ohne Vorinstallation; Prepare, sämtliche statischen Gates,
  Produktionsbuild und die ersten 14 Integrationsdateien sind grün. Die nächste
  Suite `render-cache.integration.ts` meldet 10 bestanden / 2 fehlgeschlagen / 274
  Assertions. Kein Gesamtabschluss, keine Laufzeitprüfung übersprungen.
  `isolation_review` reproduziert diese Suite isoliert; Root integriert die Ursache.
  Der eigene CI-Container `inker-wp29-ci-764985a978e24ff8914695acd524cb66` bleibt
  gestoppt erhalten. Session 57407 ist beendet. Last/Restore/Browser noch offen.
  Neues CI-Produktionsimage:
  `sha256:fd67742c709053cf5d2f37981af9402d2ca8813d30824e19a27faf6dbff9a605`.
- WP-00 bis WP-28 abgenommen. WP-11/WP-14 wurden mit ihren Handoffs abgeglichen;
  keine erneute Implementierung. Hardwareprüfungen bleiben ausdrücklich offen.
- Branch `codex/device-platform-spike`. WP-27 ist separat in `456a343` committed,
  aus dem isoliert geprüften Snapshot mit exakt 46 Dateien. Index-/Blobvergleich
  und Secret-Dateiprüfung grün; WP-28 blieb unberührt im Arbeitsbaum.
- Nur der frühere WP-26-Commit `711164f` wurde auf ausdrücklichen Einzelauftrag
  an Hartmannlight/inker gepusht. Kein weiterer Push, Merge oder Deployment.
- Nutzerfreigabe für die Remote-SQLite-Testdatei umgesetzt. Alle sechs früheren
  Nachweislücken geschlossen: Root WP-27-Linux 18/228 und WP-28-Linux 18/228,
  Agent zusätzlich Linux/Windows. Typecheck, ESLint und Fixturetests 3/3 grün.
  Isolierte abhängige Integrationen 81/2651; keine Produktionsfehler gefunden.
- WP-28: Linux-Backend 1105/6806, Operations/Correlation 19/240, Gateway/Telemetrie
  28/139, Frontend 121, Contracts 85/1559, Migrationen 14/250; jeweils Exit 0.
  Produktionstypecheck, expliziter Testtypecheck, ESLint und Produktionsbuild grün.
  Image `aa35f698f4d1c4f4f8e4431c7b1ab966ec92d7c19459c4127a4fd04c65ed9e6c`.
- Reale Docker-/Browserausfälle, Authgrenzen, Slow-Source, Metriken/Logs,
  persistierte Correlation bis WS-Send und Secret-Audit belegt. Root-Smoke:
  `.tmp/goal-wp28-container-root-confirmation.log` (Exit 0). Eigene Testressourcen
  vollständig entfernt. Unabhängiger Abschlussreview ohne neue belegte P0/P1.
- Bekannter P2: einmalige Operations-HTTP-Antwort bei Worker-Recovery,
  anschließend zweimal nicht reproduziert. Ursache unbekannt; nicht als behoben
  behaupten. WP-29 muss wiederholte Recovery unter kombinierter Last prüfen.
- Windows-Bun-TLS ist ein bekannter Host-Toolchain-P2; Linux-Produktion geprüft.
  WP-29 dokumentiert Folgeschritte, Hardwaregrenzen und Abschnitt-9-Abgleich.
- WP-28-Abschluss, Betriebsdokumentation und Architekturstatus sind aktualisiert.
  WP-28 lokal in `99f7747` committed; Arbeitsbaum danach sauber. Testbelege unter
  `.tmp/goal-wp28-*.log`, die Datei
  `goal-wp28-container-final.log` ist ein alter FEHLERlauf, kein Abnahmebeleg.

## Nächste Schritte

1. WP-27 (`456a343`) und WP-28 (`99f7747`) sind getrennt lokal committed.
2. WP-29 läuft: Anforderungen, Architekturabschnitt 12 und Abschnitt 9 gelesen;
   kombinierte Last-/Fault-/Security-/Migration-/Restore-Prüfung in Vorbereitung.
3. Mindestens 20 dauerhafte WS-Displays gemeinsam mit Batterie-/Fast-Pull,
   Touch, langsamen/fehlerhaften Sources und Renderlast tatsächlich betreiben.
4. Nachweise, Grenzwerte, P0/P1/P2 und Betriebs-/Release-Checkliste versionieren.
   Keine Foundation-Freigabe vor erfüllten Gates; physische Hardware offen lassen.

### WP-29 laufend (2026-08-29, nicht abgenommen)

- Root besitzt `backend/test/foundation-load.cjs` und
  `fixtures/foundation-load-runtime.cjs`: 20 Browser-WS + Touch-WS + Batterie-/
  Fast-Pull, vier Slow-/Failure-Sources, drei Renderprofile und zwei TLS-Remotes.
  Wiederverwendung der WP-27-TLS-Fixture: `remote-container-fixture.cjs` ist nun
  ohne Seiteneffekt importierbar; ursprünglicher CLI-Smoke unverändert aufrufbar.
  Fixture-Sicherheitstests 3/3, Syntax und Metrikhelper-Smoke grün.
- Erster Entwicklungslauf auf dem bereits geprüften WP-28-Image gestartet;
  `.tmp/goal-wp29-load-development.log`. Dies ist noch KEIN WP-29-Nachweis und
  muss nach den gezielten Korrekturen auf dem finalen Produktionsimage wiederholt
  werden. Ausschließlich eigene WP-27-TLS-Ressourcen mit zufälliger Run-ID.
- Subagent `source_contract`: ausschließlich neue Backup-/Restorefixture und
  zugehörige Runtime sowie `DATABASE_BACKUP.md`; eigene Ports 18741–18743,
  Label `inker.wp29.backup`, vollständiger Dreivolumensatz, tatsächlicher Appstart.
- Subagent `isolation_review`: CI, vollständiger dynamischer Integrationsrunner,
  Runnerprüfungen und minimale Imageparametrisierung der alten Redisfixture.
  Aktuell 19 `.integration.ts`-Dateien; kein stilles Auslassen mehr zulässig.
- Subagent `wp19_renderer`: §9-Audit fand echte offene DaysUntil-Duplikation
  und unbeschränkte Tagesiteration im synchronen Renderpfad. Gemeinsamer
  Contracts-Kern mit begrenzter Arithmetik und Paritäts-/Grenztests in Arbeit;
  dünne Frontend-/Backend-Reexports. Explizite §9/§12-Korrektur, kein neues Widget.
- Docker-Lastläufe werden serialisiert; keine parallelen Messungen mit Builds
  oder anderen Agenten. Grenzwerte und Prüfmatrix in `FOUNDATION_ACCEPTANCE.md`.

### WP-29 Abschlussprüfung – aktueller Fortsetzungspunkt

- DaysUntil-Kern implementiert: Contracts 91/1948, Backend-Brücke 7/12,
  Frontend 122; Builds/Types/gezieltes Lint und DST-Prüfungen grün. Kein neues Widget.
  Finales Produktionsimage `sha256:78da2522121ffd5175ffc8ec7af0ac067575e50ce94b32c1c4e79f882a9f795b`,
  Build Exit 0 in `.tmp/goal-wp29-build-final.log`. Browserregression noch offen.
- Vollständiger Test-Typecheck korrigiert ohne Ausschlüsse: zehn bestehende
  Testdateien an die tatsächlichen Typen angepasst, 170/537 grün; alle Testtypen
  Exit 0 (`goal-wp29-test-typecheck-final.log`). InteractionService erhält nur
  einen expliziten `AllowedAction[]`-Typ für die bereits leere Liste.
- CI-Runner mit 43 Gates, darunter alle 19 Integrationen und sieben Docker-Gates;
  Runner-Units 9/61. Lokaler Linux-Harness wird gebaut (Node 22.22.3/Bun 1.3.14),
  `.tmp/goal-wp29-linux-ci-build.log`. Dieser Build ist noch kein vollständiger CI-Lauf.
- Lastfixture respektiert echtes Pairing-Limit (erster Entwicklungslauf daran
  abgebrochen, eigene Ressourcen entfernt). Reviewkorrekturen: Live-Sockets nie
  in JSON-State, nachgewiesener einmaliger Artefaktwechsel statt generischem Retry,
  Touch-/Publish-Barriere, WS-ausgelöste Timerfeed-Abrufe, tatsächliche Ausführungs-
  überlappung anhand Worker-Logs, alle sechs Queues, alle App-Zeilenschreibzähler,
  cgroup `memory.peak`. Neue Fixture-Units 3/3 und ESLint grün; Laufzeit noch offen.
- Backup/Restore: Hashes, kompletter Dreivolumensatz, Schlüssel und Dateirechte
  geprüft; Start des restaurierten Datensatzes schlägt mit `API_START_FAILED`
  fehl. Init/Migration/Seed sind vorher erfolgreich; frische Instanz desselben
  Images am selben Port funktioniert. Konkrete Throw-Ursache noch unbekannt,
  kein Fix behauptet. Alle Fehlversuche besitzen erfolgreichen eigenen Cleanup.
  Diagnoseprotokoll `.tmp/goal-wp29-backup-final.log`; Agent `source_contract`
  besitzt Fixture/Runtime/Backup-Doku und bereitet nur ephemere Catchdiagnose vor.
- Docker-Host: Engine 28.5.1, Linux/WSL2 6.6.87.2, zehn CPUs und 27315093504 Bytes
  Docker-VM-RAM. Home-Lastlimit bleibt zwei CPUs/1536 MiB. Keine Hardwarefreigabe.
- Release-/Reproduktionscheckliste: `docs/operations/FOUNDATION_RELEASE.md`.
  Architektur-Checkboxabgleich durch `wp19_renderer`; Root besitzt diesen
  Fortschrittsstand, WORK_PACKAGES und FOUNDATION_ACCEPTANCE. Kein WP-29-Commit.

Aktualisierung vor nächster Integration:

- Contracts jetzt **93/1950**, Typecheck grün. Zwei zusätzliche echte Node-TZ-
  Prozesse prüfen São Paulo/Apia. Die dokumentierte zivile Datumssemantik
  korrigiert dort historische DST-/Datumssprungfehler bewusst. Produktionscode
  seit Image `78da...` unverändert; nur Tests und Dokumentation ergänzt.
- Linux-Harnessbuild beendet mit Exit 0. Hostnetwork-Probe scheitert, aber eng
  begrenzte TCP-Relay-Nonce-Probe besteht. `.tmp/wp29-linux-ci-relay.cjs` hält
  elf feste Loopback-Ports, max. 1024 Sockets, 5-s-Connectdeadline und unveränderte
  Protokollbytes. Fünf TCP-/Half-Close-/Backpressuretests grün, keine Skips.
  Wrapper-/Startplan `.tmp/wp29-ci-relay-alternative.md`. Finalen Harness wegen
  nachträglicher Teständerungen erneut bauen; bisher kein vollständiger CI-Lauf.
- Restore-F29-03 genauer: Vorstartdiagnose2 (`goal-wp29-backup-prestart-probe2.log`)
  erfasste **dreimal P1008 / PrismaClientKnownRequestError**, danach Ready.
  Bisherige Diagnosezustände wurden entfernt; kein Fix behauptet. Agent
  `source_contract` erstellt den dritten/letzten ursprünglichen Diagnoseversuch
  mit erlaubter Prisma-Model-/Action-/Pragma-Projektion und behält jeden Fehler-
  zustand für direkte Integration. Root besitzt Produktionsfix/abschließende Tests.
- Root-Lastfixture zusätzlich: WS-Timerinvalidierung löst tatsächlichen Feed-
  Abruf aus, alle 21 WS müssen den abgeschlossenen Timer dadurch sehen; reine
  spätere Pullchecks reichen nicht. Ein bewiesener Manifestwechsel erlaubt
  genau einen Artefakt-Neuabruf, dessen gesamte Laufzeit mitgemessen wird.
  Keine pauschale 404-Toleranz. Live-Socketfehler sicher im Bericht projiziert.
- Browser neu verbunden und vollständige Anleitung gelesen. Persistente
  Bindungen `agent`/`browser` verfügbar, noch keine Tabs/Navigation. Später nur
  eigene Operationsfixture auf 18731 für echte DaysUntil-/Admin-/Displayprüfung.

Fortsetzung nach drittem Diagnoseversuch:

- Eigene Source-Instanz und State `.tmp/wp29-backup-fixture-state.json` bleiben
  erhalten (nicht ausgeben: Zugangsdaten). Kein neuer Seed. Erster `timer.create`
  scheiterte HTTP 400 an `$.deviceId`: vorhandene 16-stellige Base64url-ID beginnt
  mit `_`; der Vertrag verlangte bisher erstes Zeichen alphanumerisch. Keine
  Timer/Receipts angelegt, Publicationrevision 1; Pending-Publish nicht erreicht.
  F29-04 ist unabhängig von F29-03, kein beobachteter Publish-503-Fehler.
- Root korrigiert ausschließlich Geräte-ID-Validierung in Interaction/Timer mit
  gemeinsamem `contracts/src/device-identifier.ts`: vollständiges Base64url-
  Alphabet plus bestehende Legacy-IDs, 1–128 Zeichen. Sonstige Kennungen bleiben
  unverändert. Deterministische Erzeugung aller 256 ersten Bytewerte und Timer-
  Creator/Acknowledgement geprüft: gesamte Contracts **95/2244**, Types/Build Exit 0.
  Backend-Distkopie aktualisiert und tatsächlich geladener Parser geprüft.
- Agent `isolation_review` ergänzt nur `backend/test/timers.integration.ts` um
  authentifizierte Create/Completion/Ack-Regressionsfälle für beide Präfixe.
  Agent `wp19_renderer` prüft den Vertragsfix lesend. Agent `source_contract`
  behält Dockerfenster und instrumentiert denselben Source-Start, ohne IDänderung
  oder Neuseed, für konkrete Prisma-Operationen. Root besitzt Produktionsfixes.
- Image `78da...` und bestehender Linux-Harness enthalten diesen neuen Fix noch
  nicht; nach Diagnose/Fix und Testfreeze erneut bauen. WP-29 weiter offen.

- Geräte-ID-Fix zusätzlich real geprüft: gesamte Timer-SQLite-Suite **15/282**,
  beide Präfixe in authentifiziertem Create, Worker-Completion und Peer-Ack;
  bestehende Interaktionssuite **16/396**, beide Exit 0. Root prüft den Diff,
  vollständige Testtypen und gezieltes ESLint grün. Read-only-Review findet keine
  weiteren betroffenen Pfade; WebSocket/Artefakt/Timerclient erlauben beide Präfixe.
- Letzter gezielter Start des erhaltenen alten Datensatzes: 4136 ms bis Ready,
  keine Query-/Bootstrapfehler. Vorheriger Neustart sah ein intern gefangenes
  `OTHER/upsert/P1008`, danach Ready; das erklärt frühere ungefangene Fehler nicht.
  Sourcecontainer gestoppt, eigene Volumes/State bleiben erhalten; Dockerfenster
  jetzt Root. Log `goal-wp29-retained-bootstrap-operation.log`.
- Separate reale Prisma-Probe belegt: Plugin.findUnique nur SELECT, leeres
  upsert dagegen BEGIN IMMEDIATE/SELECT/COMMIT. Unter eigenem gehaltenem Writer
  scheitert nur upsert mit P1008; keine Produktdaten. Root entfernt deshalb
  unnötige Startupwrites: vorhandene FederationIdentity/Pluginvorlagen zuerst
  lesen, DaysUntil nur bei geänderten fünf verwalteten Feldern aktualisieren.
  Missing-Seeds und notwendige Consumerregistrierung bleiben unverändert.
  Produktions-Typecheck/ESLint grün; gezielte Agenttests laufen noch. F29-03
  bleibt bis zum vollständigen aktuellen Restore-/Recovery-Gate offen.
- Neues Produktionsimage wird gebaut: `goal-wp29-build-startup-id-fix.log`.
  Noch kein erfolgreicher neuer Build/Runtime-Nachweis behauptet. Agent
  `source_contract` bereitet die eng begrenzte Übernahme des behaltenen eigenen
  Datensatzes auf das neue Image vor, keine umgeschriebene ID und kein Neuseed.

Aktuellster Laufpunkt:

- Produktionsbuild jetzt Exit 0: Image
  `sha256:8e1d51fb89dd962900aba9a1d3cab077101d8a00ff6e80092096092225694c4b`,
  Log `goal-wp29-build-startup-id-fix.log`. Enthält Geräte-ID- und Startupguards.
- Startup-Seed-Suite durch Root wiederholt **12/142**, Federation-SQLite durch
  Agent **16/305**; alle Testtypen einschließlich neuer Widgettemplate-Datei und
  gezieltes ESLint grün. Read-only-Review ohne neue belegte P1/P2. Alle Dateien
  eingefroren. Lastfixture-Units **3/3**, CI-Runner-Units **9/61** erneut Exit 0.
- Linux-Harnessbuild ebenfalls Exit 0, Image `5bdf7a4562c05b3e8298622b74ab9f6b0ff71ec3e75bba258ea9a41764cdd968`,
  Log `goal-wp29-linux-ci-build-current.log`; ABER nachträgliche Backup-Audit-
  Verschärfung fehlt darin noch. Vor Voll-CI erneut bauen, keine Testdatei im
  Container ersetzen. Gesamtlauf bisher nicht gestartet.
- Backup-Audit prüft jetzt zusätzlich API_START_FAILED/WORKER_START_FAILED/P1008:
  späteres Ready darf frühere Startfehler nicht maskieren. Syntax/Lint grün.
- Agent `source_contract` besitzt ab jetzt exklusives Dockerfenster für
  `.tmp/wp29-retained-production-verify.cjs` auf Image `8e1d...`. Root hat Helper
  gelesen: ausschließlich gestoppten gelabelten Sourcecontainer ersetzen, alle
  drei vorhandenen Volumes/underscore-ID erhalten, echte Auth/Timer/Replay und
  API+Workerrestart, striktes Loggate, eigener Cleanup bei Erfolg. Fehlerzustand
  bleibt sonst gestoppt erhalten. Kein vollständiger Backupnachweis daraus ableiten.

- Retained-Nachweis jetzt **Exit 0**, `goal-wp29-retained-production-recovery.log`,
  von Root gelesen: unverändertes Image `8e1d...`, ursprüngliche underscore-ID
  und Gerätecredentials, Timeranlage/Feed, API+Workerrestart, genau ein Timer/v1
  mit unveränderter Deadline und exaktes Event als Duplicate. Keine Startupcodes
  und Secret-Audit grün. Neustart samt Nachprüfung 6520 ms. Eigene Container/
  Volumes nach Labels leer und State gelöscht; Root bestätigt State-Abwesenheit.
- Ein vorheriger Retained-Versuch scheiterte nach zunächst erfolgreichem Admin-
  GET an HTTP 401: Fixture ignorierte reguläres Set-Cookie nach 15-min-Rotation.
  Read-only-Beleg: Session vorhanden, weder abgelaufen noch widerrufen, Tokenhash
  rotiert beim ersten GET. Keine Produktkorrektur/TTLverlängerung; Backup- und
  Lastclient übernehmen jetzt nur den konkreten Sessioncookie. Recovery nutzt
  ausdrücklich neuen Login, kein Fortbestand des verworfenen Cookies behauptet.
  Last-Units jetzt **4/4**, ESLint grün. Kein HTTP-Fehler wird durch Retry toleriert.
- Dockerfenster frei, sämtliche Agentdateien eingefroren. Harness `5bdf...` muss
  wegen endgültiger Cookie-/Auditfixtureänderungen noch einmal gebaut werden;
  danach unveränderter vollständiger Linux-CI-Runner über geprüften TCP-Relay.

Voll-CI, erster Versuch und erneuter Lauf:

- Erster Lauf im vorinstallierten Harness `1e023...` beendet mit Exit 1 beim
  Backend-Typecheck. `goal-wp29-linux-ci-full.log`; Container/Metadaten unter
  `.tmp/wp29-linux-ci-state.json` erhalten. Noch keine Dockerfixtures gestartet.
  Nur eigener gestoppter Container als lokales Diagnoseimage gesichert, keine
  Produktdaten/Zugangsdaten darin. Konkreter Fehler TS2307 für `@inker/contracts`.
- Exakter Snapshot reproduziert den Fehler; frisches vorbereitetes Harness
  besteht denselben Typecheck. Metadatenvergleich beweist nach erneutem prepare
  fehlende Typ-/CJS-Dateien in Backend- und Frontend-Paketkopien; Original-Contracts
  enthalten beide weiter. HOST-02 dokumentiert, keine Produktions-/TS-Korrektur.
- Ignorierter Harnessgenerator startet jetzt ohne Vorinstallation, wie frische
  GitHub-CI. Vollrunner installiert genau einmal und behält sämtliche 43 Gates.
  Build Exit 0, Image `92d0c81a451ff05da1c400609f239d43582d15a5d5bf8af3718818564edb4931`.
- Zweiter Gesamtlauf BEENDET (Exit 1): frühere Root-Execsession **57407**, Log
  `.tmp/goal-wp29-linux-ci-clean-full.log`, sichere Container-Metadaten
  `.tmp/wp29-linux-ci-clean-state.json`. Contracts **95/2244**, Backend-Units
  **1127/6923**, alle statischen Gates und die ersten 14 Integrationen grün.
  Render-Cache-Suite **10 pass / 2 fail / 274 Assertions**: unabhängiger Node-
  Testprozess mischt seit Observability Nest-Logs in sein JSON-IPC auf stdout.
  `isolation_review` besitzt ausschließlich `test/fixtures/render-process.cjs`
  für Umleitung der Fixturelogs nach stderr und anschließende Suite-Wiederholung;
  Produktionslogging und Integrationsassertionen bleiben unverändert.
- `wp19_renderer` korrigiert vier belegte Betriebsdoku-Widersprüche (Seeds bei
  APIrestart, fehlender Instanzschlüssel, begrenzte Operationslisten und explizite
  Legacy-Key-Initialisierung). `source_contract` reviewt die Lastfixture nur lesend.
  Alle Dockerläufe bleiben serialisiert. Kein WP-29-Commit oder Gesamtabschluss.

### Historisches Nachweis-Audit WP-27 (jetzt durch 18/228 geschlossen)

Unabhängiges Read-only-Audit am isolierten Stand und Root-Abgleich: Die grünen
Tests belegen normale Persistenz, Migration, 304, Revisionwechsel, Offlinecache,
Widerruf und Neustart mit zuvor wartendem Job. Folgende Fälle bleiben offen;
dies sind Nachweislücken, keine behaupteten Implementierungsfehler:

| Invariante | Grenze der bisherigen Evidenz |
|---|---|
| Atomare Erstellung/Planung ohne verwaiste Credentials, Publications, Jobs oder teilweise verschobenes `nextSyncAt` | `remote-job.test.ts` verwendet Mocktransaktionen; Containerfixture prüft frühe Inputablehnung, keinen späten Schreibfehler. |
| Atomarer Import mit Revision/Artefakten, Cachepointer, Gerätezuordnung, Folgeevents und Completion | Worker-Testtransaktion ist nur `operation(tx)`, Importer gemockt; der als Rollback benannte Test führt keinen SQLite-Rollback aus. |
| Keine doppelten aktiven Jobs; global zwei Claims, je Remote/Subscription einer zwischen Prozessen | Jobtests simulieren Deduplizierung; Workertest prüft nur die an einen Claim-Mock übergebenen Budgets. |
| Persistierte Versions-/Truständerung sperrt altes Abrufresultat; neuere Zuweisung/aktive Playlist bleibt geschützt | Versions-/Trusttests ändern Mockobjekte; Gerätefilter wird nur als Queryargument geprüft. |
| Leaseverlust/Abbruch nach ersten Domainwrites verhindert den gesamten Commit und alte Status-/Ack-Writes | Bestehender Fence-Test scheitert schon am ersten Write; Abbruchtests enden vor dem Import. |
| Crash nach Commit vor Ack erzeugt bei Wiederholung keine zweite Revision, Folgeevents oder fachliche Completion | Docker prüft Wiederaufnahme eines zuvor wartenden Jobs, nicht die Commit/Ack-Lücke. |

Quellen im Snapshot: `backend/src/federation/remote-job.test.ts`,
`remote-worker.service.test.ts` (Mocktransaktion Zeile 68, Claim/Importer 71/73,
Fälle 122/267/276/328/340/348), `remote-import.service.test.ts` (Gerätefilter),
`backend/test/remote-container-fixture.cjs` (Restart ab Zeile 262).
Root prüfte zusätzlich die existierenden WP-28-SQLite-Tests: Operations liest
Remote-Metadaten; Correlation belegt Kontextpersistenz/Deduplizierung. Beide
ersetzen keine dieser Remote-Fault-/Konkurrenzprüfungen. WP-29 nennt WP-27 und
WP-28 ausdrücklich als Gates. Keine gesperrte Datei oder Ersatzsuite angelegt.

## Verlauf bisheriger Pakete und Prüfungen

1. WP-11-Korrektur und WP-11/WP-14-Index/Handoffs in `6b6139f` lokal committed.
   WP-14 nicht erneut implementiert.
2. WP-19 abgenommen und lokal in `dc45346` committed: Render-Key/Sharp-Renderer, atomarer privater Artefaktstore,
   SQLite-RenderRequest/RenderBinding, Outbox→BullMQ-render-Queue und Fallback
   implementiert. Zehn neue Integrationen nach P1008-/Reaktivierungsfix grün.
   Neu: persistente `Device.renderRevision` plus
   gemeinsamer Vertragsvergleich gegen verspätete WebSocket-/HTTP-Antworten.
   Verifiziert: 644 Backend-/bestehende Integrationstests, neun echte
   Startup-/WebSocket-Prüfungen, zehn Cache-/sieben Migrationstests,
   29 Vertragstests und zuletzt 80 Frontendtests. Keine übersprungenen Tests.
   Reale Redis-Integration grün: überlappender Render-/Delivery-Abbruch nach
   61,836 s vollständig recovered (Delivery zwei, Render drei Versuche),
   100 Events in 6,149 s, keine Deadletters. Budget folgt echten BullMQ-
   Stalled-/SQLite-Leasezyklen; keine manuelle Datenbank-Recovery.
   Produktionscontainer einschließlich 20 Geräten/einem Renderjob, 200
   schreibfreien Manifestlesevorgängen, Snapshot-Normalisierung, Artefakthash,
   WebSocket-Reihenfolge, Restart und Secret-Audit erfolgreich.
   Dabei gefunden/behoben: synthetischer Sharp-Defaultimport funktioniert im
   Bun-Quelltest, nicht im externisierten CommonJS-Bundle. Typisierte Namespace-
   Kompatibilität nun in Renderer/PublishService, Typechecks/Lint grün.
   Echter Browser zeigte Admin-401-Weiterleitung auf öffentlicher Displayroute:
   AuthContext/API samt Tests korrigiert. Finales Image erneut vollständig
   geprüft; Browserpairing, 800×480-Fallback -> 1920×1080-Live-Update,
   weißer Fallback bei zweiter wartender Veröffentlichung -> schwarzer Render
   ohne Reload erfolgreich. DOM-Auflösung/Screenshots geprüft, keine Warnungen.
   Alle eigenen Testcontainer/Volumes entfernt. Review ohne weitere P1/P2.
   Historische Migrationstestannahmen ergänzt, ohne historische
   Datenintegritätsprüfungen zu entfernen; neue WP-19-Constraints geprüft.
3. Jetzt WP-20: vollständige Anforderungen sowie Architektur 1/5/8/Phase6/11/12
   und ADR-001/002/006/010 gelesen. Read-only Subagent-Vorbereitung bestätigt:
   Coordinator/WS bleiben API, Dispatcher/Render/Timer/Maintenance werden Worker;
   Core-Module controllerfrei trennen. Nest onModuleDestroy läuft VOR
   beforeApplicationShutdown, daher explizit vor app.close drainen.
   Aktive doppelte Log-Cleanup-Wege vereinheitlichen, inaktiven externen
   Model-Poller nicht reaktivieren. Queue-/Worker-Degraded darf Read-API nicht
   unready machen. Umsetzung im Arbeitsbaum: controllerfreie Event/Publication/
   Playback-Core-Module; API-Delivery-Lifecycle; separates `worker.ts` mit lokaler
   Readiness3001 und eigenem Bundle; gemeinsame Queuepolicy; gefencete
   Stunden-Maintenance mit dauerhaftem Effektbeleg; einmaliger s6-Init vor beiden
   non-root Services. Shutdown drain22s vor Nest-close, s6 grace28s,
   Compose stop grace35s. Nginx-Health/Ready jetzt echte Backend-Probes.
   Seed ist fail-closed, fehlender Catalog wird mitkopiert; kein falscher PIN-
   Hinweis/überschreibender Bootstrap-Upsert mehr.
   Erste Nachweise: beide Bundles/Typecheck und gezieltes Lint grün; 599
   Backendtests; 19 Cache-/Migrationsfälle einschließlich Seed-Replay und spätem
   abgebrochenem Render; Maintenance9+Publication18+Outbox13 =40 Integrationen
   grün. Erster Redisrun hing im Test bei pause(false) unbenutzter Queueworker;
   korrigiert auf nichtblockierende pause(true), Wiederholung grün (122,8s;
   überlappende Crash-Recovery62,209s, Delivery2/Render3Versuche). Gemessener
   Durchsatz6,8/s motiviert sofortiges Nachfüllen freier Slots mit weiterhin
   500ms-begrenzter Renderreconciliation; erneute Messung ausstehend.
   Erstes `inker:wp20-test`-Image gebaut: neuer Stop/Resume/SIGSTOP-Block grün,
   20 parallele API-Lesevorgänge p95 38,2ms bei pausiertem Worker. Nachfolgender
   WP18-Smoke-Assertionsfehler wird vom Auditagenten eingegrenzt.
   Zweites Review fand fehlendes Timer-Abortsignal vor Commit; Rendereragent
   behebt PlaybackService und ergänzt echte Transaktions-Abortprüfung.
   Finaler Imagebuild nach Queue-Health-/Routing-/Timerhärtung inzwischen grün.
   Reviewbefunde behoben: PlaybackModule explizit API-importiert; atomare
   Queuebudgetprüfung+Claim unter SQLite-Writerlock (echte zwei Clients, verschiedene
   Kandidaten bei gemeinsamem Renderlimit); Worker-Readiness beobachtet tatsächliche
   Command-/Blocking-Clients, nicht bloß BullMQ-isRunning. Heartbeat wird bei
   Connectionverlust oder Pause zurückgezogen. 605 Unit-Tests bestanden.
   Hauptagent: 44 Maintenance/Playback/Cache/Migration +34 Outbox/Publication
   Integrationen, 0 Fehler. Typechecks für Anwendung und Tests in ihren passenden
   CommonJS-/ES-Modi sowie gezieltes Lint aller Änderungen erfolgreich.
   Finaler Redisrun grün (118,2s): getrennter Worker-Client-Ausfall bei gesundem
   Publisher korrekt degraded/recovered; Crash-Recovery61,726s, Delivery2/Render3;
   100Events5,982s=16,7/s. Kein Deadletter/Secretleck. Finaler Docker-Smoke grün:
   s6 Workerstop beweist Exit0 ohneSignal, API/WS/Artefakte bleiben erreichbar,
   wartende neue Revision wird nachStart verarbeitet. SIGSTOP mit20APIreads
   p95=37,4ms; vollständige WP15/17/18/19-Regressionsstrecke und Restart/Secretaudit
   bestanden. Hauptagent hat Summary und konkrete Assertions selbst geprüft.
   Ergänzende neun Secret-/WS-Integrationen bestanden. Zwei echte s6-Negativtests
   für verbotenen PIN/fehlerhaften Seed bestanden: Containerexit1, keinerlei
   API-/Workerstart, Ready-Marker fehlt; GesamttestExit0. Nur eigene Container
   ohneMounts/Netzwerk, bereinigt. Hauptagent hat finalen Report überprüft.
   WP-20 abgenommen und lokal in `a3e7162` committed; danach Arbeitsbaum sauber.
4. Jetzt WP-21. Vollständiges Paket, Architektur1/2/4/5/6.4/6.5/8/Phase6/11/12,
   ADR001/002/006/007/010 gelesen. Vertrag SourceDefinition ergänzt durch
   Contractagent; Connectoragent bearbeitet nur pure Fixture/Slow/Failure und
   Validatoren. Root integriert SourceSecret/Definition/Snapshot/RefreshJob,
   Scheduler/Queuebudgets, API und echten Snapshot→Publication→Sharp-Nachweis.
   Audit fand aktive Legacy-API/Render-Netzwerkumgehungen. DataSources-Agent
   macht Cachelesen strikt persisted-only und lehnt alte direkte Refreshpfade
   ohne registrierten Connector explizit ab. Plugin-Agent behandelt analoge
   Provider-/Unknown-Code-/Secretgrenzen. Vorhandene Daten bleiben erhalten.
   Kein neuer Produktconnector; vollständige Unknown-Code-Isolation folgt WP22.
   Erste eigene Schemaänderung und Migration `20260831000000_sources` im
   Arbeitsbaum; noch NICHT abgenommen. SourceSnapshotdaten bleiben unveränderlich,
   Fehler erzeugen neue stale-Version mit letzter gültiger Datenbasis.
   Integration inzwischen vollständig: persistente SourceJobs/Secretrefs, globale
   und Provider-/Connector-/Sourcebudgets, Timeout/Abort/Retry/Circuit, Source-API,
   explizit gepinnte Snapshot→Publication→Bildbytes. Legacy-Livepfade liefern
   dokumentierte410/503 statt Netzwerk/Standardbild. Reviews fanden und behoben
   Secretkopien, späteLeasecommits, Transportdeadletter-Scheduling und SQLite-
   Burststarvation (begrenzte Writerqueue und Busyretry). Rootverifikation:
   660Unit+37Contract+80Frontend,18Sourceintegrationen339Assertions,35HTTP/Auth/
   Publication/WS-Integrationen; Migration9/60 erneut isoliertgrün nach einem
   5sTimeout unter parallel laufendem Imagebuild. Weitere53Cache/Playback/Outbox/
   Maintenancefällegrün. Typechecks undgezieltesLint0Errors14Warnings.
   Redis118,85sgrün,Recovery61,844s,15,3Events/s. Produktionsimagegebaut;
   Source-Smoke belegt5sTimeout,3Fehler+echte30sCircuitpause,white/blackBildbytes,
   Login126,3ms und20APIreads p95127,9ms. AbschließenderContainerrestart/Secretaudit
   undBrowserprüfung nochaktiv. ErsterSourceSmoke scheiterte an falsch benanntem
   Testskriptparameter; behoben,keineProduktionsregression. Source-Betriebsdoku
   undRunbookverweise ergänzt. FinalerContainerrestart/Secretauditgrün,Exit0.
   BrowserAdmin/Editor/Pairing und1920×1080weiß→schwarzohneReloadgeprüft;
   Testcontainer/Volumesbereinigt. WP21abgenommen,lokal05098c0committed;
   anschließendArbeitsbaumsauber.
5. JetztWP22: vollständigesPaket,Architektur1/2/4/5/6.5/7/8/Phase6/11/12 und
   ADR006/007/010gelesen. Reviewinventar findetweiterhin node:vmScriptExecutor
   undLiquid imAPI, einschließlichblockierenderResult.toStringaußerhalbVMTimeout.
   ArchitekturentscheidunginVorbereitung: frischerBunSubprozess mitQuickJS-WASM-
   Gast, keineHostbindings/Module/Netzwerk, harteGastheap/Stack/Interruptlimits
   undzusätzlicherElternprozessdeadline/SIGKILL. LiquidBrowserbundleebenfallsimGast.
   NacktesSubprozess-env:{}istwegengeteilterUID/SecretvolumekeineSecretgrenze.
   NurreineJS-Transformationen/deklarativeTemplates,keinnativesPlugin/Marketplace.
   Umsetzung/Abnahmetestsnoch offen; anschließendWP23bisWP29inIndexreihenfolge.
   QuickJS0.32.0exaktgepinnt(package/lock); WindowsBunadd scheitertebeimKopieren
   derlokalen@inker/contracts-Abhängigkeit auchmitcopyfile. QuickJSund9neuePakete
   sindinstalliert; gebauteContractsmanifest/README/dist manuellnachnode_modules
   zurückkopiert,requirebeiderPaketeerfolgreich. LinuxfrozenInstallnochzuprüfen.
   Root: isolation-contract.ts mitProxy/Getter/Hook-sichererbegrenzterJSONkopie,
   zentralerRedaction; isolated-executor.ts mit2Prozessen/16Wartenden,2,5sDeadline,
   leerenv,beschränktenPipes,SIGKILL undawaitclose; eigenständigeProzesstests.
   MainTypecheckgrün. GuestagentimplementiertWASM+Liquid; Callsiteagentbereitetnur
   Tests vor. Tool-SicherheitsprüfungverlangtbelegteExecutor-Negativtestsvor
   ausführbarerAPI/Worker-Anbindung; dieseAnbindungwirdbisNachweisausgesetzt,
   keineUmgehung. Neuerread-onlyAgentisolation_reviewprüftParent/Contract.
   Grenze inzwischen tatsächlich getestet und reguläre Toolfreigabe für Anbindung
   erhalten. JS/Liquid laufen jetzt nur im Gast; Source-Transformation ist optional,
   versioniert und verwendet ausschließlich normalisierte Daten. Gefundene Lücken
   behoben: quadratische Redaction, unwirksames alleiniges QuickJS-Heaplimit
   (jetzt feste32MiB-WASM-Memory), Bun-.env-Autoload, Webpack-Liquid-Assetauflösung,
   Settings vor IPC entfernt. Hauptagent:721Backendtests/3446Assertions,
   38Contracts/261,80Frontend grün. Source+Migration41/575 durchAgent grün;
   zusätzliche88Integrationen/1715 grün. Redis125,54s:Recovery61,874s,
   100Events6,671s=15,0/s. Typecheck Anwendung+Tests undgezieltesLint0Errors,
   1bestehendesWarning. LinuxfrozenInstall+Imagebuild erfolgreich.
   Container-Smoke mit eigenem WP22-Helper läuft, nochkeinAbschlussnachweis.
   Reviewer prüfte Gast/Parent/Callsites/Fences; kein weiterer P1/P2 außer
   Source-Recovery bei beschädigtem Altsecret: Agent ergänzt eng begrenzte
   Disable/Clear/Rotate-Ausnahme bei identischen öffentlichen Feldern samtTests.
   Danach finalesImage/Smoke undWP22Handoff/Commit; WP23–29 weiterhin offen.

   WP22 jetzt abgenommen: finale722Backend/38Contracts/80Frontend,36Source/585,
   10Migration/66 sowie88sonstigeIntegration/1715. AbschließendesImage/SmokeExit0:
   tatsächlicherSIGSTOP→Parentkill2521,9ms,PIDcleanup,SourceSecretRepair,
   Login104,7ms,20API/Artefaktreads p9561,3ms,RestartundSecretauditgrün.
   EigeneContainer/Volumesbereinigt. ADR010akzeptiert,WP22Handoff+Operations+Phase6
   aktualisiert. WP22 lokal in `eb5e5eb` committed; danach Arbeitsbaum sauber.
6. WP23 ist nächstes sequenzielles Paket; vollständigeAnforderung+Architektur4/5/
   6.4/6.6/7/8+ADRs gelesen. Read-onlySubagentinventar: Contractsvorhanden,
   keinepersistiertenPublicationActions; view.next sollPlaybackadvancewiederverwenden,
   aberReceipt+Änderung+OutboxmüsseneineTransaktionsein. AuthbrauchtDeviceCredential-
   Principal,keineLegacyHTTP_IDCommands. DuplicatevorCurrentRevision/Timewindowprüfen.
   Parallel erlaubt: WP28Agentwp19_renderer bearbeitet NUR neue Observability-
   Contract-/Context-/Logschema-/Metricsdateien+Tests,keinIndexexport/Schema/Bootstrap.
   WP28bleibtbisIntegrationundRemoteanschlussnachWP27unabgenommen.
   WP23 inzwischen implementiert: DeviceCredential-Bearer-HTTP-Endpoint/Context,
   unveränderliche PublicationActions (kein Recht bei Cachefallback), Registry und
   view.next über Playbacktransaktion. Receipt/Domain/Outbox atomar, SQLite-Writerlock,
   persistente Quoten/Sequenz, enge Zeit-/Payloadgrenzen, kein Token/Payload im Audit.
   Review gefundene Handlerresult-Projektion behoben; echte Rollbacktests grün.
   Agent:16 Interaktionen/396Assertions,11 Migrationen/95; Root:740 Backend/4815,
   48 Contracts/440 (enthalten unabhängigen WP28-Kern), Typecheck+gezieltesLint grün.
   Produktionsimage und gesamte Integrationsregression laufen; noch NICHT abgenommen.
   Root arbeitet HTTP-Smoke in eigener Containerfixture, danach Operations/Handoff,
   finaler Nachweis und lokaler WP23-Commit OHNE acht unintegrierte WP28-Dateien.
   Final751Backend/4937Assertions,48Contracts/440,80Frontend,alleTypechecksgrün.
   GesamteIntegrationsregression147/2793grün. ErstesProduktionsimage+HTTP/Restart
   erfolgreich, aber abschließenderSecret-Audit scheiterte imTesthelfer: reproduziert
   Prisma/Bun-console.log-Ausgabeabbruch bei64KiB. AuchBun.write reproduzierbar
   ungeeignet (Duplikat/Blockade). Korrigiert auf4KiB-writeSync-Blöcke+5sEAGAIN-
   Deadline,16–256KiBsynthetischvollständiggeprüft;256KiBRegressionjetztimSmoke.
   VollständigerContainerlaufwirdmitunverändertemProduktionsimagewiederholt.
   Rootsession76843 schreibt `.tmp/goal-wp23-container-final.log`; erstExit0,
   SecretAuditundCleanupabwarten. KeineAbnahmekriterienabgeschwächt.
   FinalerContainerlaufjetztExit0inklusiveReceipt/PlaybacküberRestartundvollständigem
   SecretAudit. SIGSTOP→Kill2522,4ms,Login102,6ms,API/Artefaktp9559,7ms,
   eingefrorenerWorkerAPIp9530,2ms. WP23Index/Handoff/Phase7undBetriebsdokumentation
   aktualisiert. WP28CoreReviewfandProxyOriginalrückgabeimContract; Sourceagent
   korrigiertausschließlichdie2neuenWP28Contractdateien,separatvomWP23Commit.

7. WP24nachWP23Commitbegonnen. VollständigesPaket+Architektur6.7/8+ADRs001/002/003/
   006/007gelesen. Timer1000msbis7Tage,privateOwner/sharedlocal,Quittierungglobal
   füreinencompletedTimeralsseparateackFelder. Serverzeitclamp>=evaluatedAt;
   runningendsAt>letztepersistierteBewertung;keineTicks. Create/pause/resume/cancel/
   acknowledgeviaWP23,MutationenmitexpectedVersion;überfälligeKommandoserfolgreiche
   Completion,ackinklusive1Revision. Creator-FKSetNullerhältsharedTimer/externaleID;
   privateOrphansunsichtbarundnichtkapazitätswirksam. Max32eigen/100globaloutstanding
   (running,paused,unquittiertcompleted). RootSchema+Migration20260903000000_timers,
   TimerService/Handlers/CoreModule;OutboxstrikterTIMER_CHANGEDParserohneDelivery
   bisWP25. AgentDomain69Tests309grün,Contract10Tests448grün; Rootintegrationläuft.
   Agentisolation_reviewbesitztnurneueTimerintegration/Prozessfixture;source_contract
   nurexistierendeMigrationtests+neueTimerEventtests;RootbesitztSchema/Service/Module/
   Index/Docs/ContainerSmoke. KeineDateikonflikte,WP24nochnichtabgenommen.
   Roottypecheck/Lintgrün,820Backendtests/5246Assertionsgrün. Review+realeSQLite-
   ReproszeigtenInteger-/Zeitwerte-Checklücken;SQLjetzttypeofinteger,Unixbounds,
   vollständigeZustandsinvarianten. DDLimfinalenImageerneuert(Session88947,
   `.tmp/goal-wp24-build-final.log`). Altpfadregression147Integrationenläuftin
   Session95608nach`.tmp/goal-wp24-integrations.log`. AgentTimerintegrationund
   Migration/Eventtestsnochaktiv. Timer-Containerfixtureimplementiert,aber
   LaufnochNICHTgestartet;erstnachfinalemImageundTestfindingsausführen.
   Final825Backend/5426,61Contracts/949,80Frontend,18Timer/Event-Integration/418
   durchRootgrün;AgentgesamteMigration12/194grün. Typecheck+Lintfinalgrün.
   Timerdomain13Integrationenenthält2realeProzessrennen.DDL-FixesimfinalenImage
   enthalten;ContainerSession32373(`.tmp/goal-wp24-container.log`)hatWP24HTTP
   erfolgreichgeprüft;abschließenderRestart/SecretAudit/Exit0nochabwarten.
   AltpfadregressionSession95608nochaktiv. WP24Index/Handoff/Commiterstnachbeiden
   erfolgreichenExitcodes;anschließendWP25. WP25Inventaragentnurread-only.
   BeidefinalenLäufebeendetmitExit0:147Altintegrationen/2793undContainerinklTimer-
   HTTP/Restart/SecretAudit. WP24jetztabgenommen;Index/Handoff/Phase7/Betriebaktualisiert.
   NächsterSchrittlokalerWP24Commit(ohneWP28),danachWP25Scheduling/Push/Pull/Browser.

8. WP25 aktiv: dauerhafte Timerjobs mit deterministischer ID pro Timer/Version/
   Deadline, Outbox-Claimfence vor und nach Domain-I/O. Startup rekonstruiert
   fehlende Jobs, reaktiviert nur dann erschöpfte noch aktuelle Deadlines;
   normale Reconciliation alle5s, keine Timer-Tickwrites. Completion bleibt
   Workerarbeit. Timerfeed GET /api/timers, direktes bounded DTO mit ETag ohne
   Serverzeitsample; X-Server-Time auch304. Pullmanifest enthält timerState,
   Artefaktreads scannen keine Timer. Tiny WS-Invalidierung ohne private Daten.
   Root besitzt Scheduler/Service/Module/HTTP/Pull/Main/Docs/Containerfixture;
   isolation_review nur neue Schedulerintegration/Prozessfixture;
   source_contract OutboxTypes/Store/Coordinator/WSAdapter/Gateway+Tests;
   wp19_renderer Contracts+Frontendtestscreen. Acht WP28-Dateien weiterhin separat.
   Implementierung/Tests laufen, WP25 noch NICHT abgenommen.
   Review2P2behoben: unveränderteRecoveryjetztReadfastpath0SQLWrites; Uhr-Rücksprung
   stellt früheJobsaufOriginaldeadlinezurückohneRetrybudget. Agent+Root16Scheduler-
   Tests/144Assertionsinkl3echteProzesseund6DispatcherDeferralsgrün.
   Root27Timer/Scheduler/346vorReviewerweiterunggrün; HTTP26/82grün.
   Frontendfinal94,Contracts66/994grün. BuildfinalExit0(inker:wp25-test).
   BackendfinalunterparallelDockerbuild842/843: IsolationstdoutTestRecoverylief
   in2,5sDeadline; nachBuildgezielt14Isolation/161grünunveränderteLimits.
   RootvolleSuiteerneutinSession(offiziellesLoggoal-wp25-backend-confirmed.log).
   AltintegrationenSession68677läuft,TimerContainer+Browsernochnichtgestartet.
   Browserruntimeverbunden,Dokumentationgelesen; eigeneFixture
   backend/test/timer-browser-fixture.cjs vorbereitet,Stateunterignoriertem.tmp.

   FinalerContainer55794Exit0inklRestart/SecretAudit/Cleanup. Root843Backend/5530,
   66Contracts/994,94Frontendgrün. Altintegrationen148:3Zeitvergleichsfehlergezielt
   behoben;beideganzenDateienRoot41/2782grün,übrige107vorhergrün. KeinSkip.
   EigeneBrowserfixture2Tabs/2Geräte:SharedDoppeltap1Receipt1Timer,PauseResumeCancel,
   Private10s/Offline0s/Workercompletedv2/Reconnect/ackv3/Reload;6Receipt2Timer.
   LayoutScreenshotgeprüft,beideTabsgeschlossen,Fixture+Volumesentfernt.
   WP25Handoff/Index/Phase7aktualisiert. NächsterSchrittPaketcommitohneWP28,
   danachWP26. Read-onlyWP26Inventarvorhanden:keineFederationmodelle/ServerID,
   eigeneShareAuth+reineFeedProjectionnötig(keineDeviceManifestActions/Timer/Sources).

9. WP26 implementiert, noch NICHT abgenommen: Migration20260904000000_federation_shares,
   unveränderliche Singleton-Server-ID und Publication-Sharehash mit Audit/Widerruf;
   TLS-only Guard mit expliziten unmittelbaren Proxy-IP-Literalen. Reiner Feed
   latest/retainedArtifact, Version1.0,64KiB/8Artefakte/2MiBpro/8MiBgesamt,
   ETags+AuthentifizierungvorundnachReadinkl304; keineSource/Timer/Aktionsdaten.
   AgentDateienintegriertundRootgeprüft. Root895Backend/5754,77Contracts/1331,
   94Frontend,15realeSQLite/298inkl2Prozesse,13Migrationen/221grün.
   Produktion+neueTestsTypecheckundLintgrün. BetriebFEDERATION_OPERATIONS.md.
   ErsterImagebuildgrün,HTTPSContainerlaufbisArtefakthash/ETaggrün,dann
   doppelterNginx+BackendnosniffHeaderentdeckt. Gezieltesproxy_hide_headerin
   Federationlocationbehoben;finalerImagebuildSession20341läuft. Danachganzen
   ContainerSmokeerneutausführen,Restart/Revoke/SecretAudit/Cleanupabwarten.
   VorherkeinIndexhakenundkeinCommit. ErsterTestcontainer+Volumesentfernt.
   FinaleLogs.tmp/goal-wp26-*.log. AchtWP28Coredateienweiterhinseparat.

   FinalesImagegrün(Digest2ea40d03), vollständigerTLSContainerSmokeExit0:
   CAverify/HTTPspoof/CSRF/Scope/Expiry/Revoke/Revision/Restart/SecretAuditgrün,
   eigeneContainer+Volumesnachweislichentfernt. GültigerInteractionEventim
   Negativtestverwendet(keine400SchemaabweisungstattAuthnachweis).
   WP26Index/Handoff/Phase8/Betriebaktualisiert, Paketcommitfolgt; danachWP27.

10. WP27 begonnen. VollständigesPaket/Arch6.8/7/8/ADR001/003/004/007/009gelesen.
    NeuePrismamodelleRemoteServer/RemoteCredential/RemoteSubscription/RemoteSyncJob,
    Clientgeneriert; Migration20260905000000_remote_subscriptionsangelegt,
    nochNICHTvalidiert. TransportagentarbeitetanHTTPSoriginAllowlist,
    separaterexpliziterPrivateOriginAusnahme(keinMetadata/Linklocal),
    abbrechbaremResolver+A/AAAAvollprüfen/IPpin+TLSverify,0Redirectsaußer304.
    Importdesign: gesamtehashgeprüfteArtefaktbytes(max8MiB)inimmutablelokaler
    PublicationSchemaVersion2alsatomischerSQLiteCache; keineActions. Root hat
    publicationArtifactsParser+RemoteImportServicevalidateArtifacts/persist/
    verifyCached implementiert. LokalePublicationbeiSubcreateleer,Importer
    appendRevision+Outboxatomar,automatischeAktualisierungnurGerätemitaktuell
    derselbenlokalenPublicationundohneaktivePlaylist;anderemanualAssignments
    werdennichtüberschrieben. APIkeineRemoteRequests; WorkerOwnQueue remote-sync
    20s/global2/perRemote1; Queue/Dispatcher/Module integriert.
    Root API/Importer inklusive Pixelmetadatenprüfung und Rotation implementiert.
    Produktionstypecheck und 50 Renderer/Feed/Queue-Tests grün. Contracts82/1433,
    Frontend107 grün (Root). Migrationlauf aktiv, noch keine Gesamt-Abnahme.
    Transportagent99Tests/195 grün; Headergrenze über eigenen begrenzten HTTP/1-
    Parser, da Bun1.3.14 maxHeaderSize ignoriert. Socketabbau außerhalb nativer
    TLS-dataCallbacks verhindert im Grenzwerttest beobachteten Windowsabsturz.
    Root-Review/Linuxtest noch offen. Runtimeagent baut ausschließlich eigene
    Home+2Remote-Dockerfixture mit 2Browsergeräten+1Pullgerät; noch nicht ausgeführt.
    Neue SQLite-Testdatei remote-subscriptions.integration.ts wurde vom
    Freigabesystem wegen Nutzungslimit explizit abgelehnt, nicht angelegt und
    nicht über andere Werkzeuge umgangen. Erneute ausdrückliche Freigabe beim
    Nutzer angefragt; unabhängige Tests/Reviews laufen weiter. WP27 offen.
    Fortsetzung: Root14Migrationtests/250inklWP26→WP27Datenerhaltgrün;
    39Worker/Jobtests197Assertionsinkl15sAbbruchgrün, 6ImporterTests36grün.
    StartkonfigurationvalidiertbeideOriginListenfailclosed;Composeweitergereicht.
    ReviewP2behoben:Tokenrotation/ReaktivierungerhältbekanntenFehlerbisSyncerfolg.
    RootGesamtsuitehatBunWindowsnativeTLS-Absturz;Transport-Einzeltestalleingrün
    genügtNICHT. AgentbearbeitetTLS-Testpeer/Cleanup,keineTestsübersprungen.
    ErstesProduktionsimageinker:wp27-testgebaut(Digestbd9a137b);nachträgliches
    WorkerETagLimit200mussimfinalenImageerneutgebautwerden. SeparatesLinux-
    Unitimagebackend-builderläuft(Session80902). Docker/Browsernochnichtgestartet.
    Browserneuverbunden,Bindungenagent/browser;keineTesttabsangelegt.
    WP28parallel:SourceagentbesitztnurObservabilityContract+MetrikCore4Dateien,
    danachzentralenRedactor+Tests;separatvomWP27Commitbewahren. RootIntegration
    undAbnahmeWP28erstnachWP27. OperationsdokumentationWP27klaralsunabgenommen.
    Runtime-Nachweis: .tmp/goal-wp27-container-bmp.log Exit0 einschließlich
    Admin/CSRF/Trust/Origin,2Remotes/3Geräte,echtemTLS/304,Protokollmismatch,
    neuerRevision,beideOffline,HomeRestart11662ms,Revoke,SecretAuditundCleanup.
    Fixturefixes: eigeneBridgeohne--internal(sonstkeineHostportsaufDockerDesktop),
    weiterhin127.0.0.1-Bindung;harte10sHTTPDeadline;explizitesBMPOverrideimTestgerät
    stattbestehenderPNG-Kompatibilitätsvorgabe. KeineAssertionsabgeschwächt.
    LinuxGesamtsuite1035pass/7fail:alle99TLSinklCleanupgrün;7bestehendeBrowser-
    TestsfehltenBuildimage-Systemlibs. .tmp/Dockerfile.wp27-suitekombiniert
    vollständigeProduktionsruntimeundTestdeps;BuildSession43395,danachgesamten
    Laufwiederholen. WindowsBun1.3.14nativhängtauchmitNode-Testpeer;Ursacheoffen,
    keineweiterenidentischenVersuche. ProduktionsclientbleibtBun/Linux.
    Browser-SetupSession9905aktiv(.tmp/goal-wp27-browser-setup.log),nochkeine
    Browser-Abnahme. RootmussdanachUI+2DisplaysprüfenundFixturewiederentfernen.
    WP28Core+Redactorjetzteingefroren;RootReviewderRedaktionerfolgt,Integration
    weiteroffen. SecretRedaction2Dateienzusätzlichzuden8Coredateienseparathalten.

## Letzter verifizierter Zwischenstand WP-27

- Vollständige Linux-Backend-Suite mit Produktions-Browserbibliotheken und
  aktuellem, schreibgeschützt eingebundenem `backend/src`: **1057 Tests,
  6328 Assertions, 0 Fehler**, Exit 0 nach 69,85 s; lokales Log
  `.tmp/goal-wp27-linux-complete.log`. Eigenes `--rm`-Testimage
  `inker:wp27-suite`, keine Netzverbindung. Der frühere Lauf im reinen
  Builder-Image mit sieben fehlenden Browserbibliotheksfehlern ist hierdurch
  ersetzt, nicht als Erfolg umgedeutet. Windows-Bun-TLS-Absturz/Hänger bleibt
  als Hostproblem ungeklärter Ursache dokumentiert.
- Migrationen einschließlich WP-26→WP-27-Datenerhalt: 14 Tests/250 Assertions.
  Worker/Job: 39/197; Importer: 6/36; Renderer: 12/71.
  Produktions- und expliziter Test-Typecheck sowie gezieltes ESLint: Exit 0.
  Contracts: 82/1433 und Frontend: 107 bestanden vor den zusätzlichen
  separat gehaltenen WP-28-Contracttests.
- Echter Drei-Server-Smoke: Exit 0; `.tmp/goal-wp27-container-bmp.log`.
  Zwei unabhängige TLS-Remotes, zwei Browsergeräte und ein schneller Pullclient;
  Auth/CSRF/Trust/Origin, Conditional GET (A: 2, B: 3 echte 304), Revisionwechsel,
  Protokollmismatch, beide Remotes offline, lokaler Cache, Home-Neustart
  (Recovery 11662 ms), Widerruf, Secret-Audit und vollständiges Cleanup geprüft.
- Tatsächliche Browserprüfung der Adminseite und zweier 1920×1080-Displays:
  Pause/Reaktivierung, Zuweisung, verständliche Stale-/Widerrufsfehler und
  Bildreload aus lokalem Cache bei beiden abgeschalteten Remotes erfolgreich.
  Bei pausiertem eigenen Worker blieb nach Tokenrotation der bekannte Fehler
  erhalten und das Passwortfeld wurde geleert; erst der erfolgreiche Sync
  stellte Fresh wieder her. Admin-Konsole ohne Fehler; DOM und Screenshots
  geprüft. Alle drei Tabs geschlossen. Browserfixture-Secret-Audit und Cleanup
  mit Exit 0 abgeschlossen; labelgefilterte Container-/Volume-/Netzwerklisten
  leer und ignorierte Fixture-State-Datei nicht mehr vorhanden.
- Noch offen: gesperrte neue SQLite-Integrationssuite (Rollback/Atomarität,
  konkurrierende Clients, veraltete Claims/Versionen), abschließende Regression
  und Imageprüfung des exakten WP-27-Paketstands ohne WP-28-Änderungen.
  Der aktuelle erneute Build mit Worker-ETag-Limit 200 ist ein Kandidat des
  gesamten Arbeitsbaums, keine Paketabnahme. Build mit Exit 0 abgeschlossen
  (`.tmp/goal-wp27-build-final.log`, Image-Manifest `07da779d76c0100a0c213859b69c71a872cee6f4274b52bc3686da8faf03820e`).
  Erneuter vollständiger Smoke mit Exit 0 abgeschlossen: Recovery 11548 ms,
  echte 304 A: 2/B: 3, einschließlich Secret-Audit und Cleanup;
  Log `.tmp/goal-wp27-container-final.log`. Fixture-Selbsttests nach
  Sandbox-EPERM mit Freigabe: 3 bestanden,
  0 Fehler. Kein WP-27-Commit erstellt.
- Read-only-Subagent-Review des WP-28-Core abgeschlossen, keine Edits. Konkrete
  P2-Folgeschritte und Correlation-/Health-/Metrik-Integrationsgrenzen sind im
  neuen WP-28-Zwischenstand in `WORK_PACKAGES.md` dokumentiert. Insbesondere
  Redaction vor Logger-Konvertierungen, X-Device-Key/Einmalcodes, JSON-stdout,
  Logrotation und unbekannte statt vorgetäuschter Nullwerte noch offen.

## Aktive unabhängige WP-28-Integration

WP-27-Testfreigabe bleibt offen. WP-28 darf laut Arbeitsliste nach WP-20 parallel
bearbeitet werden; das wurde genutzt. Beide Pakete bleiben uncommitted.

- Root: OperationsService/-Controller/-Module, gemeinsame Queue-Zuordnung,
  Request-UUID/Messung, private Redis-Worker-Metriksamples (8 s, maximal 16 Worker),
  API-/Worker-Liveness, Render-/WebSocket-Diagnose und begrenzte Compose-Logs.
  Neue Correlation-Migration 20260906000000_observability; Prisma-Client generiert.
  Source-/Remote-Freshness wird zwischen bestehenden Ansichten und Operations
  geteilt. Keine Remote-Requests oder fachlichen Writes im Diagnosepfad.
- isolation_review: persistierte Correlation an allen Outbox-Producern,
  Worker-/Delivery-Kontext und Regressionen. Correlation ist eine eigene UUID,
  nicht die Event-ID; alte Zeilen bleiben null und nutzen einen stabilen
  ausschließlich gelesenen Fallback. Source-Aggregatmetadaten dürfen das
  bestehende Jobfehlerhandling nicht umgehen.
- source_contract: sichere Logger-Eingangsgrenze vor Winston, JSON-Ausgabe,
  getrennte API-/Worker-Dateien mit 5 MiB × 3 je Stream, sichere HTTP-Fehler-
  und Startupausgabe. Getter/Proxies/Zyklen, Codes/Headers/Source-Secrets geprüft.
  Alte eigene Rotationstestdateien wurden nach geprüftem Pfad entfernt.
- wp19_renderer: geschützte rein lesende Operations-UI (121 Frontendtests grün),
  danach echte SQLite-/HTTP-Integration und unabhängiges Backend-Review.
- Root verifiziert: Operations-/Correlation-Integration 17 Tests/215 Assertions,
  Logger/Redaction/Filter 40/352, Core/Request/Worker-Metrik/Routing/Health 27/1380,
  WebSocket-Gateway 21/104, Migrationen 14/250; jeweils Exit 0. Produktionstypecheck,
  expliziter WP-28-Testtypecheck und gezieltes Lint grün. Kein übersprungener Test.
- DEVICE_DELIVERED bedeutet bestätigter Server-Sendecallback, nicht Display-Ack.
  Getrennte Geräte/Adapter-Noops erzeugen keine falsche Erfolgsdiagnose. Der
  spätere Ack bleibt separat über acknowledgedAt erkennbar.
- Erstes WP-28-Arbeitsbaumimage gebaut (Manifest bfd12ff9535bdb5dd62895df94d0cc384f60af548dc82d3311754ed1e1be842e).
  Nachfolgende Gateway-/Samplingfixes erfordern erneut Build. Linux-Testlayer
  gerade in Aufbau; Logs `.tmp/goal-wp28-*.log`. Noch keine WP-28-Docker-/Browser-
  Abnahme. source_contract erstellt ausschließlich eigene Operations-Laufzeit-
  fixture (Port 18731, Label inker.wp28.fixture); Start erst nach Root-Freigabe.
- Aktuell offenes Review: Worker-Sample-TTL nach I/O/Cache und mögliche SQLite-
  Writerlocks durch diagnostische Lesetransaktion. Root behält die Integration
  und finale Verifikation. Kein Paketcheckbox/Abschlusscommit vor Behebung und
  tatsächlichen Laufzeitnachweisen.

## Wiederaufnahmehinweise nach Push und WP-28-Review

- Erneuter ausdrücklicher Push-Auftrag ausgeführt: `git push origin
  codex/device-platform-spike` meldete bereits aktuell; `ls-remote` bestätigte
  `711164ff056eb6fdccdaf23e52db5a944dd47c87` auf Hartmannlight/inker. Keine
  uncommittierten Änderungen übertragen; keine fortdauernde Push-Freigabe.
- Finaler Root-Linuxlauf vor nachfolgendem Telemetrie-Fix: **1102/6784 grün**,
  94 Dateien, 70,41 s. Neues `inker:wp28-suite` mit Produktions-Browserlibs,
  schreibgeschütztem aktuellem Source und ohne Netzwerk. Container entfernt.
- Root Operations-/Correlation-Integration jetzt **19/240 grün**, 35,57 s,
  `.tmp/goal-wp28-integrations-final.log`; enthält Ablauf während SQLite-I/O,
  Cache-TTL und echte Query-Audits ohne BEGIN IMMEDIATE/EXCLUSIVE.
  Frontend **121 grün**, Contracts **85/1559 grün**. Expliziter Test-TS grün.
- Neue `bounded-read.ts` samt 3 Regressionstests: 2-s-Timeout, Slot bleibt
  bis tatsächlichem Settlement belegt, allSettled-Barriere für Batchfehler.
  Unabhängiger Service-Repro: 20 parallele Requests nach 2022 ms beantwortet,
  auch nach Folgescrapes nur 7 gestartete Batchqueries und eine Probe.
- Worker-Metriksamples sind interne `{owner,sample}`-Readings. TTL nach Redis-
  I/O und vor Ausgaben; Cache höchstens bis zur ältesten Sample-TTL. Interne
  monotone Deltaaggregation mit 16 Baselines, festen Familien und ohne Owner-
  Labels. Neue/reappearing Owner bilden zuerst nur eine Baseline. UI zeigt
  Live-Lifetime-Summen, Prometheus beobachtete Inkremente seit API-Prozessstart.
- Neue Betriebsdokumentation `OBSERVABILITY_OPERATIONS.md`, Abnahme offen.
- Root-Produktionsimage `inker:wp28-test` Manifest
  `6fa2c7ba871d808292457afb2a763136b2c21917543c88cd7b0bf5c425958a06` gebaut.
  Erster Smoke Exit 1: Fixture erwartete falsche MIME-Parameterreihenfolge.
  source_contract korrigierte auf MIMEType und secretfreie Assertion-Orte;
  reale Auth- und Metrics-Reads danach grün. Kein vollständiger Smoke-Erfolg.
- Root-Browserfixture per `setup` gestartet, Port 18731, State nur ignorierte
  `.tmp/wp28-operations-fixture-state.json`; `cleanup` steht noch aus. Operations-
  DOM/Layout, echte Anmeldung und gekoppeltes Referenzdisplay 1920×1080 geprüft,
  lokale Bilddaten geladen, Admin-Konsole leer. Aktuelle Browserbindings:
  `browser`, `opsTab`, `opsDisplay`, `wp28Viewport`; zwei eigene Tabs. Vor Ende
  beide schließen und Viewport resetten. Browser-Skill 26.825.32147 gelesen.
- Browserfund: `Device.lastConnectedAt` war im gesamten Backend ungeschrieben.
  isolation_review ändert ausschließlich websocket-telemetry.service.ts/test:
  `observe(..., connected=false)` puffert genaue Connectionzeit und schreibt sie
  ausschließlich beim bereits gedrosselten Telemetrieflush, keine Zusatzwrites.
  Root-Gatewayaufruf für authentifizierte Connection bereits auf `true` ergänzt.
  Reconnect darf den nächsten erlaubten Flush nicht verlieren; die Schreib-
  grenze und Shutdownregel bleiben unverändert. Weitere Tests/Build erforderlich.
- wp19_renderer und source_contract frozen; ihre letzten Edits vollständig
  integriert. Root prüft aktuell UI-Degraded durch ausschließlich eigenen
  Worker-Stopp; danach Recovery, Cleanup, neuer Build und kompletter Smoke.

## Neuester Stand nach Telemetrie-Fix

- Connection-Zeitstempel im vorhandenen Telemetrieflush implementiert und
  eingefroren. Root Gateway/Telemetrie **28 Tests/139 Assertions grün**,
  Produktionstypecheck und gezieltes ESLint grün.
- Abschließende Root-Linux-Gesamtsuite am aktuellen Source:
  **1105 Tests/6806 Assertions, 94 Dateien, 68,63 s, Exit 0**;
  `.tmp/goal-wp28-linux-final.log`. Testcontainer automatisch entfernt.
- Neuer Produktionskandidat `inker:wp28-test` Manifest
  `aa35f698f4d1c4f4f8e4431c7b1ab966ec92d7c19459c4127a4fd04c65ed9e6c`,
  Build Exit 0, `.tmp/goal-wp28-build-telemetry.log`.
- Browsernachweis am vorherigen Kandidaten: Worker fehlt, API/DB/Redis bleiben
  bereit, Worker-/Render-Metriken ausdrücklich unbekannt. Display nach echtem
  Reload bei gestopptem Worker: lokales Bild geladen, 1920×1080, DOM/Screenshot
  geprüft, Konsole leer. Einzelne Browser-Locatorprüfungen liefen in ein
  internes 3-s-Timeout; direkter DOM-Bildnachweis und separate echte WS-Probe
  bestätigten die Funktion (connected 8 ms, presentation 16 ms, Artefakt
  HTTP 200 und korrekter Hash). Kein Worker-Abhängigkeitsfehler reproduziert.
- Beide eigenen Browsertabs geschlossen, Viewport zurückgesetzt. Browserfixture
  Secret-Audit + Cleanup Exit 0; ihre State-Datei entfernt. Keine offene
  Browserbindung auf einen lebenden Tab. Browserhandle `browser` bleibt nutzbar.
- Vollständiger Smoke am neuen Kandidaten erneut Exit 1:
  `.tmp/goal-wp28-container-final.log`, Stage `worker restart, persisted
  correlation and actual WebSocket send`, Assertion in `operations()` auf
  HTTP 200 (Fixturezeile 44, Aufrufer 214). Vorherige Phase einschließlich
  Connectionzeit, Slow-Source und Worker-Stopp durchlaufen; kein gesamter
  Laufzeiterfolg. Cleanup im finally beendet. HTTP-Status/Ursache noch offen.
- source_contract ergänzt ausschließlich sichere Fixture-Fehlerdiagnostik
  (HTTP-Status, feste Logmetadaten; keine Bodies/Secrets) und führt damit einen
  erneuten eigenen Smoke zur Ursachenanalyse aus. Keine Produktionsänderungen
  ohne Rootintegration. isolation_review/wp19_renderer ansonsten frozen.
- Nächste Schritte: unerwartete Operations-HTTP-Antwort beim Recovery erklären
  und beheben, kompletten Smoke und finale Browser-Timestampansicht prüfen,
  eigene Ressourcen prüfen/entfernen, danach dokumentierte Paketabnahme.
  Noch kein WP-27/WP-28-Commit; WP-27-Testdateifreigabe weiter offen.

## Aktueller nächster Schritt nach erfolgreicher WP-28-Laufzeitprüfung

- Der instrumentierte erneute Smoke durch source_contract bestand vollständig.
  Danach Root selbst: **Exit 0**,
  `.tmp/goal-wp28-container-root-confirmation.log`. Image unverändert
  `aa35f698f4d1c4f4f8e4431c7b1ab966ec92d7c19459c4127a4fd04c65ed9e6c`.
  Keine Produktionsänderung zwischen fehlgeschlagenem und erfolgreichen Läufen.
- Root-Cleanupnachweis: gelabelte WP-28-Container-, Volume- und Netzwerklisten
  leer; `.tmp/wp28-operations-fixture-state.json` nicht vorhanden. Keine
  laufenden Root-Testprozesse oder eigenen Browsertabs verbleiben.
- Der einmalige Recovery-HTTP-Fehler bleibt als nicht reproduzierter P2 mit
  konkretem Folgecheck im WP-29-Gate dokumentiert. Kein erfundener Fix und
  kein umgedeuteter Erfolg für den fehlgeschlagenen Lauf.
- WP-28-Aufgaben im Detail erfüllt und geprüft, Index/Paketcommit noch offen:
  WP-27 und WP-28 sind im aktuellen Arbeitsbaum integriert. Unverifizierte
  WP-27-Teile dürfen nicht versehentlich mit einem WP-28-Commit akzeptiert werden.
- isolation_review erstellt jetzt nur einen READ-ONLY-Trennungsplan für einen
  eigenen isolierten WP-27-Abnahmesnapshot auf HEAD 711164f, ohne WP-28. Root
  bewahrt den gesamten Arbeitsbaum. Kein Agent darf die gesperrte neue
  `backend/test/remote-subscriptions.integration.ts` anlegen oder durch eine
  andere Datei umgehen. Diese Freigabe bleibt ausdrücklich offen.
- Anschließend vorhandene WP-27-Prüfungen am isolierten Paketstand verifizieren,
  fehlende Testdateifreigabe einholen, Paketabschlüsse und lokale Commits in
  Reihenfolge. Kein weiterer Push, Merge oder Deployment autorisiert.

## Isolierter WP-27-Paketstand in Vorbereitung

- Detached Worktree angelegt:
  `.tmp/wp27-acceptance-20260828`, Basis exakt `711164f`. Hauptbranch und
  Hauptarbeitsbaum wurden nicht zurückgesetzt oder gestasht.
- `.tmp/prepare-wp27-snapshot.ps1` kopierte nach Manifest-/Pfad-/Clean-Checks
  ausschließlich 39 freigegebene WP-27-Quell-/Testdateien. Keine `node_modules`,
  `.prisma`, `dist`, Secrets oder ignorierten Fixture-State-Dateien kopiert.
  Dieses Skript erwartet einen sauberen Snapshot und darf nicht blind erneut
  ausgeführt werden.
- `.tmp/strip-wp28-from-wp27.ps1` entfernte erfolgreich genau die WP-28-Hunks
  aus Schema, Migrationsliste, Contracts-Export, Compose-Logging und zwei
  Frontend-Routingdateien. Diese Transformation ist bereits durchgeführt.
- isolation_review bearbeitet ausschließlich vier Dateien IM SNAPSHOT:
  `outbox-dispatcher.service.ts` (von HEAD nur Remote-Integration),
  `remote-job.ts`, `remote-job.test.ts`, `remote-worker.service.ts` (ohne
  WP-28-Correlation). Hauptarbeitsbaum-Dateien bleiben unangetastet.
- Nächster Rootschritt nach Agent-Freeze: Hunk-/Importreview, eigener Dockerbuild
  aus diesem Snapshot mit frisch erzeugten Contracts/Prisma, vorhandene WP-27-
  Suiten und Drei-Server-Smoke mit explizit neuem `INKER_SMOKE_IMAGE`.
- Die gesperrte neue SQLite-Integrationsdatei bleibt auch im Snapshot nicht
  vorhanden. Isolierte vorhandene Tests ersetzen diese fehlende Abnahme nicht.

## Fortsetzung: isolierte WP-27-Verifikation

- Root entfernte im Snapshot auch das nach der Zeilenextraktion verbliebene
  Operations-Navigationsobjekt. Haupt-UI unverändert.
- Unabhängiges Read-only-Review durch isolation_review: keine Findings zur
  WP-27-Vollständigkeit oder WP-28-Abhängigkeit; 30 vollständig übernommene
  Dateien hashidentisch, zehn gemischte Dateien korrekt getrennt. Architektur
  6.8/7/8/Phase 8 und ADR-001/002/003/004/006/007/009 abgeglichen.
- Produktionsimage `inker:wp27-isolated-test` und Backend-Testbasis
  `inker:wp27-isolated-unit` werden aus dem Snapshot neu gebaut. Logs:
  `.tmp/goal-wp27-isolated-build.log`, `.tmp/goal-wp27-isolated-unit-build.log`.
  Builds/Tests erst nach bestätigtem Exitcode als bestanden werten.
- Die verweigerte SQLite-Testdatei wurde weiterhin nicht angelegt. Kein
  Paketabschluss, Commit oder weiterer Push erfolgt.

## Isolierte WP-27-Prüfungen abgeschlossen, Testfreigabe weiterhin offen

- Alle gestarteten Prüfungen beendet; keine laufenden Root-Testprozesse.
  Produktionsbuild, Backend-Testbasis, kombinierte Browser-Testbasis und
  Frontend-Testimage: Exit 0. Produktionsimage-ID
  `3f2e3dd6d083d378143ec222328315e3fdd56d6dbed1d63187c400721ffc8f4f`.
- Linux-Backend 1028 Tests / 4916 Assertions / 83 Dateien / 69,27 s;
  Frontend 107 / 16 Dateien; Contracts 70 / 1209; Migrationen 14 / 250.
  Logs jeweils `.tmp/goal-wp27-isolated-{linux,frontend,contracts,migrations}.log`.
- Expliziter Test-Typecheck zuerst rot: Rotationstest verwendete `number`
  statt der Literaltypen 90/180/270. Ausschließlich `as const` in
  `snapshot-renderer.test.ts` in Haupt- und Prüfarbeitsbaum ergänzt.
  Danach Typecheck Exit 0 (`...-types-final.log`), gezieltes ESLint Exit 0
  (`...-lint.log`) und echte Renderertests 12 / 71 (`...-renderer-final.log`).
  Produktionsimage unverändert, da keine Produktionslogik geändert wurde.
- Vollständiger Drei-Server-Smoke Exit 0 (`...-smoke.log`), exakt isoliertes
  Image explizit über `INKER_SMOKE_IMAGE`. Neustart-Recovery 29627 ms,
  Conditional-304 A: 2/B: 3. Keine Last-/Kapazitätsfreigabe daraus ableiten.
  Secret-Audit und fixtureeigener Cleanup bestanden; Root bestätigte leere
  WP-27-Fixture-Container/Volumes/Netzwerke sowie Unit-/Check-Containerlisten.
  Fixture-State im Snapshot nicht mehr vorhanden.
- Der isolierte Worktree und seine Buildartefakte bleiben erhalten. Keine
  Hauptdateien zurückgesetzt, nichts gestasht, kein Commit und kein neuer Push.
- `remote-subscriptions.integration.ts` existiert weder im Haupt- noch im
  Prüfarbeitsbaum. Vor erneutem Anlegen ist die ausdrücklich angeforderte
  Nutzerfreigabe nötig. Danach fehlende reale SQLite-Rollback-, Konkurrenz-
  und Claim-/Versionsfence-Prüfungen, abschließende Regression/Review,
  WP-27-Abnahme und getrennte lokale Paketcommits. WP-29-Gate bleibt von
  WP-27/WP-28-Abnahme abhängig; Hardwareprüfungen weiterhin offen.

## Abschluss nach erteilter Testfreigabe

Die vorstehenden Aussagen zur nicht vorhandenen Testdatei und zum gesperrten
Anlegeversuch sind historisch. Nutzerfreigabe erteilt; Datei in Haupt- und
Prüfarbeitsbaum bytegleich vorhanden und vollständig geprüft. WP-27 abgenommen.
Root-Läufe und Ergebnisse siehe aktueller Status am Dokumentanfang.
Produktionsquellen seit dem isolierten Image unverändert, nur Tests/Dokumentation
ergänzt. Eigene SQLite-Testcontainer automatisch entfernt, keine laufenden Tests.

Kein Foundation-Abschluss behauptet. WP-28 und WP-29 sind noch offen.
