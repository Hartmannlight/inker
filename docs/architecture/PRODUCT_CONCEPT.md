# StatusPanel – Product Concept v0.1

## 1. Vision

StatusPanel is a central, extensible framework for collecting information from
different services and presenting it on heterogeneous displays. A dashboard is
designed once and can be delivered as a web page, an image, or a
device-optimized representation.

Typical displays include browsers, wall-mounted tablets, desktop status views,
ESP32-connected LCDs, and low-refresh e-ink displays.

## 2. Product principles

1. **Separate data from presentation.** A source retrieves and normalizes data;
   a widget decides how that data is shown.
2. **Design for a target display.** Dashboards use explicit device profiles with
   known resolution, orientation, color capability, and refresh behavior.
3. **Render deterministically.** Rendering uses the latest stored data snapshot
   and does not depend on a live third-party request succeeding.
4. **Extend without changing the core.** New sources, widget types, and output
   renderers use documented extension interfaces.
5. **Keep device clients simple.** A device should be able to poll one stable URL
   and receive exactly the representation it can display.
6. **Make stale data visible.** Every source exposes health and last-update
   information so old data is never silently presented as current.

## 3. Domain model and terminology

### Data source

A connector to an external system, for example weather, an email account,
Home Assistant, or an AI provider. It owns credentials, polling/webhook logic,
normalization, caching, and health information.

### Widget type

A reusable panel definition. It declares:

- compatible source data
- editable settings and their schema
- default dimensions and size limits
- web rendering behavior
- behavior for constrained, monochrome, or low-resolution displays

Examples: unread-mail counter, weather card, usage gauge, room climate tile,
clock, text label, and source-health indicator.

### Widget instance

A configured use of a widget type on a dashboard. It selects a source, stores
display settings, and has a position and size.

### Dashboard

A named composition of widget instances with a stable slug, background/theme,
layout, and one or more display variants.

### Device profile

The rendering contract for a target display, including:

- width and height in pixels
- orientation
- color mode or palette, such as RGB, grayscale, 1-bit, or a fixed e-ink palette
- output format
- optional dithering strategy
- safe area and pixel density
- desired refresh interval

### Renderer

Transforms a dashboard plus the latest source snapshots into an output such as
interactive HTML, PNG, JPEG, or a constrained bitmap.

### Device

An optional registered consumer of a dashboard. It has a token, profile,
assigned dashboard, last-seen time, and delivery diagnostics.

## 4. Primary users

### Administrator / operator

Installs the server, configures credentials and sources, manages access, and
checks whether sources and devices are healthy.

### Dashboard designer

Builds dashboards in a visual editor and previews the result for a chosen
display profile.

### Display device

Authenticates with a narrowly scoped token, polls a stable endpoint, and
displays the returned representation.

### Extension developer

Adds a source, widget type, or renderer using stable interfaces and a local
development preview.

## 5. Core use cases

1. Configure a weather source and show current conditions and forecast.
2. Connect an email account and display the unread-message count.
3. Display remaining quota or recent usage for an AI provider.
4. Read selected Home Assistant entities and show states, temperatures, or
   warnings.
5. Combine several widgets on a fixed-resolution dashboard using drag, resize,
   alignment, and layering controls.
6. Preview a dashboard as browser, LCD, grayscale, or e-ink output.
7. Publish a dashboard under a stable URL and retrieve it as HTML or an image.
8. Assign a dashboard to a registered device without putting service
   credentials on that device.
9. Let an ESP32 poll only when content changed, download a ready-to-display
   image, and transfer it to its display over SPI.
10. Diagnose a source that is failing or a device that has stopped polling.

## 6. User stories and acceptance criteria

### Sources

- As an operator, I can create and test a source before saving it, so I know its
  credentials and connection work.
- As an operator, I can see the last successful update, last error, and age of
  the current snapshot for every source.
- As an operator, I can set a polling interval and manually request a refresh.
- As a widget author, I receive versioned, normalized source data rather than
  provider-specific responses.

### Dashboard editor

- As a designer, I choose a device profile before laying out a dashboard, so the
  canvas matches the physical display pixel-for-pixel.
- As a designer, I can add, move, resize, duplicate, configure, and remove widget
  instances.
- As a designer, I get snapping, alignment guides, keyboard movement, undo/redo,
  and an explicit save/publish state.
- As a designer, I can preview constrained palettes and text overflow before
  publishing.
- As a designer, I can create a second layout variant for another profile while
  reusing the same sources and widget settings.

### Publishing and delivery

- As an operator, I can assign a unique slug such as `kitchen-eink` and see all
  URLs available for it.
- As a browser client, I can open a live HTML view that updates without entering
  the editor.
- As a device, I can request a PNG/JPEG/bitmap at an endpoint protected by a
  revocable token.
- As a device, I receive `ETag` and `Last-Modified` metadata and can use
  conditional requests to avoid downloading unchanged content.
- As an operator, I can see the most recent successful device request and the
  representation that was served.

### Extensions

- As an extension developer, I can declare configuration and data schemas and
  validate them without editing core code.
- As an extension developer, I can render realistic fixture data in a preview
  harness.
- As an operator, I can see extension compatibility and errors without bringing
  down other dashboards.

## 7. Suggested UI structure

### Overview

Shows dashboards, source health, registered devices, recent failures, and stale
data warnings. The main action is **Create dashboard**.

### Sources

A catalog of connector types followed by configured instances. Secrets are
write-only after entry. Each detail page contains connection test, refresh
controls, current normalized data preview, and diagnostics.

### Dashboard editor

- **Top bar:** dashboard name, profile/variant selector, undo/redo, preview,
  save, publish
