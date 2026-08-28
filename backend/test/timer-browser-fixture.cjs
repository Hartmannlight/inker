// Local browser QA only. All identities, data, volumes and services are disposable.
const { execFileSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const statePath = resolve(__dirname, '../../.tmp/wp25-browser-state.json');
const base = 'http://127.0.0.1:18725';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
const load = () => {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!/^inker-wp25-browser-[a-f0-9]{8}$/.test(state.name)) throw new Error('FIXTURE_ID_INVALID');
  return state;
};
async function wait(fn) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('FIXTURE_TIMEOUT');
}
async function setup() {
  if (existsSync(statePath)) throw new Error('FIXTURE_ALREADY_EXISTS');
  const name = `inker-wp25-browser-${randomUUID().slice(0, 8)}`, password = randomBytes(24).toString('hex');
  docker('run', '-d', '--name', name, '-p', '127.0.0.1:18725:80', '-e', `ADMIN_PIN=${password}`, '-e', 'THROTTLE_LIMIT=1000',
    '-e', 'PAIRING_ALLOW_INSECURE_HTTP=true', '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1',
    '--mount', 'type=volume,destination=/app/uploads', '--mount', 'type=volume,destination=/app/secrets',
    '--mount', 'type=volume,destination=/app/render-cache', 'inker:wp25-test');
  writeFileSync(statePath, JSON.stringify({ name, deviceIds: [] }), { flag: 'wx', mode: 0o600 });
  await wait(async () => (await fetch(`${base}/api/auth/login`, { method: 'POST', signal: AbortSignal.timeout(1500), headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 400);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = login.headers.get('x-csrf-token');
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok); const result = await response.json(); return result.data ?? result;
  };
  const devices = [], enrollments = [];
  for (let index = 0; index < 2; index++) {
    const device = await post('/api/devices', { name: `WP25 Browser ${index + 1}`, deviceType: 'web-display' });
    devices.push({ id: device.id, externalId: device.externalId });
    enrollments.push(await post(`/api/devices/${device.id}/enrollments`, {}));
  }
  await post('/api/publications/wp25-browser-qa/publish', { idempotencyKey: randomUUID(), expectedRevision: 0,
    deviceIds: devices.map(device => device.id), allowedActions: ['create', 'pause', 'resume', 'cancel', 'acknowledge']
      .map(action => ({ action: `timer.${action}`, payloadSchemaVersion: '1.0' })),
    draft: { fixtureArtifacts: ['mono-800x480-white-png'] } });
  writeFileSync(statePath, JSON.stringify({ name, deviceIds: devices.map(device => device.id) }), { mode: 0o600 });
  console.log(JSON.stringify({ base, clients: devices.map((device, index) => ({ externalId: device.externalId,
    url: `${base}/display/${device.externalId}?test=timers`, code: enrollments[index].code })) }));
}
async function main() {
  const action = process.argv[2];
  if (action === 'setup') return setup();
  const state = load();
  if (action === 'inspect') {
    const result = docker('exec', state.name, 'bun', '-e',
      "const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); console.log(JSON.stringify({timers:await p.timer.findMany({select:{timerId:true,status:true,version:true,durationMs:true,visibility:true,endsAt:true,completedAt:true,acknowledgedAt:true}}),receipts:await p.interactionReceipt.count()}));await p.$disconnect();");
    console.log(result.trim()); return;
  }
  if (action === 'offline' || action === 'online') {
    docker('exec', state.name, '/command/s6-svc', action === 'offline' ? '-d' : '-u', '/run/service/backend');
    if (action === 'online') await wait(async () => (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1500) })).ok);
    console.log(action); return;
  }
  if (action === 'cleanup') {
    docker('stop', '--timeout', '35', state.name); docker('rm', '-v', state.name);
    unlinkSync(statePath); console.log('Own browser fixture removed'); return;
  }
  throw new Error('FIXTURE_ACTION_INVALID');
}
main().catch(error => { console.error(error instanceof Error && /^FIXTURE_[A-Z_]+$/.test(error.message) ? error.message : 'BROWSER_FIXTURE_FAILED'); process.exitCode = 1; });
