# StatusPanel – Ideen und geplanter Ausbau

Dieses Dokument ist der gemeinsame Backlog für Funktionen, die wir später
umsetzen möchten. Erledigte Punkte werden mit `[x]` markiert. Anforderungen,
die bereits entschieden sind, stehen unter **Festgelegt**; noch nicht
entschiedene Details stehen unter **Offene Fragen**.

## Nächster sinnvoller Ausbau

- [ ] Einheitlichen Datenkontext für Widgets definieren.
- [ ] Berechnete Werte aus einem oder mehreren Datenfeldern ermöglichen.
- [ ] Bedingungen für Sichtbarkeit und Aktivierung von Panels einführen.
- [ ] Dynamische Bereiche mit Priorisierung und Wechselsteuerung umsetzen.
- [ ] Temperaturdifferenz als ersten durchgängigen Anwendungsfall bauen.
- [ ] Regenwarnung zunächst mit Testdaten, danach mit einer echten Datenquelle
      erproben.
- [x] Das vorhandene „Days Until“-Widget zu einem Fortschritts-Widget
      erweitern.

## 1. Dynamische Bereiche

Ein dynamischer Bereich ist ein fester Platz auf einem Dashboard. In diesem
Bereich können abhängig von Daten und Regeln unterschiedliche, gewöhnliche
Panels angezeigt werden. Dadurch muss für seltene Hinweise wie eine
Regenwarnung kein dauerhaft leerer Platz reserviert werden.

### Festgelegt

- [ ] Jeder bereits vorhandene Panel-/Widget-Typ kann in einem dynamischen
      Bereich verwendet werden.
- [ ] Ein dynamischer Bereich kann ein Standard-Panel besitzen, das angezeigt
      wird, wenn keine besondere Bedingung aktiv ist.
- [ ] Für jedes Panel im Bereich kann eine Aktivierungsbedingung konfiguriert
      werden.
- [ ] Für jedes bedingte Panel kann eine Priorität konfiguriert werden.
- [ ] Sind mehrere Panels aktiv, werden Panels mit der höchsten Priorität
      bevorzugt.
- [ ] Sind mehrere aktive Panels gleich priorisiert, wechseln sie sich nach
      einem konfigurierbaren Zeitintervall ab.
- [ ] Wird ein Panel mit niedrigerer Priorität neu aktiviert, wird es trotz
      eines bereits aktiven höher priorisierten Panels einmal angezeigt.
- [ ] Nach dieser einmaligen Anzeige gilt wieder die normale
      Prioritätsreihenfolge.
- [ ] Das einmalige Anzeigen wird nur durch den Wechsel von „nicht aktiv“ zu
      „aktiv“ ausgelöst, nicht bei jeder erneuten Datenabfrage.
- [ ] Darstellung und Verhalten müssen in der Vorschau mit frei setzbaren
      Testdaten überprüfbar sein.

### Vorgeschlagenes Laufzeitverhalten

1. Neu aktivierte Panels werden in eine einmalige Anzeige-Warteschlange
   aufgenommen.
2. Die Warteschlange wird angezeigt, auch wenn ein Eintrag eine niedrigere
   Priorität als das aktuell sichtbare Panel hat.
3. Danach wird das aktive Panel mit der höchsten Priorität angezeigt.
4. Bei gleicher höchster Priorität rotiert die Anzeige im konfigurierten
   Intervall durch alle entsprechenden Panels.
5. Sobald kein bedingtes Panel mehr aktiv ist, erscheint das Standard-Panel.

### Konfiguration pro dynamischem Bereich

- [ ] Name des Bereichs
- [ ] Standard-Panel/Fallback
- [ ] Enthaltene Panels
- [ ] Aktivierungsbedingung je Panel
- [ ] Priorität je Panel
- [ ] Dauer der einmaligen Anzeige eines neu aktivierten Panels
- [ ] Wechselintervall für gleich priorisierte Panels
- [ ] Verhalten bei fehlenden oder veralteten Daten

### Technische Aufgaben

- [ ] Datenmodell für dynamische Bereiche und enthaltene Panel-Varianten
      entwerfen.
