# API and worker operations

WP-20 separates the read/control API from queue work on one host and one SQLite
database. Multiple hosts remain outside this deployment model (ADR-001).
The production-image tests passed worker stop/resume, frozen-worker reads and
fail-closed initialization. Package acceptance and measured results are recorded
in `docs/architecture/WORK_PACKAGES.md`.

## Processes and startup

`bun run build` produces two independent Nest bundles:

| Process | Command | Responsibilities |
|---|---|---|
| API | `bun run start:prod` | HTTP, auth, commands, manifests, authenticated files, sockets and their delivery acknowledgements |
| Worker | `bun run start:worker:prod` | Durable outbox dispatch, source refresh, rendering, playlist/timer transitions, remote synchronization and maintenance |

Development can start the worker with `bun run start:worker`. Both processes use
the same validated environment, instance key file, `DATABASE_URL`, private render
directory and local Redis. A second worker must use a distinct
`WORKER_HEALTH_PORT`; the default is 3001, bound only to `127.0.0.1`.

The production image keeps the existing single-container deployment. Its s6
initializer prepares private storage, validates/initializes secrets, applies
versioned migrations and seeds reference data **once before either process**.
Failure aborts initialization; neither service may start without the volatile,
root-owned success marker. A service restart does not repeat migrations or the
initializer's `prisma/seed.ts`. API module initialization still checks built-in
plugin and widget-template seeds: missing entries are created; unchanged entries
are not written. Existing profile and policy configuration is preserved. For the
DaysUntil template, changed managed fields (`label`, `description`, `defaultConfig`,
`minWidth`, `minHeight`) are updated to the bundled defaults; other existing template
configuration is preserved. Schema/reference upgrades outside these managed
template defaults belong in tested migrations.

## Readiness and degradation

- `/health` probes the API database through Nginx; it is no longer a static Nginx
  200 response.
- `/ready` returns API readiness based on its database, with a separate
  `background` object. Missing workers or Redis produce background `degraded`,
  while existing manifests and cached images remain available.
- Worker `http://127.0.0.1:3001/ready` requires its database, running local queue
  processors, both command/blocking Redis clients and a current heartbeat.
  Paused processors or disconnected clients return 503 and withdraw presence.
- Worker heartbeats expire after eight seconds and are reconstructed in Redis;
  they never become the source of durable job truth.

Do not turn a background-degraded response into API removal from service. New
commands remain durable while processing waits. Investigate SQLite outbox
`pending`, `processing` and `dead-letter` states separately from socket health.

## Queue policies

The implementation source is `backend/src/jobs/queue-policy.ts`. All jobs use
version 1 and the compatible Redis prefix `inker-wp16`. The queue payload carries
only the event ID and claim token; the authoritative input lives in SQLite.

| Group | Timeout | Local / global concurrency | Rate limit per second |
|---|---:|---:|---:|
| source-refresh | 8 s | 2 / 4 | 8 |
| render | 20 s | 1 / 1 | 4 |
| delivery | 8 s | 4 / 4 | 32 |
| timer | 8 s | 2 / 2 | 16 |
| maintenance | 20 s | 1 / 1 | 2 |
| remote-sync | 20 s | 1 / 2 | 4 |

WP-21 activates source refresh for the built-in fixture, slow and failure
connectors only. The global limit is four, with two per provider group, two per
connector type and one per source. These limits are claimed atomically in SQLite.
Provider credentials stay outside snapshots and rendering. See
`SOURCE_OPERATIONS.md` for scheduling, timeouts, retries and circuit breakers;
the old model poller and direct provider refresh paths remain disabled.

WP-27 adds read-only remote publication synchronization. In addition to the
global budget, at most one job may own a given remote or subscription at once.
The complete network phase is bounded to 15 seconds. Origin/DNS/TLS rules,
credential handling, conditional GETs, local cache and circuit behavior are
documented in [federation operations](../architecture/FEDERATION_OPERATIONS.md).
Displays still connect only to their home server.

Durable attempts are bounded at five, with exponential 1–60 second backoff plus
0–20% additive jitter. Each fenced Redis job has only one transport attempt, so
Redis retries cannot multiply the durable retry budget. Completed Redis jobs are
removed; failed transport diagnostics retain at most 100 jobs for one day.
SQLite retains terminal outbox records for 30/90 days and permanent dedupe
receipts according to the existing retention policy.

