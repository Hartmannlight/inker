# Inker Deep Dive und sichere E-Mail-Integration

Stand: 1. August 2026  
Geprüfter Inker-Stand: `83c72b0c590cca40df9da1c646c3d5693e0028df` (v0.6.0)

## Entscheidung

Wir sollten **Inker forken und als Editor-, Rendering- und Device-Basis
verwenden**, aber nicht unverändert darauf weiterbauen. Vor der ersten
sensiblen Datenquelle braucht der Fork eine neue Sicherheits- und
Datenquellenschicht.

Das ist gegenüber einer kompletten Neuentwicklung sinnvoll, weil Inker bereits
die besonders arbeitsintensiven Produktteile besitzt:

- visueller Screen Designer mit frei positionierbaren und skalierbaren Widgets
- Geräte, Modelle, Auflösungen, Screens und Playlists
- Browser-basiertes Rendering über Chromium und Bildaufbereitung über Sharp
- E-Ink-Ausgabe mit 1 Bit und 16 Graustufen
- BYOD- und TRMNL-Geräteprotokoll
- React-Verwaltungsoberfläche und Docker-Betrieb

Eine komplette Neuentwicklung würde genau diese Teile erneut bauen. Der
sicherheitskritische Kern ist dagegen überschaubarer und kann im Fork bewusst
ersetzt werden. Grob können wir 60–70 % der vorhandenen Produktbasis behalten;
bei Authentifizierung, OAuth, Sources und Plugin-Ausführung ist jedoch ein
substanzieller Umbau nötig.

Ein eigener Clean-Room-Neubau wäre vorzuziehen, wenn mindestens eine dieser
Bedingungen gilt:

- Das Produkt soll proprietär bleiben; Inker steht unter AGPL-3.0.
- TypeScript/NestJS/React ist als Stack nicht akzeptabel.
- Der Editor soll konzeptionell stark anders funktionieren.
- Wir wollen einen öffentlichen Multi-Tenant-SaaS-Dienst statt eines
  selbst gehosteten Servers bauen.

Für das aktuell beschriebene offene, selbst gehostete StatusPanel überwiegt der
Nutzen des Forks.

## Was im Inker-Kern bereits gut gelöst ist

- OAuth-Access- und Refresh-Tokens werden mit AES-256-GCM, zufälliger IV und
  Authentifizierungs-Tag verschlüsselt gespeichert.
- Das Gerät erhält gerenderte Bilder und benötigt grundsätzlich keine
  Provider-Zugangsdaten.
- Datenquellen besitzen Cache, parallele Request-Deduplizierung und eine
  Stale-Data-Rückfallstrategie.
- Generische HTTP-Quellen haben Zeit- und Größenlimits. Private IPs werden
  standardmäßig blockiert; DNS-Auflösung und DNS-Rebinding werden geprüft.
- Die PIN-Prüfung verwendet einen timing-sicheren Vergleich und Login-Throttling.
- HTML-Screenshots blockieren ausgehende Browser-Requests und erlauben nur
  Inline- beziehungsweise Data-URLs.
- Das Backend läuft im Container als Nicht-Root-Benutzer.

Diese Punkte sind eine gute Basis, ersetzen aber keine saubere Trennung
zwischen vertrauenswürdigen Credentials und ausführbarem Plugin-Code.

## Kritische Befunde vor einer Gmail-Anbindung

### 1. OAuth-Scope ist providerweit statt verbindungsspezifisch

Inker konfiguriert für Google derzeit global `calendar.readonly`. Obwohl das
Prisma-Modell ein `oauthScopes`-Feld am Plugin besitzt, verwendet der
OAuth-Service ausschließlich die globalen Provider-Scopes. Eine Ergänzung um
Gmail würde dadurch Kalender- und Mailberechtigungen vermischen und jede
Google-Verbindung überprivilegieren.

**Änderung:** Eine `AccountConnection` muss Provider, Kontoidentität,
angeforderte Scopes, tatsächlich gewährte Scopes und verschlüsselte Tokens
besitzen. Scopes werden pro Connector und erst beim Aktivieren der Funktion
angefordert.

### 2. Access-Tokens werden an frei ausführbaren Plugin-Code übergeben

`PluginsService` schreibt den OAuth-Access-Token in
`settings.oauth_access_token`. Ein Plugin kann anschließend seine
`dataTransform`-Funktion als `AsyncFunction` mit uneingeschränktem
`globalThis.fetch` ausführen. Das 10-Sekunden-`Promise.race` beendet den
laufenden Code nicht und verhindert keine Token-Exfiltration.

