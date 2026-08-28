# StatusPanel – Architektur- und Umsetzungsplan

Stand: 24. August 2026  
Ausgangsbasis: Inker `0.6.0` auf Commit `83c72b0`

Operative Abarbeitung: [`WORK_PACKAGES.md`](WORK_PACKAGES.md) zerlegt diesen Plan
in geordnete, einzeln in einem neuen Chat ausführbare Arbeitspakete mit
Abhängigkeiten, Abnahmekriterien, Tests und Handoff-Format.

Verbindliche Einzelentscheidungen und bewusst offene Annahmen stehen im
[ADR-Index](adr/README.md). Änderungen am Zielbild werden dort als neue,
nachvollziehbare Entscheidung dokumentiert.

## 1. Ziel und Vorgehen

StatusPanel soll als selbst gehosteter Server unterschiedliche Displays versorgen,
ohne Datenquellen, Widgets, Rendering und Geräteprotokolle fest miteinander zu
verdrahten. Die Architektur wird deshalb zuerst stabilisiert; konkrete Widgets und
echte E-Mail-, Smart-Home- oder Grafana-Integrationen folgen erst, wenn die
Kernverträge belastbar sind.

Wir entwickeln keinen vollständigen Neubau. Der vorhandene Inker-Editor, die
Playlist-/Screen-Verwaltung und das Rendering bleiben die Ausgangsbasis. Die noch
uncommittierte Geräteplattform ist ein guter Spike, wird aber vor dem Ausbau an den
unten definierten Grenzen ausgerichtet.

### Annahmen für die erste belastbare Version

- Eine Installation gehört zunächst einem Administrator beziehungsweise Haushalt.
- Es gibt einen logischen StatusPanel-Server. API, Hintergrund-Worker und Renderer
  dürfen darin als getrennte Prozesse laufen.
- Die erste Lastgrenze sind mindestens 20 gleichzeitig registrierte Displays.
- Ein Neustart darf Verbindungen unterbrechen, aber keine Timer, Pairings,
  Veröffentlichungen oder geplanten Datenabrufe verlieren.
- Langsame oder fehlerhafte externe Dienste dürfen UI und Display-Auslieferung
  nicht blockieren.
- Breaking Changes an Datenbank, API und der aktuellen Web-Display-Implementierung
  sind jetzt ausdrücklich erlaubt.
- Widgets sind nicht Teil der aktuellen Foundation-Arbeit. Die Foundation muss
  unbekannte zukünftige Widget-Typen aber über versionierte Verträge aufnehmen
  können.

## 2. Scope

### Enthalten

- Geräteprofile und Geräteinstanzen für E-Ink, ESP32-Touch und Browser/Kiosk
- Pull-, Push- und interaktive Geräteprotokolle
- einfache, sichere Geräteanmeldung mit kurzer Einmal-Pairing-ID
- dauerhafte Zustände, Events, Timer und Geräteaktionen
- getrennte API-, Job-, Source-, Rendering- und Delivery-Pfade
- versionierte Veröffentlichungen, Render-Cache und Conditional GET
- vorbereitete Source-/Snapshot-Architektur für viele parallele externe Abfragen
- vorbereitete Server-zu-Server-Abonnements
- versionierte Datenbankmigrationen, Tests, Lasttests und Betriebsdiagnostik
- Behebung der bereits gefundenen Probleme im aktuellen Fork

### Nicht enthalten

- konkrete neue Widgets
- produktive Gmail-, Home-Assistant-, Grafana- oder Wetter-Connectoren
- öffentliche Erweiterungs-/Widget-Marktplätze
- echtes Multi-Tenant-SaaS mit unabhängigen Organisationen
- Hochverfügbarkeit über mehrere StatusPanel-Serverinstanzen
- fertige ESP32-Firmware; ihre Verträge und ein Referenzclient gehören jedoch zum
  Plan

## 3. Zielgeräte und abgeleitete Anforderungen

| Gerät | Normaler Transport | Verhalten | Architekturfolge |
|---|---|---|---|
| TRMNL BYOD 7.5, Batterie | HTTP Pull | lange Schlafphasen, seltene Updates | Kein dauerhafter Socket; `ETag`, `If-None-Match`, kleine Manifeste, fertiges E-Ink-Bild und toleranter Offline-Zustand |
| TRMNL BYOD 7.5, Netzbetrieb | HTTP Pull mit kürzerem Intervall | deutlich häufigere Updates, aber abhängig von der Firmware nicht zwingend echtes Push | Dieselbe Geräteidentität, andere Delivery Policy; keine künstliche Vermischung von Gerätetyp und Strommodus |
| ESP32-S3 4" IPS Touch 86 Box | WebSocket plus HTTP-Fallback | dauerhaft online, farbig, interaktiv | Push-Manifeste, separat ladbare Assets, Heartbeat, reconnectbarer Zustand und authentifizierte Touch-Aktionen |
| Raspberry Pi Zero 2W mit HD-TV | Browser/Kiosk über WebSocket und HTTP | dauerhaft online, HTML/Bild möglich | Web-Display-Profil, automatische Wiederverbindung, Fullscreen/PWA-Kiosk und optional clientseitige Animation |

