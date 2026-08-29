# ADR-009 – Richtlinie für HTTP-Pairing im lokalen Netz

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

[ADR-005](005-short-code-pairing.md) verlangt für den regulären Pairingpfad TLS.
Lokales HTTPS kann in Homelab-Netzen jedoch zusätzliche Zertifikats- und
Provisionierungsarbeit verursachen. Unverschlüsseltes HTTP legt Kurzcode und
ausgegebenes Geräte-Credential gegenüber Teilnehmern im lokalen Netz offen.

## Entscheidung

HTTPS ist der Produktionsdefault und wird serverseitig erzwungen. Für eine
bewusst vertrauenswürdige lokale Installation darf ein Administrator ausschließlich
über `PAIRING_ALLOW_INSECURE_HTTP=true` und einen Containerneustart HTTP-Pairing
freigeben. Die Pairing-Oberfläche erklärt diese Voraussetzung bei einem 403; sie
aktiviert HTTP nie selbst und leitet die Entscheidung nicht aus Host-Headern ab.

`PAIRING_TRUST_PROXY=true` ist eine davon unabhängige Freigabe für genau einen
TLS terminierenden Reverse Proxy. Nur dann wird dessen `X-Forwarded-Proto` für
die HTTPS-Prüfung berücksichtigt. Der lokale HTTP-Opt-in ersetzt kein TLS und
setzt voraus, dass das lokale Netz ausdrücklich als vertrauenswürdig bewertet
wurde.

## Folgen

- Produktions- und Proxy-Installationen verwenden HTTPS ohne lokale Ausnahme.
- HTTP bleibt eine sichtbare, persistente Administratorentscheidung im Compose-
  Environment und kein automatischer Fallback.
- Bestehende Device-Credentials bleiben von der Transportentscheidung unberührt.

## Alternativen

- **HTTPS ausnahmslos verlangen:** bietet die klare Sicherheitsgrenze, kann aber
  lokale Erstinstallation erschweren.
- **HTTP im LAN standardmäßig erlauben:** vereinfacht den Start, setzt aber ein
  häufig nicht überprüfbares vertrauenswürdiges Netz voraus.
- **HTTP nur für Code, Credential über zweiten Kanal:** vermeidet Zertifikate nicht
  zuverlässig und erhöht die Protokollkomplexität.