**Konsequenz:** Gmail darf in der aktuellen Architektur kein generisches
Plugin sein. Provider-Tokens dürfen den vertrauenswürdigen Connector niemals
verlassen. Importierte Plugins erhalten nur normalisierte Ergebnisse.

### 3. OAuth-`state` ist authentifiziert, aber nicht an die Sitzung gebunden

Inker verschlüsselt `{instanceId, provider}` und erkennt dadurch Manipulation.
Der Wert besitzt aber keinen Ablaufzeitpunkt, keine einmalig konsumierbare
Nonce und keine Bindung an die Admin-Sitzung beziehungsweise den Browser.

**Änderung:** Zufällige 256-Bit-Nonce serverseitig mit `sessionId`,
`connectionId`, `expiresAt` und `consumedAt` speichern. Callback nur einmal,
innerhalb von 5–10 Minuten und für dieselbe Sitzung akzeptieren.

### 4. Trennen löscht nur lokale Tokens

`disconnectOAuth` leert die Datenbankfelder, ruft aber nicht den
Revocation-Endpunkt des Providers auf. Gewährte Scopes und Kontoidentität
werden ebenfalls nicht persistiert oder validiert.

**Änderung:** Beim Trennen zuerst widerrufen, danach lokale Tokens sicher
löschen. Gewährte Scopes, Provider-Subject und sichtbare Kontoadresse speichern
und im UI anzeigen.

### 5. Unsichere Defaults

Ohne `ENCRYPTION_KEY` fällt Inker auf die Admin-PIN und bei der Standard-PIN
`1111` sogar auf den konstanten String `inker-default-key` zurück. Damit ist
die vorhandene Verschlüsselung bei einer Default-Installation praktisch kein
Schutz.

**Änderung:** Start verweigern, wenn Standard-PIN oder Schlüssel fehlt. Für
eine einfache Installation kann der Setup-Assistent beim ersten Start einen
zufälligen 256-Bit-Instanzschlüssel erzeugen und außerhalb der SQLite-Datei
ablegen.

### 6. Weitere Schutzlücken

- Header generischer Datenquellen liegen als JSON unverschlüsselt in SQLite.
- Die Admin-Sitzung ist ein 30 Tage gültiger In-Memory-Bearer-Token; das
  Frontend speichert ihn in `localStorage`.
- Mehrere Bild- und Plugin-Render-Endpunkte sind öffentlich und verwenden
  erratbare numerische IDs. Das kann vertrauliche Statusinformationen zeigen.
- Geräte können sich über einen öffentlichen Setup-Endpunkt selbst anlegen.
- Chromium läuft mit `--no-sandbox`; benutzerdefiniertes Markup sollte deshalb
  zusätzlich in einen isolierten Render-Worker.
- Datenbankänderungen werden per `prisma db push` statt versionierter
  Migrationen angewandt.
- Gerätebilder verwenden `no-store` statt ETag/Conditional GET.

Diese Punkte blockieren keinen lokalen UI-Prototyp, aber eine produktive
Gmail-Verbindung oder Internetfreigabe.

## Sichere Architektur für „ungelesene E-Mails“

```text
Google OAuth
    │  verschlüsseltes Refresh-Token
    ▼
AccountConnection (nur Serverkern)
    │  kurzlebiger Access-Token, nur im Speicher
    ▼
Trusted Gmail Connector
    │  GET /gmail/v1/users/me/labels/INBOX
    ▼
SourceSnapshot
    { unreadCount, fetchedAt, stale, error }
    │
    ├── Mail-Widget im Browser
    ├── PNG/JPEG/BMP-Renderer
    └── ESP32/E-Ink-Gerät
```

Das Gerät sieht weder Google-Token noch Client-Secret, Mailadresse,
Betreffzeile, Absender oder Nachrichtentext. Es fragt nur unser StatusPanel mit
einem eigenen gerätespezifischen Token ab.

Gmail liefert für ein Label direkt `messagesUnread`. Daher genügt ein einzelner
Abruf von `users.labels.get` für das Systemlabel `INBOX`; wir müssen keine
Nachrichtenliste und keine Mailinhalte laden.

Der minimal sinnvolle Scope ist nicht völlig eindeutig:

| Scope | Vorteil | Nachteil |
| --- | --- | --- |
| `gmail.labels` | von Google als nicht sensibel klassifiziert; kein Zugriff auf Mailtexte | erlaubt technisch auch das Bearbeiten von Labels |
| `gmail.metadata` | Metadatenzugriff ohne Nachrichtentext | schließt Header ein und wird von Google als eingeschränkter Scope behandelt |