Wichtig: Gerätetyp, Displayeigenschaften, Energieprofil und Transport sind vier
verschiedene Dinge. Ein TRMNL im Netzbetrieb bleibt dasselbe Gerät, verwendet aber
eine andere Aktualisierungsrichtlinie.

## 4. Verbindliche Architekturprinzipien

1. **Datenabruf ist nicht Rendering.** Connectoren erzeugen validierte Snapshots;
   Renderer lesen nur gespeicherte Snapshots.
2. **Rendering ist nicht Auslieferung.** Renderer erzeugen versionierte Artefakte;
   Transportadapter liefern Manifeste oder Artefakte an Geräte.
3. **Geräte melden Fähigkeiten, keine Produktannahmen.** Auflösung, Farbtiefe,
   Formate, Touch, Audio, Energieprofil und Transport sind explizite Capabilities.
4. **Lesen verändert keine fachliche Version.** GET/Manifest-Aufrufe erhöhen keine
   Revision und schalten keine Playlist implizit weiter.
5. **Dauerhafter Zustand liegt nicht nur im RAM.** Timer, gewünschte Darstellung,
   Pairings, Veröffentlichungen und ausstehende Aktionen überleben Neustarts.
6. **Externe Arbeit läuft begrenzt und fehlertolerant.** Jede Quelle hat Timeout,
   Concurrency-Limit, Retry-Policy, Circuit Breaker und letzten gültigen Snapshot.
7. **Displays erhalten keine Provider-Secrets.** Ein Gerät sieht nur publizierte
   Inhalte und für es erlaubte Aktionen.
8. **Kurze Codes dienen nur zum Bootstrap.** Nach erfolgreichem Pairing erhält das
   Gerät automatisch ein hochentropisches, widerrufbares Credential.
9. **Verträge sind versioniert.** Device-, Presentation-, Interaction-, Source- und
   Federation-Protokolle tragen eine explizite Versionsnummer.
10. **Ein Feature besitzt eine fachliche Quelle der Wahrheit.** Gemeinsame
    Berechnungen werden nicht unabhängig in Frontend und Backend kopiert.

## 5. Zielbild

```text
                              ┌──────────────────────────┐
                              │ Admin UI / Editor        │
                              └────────────┬─────────────┘
                                           │ HTTPS
┌─────────────────────┐       ┌────────────▼─────────────┐
│ Displays            │◄─────►│ API / Control Plane      │
│ - TRMNL Pull        │ HTTP  │ Auth, Config, Commands   │
│ - ESP32 WebSocket   │ WS    └────────────┬─────────────┘
│ - Pi Browser/Kiosk  │                    │ Transaktion + Outbox
└──────────┬──────────┘       ┌────────────▼─────────────┐
           │                  │ Persistenter Zustand     │
           │ Manifest/Asset   │ DB + versionierte Daten  │
           │                  └──────┬──────────┬────────┘
           │                         │          │
           │                  ┌──────▼────┐ ┌──▼──────────────┐
           └──────────────────│ Delivery  │ │ Job/Source Worker│
                              │ + Cache   │ │ Limits, Retries  │
                              └──────┬────┘ └──┬───────────────┘
                                     │         │
                              ┌──────▼────┐ ┌──▼────────────────┐
                              │ Renderer  │ │ Externe Dienste   │
                              │ HTML/Bild │ │ Mail/HA/Grafana   │
                              └───────────┘ └───────────────────┘
```

API und Worker können anfangs in einem Docker-Deployment gebündelt sein. Sie
verwenden trotzdem getrennte Module, Queues und Concurrency-Grenzen, damit sie
später ohne fachlichen Umbau in eigene Prozesse verschoben werden können.

## 6. Kernmodell und Verträge

### 6.1 DeviceProfile

Beschreibt eine wiederverwendbare Geräteklasse, nicht ein konkretes Gerät.

- Auflösung und Pixeldichte
- Farbraum, Farbtiefe und unterstützte Bildformate
- Rotation, Safe Area und Skalierung
- unterstützte Renderer: `html`, `png`, `jpeg`, `bmp1`, später Raw-Formate
- Interaktionen: `touch`, `buttons`, optional später `audio`
- empfohlene minimale Aktualisierungsrate
- E-Ink-spezifische Grenzen wie Full-Refresh-Intervall

Profile für die erste Foundation:

- `trmnl-byod-7.5-mono`
- `esp32-s3-86box-480x480-rgb-touch` nach Verifikation der echten Auflösung
- `browser-hd-1920x1080`

### 6.2 Device

Beschreibt eine konkrete registrierte Instanz.

