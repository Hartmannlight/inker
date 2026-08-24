# ADR-003 – Explizites Publish-Modell mit unveränderlichen Versionen

- Status: Akzeptiert
- Datum: 2026-08-24
- Ersetzt: –
- Ersetzt durch: –

## Kontext

Displays benötigen reproduzierbare, cachebare Inhalte. Wenn ein Entwurf direkt
ausgeliefert oder ein GET implizit Zustand verändert, entstehen nicht idempotente
Abrufe, Race Conditions und unnötige Schreiblast.

## Entscheidung

Entwurf und ausgelieferter Inhalt sind getrennt. Nur eine explizite Publish-Aktion
erzeugt eine neue, unveränderliche Publication-Version. Eine Änderung am Entwurf
ist für Geräte erst nach einem weiteren Publish sichtbar.

Ein PresentationManifest referenziert genau eine Publication-Version und ihre
Geräte-/Profilvariante sowie versionierte Artefakte mit Hash, MIME-Type, Größe und
`ETag`. Manifest- und Artefakt-GETs sind read-only und idempotent. Sie erhöhen keine
fachliche Revision und schalten keine Playlist weiter. Playlist- und
Rotationszustand wird separat, persistent und deterministisch fortgeschrieben.

Renderer arbeiten gemäß [ADR-007](007-snapshot-only-rendering.md) nur auf der
Publication-Version und den darin referenzierten Snapshot-Versionen. Ein
fehlgeschlagener Render macht die letzte gültige veröffentlichte Revision nicht
unbrauchbar.

## Folgen

- Eine Publication kann reproduziert, per Hash geprüft und über `ETag` gecacht
  werden.
- Entwurfsänderungen benötigen einen sichtbaren Publish-Schritt.
- Neue Versionen und Artefakte brauchen Retention- und Cleanup-Regeln.
- Publish und zugehöriges Outbox-Ereignis müssen atomar persistiert werden.

## Alternativen

- **Entwurf direkt ausliefern:** spart ein Modell, erzeugt aber instabile und
  schwer cachebare Geräteansichten.
- **Publication beim GET aktualisieren:** koppelt Lesen an Schreibzustand und wird
  wegen Race Conditions ausgeschlossen.
- **Artefakte überschreiben:** spart Speicher, verhindert aber reproduzierbare
  Revisionen und sichere Fallbacks.
