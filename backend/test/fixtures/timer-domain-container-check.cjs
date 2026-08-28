const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function check({ request, db, renderedFor, until, secrets, setStage }) {
  setStage('WP24 timer domain fixture');
  const clients = [];
  const actions = ['create', 'pause', 'resume', 'cancel', 'acknowledge'].map(action => ({ action: `timer.${action}`, payloadSchemaVersion: '1.0' }));
  for (let index = 0; index < 2; index++) {
    const created = await request('/api/devices', { method: 'POST', admin: true, data: { name: `WP24 timer ${index}`, deviceType: 'web-display' } });
    assert.equal(created.response.status, 201);
    secrets.push(created.body.pairingToken);
    const paired = await request('/api/web-displays/pair', { method: 'POST', data: { externalId: created.body.externalId, pairingToken: created.body.pairingToken } });
    assert.equal(paired.response.status, 201); secrets.push(paired.body.credential);
    clients.push({ device: created.body, headers: { Authorization: `Bearer ${paired.body.credential}` } });
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
  const paused = await mutate(clients[1], 'pause', running);
  assert.equal(paused.status, 'accepted'); assert.equal(paused.result.status, 'paused');
  assert.ok(paused.result.pausedRemainingMs > 0 && paused.result.pausedRemainingMs <= 60000);
  const resumed = await mutate(clients[0], 'resume', paused.result);
  assert.equal(resumed.status, 'accepted'); assert.equal(resumed.result.status, 'running');
  const cancelled = await mutate(clients[1], 'cancel', resumed.result);
  assert.equal(cancelled.status, 'accepted'); assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(cancelled.result.version, 4);
  setStage('WP24 private authorization and server-time completion');
  const privateResult = await send(clients[0], event(clients[0], 'create', { durationMs: 1000, visibility: 'private' }));
  assert.equal(privateResult.status, 'accepted');
  const privateTimer = privateResult.result;
  const denied = await mutate(clients[1], 'pause', privateTimer);
  assert.equal(denied.status, 'rejected');
  // Server time advances without a DB tick. Scheduling is introduced in WP25.
  await until(() => Date.now() > Date.parse(privateTimer.endsAt) + 20);
  const persisted = db('console.log(JSON.stringify(await p.timer.findUniqueOrThrow({where:{timerId:input.id}})));', { id: privateTimer.timerId });
  assert.equal(persisted.status, 'running'); assert.equal(persisted.version, 1);
  const acknowledged = await mutate(clients[0], 'acknowledge', privateTimer);
  assert.equal(acknowledged.status, 'accepted'); assert.equal(acknowledged.result.status, 'completed');
  assert.equal(acknowledged.result.version, 2);
  assert.equal(acknowledged.result.completedAt, privateTimer.endsAt);
  assert.equal(acknowledged.result.acknowledgedByDeviceId, clients[0].device.externalId);
  const repeated = await mutate(clients[0], 'acknowledge', acknowledged.result);
  assert.equal(repeated.status, 'accepted'); assert.deepEqual(repeated.result, acknowledged.result);
  const eventCount = db("console.log(JSON.stringify(await p.outboxEvent.count({where:{aggregateType:'Timer',aggregateId:input.id}})));", { id: privateTimer.timerId });
  assert.equal(eventCount, 2);
  await until(() => db("console.log(JSON.stringify(await p.outboxEvent.count({where:{eventType:'timer.state.changed',status:{not:'delivered'}}}))); ") === 0);
  console.info('WP-24 real HTTP: duplicate create, shared pause/resume/cancel, private denial, no tick writes, due acknowledgement and durable domain events passed');
  return [cancelled.result, acknowledged.result].map(timer => ({ timerId: timer.timerId, version: timer.version, status: timer.status }));
};
