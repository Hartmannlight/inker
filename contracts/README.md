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
- Fachliche Verträge und deren Versionsregeln werden erst in WP-04 ergänzt. Dieses
  Paket enthält bewusst nur `DeviceStatus` als kompatiblen Durchstich.

## Befehle

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```
