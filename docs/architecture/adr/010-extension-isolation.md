# ADR-010 – Ausführungsgrenze für Drittanbieter-Erweiterungen

- Status: Offen
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Externe Connectoren und Erweiterungen können blockieren, abstürzen oder
unerwarteten Code ausführen. [ADR-006](006-api-worker-separation.md) schließt ihre
Ausführung im API-Prozess und impliziten Zugriff auf Provider-Tokens aus. Die
konkrete Isolationstiefe beeinflusst Erweiterbarkeit, Betrieb und Sicherheit.

## Entscheidung

Noch offen ist, ob Drittanbieter-Erweiterungen ausschließlich deklarativ, in
beschränkten Subprozessen oder in eigenen Containern laufen. Bis zur Entscheidung
wird kein generischer Drittanbietercode als vertrauenswürdig oder in-process
ladbar zugesagt. Er muss außerhalb des API-Prozesses bleiben, harte Zeit- und
Ressourcengrenzen besitzen und nur explizit zugewiesene Secrets erhalten.

Die Wahl wird vor dem ersten echten Drittanbieter-Connector anhand eines
adversarialen Test-Connectors getroffen. Bewertet werden Abbruch, Prozess-Cleanup,
Speicher-/CPU-Grenzen, Netzwerkzugriff, Secret-Sichtbarkeit und die Anforderungen
der unterstützten Deploymentplattformen.

## Folgen

- Die API-/Worker-Grenze kann unabhängig von der späteren Sandboxtechnik
  implementiert werden.
- Eine öffentliche Plugin-API wird bis zum Isolationstest nicht versprochen.
- Stärkere Isolation kann zusätzliche Prozesse, Images und Betriebsaufwand
  erfordern.

## Alternativen

- **Nur deklarative Erweiterungen:** besitzen die kleinste Angriffsfläche, begrenzen
  aber Integrationsmöglichkeiten.
- **Beschränkte Subprozesse:** sind portabel und leichter als Container, bieten aber
  nur die Isolation des Hostbetriebssystems.
- **Eigene Container:** erlauben stärkere Ressourcen- und Netzwerkgrenzen, erhöhen
  aber Deployment- und Plattformkomplexität.
