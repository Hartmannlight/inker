# ADR-006 – Logische API-/Worker-Trennung ab dem ersten Deployment

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Login, Editor, Pairing und die Auslieferung vorhandener Manifeste dürfen nicht von
langsamen Providern, Rendering oder nicht abbrechbaren Bibliotheken blockiert
werden. Kleine Installationen sollen dennoch nicht mehrere Deployments betreiben
müssen.

## Entscheidung

API/Control Plane und Job-/Source-Worker besitzen getrennte Module,
Bootstrap-Einstiegspunkte, Queue-Verträge, Abhängigkeiten und
Concurrency-Grenzen. Sie dürfen anfangs im selben Docker-Deployment laufen, müssen
aber ohne fachlichen Umbau als getrennte Prozesse startbar sein.

Die API validiert und persistiert fachliche Absichten und veröffentlicht sie über
Outbox und Queue. Provider-Zugriffe, Source-Refresh, Rendering, Delivery-Retries und
Wartungsarbeit laufen im Worker. Blockierende oder nicht zuverlässig abbrechbare
Arbeit läuft zusätzlich in Worker-Threads oder Subprozessen. Unbekannter
Plugin-Code läuft niemals im API-Prozess und erhält keine Provider-Tokens. Die
konkrete Ausführungsgrenze für Drittanbieter-Erweiterungen ist seit WP-22 im
akzeptierten [ADR-010](010-extension-isolation.md) festgelegt.

Ein Worker-Ausfall darf Read-Pfade für bereits publizierte Manifeste und Artefakte
nicht stoppen. Die Datenbank ist gemäß [ADR-001](001-sqlite-postgresql-boundary.md)
die dauerhafte Übergabegrenze; BullMQ ist gemäß
[ADR-002](002-redis-bullmq-job-transport.md) der rekonstruierbare Jobtransport.

## Folgen

- Ein gemeinsames Einsteiger-Deployment bleibt möglich, während Last- und
  Fehlerisolation vorbereitet sind.
- Bootstrap, Health-Status und Shutdown müssen API und Worker getrennt abbilden.
- Gemeinsame In-Process-Zustände dürfen nicht für fachliche Koordination verwendet
  werden.
- Separate Hosts lösen gemäß ADR-001 die PostgreSQL-Migrationsgrenze aus.

## Alternativen

- **Ein monolithischer Prozess ohne Modulgrenzen:** ist anfangs kompakt, koppelt
  jedoch API-Latenz und Stabilität an externe Arbeit.
- **Sofort getrennte Deployments erzwingen:** bietet stärkere Isolation, erhöht aber
  die Einstiegshürde kleiner Installationen.
- **Alle Arbeit synchron in Requests ausführen:** verletzt Timeout-, Concurrency-
  und Verfügbarkeitsziele.
