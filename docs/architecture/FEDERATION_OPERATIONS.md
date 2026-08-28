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

## Remote-Abonnements betreiben (WP-27)

Die Adminseite `/remotes` verwaltet höchstens 32 Abonnements. Vor dem Anlegen die
Server-UUID über einen vertrauenswürdigen Kanal mit dem Remote-Betreiber prüfen,
eine konkrete Publication freigeben lassen und deren Share-Token übernehmen.
Discovery allein bestätigt keine vertrauenswürdige Identität. Die UI verlangt
die explizite Vertrauensbestätigung. Tokens werden nur im Passwortfeld eingegeben,
nach erfolgreicher Übernahme verworfen und serverseitig mit dem Instanzschlüssel
verschlüsselt. Listenantworten enthalten weder Token noch Credentialreferenzen.

Vor dem Start für API und Worker setzen:

```text
FEDERATION_ALLOWED_ORIGINS=https://remote.example,https://home-remote.example:8443
FEDERATION_PRIVATE_ORIGINS=https://home-remote.example:8443
```

Beide Listen sind standardmäßig leer, maximal 32 kanonische HTTPS-Origins ohne
Pfad, Query, Benutzerinfo oder Wildcards. Die zweite Liste muss eine Teilmenge
der ersten sein. Sie erlaubt ausschließlich für diese Origins RFC1918-, Loopback-
oder IPv6-ULA-Adressen; Link-local, Cloud-Metadata, Multicast, Dokumentations- und
andere gesperrte Spezialbereiche bleiben verboten. Zertifikats- und Hostprüfung
bleiben auch für private Remotes aktiv. Für eine private CA den öffentlichen
Trustanker vor Prozessstart über die Laufzeit-CA-Konfiguration bereitstellen;
niemals `NODE_TLS_REJECT_UNAUTHORIZED=0` verwenden. `FEDERATION_TRUSTED_PROXIES`
betrifft ausschließlich eingehende HTTPS-Nachweise und erlaubt keine ausgehenden
Ziele. Compose reicht alle drei Listen getrennt weiter.

Jeder Abruf prüft sämtliche A-/AAAA-Antworten, bindet die TLS-Verbindung an eine
geprüfte numerische Adresse und prüft den ursprünglichen Hostnamen. Ein frischer
Resolver und Socket werden je Anfrage verwendet. Kein HTTP-Proxy aus der Umgebung,
keine Redirects und keine automatische Credentialweitergabe an ein anderes Ziel.
`304` wird nur nach einem Conditional GET angenommen. DNS ist auf 2 Sekunden,
die gesamte Einzelanfrage auf 5 Sekunden und ein Sync auf 15 Sekunden Netzwerkzeit
begrenzt. Die Queue begrenzt einen Job auf 20 Sekunden, global zwei und pro Remote
beziehungsweise Abonnement einen aktiven Job. Fünf Versuche mit Backoff, ab drei
Fehlern mindestens 30 Sekunden Circuit-Cooldown. Konfigurations-, Identitäts-,
Credential- und Protokollfehler erschöpfen den aktuellen Auftrag sofort; spätere
planmäßige Perioden können eine zwischenzeitlich behobene Ursache erkennen.

Der HTTPS-Reader akzeptiert begrenztes HTTP/1.0 beziehungsweise HTTP/1.1 mit
höchstens 8 KiB Headern. Er lehnt komprimierte Transferinhalte, mehrdeutige
Content-Length/Transfer-Encoding-Kombinationen, Informational Responses,
Chunk-Erweiterungen und Trailerfelder ab. Antwortgrößen werden während des Lesens
begrenzt, nicht erst nach dem Download. PNG-/BMP-Bytes werden vor der kurzen
SQLite-Transaktion auf Hash, Abmessungen und deklarierte Farbpräzision geprüft.

### Lokaler Cache und Status

Ein erfolgreicher Sync schreibt alle Artefaktbytes als unveränderlichen
Publication-Inhalt (`schemaVersion: 2`) samt Outbox-Ereignissen in **eine** lokale
SQLite-Transaktion. Erst ihr Commit aktualisiert den Cachepointer. Keine
Remote-Aktionen, Timer oder Source-Daten werden importiert. Ein identischer Feed
erzeugt keine weitere Revision; `304` validiert auch den lokalen Cache. Ein
beschädigter Cache löst einen vollständigen Neuabruf aus, ohne beschädigte Inhalte
als erfolgreich zu melden. Ein Revisionsrückschritt oder geänderter Inhalt unter
derselben Remote-Revision wird abgelehnt.

Die Refreshperiode ist 60 bis 86400 Sekunden. `pending` bedeutet noch keinen
gültigen Cache, `error` einen fehlgeschlagenen Abruf ohne Cache. `fresh` setzt
einen erfolgreichen Abruf ohne nachfolgenden Fehler voraus. Nach Fehlern oder
zweifacher Refreshperiode ohne Erfolg heißt der vorhandene Cache `stale`.
`disabled` pausiert neue Synchronisationen; vorhandene lokale Inhalte bleiben
auslieferbar. `401`/`403` werden als `REMOTE_UNAUTHORIZED` sichtbar, ein fremdes
Protokoll als `REMOTE_PROTOCOL_MISMATCH`, eine andere UUID als
`REMOTE_IDENTITY_MISMATCH`. Es gibt keinen Fallback auf andere Credentials.