- stabile interne ID und optional menschenlesbarer Name
- Referenz auf ein DeviceProfile
- Transport Policy und Energieprofil
- zugewiesene Publication/Playlist
- gewünschte und zuletzt bestätigte Revision
- zuletzt gesehen, zuletzt ausgeliefert und letzter Fehler
- Capabilities-Override nur für echte Abweichungen vom Profil
- ein oder mehrere rotierbare DeviceCredentials

Auflösung und Capabilities werden nicht gleichzeitig in mehreren unkoordinierten
Feldern gepflegt. Das Profil ist Standard, ein klar benannter Override ist die
einzige Abweichung.

### 6.3 TransportAdapter und DeliveryPolicy

Ein Transportadapter übernimmt Verbindung und Protokoll, nicht das Rendering.

- `PullHttpAdapter`: TRMNL/BYOD, Conditional GET und fertige Bildartefakte
- `WebSocketAdapter`: ESP32 und Browser, Push eines kleinen Manifests
- optional später `MqttAdapter`, ohne Änderungen am Dashboardmodell

Eine DeliveryPolicy legt Aktualisierungsverhalten fest:

- `sleepy`: lange Polling-Intervalle, minimale Telemetrie
- `responsive-pull`: kurzes Polling für TRMNL am Netzteil
- `connected`: dauerhafte Verbindung mit Reconnect und Heartbeat

### 6.4 Publication und PresentationManifest

Ein Dashboard wird nicht direkt aus seinem Entwurfszustand ausgeliefert. Ein
expliziter Publish-Vorgang erzeugt eine unveränderliche Publication-Version.

Das Manifest enthält mindestens:

- `protocolVersion`
- Publication-ID und Inhaltsrevision
- Device/Profile-Variante
- Liste referenzierter Artefakte mit URL, MIME-Type, Größe, Hash und `ETag`
- Gültigkeits-/Refresh-Hinweise
- nächster fachlicher Übergangszeitpunkt
- erlaubte Interaktionen
- optional Fallback auf die letzte bekannte Revision

Ein Abruf des Manifests ist idempotent. Playlist-/Rotationszustand wird von einer
separaten, deterministischen Zustandsmaschine berechnet und gespeichert.

### 6.5 SourceDefinition und SourceSnapshot

Die spätere Connector-Schicht wird jetzt nur als Vertrag vorbereitet.

- `SourceDefinition`: Typ, Konfiguration, Secret-Referenzen, Intervall,
  Timeout, Concurrency-Gruppe und Schema-Version
- `SourceSnapshot`: validierte normalisierte Daten, Erstellzeit, Quellzeit,
  Freshness, Fehlerstatus und Connector-Version
- Renderer lesen ausschließlich Snapshots und starten niemals externe Requests.
- Bei Fehlern bleibt der letzte gültige Snapshot mit `stale`-Kennzeichnung nutzbar.
- Provider-Secrets verlassen den Connector-Worker nicht.

### 6.6 InteractionEvent und Command

Touch-Geräte senden keine beliebigen Serveraufrufe, sondern versionierte Events:

- Geräte-ID und Credential
- eindeutige `eventId` für Idempotenz
- Publication-/Widget-Instanz
- Aktion, zum Beispiel `timer.create`, `timer.pause`, `view.next`
- validiertes Payload-Schema
- Zeitstempel und optional Clientsequenz

Der Server autorisiert die Aktion anhand der publizierten Oberfläche. Ein Widget
darf nur die Aktionen auslösen, die seine Publication ausdrücklich freigibt.

### 6.7 Timer als erste interaktive Referenzdomäne

Timer werden serverseitig dauerhaft gespeichert und nicht sekündlich hoch- oder
heruntergezählt.

- Zustand: `running`, `paused`, `completed`, `cancelled`
- `startedAt`, `endsAt`, `pausedRemainingMs`, Erstellergerät und Sichtbarkeit
- Befehle: erstellen, pausieren, fortsetzen, abbrechen, quittieren
- Alle Befehle sind idempotent.
- Clients berechnen die sichtbare Restzeit aus `endsAt` und Serverzeit lokal.
- Der Server plant nur den Abschlusszeitpunkt dauerhaft ein und sendet dann ein
  Zustandsereignis.
- Nach Neustart werden überfällige Timer abgeschlossen und zukünftige Timer neu
  eingeplant.
- E-Ink sieht beim nächsten Pull den aktuellen Zustand; verbundene Displays
  erhalten sofort einen Push.

Damit prüfen Timer früh, ob Persistenz, Aktionen, Push/Pull und mehrere Displays
sauber zusammenspielen, ohne schon eine allgemeine Widgetplattform zu bauen.

### 6.8 RemoteServer und RemoteSubscription

Für Inhalte von mehreren StatusPanel-Servern wird zunächst ein Hub-Modell
empfohlen:

```text
Remote StatusPanel ── read-only Publication Feed ──► eigener StatusPanel
                                                        │
                                                        ▼
                                                    lokale Displays
```

