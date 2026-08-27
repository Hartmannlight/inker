# Render cache operations

WP-19 stores render intent in SQLite and transports fenced references through the
BullMQ `render` queue. Rendering consumes only immutable publication snapshots.
Manifest and artifact reads never enqueue work or modify SQL state.

## Storage and identity

- `INKER_RENDER_CACHE_PATH` defaults to `.render-cache` relative to the backend;
  the production image uses `/app/render-cache` and Compose mounts `render_data`.
- This directory is private, outside `/app/uploads` and Nginx static roots.
  Linux directory/file modes are `0700`/`0600`. Only authenticated device
  artifact endpoints expose bytes authorized for the requested device.
- The canonical key includes publication ID/revision/content hash, effective
  profile pixel parameters, explicit snapshot versions and renderer version.
  Device IDs, delivery policies, telemetry and wall-clock time do not enter it.
- `RenderRequest` stores target, renderer version, SHA-256, MIME type, byte size,
  creation and successful completion time. `RenderBinding` retains each device's
  desired, ready and previous compatible keys. Completed metadata is immutable.
- Temporary UUID `.partial` files are flushed before an atomic same-filesystem
  hard link publishes their SHA-256 filename. Metadata becomes ready only after
  image validation, file publication and the final valid outbox lease check.

## Failure and recovery

A failed render leaves ready/previous bindings intact. A reader verifies file
size and SHA-256 and falls back only within the same effective profile variant.
Without compatible cached content, legacy immutable native publication artifacts
remain readable where supported; unavailable/incompatible output remains an
explicit error, never a placeholder claimed as a successful render.

An interrupted worker can leave a complete unreferenced file or `.partial` file;
neither is exposed by the read path. Expired SQLite outbox claims recover through
the existing bounded retry policy (five attempts, backoff/jitter). Redis loss
does not lose render intent. Completed requests do not render again after a lost
acknowledgement. One global BullMQ render slot limits native work. The current
real Redis/process test measured 61.836 seconds for an overlapping render and
delivery process crash: delivery recovered in two attempts and rendering in
three. BullMQ's 30-second lock/stalled checks can outlive the first SQLite lease;
the bounded integration test budgets 100 seconds for complete recovery and
requires no dead letters. A simple Redis restart is tested separately.
Since WP-20, rendering runs in the separate worker process with a 20-second
processing budget and abort checks before domain commits. See
[worker operations](WORKER_OPERATIONS.md). Untrusted plugin isolation remains
the separate WP-22 gate.

Cache hits and fallbacks, misses, completed renders and failures are available
through `RenderCacheService.metrics()`. Persistent diagnostics are
`render_requests.completed_at`, `render_bindings` and `outbox_events` with types
`render.requested` / `render.artifact.ready`; failed events use redacted codes.
WP-28 adds the common operational metrics surface. A new publication-ready image
increments `devices.render_revision`, not the publication or playlist revision.
Web clients compare `(desired sequence, render revision)` so an old retry cannot
replace a newer rendered image.

## Retention and backups

WP-19 conservatively retains all completed artifacts and render requests.
Publication cleanup retains referenced render inputs. There is no automatic
age-only deletion of ready, previous or pending content. Monitor disk growth;
size-based garbage collection is not silently enabled. Orphan `.partial` files
may be removed only while the worker is stopped, after verifying they are inside
this cache directory; do not remove hash files or edit ready SQL metadata.

Stop the application and back up `render_data` with the matching uploads/SQLite
snapshot; keep the instance-secret backup separately protected as before. Restore
all three from the same stopped backup set. A database-only restore can preserve
metadata but lose the referenced pixels. A damaged/missing hash file must be
restored from a verified backup with its original SHA-256, or a new explicit
publication must be produced. The renderer never overwrites a completed hash
file or rewrites an immutable successful record to conceal corruption.

Physical TRMNL/ESP32 image, refresh and power measurements remain open. E-Ink
metadata requests full refresh conservatively and carries configured
`fullRefreshAfterUpdates`; no measured firmware threshold is invented.
