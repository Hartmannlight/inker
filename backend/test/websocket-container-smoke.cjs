// Explicit, isolated production-image smoke. Never targets an existing container.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const name = `inker-wp18-${randomUUID().slice(0, 8)}`;
const base = 'http://127.0.0.1:18715';
const password = randomBytes(24).toString('hex');
const secrets = [password];
let cookie, csrf, playbackBeforeRestart, stage = 'start';
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
    // Test-only HTTP budget for 200 reads. Production's existing limit stays 100/min.
    docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1:18715:80', '-e', 'ADMIN_PIN', '-e', 'THROTTLE_LIMIT=1000', '-e', 'PAIRING_ALLOW_INSECURE_HTTP=true', '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1',
      '--mount', 'type=volume,destination=/app/uploads', '--mount', 'type=volume,destination=/app/secrets', process.env.INKER_SMOKE_IMAGE || 'inker:wp18-test');
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
    {
      stage = 'explicit publish';
      const publishInput = { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [device.id], draft: { fixtureArtifacts: ['mono-800x480-white-png'] } };
      assert.equal((await request('/api/publications/browser/publish', { method: 'POST', headers: { Cookie: cookie }, data: publishInput })).response.status, 403);
      const publication = await request('/api/publications/browser/publish', { method: 'POST', admin: true, data: publishInput });
      assert.equal(publication.response.status, 201);
      assert.deepEqual((await request('/api/publications/browser/publish', { method: 'POST', admin: true, data: publishInput })).body, publication.body);
      await until(() => active.messages.filter(m => m.type === 'presentation.changed').length === 2);
      const manifestPath = `/api/web-displays/${device.externalId}/presentation`;
      const auth = { Authorization: `Bearer ${token}` };
      const publishedManifest = await request(manifestPath, { headers: auth });
      db(`await p.$executeRawUnsafe('CREATE TABLE wp17_writes (n INTEGER NOT NULL)'); await p.$executeRawUnsafe('INSERT INTO wp17_writes VALUES (0)');
        await p.$executeRawUnsafe('CREATE TRIGGER wp17_device_writes AFTER UPDATE OF presentation_revision,last_screen_id,screen_started_at ON devices BEGIN UPDATE wp17_writes SET n=n+1; END');
        await p.$executeRawUnsafe('CREATE TRIGGER wp17_state_writes AFTER UPDATE ON device_publication_states BEGIN UPDATE wp17_writes SET n=n+1; END'); console.log('true');`);
      stage = '100 sequential manifest reads';
      for (let i = 0; i < 100; i++) assert.deepEqual((await request(manifestPath, { headers: auth })).body, publishedManifest.body);
      stage = '100 parallel manifest reads';
      await Promise.all(Array.from({ length: 100 }, async () => assert.deepEqual((await request(manifestPath, { headers: auth })).body, publishedManifest.body)));
      assert.equal(db("console.log(JSON.stringify(await p.$queryRawUnsafe('SELECT n FROM wp17_writes')));")[0].n, 0);
      stage = 'browser artifact auth and conditional get';
      const image = await fetch(base + publishedManifest.body.content.url, { headers: auth }); assert.equal(image.status, 200);
      const unchanged = await fetch(base + publishedManifest.body.content.url, { headers: { ...auth, 'If-None-Match': image.headers.get('etag') } });
      assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
      assert.equal((await fetch(base + publishedManifest.body.content.url, { headers: { 'If-None-Match': image.headers.get('etag') } })).status, 401);
      stage = 'outbox refresh';
      const before = active.messages.filter(m => m.type === 'presentation.changed').length;
      assert.equal((await request(`/api/devices/${device.id}/refresh`, { method: 'POST', admin: true })).response.status, 201);
      stage = 'outbox durable ack';
      await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'device:refresh',status:'delivered'}})));") === 1);
      assert.equal(active.messages.filter(m => m.type === 'presentation.changed').length, before);
      const outbox = JSON.stringify(db('console.log(JSON.stringify(await p.outboxEvent.findMany()));'));
      for (const value of secrets) assert.equal(outbox.includes(value), false);
      console.info('WP-17 publish/replay, 100 sequential + 100 parallel read-only manifests, authenticated artifacts and WP-16 durable refresh passed');
    }
    stage = 'WP18 playlist publication and automatic transition';
    {
      const auth = { Authorization: `Bearer ${token}` };
      const next = await request('/api/publications/browser-next/publish', { method: 'POST', admin: true,
        data: { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [], draft: { fixtureArtifacts: ['mono-800x480-white-png'] } } });
      assert.equal(next.response.status, 201);
      const fixture = db("const desired=await p.devicePublicationState.findUniqueOrThrow({where:{deviceId:input.deviceId}}); const playlist=await p.playlist.create({data:{name:'WP18 draft',items:{create:[{order:0,duration:2},{order:1,duration:null}]}},include:{items:{orderBy:{order:'asc'}}}}); console.log(JSON.stringify({playlist,desired}));", { deviceId: device.id });
      const draft = await request(`/api/playback/playlists/${fixture.playlist.id}/draft`, { admin: true });
      const published = await request(`/api/playback/playlists/${fixture.playlist.id}/publish`, { method: 'POST', admin: true,
        data: { version: 1, idempotencyKey: randomUUID(), expectedRevision: 0, expectedDraftHash: draft.body.draftHash,
          bindings: fixture.playlist.items.map((item, i) => ({ itemId: item.id, publicationRevisionId: i ? next.body.publicationRevisionId : fixture.desired.desiredPublicationRevisionId })) } });
      assert.equal(published.response.status, 201);
      const command = { version: 1, idempotencyKey: randomUUID(), action: 'start', expectedVersion: 0,
        expectedDesiredSequence: fixture.desired.desiredSequence, playlistRevisionId: published.body.playlistRevisionId };
      assert.equal((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', data: command, headers: { Cookie: cookie } })).response.status, 403);
      assert.equal((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', data: command, headers: auth })).response.status, 401);
      const started = await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', admin: true, data: command });
      assert.equal(started.response.status, 201);
      assert.deepEqual((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', admin: true, data: command })).body, started.body);
      await until(async () => (await request(`/api/playback/devices/${device.id}`, { admin: true })).body.version === 2);
      playbackBeforeRestart = (await request(`/api/playback/devices/${device.id}`, { admin: true })).body.state;
      assert.equal(playbackBeforeRestart.currentItemId, fixture.playlist.items[1].id);
      assert.equal(playbackBeforeRestart.nextTransitionAt, null);
      const current = await request(`/api/web-displays/${device.externalId}/presentation`, { headers: auth });
      assert.equal(current.body.revision, fixture.desired.desiredSequence + 1);
      assert.equal(current.body.nextTransitionAt, null);
      await until(() => active.messages.some(m => m.presentation?.revision === current.body.revision));
      assert.ok(db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'playback.transition.due',status:'delivered'}})));") === 1);
      console.info('WP-18 admin/CSRF, explicit playlist release, scheduled transition and browser assignment sequence passed');
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
    const fixture = await request('/api/publications/pull/publish', { method: 'POST', admin: true, data: { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [pull.id], draft: { fixtureArtifacts: ['mono-800x480-white-bmp', 'mono-800x480-white-png'] } } });
    assert.equal(fixture.response.status, 201);
    assert.ok(fixture.body.publicationId);
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
    const playbackAfterRestart = db('console.log(JSON.stringify(await p.playbackState.findUniqueOrThrow({where:{deviceId:input.deviceId}})));', { deviceId: device.id });
    assert.equal(playbackAfterRestart.currentItemId, playbackBeforeRestart.currentItemId);
    assert.equal(playbackAfterRestart.anchorAt, playbackBeforeRestart.anchorAt);
    assert.equal(playbackAfterRestart.version, playbackBeforeRestart.version);
    stage = 'secret-audit';
    const logs = docker('logs', name);
    const sessions = db('console.log(JSON.stringify(await p.adminSession.findMany()));');
    const telemetry = db('console.log(JSON.stringify(await p.device.findMany({select:{telemetry:true}})));');
    const durable = db('console.log(JSON.stringify({outbox:await p.outboxEvent.findMany(),playback:await p.playbackState.findMany(),receipts:await p.playbackCommand.findMany(),publications:await p.publicationRevision.findMany()}));');
    for (const secret of secrets.filter(Boolean)) { assert.equal(logs.includes(secret), false); assert.equal(JSON.stringify(sessions).includes(secret), false); assert.equal(JSON.stringify(telemetry).includes(secret), false); assert.equal(JSON.stringify(durable).includes(secret), false); }
    console.info('WP-15 production smoke passed: admin/CSRF, pairing, heartbeat, idle revocation, reconnect, pull/304/policy/artifact, TRMNL display, restart/key identity, secret audit');
    if (logs.includes('device-configuration.catalog')) console.info('Known optional runtime seed warning observed.');
  } catch {
    console.error(`WP-15 production smoke failed at ${stage}`); process.exitCode = 1;
    {
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