Das Display besitzt normalerweise nur eine Verbindung zu seinem Home-Server.
Der Home-Server abonniert Veröffentlichungen von Smart-Home-, Internet- oder
Freundes-Servern. Das vereinfacht Credentials, Offline-Caching, Layout und
Fehlerdiagnose.

Ein Remote-Abonnement benötigt:

- kanonische HTTPS-Basis-URL
- stabile Remote-Server-ID
- read-only, auf genau eine Publication begrenztes Credential
- Protokollversion und Capability-Negotiation
- `ETag`/Conditional GET und lokal gespeicherte letzte gültige Version
- Allowlist, DNS-/Private-IP-Regeln und Schutz vor SSRF/DNS-Rebinding
- sichtbaren Vertrauensstatus, letzte Synchronisation und Widerruf

Direkte Mehrfachverbindungen eines Panels zu mehreren Servern bleiben als spätere
Option im Protokoll möglich, sind aber nicht der erste Implementierungsweg.

## 7. Authentifizierungs- und Pairingmodell

Es werden getrennte Identitäten verwendet:

1. **Administrator:** kurzlebige Session, HttpOnly/Secure/SameSite-Cookie,
   CSRF-Schutz und später optional mehrere Benutzer.
2. **Display-Gerät:** eigenes widerrufbares Credential mit minimalen Rechten.
3. **Connector:** serverintern gespeicherte Provider-Credentials; niemals auf
   Displays.
4. **Remote-Abonnement:** read-only und auf eine Publication begrenzt.
5. **Erweiterung:** eigene Vertrauensstufe; kein impliziter Zugriff auf Secrets.

### Pairing ohne langes Abtippen

1. Im Admin-UI wird ein Pairing-Vorgang für eine Geräteklasse erzeugt.
2. Der Server zeigt einen 10-stelligen Code aus verwechslungsarmem Crockford
   Base32, zum Beispiel `7K4M-9Q2D-XP`.
3. Am Gerät werden nur Basis-URL und Code eingegeben. Alternativ kann ein QR-Code
   denselben Bootstrap transportieren.
4. Das Gerät sendet den Code über TLS an den Server.
5. Der Code ist einmalig, höchstens zehn Minuten gültig, serverseitig gehasht und
   streng rate-limitiert.
6. Nach Erfolg erhält das Gerät automatisch ein langes zufälliges Credential und
   speichert es lokal. Dieses Credential wird nie abgetippt.
7. Pairing-Code und vorherige Credentials werden atomar verbraucht beziehungsweise
   widerrufen.

Zehn Base32-Zeichen liefern rund 50 Bit Zufall. In Verbindung mit kurzer
Gültigkeit, Einmalverwendung und Rate-Limit ist das für den Bootstrap ausreichend;
es ersetzt nicht das dauerhafte Geräte-Credential. Ohne HTTPS darf dieses Verfahren
nur in einem ausdrücklich als vertrauenswürdig markierten lokalen Netz verwendet
werden.

## 8. Job-, Concurrency- und Fehlerkonzept

BullMQ/Redis kann als vorhandene technische Basis bleiben, erhält aber einen klaren
fachlichen Auftrag. Die Datenbank bleibt Quelle der Wahrheit; die Queue ist kein
dauerhaftes Facharchiv.

Geplante Queue-Gruppen:

- `source-refresh`: externe APIs, Mail, Home Assistant, Grafana
- `render`: HTML/Bild-Erzeugung und Formatkonvertierung
- `delivery`: Push-Benachrichtigungen und Wiederholungen
- `timer`: dauerhafte zeitgesteuerte Aktionen
- `maintenance`: Cleanup, Rotation und Diagnose

Jeder Jobtyp definiert:

- idempotenten Job-Key
- hartes Timeout und Abbruchsignal
- maximale Versuche und Backoff mit Jitter
- globale und providerbezogene Concurrency
- Rate-Limit und Circuit Breaker
- strukturierten Fehler ohne Secret-Inhalte
- Dead-Letter-/Failed-Job-Ansicht

Blockierende oder nicht zuverlässig abbrechbare Bibliotheken laufen in einem
Worker-Thread oder separaten Prozess. Unbekannter Plugin-Code läuft niemals im
API-Prozess und erhält keine Provider-Tokens.

Für 20 Displays werden keine 20 identischen Renderings parallel erzeugt. Ein
Render-Key besteht aus Publication-Version, Profil, Snapshot-Versionen und
Renderer-Version. Gleiche Anfragen teilen sich dasselbe gecachte Artefakt.

## 9. Bekannte Probleme des aktuellen Forks

