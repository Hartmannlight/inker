# Föderation – Betrieb und Vertrauensgrenzen

## Veröffentlichung anbieten (WP-26)

Ein ShareCredential liest genau eine ausdrücklich veröffentlichte Publication.
Es ist kein Admin-, Geräte-, Pairing- oder Connector-Credential. Ein Share erlaubt
weder Drafts noch Source-Snapshots, Secretzugriff, Timer- oder Geräteaktionen.
Der Feed enthält ausschließlich Artefaktmetadaten, keine lokalen Aktionsangebote.
Das Bild selbst kann selbstverständlich sensible veröffentlichte Inhalte zeigen:
vor der Freigabe die Publication prüfen.

| Methode und Pfad unter `/api/federation` | Anmeldung | Ergebnis |
| --- | --- | --- |
| `GET /v1/capabilities` | keine; HTTPS erforderlich | Protokoll 1.0, Server-ID, Features und Limits |
| `GET /v1/publications/:publicationId` | Share-Bearer | neueste veröffentlichte Revision |
| `GET /v1/publications/:publicationId/revisions/:revision/artifacts/:sha256` | derselbe Share-Bearer | hashgeprüfte unveränderliche Bildbytes |
| `POST /publications/:publicationId/shares` | Admin-Session und CSRF | neues Credential; Klartexttoken nur einmal |
| `GET /publications/:publicationId/shares` | Admin-Session | maximal 100 jüngste Auditdatensätze, `truncated` |
| `DELETE /publications/:publicationId/shares/:credentialId` | Admin-Session und CSRF | endgültiger, idempotenter Widerruf |

POST akzeptiert `{}` oder `{ "expiresAt": "2030-01-01T00:00:00.000Z" }`;
`null` bedeutet keinen Ablauf. Der Zeitpunkt muss bei Erstellung in der Zukunft
liegen. Keine zusätzlichen Felder oder veränderbaren Scopes. Admin-Antworten
verwenden den bestehenden `data`-Umschlag; Feed/Capabilities liefern direktes JSON.
Nur den Tokenwert der einmaligen Antwort über einen sicheren Kanal an den
Home-Server übergeben. Nicht in URLs, Shellhistorie, Screenshots oder Logs kopieren.
Anmeldungen erfolgen ausschließlich als `Authorization: Bearer <token>`.

Persistiert werden ein SHA-256-Hash mit eigenem Namespace, Publication-ID,
Credential-ID, Erstellungs-/Ablauf-/Widerrufszeit und erzeugender Admin. 48 zufällige
Bytes bilden das Token. Maximal 16 aktive Shares pro Publication und 128 pro
Instanz; Prüfung und Anlage sind transaktional gegen parallele Erstellung gesichert.
Auditdaten bleiben 180 Tage nach Ablauf/Widerruf erhalten; die nächste Shareanlage
räumt ältere inaktive Datensätze auf. Ein Widerruf ist nicht rückgängig zu machen.
Rotation: neuen Share ausgeben, Home-Server umstellen, alten Share widerrufen.

Fehlendes, falsches, abgelaufenes, widerrufenes oder fremd gescoptes Credential
ergibt immer `401 SHARE_UNAUTHORIZED`. Authentifizierung wird vor und nach dem
Lesen geprüft, auch bei `304`. Datenbankfehler ergeben einen festen `503`-Fehler;
keine Datenbankdetails oder Credentialwerte gehören in Antworten. GETs erzeugen
weder Renderarbeit noch Datenbankwrites. Eine Server-ID wird einmal beim
API-Start angelegt; sie bleibt bei Neustart/Backup-Restore erhalten. Eine geklonte
Instanz mit derselben Datenbank ist dieselbe Föderationsidentität und darf nicht
als unabhängiger Remote betrieben werden.

## HTTPS und Proxykonfiguration

Es gibt keine HTTP-Ausnahme für Föderation. `PAIRING_ALLOW_INSECURE_HTTP` und
`PAIRING_TRUST_PROXY` heben diese Regel nicht auf. Der normale HTTP-Listener des
All-in-one-Images antwortet auf Föderationszugriffe mit
`403 FEDERATION_HTTPS_REQUIRED`, auch wenn ein Client `X-Forwarded-Proto: https`
sendet. Das ist beabsichtigt, bis der Betreiber HTTPS eingerichtet hat.