- [ ] Regelmodell mit Vergleichen, UND, ODER und NICHT definieren.
- [ ] Aktivierungszustände dauerhaft speichern, damit ein Serverneustart oder
      erneutes Rendern keine wiederholte „Neu aktiviert“-Anzeige auslöst.
- [ ] Warteschlange für neu aktivierte Panels implementieren.
- [ ] Deterministische Prioritäts- und Rotationslogik implementieren.
- [ ] Editor für Bereich, Panels, Bedingungen, Prioritäten und Intervalle
      ergänzen.
- [ ] Browser- und Server-Renderer auf dasselbe Auswahlverhalten bringen.
- [ ] Übergänge, gleichzeitige Aktivierungen und deaktivierte Panels testen.

### Display-Hinweis

Browser-Displays können tatsächlich alle paar Sekunden wechseln. Bei E-Ink
sollte der Wechsel an die erlaubte Aktualisierungsrate des Geräts gekoppelt
werden, um Ghosting, hohen Stromverbrauch und unnötige Schreibzyklen zu
vermeiden. Die Konfiguration soll deshalb je Zielgerät geprüft beziehungsweise
auf ein sicheres Minimum begrenzt werden.

### Offene Fragen

- [ ] Soll ein neu aktiviertes Panel sofort unterbrechen oder beim nächsten
      regulären Wechsel angezeigt werden?
- [ ] In welcher Reihenfolge werden mehrere gleichzeitig neu aktivierte Panels
      einmalig angezeigt: Aktivierungszeit, Priorität oder konfigurierbare
      Reihenfolge?
- [ ] Soll die einmalige Anzeige auch erfolgen, wenn das Panel nur sehr kurz
      aktiv war und die Bedingung vor seiner Anzeige wieder endet?

## 2. Regenwarnung ohne dauerhaft reservierten Platz

Eine Regenwarnung soll nur erscheinen, wenn für den eigenen Standort aktuell
oder innerhalb eines konfigurierbaren Zeitraums Regen erkannt wird. Sie wird als
Panel in einem dynamischen Bereich verwendet und ersetzt dort vorübergehend den
normalen Inhalt.

### Anforderungen

- [ ] Standort beziehungsweise überwachten Bereich konfigurieren.
- [ ] Warnzeitraum konfigurieren, standardmäßig die nächsten zwei Stunden.
- [ ] Zwischen „regnet aktuell“ und „Regen erwartet“ unterscheiden.
- [ ] Erwarteten Beginn, Intensität und Wahrscheinlichkeit anzeigen, sofern die
      Datenquelle diese Werte liefert.
- [ ] Mindestwahrscheinlichkeit beziehungsweise Intensität als Schwelle
      konfigurieren.
- [ ] Regenwarnung mit einer höheren oder niedrigeren Priorität als andere
      Hinweise konfigurieren können.
- [ ] Fehlende und veraltete Wetterdaten sichtbar behandeln.

### Umsetzungsschritte

- [ ] Datenmodell und Anzeige zunächst mit festen Testdaten entwickeln.
- [ ] Geeignete Wetterradar-/Nowcast-Datenquelle auswählen.
- [ ] Daten serverseitig abrufen, normalisieren und zwischenspeichern.
- [ ] Aktivierungsregel für „jetzt oder innerhalb der nächsten N Minuten“
      anlegen.
- [ ] Verhalten auf Browser- und E-Ink-Displays testen.

## 3. Berechnete Werte und kombinierte Datenquellen

StatusPanel soll aus vorhandenen Serverdaten neue Werte berechnen können, ohne
dass für jede Berechnung ein eigener externer API-Endpunkt gebaut werden muss.

### Anforderungen

- [ ] Werte aus einer Datenquelle miteinander verrechnen.
- [ ] Werte aus mehreren Datenquellen kombinieren.
- [ ] Grundrechenarten, Vergleiche, Rundung, Min/Max und Prozentrechnung
      unterstützen.