| Problem | Auswirkung | Behebung im Plan |
|---|---|---|
| Neuer Pairing-Link wird bei vorhandenem Browser-Credential ignoriert | Widerrufenes Web-Display kann sich im selben Browser nicht neu verbinden | Phase 3 |
| WebSocket-Verbindungen und Übergangstimer liegen nur im RAM | Neustart verliert Timer; mehrere Prozesse sehen nicht dieselben Verbindungen | Phasen 4 und 7 |
| Presentation-Abruf erhöht Revision und schreibt Wiedergabestatus | unnötige SQLite-Schreiblast, nicht idempotente GETs, Race Conditions | Phase 5 |
| Event-Dispatcher startet Promises ohne Fehlerpfad | unbehandelte Fehler und verlorene Updates | Phase 4 |
| Screen-Design-Update kann doppelte Pushes auslösen | doppelte Renderings und künstliche Revisionen | Phase 4 |
| Keine Prisma-Migrationen, nur `db push` mit ignorierten Fehlern | unkontrollierte Schemaänderungen und möglicher Start mit kaputter DB | Phase 2 |
| Driver-Registry ist fest verdrahtet und Interface beschreibt fast nur Defaults | neue Transporte benötigen Änderungen an mehreren Kernstellen | Phase 4 |
| Gerätedaten und Capabilities können doppelt und widersprüchlich gespeichert werden | unklarer Gerätezustand | Phase 2 |
| Days-Until-Berechnung existiert fast doppelt in Frontend und Backend | spätere fachliche Abweichungen | Phase 1 beziehungsweise Widget-Arbeit nach der Foundation |
| Admin-PIN, lokale Bearer-Tokens und unsichere Default-Secrets | nicht für Internetbetrieb oder sensible Connectoren geeignet | Phase 3 |
| Plugin-Code kann im Serverprozess laufen und Tokens sehen | Blockierung und Credential-Exfiltration möglich | Phase 6 |
| Äußeres `StatusPanel`-Repository enthält zwei verschachtelte Git-Repositories | unklarer Commit-/Release-Umfang | Phase 0 |

## 10. Sequenzieller Umsetzungsplan

Jede Phase endet mit einem Gate. Die nächste Phase beginnt erst, wenn dieses Gate
erfüllt ist. Dadurch bleibt das Projekt nach jedem Schritt verständlich und
testbar.

### Phase 0 – Repository und Arbeitsstand sichern

**Warum:** Der komplette aktuelle Spike ist uncommittiert und liegt in einer
verschachtelten Git-Struktur. Vor Breaking Changes braucht es eine eindeutige,
wiederherstellbare Basis.

- [ ] Entscheiden, ob `StatusPanel` das eigentliche Repository wird oder
  `StatusPanel/inker` der alleinige Fork bleibt.
- [ ] Die zweite Upstream-Arbeitskopie aus dem zukünftigen Repository auslagern
  oder konsequent ignorieren.
- [ ] Konzeptdokumente in einen eindeutigen `docs/architecture/`-Bereich
  überführen.
- [ ] Den aktuellen Spike auf einem eigenen Branch sichern.
- [ ] Lockfile-Rauschen von fachlichen Änderungen trennen.
- [ ] Bestehende Änderungen in nachvollziehbare Themenblöcke aufteilen:
  Geräteplattform, Web-Display, Pairing, Days-Until und Dokumentation.
- [ ] Bun-Version und Installationsweg verbindlich dokumentieren.

**Gate:** Ein Repository, ein Branch, reproduzierbare Installation, sauberer
Status und ein eindeutiger Vergleich zu Upstream.

### Phase 1 – Architekturverträge und ADRs festschreiben

**Warum:** Breaking Changes sind jetzt günstig. Ohne explizite Verträge wächst der
aktuelle Spike sonst über String-Felder und Sonderfälle weiter.

- [x] Architecture Decision Records für SQLite/PostgreSQL-Grenze, Redis/BullMQ,
  Hub-Föderation, Publish-Modell und Geräte-Pairing erstellen.
- [ ] Versionierte TypeScript-Verträge für DeviceProfile, DeviceCapabilities,
  PresentationManifest, InteractionEvent, Command und SourceSnapshot definieren.
- [ ] Verträge in ein frameworkunabhängiges Paket beziehungsweise einen
  gemeinsamen `contracts`-Bereich legen.
- [ ] JSON Schema oder eine gleichwertige Laufzeitvalidierung für Netzwerkgrenzen
  festlegen.
- [ ] Frontend, Backend und spätere Firmware-Clients aus denselben Protokollschemas
  ableiten.
- [ ] Kompatibilitätsregeln für `protocolVersion` dokumentieren.
- [ ] Einen kleinen Contract-Test-Harness für gültige und ungültige Nachrichten
  anlegen.

**Gate:** Die drei Zielgeräte lassen sich allein über Profile, Policies und
Capabilities ausdrücken; kein Vertrag erwähnt ein konkretes Widget.

### Phase 2 – Datenmodell und Migrationen stabilisieren

**Warum:** Alle späteren Bereiche hängen an zuverlässiger Persistenz und
reproduzierbaren Upgrades.

- [ ] Das aktuelle Prisma-Schema in Profile, Geräte, Credentials, Publications,
  Outbox und Zustandsrevisionen überführen.
