# Architecture Decision Records

Die ADRs konkretisieren den
[`ARCHITECTURE_PLAN.md`](../ARCHITECTURE_PLAN.md). Für eine einzelne technische
Entscheidung ist das jeweilige akzeptierte ADR verbindlich. Widerspricht ein ADR
dem Architekturplan, muss der Widerspruch durch ein neues ADR aufgelöst werden;
stilles Abweichen ist nicht zulässig.

Statuswerte:

- `Vorgeschlagen`: zur Entscheidung vorbereitet, aber noch nicht verbindlich
- `Akzeptiert`: verbindliche aktuelle Entscheidung
- `Abgelehnt`: geprüft und nicht gewählt
- `Ersetzt`: durch ein neueres ADR abgelöst
- `Offen`: bewusst noch nicht entschieden; dokumentierte Annahmen gelten nur bis
  zur Verifikation

Neue ADRs entstehen aus [`000-template.md`](000-template.md), erhalten die nächste
freie dreistellige Nummer und werden nach der Annahme nicht inhaltlich
umgeschrieben. Änderungen werden in einem neuen ADR festgehalten, das das alte
ersetzt.

## Entscheidungen

| ADR | Status | Entscheidung |
| --- | --- | --- |
| [001](001-sqlite-postgresql-boundary.md) | Akzeptiert | SQLite-Start und PostgreSQL-Migrationsgrenze |
| [002](002-redis-bullmq-job-transport.md) | Akzeptiert | Redis/BullMQ als Jobtransport, nicht als Facharchiv |
| [003](003-explicit-publishing.md) | Akzeptiert | Explizites Publish-Modell mit unveränderlichen Versionen |
| [004](004-hub-federation.md) | Akzeptiert | Hub-Föderation über den Home-Server |
| [005](005-short-code-pairing.md) | Akzeptiert | Kurzcode-Pairing als einmaliger Bootstrap |
| [006](006-api-worker-separation.md) | Akzeptiert | Logische API-/Worker-Trennung ab dem ersten Deployment |
| [007](007-snapshot-only-rendering.md) | Akzeptiert | Renderer lesen ausschließlich persistierte Snapshots |
| [008](008-hardware-assumptions.md) | Offen | Hardwaredetails bleiben bis zur Messung Annahmen |
| [009](009-local-http-policy.md) | Offen | Richtlinie für HTTP-Pairing im lokalen Netz |
| [010](010-extension-isolation.md) | Offen | Ausführungsgrenze für Drittanbieter-Erweiterungen |
