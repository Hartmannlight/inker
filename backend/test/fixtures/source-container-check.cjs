const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');

module.exports = async function checkSources({ request, db, until, renderedFor, connect, secrets, base, setStage, login }) {
  setStage('WP21 source auth and encrypted storage');
  assert.equal((await request('/api/sources')).response.status, 401);
  const secret = randomBytes(32).toString('hex'); secrets.push(secret);
  const input = { protocolVersion: '1.0', name: 'WP21 fixture', connectorType: 'fixture', schemaVersion: '1',
    configuration: { data: { fixtureArtifacts: ['mono-800x480-white-png'] } }, secret,
    refreshIntervalSeconds: 3600, timeoutMs: 5000, concurrencyGroup: 'wp21-fixtures' };
  const created = await request('/api/sources', { method: 'POST', admin: true, data: input });
  assert.equal(created.response.status, 201);
  assert.equal(created.text.includes(secret), false);
  const id = created.body.definition.sourceDefinitionId;
  const storage = db(`const source=await p.sourceDefinition.findUniqueOrThrow({where:{sourceDefinitionId:input.id},include:{secret:true}});
    console.log(JSON.stringify({encrypted:source.secret.ciphertext.startsWith('v1:'),ciphertext:source.secret.ciphertext,config:source.configuration}));`, { id });
  assert.equal(storage.encrypted, true); assert.equal(JSON.stringify(storage).includes(secret), false);
  let source;
  async function read() {
    const result = await request(`/api/sources/${id}`, { admin: true });
    assert.equal(result.response.status, 200); assert.equal(result.text.includes(secret), false);
    source = result.body; return source;
  }
  await until(async () => (await read()).snapshot?.freshness.state === 'fresh');
  const a = source.snapshot;
  assert.deepEqual(a.data, input.configuration.data);
  setStage('WP21 immutable source publication and white pixels');
  const device = (await request('/api/devices', { method: 'POST', admin: true, data: { name: 'WP21 source pixels', deviceType: 'web-display' } })).body;
  secrets.push(device.pairingToken);
  const pair = await request('/api/web-displays/pair', { method: 'POST', data: { externalId: device.externalId, pairingToken: device.pairingToken } });
  assert.equal(pair.response.status, 201); const token = pair.body.credential; secrets.push(token);
  const live = connect(device, token), auth = { Authorization: `Bearer ${token}` };
  await until(() => live.messages.some(message => message.type === 'presentation.changed'));
  async function publish(snapshotId, expectedRevision) {
    const result = await request('/api/publications/source-proof/publish', { method: 'POST', admin: true,
      data: { idempotencyKey: randomUUID(), expectedRevision, deviceIds: [device.id], draft: { sourceSnapshotId: snapshotId } } });
    assert.equal(result.response.status, 201);
    return renderedFor(device.id);
  }
  const first = await publish(a.snapshotId, 0);
  const manifestPath = `/api/web-displays/${device.externalId}/presentation`;
  const manifestA = (await request(manifestPath, { headers: auth })).body;
  const imageA = await fetch(base + manifestA.content.url, { headers: auth });
  const bytesA = Buffer.from(await imageA.arrayBuffer());
  assert.equal(createHash('sha256').update(bytesA).digest('hex'), first.ready.artifactHash);
  const pixelsA = await require('sharp')(bytesA).raw().toBuffer({ resolveWithObject: true });
  const center = (Math.floor(pixelsA.info.height / 2) * pixelsA.info.width + Math.floor(pixelsA.info.width / 2)) * pixelsA.info.channels;
  assert.equal(pixelsA.data[center], 255);

  setStage('WP21 actual slow connector and independent API');
  const { secret: _secret, ...withoutSecret } = input;
  const slowInput = { ...withoutSecret, expectedDefinitionVersion: 1, connectorType: 'slow',
    configuration: { data: { fixtureArtifacts: ['mono-800x480-black-bmp'] }, delayMs: 60000 } };
  const slow = await request(`/api/sources/${id}`, { method: 'PUT', admin: true, data: slowInput });
  assert.equal(slow.response.status, 200);
  const slowEventId = slow.body.eventId;
  await until(() => db(`const {Queue}=require('bullmq');const q=new Queue('source-refresh',{prefix:'inker-wp16',connection:{host:'127.0.0.1',port:6379,password:process.env.REDIS_PASSWORD||'inker_redis'}});
    try{console.log(JSON.stringify((await q.getActive()).some(job=>job.data.eventId===input.eventId)));}finally{await q.close();}`, { eventId: slowEventId }));
  const loginStarted = performance.now();
  assert.equal((await login()).response.status, 200);
  const loginMs = performance.now() - loginStarted;
  assert.ok(loginMs < 1000, 'Slow source must not block a real authenticated login');
  const durations = await Promise.all(Array.from({ length: 20 }, async () => {
    const started = performance.now();
    assert.deepEqual((await request(manifestPath, { headers: auth })).body, manifestA);
    assert.equal((await read()).definition.definitionVersion, 2);
    return performance.now() - started;
  }));
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 < 1000, 'Slow source must not block API reads');
  assert.equal(db('console.log(JSON.stringify(await p.sourceSnapshot.count({where:{refreshEventId:input.eventId}})));', { eventId: slowEventId }), 0,
    'The slow job must still be running throughout the read measurement');
  await until(async () => (await read()).snapshot?.error?.code === 'SOURCE_TIMEOUT');
  assert.deepEqual(source.snapshot.data, a.data);
  assert.equal(source.snapshot.freshness.state, 'stale');
  const slowEvent = db('console.log(JSON.stringify(await p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId}})));', { eventId: slowEventId });
  assert.ok(Date.parse(source.snapshot.createdAt) - Date.parse(slowEvent.lastAttemptAt) >= 4900);
  assert.deepEqual((await request(manifestPath, { headers: auth })).body, manifestA);

  setStage('WP21 retries and real circuit cooldown');
  const failureInput = { ...withoutSecret, expectedDefinitionVersion: 2, connectorType: 'failure', timeoutMs: 1000,
    configuration: { data: { fixtureArtifacts: ['mono-800x480-black-bmp'] }, failuresBeforeSuccess: 3 } };
  const failure = await request(`/api/sources/${id}`, { method: 'PUT', admin: true, data: failureInput });
  assert.equal(failure.response.status, 200);
  await until(async () => (await read()).state.consecutiveFailures === 3);
  const openedUntil = source.state.circuitOpenUntil;
  assert.ok(Date.parse(openedUntil) > Date.now());
  const waiting = db('console.log(JSON.stringify(await p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId}})));', { eventId: failure.body.eventId });
  assert.equal(waiting.status, 'pending'); assert.equal(waiting.attempts, 3);
  assert.ok(Date.parse(waiting.availableAt) >= Date.parse(openedUntil));
  assert.deepEqual(source.snapshot.data, a.data);
  await until(async () => { const state = await read(); return state.snapshot?.freshness.state === 'fresh' && state.snapshot.definitionVersion === 3; }, 500);
  const b = source.snapshot;
  assert.ok(Date.parse(b.createdAt) >= Date.parse(openedUntil));
  assert.equal(source.state.consecutiveFailures, 0); assert.equal(source.state.circuitOpenUntil, null);
  assert.deepEqual(b.data, failureInput.configuration.data);
  assert.deepEqual((await request(manifestPath, { headers: auth })).body, manifestA);
  const completed = db('console.log(JSON.stringify(await p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId}})));', { eventId: failure.body.eventId });
  assert.equal(completed.attempts, 4);
  await until(() => db('console.log(JSON.stringify((await p.outboxEvent.findUniqueOrThrow({where:{eventId:input.eventId}})).status));', { eventId: failure.body.eventId }) === 'delivered');
  const second = await publish(b.snapshotId, 1);
  assert.notEqual(second.ready.key, first.ready.key); assert.notEqual(second.ready.artifactHash, first.ready.artifactHash);
  const manifestB = (await request(manifestPath, { headers: auth })).body;
  const pixelsB = await require('sharp')(Buffer.from(await (await fetch(base + manifestB.content.url, { headers: auth })).arrayBuffer())).raw().toBuffer();
  assert.equal(pixelsB[center], 0);
  await until(() => live.messages.some(message => message.presentation?.renderRevision === second.device.renderRevision && message.presentation?.revision === manifestB.revision));
  assert.equal((await request('/api/device-images/design/123')).response.status, 410);
  console.info(`WP-21 encrypted sources, actual 5s timeout, stale fallback, three retries + real 30s circuit cooldown, source-pinned white/black pixels, login ${loginMs.toFixed(1)}ms and API p95 ${p95.toFixed(1)}ms passed`);
  return { sourceId: id, snapshotId: b.snapshotId, deviceId: device.id, artifactHash: second.ready.artifactHash };
};