- [ ] Doppelte Felder zwischen Device und `capabilities` entfernen oder als klaren
  Override modellieren.
- [ ] Freie Strings für bekannte Zustände durch geprüfte Enums/Constraints
  ersetzen.
- [ ] Eine Baseline-Migration für bestehende Inker-Installationen erstellen.
- [ ] Jede folgende Schemaänderung als versionierte Vorwärtsmigration anlegen.
- [ ] Containerstart auf `prisma migrate deploy` umstellen und bei Fehlern hart
  abbrechen.
- [ ] Backup-/Restore-Test inklusive bestehender SQLite-Daten erstellen.
- [ ] SQLite WAL, Busy Timeout und kurze Transaktionen konfigurieren.
- [ ] Eine dokumentierte PostgreSQL-Migrationsgrenze definieren, aber PostgreSQL
  noch nicht erzwingen.

**Gate:** Leere und bestehende Testdatenbanken migrieren reproduzierbar; ein
fehlgeschlagenes Upgrade startet die Anwendung nicht.

### Phase 3 – Authentifizierung, Pairing und Secret-Grenzen

**Warum:** Geräte und spätere Mail-/Remote-Server-Zugänge brauchen voneinander
getrennte Vertrauensbereiche.

- [ ] Die Admin-PIN durch eine echte Setup- und Session-Authentifizierung mit
  sicheren Cookies ersetzen.
- [ ] Default-PIN und Default-Verschlüsselungsschlüssel beim Start verbieten.
- [ ] Instanzschlüssel außerhalb der SQLite-Datenbank erzeugen und rotierbar
  speichern.
- [ ] PairingEnrollment mit zehnstelligem Code, TTL, Hash, Versuchszähler und
  atomarem Consume implementieren.
- [ ] Pairing per Eingabe und QR-Code unterstützen.
- [ ] Geräterecht auf Manifest lesen, Telemetrie senden und erlaubte Commands
  beschränken.
- [ ] Credential-Rotation, Widerruf und Verlust eines Geräts abbilden.
- [ ] Den aktuellen Re-Pairing-Fehler des Web-Displays beheben.
- [ ] Pairing-, Replay-, Rate-Limit- und Race-Condition-Tests erstellen.

**Gate:** An einem neuen Gerät müssen nur Basis-URL und kurzer Code eingegeben
werden; danach kann das Credential einzeln widerrufen und sicher ersetzt werden.

### Phase 4 – Geräteplattform und Transportadapter refaktorieren

**Warum:** Pull, WebSocket und Interaktionen müssen austauschbare Delivery-Wege
sein, nicht Sonderfälle in `DevicesService`.

- [ ] DeviceDriver in Profile Resolver, TransportAdapter und DeliveryPolicy
  aufteilen.
- [ ] Adapter über NestJS-Provider registrieren statt die Registry bei jedem
  Gerätetyp manuell zu ändern.
- [ ] TRMNL Pull und Web-Display WebSocket auf dieselben Manifest-/Statusverträge
  umstellen.
- [ ] WebSocket-Authentifizierung, Heartbeat, tote Verbindungserkennung,
  Payload-Schemas und Nachrichtendrosselung ergänzen.
- [ ] Telemetrie puffern/drosseln, statt jeden Ping als Datenbankschreibvorgang zu
  speichern.
- [ ] Event-Verarbeitung mit Fehlerpfad, Deduplizierung und Korrelations-ID
  versehen.
- [ ] Eine Transaktions-Outbox für fachliche Änderungen einführen.
- [ ] Outbox-Ereignisse über Redis an den zuständigen Delivery-Prozess verteilen.
- [ ] Pull-Fallback für dauerhaft verbundene Geräte definieren.
- [ ] Referenzabläufe für Batterie-TRMNL, Netz-TRMNL, ESP32 und Pi-Browser testen.

**Gate:** Dieselbe Publication erreicht alle vier Betriebsvarianten, ohne dass
Rendering oder Dashboardcode den Transporttyp kennen.

### Phase 5 – Publish, Presentation und Render-Cache

**Warum:** Displays müssen schnell und deterministisch bedient werden, auch wenn
Quellen oder Renderer gerade langsam sind.

- [ ] Entwurf und unveränderliche Publication-Version trennen.
- [ ] Presentation-Aufrufe read-only und idempotent machen.
- [ ] Playlist-/Rotationszustand als eigene deterministische Zustandsmaschine
  implementieren.
- [ ] Render-Key aus Publication, Profil, Snapshots und Renderer-Version bilden.
- [ ] Gleichzeitige identische Render-Jobs deduplizieren.
- [ ] Artefakte atomar speichern und erst nach Erfolg veröffentlichen.
- [ ] `ETag`, `If-None-Match`, Hash, MIME-Type und Größenmetadaten ausliefern.
- [ ] Letztes gültiges Artefakt während Fehlern weiter ausliefern.
- [ ] E-Ink-sichere Mindestintervalle und Full-Refresh-Hinweise in DeliveryPolicy
  berücksichtigen.
