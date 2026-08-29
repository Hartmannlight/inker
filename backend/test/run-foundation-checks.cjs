#!/usr/bin/env node
// Local CI equivalent; use repository-pinned Node/Bun and a working Docker engine:
//   node backend/test/run-foundation-checks.cjs --plan --image inker:foundation-local
//   node backend/test/run-foundation-checks.cjs --phase prepare
// Install the locked Puppeteer browser/system dependencies as in ci.yml, or set
// PUPPETEER_EXECUTABLE_PATH to a working Chromium installation. Then run phases
// static, image, integration, e2e in that order; the last three require --image.
// --phase all runs all phases sequentially when browser dependencies already exist.
// Raw child output can contain assertion values or tool environments: only bounded
// numeric test evidence and fixed gate metadata are emitted, never raw logs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const PHASES = ['prepare', 'static', 'image', 'integration', 'e2e'];
const E2E = [
  ['worker-startup-container.cjs'], ['websocket-container-smoke.cjs'], ['federation-container-smoke.cjs'],
  ['remote-container-fixture.cjs', 'smoke'], ['operations-container-fixture.cjs', 'smoke'],
  ['foundation-load.cjs'], ['foundation-backup-restore.cjs'],
];
const ROOT = path.resolve(__dirname, '../..');
function fail(code) { throw new Error(code); }
function imageValid(image) {
  return typeof image === 'string' && image.length <= 255 && (
    /^sha256:[a-f0-9]{64}$/.test(image) ||
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image));
}
function options(args) {
  const result = { phase: 'all', plan: false, image: undefined }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (seen.has(key) || !['--phase', '--image', '--plan'].includes(key)) fail('FOUNDATION_ARGUMENT_INVALID');
    seen.add(key);
    if (key === '--plan') result.plan = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail('FOUNDATION_ARGUMENT_INVALID');
      result[key.slice(2)] = value;
    }
  }
  if (!['all', ...PHASES].includes(result.phase)) fail('FOUNDATION_PHASE_INVALID');
  if (['all', 'image', 'integration', 'e2e'].includes(result.phase) && !imageValid(result.image)) fail('FOUNDATION_IMAGE_REQUIRED');
  if (result.image !== undefined && !imageValid(result.image)) fail('FOUNDATION_IMAGE_INVALID');
  if (['all', 'image'].includes(result.phase) && result.image?.startsWith('sha256:')) fail('FOUNDATION_BUILD_TAG_REQUIRED');
  return result;
}
function discover(directory, predicate) {
  const result = [];
  function visit(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      if (item.isSymbolicLink()) fail('FOUNDATION_TEST_SYMLINK_DENIED');
      const target = path.join(current, item.name);
      if (item.isDirectory()) visit(target);
      else if (item.isFile() && predicate(item.name)) result.push(target);
    }
  }
  visit(directory);
  return result;
}
function buildPlan(root, config) {
  const integrations = discover(path.join(root, 'backend/test'), name => name.endsWith('.integration.ts'));
  if (!integrations.some(file => path.basename(file) === 'migrations.integration.ts') ||
    !integrations.some(file => path.basename(file) === 'outbox-redis.integration.ts')) fail('FOUNDATION_INTEGRATION_GATE_MISSING');
  const steps = [];
  const add = (phase, id, tool, cwd, args, timeoutMs = 600_000) => steps.push({ phase, id, tool, cwd, args, timeoutMs });
  const bun = (phase, id, cwd, ...args) => add(phase, id, 'bun', cwd, ['--no-env-file', ...args]);
  bun('prepare', 'contracts-install', 'contracts', 'install', '--frozen-lockfile');
  bun('prepare', 'contracts-bootstrap-build', 'contracts', 'run', 'build');
  bun('prepare', 'backend-install', 'backend', 'install', '--frozen-lockfile');
  add('prepare', 'prisma-generate', 'node', 'backend', ['node_modules/prisma/build/index.js', 'generate']);
  bun('prepare', 'frontend-install', 'frontend', 'install', '--frozen-lockfile');
  for (const script of ['typecheck', 'test', 'build']) bun('static', `contracts-${script}`, 'contracts', 'run', script);
  add('static', 'prisma-validate', 'node', 'backend', ['node_modules/prisma/build/index.js', 'validate']);
  bun('static', 'backend-typecheck', 'backend', 'run', 'typecheck');
  add('static', 'backend-test-typecheck', 'node', 'backend', ['node_modules/typescript/bin/tsc', '--project', '<test-tsconfig>']);
  // Bun discovers *.test.* / *.spec.* (including CJS tests), not *.integration.ts.
  bun('static', 'backend-unit', 'backend', 'test');
  bun('static', 'backend-build', 'backend', 'run', 'build');
  for (const script of ['typecheck', 'test', 'build']) bun('static', `frontend-${script}`, 'frontend', 'run', script);
  add('image', 'production-image', 'docker', '.', ['build', '--tag', config.image, '.'], 2_400_000);
  for (const file of integrations) {
    const relative = path.relative(path.join(root, 'backend'), file).split(path.sep).join('/');
    bun('integration', relative, 'backend', 'test', `./${relative}`);
  }
  for (const [file, ...args] of E2E) add('e2e', file, 'node', 'backend', [`test/${file}`, ...args], 1_200_000);
  return steps.filter(step => config.phase === 'all' || step.phase === config.phase);
}
function typecheckConfig(root) {
  const files = ['backend/src', 'backend/test'].flatMap(directory => discover(path.join(root, directory),
    name => /(?:\.test|\.spec|\.integration)\.ts$/.test(name)));
  if (!files.length) fail('FOUNDATION_TEST_TYPES_MISSING');
  return { extends: path.join(root, 'backend/tsconfig.json'), files, include: [], exclude: [],
    compilerOptions: { noEmit: true, incremental: false, module: 'ESNext', moduleResolution: 'Node' } };
}
const SAFE_ENVIRONMENT_KEYS = new Set([
  // Executable discovery and cross-platform process basics.
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  // Explicit toolchain and public-network plumbing required by the gate.
  'BUN_BIN', 'BUN_INSTALL', 'PUPPETEER_CACHE_DIR', 'PUPPETEER_EXECUTABLE_PATH',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_BUILDKIT', 'BUILDKIT_PROGRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Bounded output controls; application configuration is deliberately absent.
  'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
]);
function safeEnvironment(env, image) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => SAFE_ENVIRONMENT_KEYS.has(key)));
  Object.assign(result, { CI: 'true', NODE_ENV: 'test', TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    DATABASE_URL: 'file:./foundation-schema-validation.db' });
  if (image) result.INKER_SMOKE_IMAGE = image; else delete result.INKER_SMOKE_IMAGE;
  return result;
}
function summaryReader() {
  let line = '', dropping = false;
  const counts = { passed: null, failed: null, assertions: null };
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  function accept() {
    const text = line.replace(ansi, '').trim();
    const match = /^(\d{1,7}) (pass|fail|expect\(\) calls)$/.exec(text);
    if (match) counts[match[2] === 'pass' ? 'passed' : match[2] === 'fail' ? 'failed' : 'assertions'] = Number(match[1]);
    line = ''; dropping = false;
  }
  return { counts, write(chunk) {
    for (const character of chunk.toString('utf8')) {
      if (character === '\n') { if (!dropping) accept(); else { dropping = false; line = ''; } }
      else if (!dropping) { line += character; if (line.length > 8192) { dropping = true; line = ''; } }
    }
  } };
}
function runStep(step, { root, env, node = process.execPath, bun = 'bun', testConfig } = {}) {
  return new Promise(resolve => {
    const started = Date.now(), readers = [summaryReader(), summaryReader()];
    const command = step.tool === 'node' ? node : step.tool === 'bun' ? bun : step.tool;
    const args = step.args.map(value => value === '<test-tsconfig>' ? testConfig : value);
    let timedOut = false, settled = false;
    const child = spawn(command, args, { cwd: path.resolve(root, step.cwd), env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => readers[0].write(chunk));
    child.stderr.on('data', chunk => readers[1].write(chunk));
    const finish = code => {
      if (settled) return; settled = true; clearTimeout(timeout);
      const counts = Object.fromEntries(Object.keys(readers[0].counts).map(key => [key, readers[1].counts[key] ?? readers[0].counts[key]]));
      resolve({ gate: step.id, outcome: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed',
        exitCode: Number.isInteger(code) ? code : null, durationMs: Date.now() - started, ...counts });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      // Terminate only the child/process group created above, never unrelated
      // Docker resources. Normal resource cleanup remains owned by each fixture.
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, step.timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}
function exactVersion(tool, expected, env) {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024, env });
  if (result.status !== 0 || result.stdout.trim().replace(/^v/, '') !== expected) fail('FOUNDATION_TOOLCHAIN_MISMATCH');
}
async function main(args = process.argv.slice(2)) {
  const config = options(args), plan = buildPlan(ROOT, config);
  if (config.plan) { console.log(JSON.stringify({ phases: PHASES, gates: plan }, null, 2)); return; }
  const bun = process.env.BUN_BIN || 'bun', env = safeEnvironment(process.env, config.image);
  if (process.versions.bun || process.versions.node !== fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim()) fail('FOUNDATION_NODE_VERSION_MISMATCH');
  exactVersion(bun, fs.readFileSync(path.join(ROOT, '.bun-version'), 'utf8').trim(), env);
  if (plan.some(step => ['image', 'integration', 'e2e'].includes(step.phase))) {
    const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 });
    if (docker.status !== 0) fail('FOUNDATION_DOCKER_UNAVAILABLE');
  }
  for (const packageName of ['.', 'contracts', 'backend', 'frontend']) {
    if (fs.readdirSync(path.join(ROOT, packageName)).some(file => /^\.env(?:\.(?:local|test|production|development)(?:\.local)?)?$/.test(file)))
      fail('FOUNDATION_LOCAL_DOTENV_PRESENT');
  }
  if (plan.some(step => step.phase === 'e2e')) {
    for (const [file] of E2E) if (!fs.existsSync(path.join(ROOT, 'backend/test', file))) fail('FOUNDATION_E2E_GATE_MISSING');
    for (const file of ['wp27-remote-fixture-state.json', 'wp28-operations-fixture-state.json'])
      if (fs.existsSync(path.join(ROOT, '.tmp', file))) fail('FOUNDATION_EXISTING_FIXTURE_STATE');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'inker-foundation-checks-'));
  try {
    env.DATABASE_URL = `file:${path.join(temporary, 'validation.db').split(path.sep).join('/')}`;
    const testConfig = path.join(temporary, 'tests.json');
    fs.writeFileSync(testConfig, JSON.stringify(typecheckConfig(ROOT)), { mode: 0o600 });
    let resolvedImage;
    for (const step of plan) {
      if (['integration', 'e2e'].includes(step.phase) && !resolvedImage) {
        const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', config.image], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 });
        resolvedImage = inspect.stdout?.trim();
        if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(resolvedImage ?? '')) fail('FOUNDATION_IMAGE_UNAVAILABLE');
        env.INKER_SMOKE_IMAGE = resolvedImage; // Pin exact bytes for every fixture in this phase.
      }
      console.log(JSON.stringify({ gate: step.id, outcome: 'started' }));
      const result = await runStep(step, { root: ROOT, env, bun, testConfig });
      console.log(JSON.stringify(result));
      if (result.outcome !== 'passed') fail(result.outcome === 'timeout' ? 'FOUNDATION_TIMEOUT_INSPECT_OWN_FIXTURE_CLEANUP' : 'FOUNDATION_GATE_FAILED');
    }
  } finally {
    const target = path.resolve(temporary);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('inker-foundation-checks-')) fail('FOUNDATION_CLEANUP_PATH_INVALID');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => {
  console.error(/^FOUNDATION_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'FOUNDATION_RUNNER_FAILED');
  process.exitCode = 1;
});
module.exports = { PHASES, E2E, options, imageValid, discover, buildPlan, typecheckConfig, safeEnvironment, summaryReader, runStep };
