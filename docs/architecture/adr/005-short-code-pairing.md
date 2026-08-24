# ADR-005 – Kurzcode-Pairing als einmaliger Bootstrap

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Displays benötigen ein widerrufbares Geräte-Credential, lange Zufallswerte sind
auf E-Ink- und Embedded-Geräten aber fehleranfällig einzugeben. Ein kurzer Code darf
nicht zum dauerhaften Authentisierungsgeheimnis werden.

## Entscheidung

Das Admin-UI erzeugt einen zehnstelligen, verwechslungsarmen Crockford-Base32-Code
mit höchstens zehn Minuten TTL. Der Server speichert nur dessen Hash sowie
Versuchszähler und Enrollment-Kontext. Der Code ist einmal verwendbar und streng
rate-limitiert.

Das Gerät übermittelt Basis-URL und Code über TLS. Nach erfolgreicher atomarer
Einlösung erhält es ein langes, hochentropisches, widerrufbares Credential mit
minimalen Rechten. Code und gegebenenfalls vorheriges Credential werden atomar
verbraucht beziehungsweise widerrufen. QR-Code und manuelle Eingabe transportieren
denselben Bootstrap und ändern das Protokoll nicht.

Ohne HTTPS ist Pairing nur als ausdrücklich aktivierter, sichtbar unsicherer Modus
in einem als vertrauenswürdig markierten lokalen Netz zulässig. Ob dieser Modus in
der ersten Version angeboten wird, bleibt gemäß
[ADR-009](009-local-http-policy.md) offen.

Eingabemethode, Bildschirmauflösung, Controller und Netzwerkstack sind
Gerätefähigkeiten, keine fest codierten Produktannahmen; siehe
[ADR-008](008-hardware-assumptions.md).

## Folgen

- Benutzer müssen keine dauerhaften Credentials abtippen oder in QR-Codes
  weitergeben.
- Enrollment benötigt Hashing, TTL, atomare Einlösung, Rate-Limits sowie Replay-
  und Race-Tests.
- Geräte müssen das erhaltene Credential sicher lokal speichern und Rotation oder
  Widerruf behandeln.
- Geräte ohne Tastatur können denselben Vertrag über QR oder einen
  gerätespezifischen Provisioning-Kanal verwenden.

## Alternativen

- **Dauerhaftes kurzes Secret:** ist online erratbar und wird ausgeschlossen.
- **Langes Token manuell eingeben:** ist kryptografisch stark, aber für die
  Zielgeräte unnötig fehleranfällig.
- **Herstellergebundener Pairing-Dienst:** vereinfacht einzelne Geräte, verletzt
  aber die generische Self-Hosting- und Capability-Grenze.