- [ ] Cache-Invalidierung ausschließlich durch relevante Versionsänderungen
  auslösen.

**Gate:** 20 gleichartige Displayanfragen lösen höchstens ein Rendering aus;
unveränderte Pull-Geräte erhalten `304 Not Modified`.

### Phase 6 – Worker- und Source-Fundament

**Warum:** Spätere Mail-, Smart-Home- und Grafana-Abfragen dürfen weder API noch
Rendering blockieren.

- [x] API- und Worker-Bootstrap logisch und optional prozessseitig trennen.
- [x] Queue-Konfiguration zentralisieren und Jobverträge versionieren.
- [x] Globale, providerbezogene und connectorbezogene Concurrency-Grenzen
  implementieren.
- [x] Timeout, Abbruch, Retry mit Jitter und Circuit Breaker standardisieren.
- [x] SourceDefinition, Secret-Referenz und SourceSnapshot persistieren.
- [x] Snapshot-Schema und Freshness-/Stale-Regeln implementieren.
- [x] Einen Fixture-/Demo-Connector ohne externe Credentials bauen.
- [x] Einen absichtlich langsamen und fehlerhaften Testconnector bauen.
- [x] Nicht abbrechbare Arbeit in Worker-Threads/Subprozesse verschieben.
- [x] Generischen Plugin-Code vom API-Prozess und von Provider-Tokens isolieren.

**Gate:** Ein hängender Testconnector beeinflusst Login, Editor, Manifestabruf und
bereits gerenderte Displays nicht.

Nachweis: abgenommene Handoffs WP-20 bis WP-22 in `WORK_PACKAGES.md`, einschließlich
echter Docker-/Redis-/Browserprüfung und beendeter adversarialer Kindprozesse.

### Phase 7 – Interaktionen und persistente Timer

**Warum:** Timer sind ein kleiner, aber vollständiger Test für Touch, Befehle,
Persistenz, Zeit und mehrere Displays.

- [x] Versionierte InteractionEvents und Command-Ergebnisse implementieren (WP-23).
- [x] Event-IDs deduplizieren und Wiederholungen idempotent beantworten (WP-23).
- [x] Publication-spezifische Aktionsrechte prüfen (WP-23).
- [ ] Persistentes Timer-Modell und Zustandsautomat implementieren.
- [ ] Timerabschluss als durable Queue-Aufgabe planen.
- [ ] Timer nach Neustart rekonstruieren und überfällige Abschlüsse nachholen.
- [ ] Serverzeit/-offset an Clients liefern; Countdown lokal aus `endsAt`
  darstellen.
- [ ] Timerzustand an alle berechtigten verbundenen Displays pushen.
- [ ] Pull-Geräten beim nächsten Abruf denselben Zustand liefern.
- [ ] Parallel-, Doppel-Tap-, Offline-, Neustart- und Uhrabweichungstests
  erstellen.

**Gate:** Ein ESP32 erzeugt einen Timer, der auf Pi-Browser und späterem
TRMNL-Pull konsistent erscheint und einen Serverneustart überlebt.

### Phase 8 – Server-zu-Server-Abonnements

**Warum:** Lokales Smart Home, eigener Internetserver und ein Freundeserver sollen
Inhalte teilen können, ohne Displays mit mehreren Administrationszugängen zu
belasten.

- [ ] Einen minimalen versionierten Publication-Feed definieren.
- [ ] Read-only ShareCredential auf genau eine Publication begrenzen.
- [ ] RemoteServer und RemoteSubscription persistieren.
- [ ] HTTPS-Verifikation, URL-Normalisierung und Vertrauensanzeige implementieren.
- [ ] Remote-Manifeste per Conditional GET und begrenztem Worker abrufen.
- [ ] Remote-Artefakte lokal cachen und bei Ausfall weiterverwenden.
- [ ] SSRF-, DNS-Rebinding-, Redirect- und Größenlimits übernehmen.
- [ ] Konflikte zwischen lokalen und Remote-Namen eindeutig darstellen.
- [ ] Widerruf, Ablauf und Protokollinkompatibilität sichtbar behandeln.
- [ ] Direkte Multi-Server-Verbindung am Display nur dokumentieren, noch nicht
  implementieren.

**Gate:** Der Home-Server kann je eine Test-Publication von zwei Remote-Servern
abonnieren und auch bei deren Ausfall die letzte gültige Version liefern.

### Phase 9 – Last, Betrieb und Freigabegate

**Warum:** Architekturqualität wird erst unter Fehlern, Neustarts und Parallelität
sichtbar.

