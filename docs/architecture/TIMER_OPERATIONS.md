# Persistente Timer und Auslieferung (WP-24/WP-25)

## Umfang und Datenfluss

Timer sind serverseitige Fachzustände, keine sekündlichen Zähler. WP-24 ergänzt
Zustandsmaschine, SQLite-Persistenz und fünf registrierte Interaction-Handler.
WP-25 ergänzt Scheduling, Startup-Recovery, Push/Pull und eine minimale
Browser-Testoberfläche. Ein späterer Befehl kann einen überfälligen Timer ebenfalls
fachlich abschließen; Worker und Befehle verwenden dieselbe Zustandsmaschine.

Alle Gerätebefehle laufen durch die [Interaction-Pipeline](INTERACTION_OPERATIONS.md):
gültiges DeviceCredential, aktuelle fertig gerenderte Publication mit explizit
erlaubter Aktion, Payloadprüfung, Deduplizierung und eine gemeinsame Transaktion
für Fachänderung, Outbox und CommandResult. Keine direkten Timer-Mutationsendpunkte.

| Aktion | Payload innerhalb des InteractionEvents |
|---|---|
| `timer.create` | `{"version":1,"durationMs":60000,"visibility":"private"}` |
| `timer.pause` | `{"version":1,"timerId":"<UUID>","expectedVersion":1}` |
| `timer.resume` | gleiche Form mit aktueller Timerversion |
| `timer.cancel` | gleiche Form mit aktueller Timerversion |
| `timer.acknowledge` | gleiche Form mit aktueller Timerversion |

`targetId` bezeichnet weiterhin das freigegebene Publication-Aktionselement;
die Timer-ID steht im Payload. Ersteller und Quittierender stammen aus dem
authentifizierten Principal, nie aus einem frei wählbaren Payloadfeld.
Das Ergebnis enthält den vollständigen geprüften `TimerSnapshot` und
`stateRevision` als Timerversion. Publication-, Timer- und Playbackversionen sind
getrennte Werte. Bei Versionskonflikten zunächst neuen Zustand lesen und einen
neuen Event erzeugen; für reine Netzwerk-Retries das alte Event unverändert senden.

## Rechte und Gerätelebenszyklus

- `private`: Nur das Erstellergerät kann den Timer lesen und verändern.
  Fremde private IDs werden wie unbekannte IDs behandelt.
- `shared`: Für aktive Geräte dieser lokalen Installation sichtbar. Änderungen
  benötigen weiterhin die jeweilige publizierte Timeraktion und eine aktuelle
  Credential. Es gibt keine automatische Remote-/Mandantenfreigabe.
- Credentialrotation ändert das Erstellergerät nicht. Gerätesperrung sperrt dessen
  Befehle. Geräteentfernung setzt interne Creator-/Acknowledger-FKs auf `NULL`,
  löscht aber keine geteilten Timer. Öffentliche externe IDs bleiben als Auditidentität
  erhalten. Private verwaiste Timer werden keinem anderen Gerät zugänglich.
- Quittierung ist für einen geteilten Timer gemeinsam. Eine spätere Quittierung
  je Display bräuchte ein eigenes Modell und ist nicht Bestandteil dieser Foundation.

## Zustandsmaschine

`create` erzeugt `running` mit Version 1. `pause` speichert eine positive Restdauer
und entfernt `endsAt`; `resume` berechnet ein neues `endsAt` aus Serverzeit und
gespeicherter Restdauer. `startedAt` bleibt der ursprüngliche Erstellzeitpunkt.
`cancel` erzeugt `cancelled`. Sobald `now >= endsAt`, hat Completion Vorrang:
Ein verspätetes pause/resume/cancel liefert erfolgreich `completed`, ohne den
Timer wiederzubeleben. `completedAt` ist der ursprüngliche Endzeitpunkt.

Quittierung belässt `status: completed` und setzt `acknowledgedAt` sowie die
Quittiereridentität. Ein überfälliges acknowledge schließt und quittiert in genau
einem atomaren Übergang. Ein noch laufender oder pausierter Timer ist nicht quittierbar.
Andere ungültige Übergänge aus terminalen Zuständen werden abgelehnt.

Eine bereits erfüllte pause/resume/cancel/acknowledge-Aktion ist bei passender
Timerversion ein No-op: keine weitere Timerrevision und kein neues Timerereignis.
Die Interaction-Pipeline speichert dennoch die neue Command-Receipt. Ein identisches
Event wiederholt ausschließlich dessen gespeichertes Ergebnis.

`evaluatedAt` ist die letzte persistierte fachliche Bewertung, nicht die Zeit eines
GET. Rückwärts bewegte Serverzeit wird bei Übergängen auf diesen Wert begrenzt.
Lesen und bloßer Uhrfortschritt erzeugen weder Writes noch Completion.
Clients können eine Restzeit ohne Server-Ticks berechnen:

```text
running: max(0, endsAt - max(serverNow, evaluatedAt))
paused:  pausedRemainingMs
completed/cancelled: 0
```

