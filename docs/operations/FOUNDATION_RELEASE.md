# Foundation verification and release checklist

WP-29 is an acceptance gate, not permission to deploy. The current decision and
measured limits are in [the acceptance report](../architecture/FOUNDATION_ACCEPTANCE.md).
Do not infer approval from a successful image build or an earlier package handoff.

## Reproduce the complete software gate

Use a fresh isolated Linux checkout without preinstalled `node_modules` or
generated `dist` directories, with the exact versions in `.node-version` and
`.bun-version`, a working Docker engine and no local `.env` files or credentials.
Run from the repository root. The runner rejects mismatched runtimes and existing
fixture state; it never adopts a running installation.

The WP-29 local harness exposed a Bun 1.3.14 reinstall issue: repeating the
installation over a prepared workspace removed the generated entry points and
declarations from copied `file:../contracts` dependencies. Run `prepare` once in
the fresh verification workspace. A prewarmed dependency tree is not the same
starting state as CI; preserve existing development work and use a new isolated
copy when reproducing this gate. The follow-up is tracked as HOST-02 in the report.

```sh
node backend/test/run-foundation-checks.cjs --plan --image inker:foundation-verification
node backend/test/run-foundation-checks.cjs --phase prepare
# Install the locked Puppeteer browser and system dependencies as in ci.yml.
node backend/node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome --install-deps
node backend/test/run-foundation-checks.cjs --phase static
node backend/test/run-foundation-checks.cjs --phase image --image inker:foundation-verification
node backend/test/run-foundation-checks.cjs --phase integration --image inker:foundation-verification
node backend/test/run-foundation-checks.cjs --phase e2e --image inker:foundation-verification
```

System dependency installation may require separately authorized administrator
access. With browser dependencies already installed, `--phase all --image
inker:foundation-verification` runs all phases sequentially. Never skip a failing
gate. The integration list is discovered from every `.integration.ts` file;
ordinary Bun discovery alone does not execute those files. All runtime gates use
the image's resolved immutable ID. `.github/workflows/ci.yml` runs the same phases.

Fixtures start and remove only their own labelled containers, volumes and networks.
Keep them sequential: fixed loopback ports include 18715, 18716, 18726–18731 and
18741–18743. Check port availability and do not stop unrelated services. A runner
inside Docker needs explicit access to its daemon and to host-published loopback
ports; a normal bridge container cannot use these addresses as the host. Do not
change Docker settings or mount user credentials to make a test pass.

The runner prints bounded gate outcomes, durations and test counts. Individual
fixture state and diagnostic artifacts under ignored `.tmp` may contain test
credentials. Never publish these files, whole process environments, or raw Docker
inspect output. Before retrying a failed fixture, use its ownership-checked cleanup
and confirm that its state and resources are gone. Do not use broad Docker prune,
queue deletion, migration-history edits or `db push` as recovery.

## Before a release decision

- [x] Complete all runner phases on the exact candidate, with no skipped tests.
- [x] Review the combined load report: real source/render overlap, 20 persistent
  displays, touch/pull convergence, queue samples, resource limits and fault recovery.
- [x] Complete full stopped-volume restore and predecessor-migration verification.
- [x] Exercise changed admin/editor and display behavior in a real browser.
- [x] Resolve every P0/P1 and every §9 P1/P2; give other P2 findings an explicit
  follow-up. Preserve failed-run evidence and distinguish an unknown cause from a fix.
- [x] Record the candidate commit/image ID, environment, thresholds, measured
  results, security checks, cleanup result and unavailable hardware in the report.
- [x] Review [backup/restore](DATABASE_BACKUP.md), [worker operations](WORKER_OPERATIONS.md),
  [sources](SOURCE_OPERATIONS.md), [render cache](RENDER_CACHE.md),
  [observability](../architecture/OBSERVABILITY_OPERATIONS.md) and
  [federation](../architecture/FEDERATION_OPERATIONS.md) against the candidate.
- [x] Make the local package commit only after acceptance and check the working
  tree for unrelated changes and secrets. The user separately authorized pushing
  the accepted branch to Hartmannlight; merge and deployment remain unauthorized.

Accepted software candidate on 2026-08-29:
`sha256:9b57638e189b3d9f5c34f1ba51775aa341c189dab04d2a76e3e7498ee81117b6`.
The authoritative measurements, 43-gate result, browser evidence, P2 follow-ups
and unavailable hardware are recorded in the acceptance report. This checklist
does not authorize deployment.

## Deployment review, separate from this goal

Use a tested image and three matching persistent volumes for uploads/SQLite,
instance secrets and private render cache. Keep a verified stopped backup before
every schema upgrade; rollback restores both the previous image and its complete
volume set. Do not expose Redis, worker readiness or private storage publicly.
Use configured HTTPS and secure admin sessions; the fixtures' explicit insecure
loopback pairing mode is not a production default. Protect the instance key and
never derive it from the admin password.

Check API readiness and background readiness separately after startup. Cached
displays may remain available while workers are degraded. Investigate durable
queue state instead of clearing it. A software load result does not establish
physical ESP32/Pi/TRMNL behavior, display lifetime, energy consumption or safe
refresh intervals. Hardware verification remains a separate open checklist.
