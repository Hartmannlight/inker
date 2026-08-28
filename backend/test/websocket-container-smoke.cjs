// Explicit, isolated production-image smoke. Never targets an existing container.
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const name = `inker-wp22-${randomUUID().slice(0, 8)}`;
const base = 'http://127.0.0.1:18715';
const password = randomBytes(24).toString('hex');
const secrets = [password];
let cookie, csrf, playbackBeforeRestart, renderBeforeRestart, sourceBeforeRestart, stage = 'start';
let workerPaused = false;
const sockets = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000, env: { ...process.env, ADMIN_PIN: password } });
// Waiting for a draining worker must not block the test client's WS pongs.
const dockerAsync = (...args) => new Promise((resolve, reject) => execFile('docker', args,
  { encoding: 'utf8', timeout: 90_000, windowsHide: true, env: { ...process.env, ADMIN_PIN: password } },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await sleep(100); }
  throw new Error('Smoke condition timed out');
}
function db(code, input = {}) {
  return JSON.parse(execFileSync('docker', ['exec', '-i', name, 'bun', '-e',
    `const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); const input=JSON.parse(await Bun.stdin.text()); try { ${code} } finally {await p.$disconnect();}`],
    { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }));
}
async function request(path, { method = 'GET', data, admin = false, headers = {} } = {}) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000), headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
  const text = await response.text(); let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, text, body: body?.data ?? body };
}
async function renderedFor(deviceId) {
  let binding;
  await until(() => {
    binding = db('console.log(JSON.stringify(await p.renderBinding.findFirst({where:{deviceId:input.deviceId},include:{ready:true,device:{include:{publicationState:true}}}})));', { deviceId });
    return binding?.ready?.completedAt && binding.readyKey === binding.desiredKey &&
      binding.ready.publicationRevisionId === binding.device.publicationState.desiredPublicationRevisionId;
  });
  return binding;
}
function renderQueue(paused) {
  db(`const {Queue}=require('bullmq'); const q=new Queue('render',{prefix:'inker-wp16',connection:{host:'127.0.0.1',port:6379,password:process.env.REDIS_PASSWORD||'inker_redis'}});
    try { await q.${paused ? 'pause' : 'resume'}(); console.log('true'); } finally {await q.close();}`);
}
function workerReady() {
  return JSON.parse(docker('exec', name, 'bun', '-e',
    "try {const response=await fetch('http://127.0.0.1:3001/ready',{signal:AbortSignal.timeout(1500)});console.log(JSON.stringify(response.status===200));} catch {console.log('false');}"));
}
async function backgroundReady(expected) {
  await until(async () => {
    const ready = await request('/ready');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.status, 'ready');
    assert.equal(ready.body.background.redis, 'ready');
    return ready.body.background.status === expected &&
      (expected === 'ready' ? ready.body.background.workers > 0 : ready.body.background.workers === 0);
  }, 300);
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
      '--mount', 'type=volume,destination=/app/uploads', '--mount', 'type=volume,destination=/app/secrets',
      '--mount', 'type=volume,destination=/app/render-cache', process.env.INKER_SMOKE_IMAGE || 'inker:wp22-test');
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
      const deviceIds = [device.id];
      for (let i = 1; i < 20; i++) {
        const peer = await request('/api/devices', { method: 'POST', admin: true, data: { name: `WP19 peer ${i}`, deviceType: 'web-display' } });
        assert.equal(peer.response.status, 201); deviceIds.push(peer.body.id); secrets.push(peer.body.pairingToken);
      }
      // Pause only our isolated queue to deterministically observe fallback then
      // real render completion; no renderer is mocked or replaced.
      renderQueue(true);
      const publishInput = { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds, draft: { fixtureArtifacts: ['mono-800x480-white-png'] } };
      assert.equal((await request('/api/publications/browser/publish', { method: 'POST', headers: { Cookie: cookie }, data: publishInput })).response.status, 403);
      const publication = await request('/api/publications/browser/publish', { method: 'POST', admin: true, data: publishInput });
      assert.equal(publication.response.status, 201);
      assert.deepEqual((await request('/api/publications/browser/publish', { method: 'POST', admin: true, data: publishInput })).body, publication.body);
      await until(() => active.messages.some(m => m.presentation?.revision === 1 && (m.presentation.renderRevision ?? 0) === 0));
      await until(() => db('console.log(JSON.stringify(await p.renderBinding.count()));') === 20);
      assert.equal(db('console.log(JSON.stringify(await p.renderRequest.count()));'), 1);
      assert.equal(db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'render.requested'}})));"), 1);
      renderQueue(false);
      const rendered = await renderedFor(device.id);
      await until(() => active.messages.some(m => m.presentation?.revision === 1 && m.presentation.renderRevision === rendered.device.renderRevision));
      assert.ok(rendered.device.renderRevision > 0);
      assert.equal(db('console.log(JSON.stringify(await p.renderBinding.count({where:{readyKey:input.key}})));', { key: rendered.readyKey }), 20);
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
      const imageBytes = Buffer.from(await image.arrayBuffer());
      assert.equal(createHash('sha256').update(imageBytes).digest('hex'), rendered.ready.artifactHash);
      const dimensions = await require('sharp')(imageBytes).metadata();
      assert.equal(dimensions.width, rendered.ready.target.width); assert.equal(dimensions.height, rendered.ready.target.height);
      for (const path of [`/render-cache/${rendered.ready.artifactHash}`, `/uploads/${rendered.ready.artifactHash}`]) {
        const exposed = await fetch(base + path);
        assert.notEqual(createHash('sha256').update(Buffer.from(await exposed.arrayBuffer())).digest('hex'), rendered.ready.artifactHash);
      }
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
      console.info('WP-19 real render queue: 20 devices, one request/job, atomic cache, private image hash/dimensions and ordered live WebSocket render update passed');
    }
    {
      stage = 'WP20 independent worker readiness';
      const auth = { Authorization: `Bearer ${token}` };
      const manifestPath = `/api/web-displays/${device.externalId}/presentation`;
      await backgroundReady('ready');
      await until(workerReady);
      const before = await request(manifestPath, { headers: auth });
      assert.equal(before.response.status, 200);
      const previousRender = (await renderedFor(device.id)).ready;

      // Stop only the worker in this run's container. API, Redis and the
      // authenticated WebSocket remain real, independently supervised services.
      stage = 'WP20 worker stop and degraded background';
      docker('exec', name, '/command/s6-svc', '-d', '/run/service/worker');
      await dockerAsync('exec', name, '/command/s6-svwait', '-d', '-t', '30000', '/run/service/worker');
      assert.equal(docker('exec', name, '/command/s6-svstat', '-o', 'up,exitcode,signal', '/run/service/worker').trim(), 'false 0 NA', 'Worker must exit cleanly with status zero, not be killed');
      assert.equal(workerReady(), false);
      await backgroundReady('degraded');
      const downLogin = await request('/api/auth/login', { method: 'POST', data: { password } });
      assert.equal(downLogin.response.status, 200);
      cookie = downLogin.response.headers.get('set-cookie').split(';')[0];
      csrf = downLogin.response.headers.get('x-csrf-token');
      secrets.push(cookie.split('=')[1], csrf);
      assert.equal((await request('/api/devices', { admin: true })).response.status, 200);
      const whileDown = await request(manifestPath, { headers: auth });
      assert.equal(whileDown.response.status, 200);
      assert.deepEqual(whileDown.body, before.body);
      const cachedImage = await fetch(base + whileDown.body.content.url, { headers: auth, signal: AbortSignal.timeout(5000) });
      assert.equal(cachedImage.status, 200);
      assert.equal(createHash('sha256').update(Buffer.from(await cachedImage.arrayBuffer())).digest('hex'), previousRender.artifactHash);
      const pingsBeforeStop = active.pings;
      await until(() => active.pings > pingsBeforeStop, 450);
      assert.equal(active.code, undefined);

      stage = 'WP20 publication persists while worker stopped';
      const published = await request('/api/publications/browser/publish', { method: 'POST', admin: true,
        data: { idempotencyKey: randomUUID(), expectedRevision: 1, deviceIds: [device.id], draft: { fixtureArtifacts: ['mono-800x480-black-bmp'] } } });
      assert.equal(published.response.status, 201);
      const revisionId = published.body.publicationRevisionId;
      const persisted = db(`const desired=await p.devicePublicationState.findUniqueOrThrow({where:{deviceId:input.deviceId}});
        const revision=await p.publicationRevision.findUniqueOrThrow({where:{publicationRevisionId:input.revisionId}});
        const events=(await p.outboxEvent.findMany({where:{eventType:'device.publication.desired-revision.changed',aggregateId:String(input.deviceId)}})).filter(event=>event.payload.publicationRevisionId===input.revisionId);
        console.log(JSON.stringify({desired,revisionId:revision.publicationRevisionId,events:events.map(event=>({id:event.eventId,status:event.status}))}));`, { deviceId: device.id, revisionId });
      assert.equal(persisted.revisionId, revisionId);
      assert.equal(persisted.desired.desiredPublicationRevisionId, revisionId);
      assert.equal(persisted.desired.desiredSequence, before.body.revision + 1);
      assert.equal(persisted.events.length, 1);
      assert.equal(persisted.events[0].status, 'pending');
      const pendingManifest = await request(manifestPath, { headers: auth });
      assert.equal(pendingManifest.response.status, 200);
      assert.equal(pendingManifest.body.revision, persisted.desired.desiredSequence);
      assert.equal(pendingManifest.body.renderRevision, before.body.renderRevision);
      assert.equal(pendingManifest.body.content.url, before.body.content.url);
      // Reads may serve the compatible cached artifact, but cannot render it.
      await sleep(1000);
      assert.equal(workerReady(), false);
      assert.equal(db('console.log(JSON.stringify(await p.renderRequest.count({where:{publicationRevisionId:input.revisionId,completedAt:{not:null}}})));', { revisionId }), 0);

      stage = 'WP20 worker resumes durable queued publication and rendering';
      docker('exec', name, '/command/s6-svc', '-u', '/run/service/worker');
      await dockerAsync('exec', name, '/command/s6-svwait', '-u', '-t', '30000', '/run/service/worker');
      await until(workerReady);
      await backgroundReady('ready');
      const recovered = await renderedFor(device.id);
      assert.equal(recovered.ready.publicationRevisionId, revisionId);
      assert.notEqual(recovered.ready.artifactHash, previousRender.artifactHash);
      assert.ok(recovered.device.renderRevision > before.body.renderRevision);
      await until(() => db('console.log(JSON.stringify(await p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId},select:{status:true}})));', { eventId: persisted.events[0].id }).status === 'delivered');
      await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'render.requested',aggregateId:input.key,status:'delivered'}})));", { key: recovered.ready.key }) === 1);
      await until(() => active.messages.some(message => message.presentation?.revision === persisted.desired.desiredSequence && message.presentation.renderRevision === recovered.device.renderRevision));
      assert.equal(active.code, undefined);
      const stable = await request(manifestPath, { headers: auth });
      assert.equal(stable.response.status, 200);
      assert.equal(stable.body.revision, persisted.desired.desiredSequence);
      assert.equal(stable.body.renderRevision, recovered.device.renderRevision);
      const recoveredImage = await fetch(base + stable.body.content.url, { headers: auth, signal: AbortSignal.timeout(5000) });
      assert.equal(recoveredImage.status, 200);
      assert.equal(createHash('sha256').update(Buffer.from(await recoveredImage.arrayBuffer())).digest('hex'), recovered.ready.artifactHash);

      stage = 'WP20 frozen worker does not block API reads';
      // SIGSTOP leaves the actual worker alive but unable to execute work or
      // refresh its presence; no clock or health response is mocked.
      workerPaused = true;
      docker('exec', name, '/command/s6-svc', '-p', '/run/service/worker');
      await until(() => docker('exec', name, '/command/s6-svstat', '-o', 'up,paused', '/run/service/worker').trim() === 'true true');
      await backgroundReady('degraded');
      const durations = await Promise.all(Array.from({ length: 20 }, async () => {
        const start = performance.now();
        const result = await request(manifestPath, { headers: auth });
        const elapsed = performance.now() - start;
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.body, stable.body);
        return elapsed;
      }));
      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
      assert.ok(p95 < 1000, 'API manifest p95 must stay below 1000ms while worker is SIGSTOPed');
      docker('exec', name, '/command/s6-svc', '-c', '/run/service/worker');
      workerPaused = false;
      await until(workerReady);
      await backgroundReady('ready');
      console.info(`WP-20 worker stop/restart, durable publication/render recovery, live WebSocket and 20 API reads with frozen worker passed (p95 ${p95.toFixed(1)}ms)`);
    }
    stage = 'production CommonJS snapshot normalization';
    {
      // Exercise the compiled Sharp import, not only fixture-only publishing or
      // the TS source loader (whose module interop differs from webpack).
      const screen = db("await require('sharp')({create:{width:32,height:24,channels:3,background:'#123456'}}).png().toFile('/app/uploads/screens/wp19-normalize.png'); console.log(JSON.stringify(await p.screen.create({data:{name:'WP19 normalization',imageUrl:'/uploads/screens/wp19-normalize.png'}}))); ");
      const normalized = await request('/api/publications/normalized/publish', { method: 'POST', admin: true,
        data: { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [], draft: { screenId: screen.id, expectedUpdatedAt: screen.updatedAt } } });
      assert.equal(normalized.response.status, 201);
      const snapshot = db('console.log(JSON.stringify(await p.publicationRevision.findUniqueOrThrow({where:{publicationRevisionId:input.id}})));', {id:normalized.body.publicationRevisionId});
      const bytes = Buffer.from(snapshot.content.image.png, 'base64');
      const metadata = await require('sharp')(bytes).metadata();
      assert.equal(metadata.width,32); assert.equal(metadata.height,24);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.content.image.sha256);
    }
    stage = 'WP18 playlist publication and automatic transition';
    {
      const auth = { Authorization: `Bearer ${token}` };
      const next = await request('/api/publications/browser-next/publish', { method: 'POST', admin: true,
        data: { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [], draft: { fixtureArtifacts: ['mono-800x480-white-png'] } } });
      assert.equal(next.response.status, 201);
      stage = 'WP18 immutable playlist publication';
      const fixture = db("const desired=await p.devicePublicationState.findUniqueOrThrow({where:{deviceId:input.deviceId}}); const playlist=await p.playlist.create({data:{name:'WP18 draft',items:{create:[{order:0,duration:2},{order:1,duration:null}]}},include:{items:{orderBy:{order:'asc'}}}}); console.log(JSON.stringify({playlist,desired}));", { deviceId: device.id });
      const draft = await request(`/api/playback/playlists/${fixture.playlist.id}/draft`, { admin: true });
      assert.equal(draft.response.status, 200);
      const published = await request(`/api/playback/playlists/${fixture.playlist.id}/publish`, { method: 'POST', admin: true,
        data: { version: 1, idempotencyKey: randomUUID(), expectedRevision: 0, expectedDraftHash: draft.body.draftHash,
          bindings: fixture.playlist.items.map((item, i) => ({ itemId: item.id, publicationRevisionId: i ? next.body.publicationRevisionId : fixture.desired.desiredPublicationRevisionId })) } });
      assert.equal(published.response.status, 201);
      stage = 'WP18 playback command authorization and idempotency';
      const command = { version: 1, idempotencyKey: randomUUID(), action: 'start', expectedVersion: 0,
        expectedDesiredSequence: fixture.desired.desiredSequence, playlistRevisionId: published.body.playlistRevisionId };
      assert.equal((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', data: command, headers: { Cookie: cookie } })).response.status, 403);
      assert.equal((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', data: command, headers: auth })).response.status, 401);
      const started = await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', admin: true, data: command });
      assert.equal(started.response.status, 201);
      assert.deepEqual((await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', admin: true, data: command })).body, started.body);
      stage = 'WP18 scheduled transition and persisted playback';
      await until(async () => (await request(`/api/playback/devices/${device.id}`, { admin: true })).body.version === 2);
      playbackBeforeRestart = (await request(`/api/playback/devices/${device.id}`, { admin: true })).body.state;
      assert.equal(playbackBeforeRestart.currentItemId, fixture.playlist.items[1].id);
      assert.equal(playbackBeforeRestart.nextTransitionAt, null);
      await renderedFor(device.id);
      const current = await request(`/api/web-displays/${device.externalId}/presentation`, { headers: auth });
      assert.equal(current.body.revision, fixture.desired.desiredSequence + 1);
      assert.equal(current.body.nextTransitionAt, null);
      await until(() => active.messages.some(m => m.presentation?.revision === current.body.revision));
      stage = 'WP18 transition durable acknowledgement';
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
    sourceBeforeRestart = await require('./fixtures/source-container-check.cjs')({ request, db, until, renderedFor, connect, secrets, base, setStage: value => { stage = value; },
      login: () => request('/api/auth/login', { method: 'POST', data: { password } }) });
    await require('./fixtures/isolation-container-check.cjs')({ request, db, until, secrets, base, device, credential: rotated, setStage: value => { stage = value; },
      login: () => request('/api/auth/login', { method: 'POST', data: { password } }) });
    stage = 'pull-create';
    const pull = (await request('/api/devices', { method: 'POST', admin: true, data: { name: 'WP15 pull', macAddress: 'AA:15:00:00:00:01' } })).body;
    stage = 'pull-setup';
    const setup = await request('/api/setup', { headers: { HTTP_ID: 'AA:15:00:00:00:01' } }); assert.equal(setup.response.status, 200);
    pull.apiKey = setup.body.api_key; assert.ok(pull.apiKey); secrets.push(pull.apiKey);
    stage = 'pull-fixture';
    const fixture = await request('/api/publications/pull/publish', { method: 'POST', admin: true, data: { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [pull.id], draft: { fixtureArtifacts: ['mono-800x480-white-bmp', 'mono-800x480-white-png'] } } });
    assert.equal(fixture.response.status, 201);
    assert.ok(fixture.body.publicationId);
    await renderedFor(pull.id);
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
    renderBeforeRestart = (await renderedFor(device.id)).ready;
    const keyId = JSON.parse(docker('exec', name, 'cat', '/app/secrets/instance.json')).keyId;
    docker('restart', '--timeout', '35', name);
    await until(async () => { try { return (await fetch(base + '/api/v1/device-content', { headers })).ok; } catch { return false; } }, 600);
    assert.equal(JSON.parse(docker('exec', name, 'cat', '/app/secrets/instance.json')).keyId, keyId);
    const restarted = connect(device, rotated); await until(() => restarted.messages.some(m => m.type === 'presentation.changed'));
    assert.equal((await request('/api/v1/device-content', { headers })).response.headers.get('etag'), etag);
    const playbackAfterRestart = db('console.log(JSON.stringify(await p.playbackState.findUniqueOrThrow({where:{deviceId:input.deviceId}})));', { deviceId: device.id });
    assert.equal(playbackAfterRestart.currentItemId, playbackBeforeRestart.currentItemId);
    assert.equal(playbackAfterRestart.anchorAt, playbackBeforeRestart.anchorAt);
    assert.equal(playbackAfterRestart.version, playbackBeforeRestart.version);
    const renderedAfterRestart = (await renderedFor(device.id)).ready;
    assert.equal(renderedAfterRestart.key, renderBeforeRestart.key);
    assert.equal(renderedAfterRestart.artifactHash, renderBeforeRestart.artifactHash);
    assert.equal((await request(`/api/sources/${sourceBeforeRestart.sourceId}`, { admin: true })).body.snapshot.snapshotId, sourceBeforeRestart.snapshotId);
    assert.equal((await renderedFor(sourceBeforeRestart.deviceId)).ready.artifactHash, sourceBeforeRestart.artifactHash);
    const restartedImage = await request(`/api/web-displays/${device.externalId}/presentation`, { headers: { Authorization: `Bearer ${rotated}` } });
    const restartedBytes = Buffer.from(await (await fetch(base + restartedImage.body.content.url, { headers: { Authorization: `Bearer ${rotated}` } })).arrayBuffer());
    assert.equal(createHash('sha256').update(restartedBytes).digest('hex'), renderBeforeRestart.artifactHash);
    stage = 'secret-audit';
    const logs = docker('logs', name);
    const sessions = db('console.log(JSON.stringify(await p.adminSession.findMany()));');
    const telemetry = db('console.log(JSON.stringify(await p.device.findMany({select:{telemetry:true}})));');
    const durable = db('console.log(JSON.stringify({outbox:await p.outboxEvent.findMany(),playback:await p.playbackState.findMany(),receipts:await p.playbackCommand.findMany(),publications:await p.publicationRevision.findMany(),sources:await p.sourceDefinition.findMany(),snapshots:await p.sourceSnapshot.findMany(),sourceJobs:await p.sourceRefreshJob.findMany()}));');
    for (const secret of secrets.filter(Boolean)) { assert.equal(logs.includes(secret), false); assert.equal(JSON.stringify(sessions).includes(secret), false); assert.equal(JSON.stringify(telemetry).includes(secret), false); assert.equal(JSON.stringify(durable).includes(secret), false); }
    assert.equal(logs.includes('device-configuration.catalog'), false, 'The production seed catalog must load successfully');
    console.info('WP-15 production smoke passed: admin/CSRF, pairing, heartbeat, idle revocation, reconnect, pull/304/policy/artifact, TRMNL display, restart/key identity, secret audit');
  } catch (error) {
    console.error(`WP-15 production smoke failed at ${stage}`); process.exitCode = 1;
    // Tool errors may embed environment/command output. Print only a safe code.
    if (Number.isInteger(error?.status)) console.error(`Tool exit status: ${error.status}`);
    if (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code)) console.error(`Failure code: ${error.code}`);
    if (Number.isFinite(error?.actual) && Number.isFinite(error?.expected)) console.error(`Numeric assertion: actual=${error.actual} expected=${error.expected}`);
    const location = typeof error?.stack === 'string' && error.stack.match(/websocket-container-smoke\.cjs:(\d+):(\d+)/);
    if (location) console.error(`Smoke source location: ${location[1]}:${location[2]}`);
    const sourceLocation = typeof error?.stack === 'string' && error.stack.match(/source-container-check\.cjs:(\d+):(\d+)/);
    if (sourceLocation) console.error(`Source fixture location: ${sourceLocation[1]}:${sourceLocation[2]}`);
    const isolationLocation = typeof error?.stack === 'string' && error.stack.match(/isolation-container-check\.cjs:(\d+):(\d+)/);
    if (isolationLocation) console.error(`Isolation fixture location: ${isolationLocation[1]}:${isolationLocation[2]}`);
    {
      try { console.error(db('console.log(JSON.stringify({events:await p.outboxEvent.findMany({select:{status:true,attempts:true,lastError:true}}),targets:await p.outboxTarget.findMany({select:{delivered:true,lastError:true}})}));')); } catch {}
    }
    try {
      let errors = docker('logs', '--tail', '200', name).split('\n').filter(line => /ERROR|Error|error:|RENDER_/.test(line)).slice(-10).map(line => line.split(' - {')[0]).join('\n');
      for (const secret of secrets.filter(Boolean)) errors = errors.replaceAll(secret, '[REDACTED]');
      console.error(errors);
    } catch { /* Do not print docker's raw error object. */ }
  } finally {
    for (const ws of sockets) ws.terminate();
    if (workerPaused) { try { docker('exec', name, '/command/s6-svc', '-c', '/run/service/worker'); } catch {} }
    try { docker('stop', '--timeout', '35', name); } catch { /* The container may already have exited. */ }
    try { docker('rm', '-f', '-v', name); } catch { /* Only this run's uniquely named container. */ }
  }
}
void main();