Für eine persönliche Self-Hosted-Installation ist `gmail.labels` vertretbar,
wenn der fest eingebaute Connector ausschließlich den GET-Endpunkt für
`INBOX` aufrufen kann. Das reduziert die gelesenen Daten, auch wenn ein
gestohlener Token aufgrund seines Scopes theoretisch Labels verändern könnte.
Falls unverändernder Read-only-Zugriff wichtiger ist und die strengeren
Google-Anforderungen akzeptiert werden, ist `gmail.metadata` die Alternative.

Persistiert wird nur:

```json
{
  "unreadCount": 12,
  "fetchedAt": "2026-08-01T17:30:00Z",
  "stale": false,
  "error": null
}
```

Der Roh-Response wird sofort verworfen. Logs dürfen weder Tokens noch komplette
Provider-Antworten enthalten.

### Praktischer Google-OAuth-Betrieb

Für eine wirklich selbst gehostete Installation sollte der Betreiber ein
eigenes Google-Cloud-Projekt und einen eigenen OAuth-Web-Client hinterlegen.
Client-ID und Client-Secret kommen als Secrets in den Server; die exakte
HTTPS-Callback-URL wird im Google-Projekt registriert. Dadurch teilen nicht
alle Installationen ein zentrales Client-Secret.

Wichtig für den Einrichtungsassistenten: Bei externen Google-OAuth-Apps im
Status **Testing** laufen Autorisierungen und damit auch Offline-Refresh-Tokens
für Gmail-Scopes nach sieben Tagen ab. Für einen dauerhaft laufenden
Mailzähler muss das Projekt passend veröffentlicht werden oder das UI muss den
Testbetrieb ausdrücklich als kurzlebig kennzeichnen und eine erneute
Autorisierung anbieten.

## Zwei Geräteklassen, ein persistierter Zustand

StatusPanel sollte die Geräte nicht nach konkreter Hardware, sondern nach
ihrem **Delivery Profile** behandeln. Datenabruf, Rendering und Auslieferung
bleiben voneinander unabhängig.

### `sleepy-pull`

Für Akku-/Deep-Sleep-Geräte:

- Gerät wacht beispielsweise alle 30 Minuten auf.
- Es fragt einen kleinen Manifest- oder Bild-Endpunkt mit `If-None-Match` ab.
- Bei unveränderter Revision antwortet der Server mit `304 Not Modified`.
- Nur bei einer neuen Revision wird das Bild geladen und das Display erneuert.
- Der Server kann `nextCheckIn` empfehlen; das Gerät behält aber die Kontrolle
  über seinen Schlafzyklus.

Ein schlafender ESP32 kann keine Notification empfangen. Das ist keine
Einschränkung unseres Protokolls, sondern eine Folge des abgeschalteten WLANs.

### `live-notify`

Für USB-versorgte oder anderweitig dauerhaft aktive Geräte:

- Das Gerät hält eine authentifizierte SSE-Verbindung zum Server.
- Bei einer neuen Dashboardrevision sendet der Server nur ein kleines
  `dashboard.changed`-Event.
- Das Gerät lädt das Bild anschließend per HTTP mit ETag.
- Nach Verbindungsabbruch verbindet es sich automatisch neu und vergleicht
  seine letzte Revision mit der persistenten Serverrevision.
- Ein langsames Kontroll-Polling bleibt als Rückfall erhalten.

SSE genügt zunächst, weil der Server lediglich einseitige
Änderungsbenachrichtigungen senden muss. Ein späterer MQTT-Adapter kann dieselbe
interne Event-Schnittstelle verwenden. WebSockets werden erst nötig, wenn
echte bidirektionale Echtzeitsteuerung benötigt wird.

Die Notification ist nur ein Hinweis. Wahrheit ist immer die persistierte
`DashboardRevision` mit Content-Hash und Render-Artefakt. Dadurch kann ein
Gerät keine Änderung dauerhaft verpassen, selbst wenn es beim Event offline
war.

### Schnelle Gmail-Aktualisierung

Für das Fünf-Sekunden-Ziel reicht ein langsamer Gmail-Poller nicht. Der
Gmail-Connector kann stattdessen `users.watch` für das Label `INBOX`
registrieren. Gmail veröffentlicht Änderungen über Google Cloud Pub/Sub.

Für einen Self-Hosted-Server bietet sich eine ausgehende `StreamingPull`-
Subscription an: Der Server hält eine Verbindung zu Google, ohne selbst einen
öffentlichen Webhook bereitzustellen. Bei einer Notification ruft der Connector
den aktuellen Inbox-Zähler ab, schreibt bei einer tatsächlichen Änderung einen
neuen Snapshot und invalidiert nur die betroffenen Dashboards.

