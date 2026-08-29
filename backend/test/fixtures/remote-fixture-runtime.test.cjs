// Pure fixture checks; no Docker resources or application database are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const runtime = require('./remote-fixture-runtime.cjs');
const certificate = '-----BEGIN CERTIFICATE-----\nPUBLIC-TEST-DATA\n-----END CERTIFICATE-----\n';

test('CA archive has a single readable public file and a valid ustar checksum', () => {
  const archive = runtime.caArchive(certificate), header = archive.subarray(0, 512);
  assert.equal(archive.length % 512, 0);
  assert.equal(parseInt(header.toString('ascii', 100, 107), 8), 0o644);
  assert.equal(parseInt(header.toString('ascii', 124, 135), 8), Buffer.byteLength(certificate));
  assert.equal(archive.subarray(512, 512 + Buffer.byteLength(certificate)).toString(), certificate);
  assert.ok(archive.subarray(-1024).every(byte => byte === 0));
  const checksum = parseInt(header.toString('ascii', 148, 154), 8);
  const copy = Buffer.from(header); copy.fill(32, 148, 156);
  assert.equal(copy.reduce((sum, byte) => sum + byte, 0), checksum);
  const tar = spawnSync('tar', ['-tvf', '-'], { input: archive, encoding: 'utf8', windowsHide: true });
  assert.equal(tar.status, 0);
  assert.match(tar.stdout, /-rw-r--r--/);
  assert.match(tar.stdout, /remote-fixture-ca[.]crt/);
  assert.equal(tar.stdout.trim().split('\n').length, 1);
});

test('invalid CA and resource identities fail before any resource operation', () => {
  assert.throws(() => runtime.caArchive('invalid'), /FIXTURE_CA_INVALID/);
  assert.throws(() => runtime.caArchive(certificate + 'a'.repeat(17000)), /FIXTURE_CA_INVALID/);
  assert.throws(() => runtime.cleanup({ version: 1, runId: '../outside' }), /FIXTURE_STATE_INVALID/);
  assert.throws(() => runtime.container({}, 'outside'), /FIXTURE_ROLE_INVALID/);
});

test('an invalid CLI command cannot create resources or print credentials', () => {
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../remote-container-fixture.cjs'), 'invalid'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /FIXTURE_COMMAND_INVALID/);
  assert.equal(cli.stderr.includes('Bearer'), false);
});

function cookieState() {
  return { version: 1, runId: 'a'.repeat(16), secrets: [], servers: Object.fromEntries(
    ['home', 'remote-a', 'remote-b'].map(role => [role, { password: 'test-only', cookie: 'inker_admin_session=old', csrf: role + '-csrf' }])) };
}

test('rotation updates only the selected server cookie and tracks its secret without changing CSRF', () => {
  const state = cookieState();
  for (const [index, role] of ['home', 'remote-a', 'remote-b'].entries()) {
    const token = String(index).repeat(43), before = structuredClone(state.servers);
    const headers = { 'set-cookie': [`inker_admin_session=${token}; Path=/api; HttpOnly`] };
    assert.equal(runtime.acceptAdminCookie(state, role, headers), true);
    assert.equal(state.servers[role].cookie === `inker_admin_session=${token}`, true);
    assert.equal(state.servers[role].csrf, before[role].csrf);
    for (const other of Object.keys(state.servers).filter(value => value !== role)) assert.deepEqual(state.servers[other], before[other]);
    assert.equal(state.secrets.includes(token), true);
    assert.equal(runtime.acceptAdminCookie(state, role, headers), false);
    assert.equal(state.secrets.length, index + 1);
  }
});

test('unknown cookies are ignored, but malformed, duplicate and oversized session headers fail without mutation', () => {
  const state = cookieState(), before = structuredClone(state), token = '_'.repeat(43);
  for (const headers of [{}, { 'set-cookie': ['other=value', `inker_admin_session_extra=${token}`] }, { 'set-cookie': Array(8).fill('other=value') }])
    assert.equal(runtime.acceptAdminCookie(state, 'home', headers), false);
  for (const value of ['not-an-array', [null], Array(9).fill('other=value'), ['other=' + 'x'.repeat(4096)],
    ['inker_admin_session='], ['inker_admin_session=' + 'x'.repeat(42)], ['inker_admin_session=' + 'x'.repeat(44)],
    ['inker_admin_session=' + token + '!'], ['inker_admin_session=' + token, 'inker_admin_session=' + token]]) {
    assert.throws(() => runtime.acceptAdminCookie(state, 'home', { 'set-cookie': value }), /FIXTURE_SESSION_COOKIE_INVALID/);
    assert.deepEqual(state, before);
  }
  assert.throws(() => runtime.acceptAdminCookie(state, 'outside', {}), /FIXTURE_ROLE_INVALID/);
});

