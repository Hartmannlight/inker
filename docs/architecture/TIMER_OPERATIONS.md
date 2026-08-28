# Persistente Timerdomäne (WP-24)

## Umfang und Datenfluss

Timer sind serverseitige Fachzustände, keine sekündlichen Zähler. WP-24 ergänzt
Zustandsmaschine, SQLite-Persistenz und fünf registrierte Interaction-Handler.
Scheduling, Startup-Recovery, Push/Pull und eine minimale Testoberfläche gehören
zu WP-25. Der aktuelle WP-24-Stand führt keine automatische Hintergrund-Completion
aus; ein späterer Befehl kann einen überfälligen Timer bereits fachlich abschließen.

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
Ein Index `(status, endsAt)` unterstützt die spätere Recovery. Bestehende Daten
werden nicht umgeschrieben. Das reguläre SQLite-Backup enthält sämtliche Timer;
Redis ist weiterhin kein Facharchiv.

Jede Fachänderung erzeugt `timer.state.changed` in derselben Transaktion:
Aggregate `Timer`, Aggregate-ID Timer-UUID, Aggregate-Revision Timerversion,
Payloadversion 1, Payload `{timerId,version,reason}`. Gründe sind `created`,
`paused`, `resumed`, `cancelled`, `completed`, `acknowledged`. Kein Credential,
freier Benutzertext oder vollständiger Timerzustand im Eventpayload.
Der strikte Outboxparser akzeptiert diese Ereignisse in WP-24 mit leeren Delivery-Zielen;
damit werden sie regulär quittiert und nicht als unbekannte Arbeit dead-lettered.

## Übergabe an WP-25

`TimerService.executeInTransaction` verwendet ausschließlich die übergebene
Prisma-Transaktion; Command-Receipt und äußere Authentifizierung gehören dem Aufrufer.
`TimerHandlers` wird in der gemeinsamen CommandRegistry registriert.
`listForDevice` projiziert höchstens 100 sichtbare ausstehende Timer ohne Writes;
Serverzeit steht getrennt neben den gespeicherten Snapshots. Noch kein eigener
Transportendpunkt. Die interne pure Aktion `complete` ist kein Geräte-Command.

WP-25 ergänzt durable Abschlussabsicht/Job, Startup-Recovery und Lease-/Versions-/
Deadline-Fences nach dem Playbackmuster. Push/Pull muss private Rechte erneut prüfen,
Frames und Feedgröße begrenzen und darf Zustandsänderungen nicht durch GETs auslösen.
Countdown und Serveroffset werden lokal angezeigt; kein allgemeines Timer-Widget.

## Prüfung

`timer-domain.test.ts`: tabellengetriebene Übergänge, genaue Endgrenze, Uhr rückwärts,
No-ops und Überlauf. `timer.test.ts`: Payload-/Snapshotvertrag und Zustandsinvarianten.
`timers.integration.ts`: tatsächliche SQLite-, Command-, Berechtigungs- und
Rollbackpfade. Die Containerfixture `timer-domain-container-check.cjs` prüft echte
HTTP-Befehle, doppelte Erstellung, geteilte Übergänge, private Ablehnung und den
gespeicherten Zustand nach Neustart. Endgültige Ergebnisse dokumentiert der
[Paket-Handoff](WORK_PACKAGES.md#wp-24--persistente-timer-domäne-implementieren).
