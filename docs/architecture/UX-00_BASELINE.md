# UX-00 – Reproducible fault baseline

Recorded: 2026-08-29
Repository revision: `06e337b5f0b0b50675382faeece2b0db85fbd170`
Branch: `codex/device-platform-spike`

## Safety

No Grafana credential was supplied, read, stored, or sent. The reported old
Grafana token must be revoked by its owner before a real Grafana smoke test.
All fixtures below use temporary SQLite databases and synthetic credentials.

## Reproductions

| Symptom | Reproducible request or fixture | Current expected result | Correlation evidence |
| --- | --- | --- | --- |
| Grafana dashboard list | `POST /api/plugins/grafana/dashboards` for any valid parent instance | `503 SOURCE_REFRESH_REQUIRES_CONNECTOR` | API failures emit a server-generated `X-Correlation-ID`; the client cannot choose it. |
| Design preview through legacy URL | `GET /api/device-images/design/:id` | `410 PUBLICATION_REQUIRED`, without an existence lookup | Same response header and body correlation convention. |
| Device preview through legacy URL | `GET /api/device-images/device/:id` | `410 PUBLICATION_REQUIRED`, without an existence lookup | Same response header and body correlation convention. |
| Short-code exchange over HTTP | Valid exchange request without TLS and without `PAIRING_ALLOW_INSECURE_HTTP=true` | `403 Pairing requires HTTPS` | Request receives a generated correlation ID. |
| Short-code exchange over HTTPS / allowed HTTP | Valid one-time code, TLS or explicit opt-in | Credential issuance succeeds once and atomically revokes a previous credential. | Enrollment integration fixture proves the durable state change without exposing the generated credential. |
| Display manifest | Authenticated browser or pull display reads a desired publication | No provider fetch occurs during the read; a display read does not advance playback. | Durable outbox/worker tests preserve the originating correlation ID. |
| Duplicate font stylesheet | Load `frontend/index.html` through nginx | `/fonts/fonts.css` is requested even though `src/index.css` already defines the fonts. The `/fonts/` nginx `types` block lists font extensions only, so CSS is not declared as `text/css`. | Static configuration reproduction; runtime MIME smoke remains pending Docker availability. |

The API correlation contract is implemented by the request-observation and
exception-filter boundaries: responses contain `X-Correlation-ID`, response
bodies contain the same ID, and a caller-provided correlation header is ignored.
Outbox descendants retain the generated ID across API, worker and delivery.

## Disposable local fixtures

- `backend/test/device-enrollment.integration.ts` creates a fresh
  `inker-enrollment-test-*` SQLite directory and four `Enrollment *` browser
  devices; it proves hash-only storage, TTL/replay/rate-limit behavior, atomic
  credential rotation, rollback, and concurrent redemption.
- `backend/test/playback.integration.ts` creates a fresh `inker-playback-*`
  database containing a browser device, a pull device, fixture publications, and
  a playlist. Its singleton-release case measures `nextTransitionAt: null`, no
  new transition event, and no desired-sequence increment after restart.
- `backend/test/observability-correlation.integration.ts` creates a fresh
  `inker-correlation-*` database and verifies correlation propagation through
  API intent, outbox, worker restart, and delivery.

## Evidence run

The pinned Bun `1.3.14` runtime was downloaded as a temporary local test tool;
no dependency lockfile changed.

```text
bun test ./src/config/secret-redaction.test.ts ./src/plugins/plugins-source-boundary.test.ts ./src/device-enrollment/device-enrollment.controller.test.ts
  37 pass, 0 fail

bun test ./test/device-enrollment.integration.ts
  4 pass, 0 fail

bun test ./test/playback.integration.ts --test-name-pattern 'singleton releases'
  1 pass, 0 fail

bun test ./src/common/filters/http-exception.filter.test.ts ./src/observability/runtime-observability.test.ts ./test/observability-correlation.integration.ts
  17 pass, 0 fail
```

## Live isolated-container evidence

An isolated `inker:latest` container was run against new temporary volumes on
2026-08-29. The existing `inker-local` container and its volumes were not used.
The test uses a generated process-only `ADMIN_PIN`; cookies, CSRF tokens,
device keys, enrollment codes, and issued credentials were neither printed nor
persisted in this repository.

| Check | Result |
| --- | --- |
| API readiness and worker startup | API became healthy; startup logs confirmed API initialization and the separate worker service. |
| Synthetic devices | Fresh browser fixture ID `1` and pull fixture ID `2` were created in the isolated database. |
| Grafana dashboard request | `503 SOURCE_REFRESH_REQUIRES_CONNECTOR`; correlation ID recorded by the server (redacted from this document). |
| Legacy design and device preview | Both returned `410 PUBLICATION_REQUIRED`, each with a generated correlation ID. |
| Pairing over HTTP without opt-in | `403 Pairing requires HTTPS`, with a generated correlation ID. |
| Pairing with explicit local HTTP opt-in | A generated one-time code exchanged successfully with `200`; issued credential was not inspected or logged. |
| Font CSS over nginx | `GET /fonts/fonts.css` returned `200 application/octet-stream`, confirming the MIME defect. |
| Display read without usable legacy device key | `422` with `HTTP_ID` redacted, confirming the request boundary; a complete authenticated display-manifest capture remains an open UX-00 item. |

The local Docker Desktop context was inaccessible to the session, but the
separate default Docker daemon was available with elevated local access. This is
an environment-access distinction, not a product defect.
