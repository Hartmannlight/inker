# Geräteaktionen – Vertrag und Betrieb (WP-23)

## Transport und Berechtigung

`GET /api/interactions/context` und `POST /api/interactions` benötigen ein aktives,
nicht abgelaufenes DeviceCredential als `Authorization: Bearer …`. Adminsessions,
Legacy-`HTTP_ID` und `access-token` berechtigen nicht. Beide Antworten sind
`Cache-Control: no-store`; Credentials gehören niemals in URLs oder Eventpayloads.

Der Context enthält `protocolVersion`, Geräte-`externalId` als `deviceId`, öffentliche
`credentialId`, `serverTime`, `publicationId`, Publication-`revision`,
`allowedActions` und `playback.{version,desiredSequence}`. Er schreibt keine SQL-Daten.
Publication-Revision, Gerätezuweisungssequenz und Playback-Version sind verschieden.

Aktionen werden beim expliziten Admin-Publish als optionales `allowedActions`
angegeben. Maximal 16 eindeutige Paare aus `action` und optionalem `targetId`, jeweils
mit `payloadSchemaVersion: "1.0"`. Beispiel:

```json
[{"action":"view.next","targetId":"next","payloadSchemaVersion":"1.0"}]
```

Die Rechte sind Teil des unveränderlichen Publication-Contents/Hashes. Alte
Publications und fehlende/leere Listen erlauben nichts. Nur die aktuelle gewünschte
Publication mit fertigem, passendem Rendercache gewährt Rechte. Ein alter
Bild-Fallback bleibt sichtbar, gewährt aber keine Aktionen. Der Pull-ETag berücksichtigt
diese Rechteänderung. `targetId` muss exakt übereinstimmen, auch bei Abwesenheit.
Registrierte Handler ohne veröffentlichte Freigabe bleiben gesperrt; eine Freigabe
für einen unbekannten Handler führt zu einer sicheren Ablehnung.

## Event und Ergebnis

Den Context lesen und ein `InteractionEvent` aus dem gemeinsamen Contract senden:

```json
{
  "protocolVersion":"1.0",
  "eventId":"client-generated-unique-id",
  "deviceId":"external-device-id",
  "credentialId":"public-credential-id",
  "publicationId":"publication-id",
  "revision":"1",
  "action":"view.next",
  "targetId":"next",
  "payload":{"version":1,"expectedPlaybackVersion":1,"expectedDesiredSequence":3},
  "occurredAt":"2026-08-28T12:00:00.000Z",
  "clientSequence":1
}
```

Der Zeitstempel ist ein Beispiel und muss beim tatsächlichen Senden zur Serverzeit
passen. `view.next` verwendet die bestehenden Playback-Übergänge und Versionsfences;
es gibt keine versteckte Publikation oder Playliständerung durch das Lesen.

HTTP 200 enthält synchron `accepted`, `rejected` oder `duplicate`. Die serverseitige
`commandId` ist zugleich `X-Correlation-ID`; abgelehnte Befehle haben einen festen
Fehlercode und keine internen Fehlertexte. HTTP 400 bedeutet ungültige Eingabe,
401 fehlende Berechtigung, 429 ausgeschöpfte Quote und 503 temporär nicht ausführbar.
Ein 503 hinterlässt keine Teiländerung und kann mit demselben Event wiederholt werden.

Für einen Netzwerk-Retry das gesamte ursprüngliche Event einschließlich `eventId`
und Zeitstempel wiederholen. Ein bestätigter Doppel-Tap erzeugt genau eine Änderung.
Ein anderes Event unter derselben Geräte-`eventId` wird mit
`INTERACTION_EVENT_CONFLICT` abgelehnt. Wiederholungen liefern das gespeicherte
Ergebnis mit `status: duplicate`, derselben Correlation-ID und gegebenenfalls dem
ursprünglichen Fehler. Vorher wird die aktuelle Credentialgültigkeit geprüft.
Ein bereits ausgeführtes `view.next` darf die Publication gewechselt haben; daher
kommen Zeit-/Publication-/Sequenzprüfungen erst nach der Deduplizierung.

## Grenzen und Persistenz

