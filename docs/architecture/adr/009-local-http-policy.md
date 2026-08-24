# ADR-009 – Richtlinie für HTTP-Pairing im lokalen Netz

- Status: Offen
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

[ADR-005](005-short-code-pairing.md) verlangt für den regulären Pairingpfad TLS.
Lokales HTTPS kann in Homelab-Netzen jedoch zusätzliche Zertifikats- und
Provisionierungsarbeit verursachen. Unverschlüsseltes HTTP legt Kurzcode und
ausgegebenes Geräte-Credential gegenüber Teilnehmern im lokalen Netz offen.

## Entscheidung

Noch offen ist, ob die erste Version internes LAN-HTTP überhaupt anbietet oder
lokales HTTPS von Anfang an verlangt. Bis zur Entscheidung gilt HTTPS als sicherer
Standard. Eine HTTP-Ausnahme darf nicht stillschweigend aktiv sein; falls sie
implementiert wird, benötigt sie explizite Administratorfreigabe, eine sichtbare
Warnung und eine klar abgegrenzte Vertrauensannahme.

Entschieden wird vor der Implementierung des vollständigen Pairingflows anhand
eines dokumentierten lokalen Zertifikats-/Provisioning-Smoke-Tests und eines
Threat-Model-Reviews.

## Folgen

- Folgepakete können den HTTPS-Pfad implementieren, ohne auf diese Komfortfrage zu
  warten.
- Ein möglicher HTTP-Modus bleibt eine bewusste Sicherheitsentscheidung und keine
  automatische Fallbacklogik.
- Lokale Discovery und Zertifikatsverteilung benötigen gegebenenfalls zusätzliche
  Produktarbeit.

## Alternativen

- **HTTPS ausnahmslos verlangen:** bietet die klare Sicherheitsgrenze, kann aber
  lokale Erstinstallation erschweren.
- **HTTP im LAN standardmäßig erlauben:** vereinfacht den Start, setzt aber ein
  häufig nicht überprüfbares vertrauenswürdiges Netz voraus.
- **HTTP nur für Code, Credential über zweiten Kanal:** vermeidet Zertifikate nicht
  zuverlässig und erhöht die Protokollkomplexität.
