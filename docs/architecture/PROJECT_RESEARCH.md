# StatusPanel – Evaluation bestehender Projekte

Stand: 1. August 2026

## Kurzentscheidung

`czuryk/Waveshare-ePaper-10.85-dashboard` sollte **nicht** die technische
Basis für StatusPanel werden. Das Projekt ist eine gute Referenz für konkrete
Datenquellen und den Betrieb eines Waveshare-Displays, ist aber kein zentraler
Dashboard-Server und besitzt derzeit keine erkennbare Open-Source-Lizenz.

Der stärkste Kandidat ist [`usetrmnl/inker`](https://github.com/usetrmnl/inker).
Nach einer vertieften Codeprüfung empfehlen wir einen Fork als Editor-,
Rendering- und Device-Basis. Vor sensiblen Quellen wie Gmail muss jedoch die
OAuth-, Credential- und Source-Schicht umgebaut werden. Die Einzelheiten stehen
in [`INKER_DEEP_DIVE.md`](INKER_DEEP_DIVE.md).

## 1. Waveshare-ePaper-10.85-dashboard

Repository:
[`czuryk/Waveshare-ePaper-10.85-dashboard`](https://github.com/czuryk/Waveshare-ePaper-10.85-dashboard)

### Was daran wertvoll ist

- funktionierender Betrieb auf Raspberry Pi Zero 1W/2W
- angepasster Waveshare-Treiber und partielle Display-Updates
- interessante Integrationen: Open-Meteo, Gmail, Codex, Claude, Strava,
  Bambu Lab, Roborock und Last.fm/Spotify
- getrennte Hintergrundabfragen mit einem gemeinsamen aktuellen Datenzustand
- Erfahrungen mit Ghosting, Full Refresh und Hardware-Timeouts
- gutes visuelles Referenzdesign für das konkrete 10,85-Zoll-Panel

### Warum es nicht als Basis passt

- Es ist eine Anwendung für genau ein lokal angeschlossenes Display, kein
  zentraler Multi-Device-Server.
- Datenabruf, globale Zustände, Pillow-Rendering, Hardwaretreiber und
  Gerätekonfiguration befinden sich zusammen in `main.py`.
- Auflösung und Layout sind für das konkrete Panel programmiert.
- Widgets werden über Konstanten im Python-Code aktiviert; es gibt keinen
  visuellen Editor, kein persistiertes Dashboardmodell und keine Profile.
- Es gibt keine HTTP-Auslieferung für Browser, Bilder oder Geräte.
- Im Root liegen weder Paket-/Lock-Konfiguration, Tests, Datenbankmodell noch
  Deploymentdefinition.
- `codex.py` verwendet einen nicht dokumentierten ChatGPT-Endpunkt und kopierte
  Codex-Login-Tokens. Das ist als private Integration interessant, aber keine
  stabile öffentliche Provider-Schnittstelle.
- Das Repository enthält am Prüfdatum keine `LICENSE`-Datei und GitHub zeigt
  keine Lizenz an. Ohne Lizenz gelten die normalen Urheberrechte; öffentlich
  sichtbar bedeutet nicht, dass abgeleitete Werke verbreitet werden dürfen.

### Empfehlung dazu

- Nicht forken und nicht kopieren.
- Als Funktions- und Hardware-Referenz verwenden.
- Den Autor um eine ausdrückliche Lizenz bitten, falls einzelne
  Integrationen oder Treiber übernommen werden sollen.
- Die Integrationen später sauber gegen unsere Source-Schnittstelle neu
  implementieren.

## 2. Inker

Repository: [`usetrmnl/inker`](https://github.com/usetrmnl/inker)

### Übereinstimmung mit unserem Ziel

Inker 0.6.0 bietet bereits:

- zentralen selbst gehosteten Server
- React-basierten Screen Designer mit Drag-and-drop, Größenänderung,
  Snap-Guides, Zeichnen und Zoom
- frei registrierbare BYOD-Geräte und benutzerdefinierte Auflösungen
- Geräte, Modelle, Screens, Playlists, Logs und Status
- eingebaute Widgets wie Uhr, Datum, Kalender, Text, Wetter, QR-Code, Bild,
  Batterie, WLAN und Geräteinformationen
- JSON-API- und RSS-Datenquellen mit Cache und Fehlerzustand
- benutzerdefinierte Widgets und Liquid-Markup
- Pluginmodell mit Polling, Webhooks/Static-Konzept, Einstellungs-Schema,
  verschlüsselten Secrets und OAuth-Feldern
- Chromium/Puppeteer-Rendering und Bildkonvertierung über Sharp
- TRMNL-kompatible Geräte-API sowie 1-Bit- und 16-Graustufen-Modelle
- Docker-Deployment, SQLite und ARM64-Unterstützung

Der Stack besteht aus TypeScript, NestJS, Prisma/SQLite, React, Vite, Bun,
Puppeteer und Sharp.

### Stärken

- Es spart wahrscheinlich mehrere Monate Editor-, Render- und
  Geräteverwaltungsarbeit.
- Das Datenmodell besitzt bereits die richtigen Grundobjekte: Source, Plugin,
  PluginInstance, WidgetTemplate, ScreenDesign, ScreenWidget, Model und Device.
- Das Projekt wird aktuell weiterentwickelt; Version 0.6.0 erschien am
  30. Juli 2026.
- Es ist nicht ausschließlich an originale TRMNL-Hardware gebunden.
- Die im README genannten 432 Backend- und 19 Frontendtests sind für ein
  junges Projekt ein gutes Signal.

### Risiken und notwendige Änderungen

- Inker steht unter AGPL-3.0. Bei einem modifizierten, über ein Netzwerk
  angebotenen Dienst muss der entsprechende Quellcode den Nutzern zugänglich
  gemacht werden. Das ist für ein offenes Projekt gut, für eine spätere
  proprietäre Variante möglicherweise ungeeignet.
- Das Projekt ist jung: am Prüfdatum nur 20 Commits und wenige Maintainer.
- Die Authentifizierung besteht primär aus einer Admin-PIN. Vor einer
  Internetfreigabe benötigen wir Sessions, Benutzerverwaltung, CSRF-Schutz,
  sichere Defaults und ein klares Berechtigungsmodell.
- Standardwerte `ADMIN_PIN=1111` und ein Fallback-Verschlüsselungsschlüssel
  dürfen bei StatusPanel nicht erlaubt sein.
- Benutzerdefinierte Quellen dürfen beliebige URLs inklusive lokaler Ziele
  abrufen. Das ist für einen vertrauenswürdigen Homelab-Admin gewollt, wird bei
  mehreren Benutzern aber zum SSRF-Risiko.
- Plugin-Transformationen werden mit `AsyncFunction` als JavaScript im
  Serverprozess ausgeführt. Ein Timeout beendet den Code nicht zuverlässig und
  bietet keine Sicherheitsisolation. Drittanbieter-Code muss in einen Worker,
  Subprozess oder Container ausgelagert oder zunächst ganz verboten werden.
- Der Datenabruf ist teilweise noch eng mit dem Plugin verbunden. Unser Ziel
  verlangt langfristig wiederverwendbare Source-Instanzen, die mehrere Widgets
  versorgen können.
- Das Rendering ist stark auf E-Ink/TRMNL ausgerichtet. Live-HTML, Farb-LCD,
  JPEG, gerätespezifische Paletten und stabile öffentliche Slug-URLs müssen
  ergänzt oder generalisiert werden.
- SQLite ist für eine persönliche Installation passend, aber die jüngste
  Entfernung von PostgreSQL erschwert späteres Multi-Instance-Hosting.

### Empfehlung dazu

Inker sollte zunächst **nicht blind geforkt**, sondern in einem kurzen
technischen Spike ausgeführt und erweitert werden. Wenn AGPL und der
TypeScript-Stack akzeptabel sind, ist ein Inker-Fork der schnellste Weg zu
einem funktionsfähigen StatusPanel.

Der Fork sollte sich anfangs auf folgende Änderungen beschränken:

1. StatusPanel-Begriffe und Device Profiles ergänzen, ohne das TRMNL-Protokoll
   zu entfernen.
2. Dashboard per stabiler Slug-URL als HTML und PNG bereitstellen.
3. Datenquelle und Darstellung im Kernmodell sauberer trennen.
4. generische RGB-, Graustufen-, 1-Bit- und feste E-Ink-Paletten einführen.
5. Geräte-Tokens und Conditional GET (`ETag`, `If-None-Match`) ergänzen.
6. unsichere Defaults entfernen und Plugin-Ausführung isolieren.
7. eine erste eigene Quelle und ein eigenes Widget Ende-zu-Ende implementieren.

## 3. Weitere Kandidaten

### TRMNL Terminus

Repository: [`usetrmnl/terminus`](https://github.com/usetrmnl/terminus)

- sehr aktiver und wesentlich reiferer zentraler BYOS-Server
- Geräte, Screens, Playlists, Erweiterungen, Modelle, Paletten, Firmware,
  Benutzer, Jobs, API, Docker und Rendering sind vorhanden
- MIT-Lizenz
- Ruby/Hanami, PostgreSQL, Sidekiq, Valkey, htmx, ImageMagick und Chrome
- mehr Betriebsaufwand und deutlich größerer Codebestand
- auf TRMNL-Workflows und Liquid-Plugins ausgerichtet; kein vergleichbarer
  frei positionierbarer Screen Designer als zentrales Merkmal

**Eignung:** beste reife Referenz für Device-API, Modellverwaltung, Jobs und
TRMNL-Kompatibilität. Als Fork interessant, wenn MIT wichtiger ist als der
gewünschte React-Editor und Ruby/Hanami akzeptiert wird.

### TRMNL BYOS FastAPI

Repository:
[`usetrmnl/byos_fastapi`](https://github.com/usetrmnl/byos_fastapi)

- MIT-Lizenz, Python/FastAPI, SQLAlchemy und SQLite
- zentrale Device-/Playlist-Verwaltung, Plugin-Scheduler und TRMNL-API
- sehr gute E-Ink-Bildaufbereitung, Dithering und BMP/PNG-Ausgabe
- bewusst nur minimale Verwaltungsoberfläche
- keine Multi-User-Sicherheit, kein visueller Dashboardeditor, wenige Plugins
- sehr jung und klein

**Eignung:** gute MIT-lizenzierte Backend- und Rendering-Referenz. Sinnvoll als
Basis, falls Python/FastAPI gesetzt ist und wir den gesamten Editor selbst
bauen möchten. Gegenüber Inker bleibt wesentlich mehr Produktarbeit übrig.

### topi314/esphome-dashboard

Repository:
[`topi314/esphome-dashboard`](https://github.com/topi314/esphome-dashboard)

- Apache-2.0-Lizenz
- kleiner Go-Server mit Docker
- holt Home-Assistant-Entitäten, Kalender und Serviceantworten
- rendert Go-HTML-Templates als HTML, PNG, JPEG oder BMP
- liefert eine ESPHome-Konfiguration für ESP32/Waveshare mit
  Seitenumschaltung
- kein Editor, keine frei konfigurierbaren Quellen, keine Benutzer- oder
  umfassende Geräteverwaltung

**Eignung:** sehr gute Referenz für die einfache Server-zu-ESPHome-Strecke und
die Ausgabeformate, aber zu schmal als Produktbasis.

### kyleturman/home-dashboard

Repository:
[`kyleturman/home-dashboard`](https://github.com/kyleturman/home-dashboard)

- MIT-Lizenz
- Node-Server sammelt Daten, rendert HTML/CSS, erzeugt ein 1-Bit-PNG und liefert
  es an einen ESP32-Client aus
- besitzt Admin-Seite, JSON-API, Servicezustände und einen Arduino-Referenzclient
- nur zwei Commits; laut README nicht aktiv gepflegt
- festes Dashboard statt Framework/Editor

**Eignung:** gute Referenz für unseren vertikalen MVP-Schnitt, aber keine
nachhaltige Fork-Basis.

### InkyPi

Repository: [`fatihak/InkyPi`](https://github.com/fatihak/InkyPi)

- etabliertes Python-Projekt mit Weboberfläche, Plugins, Tests und vielen
  unterstützten Raspberry-Pi/Waveshare/Pimoroni-Displays
- GPL-3.0
- Architektur ist weiterhin überwiegend ein Raspberry Pi pro lokalem Display
- Plugins werden als Playlist nacheinander gezeigt; kombinierte modulare
  Layouts stehen noch auf der Roadmap

**Eignung:** wertvolle Referenz für Plugin-UX und Hardwaretreiber, aber nicht
die gewünschte zentrale Multi-Device-Architektur.

### MagicMirror²

Repository:
[`MagicMirrorOrg/MagicMirror`](https://github.com/MagicMirrorOrg/MagicMirror)

- sehr reifes Modulsystem und großes Ökosystem für Informationsanzeigen
- auf live im Browser/Electron ausgeführte Smart-Mirror-Oberflächen optimiert
- kein geräteprofiliertes statisches Rendering, kein Bild-Polling-Protokoll und
  kein visueller Layouteditor für kleine E-Ink-Geräte

**Eignung:** Inspiration und mögliche Datenintegrationen, nicht Produktbasis.

### OpenEPaperLink

Repository:
[`OpenEPaperLink/OpenEPaperLink`](https://github.com/OpenEPaperLink/OpenEPaperLink)

- ausgereiftes Firmware-/Access-Point-System für Electronic Shelf Labels
- viele kleine, sehr stromsparende E-Paper-Tags und Home-Assistant-Integration
- Schwerpunkt ist Funkprotokoll, Access Point und Tag-Hardware statt ein
  universelles Dashboard-Framework

**Eignung:** späterer Device-Adapter für ESL-Tags, nicht der zentrale Server.

## 4. Empfohlener Entscheidungsweg

### Bevorzugter Weg

1. Inker lokal unverändert starten.
2. Einen frei auflösbaren Browser-Screen und einen ESP32-/E-Ink-Screen anlegen.
3. Eine JSON-Quelle anbinden und das gleiche Datum in zwei Widgets verwenden.
4. HTML- und PNG-Ausgabe sowie Rendergleichheit überprüfen.
5. Einen Prototyp für stabile Slug-URL, Geräteprofil und ETag implementieren.
6. Danach bewusst entscheiden: Upstream-Beiträge, dauerhafter AGPL-Fork oder
   eigener Clean-Room-Kern.

### Wann wir Inker forken sollten

- StatusPanel soll Open Source bleiben und AGPL ist akzeptiert.
- TypeScript/NestJS/React/Bun sind ein gewünschter Stack.
- schnelle Nutzbarkeit ist wichtiger als vollständige architektonische
  Kontrolle.
- E-Ink bleibt ein Hauptanwendungsfall, auch wenn Farb-LCD und Web dazukommen.

### Wann wir selbst bauen sollten

- proprietäre oder anders lizenzierte Nutzung ist absehbar.
- Python/FastAPI ist eine harte Vorgabe.
- Multi-Tenant-Cloudbetrieb gehört früh zum Produkt.
- isolierte Drittanbieter-Plugins sind ein zentrales Alleinstellungsmerkmal.
- Web- und Farbdisplays sind wichtiger als TRMNL-/E-Ink-Kompatibilität.

In diesem Fall sollten wir trotzdem nicht bei null beginnen: TRMNLs
Geräteprotokoll und Firmware, BYOS FastAPI für Bildausgabe/Dithering,
topi314 für ESPHome und die Integrationsideen des Waveshare-Projekts können als
getrennte, lizenzkonforme Referenzen dienen.

## 5. Vorläufiges Urteil

**Waveshare-Projekt:** nicht forken.

**StatusPanel komplett neu bauen:** erst dann, wenn AGPL oder Inkers Stack nach
dem Spike tatsächlich ausschließen.

**Aktuell beste Option:** Inker als Ausgangsbasis evaluieren und bei positivem
Spike forken. Funktional liegt es wesentlich näher an der Produktidee als alle
anderen geprüften Projekte.

## Quellen

- <https://github.com/czuryk/Waveshare-ePaper-10.85-dashboard>
- <https://github.com/usetrmnl/inker>
- <https://github.com/usetrmnl/terminus>
- <https://github.com/usetrmnl/byos_fastapi>
- <https://github.com/topi314/esphome-dashboard>
- <https://github.com/kyleturman/home-dashboard>
- <https://github.com/fatihak/InkyPi>
- <https://github.com/MagicMirrorOrg/MagicMirror>
- <https://github.com/OpenEPaperLink/OpenEPaperLink>
- <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository>