| Grenze | Wert |
|---|---|
| Event / Payload | 8 KiB / 4 KiB UTF-8; Payloadtiefe maximal 8 |
| Neue valide Events pro Gerät | 8 pro Sekunde und 60 pro Minute, persistente feste Fenster |
| Zeitfenster | höchstens 5 Minuten alt und 30 Sekunden in der Zukunft |
| Optionale `clientSequence` | 0 bis 2.147.483.647, nach erfolgreichem Befehl monoton pro Credential |
| Registrierte Handler | höchstens 32; Action maximal 64 Zeichen |
| Transaktion | 5 Sekunden; Fehler ohne Teilcommit |

Duplikate verbrauchen die Commandquote nicht; der allgemeine HTTP-Throttler gilt
weiterhin. Quote gilt über Credentialrotation und API-Neustart hinweg pro Gerät.
429 erzeugt keine Receipt. Eine fachliche Ablehnung wird dagegen gespeichert und
verbraucht Quote. Fehlgeschlagene Befehle erhöhen keine erfolgreiche Clientsequenz.

Migration `20260902000000_interactions` ergänzt `interaction_receipts`,
`interaction_rates` und `interaction_sequences`. Ein SQLite-Writerlock serialisiert
konkurrierende Prozesse vor Auth-/Receipt-/Zustandslesevorgängen. Fachänderung,
Outbox, erfolgreiche Sequenz und Receipt werden gemeinsam committed. Fachliche
400/404/409-Handlerfehler rollen per Savepoint ihre Änderungen zurück und speichern
nur die sichere Ablehnung; unerwartete Fehler oder zwischenzeitlicher Credentialablauf
rollen alles zurück. Handler-Ergebnisse werden kopiert und auf sichere Felder/Größe
begrenzt. Receipts speichern öffentliche Identität, Requesthash und Ergebnis, keine
rohen Requestpayloads oder Bearertokens.

Receipts bleiben über Credentialrotation erhalten und werden erst mit dem Gerät
gelöscht. Kein zeitgesteuertes Pruning: Es darf nicht durch Receiptlöschung erneut
ein alter Event ausgeführt werden. Datenbankgröße beobachten und mit dem regulären
SQLite-Backup sichern. Credentiallöschung entfernt nur ihre Sequenz.

## Handler ergänzen – Übergabe an WP-24

Ein injizierbarer `CommandHandler` benennt `action`, `payloadSchemaVersion`,
`validate(payload)` und `execute(tx, principal, payload, event, commandId)`.
In der Factory des `InteractionsModule` registrieren. Keine Widget-Switches im
Controller, keine eigene verschachtelte Prisma-Transaktion und keine externen
Seiteneffekte innerhalb des Handlers. Fachzustand und Outbox ausschließlich über
das übergebene `tx` schreiben. Ergebnis erlaubt nur `stateRevision` und JSON-`result`.

Timerpayloads müssen ihre eigene Version, Dauer-/Identitätsgrenzen und konkurrierende
Zustandsversion prüfen. Publication-Aktionsfreigabe ersetzt nicht die fachliche
Prüfung privater/geteilter Timer und ihres Erstellergeräts. Serverzeit ist maßgeblich.
Scheduling/Push und eine minimale Bedienoberfläche folgen WP-25; WP-23 fügt keine
UI, Firmware oder produktiven Connectoren hinzu.

## Nachweis

`backend/test/interactions.integration.ts` prüft tatsächliche SQLite-/Render-/Playback-
und Outboxpfade einschließlich zweier unabhängiger Prozesse, Triggerfehler,
Savepointrollback, ablaufender Credentials, Grenzen und Secret-/Resultprojektion.
`backend/test/websocket-container-smoke.cjs` führt zusätzlich die neue Interaction-
Fixture über echtes HTTP im eigenen Produktionscontainer aus und prüft den
gespeicherten Zustand nach Neustart. Endgültige Ergebnisse stehen im
[Paket-Handoff](WORK_PACKAGES.md#wp-23--interaction-command-pipeline-implementieren).
Physische Touchgeräte sind mit diesen Softwareprüfungen nicht abgenommen.
