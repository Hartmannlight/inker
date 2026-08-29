const { test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PHASES, E2E, options, imageValid, discover, buildPlan, typecheckConfig, safeEnvironment, summaryReader, runStep } = require('./run-foundation-checks.cjs');
const root = path.resolve(__dirname, '../..');
function cleanupDiscovery(directory) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('inker-foundation-discovery-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
}

test('all phases include every integration exactly once, including migrations and actual Redis', () => {
  const plan = buildPlan(root, options(['--image', 'inker:foundation-test']));
  expect([...new Set(plan.map(step => step.phase))]).toEqual(PHASES);
  const files = discover(path.join(root, 'backend/test'), name => name.endsWith('.integration.ts'));
  const executed = plan.filter(step => step.phase === 'integration');
  expect(executed.map(step => path.resolve(root, step.cwd, step.args.at(-1))).sort()).toEqual(files.sort());
  expect(new Set(executed.map(step => step.id)).size).toBe(files.length);
  expect(executed.some(step => step.id.endsWith('migrations.integration.ts'))).toBe(true);
  expect(executed.some(step => step.id.endsWith('outbox-redis.integration.ts'))).toBe(true);
  expect(plan.findIndex(step => step.phase === 'image')).toBeLessThan(plan.findIndex(step => step.phase === 'integration'));
});

test('new nested integration files are discovered without a maintained allowlist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inker-foundation-discovery-'));
  try {
    fs.mkdirSync(path.join(directory, 'backend/test/nested'), { recursive: true });
    for (const file of ['migrations.integration.ts', 'outbox-redis.integration.ts', 'nested/new.integration.ts'])
      fs.writeFileSync(path.join(directory, 'backend/test', file), '');
    const plan = buildPlan(directory, options(['--phase', 'integration', '--image', 'inker:test']));
    expect(plan.map(step => step.id)).toContain('test/nested/new.integration.ts');
    expect(plan).toHaveLength(3);
  } finally {
    cleanupDiscovery(directory);
  }
});

test('explicit image is mandatory for Docker and Redis; invalid arguments fail closed', () => {
  for (const phase of ['all', 'image', 'integration', 'e2e']) expect(() => options(['--phase', phase])).toThrow('FOUNDATION_IMAGE_REQUIRED');
  for (const value of ['', '--privileged', 'inker', 'inker:tag --network host', 'inker:tag\nsecret', '$(evil):tag']) expect(imageValid(value)).toBe(false);
  for (const value of ['inker:ci-123', 'localhost:5000/team/inker:ci', 'sha256:' + 'a'.repeat(64)]) expect(imageValid(value)).toBe(true);
  expect(() => options(['--phase', 'image', '--image', 'sha256:' + 'a'.repeat(64)])).toThrow('FOUNDATION_BUILD_TAG_REQUIRED');
  expect(() => options(['--phase', 'static', '--skip', 'integration'])).toThrow('FOUNDATION_ARGUMENT_INVALID');
  expect(() => options(['--phase', 'static', '--phase', 'prepare'])).toThrow('FOUNDATION_ARGUMENT_INVALID');
});

test('all packages retain typecheck/tests/build; fresh Prisma client precedes backend checks', () => {
  const plan = buildPlan(root, options(['--image', 'inker:test']));
  for (const id of ['contracts-typecheck', 'contracts-test', 'contracts-build', 'backend-typecheck', 'backend-test-typecheck',
    'backend-unit', 'backend-build', 'frontend-typecheck', 'frontend-test', 'frontend-build', 'prisma-validate', 'prisma-generate'])
    expect(plan.some(step => step.id === id)).toBe(true);
  expect(plan.findIndex(step => step.id === 'prisma-generate')).toBeLessThan(plan.findIndex(step => step.id === 'backend-typecheck'));
  for (const step of plan.filter(step => step.id.endsWith('-install'))) expect(step.args).toContain('--frozen-lockfile');
  const types = typecheckConfig(root);
  expect(types.files.some(file => file.endsWith('remote-subscriptions.integration.ts'))).toBe(true);
  expect(types.files.some(file => file.endsWith('remote-transport.test.ts'))).toBe(true);
  expect(types.exclude).toEqual([]);
});