Rotation und Reaktivierung erhöhen die Subscription-Version und sperren damit
laufende alte Jobs gegen spätere Writes. Sie entfernen einen bekannten Fehler
erst nach erfolgreichem Neuabruf. „Jetzt synchronisieren“ erzeugt einen dauerhaften
Auftrag, wartet aber nicht im HTTP-Request auf den Remote. Die UI zeigt dafür eine
Auftragsbestätigung, keinen vorgetäuschten abgeschlossenen Sync.

Ein Gerät kann dem gültigen lokalen Cache zugewiesen werden. Folgende Revisionen
aktualisieren nur Geräte, die noch derselben lokalen Publication zugeordnet sind.
Manuelle Wechsel und laufende oder pausierte Playlists werden nicht überschrieben.
Das Display lädt ausschließlich vom Home-Server und erhält keine Remote-URL oder
Share-Credentials. Ein Remote-Widerruf verhindert zukünftige Abrufe; bereits
rechtmäßig lokal gespeicherte Bilder werden dadurch nicht fernlöscht.

Die Subscription-Identität, Origin und Publication sind unveränderlich. Eine
andere Vertrauensbeziehung erfordert ein neues Abonnement; das alte kann deaktiviert
werden. Löschen und automatischer Identitätswechsel sind nicht Bestandteil dieser
Foundation-Oberfläche. Backup/Restore umfasst SQLite **und** den passenden
Instanzschlüssel. Die Remote-Bytes liegen in SQLite, lokale Renderdateien weiterhin
im vorhandenen privaten Render-Volume. Ohne Schlüssel bleiben gecachte Bilder
lesbar, neue Syncs melden `REMOTE_SECRET_UNAVAILABLE`.

## Reproduzierbare Prüfung

Contracttests unter `contracts/test/federation.test.ts`, API-/Guardtests unter
`backend/src/federation/`, reale SQLite-Tests unter
`backend/test/federation.integration.ts`; vollständige Migrationstests zusätzlich.
`node backend/test/federation-container-smoke.cjs` verwendet das vorher gebaute
`inker:wp26-test`, ausschließlich eigene temporäre Container/Volumes und eine
eigene Test-CA. Der HTTPS-Client prüft Zertifikat und Hostname; es gibt keinen
Abschaltpfad für TLS-Verifikation. Ergebnisse stehen nach Abschluss im WP-26-Handoff.

Die WP-27-Drei-Server-Prüfung startet vom Repository-Root mit
`node backend/test/remote-container-fixture.cjs smoke` nach einem erfolgreichen
Build von `inker:wp27-test`. Sie erstellt ausschließlich eigene, zufällig benannte
und markierte Container, Volumes und ein Netzwerk; veröffentlichte Ports 18728
bis 18730 sind an `127.0.0.1` gebunden. Fremde Dienste werden nicht übernommen.
Der Smoke prüft zwei TLS-Remotes, zwei Browsergeräte, einen Pullclient, echte 304,
Revisionwechsel, Offlinecache, Widerruf, Protokollmismatch und Neustart und räumt
seine Ressourcen auch im Fehlerfall auf. Ein abschließender Secret-Audit prüft
die eigenen Datenbank- und Logausgaben.

Für tatsächliche UI-Prüfungen hält `setup` dieselbe isolierte Umgebung bereit;
`offlineA`, `offlineB`, `onlineA`, `onlineB`, `revokeA` und `restartHome` steuern
nur deren durch Namen und Labels verifizierte Ressourcen. Anschließend immer
`cleanup` ausführen. Die ignorierte Datei `.tmp/wp27-remote-fixture-state.json`
enthält ausschließlich Testzugänge, ist dennoch vertraulich und darf weder
ausgegeben noch committed werden. `inspect` gibt nur begrenzte Statusmetadaten
aus. Zertifikatsprüfung bleibt in allen Modi eingeschaltet.

Unit-/Vertragstests ersetzen die realen SQLite-, Docker- und Browsernachweise
nicht. Die SQLite-Regressionssuite `backend/test/remote-subscriptions.integration.ts`
prüft mit echten Transaktionen und Prozessen atomaren Import, Konkurrenz,
Versions-/Claimfences und Commit-vor-Ack-Recovery. Aus `backend/` mit
`bun test ./test/remote-subscriptions.integration.ts` ausführen; Ergebnisse und
Paketabnahme stehen im WP-27-Handoff. Für die vollständige Backend-Suite
werden neben Testabhängigkeiten die Produktions-Browserbibliotheken benötigt;
ein reines Builder-Image ohne diese Bibliotheken ist kein vollständiger Testhost.