Expired 30-second SQLite claims recover after process or queue loss. BullMQ's
separate lock/stalled checks may delay complete recovery across another cycle;
the integration test measured about 62 seconds for overlapping render and
delivery crashes. Completed work is fenced/idempotent on replay. A Redis queue
must never be emptied to "fix" a backlog.

## Shutdown and maintenance

The worker stops claiming jobs and fetching queue work, withdraws presence and
allows up to 22 seconds for active work before aborting and closing transport.
This happens **before** Nest destroys database providers. Job abort signals are
checked before domain commits; unfinished leases recover on restart. Sharp uses
bounded processing time as well as the job abort signal. Untrusted/plugin-code
process isolation is the separate WP-22 gate.

s6 grants 28 seconds to services; Compose grants 35 seconds to the container.
Use an equivalent timeout for manual Docker stop/restart. To control only the
worker in a known container, use `/command/s6-svc -d /run/service/worker` and
`/command/s6-svc -u /run/service/worker` through `docker exec`. The absolute path
is required because `docker exec` does not add s6's `/command` directory to PATH.

Maintenance has one deterministic UTC-hour outbox identity and a durable effect
receipt. Log cleanup and publication/outbox retention run in one fenced
transaction, using that scheduled hour as their fixed cutoff. API cron and
startup timers, and the duplicate unregistered cleanup processor, are removed.
Retention never removes live work, ready render inputs or referenced content.

For backups stop the entire container, not only the worker: API commands and
telemetry can still write SQLite. Follow `DATABASE_BACKUP.md` and
`RENDER_CACHE.md` for the complete matching volume set.

## Operations diagnostics (WP-28)

The authenticated `/operations` page and `/api/operations/metrics` expose bounded,
read-only diagnostics. Missing worker/Redis samples remain unknown rather than
zero. `/live` checks the API process; `/ready` distinguishes SQLite readiness
from degraded background work. Worker probes stay on container loopback port 3001.
See [observability operations](../architecture/OBSERVABILITY_OPERATIONS.md) for
metric names, sample freshness, correlation, log rotation and test reproduction.
The 30-second queue-age warning is a diagnostic threshold, not a capacity promise;
combined load and recovery limits must be established by WP-29.

## Repeat the process checks

For the complete current acceptance pipeline, including every integration,
combined load/faults and full restore, follow [Foundation verification](FOUNDATION_RELEASE.md).
The commands below are the narrower historical process checks, not the WP-29 gate.

After building a local `inker:wp25-test` image, run from `backend/`:

```text
INKER_SMOKE_IMAGE=inker:wp25-test node test/websocket-container-smoke.cjs
INKER_SMOKE_IMAGE=inker:wp25-test node test/worker-startup-container.cjs
INKER_SMOKE_IMAGE=inker:wp25-test bun test ./test/outbox-redis.integration.ts
```

These tests create and remove their own disposable containers. The negative
startup cases expose no ports, have no network or volumes, and inject a broken
seed only into their own writable container layer. They verify nonzero container
exit, no API/worker startup, missing readiness marker and absence of test secrets.
The normal smoke proves worker exit zero, queue recovery, existing WebSocket
continuity, cached artifacts and 20 reads with an actually frozen worker.
It also checks the authenticated [interaction pipeline](../architecture/INTERACTION_OPERATIONS.md),
concurrent duplicate touch events and their durable receipt after restart.
The [timer domain](../architecture/TIMER_OPERATIONS.md) fixture covers private/shared
authorization, state transitions and persistent anchors without database ticks.
On PowerShell set `$env:INKER_SMOKE_IMAGE='inker:wp25-test'` before the Node command.

WP-25 adds durable timer completion to the existing timer queue, including startup
reconstruction from SQLite, authorized WS invalidations and the next pull state.
Unchanged recovery is read-only; early execution after a clock correction is deferred
without consuming the failure budget. See [timer operations](../architecture/TIMER_OPERATIONS.md)
for deadline recovery, private/shared visibility and the isolated two-browser fixture.