Alle Zeitwerte sind ganze Unix-Millisekunden zwischen Epoch und dem Ende des
Jahres 9999. SQLite-Checks und Contract-/Domainguards prüfen denselben Zeitbereich;
SQL prüft zusätzlich Datentyp und Zustandskonsistenz. Ungültiger persistierter
Zustand wird nicht stillschweigend repariert.

## Grenzen, Persistenz und Ereignisse

Dauer: 1.000 bis 604.800.000 Millisekunden (sieben Tage), nur Ganzzahlen.
Timerversion: 1 bis 2.147.483.647, kein Überlauf. Höchstens 32 ausstehende Timer
pro Erstellergerät und 100 insgesamt. Als ausstehend zählen laufende, pausierte
und abgeschlossene, noch nicht quittierte Timer. Quittierte/abgebrochene Timer
bleiben gespeichert, belegen diese Quote aber nicht. Private verwaiste Timer
belegen keine nutzbare globale Kapazität. Ein Quotenkonflikt erzeugt keine Timerzeile.

Migration `20260903000000_timers` legt `timers` an. Zustand enthält unveränderliche
Erstelleridentität, Sichtbarkeit, Dauer, Zeitanker, Version und Abschluss-/Quittierdaten.
Ein Index `(status, endsAt)` unterstützt die Recovery. Bestehende Daten
werden nicht umgeschrieben. Das reguläre SQLite-Backup enthält sämtliche Timer;
Redis ist weiterhin kein Facharchiv.

Jede Fachänderung erzeugt `timer.state.changed` in derselben Transaktion:
Aggregate `Timer`, Aggregate-ID Timer-UUID, Aggregate-Revision Timerversion,
Payloadversion 1, Payload `{timerId,version,reason}`. Gründe sind `created`,
`paused`, `resumed`, `cancelled`, `completed`, `acknowledged`. Kein Credential,
freier Benutzertext oder vollständiger Timerzustand im Eventpayload.
Der strikte Outboxparser akzeptiert nur diese Felder. Der Dispatcher ermittelt
Empfänger aus der aktuellen Timerzeile in derselben Transaktion wie Effect und
Delivery-Ziele: privat nur aktiver Ersteller, geteilt alle aktiven lokalen Geräte.
Der WS-Transport sendet ausschließlich `{protocolVersion:"1.0",type:"timers.changed"}`.
Es gibt keine Timerdaten in WS-Frames, keine künstliche Presentationrevision und
keinen Renderauftrag. Credential- und Leaseprüfung bleiben wirksam.

## Dauerhafte Fristen und Wiederanlauf

`TimerService.executeInTransaction` verwendet ausschließlich die übergebene
Prisma-Transaktion; Command-Receipt und äußere Authentifizierung gehören dem Aufrufer.
`TimerHandlers` wird in der gemeinsamen CommandRegistry registriert.
`listForDevice` projiziert höchstens 100 sichtbare ausstehende Timer ohne Writes.
Die interne pure Aktion `complete` ist kein Geräte-Command.

Jeder laufende Zustand erzeugt atomar ein `timer.completion.due` mit deterministischer
SHA-256-ID aus Ereignistyp, Timer-ID, Version und Deadline. `availableAt=endsAt`.
Pause, Abbruch oder neue Version erledigen alte noch ausstehende Fristen; bereits
beanspruchte alte Jobs werden durch Status-, Versions- und Deadlinevergleich harmlos.
Die gemeinsame Timerqueue hat global zwei Slots, acht Sekunden Timeout und fünf
Versuche. Redis enthält Transportarbeit; SQLite bleibt die Wiederherstellungsquelle.

Workerstart rekonstruiert fehlende Jobs für alle laufenden Timer und reaktiviert
erschöpfte noch aktuelle Timerfristen einmal pro Start. Überfällige Jobs werden
sofort beanspruchbar und über denselben Completionpfad abgeschlossen. Zusätzlich
rekonstruiert eine Prüfung alle fünf Sekunden fehlende Jobs; sie reaktiviert keine
Deadletters. Bereits vorhandene Fristen werden ausschließlich lesend geprüft.
Keine sekündlichen Timerupdates und keine per-Timer-JavaScript-Timeouts.
Die Recovery ändert weder Zeitanker noch Timerversion.

Completion erwirbt vor Domain-I/O den SQLite-Writerlock über eine aktive Outbox-Claim
und prüft die Lease danach erneut. Timer, Zustandsereignis und Effect werden atomar
geschrieben; Bestätigung folgt separat. Absturz nach Commit und vor Bestätigung
wiederholt nur den Effect. Ein verspäteter Worker oder widerrufener Claim darf keine
Zustandsänderung hinterlassen. `completedAt` bleibt die ursprüngliche Deadline,
auch nach langer Downtime. Ein Uhr-Rücksprung stellt zu frühe Arbeit wieder auf die
ursprüngliche Deadline zurück, ohne das Fehlerbudget zu verbrauchen. Worker-Ausfälle
sind am separaten Backgroundstatus sichtbar. Deadletters untersuchen, bevor
wiederholt neu gestartet wird.

