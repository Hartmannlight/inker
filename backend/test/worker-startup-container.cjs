// Explicit negative production-image tests. Only newly created containers are used.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');

const image = process.env.INKER_SMOKE_IMAGE || 'inker:wp20-test';
const temporary = mkdtempSync(join(tmpdir(), 'inker-wp20-startup-'));
const reportPath = resolve(__dirname, '../../goal-wp20-startup-final.log');
const containers = [];
const report = [];
let stage = 'prepare';
const sleep = ms => new Promise(done => setTimeout(done, ms));
function record(message) { report.push(message); console.info(message); }
function docker(args, password) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
      windowsHide: true, env: { ...process.env, ...(password ? { ADMIN_PIN: password } : {}) },
    });
  } catch (error) { error.toolOperation = args[0]; throw error; }
}
function state(name) {
  return JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]));
}
function assertMarkerAbsent(name, label) {
  const marker = join(temporary, `${label}-init.ready`);
  let absent = false;
  try { docker(['cp', `${name}:/run/inker-init.ready`, marker]); }
  catch (error) {
    // A generic Docker/permission failure is not evidence of a missing marker.
    absent = error.status === 1 && String(error.stderr).includes('Could not find the file /run/inker-init.ready');
  }
  assert.equal(absent, true, 'Initialization readiness marker must be absent');
  assert.equal(existsSync(marker), false);
}
async function rejectedStartup(label, password, injectSeed) {
  stage = `${label}: create`;
  const name = `inker-wp20-startup-${label}-${randomUUID().slice(0, 8)}`;
  containers.push(name);
  // No ports, mounts, volumes or external network; all state stays in this
  // disposable container's writable layer. Passwords never enter argv or logs.
  docker(['create', '--name', name, '--network', 'none', '-e', 'ADMIN_PIN', image], password);
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', name]));
  assert.equal(mounts.length, 0, 'Negative startup tests must not use volumes');
  if (injectSeed) {
    const seed = join(temporary, 'seed.ts');
    writeFileSync(seed, "throw new Error('TEST_SEED_FAILURE');\n", { mode: 0o644 });
    docker(['cp', seed, `${name}:/app/prisma/seed.ts`]);
  }
  stage = `${label}: startup rejection`;
  docker(['start', name]);
  const deadline = Date.now() + 45_000;
  let finalState;
  while (Date.now() < deadline) {
    finalState = state(name);
    if (!finalState.Running) break;
    try {
      const processes = docker(['top', name]);
      assert.equal(/(?:bun|node)\s+(?:run\s+)?(?:\/app\/)?dist\/(?:main|worker)\.js/.test(processes), false,
        'API and worker application processes must never start after failed initialization');
    } catch (error) {
      // The container may exit between inspect and top. Never ignore an
      // assertion or a Docker error while it remains running.
      if (error?.code === 'ERR_ASSERTION') throw error;
      if (state(name).Running) {
        // This diagnostic can only contain the fixed docker-top operation,
        // never its environment; redact the test password defensively anyway.
        record(`Process inspection diagnostic: ${String(error.stderr).replaceAll(password, '[REDACTED]').replaceAll(/\r?\n/g, ' ').slice(0, 500)}`);
        throw error;
      }
    }
    await sleep(100);
  }
  finalState = state(name);
  assert.equal(finalState.Status, 'exited');
  assert.notEqual(finalState.ExitCode, 0, 'Failed initialization must fail the container');
  assert.equal(finalState.OOMKilled, false);
  const logs = docker(['logs', name]);
  assert.equal(logs.includes(password), false, 'Startup output must not disclose ADMIN_PIN');
  assert.equal(logs.includes('[init] Shared storage, migrations and reference data are ready'), false);
  assert.equal(logs.includes('[backend] Starting Inker API'), false);
  assert.equal(logs.includes('[worker] Starting Inker worker'), false);
  assert.equal(logs.includes('Inker Server running'), false);
  assert.equal(logs.includes('WORKER_STARTED'), false);
  if (injectSeed) {
    assert.equal(logs.includes('[init] Applying versioned database migrations...'), true);
    assert.equal(logs.includes('[init] Synchronizing reference data (idempotent)...'), true);
    assert.equal(logs.includes('TEST_SEED_FAILURE'), true, 'The injected seed failure must be the observed cause');
  } else {
    assert.equal(logs.includes('ADMIN_PIN must not use a known default'), true);
    assert.equal(logs.includes('[init] Applying versioned database migrations...'), false);
    assert.equal(logs.includes('[init] Synchronizing reference data (idempotent)...'), false);
  }
  stage = `${label}: readiness marker absence`;
  assertMarkerAbsent(name, label);
  record(`PASS ${label}: container exit=${finalState.ExitCode}, no API/worker startup, readiness marker absent, no volumes, no password disclosure`);
}
async function main() {
  record(`WP-20 isolated startup rejection tests; image=${image}; started=${new Date().toISOString()}`);
  try {
    await rejectedStartup('forbidden-admin', '1111', false);
    await rejectedStartup('failing-seed', randomBytes(24).toString('hex'), true);
    record('WP-20 startup rejection tests passed: both init failures stopped the container before API/worker startup');
  } catch (error) {
    process.exitCode = 1;
    record(`FAIL at ${stage}`);
    if (Number.isInteger(error?.status)) record(`Tool exit status: ${error.status}`);
    if (typeof error?.toolOperation === 'string' && /^[a-z]+$/.test(error.toolOperation)) record(`Tool operation: ${error.toolOperation}`);
    if (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code)) record(`Failure code: ${error.code}`);
    const location = typeof error?.stack === 'string' && error.stack.match(/worker-startup-container\.cjs:(\d+):(\d+)/);
    if (location) record(`Test source location: ${location[1]}:${location[2]}`);
  } finally {
    for (const name of containers) {
      try { docker(['rm', '-f', name]); }
      catch { process.exitCode = 1; record('Cleanup failed for one uniquely named test container'); }
    }
    // Validate the resolved absolute directory before recursive Windows cleanup.
    const target = resolve(temporary);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('inker-wp20-startup-'));
    rmSync(target, { recursive: true, force: true });
    record(`Final exit code: ${process.exitCode || 0}; completed=${new Date().toISOString()}`);
    writeFileSync(reportPath, `${report.join('\n')}\n`);
  }
}
void main();
