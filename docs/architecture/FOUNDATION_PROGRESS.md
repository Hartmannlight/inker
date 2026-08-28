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
  Lokaler WP-28-Commit folgt. Testbelege unter `.tmp/goal-wp28-*.log`, die Datei
  `goal-wp28-container-final.log` ist ein alter FEHLERlauf, kein Abnahmebeleg.

## Nächste Schritte

1. Verifizierten WP-28-Stand ohne Secrets/ignorierte Artefakte lokal committen.
2. WP-29: vollständige Anforderungen, Architekturabschnitt 12 und Abschnitt 9
   abgleichen; kombinierte Last-/Fault-/Security-/Migration-/Restore-Prüfung.
3. Mindestens 20 dauerhafte WS-Displays gemeinsam mit Batterie-/Fast-Pull,
   Touch, langsamen/fehlerhaften Sources und Renderlast tatsächlich betreiben.
4. Nachweise, Grenzwerte, P0/P1/P2 und Betriebs-/Release-Checkliste versionieren.
   Keine Foundation-Freigabe vor erfüllten Gates; physische Hardware offen lassen.

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