- [ ] Einen Lasttest mit 20 dauerhaften WebSocket-Displays erstellen.
- [ ] Einen kombinierten Test mit Pull-, WebSocket- und Touch-Geräten erstellen.
- [ ] Parallele langsame Source-Jobs während Displayabrufen simulieren.
- [ ] Grenzwerte für API-Latenz, Queue-Alter, Renderdauer und Speicher festlegen.
- [ ] Metriken für Sources, Jobs, Render-Cache, WebSockets, Pairing und Gerätealter
  erfassen.
- [ ] Strukturierte Logs mit Request-, Job-, Device- und Correlation-ID ausgeben.
- [ ] Health-, Readiness- und Degraded-Status trennen.
- [ ] Backup, Restore, Migration und Neustart mit aktiven Timern testen.
- [ ] Sicherheitsprüfung für öffentliche Endpunkte und Secret-Redaction
  durchführen.
- [ ] Docker-Deployment und Betriebsdokumentation aktualisieren.

**Gate:** Alle Zielgeräte und 20 simulierte Displays bleiben während langsamer
Sources und eines kontrollierten Worker-Neustarts nutzbar; keine Secrets erscheinen
in Logs oder Geräteantworten.

## 11. Teststrategie

- **Contract-Tests:** Protokollbeispiele laufen gegen Backend, Webclient und später
  ESP32-Referenzclient.
- **Unit-Tests:** Zustandsautomaten, Pairing, Timer, Profilauflösung, Rotation und
  Cache-Keys mit kontrollierter Uhr.
- **Integrationstests:** echte SQLite-/Redis-Instanzen, Migrationen, Outbox und
  Queue-Retries.
- **End-to-End-Tests:** Admin erstellt Gerät, Pairing, Publish, Push/Pull,
  Credential-Rotation und Offline-Wiederkehr.
- **Fault-Tests:** externe Timeouts, kaputte Renderer, Redis-Neustart,
  Datenbank-Busy, verlorene WebSockets und Serverneustart.
- **Lasttests:** 20 Displays plus konfigurierbare Source- und Renderlast.
- **Security-Tests:** Rate Limits, Replay, widerrufene Tokens, SSRF, Redirects,
  Schema-Fuzzing und Secret-Redaction.

CI muss mindestens TypeScript-Typecheck, Frontend- und Backendtests,
Prisma-Migrationsprüfung, Contract-Tests und einen Docker-Smoke-Test ausführen.

## 12. Erfolgskriterien der Foundation

Die Foundation ist abgeschlossen, wenn:

- alle drei Geräteklassen ohne Sonderlogik im Dashboardmodell beschrieben sind;
- Batterie-Pull, schneller Pull und WebSocket denselben veröffentlichten Zustand
  erhalten;
- 20 Displays parallel bedient werden, ohne identische Renderarbeit zu
  vervielfachen;
- externe langsame Jobs API und Displayauslieferung nicht blockieren;
- Pairing nur Basis-URL plus kurzen Einmalcode benötigt;
- Credentials getrennt, widerrufbar und minimal berechtigt sind;
- Timer und ausstehende Aktionen Neustarts überleben;
- Publications versioniert, cachebar und per `ETag` abrufbar sind;
- ein Remote-Abonnement ohne direkten Gerätezugang möglich ist;
- Datenbankänderungen ausschließlich über getestete Migrationen erfolgen;
- Browser- und Backendberechnungen gemeinsame Verträge beziehungsweise
  gemeinsame fachliche Implementierungen nutzen;
- der aktuelle Fork keine der in Abschnitt 9 gelisteten offenen P1/P2-Probleme
  mehr enthält.

## 13. Noch offene, aber nicht blockierende Entscheidungen

- Exakte Auflösung, Controller und Netzwerkstack der ESP32-S3 86 Box verifizieren.
- Klären, ob wir den ESP32-Client im selben Repository oder als separates SDK/
  Firmware-Repository pflegen.
- Praktisch testen, welches minimale Refresh-Intervall die TRMNL-BYOD-Firmware im
  Netzbetrieb zuverlässig unterstützt.
- Entscheiden, ob internes LAN-HTTP zunächst erlaubt bleibt oder lokales HTTPS
  von Anfang an Pflicht ist.
- Entscheiden, ob Remote-Server nur fertige Publications oder später auch
  normalisierte Daten-Snapshots teilen dürfen. Für die erste Version werden nur
  Publications empfohlen.
- Vor dem ersten echten Connector festlegen, ob Drittanbietererweiterungen nur
  deklarativ, in Subprozessen oder in Containern laufen dürfen.

## 14. Empfohlener nächster Arbeitsschritt

Nicht gleichzeitig an Widgets, Sources und Geräten weiterbauen. Als Nächstes nur
Phase 0 und anschließend Phase 1 durchführen. Das konkrete erste Ergebnis soll ein
sauberes Repository mit gesichertem Spike sowie ein kleines versioniertes
`contracts`-Paket sein, das die drei vorhandenen Geräte und ein minimales
PresentationManifest ausdrückt. Erst danach sollte das Prisma-Schema erneut
geändert werden.