Gmail beschreibt die Zustellung als typischerweise zuverlässig innerhalb
weniger Sekunden, weist aber auf mögliche Verzögerungen oder verlorene
Notifications hin. Deshalb braucht der Connector zusätzlich einen langsamen
Abgleich, beispielsweise alle 15 Minuten. Der Gmail-`watch` muss mindestens
alle sieben Tage erneuert werden; Google empfiehlt täglich.

Die erwartete Kette für ein Live-Gerät ist:

```text
Neue Mail
  → Gmail Pub/Sub
  → Gmail-Connector liest neuen Zähler
  → SourceSnapshot bekommt neue Revision
  → betroffene Dashboards werden gerendert
  → SSE: dashboard.changed
  → Gerät lädt Bild per HTTP/ETag
```

Damit verwenden beide Geräteklassen exakt denselben Daten- und Renderzustand.
Sie unterscheiden sich ausschließlich darin, wann sie nach einer neuen
Revision schauen.

## Zielmodell für den Fork

### `AccountConnection`

- `id`, `provider`, `providerSubject`, `displayAccount`
- `requestedScopes`, `grantedScopes`
- `accessTokenEncrypted`, `refreshTokenEncrypted`, `expiresAt`
- `status`, `lastRefreshAt`, `lastError`

### `SourceDefinition`

- Typ des vertrauenswürdigen Connectors, zum Beispiel `gmail.unread`
- Referenz auf eine `AccountConnection`
- nicht geheime Konfiguration, Pollingintervall und Cache-Regeln

### `SourceSnapshot`

- normalisierte, secret-freie Nutzdaten
- Zeitstempel, Stale-Markierung, Fehlerzustand und optional Schema-Version
- kann von mehreren Widgets und mehreren Dashboards wiederverwendet werden

### `WidgetDefinition`

- kennt ausschließlich den Snapshot-Vertrag
- bestimmt Darstellung, nicht Provider-Authentifizierung oder Datenabruf

### Drittanbieter-Plugins

- erhalten niemals Credentials
- dürfen nur explizit freigegebene Snapshots lesen
- JavaScript-Transformationen werden in Worker/Subprozess mit echtem Abbruch,
  Speicherlimit und ohne Netzwerk ausgeführt

## Phase 0 vor dem ersten sensiblen Connector

1. Fork auf den geprüften Commit pinnen und Upstream-Remote behalten.
2. Standard-PIN und Fallback-Schlüssel entfernen; sicheren Setup-Flow bauen.
3. `AccountConnection`, `SourceDefinition` und `SourceSnapshot` einführen.
4. OAuth pro Verbindung implementieren: kleinste Scopes, Session-Nonce, TTL,
   einmaliger Callback, Granted-Scope-Prüfung und Revocation.
5. Öffentliche numerische Render-URLs durch gerätespezifische Tokens oder
   signierte, nicht erratbare URLs ersetzen.
6. Admin-Session in `HttpOnly`-/`Secure`-/`SameSite`-Cookie verlegen.
7. Plugin-Code vom Serverprozess und von Credentials isolieren.
8. Renderer isolieren und ausgehende Requests weiterhin standardmäßig sperren.
9. versionierte Prisma-Migrationen und Backup-/Restore-Test ergänzen.
10. ETag, Content-Hash und Render-Cache für ESP32-Polling einführen.

Danach ist `gmail.unread` der ideale erste Connector, weil er OAuth,
Credential-Isolation, Polling, Snapshot-Caching, Fehlerzustände und Rendering
Ende-zu-Ende beweist, ohne Mailinhalte verarbeiten zu müssen.

## Quellen und geprüfte Codepfade

- [Inker Repository](https://github.com/usetrmnl/inker)
- [Inker-Lizenz](https://github.com/usetrmnl/inker/blob/83c72b0c590cca40df9da1c646c3d5693e0028df/LICENSE)
- [OAuth-Service](https://github.com/usetrmnl/inker/blob/83c72b0c590cca40df9da1c646c3d5693e0028df/backend/src/plugins/oauth/oauth.service.ts)
- [Plugin-Service](https://github.com/usetrmnl/inker/blob/83c72b0c590cca40df9da1c646c3d5693e0028df/backend/src/plugins/plugins.service.ts)
- [Encryption-Service](https://github.com/usetrmnl/inker/blob/83c72b0c590cca40df9da1c646c3d5693e0028df/backend/src/common/services/encryption.service.ts)
- [Gmail Label Resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels)
- [Gmail `users.labels.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/get)
- [Gmail OAuth Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google OAuth für Webserver](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth Best Practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [Gmail Push Notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Google Cloud Pub/Sub Pull und StreamingPull](https://cloud.google.com/pubsub/docs/pull)
