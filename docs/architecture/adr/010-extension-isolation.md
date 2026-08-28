# ADR-010 – Ausführungsgrenze für Drittanbieter-Erweiterungen

- Status: Akzeptiert
- Datum: 2026-08-28
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Externe Connectoren und Erweiterungen können blockieren, abstürzen oder
unerwarteten Code ausführen. [ADR-006](006-api-worker-separation.md) schließt ihre
Ausführung im API-Prozess und impliziten Zugriff auf Provider-Tokens aus. Die
konkrete Isolationstiefe beeinflusst Erweiterbarkeit, Betrieb und Sicherheit.

## Entscheidung

WP-22 implementiert folgende konkrete Grenze. Die Container-/Integrationsabnahme
ist im [WP-22-Handoff](../WORK_PACKAGES.md#wp-22--isolationsgrenze-für-plugin-blockiercode)
dokumentiert. Sie ist keine Freigabe für zusätzliche native Erweiterungsrechte.

- Geprüfte Built-in-Connectoren bleiben registrierter Anwendungscode im
  Source-Worker. In der Foundation sind ausschließlich die Testconnectoren
  `fixture`, `slow` und `failure` enthalten.
- Unbekanntes JavaScript und deklarative Liquid-Templates laufen in einem
  QuickJS-WASM-Gast innerhalb eines frischen Bun-Kindprozesses pro Ausführung.
  Im API-/Worker-Elternprozess gibt es keine Ausführung dieses Codes durch `vm`,
  `AsyncFunction` oder eine Liquid-Engine.
- Der Gast erhält ausschließlich begrenzte, descriptor-sicher kopierte und
  normalisierte JSON-Daten. Provider-Secrets, Plugin-Settings, Hostfunktionen und
  lebende Hostobjekte werden nicht übergeben. Source-Ergebnisse werden nach einer
  Transformation erneut validiert. Liquid erhält stets `settings: {}`.
- Kein Modul-Loader und keine Hostbindings für Dateisystem, Umgebung oder
  Netzwerk werden registriert. Der vertrauenswürdige Loader startet mit leerer
  Umgebung und unter Bun mit `--no-env-file`; er lädt nur feste installierte
  Laufzeitassets. Native Plugins, npm-Module und beliebige Executables sind nicht
  unterstützt.
- Ein QuickJS-Interruptbudget von 1.000 ms und eine Parent-Deadline von 2.500 ms
  einschließlich Warteschlange begrenzen die Ausführung. Der WASM-Linearspeicher
  ist mit `initial = maximum` hart auf 32 MiB begrenzt; nur
  `runtime.setMemoryLimit()` wäre dafür kein ausreichender Nachweis. Das
  Stacklimit beträgt 512 KiB. Zwei aktive Kinder und 16 wartende Aufträge je
  Elternprozess sowie feste Code-/IPC-/Datenlimits begrenzen Parallelität und
  Ausgabe.
- Bei Abbruch oder Deadline beendet der Parent das Kind und wartet auf dessen
  tatsächliches Schließen. Fehler liefern ausschließlich feste Codes. Source-
  Fehler behalten die letzten gültigen Daten als `stale`; Lease-/Versions-Fencing
  verhindert verspätete Erfolgsschreibvorgänge.

Die Grenze ist keine vollständige OS-Sandbox: Bun-Kind und Parent haben dieselbe
UID, keine separat eingeschränkten Dateisystem-/Netzwerkrechte und kein eigenes
RSS-Limit pro Kind. Die 32 MiB begrenzen den WASM-Linearspeicher, nicht den
Gesamtspeicher von Bun. Engine-/Loader-Sicherheitslücken bleiben ein Risiko.
Separate Container oder OS-Sandboxing werden für native beziehungsweise frei
vernetzte Drittanbieter-Erweiterungen weiterhin gesondert entschieden.

## Folgen

- Die API bleibt bei langsamen oder fehlerhaften Gastaufträgen unabhängig vom
  Gast-Eventloop; Warteschlange und Prozessstart können dennoch Ressourcen kosten.
- Bestehende JavaScript-/Liquid-Aufrufstellen werden asynchron. Fehler sind keine
  erfolgreichen Platzhalterbilder. Nicht-JSON-Ergebnisse und gesperrte Liquid-
  Datei-/Ausführungsfunktionen werden abgewiesen.
- Es entsteht keine öffentliche allgemeine Pluginplattform und kein produktiver
  Connector. Erweiterungen der erlaubten Hostrechte benötigen eine neue ADR und
  erneute adversariale Prüfung.
- [ISOLATION_OPERATIONS.md](../ISOLATION_OPERATIONS.md) hält Limits, Kompatibilität,
  Fehlercodes, Shutdown, Diagnose und die verbleibenden OS-Grenzen fest.
- Endlosschleife, aggregierte Speicherlast, Token-/Hostzugriff, Crash, Abbruch,
  Prozess-Cleanup, Source-Stale/Retry und Wiederherstellung wurden mit echten
  Kindprozessen und dem Produktionscontainer geprüft. Der Paket-Handoff hält die
  Ergebnisse und verbleibenden Grenzen fest; diese Prüfungen bleiben bei einer
  Änderung der Ausführungsrechte oder Runtime erneut erforderlich.

## Alternativen

- **Nur deklarative Erweiterungen:** besitzen die kleinste Angriffsfläche, begrenzen
  aber Integrationsmöglichkeiten; auch Templates benötigen wirksame Grenzen.
- **Unbekannter Code direkt in Bun-/Node-Subprozessen:** trennt den Eventloop,
  gibt ohne zusätzliche OS-Grenze aber zu viele Hostfähigkeiten frei.
- **Eigene Container:** erlauben stärkere Ressourcen- und Netzwerkgrenzen, erhöhen
  aber Deployment- und Plattformkomplexität; für breitere Erweiterungsrechte
  weiterhin eine spätere Option.
