# `@inker/contracts`

Frameworkunabhängige Netzwerk- und Domänenverträge für Backend, Frontend und
spätere Geräte-/Firmware-Tools. Das Paket liegt unter `contracts/` und wird über
den stabilen Importnamen `@inker/contracts` eingebunden.

## Konventionen

- Reine Verträge sind exportierte TypeScript-Typen oder Interfaces. Sie
  importieren weder NestJS, React noch Prisma und enthalten keine
  Framework-Decoratoren oder Persistenzmodelle.
- Laufzeitwerte sind auf kleine Konstanten und seiteneffektfreie Validatoren
  beschränkt. Validatoren nehmen `unknown` an und geben einen Type-Guard oder ein
  explizites Validierungsergebnis zurück; Framework-Pipes und UI-Logik bleiben in
  den konsumierenden Anwendungen.
- Werte an Netzwerk- und Persistenzgrenzen müssen `JsonValue` erfüllen. Zulässig
  sind `null`, Strings, Booleans, endliche Zahlen, Arrays und einfache Objekte mit
  ausschließlich JSON-kompatiblen Werten. `undefined`, `bigint`, Funktionen,
  Symbole, nicht endliche Zahlen, Klasseninstanzen und Zyklen sind unzulässig.
- Zeitpunkte werden als dokumentierte ISO-8601-Strings übertragen, Binärdaten als
  Artefaktreferenz oder ausdrücklich dokumentierte Stringkodierung. `Date`,
  `Buffer` und andere Laufzeitobjekte gehören nicht in Verträge.
- Repräsentative JSON-Beispiele liegen unter `fixtures/` und werden im
  Contract-Test-Harness gegen die zugehörigen Laufzeitvalidatoren geprüft.
- Alle Kernverträge tragen `protocolVersion` im Format `major.minor`. Version
  `1.0` ist aktuell. Eine unbekannte Minor-Version derselben Major-Linie wird mit
  Warnung angenommen; unbekannte Felder und Features bleiben ungenutzt. Eine
  andere Major-Version oder ungültige Syntax wird abgelehnt.
- Parser nehmen `unknown` an und liefern `ParseResult<T>` mit maschinenlesbarem
  Fehlercode, JSON-Pfad und verständlicher Meldung. Sie werfen nicht für reguläre
  Eingabefehler.

## Vertragssatz 1.0

- `DeviceProfile`, `DeviceCapabilities` und `DeliveryPolicy` trennen Display,
  Transport, Energie und Interaktion. Batterie- und Netz-TRMNL teilen dasselbe
  Profil und unterscheiden sich nur in Energie-Capability und Delivery Policy.
- `PresentationManifest` beschreibt unveränderliche Publication-Revisionen,
  Artefakte, Refresh-Hinweise und erlaubte Aktionen ohne Widgettypen.
- `SourceSnapshot` enthält nur validierte, normalisierte JSON-Daten und
  Freshness-/Fehlerstatus; Providerzugriff und Secrets sind kein Teil des
  Vertrags.
- `InteractionEvent` und `CommandResult` bilden idempotente Aktionen und deren
  Ergebnis ab. Das Geräte-Credential wird nur über `credentialId` referenziert,
  nicht als Secret übertragen.

Die vier Profile unter `fixtures/profiles/` sind Contract-Beispiele. Insbesondere
ist das 480×480-ESP32-Profil ausdrücklich eine Referenz-Fixture und keine
verifizierte Produktannahme. Poll-, Refresh- und E-Ink-Grenzwerte der Fixtures sind
keine gemessenen Produktdefaults.

## Befehle

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```