Bei TLS-Terminierung vor der API muss `FEDERATION_TRUSTED_PROXIES` die **tatsächliche
unmittelbare Socket-Peer-IP** des kontrollierten Proxys enthalten, kommasepariert,
höchstens 32 IP-Literale. Standard ist leer. Keine Hostnamen, CIDRs oder Wildcards.
IPv4 und IPv4-mapped IPv6 sind verschiedene exakte Einträge. Der Proxy muss
`X-Forwarded-Proto` selbst aus der tatsächlich terminierten TLS-Verbindung setzen
und Clientwerte überschreiben. Er muss direkten unverschlüsselten Zugriff auf
die Backend-Schnittstelle verhindern. Der Headerwert muss exakt `https` sein.

Beispiel bei TLS-Terminierung im eigenen Container-Nginx: dessen Listener mit
betriebsseitigen Zertifikaten auf HTTPS konfigurieren und
`FEDERATION_TRUSTED_PROXIES=127.0.0.1,::1` setzen. Die vorhandene spezifische
`/api/federation/`-Location setzt den Header aus `$scheme`. Bei vorgeschaltetem
externem TLS-Proxy genügt ein durchgereichter Clientheader **nicht**: eine
kontrollierte HTTPS-Verbindung zum inneren Listener verwenden oder eine explizite,
nur vom Edge erreichbare Listenerkonfiguration mit eigener Vertrauensgrenze
einrichten. Niemals pauschal fremde Forwarded-Header übernehmen.

## Vertrag, Cache und Grenzen

`@inker/contracts` exportiert `FederationCapabilities`,
`FederationPublicationFeed`, `FederationArtifact` und die zugehörigen Parser.
1.0 ist strikt; unbekannte Minor-Versionen derselben Major-Linie werden mit
Warnung angenommen und auf bekannte Felder projiziert. Andere Major-Versionen
werden abgelehnt. Der Home-Server muss die stabile UUID aus Discovery und jedem
Feed vergleichen; ein Identitätswechsel ist keine automatische Vertrauensübernahme.

- Manifest maximal 64 KiB, 1–8 Artefakte, je maximal 2 MiB, zusammen maximal 8 MiB.
- PNG oder monochromes BMP; maximal 8192 Pixel je Dimension und 16.777.216 Pixel.
- Artefakt-ID entspricht SHA-256. URL ist ein relativer, publication- und
  revisionsgebundener Pfad ohne Token, Query, fremden Origin oder Redirectziel.
- Feed-ETag bildet den gesamten kanonischen Feed ab; Artefakt-ETag seinen Hash.
  `If-None-Match` unterstützt 304; Antworten sind `private, no-cache` und
  `Vary: Authorization`. Fehler und Credentialverwaltung sind `no-store`.
- Bereits gelesene ältere Artefaktrevisionen bleiben während ihrer normalen
  Publication-Retention abrufbar. Widerruf/Ablauf sperrt auch diese URLs sofort.
  Latest bleibt erhalten; ältere unreferenzierte Revisionen unterliegen der
  vorhandenen 90-Tage-Retention, nicht einer neuen Share-Ausnahme.

## Übergabe an WP-27

Der Home-Server speichert eigene verschlüsselte Credentialreferenzen und prüft
HTTPS, erlaubte Origins, DNS/IPs, Rebinding, Redirects und Größen schon vor bzw.
während des Abrufs. Er akzeptiert nur gehashte Artefakte des bestätigten Remotes
und schreibt Cacheeinträge atomar. `401` bedeutet sichtbaren Credentialfehler,
kein Wechsel zu Admin-/Gerätecredentials. Bei Ausfall bleibt ausschließlich die
letzte gültige lokal gespeicherte Revision sichtbar mit Stale-Diagnose.
Keine direkte Multi-Server-Verbindung des Displays und kein Source-Import.

## Reproduzierbare Prüfung

Contracttests unter `contracts/test/federation.test.ts`, API-/Guardtests unter
`backend/src/federation/`, reale SQLite-Tests unter
`backend/test/federation.integration.ts`; vollständige Migrationstests zusätzlich.
`node backend/test/federation-container-smoke.cjs` verwendet das vorher gebaute
`inker:wp26-test`, ausschließlich eigene temporäre Container/Volumes und eine
eigene Test-CA. Der HTTPS-Client prüft Zertifikat und Hostname; es gibt keinen
Abschaltpfad für TLS-Verifikation. Ergebnisse stehen nach Abschluss im WP-26-Handoff.