## Feed, Pull und lokaler Countdown

`GET /api/timers` akzeptiert ein Device-Bearer oder ein vorhandenes Legacy-Pull-
Credential, aber keine Adminsession, MAC-Adresse oder URL-Credentials. Legacygeräte
ohne `externalId` können lesen, jedoch keine Timerbefehle erteilen. Die Antwort ist
direkt `{protocolVersion:"1.0",serverTime,timers}` (kein `data`-Wrapper), maximal
100 eindeutige Snapshots und 128 KiB. Abgebrochene und quittierte Timer fehlen in
dieser Sammlung; leer ist ein gültiger Zustand.

`ETag` hängt nur von sichtbarem Zustand ab. `X-Server-Time` liefert eine frische
Zeitprobe auch bei 304; `Cache-Control: private, no-cache` und `Vary` verhindern
gemeinsames Caching. Vor einer Antwort wird die Authentifizierung erneut geprüft.
Der nächste `GET /api/v1/device-content` enthält denselben Zustand in `timerState`.
Sein Manifest-ETag ändert sich bei Timeränderungen; Artefakt-ETags bleiben stabil.
Artefaktabrufe fragen die Timer nicht ab.

Testscreen: Eine gekoppelte Displayroute mit `?test=timers` öffnen. Die zugewiesene
fertig gerenderte Publication muss die gewünschten fünf `timer.*`-Aktionen mit
`payloadSchemaVersion:"1.0"` explizit erlauben. Der Bildschirm bleibt eine kleine
Foundation-Testoberfläche, kein Widget und kein Editorfeature. Zwei Browser koppeln,
dieselbe berechtigte Publication zuweisen, auf einem einen geteilten Timer erzeugen
und auf dem anderen pausieren/fortsetzen oder nach Abschluss quittieren.

Der Client liest bei Verbindung, Wiederverbindung und Timerinvalidierung den Feed,
koalesziert parallele Abrufe und zählt mit `performance.now()` lokal weiter. Die
Serverzeitprobe plus halber gemessener Roundtrip liefert den Offset; Änderungen
der lokalen Wandzeit beeinflussen den Countdown nicht. Offline bleibt der letzte
bestätigte Zustand sichtbar, Aktionen sind gesperrt. Nach fehlender Bestätigung
wiederholt die Schaltfläche denselben unveränderten InteractionEvent. Doppeltaps
erzeugen keinen zweiten gleichzeitig laufenden Befehl. Credentialverlust entfernt
private Daten; ein Anzeigewechsel darf keinen alten privaten Zustand übernehmen.

Physischer ESP32, Raspberry-Pi-Browser und TRMNL sind nicht verfügbar. HTTP-/WS-
Referenzabläufe und der Browser werden mit echter Laufzeit geprüft; unveränderte
TRMNL-Firmware zeichnet aus dem neuen JSON-Feld nicht automatisch Timergrafiken.
Eine solche Firmware-/Widgetentwicklung ist außerhalb dieses Foundation-Auftrags.

## Prüfung

`timer-domain.test.ts`: tabellengetriebene Übergänge, genaue Endgrenze, Uhr rückwärts,
No-ops und Überlauf. `timer.test.ts`: Payload-/Snapshotvertrag und Zustandsinvarianten.
`timers.integration.ts`: tatsächliche SQLite-, Command-, Berechtigungs- und
Rollbackpfade. `timer-scheduling.integration.ts` prüft Claim-Races, fehlende Jobs,
Absturz nach Commit, originale Deadline nach Downtime, Clock-Skew und die
lesende Recovery mit SQL-Schreibzähler. Die Containerfixture
`timer-domain-container-check.cjs` prüft echte HTTP/WS-/Redis-Pfade, zwei Geräte,
private Zustellung, nächste Pullantwort und den gespeicherten Zustand nach Neustart.

Für einen isolierten manuellen Browserlauf zuerst `inker:wp25-test` bauen, dann im
Backend `node test/timer-browser-fixture.cjs setup` ausführen. Die Ausgabe liefert
zwei temporäre Geräte-URLs und kurzlebige Kopplungscodes. Nur diese Geräte koppeln;
die Fixture nutzt Port 18725 und eigene Volumes. `inspect` zeigt ausschließlich
Timer-Metadaten und Receiptanzahl, `offline`/`online` stoppen/starten nur deren API,
`cleanup` entfernt nur den eindeutig benannten Testcontainer mit seinen Volumes.
Die ignorierte `.tmp/wp25-browser-state.json` enthält die Fixturezuordnung, keine
Adminsession oder Device-Credentials. Setup bei vorhandener Zuordnung verweigert
eine zweite Instanz. Nicht gegen produktive Container oder Daten ausführen.

Endgültige Ergebnisse dokumentiert der
[Paket-Handoff](WORK_PACKAGES.md#wp-25--timer-planen-wiederherstellen-und-verteilen).
