# ADR-002 – Redis/BullMQ als Jobtransport, nicht als Facharchiv

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

BullMQ und Redis sind als technische Basis vorhanden. Externe Abrufe, Rendering,
Delivery, Timer und Wartung benötigen Concurrency-Limits, Retries und verzögerte
Ausführung. Eine Queue allein bietet aber keine ausreichende fachliche
Transaktions- und Aufbewahrungsgrenze.

## Entscheidung

Redis/BullMQ transportiert und koordiniert rekonstruierbare Arbeit. Die
Queue-Gruppen sind `source-refresh`, `render`, `delivery`, `timer` und
`maintenance`. Jeder Jobvertrag ist versioniert und definiert mindestens einen
idempotenten Schlüssel, Timeout und Abbruchsignal, Retry/Backoff mit Jitter,
Concurrency- und Rate-Limits sowie einen geheimnisfreien strukturierten Fehler.

Die Datenbank bleibt Quelle der Wahrheit. Fachliche Absicht, Fälligkeit, Status und
Outbox-Ereignis werden vor dem Enqueueing dauerhaft gespeichert. Ein Dispatcher
überträgt Outbox-Ereignisse an BullMQ; Wiederholung und Deduplizierung müssen nach
Prozess- oder Redis-Ausfall sicher sein. Queue-Inhalt, Locks, Presence und
Verbindungslisten dürfen verloren gehen, ohne Timer, Pairings, Publications,
Snapshots oder ausstehende Aktionen zu verlieren.

### Ergänzung WP-27 (2026-08-28)

Remote-Publication-Abonnements verwenden zusätzlich die Queue `remote-sync`.
Ihr eigenes Budget schützt Source-Refresh und andere Jobgruppen vor langsamen
Remote-Servern: ein lokaler, zwei globale Jobs, höchstens einer pro Remote und
Abonnement, 20 Sekunden Jobfrist bei 15 Sekunden Gesamt-Netzwerkfrist. Claim-
Budgets und Versionsfences werden in SQLite geprüft; Redis bleibt rekonstruierbar.
Dies erweitert die Jobgruppen für ADR-004, nicht die Persistenzentscheidung.

## Folgen

- Redis-Ausfall darf bestehende Manifeste und Artefakte nicht unlesbar machen;
  neue Hintergrundarbeit wartet bis zur Wiederherstellung.
- Worker können unabhängig skaliert und mit pro Jobtyp begrenzter Parallelität
  betrieben werden.
- Outbox-Dispatcher, Recovery und Idempotenz sind notwendige Folgearbeit.
- Queue-Aufbewahrung dient Diagnose und Retry, nicht der fachlichen Historie.

## Alternativen

- **BullMQ als alleinige Persistenz:** vereinfacht den ersten Schreibpfad, verliert
  aber die atomare Verbindung zwischen Fachzustand und Auftrag.
- **Nur Datenbank-Polling:** reduziert Infrastruktur, verzichtet aber auf die
  vorhandenen Scheduling-, Retry- und Concurrency-Funktionen.
- **In-Process-Queues:** sind für Neustart, mehrere Prozesse und Lastisolation
  ungeeignet.
