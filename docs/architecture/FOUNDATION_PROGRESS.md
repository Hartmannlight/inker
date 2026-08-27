# Foundation-Goal – Fortsetzungsstand

Stand: 2026-08-28. Verbindlicher Auftrag: WP-00 bis WP-29 und Abschnitt 12 des
Architekturplans vollständig verifizieren. Paketweise fortsetzen, lokale Commits
nach Abnahme; kein Push, Merge oder Deployment. Hardwaremessungen offen ausweisen.

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

- WP-11 und WP-14 sind in `e1a7bee` bzw. `2f3ff2b` implementiert; offene
  Indexmarkierungen werden gegen Code/Tests geprüft, nicht erneut implementiert.
- WP-11-Review fand eine konkrete Text-Redaction-Lücke bei API-Key-Aliasen,
  serialisiertem JSON und Basic Authorization. Korrigiert und durch Hauptagent
  verifiziert: 569 Backendtests, sieben Redaction-/vier Startupintegrationen,
  Typecheck, Build und gezieltes Lint bestanden; Index geschlossen.
- WP-14: gezielte HTTP-/SQLite-/Restart-Prüfung bestätigt vorhandene Umsetzung;
  physische Firmwaremessungen bleiben offen wie im bestehenden Handoff.
- WP-19: vollständiges Paket, zugehörige Architektur und ADR-001/002/003/007
  gelesen. Renderer-Subtask getrennt von Cache-/Persistenzintegration.
  GETs bleiben ohne SQL-Writes. Dauerhafte, deduplizierte Renderabsicht und
  Outbox vor Queue; Artefakte außerhalb des öffentlichen Uploadverzeichnisses.

## Nächste Schritte

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
   Testcontainer/Volumesbereinigt. WP21abgenommen,lokalerCommitfolgt.
5. Danach bis WP-29 in Indexreihenfolge; keine unerfüllten Gates überspringen.

Kein Foundation-Abschluss behauptet. WP-22 bis WP-29 sind noch offen.