- [ ] Berechnete boolesche Werte als Aktivierungsbedingungen verwenden.
- [ ] Einheit und Zahlenformat für Ergebnisse konfigurieren.
- [ ] Verhalten bei fehlenden, ungültigen oder veralteten Eingangswerten
      konfigurieren.
- [ ] Berechnung mit gespeicherten Testdaten in der UI ausprobieren können.

### Erster Anwendungsfall: Temperaturdifferenz

- [ ] Innentemperatur auswählen.
- [ ] Außentemperatur auswählen.
- [ ] `Differenz = Innentemperatur - Außentemperatur` berechnen.
- [ ] Vorzeichen, Einheit und Rundung konfigurieren.
- [ ] Optional abhängig vom Ergebnis einen Hinweis auslösen, zum Beispiel
      „Fenster öffnen“.

## 4. Fortschritt bis zu einem Ereignis

Das vorhandene „Days Until“-Widget soll neben der verbleibenden Zeit auch den
bereits erreichten Fortschritt visualisieren können.

### Eingabemöglichkeiten

- [x] Startdatum und Zieldatum
- [x] Startdatum und direkte Angabe der Anzahl Tage
- [x] Optional nur Zieldatum für die bisherige reine Resttage-Anzeige
- [x] Auswahl zwischen Kalendertagen und Arbeitstagen
- [x] Standard für Arbeitstage: Montag bis Freitag
- [ ] Optional Wochenendtage individuell ein-/ausschließen
- [ ] Optional Feiertage über Land/Bundesland oder eine manuelle
      Ausschlussliste berücksichtigen

### Berechnung

- [x] Gesamte relevante Tage berechnen.
- [x] Bereits vergangene relevante Tage berechnen.
- [x] Verbleibende relevante Tage berechnen.
- [x] Fortschritt auf `0–100 %` begrenzen.
- [x] Verhalten vor dem Start und nach dem Ziel definieren.
- [ ] Zeitzone und Tagesgrenzen konsistent zwischen Vorschau und Server-Render
      behandeln.

### Designs

- [x] Nur verbleibende Zahl, zum Beispiel „60 Tage bis zum Urlaub“
- [x] Horizontaler Fortschrittsbalken
- [ ] Vertikaler Fortschrittsbalken
- [ ] Fortschrittsring
- [x] Reihe aus Fortschrittssegmenten
- [ ] Kompakte Textzeile mit Prozentwert
- [x] Große Zahl mit kleinem Balken
- [ ] Für 1-Bit-E-Ink geeignete Muster statt nur farblicher Unterschiede
- [ ] Beschriftungen, Reihenfolge und sichtbare Kennzahlen konfigurierbar machen

## 5. Allgemeine Regeln und Überschreibungen

- [ ] Widgets abhängig von Daten anzeigen oder ausblenden.
- [ ] Ein Widget durch ein anderes Widget ersetzen.
- [ ] Bedingungen über einfache Feldauswahl statt ausschließlich JavaScript
      konfigurierbar machen.
- [ ] Regeln aus mehreren Bedingungen mit UND/ODER/NEGATION zusammensetzen.
- [ ] Regelprioritäten und Konflikte nachvollziehbar in der UI darstellen.
- [ ] In der Vorschau erklären, warum gerade ein bestimmtes Panel sichtbar ist.
- [ ] Fallback bei Fehlern und veralteten Daten definieren.

## 6. Qualität und Betrieb

- [ ] Browser-Vorschau und erzeugtes PNG/BMP pixel- und inhaltsgleich halten.
- [ ] Zeitabhängige Logik mit kontrollierter Systemzeit testen.
- [ ] Arbeitstage über Monats- und Jahresgrenzen testen.
- [ ] Sommer-/Winterzeit und unterschiedliche Zeitzonen testen.
- [ ] Gleichzeitige Aktivierungen und Prioritätswechsel testen.
- [ ] Datenalter und letzten erfolgreichen Abruf sichtbar machen.
- [ ] Render-Cache bei relevanten Zustandsänderungen gezielt invalidieren.
- [ ] Sichere Aktualisierungsintervalle für verschiedene Displayprofile
      berücksichtigen.
