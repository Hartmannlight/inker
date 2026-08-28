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
