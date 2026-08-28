const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function check({ request, db, renderedFor, until, secrets, setStage, connect, worker }) {
  setStage('WP24 timer domain fixture');
  const clients = [];
  const actions = ['create', 'pause', 'resume', 'cancel', 'acknowledge'].map(action => ({ action: `timer.${action}`, payloadSchemaVersion: '1.0' }));
  for (let index = 0; index < 2; index++) {
    const created = await request('/api/devices', { method: 'POST', admin: true, data: { name: `WP24 timer ${index}`, deviceType: 'web-display' } });
    assert.equal(created.response.status, 201);
    secrets.push(created.body.pairingToken);
    const paired = await request('/api/web-displays/pair', { method: 'POST', data: { externalId: created.body.externalId, pairingToken: created.body.pairingToken } });
    assert.equal(paired.response.status, 201); secrets.push(paired.body.credential);
    clients.push({ device: created.body, token: paired.body.credential, headers: { Authorization: `Bearer ${paired.body.credential}` } });
  }
  const publication = await request('/api/publications/wp24-timers/publish', { method: 'POST', admin: true, data: {
    idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: clients.map(client => client.device.id),
    allowedActions: actions, draft: { fixtureArtifacts: ['mono-800x480-white-png'] },
  } });
  assert.equal(publication.response.status, 201);
  for (const client of clients) {
    await renderedFor(client.device.id);
    client.context = (await request('/api/interactions/context', { headers: client.headers })).body;
    assert.equal(client.context.allowedActions.length, 5);
    client.socket = connect(client.device, client.token);
    await until(() => client.socket.messages.some(message => message.type === 'connected'));
  }
  const event = (client, action, payload) => ({ protocolVersion: '1.0', eventId: randomUUID(),
    deviceId: client.device.externalId, credentialId: client.context.credentialId,
    publicationId: client.context.publicationId, revision: client.context.revision,
    action: `timer.${action}`, payload: { version: 1, ...payload }, occurredAt: new Date().toISOString() });
  async function send(client, input) {
    const result = await request('/api/interactions', { method: 'POST', headers: client.headers, data: input });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-correlation-id'), result.body.commandId);
    return result.body;
  }
  async function mutate(client, action, timer) {
    return send(client, event(client, action, { timerId: timer.timerId, expectedVersion: timer.version }));
  }
  setStage('WP24 real HTTP idempotent create and shared transitions');
  const creation = event(clients[0], 'create', { durationMs: 60000, visibility: 'shared' });
  const duplicate = await Promise.all([send(clients[0], creation), send(clients[0], creation)]);
  assert.deepEqual(duplicate.map(result => result.status).sort(), ['accepted', 'duplicate']);
  assert.equal(duplicate[0].result.timerId, duplicate[1].result.timerId);
  const running = duplicate[0].result;
  assert.equal(running.version, 1); assert.equal(running.status, 'running');
  await until(() => clients.every(client => client.socket.messages.some(message => message.type === 'timers.changed')));
  for (const client of clients) {
    const feed = await request('/api/timers', { headers: client.headers });
    assert.equal(feed.response.status, 200);
    assert.equal(feed.body.timers.find(timer => timer.timerId === running.timerId).version, 1);
  }
  const paused = await mutate(clients[1], 'pause', running);
  assert.equal(paused.status, 'accepted'); assert.equal(paused.result.status, 'paused');
  assert.ok(paused.result.pausedRemainingMs > 0 && paused.result.pausedRemainingMs <= 60000);
  const resumed = await mutate(clients[0], 'resume', paused.result);
  assert.equal(resumed.status, 'accepted'); assert.equal(resumed.result.status, 'running');
  const cancelled = await mutate(clients[1], 'cancel', resumed.result);
  assert.equal(cancelled.status, 'accepted'); assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(cancelled.result.version, 4);
  setStage('WP24 private authorization and server-time completion');
  await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.state.changed',status:{not:'delivered'}}}))); ") === 0);
  await new Promise(resolve => setImmediate(resolve));
  const peerUpdates = clients[1].socket.messages.filter(message => message.type === 'timers.changed').length;
  const privateResult = await send(clients[0], event(clients[0], 'create', { durationMs: 3000, visibility: 'private' }));
  assert.equal(privateResult.status, 'accepted');
  const privateTimer = privateResult.result;
  const denied = await mutate(clients[1], 'pause', privateTimer);
  assert.equal(denied.status, 'rejected');
  let completed;
  await until(async () => {
    completed = (await request('/api/timers', { headers: clients[0].headers })).body.timers.find(timer => timer.timerId === privateTimer.timerId);
    return completed.status === 'completed';
  });
  assert.equal(completed.version, 2);
  assert.equal(completed.completedAt, privateTimer.endsAt);
  assert.equal((await request('/api/timers', { headers: clients[1].headers })).body.timers.some(timer => timer.timerId === privateTimer.timerId), false);
  await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.state.changed',status:{not:'delivered'}}}))); ") === 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients[1].socket.messages.filter(message => message.type === 'timers.changed').length, peerUpdates);
  const acknowledged = await mutate(clients[0], 'acknowledge', completed);
  assert.equal(acknowledged.status, 'accepted'); assert.equal(acknowledged.result.status, 'completed');
  assert.equal(acknowledged.result.version, 3);
  assert.equal(acknowledged.result.completedAt, privateTimer.endsAt);
  assert.equal(acknowledged.result.acknowledgedByDeviceId, clients[0].device.externalId);
  const repeated = await mutate(clients[0], 'acknowledge', acknowledged.result);
  assert.equal(repeated.status, 'accepted'); assert.deepEqual(repeated.result, acknowledged.result);
  const eventCount = db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.state.changed',aggregateId:input.id}})));", { id: privateTimer.timerId });
  assert.equal(eventCount, 3);
  await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.state.changed',status:{not:'delivered'}}}))); ") === 0);
  setStage('WP25 offline peer, pull state and worker startup recovery');
  const pull = (await request('/api/devices', { method: 'POST', admin: true,
    data: { name: 'WP25 timer pull', macAddress: 'AA:25:00:00:00:01' } })).body;
  const setup = await request('/api/setup', { headers: { HTTP_ID: 'AA:25:00:00:00:01' } });
  assert.equal(setup.response.status, 200); secrets.push(setup.body.api_key);
  const pullHeaders = { HTTP_ID: setup.body.api_key };
  const pullPublish = await request('/api/publications/wp25-timer-pull/publish', { method: 'POST', admin: true, data: {
    idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [pull.id], draft: { fixtureArtifacts: ['mono-800x480-white-png'] },
  } });
  assert.equal(pullPublish.response.status, 201); await renderedFor(pull.id);
  const before = await request('/api/v1/device-content', { headers: pullHeaders }); assert.equal(before.response.status, 200);
  clients[1].socket.ws.close();
  await worker(false);
  const overdue = await send(clients[0], event(clients[0], 'create', { durationMs: 1000, visibility: 'shared' }));
  const future = await send(clients[0], event(clients[0], 'create', { durationMs: 60000, visibility: 'shared' }));
  assert.equal(overdue.status, 'accepted'); assert.equal(future.status, 'accepted');
  // Isolated fixture only: remove durable due jobs to prove startup reconstruction.
  db("console.log(JSON.stringify(await p.outboxEvent.deleteMany({where:{eventType:'timer.completion.due',aggregateId:{in:input.ids}}})));",
    { ids: [overdue.result.timerId, future.result.timerId] });
  await until(() => Date.now() > Date.parse(overdue.result.endsAt) + 20);
  assert.equal(db('console.log(JSON.stringify(await p.timer.findUniqueOrThrow({where:{timerId:input.id}})));', { id: overdue.result.timerId }).version, 1);
  await worker(true);
  let recovered;
  await until(async () => {
    recovered = (await request('/api/timers', { headers: clients[0].headers })).body.timers.find(timer => timer.timerId === overdue.result.timerId);
    return recovered.status === 'completed';
  });
  assert.equal(recovered.completedAt, overdue.result.endsAt); assert.equal(recovered.version, 2);
  assert.equal(db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.completion.due',aggregateId:input.id,status:'pending'}})));", { id: future.result.timerId }), 1);
  clients[1].socket = connect(clients[1].device, clients[1].token);
  await until(() => clients[1].socket.messages.some(message => message.type === 'connected'));
  const reconnected = await request('/api/timers', { headers: clients[1].headers });
  assert.equal(reconnected.body.timers.find(timer => timer.timerId === recovered.timerId).completedAt, recovered.completedAt);
  const pullNow = await request('/api/v1/device-content', { headers: { ...pullHeaders, 'If-None-Match': before.response.headers.get('etag') } });
  assert.equal(pullNow.response.status, 200);
  assert.equal(pullNow.body.timerState.timers.find(timer => timer.timerId === recovered.timerId).status, 'completed');
  assert.deepEqual(pullNow.body.artifacts, before.body.artifacts);
  const finalFuture = await mutate(clients[0], 'cancel', future.result);
  const finalOverdue = await mutate(clients[1], 'acknowledge', recovered);
  assert.equal(finalFuture.status, 'accepted'); assert.equal(finalOverdue.status, 'accepted');
  for (const client of clients) for (const message of client.socket.messages.filter(message => message.type === 'timers.changed'))
    assert.deepEqual(message, { protocolVersion: '1.0', type: 'timers.changed' });
  console.info('WP-25 real HTTP/WS/Redis: duplicate create, private routing, automatic completion, offline reconnect, TRMNL pull, missing-deadline startup recovery and shared transitions passed');
  return [cancelled.result, acknowledged.result, finalFuture.result, finalOverdue.result].map(timer => ({ timerId: timer.timerId, version: timer.version, status: timer.status }));
};
