# ADR-004 – Hub-Föderation über den Home-Server

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Ein Display soll Inhalte aus lokalem Smart Home, eigenem Internetserver und
Servern anderer Personen darstellen können. Direkte Verbindungen jedes Displays
zu jedem Server vervielfachen Credentials, Fehlerfälle und Offline-Caches.

## Entscheidung

Die erste Föderationsform ist ein Hub-Modell. Jedes Display verbindet sich im
Normalfall nur mit seinem Home-Server. Der Home-Server abonniert einen
versionierten, read-only Publication-Feed anderer StatusPanel-Server, speichert die
letzte gültige Remote-Version lokal und liefert sie über seine normalen Gerätepfade
aus.

Ein Remote-Abonnement besitzt eine kanonische HTTPS-Basis-URL, stabile Server-ID,
Protokollversion mit Capability-Negotiation und ein widerrufbares Credential, das
genau eine Publication lesen darf. Abrufe verwenden `ETag`/Conditional GET und
laufen über einen begrenzten Worker. URL-Normalisierung, Allowlist, Redirect-,
Größen-, DNS-/Private-IP- und DNS-Rebinding-Schutz sind Teil der Vertrauensgrenze.

Die erste Version teilt fertige Publications, keine normalisierten
Source-Snapshots. Direkte Multi-Server-Verbindungen des Displays bleiben eine
spätere Protokolloption und werden noch nicht implementiert.

## Folgen

- Displays benötigen nur ein Geräte-Credential und einen lokalen Fehlerpfad.
- Der Home-Server übernimmt Trust-Anzeige, Widerruf, Offline-Cache und
  Protokollkompatibilität.
- Remote-Inhalte sind eventuell veraltet und müssen als solche sichtbar sein.
- Der Hub wird zusätzliche Betriebsverantwortung, aber kein Besitzer fremder
  Provider-Secrets.

## Alternativen

- **Display verbindet sich direkt mit allen Servern:** reduziert Hubarbeit, erhöht
  aber Credential-, UI-, Netzwerk- und Diagnosekomplexität auf jedem Gerät.
- **Gemeinsame zentrale Cloud:** vereinfacht Discovery, widerspricht aber dem
  selbst gehosteten Vertrauensmodell.
- **Source-Snapshots sofort föderieren:** ermöglicht lokale Neu-Renderings, erweitert
  jedoch Datenschutz-, Schema- und Secret-Grenzen zu früh.
