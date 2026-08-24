# ADR-001 – SQLite-Start und PostgreSQL-Migrationsgrenze

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Inker startet als selbst gehostete Einzelinstallation und verwendet bereits
SQLite. Timer, Pairings, Publications, Source-Snapshots und ausstehende Aktionen
müssen Neustarts überleben. Gleichzeitig soll eine spätere Verteilung auf mehrere
Hosts möglich bleiben, ohne PostgreSQL schon für jede kleine Installation zu
erzwingen.

## Entscheidung

SQLite bleibt die unterstützte Startdatenbank. Sie wird mit WAL, Busy Timeout und
kurzen Transaktionen betrieben. Dauerhafter Fachzustand liegt in der Datenbank;
RAM, Redis und BullMQ dürfen nur abgeleitete oder rekonstruierbare Zustände halten.
Fachliche Änderung und zugehöriges Outbox-Ereignis werden in derselben
Datenbanktransaktion gespeichert.

Die PostgreSQL-Migration wird vor einem produktiven horizontalen Betrieb mit
mehreren API-/Worker-Hosts oder vor Anforderungen an Hochverfügbarkeit und
verwaltete Replikation vollzogen. Sie wird ebenfalls ausgelöst, wenn gemessene
SQLite-Schreibkonflikte trotz WAL, Busy Timeout und kurzer Transaktionen die noch
festzulegenden Betriebsgrenzen verletzen. Reine Datenmenge oder die logische
Prozesstrennung allein erzwingen PostgreSQL nicht.

Der Wechsel ist eine getestete Migration mit Backup, Export/Import beziehungsweise
Vorwärtsmigration und Rollback-Plan. Ein ungeprüfter Laufzeit-Schalter zwischen
Prisma-Providern ist nicht Teil der Entscheidung.

## Folgen

- Kleine Installationen behalten einen einfachen Betrieb und ein einfaches Backup.
- API und Worker können auf einem Host getrennt laufen, solange sie dieselbe
  SQLite-Datei sicher verwenden und die gemessenen Grenzen einhalten.
- Persistenzmodelle und Outbox dürfen keine SQLite-spezifischen Nebenwirkungen als
  fachliches Verhalten voraussetzen.
- Horizontale Skalierung erfordert ein eigenes, vorab getestetes Migrationspaket.

## Alternativen

- **PostgreSQL sofort erzwingen:** bietet früh Mehrhostbetrieb, erhöht aber die
  Betriebslast jeder Homelab-Installation.
- **SQLite ohne definierte Grenze beibehalten:** ist einfach, verschiebt
  Skalierungs- und Verfügbarkeitsrisiken jedoch unkontrolliert in den Betrieb.
- **Queue oder RAM als Quelle der Wahrheit verwenden:** verletzt Restart- und
  Recovery-Anforderungen und wird ausgeschlossen.