test('Docker matrix includes broad smoke, TLS/remote/operations and WP29 load/backup gates', () => {
  const plan = buildPlan(root, options(['--phase', 'e2e', '--image', 'inker:test']));
  expect(plan.map(step => step.id)).toEqual(E2E.map(([file]) => file));
  expect(plan).toHaveLength(7);
  expect(plan.find(step => step.id === 'remote-container-fixture.cjs').args.at(-1)).toBe('smoke');
  expect(plan.find(step => step.id === 'operations-container-fixture.cjs').args.at(-1)).toBe('smoke');
});

test('CI third-party actions are pinned to immutable full commit SHAs', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(match => match[1]);
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
});

test('local deployment credentials and data targets cannot leak into gate subprocesses', () => {
  const clean = safeEnvironment({ PATH: '/tools', ADMIN_PIN: 'secret', DATABASE_URL: 'file:/production/data',
    INKER_INSTANCE_SECRET_PATH: '/production/key', INKER_RENDER_CACHE_PATH: '/production/cache',
    REDIS_PASSWORD: 'secret', OUTBOX_REDIS_HOST: 'production', INKER_SMOKE_IMAGE: 'wrong:old',
    GITHUB_TOKEN: 'secret', OAUTH_GOOGLE_CLIENT_SECRET: 'secret', OAUTH_SPOTIFY_CLIENT_ID: 'local',
    API_URL: 'https://production.invalid', MODELS_API_URL: 'https://production.invalid', SCREENS_DIR: '/production/screens',
    PUPPETEER_EXECUTABLE_PATH: '/chrome', HTTPS_PROXY: 'http://proxy.invalid' }, 'inker:exact');
  for (const key of ['ADMIN_PIN', 'INKER_INSTANCE_SECRET_PATH', 'INKER_RENDER_CACHE_PATH', 'REDIS_PASSWORD', 'OUTBOX_REDIS_HOST',
    'GITHUB_TOKEN', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_SPOTIFY_CLIENT_ID', 'API_URL', 'MODELS_API_URL', 'SCREENS_DIR'])
    expect(clean[key]).toBeUndefined();
  expect(clean.DATABASE_URL).toBe('file:./foundation-schema-validation.db');
  expect(clean.INKER_SMOKE_IMAGE).toBe('inker:exact');
  expect(clean.PUPPETEER_EXECUTABLE_PATH).toBe('/chrome');
  expect(clean.HTTPS_PROXY).toBe('http://proxy.invalid');
  expect(clean.TZ).toBe('UTC');
  expect(clean.CI).toBe('true');
});

test('bounded diagnostics retain counts but discard raw logs and huge assertion values', () => {
  const reader = summaryReader();
  reader.write(Buffer.from('PRIVATE_TOKEN=secret\nError: token=secret\n' + 'x'.repeat(100_000) + '\n'));
  reader.write(Buffer.from(' 18 pa')); reader.write(Buffer.from('ss\n 0 fail\n 228 expect() calls\n'));
  expect(reader.counts).toEqual({ passed: 18, failed: 0, assertions: 228 });
  expect(JSON.stringify(reader.counts)).not.toContain('secret');
});

test('real subprocess failure stays failed and cannot echo secret output through the runner', async () => {
  const result = await runStep({ id: 'failure-test', tool: 'node', cwd: '.', args: ['-e', 'console.error("PRIVATE_SECRET");process.exit(7)'], timeoutMs: 5000 },
    { root, env: process.env, node: 'node' });
  expect(result).toMatchObject({ gate: 'failure-test', outcome: 'failed', exitCode: 7 });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
});

test('hung subprocess has a real deadline instead of a fabricated success', async () => {
  const result = await runStep({ id: 'timeout-test', tool: 'node', cwd: '.', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 150 },
    { root, env: process.env, node: 'node' });
  expect(result.outcome).toBe('timeout');
  expect(result.durationMs).toBeLessThan(5000);
});
