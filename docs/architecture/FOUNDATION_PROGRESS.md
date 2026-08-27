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
2. WP-19 abgenommen: Render-Key/Sharp-Renderer, atomarer privater Artefaktstore,
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
   unready machen. Noch keine WP-20-Implementierung.
4. Danach bis WP-29 in Indexreihenfolge; keine unerfüllten Gates überspringen.

Kein Foundation-Abschluss behauptet. WP-20 bis WP-29 sind noch offen.
