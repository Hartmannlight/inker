# ADR-007 – Renderer lesen ausschließlich persistierte Snapshots

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Externe Provider sind langsam, fehleranfällig und benötigen Secrets. Würde ein
Renderer während eines Displayabrufs Provider abfragen, wären Renderausgabe,
Latenz und Cache-Key vom momentanen Netzwerkzustand abhängig.

## Entscheidung

Connector-Worker erzeugen validierte, normalisierte und persistierte
`SourceSnapshot`-Versionen. Renderer lesen ausschließlich diese Snapshots und
starten niemals Provider-, Connector- oder andere externe Datenabfragen.
Provider-Secrets bleiben im Connector-Worker.

Ein Snapshot enthält mindestens Schema- und Connector-Version, Erstell- und
Quellzeit, Freshness sowie Fehler-/Stale-Status. Bei einem Abruffehler bleibt der
letzte gültige Snapshot mit sichtbarer `stale`-Kennzeichnung nutzbar. Der
Render-Key referenziert konkrete Snapshot-Versionen; identische Inputs teilen ein
Artefakt.

Snapshot-Metadaten und die für veröffentlichte Inhalte benötigten Snapshot-Daten
sind dauerhafter Fachzustand. Sie dürfen nicht ausschließlich in RAM, Cache oder
Queue leben.

## Folgen

- Rendering ist deterministisch, deduplizierbar und unabhängig von
  Provider-Latenz.
- Source-Freshness und Render-Freshness sind getrennte, beobachtbare Zustände.
- Snapshots benötigen Schema-Versionierung, Retention und Schutz sensibler
  normalisierter Daten.
- Aktualität entsteht durch geplante Source-Refresh-Jobs, nicht durch Display-GETs.

## Alternativen

- **Providerzugriff im Renderer:** spart das Snapshot-Modell, blockiert aber
  Displays und vermischt Secrets, Datenabruf und Rendering.
- **Nur flüchtiger Snapshot-Cache:** ist schnell, verliert aber Restart-Fallback und
  reproduzierbare Publications.
- **Providerrohdaten unverändert speichern:** vermeidet Normalisierung, koppelt
  Renderer jedoch an externe Schemas und kann unnötige Geheimnisse persistieren.
