// Explicit, isolated production-image smoke. Never targets an existing container.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const name = `inker-wp15-${randomUUID().slice(0, 8)}`;
const base = 'http://127.0.0.1:18715';
const password = randomBytes(24).toString('hex');
const secrets = [password];
let cookie, csrf, stage = 'start';
const sockets = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ADMIN_PIN: password } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await sleep(100); }
  throw new Error('Smoke condition timed out');
}
function db(code, input = {}) {
  return JSON.parse(execFileSync('docker', ['exec', '-i', name, 'bun', '-e',
    `const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); const input=JSON.parse(await Bun.stdin.text()); try { ${code} } finally {await p.$disconnect();}`],
    { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}
async function request(path, { method = 'GET', data, admin = false, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
  const text = await response.text(); let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, text, body: body?.data ?? body };
}
function connect(device, token, options = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/device-connect', { origin: base, ...options }); sockets.push(ws);
  const state = { messages: [], pings: 0, code: undefined, ws };
  ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'authenticate', externalId: device.externalId, token, viewport: { width: 800, height: 480 } })));
  ws.on('message', raw => {
    const text = raw.toString(); for (const secret of secrets) assert.equal(text.includes(secret), false);
    const message = JSON.parse(text); state.messages.push(message);
    if (message.type === 'ping') { state.pings++; ws.send(JSON.stringify({ protocolVersion: '1.0', type: 'pong', nonce: message.nonce })); }
  });
  ws.on('error', () => {}); ws.on('close', code => { state.code = code; });
  return state;
}
async function main() {
  try {
    docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1:18715:80', '-e', 'ADMIN_PIN', '-e', 'PAIRING_ALLOW_INSECURE_HTTP=true', '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1',
      '--mount', 'type=volume,destination=/app/uploads', '--mount', 'type=volume,destination=/app/secrets', process.env.INKER_SMOKE_IMAGE || 'inker:wp15-test');
    await until(async () => { try { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 400; } catch { return false; } }, 600);
    stage = 'admin';
    const login = await request('/api/auth/login', { method: 'POST', data: { password } }); assert.equal(login.response.status, 200);
    cookie = login.response.headers.get('set-cookie').split(';')[0]; csrf = login.response.headers.get('x-csrf-token'); secrets.push(cookie.split('=')[1], csrf);
    const blocked = await request('/api/devices', { method: 'POST', data: { name: 'blocked', deviceType: 'web-display' }, headers: { Cookie: cookie } }); assert.equal(blocked.response.status, 403);
    const created = await request('/api/devices', { method: 'POST', admin: true, data: { name: 'WP15 browser', deviceType: 'web-display' } }); assert.equal(created.response.status, 201);
    const device = created.body; secrets.push(device.pairingToken);
    stage = 'pairing';
    const pair = await request('/api/web-displays/pair', { method: 'POST', data: { externalId: device.externalId, pairingToken: device.pairingToken } }); assert.equal(pair.response.status, 201);
    const token = pair.body.credential; secrets.push(token);
    const http = await request(`/api/web-displays/${device.externalId}/presentation`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(http.response.status, 200);
    const active = connect(device, token); await until(() => active.messages.some(m => m.type === 'presentation.changed'));
    if (process.env.INKER_SMOKE_IMAGE === 'inker:wp16-test') {
      stage = 'outbox refresh';
      const before = active.messages.filter(m => m.type === 'presentation.changed').length;
      assert.equal((await request(`/api/devices/${device.id}/refresh`, { method: 'POST', admin: true })).response.status, 201);
      stage = 'outbox websocket delivery';
      await until(() => active.messages.filter(m => m.type === 'presentation.changed').length === before + 1);
      stage = 'outbox durable ack';
      await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'device:refresh',status:'delivered'}})));") === 1);
      const outbox = JSON.stringify(db('console.log(JSON.stringify(await p.outboxEvent.findMany()));'));
      for (const value of secrets) assert.equal(outbox.includes(value), false);
      console.info('WP-16 container outbox refresh and secret audit passed');
    }
    stage = 'heartbeat'; await until(() => active.pings >= 1, 450); assert.equal(active.code, undefined);
    stage = 'rotation';
    const enrollment = await request(`/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true }); assert.equal(enrollment.response.status, 201); secrets.push(enrollment.body.code);
    const exchange = await request('/api/device-enrollments/exchange', { method: 'POST', data: { code: enrollment.body.code } }); assert.equal(exchange.response.status, 200);
    const rotated = exchange.body.credential; secrets.push(rotated);
    await until(() => active.code !== undefined); assert.equal(active.code, 4401);
    const rejected = connect(device, token); await until(() => rejected.code !== undefined); assert.equal(rejected.code, 4401);
    const fresh = connect(device, rotated); await until(() => fresh.messages.some(m => m.type === 'presentation.changed'));
    stage = 'pull-create';
    const pull = (await request('/api/devices', { method: 'POST', admin: true, data: { name: 'WP15 pull', macAddress: 'AA:15:00:00:00:01' } })).body;
    stage = 'pull-setup';
    const setup = await request('/api/setup', { headers: { HTTP_ID: 'AA:15:00:00:00:01' } }); assert.equal(setup.response.status, 200);
    pull.apiKey = setup.body.api_key; assert.ok(pull.apiKey); secrets.push(pull.apiKey);
    stage = 'pull-fixture';
    const fixture = db(`const r=await p.publication.create({data:{publicationKey:'wp15-smoke',revisions:{create:{revision:1,protocolVersion:'1.0',contentHash:'wp15-fixture',content:{fixtureArtifacts:['mono-800x480-white-bmp','mono-800x480-white-png']}}}},include:{revisions:true}}); await p.devicePublicationState.create({data:{deviceId:input.id,desiredPublicationRevisionId:r.revisions[0].publicationRevisionId}}); console.log(JSON.stringify({id:r.publicationId}));`, { id: pull.id });
    assert.ok(fixture.id);
    const headers = { HTTP_ID: pull.apiKey };
    stage = 'pull-manifest';
    const manifest = await request('/api/v1/device-content', { headers }); assert.equal(manifest.response.status, 200);
    const etag = manifest.response.headers.get('etag');
    stage = 'pull-304';
    const cached = await request('/api/v1/device-content', { headers: { ...headers, 'If-None-Match': `"different", ${etag},` } }); assert.equal(cached.response.status, 304); assert.equal(cached.text, ''); assert.equal(cached.response.headers.get('x-refresh-after-seconds'), '900');
    stage = 'pull-auth'; assert.equal((await request('/api/v1/device-content', { headers: { 'If-None-Match': etag } })).response.status, 401);
    stage = 'pull-artifact';
    const artifact = await fetch(base + manifest.body.artifacts[0].url, { headers }); assert.equal(artifact.status, 200); assert.ok((await artifact.arrayBuffer()).byteLength > 0);
    stage = 'pull-policy'; assert.equal((await request(`/api/devices/${pull.id}`, { method: 'PATCH', admin: true, data: { deliveryPolicyId: 'reference-responsive-pull' } })).response.status, 200);
    const policy = await request('/api/v1/device-content', { headers: { ...headers, 'If-None-Match': etag } }); assert.equal(policy.response.status, 304); assert.equal(policy.response.headers.get('x-refresh-after-seconds'), '60');
    stage = 'trmnl-display'; const display = await request('/api/display', { headers }); assert.equal(display.response.status, 200);
    stage = 'restart';
    const keyId = JSON.parse(docker('exec', name, 'cat', '/app/secrets/instance.json')).keyId;
    docker('restart', name);
    await until(async () => { try { return (await fetch(base + '/api/v1/device-content', { headers })).ok; } catch { return false; } }, 600);
    assert.equal(JSON.parse(docker('exec', name, 'cat', '/app/secrets/instance.json')).keyId, keyId);
    const restarted = connect(device, rotated); await until(() => restarted.messages.some(m => m.type === 'presentation.changed'));
    assert.equal((await request('/api/v1/device-content', { headers })).response.headers.get('etag'), etag);
    stage = 'secret-audit';
    const logs = docker('logs', name);
    const sessions = db('console.log(JSON.stringify(await p.adminSession.findMany()));');
    const telemetry = db('console.log(JSON.stringify(await p.device.findMany({select:{telemetry:true}})));');
    for (const secret of secrets.filter(Boolean)) { assert.equal(logs.includes(secret), false); assert.equal(JSON.stringify(sessions).includes(secret), false); assert.equal(JSON.stringify(telemetry).includes(secret), false); }
    console.info('WP-15 production smoke passed: admin/CSRF, pairing, heartbeat, idle revocation, reconnect, pull/304/policy/artifact, TRMNL display, restart/key identity, secret audit');
    if (logs.includes('device-configuration.catalog')) console.info('Known optional runtime seed warning observed.');
  } catch {
    console.error(`WP-15 production smoke failed at ${stage}`); process.exitCode = 1;
    if (process.env.INKER_SMOKE_IMAGE === 'inker:wp16-test') {
      try { console.error(db('console.log(JSON.stringify({events:await p.outboxEvent.findMany({select:{status:true,attempts:true,lastError:true}}),targets:await p.outboxTarget.findMany({select:{delivered:true,lastError:true}})}));')); } catch {}
    }
    try {
      let errors = docker('logs', '--tail', '150', name).split('\n').filter(line => /ERROR|Error|error:/.test(line)).slice(-4).map(line => line.split(' - {')[0]).join('\n');
      for (const secret of secrets.filter(Boolean)) errors = errors.replaceAll(secret, '[REDACTED]');
      console.error(errors);
    } catch { /* Do not print docker's raw error object. */ }
  } finally {
    for (const ws of sockets) ws.terminate();
    try { docker('rm', '-f', '-v', name); } catch { /* Only this run's uniquely named container. */ }
  }
}
void main();
