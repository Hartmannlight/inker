# ADR-008 – Hardwaredetails bleiben bis zur Messung Annahmen

- Status: Offen
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Die Foundation soll TRMNL-, ESP32- und Raspberry-Pi-/Browser-Geräte unterstützen.
Einige konkrete Hardwareeigenschaften sind noch nicht praktisch verifiziert.
Fest codierte Produktwerte würden die Verträge vorzeitig auf einzelne Geräte
verengen.

## Entscheidung

Bis zur Messung gelten Hardwaredetails ausschließlich als Annahmen. Verträge und
Fachlogik verwenden gemeldete `DeviceCapabilities` und auflösbare
`DeviceProfile`, insbesondere für Auflösung, Farbtiefe, Formate, Touch, Audio,
Energieprofil, Mindest-Refresh und Transport. Ein Beispielprofil ist keine
Garantie für alle Geräte derselben Produktbezeichnung.

Folgende Fragen bleiben ausdrücklich offen:

- exakte Auflösung, Displaycontroller und Netzwerkstack der ESP32-S3 86 Box;
- Repositorygrenze für ESP32-Client, gemeinsames Repository oder separates
  Firmware-/SDK-Repository;
- praktisch zuverlässiges minimales Refresh-Intervall der TRMNL-BYOD-Firmware im
  Netzbetrieb.

Die Punkte werden durch Inspektion realer Hardware beziehungsweise Firmware und
reproduzierbare Messungen entschieden. Das Ergebnis ersetzt dieses ADR oder setzt
es auf `Akzeptiert`; bis dahin darf kein Implementierungspaket die Annahmen als
feste Wahrheit ausgeben.

## Folgen

- Kernverträge bleiben gerätegenerisch und neue Hardware kann über Profile
  hinzukommen.
- Referenzclients benötigen Capability-Erkennung oder explizite Konfiguration.
- Einzelne DeliveryPolicy-Werte können erst nach Hardwaretests verbindlich werden.

## Alternativen

- **Werte aus Produktnamen ableiten:** ist bequem, aber ohne Hardwareverifikation
  fragil und schlecht erweiterbar.
- **Nur ein universelles Minimalprofil:** vermeidet falsche Details, nutzt jedoch
  vorhandene Gerätefähigkeiten unnötig schlecht.
- **Alle Hardwarefragen vor der Foundation blockierend klären:** reduziert offene
  Punkte, verzögert aber unabhängige Vertrags- und Persistenzarbeit.