- **Left sidebar:** searchable widget catalog grouped by category
- **Center:** pixel-accurate canvas with zoom, rulers, snapping, and safe area
- **Right sidebar:** selected widget settings, source binding, typography,
  colors, and exact geometry
- **Bottom/status area:** resolution, palette, estimated output size, freshness,
  and validation warnings

The editor should use a fixed canvas per device profile. Purely responsive web
layout is useful for browser-only dashboards but is not sufficient for physical
displays with exact resolutions.

### Preview and publish

Shows the final render at 100% pixels, simulates the target palette, and lists
copyable endpoints plus short integration examples.

### Devices

Lists profile, assigned dashboard, token status, last seen, last content change,
and recent delivery errors.

## 8. Delivery API sketch

Human-facing routes:

- `/view/{dashboard-slug}` – published browser view
- `/editor/{dashboard-id}` – authenticated editor

Device-facing routes:

- `/api/v1/dashboards/{slug}/render.png`
- `/api/v1/dashboards/{slug}/render.jpg`
- `/api/v1/dashboards/{slug}/render.bmp`
- `/api/v1/dashboards/{slug}/data.json`
- `/api/v1/devices/{device-id}/content` – negotiated output for a registered
  device

The device endpoint should support bearer tokens, conditional GET, explicit
content type, checksum, render timestamp, source snapshot timestamp, and cache
headers. Query parameters may support diagnostics and one-off preview sizing,
but stored device profiles should define production output.

## 9. Functional scope

### Foundation

- source registry and versioned snapshot store
- widget registry and schema-driven settings
- dashboard persistence and versioned publish state
- device-profile management
- render queue/cache
- authentication and scoped device tokens
- source/device health and structured logs

### Initial built-in sources

- weather provider
- generic JSON/HTTP source with field mapping
- webhook/push source
- email unread count
- Home Assistant entities

AI usage should follow after validating which providers expose stable usage and
quota APIs. The generic JSON source provides an escape hatch in the meantime.

### Initial built-in widgets

- text and rich value
- clock/date
- icon plus numeric value
- gauge/progress bar
- list of short items
- weather card
- status/alert tile
- image/QR code
- source freshness indicator

### Initial renderers

- browser HTML
- PNG as the lossless general-purpose device output
- JPEG for photo-heavy or bandwidth-sensitive color displays
- 1-bit/grayscale BMP or packed raw pixels for constrained firmware

PNG should be the default for UI-like dashboards because text and line art stay
sharp. JPEG is optional and is usually a poor default for e-ink and small LCD UI.

## 10. Recommended processing model

```text
External service
      │ polling or webhook
      ▼
Data source ──► validated snapshot store ──► widget view model
                                                 │
Dashboard + device profile ──────────────────────┤
                                                 ▼
                                             renderer
                                                 │
                                  render cache + ETag
                                                 │
                                browser / ESP32 / tablet
```

Fetching and rendering are separate jobs. A failed provider call therefore does
not make the render endpoint slow or unavailable; widgets can show the last
known value together with a stale indicator.

## 11. MVP proposal

The first usable release targets one self-hosted installation and one
administrator. It includes:

1. fixed-resolution device profiles for browser, color LCD, and monochrome
   e-ink
2. weather, generic JSON, webhook, and static/demo sources
3. value, text, clock, gauge, weather, and status widgets
4. drag/resize grid editor with settings sidebar and preview
5. versioned save and explicit publish
6. HTML and PNG delivery
7. stable slug, per-device token, caching, `ETag`, and last-seen diagnostics
8. Docker-based local deployment and persistent storage

Not in the first MVP: multi-tenant accounts, a public extension marketplace,
arbitrary user code in the UI, complex animation, native mobile apps, and direct
printer/display drivers in the server.

## 12. Important non-functional requirements

- Credentials are encrypted at rest and never sent to display devices.
- A broken or slow extension cannot block unrelated dashboards.
- Published dashboards remain renderable using cached snapshots during upstream
  outages.
- Rendering the same published version and snapshots produces the same output.
- Fonts are bundled or explicitly managed so server image output matches preview.
- All dates use stored UTC plus an explicit dashboard time zone.
- Backups include configuration, encrypted secrets, dashboards, and profiles;
  transient render caches can be rebuilt.
- The system records extension version, render duration, output size, and errors.

## 13. Decisions to validate before implementation

1. Is the first release strictly personal/self-hosted, or must it support
   multiple users and tenants immediately?
2. Should one dashboard have multiple layout variants, or is each target
   resolution a separate dashboard that can be cloned?
3. Which exact LCD/e-ink controllers and pixel formats must the first device
   client support?
4. Should ESP32 firmware be part of this repository, a separate reference
   client, or outside the project?
5. Which email and AI providers are required first, and which authentication
   methods do they expose?
6. Is Home Assistant reached through its REST/WebSocket API, or should StatusPanel
   also be packaged as a Home Assistant add-on?
7. How should third-party extensions be trusted: installed Python/JavaScript
   packages, subprocesses, containers, or only declarative HTTP mappings?
8. Must the HTML output be interactive, or should it visually match static
   renders exactly?

## 14. Suggested implementation sequence

1. Build a vertical slice with fixture data: one profile, one value widget, one
   dashboard, editor persistence, HTML preview, and PNG render.
2. Add source snapshots, polling, freshness, and generic JSON/webhook connectors.
3. Add publish versions, render caching, ETag, and device tokens.
4. Add constrained palettes and an ESP32 reference client.
5. Add real service connectors and formal extension interfaces only after the
   core contracts have proven stable.
