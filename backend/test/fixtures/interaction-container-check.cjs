const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Only the parent smoke's freshly created container and volumes are used.
module.exports = async function check({ request, db, renderedFor, secrets, setStage }) {
  setStage('WP23 interaction fixture');
  const created = await request('/api/devices', { method: 'POST', admin: true, data: { name: 'WP23 touch', deviceType: 'web-display' } });
  assert.equal(created.response.status, 201);
  const device = created.body; secrets.push(device.pairingToken);
  const paired = await request('/api/web-displays/pair', { method: 'POST', data: { externalId: device.externalId, pairingToken: device.pairingToken } });
  assert.equal(paired.response.status, 201);
  const token = paired.body.credential; secrets.push(token);
  const headers = { Authorization: `Bearer ${token}` };
  const actions = [{ action: 'view.next', targetId: 'next', payloadSchemaVersion: '1.0' }];
  const revisions = [];
  for (let i = 0; i < 2; i++) {
    const published = await request(`/api/publications/wp23-${i}/publish`, { method: 'POST', admin: true, data: {
      idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [device.id], allowedActions: actions,
      draft: { fixtureArtifacts: ['mono-800x480-white-png'] },
    } });
    assert.equal(published.response.status, 201);
    revisions.push(published.body.publicationRevisionId);
    await renderedFor(device.id);
  }
  const fixture = db("console.log(JSON.stringify(await p.playlist.create({data:{name:'WP23 fixture',items:{create:[{order:0,duration:null},{order:1,duration:null}]}},include:{items:{orderBy:{order:'asc'}}}}))); ");
  const draft = await request(`/api/playback/playlists/${fixture.id}/draft`, { admin: true });
  const published = await request(`/api/playback/playlists/${fixture.id}/publish`, { method: 'POST', admin: true, data: {
    version: 1, idempotencyKey: randomUUID(), expectedRevision: 0, expectedDraftHash: draft.body.draftHash,
    bindings: fixture.items.map((item, i) => ({ itemId: item.id, publicationRevisionId: revisions[i] })),
  } });
  assert.equal(published.response.status, 201);
  const previous = await request('/api/interactions/context', { headers });
  assert.equal(previous.response.status, 200);
  const started = await request(`/api/playback/devices/${device.id}/commands`, { method: 'POST', admin: true, data: {
    version: 1, idempotencyKey: randomUUID(), action: 'start', expectedVersion: 0,
    expectedDesiredSequence: previous.body.playback.desiredSequence, playlistRevisionId: published.body.playlistRevisionId,
  } });
  assert.equal(started.response.status, 201);
  await renderedFor(device.id);
  const context = await request('/api/interactions/context', { headers });
  assert.equal(context.response.status, 200);
  assert.equal(context.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(context.body.allowedActions, actions);
  const event = {
    protocolVersion: '1.0', eventId: randomUUID(), deviceId: device.externalId, credentialId: context.body.credentialId,
    publicationId: context.body.publicationId, revision: context.body.revision, action: 'view.next', targetId: 'next',
    occurredAt: context.body.serverTime, clientSequence: 1,
    payload: { version: 1, expectedPlaybackVersion: context.body.playback.version, expectedDesiredSequence: context.body.playback.desiredSequence },
  };
  setStage('WP23 HTTP authentication and bounded input');
  assert.equal((await request('/api/interactions', { method: 'POST', admin: true, data: event })).response.status, 401);
  assert.equal((await request('/api/interactions', { method: 'POST', headers: { HTTP_ID: token }, data: event })).response.status, 401);
  assert.equal((await request('/api/interactions', { method: 'POST', headers, data: { ...event, payload: { text: 'x'.repeat(4097) } } })).response.status, 400);
  const denied = await request('/api/interactions', { method: 'POST', headers, data: { ...event, eventId: randomUUID(), action: 'timer.start' } });
  assert.equal(denied.response.status, 200); assert.equal(denied.body.status, 'rejected');
  assert.equal(denied.body.error.code, 'INTERACTION_NOT_ALLOWED');
  setStage('WP23 HTTP concurrent idempotent touch');
  const results = await Promise.all(Array.from({ length: 2 }, () => request('/api/interactions', { method: 'POST', headers, data: event })));
  for (const result of results) {
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-correlation-id'), result.body.commandId);
  }
  assert.deepEqual(results.map(result => result.body.status).sort(), ['accepted', 'duplicate']);
  const accepted = results.find(result => result.body.status === 'accepted').body;
  assert.deepEqual(results.find(result => result.body.status === 'duplicate').body, { ...accepted, status: 'duplicate' });
  const state = await request(`/api/playback/devices/${device.id}`, { admin: true });
  assert.equal(state.body.version, context.body.playback.version + 1);
  assert.equal(state.body.state.currentItemId, fixture.items[1].id);
  const receipts = db('console.log(JSON.stringify(await p.interactionReceipt.findMany({where:{deviceId:input.id}})));', { id: device.id });
  assert.equal(receipts.filter(receipt => receipt.eventId === event.eventId).length, 1);
  assert.equal(JSON.stringify(receipts).includes(token), false);
  const collision = await request('/api/interactions', { method: 'POST', headers, data: { ...event, targetId: 'different' } });
  assert.equal(collision.body.error.code, 'INTERACTION_EVENT_CONFLICT');
  await renderedFor(device.id);
  setStage('WP23 credential revocation denies persisted replay');
  const enrollment = await request(`/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true });
  assert.equal(enrollment.response.status, 201); secrets.push(enrollment.body.code);
  const exchange = await request('/api/device-enrollments/exchange', { method: 'POST', data: { code: enrollment.body.code } });
  assert.equal(exchange.response.status, 200); secrets.push(exchange.body.credential);
  assert.equal((await request('/api/interactions', { method: 'POST', headers, data: event })).response.status, 401);
  console.info('WP-23 real HTTP: publication authority, bounded input, concurrent duplicate, exactly one advance, durable result/correlation and revoked replay passed');
  return { eventId: event.eventId, commandId: accepted.commandId, deviceId: device.id, version: state.body.version };
};