test('explicit known session cookies qualify for rotation without treating foreign or absent cookies as admin', () => {
  const state = cookieState();
  assert.equal(runtime.sendsKnownAdminCookie(state, 'home', true, {}), true);
  assert.equal(runtime.sendsKnownAdminCookie(state, 'home', false, { Cookie: state.servers.home.cookie }), true);
  assert.equal(runtime.sendsKnownAdminCookie(state, 'home', false, { cookie: state.servers.home.cookie }), true);
  for (const headers of [{}, { Cookie: undefined }, { Cookie: 'foreign' }, { Cookie: '' },
    { Cookie: state.servers.home.cookie, cookie: state.servers.home.cookie }])
    assert.equal(runtime.sendsKnownAdminCookie(state, 'home', false, headers), false);
  state.servers.home.cookie = undefined;
  assert.equal(runtime.sendsKnownAdminCookie(state, 'home', false, { Cookie: undefined }), false);
});

test('admin HTTP responses persist changed rotations only; device responses never adopt cookies', async () => {
  // All I/O dependencies are stubbed before loading the request closure. This
  // test never contacts Docker, HTTP, or the real ignored recovery state file.
  const fs = require('node:fs'), vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const modulePath = require.resolve('./remote-fixture-runtime.cjs');
  const state = cookieState(); let writes = 0, cookie = '1'.repeat(43), calls = 0, status = 200;
  const childProcess = { spawnSync: (command, args) => {
    assert.equal(command, 'docker');
    assert.equal(JSON.stringify(args), JSON.stringify(['container', 'inspect', runtime.container(state, 'home')]));
    return { status: 0, stdout: JSON.stringify([{ Config: { Labels: { 'inker.wp27.fixture': state.runId } } }]) };
  }, execFileSync: () => { throw new Error('UNEXPECTED_CHILD_PROCESS'); } };
  const fileSystem = {
    mkdirSync: target => { assert.equal(target, path.dirname(runtime.statePath)); },
    readFileSync: target => { assert.equal(target, runtime.statePath); return JSON.stringify(state); },
    writeFileSync: target => { assert.equal(target, runtime.statePath); writes++; },
  };
  const http = { request: (_options, callback) => {
    calls++; const req = new EventEmitter(); req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = status;
      response.headers = { 'set-cookie': [`inker_admin_session=${cookie}; HttpOnly`] };
      callback(response); response.emit('data', Buffer.from('{}')); response.emit('end');
    });
    return req;
  } };
  const stubs = { 'node:child_process': childProcess, 'node:fs': fileSystem, 'node:http': http, 'node:https': http,
    'node:crypto': require('node:crypto'), 'node:path': path };
  const isolatedModule = { exports: {} };
  // Evaluate only this trusted repository fixture. Neither the global module
  // cache nor built-in modules are mutated; unlisted dependencies fail closed.
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
    module: isolatedModule, __dirname, Buffer, AbortSignal, setTimeout, process: { env: {} },
    require: name => { assert.ok(Object.hasOwn(stubs, name)); return stubs[name]; },
  }, { filename: modulePath });
  const isolated = isolatedModule.exports;
    assert.equal((await isolated.request(state, 'home', '/api/devices', { admin: true })).status, 200);
    assert.equal(writes, 1); assert.equal(state.servers.home.cookie.endsWith(cookie), true);
    await isolated.request(state, 'home', '/api/devices', { admin: true }); assert.equal(writes, 1);
    cookie = '2'.repeat(43);
    await isolated.request(state, 'home', '/api/timers'); assert.equal(writes, 1);
    assert.equal(state.servers.home.cookie.endsWith(cookie), false); assert.equal(state.secrets.includes(cookie), false);
    status = 403;
    const rejected = await isolated.request(state, 'home', '/api/remote-subscriptions/test/sync', {
      method: 'POST', headers: { Cookie: state.servers.home.cookie, 'X-CSRF-Token': 'wrong' }, data: {},
    });
    assert.equal(rejected.status, 403); assert.equal(calls, 4); assert.equal(writes, 2);
    assert.equal(state.servers.home.cookie.endsWith(cookie), true);
    status = 200; cookie = '3'.repeat(43);
    await isolated.request(state, 'home', '/api/devices', { headers: { Cookie: 'foreign' } });
    assert.equal(writes, 2); assert.equal(state.servers.home.cookie.endsWith(cookie), false);
    cookie = 'malformed';
    await assert.rejects(isolated.request(state, 'home', '/api/devices', { admin: true }), /FIXTURE_SESSION_COOKIE_INVALID/);
    assert.equal(writes, 2); assert.equal(calls, 6);
});

test('startup audit rejects supervisor-masked bootstrap errors and permits expected source faults', () => {
  for (const code of ['API_START_FAILED', 'WORKER_START_FAILED', 'P1008'])
    assert.throws(() => runtime.assertStartupLogs(JSON.stringify({ code }) + '\nREADY'), /FIXTURE_BOOTSTRAP_FAILURE/);
  assert.doesNotThrow(() => runtime.assertStartupLogs('SOURCE_TIMEOUT\nSOURCE_REFRESH_FAILED\nJOB_FAILED\nREADY'));
  assert.doesNotThrow(() => runtime.assertStartupLogs(''));
});
