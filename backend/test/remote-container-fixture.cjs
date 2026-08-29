// WP27 disposable three-server fixture. No existing container, volume or network is adopted.
// bun ./test/remote-container-fixture.cjs setup|smoke|inspect|offlineA|offlineB|onlineA|onlineB|revokeA|restartHome|cleanup
// setup stays available for browser QA; smoke creates a fresh run and always cleans up.
// Credentials are written only to the ignored 0600 state file, never to stdout or command arguments.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const runtime = require('./fixtures/remote-fixture-runtime.cjs');
const { parseRemoteSubscriptionList, parseFederationCapabilities, parseFederationPublicationFeed,
  parseDeviceServerMessage } = require('../../contracts/dist/index.cjs');
const { statePath, check, exec, control, save, load, newState, wait, request, json, login, db,
  createInfrastructure, configureRemotes, ready, counter, audit, cleanup, remember } = runtime;
let stage = 'initialize';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const remoteRoles = ['remote-a', 'remote-b'];

async function views(state) {
  const response = await request(state, 'home', '/api/remote-subscriptions', { admin: true });
  assert.equal(response.status, 200);
  const parsed = parseRemoteSubscriptionList(json(response)); check(parsed.success, 'FIXTURE_REMOTE_VIEW_INVALID');
  return parsed.data;
}
async function view(state, role) {
  const rows = await views(state), result = rows.find(row => row.subscriptionId === state.remotes[role].subscriptionId);
  check(result, 'FIXTURE_SUBSCRIPTION_MISSING'); return result;
}
async function sync(state, role) {
  const response = await request(state, 'home', `/api/remote-subscriptions/${state.remotes[role].subscriptionId}/sync`, { admin: true, method: 'POST', data: {} });
  assert.equal(response.status, 201); assert.equal(json(response).scheduled, true);
}
async function waitView(state, role, predicate, milliseconds = 90000) {
  let result;
  await wait(async () => { result = await view(state, role); return predicate(result); }, milliseconds);
  return result;
}
async function synced(state, role, predicate = row => row.status === 'fresh') {
  const previous = await view(state, role); await sync(state, role);
  return waitView(state, role, row => row.lastAttemptAt !== previous.lastAttemptAt && predicate(row));
}
async function publish(state, role, expectedRevision, fixtures) {
  const response = await request(state, role, '/api/publications/wp27-shared/publish', { method: 'POST', admin: true,
    data: { idempotencyKey: randomUUID(), expectedRevision, deviceIds: [], draft: { fixtureArtifacts: fixtures },
      allowedActions: [{ action: 'timer.create', payloadSchemaVersion: '1.0' }] } });
  assert.equal(response.status, 201); return json(response);
}
async function createRemote(state, role) {
  await login(state, role);
  const capabilityResponse = await request(state, role, '/api/federation/v1/capabilities');
  assert.equal(capabilityResponse.status, 200);
  const capability = parseFederationCapabilities(json(capabilityResponse, false)); check(capability.success, 'FIXTURE_CAPABILITY_INVALID');
  const published = await publish(state, role, 0, role === 'remote-a'
    ? ['mono-800x480-white-png', 'mono-800x480-white-bmp'] : ['mono-800x480-black-bmp']);
  const shareResponse = await request(state, role, `/api/federation/publications/${published.publicationId}/shares`, { method: 'POST', admin: true, data: {} });
  assert.equal(shareResponse.status, 201);
  const share = json(shareResponse); remember(state, share.token);
  const feedResponse = await request(state, role, `/api/federation/v1/publications/${published.publicationId}`, { headers: { Authorization: `Bearer ${share.token}` } });
  assert.equal(feedResponse.status, 200);
  const feed = parseFederationPublicationFeed(json(feedResponse, false)); check(feed.success, 'FIXTURE_FEED_INVALID');
  const response = await request(state, 'home', '/api/remote-subscriptions', { method: 'POST', admin: true,
    data: { name: role === 'remote-a' ? 'Remote A · white' : 'Remote B · black', baseUrl: `https://${role}`,
      serverId: capability.data.serverId, publicationId: published.publicationId, token: share.token, trust: true, refreshIntervalSeconds: 60 } });
  assert.equal(response.status, 201);
  state.remotes[role] = { serverId: capability.data.serverId, publicationId: published.publicationId,
    shareId: share.credentialId, token: share.token, subscriptionId: json(response).subscriptionId,
    sourceFeed: feed.data, sourceETag: feedResponse.headers.etag, offline: false, revoked: false };
  save(state);
}
async function createDevice(state, key, data) {
  const response = await request(state, 'home', '/api/devices', { method: 'POST', admin: true, data });
  assert.equal(response.status, 201); const device = json(response);
  remember(state, device.pairingToken); remember(state, device.apiKey);
  const enrollment = await request(state, 'home', `/api/devices/${device.id}/enrollments`, { method: 'POST', admin: true, data: {} });
  assert.equal(enrollment.status, 201); const code = json(enrollment).code; remember(state, code);
  const exchange = await request(state, 'home', '/api/device-enrollments/exchange', { method: 'POST', data: { code } });
  assert.equal(exchange.status, 200); const credentials = json(exchange); remember(state, credentials.credential);
  state.devices[key] = { id: device.id, externalId: device.externalId, credential: credentials.credential, credentialId: credentials.credentialId };
  save(state);
}
async function assign(state, role, key) {
  const device = state.devices[key];
  const response = await request(state, 'home', `/api/remote-subscriptions/${state.remotes[role].subscriptionId}/devices/${device.id}`, { method: 'PUT', admin: true, data: {} });
  assert.equal(response.status, 200); assert.equal(json(response).assigned, true);
  await rendered(state, device.id);
}
async function rendered(state, deviceId) {
  await wait(async () => {
    const result = db(state, 'home', `p.renderBinding.findFirst({where:{deviceId:input.id},include:{ready:true,device:{include:{publicationState:true}}}})`, { id: deviceId });
    return result?.ready?.completedAt && result.readyKey === result.desiredKey
      && result.ready.publicationRevisionId === result.device.publicationState?.desiredPublicationRevisionId;
  });
}
async function browserCopy(state, role) {
  const device = state.devices[role]; await rendered(state, device.id);
  const auth = { Authorization: `Bearer ${device.credential}` };
  const response = await request(state, 'home', `/api/web-displays/${device.externalId}/presentation`, { headers: auth });
  assert.equal(response.status, 200);
  const parsed = parseDeviceServerMessage({ protocolVersion: '1.0', type: 'presentation.changed', presentation: json(response) });
  check(parsed.success && parsed.data.type === 'presentation.changed', 'FIXTURE_BROWSER_MANIFEST_INVALID');
  const presentation = parsed.data.presentation;
  check(presentation.content.url.startsWith(`/api/web-displays/${device.externalId}/artifacts/`), 'FIXTURE_NONLOCAL_ARTIFACT');
  const artifact = await request(state, 'home', presentation.content.url, { headers: auth });
  assert.equal(artifact.status, 200); assert.equal(artifact.headers['content-type'], 'image/png');
  const sha256 = hash(artifact.bytes); assert.equal(presentation.content.url.split('/').pop(), sha256);
  const subscription = await view(state, role);
  const pointer = db(state, 'home', `p.devicePublicationState.findUniqueOrThrow({where:{deviceId:input.id},select:{desiredPublicationRevisionId:true}})`, { id: device.id });
  assert.equal(pointer.desiredPublicationRevisionId, subscription.localPublicationRevisionId);
  const unchanged = await request(state, 'home', presentation.content.url, { headers: { ...auth, 'If-None-Match': artifact.headers.etag } });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes.length, 0);
  return { sha256, localPublicationId: subscription.localPublicationId, localRevisionId: subscription.localPublicationRevisionId };
}
async function pullCopy(state, role) {
  await assign(state, role, 'pull');
  const auth = { Authorization: `Bearer ${state.devices.pull.credential}` };
  const response = await request(state, 'home', '/api/v1/device-content', { headers: auth });
  assert.equal(response.status, 200); const manifest = json(response, false);
  const subscription = await view(state, role);
  assert.equal(manifest.publicationId, subscription.localPublicationId);
  assert.equal(manifest.metadata.fallback, false); assert.deepEqual(manifest.allowedActions, []);
  const meta = manifest.artifacts[0]; check(meta.url.startsWith('/api/v1/device-content/artifacts/'), 'FIXTURE_NONLOCAL_ARTIFACT');
  assert.equal(meta.mimeType, 'image/bmp');
  const artifact = await request(state, 'home', meta.url, { headers: auth });
  assert.equal(artifact.status, 200); assert.equal(hash(artifact.bytes), meta.sha256); assert.equal(artifact.bytes.length, meta.sizeBytes);
  const expected = state.remotes[role].sourceFeed.artifacts.find(item => item.format === 'bmp1');
  check(expected, 'FIXTURE_BMP_MISSING'); assert.equal(hash(artifact.bytes), expected.sha256);
  const unchanged = await request(state, 'home', '/api/v1/device-content', { headers: { ...auth, 'If-None-Match': response.headers.etag } });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes.length, 0);
  return { sha256: meta.sha256, localPublicationId: manifest.publicationId };
}
async function prepare(state) {
  stage = 'create owned network and three isolated servers'; createInfrastructure(state);
  stage = 'TLS certificates and home trust anchor before startup'; await configureRemotes(state);
  for (const role of remoteRoles) {
    let rejected = false;
    try { await request(state, role, '/ready', { trustCA: false }); } catch (error) { rejected = /CERT|ISSUER|VERIFY|SELF_SIGNED/.test(String(error.code)); }
    check(rejected, 'FIXTURE_UNTRUSTED_TLS_ACCEPTED');
  }
  stage = 'publish and subscribe to two remote publications';
  await login(state, 'home');
  for (const role of remoteRoles) await createRemote(state, role);
  assert.notEqual(state.remotes['remote-a'].serverId, state.remotes['remote-b'].serverId);
  for (const role of remoteRoles) await waitView(state, role, row => row.status === 'fresh' && row.remoteRevision === 1 && row.localPublicationRevisionId !== null);
  stage = 'three real device enrollments and local cache assignments';
  for (const role of remoteRoles) await createDevice(state, role, { name: role === 'remote-a' ? 'Remote A browser' : 'Remote B browser', deviceType: 'web-display' });
  await createDevice(state, 'pull', { name: 'WP27 isolated pull proof', deviceType: 'trmnl', macAddress: '02:27:00:00:00:01',
    profileId: 'trmnl-byod-7.5-mono', deliveryPolicyId: 'reference-responsive-pull',
    capabilitiesOverride: { display: { renderFormats: ['bmp1'], mimeTypes: ['image/bmp'] } } });
  for (const role of remoteRoles) await assign(state, role, role);
  const browserA = await browserCopy(state, 'remote-a'), browserB = await browserCopy(state, 'remote-b');
  assert.notEqual(browserA.sha256, browserB.sha256);
  await pullCopy(state, 'remote-a'); await pullCopy(state, 'remote-b');
  state.baseline = { 'remote-a': browserA, 'remote-b': browserB };
  state.ready = true; save(state);
}
async function browserEnrollments(state) {
  for (const role of remoteRoles) {
    const response = await request(state, 'home', `/api/devices/${state.devices[role].id}/enrollments`, { method: 'POST', admin: true, data: {} });
    assert.equal(response.status, 201); const enrollment = json(response);
    state.devices[role].browserPairingCode = enrollment.code; state.devices[role].browserPairingExpiresAt = enrollment.expiresAt;
    remember(state, enrollment.code);
  }
  save(state);
}
async function offline(state, role) {
  control(state, role, 'stop'); state.remotes[role].offline = true; save(state);
  await synced(state, role, row => row.status === 'stale' && row.lastErrorCode !== null);
}
async function online(state, role) {
  control(state, role, 'start'); await ready(state, role); state.remotes[role].offline = false; save(state);
  const response = await request(state, 'home', `/api/remote-subscriptions/${state.remotes[role].subscriptionId}`, { method: 'PATCH', admin: true, data: { enabled: true } });
  assert.equal(response.status, 200);
  await waitView(state, role, row => state.remotes[role].revoked ? row.lastErrorCode === 'REMOTE_UNAUTHORIZED' : row.status === 'fresh');
}
async function revokeA(state) {
  const role = 'remote-a', remote = state.remotes[role]; check(!remote.offline, 'FIXTURE_REMOTE_OFFLINE');
  await login(state, role);
  const response = await request(state, role, `/api/federation/publications/${remote.publicationId}/shares/${remote.shareId}`, { method: 'DELETE', admin: true });
  assert.equal(response.status, 200); remote.revoked = true; save(state);
  await synced(state, role, row => row.status === 'stale' && row.lastErrorCode === 'REMOTE_UNAUTHORIZED');
}
async function restartHome(state) {
  control(state, 'home', 'restart'); await ready(state, 'home'); await login(state, 'home');
}
async function adminBoundaries(state) {
  const path = '/api/remote-subscriptions';
  for (const token of [undefined, state.devices['remote-a'].credential, state.remotes['remote-a'].token]) {
    const response = await request(state, 'home', path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
  }
  const csrf = await request(state, 'home', `${path}/${state.remotes['remote-a'].subscriptionId}/sync`, {
    method: 'POST', data: {}, headers: { Cookie: state.servers.home.cookie },
  });
  assert.equal(csrf.status, 403);
  const counts = () => db(state, 'home', 'Promise.all([p.remoteSubscription.count(),p.remoteServer.count(),p.remoteCredential.count(),p.publication.count()])');
  const before = counts(), remote = state.remotes['remote-a'];
  const valid = { name: 'Rejected test subscription', baseUrl: 'https://remote-a', serverId: remote.serverId,
    publicationId: remote.publicationId, token: remote.token, trust: true, refreshIntervalSeconds: 60 };
  for (const change of [{ trust: false }, { baseUrl: 'http://remote-a' }, { baseUrl: 'https://not-allowed.invalid' }]) {
    const response = await request(state, 'home', path, { admin: true, method: 'POST', data: { ...valid, ...change } });
    assert.equal(response.status, 400);
    assert.deepEqual(counts(), before);
  }
}
async function protocolMismatch(state) {
  const role = 'remote-b';
  const original = exec(state, role, ['cat', '/etc/nginx/conf.d/default.conf']);
  const response = await request(state, role, '/api/federation/v1/capabilities');
  assert.equal(response.status, 200);
  const parsed = parseFederationCapabilities(json(response, false)); check(parsed.success, 'FIXTURE_CAPABILITY_INVALID');
  const body = JSON.stringify({ ...parsed.data, protocolVersion: '2.0' });
  check(!body.includes("'"), 'FIXTURE_NGINX_JSON_INVALID');
  const inject = original.replace('server {', `server {\nlocation = /api/federation/v1/capabilities {\n default_type application/json;\n access_log /tmp/wp27-federation-status.log wp27_status;\n return 200 '${body}';\n}\n`);
  check(inject !== original, 'FIXTURE_NGINX_LAYOUT');
  const install = content => {
    exec(state, role, ['bun', '-e', "require('node:fs').writeFileSync('/etc/nginx/conf.d/default.conf',await Bun.stdin.text(),{mode:0o600});"], content);
    exec(state, role, ['nginx', '-t']); exec(state, role, ['nginx', '-s', 'reload']);
  };
  try {
    install(inject);
    await wait(async () => json(await request(state, role, '/api/federation/v1/capabilities'), false).protocolVersion === '2.0', 5000);
    await synced(state, role, row => row.status === 'stale' && row.lastErrorCode === 'REMOTE_PROTOCOL_MISMATCH');
    assert.deepEqual(await browserCopy(state, role), state.baseline[role]);
    await pullCopy(state, role);
  } finally {
    install(original);
  }
  await wait(async () => json(await request(state, role, '/api/federation/v1/capabilities'), false).protocolVersion === '1.0', 5000);
  // Normal admin command creates a new configuration generation; no DB status mutation.
  await online(state, role);
  assert.deepEqual(await browserCopy(state, role), state.baseline[role]);
}
async function smoke(state) {
  stage = 'admin authentication, CSRF, trust and origin rejection without writes';
  await adminBoundaries(state);
  stage = 'unsupported remote protocol retains old cache and recovers over real TLS';
  await protocolMismatch(state);
  stage = 'real conditional federation GET returns 304 without creating a local revision';
  for (const role of remoteRoles) {
    const before = await view(state, role), counts = counter(state, role);
    const after = await synced(state, role);
    assert.equal(after.localPublicationRevisionId, before.localPublicationRevisionId);
    assert.equal(after.remoteRevision, before.remoteRevision);
    await wait(async () => (counter(state, role)['304'] || 0) > (counts['304'] || 0), 5000);
  }
  stage = 'new remote revision updates exactly the assigned local publication';
  const role = 'remote-a', previous = await view(state, role);
  await publish(state, role, 1, ['mono-800x480-black-bmp']);
  const source = await request(state, role, `/api/federation/v1/publications/${state.remotes[role].publicationId}`, { headers: { Authorization: `Bearer ${state.remotes[role].token}` } });
  assert.equal(source.status, 200); const parsed = parseFederationPublicationFeed(json(source, false)); check(parsed.success, 'FIXTURE_FEED_INVALID');
  state.remotes[role].sourceFeed = parsed.data; save(state);
  const next = await synced(state, role, row => row.status === 'fresh' && row.remoteRevision === 2);
  assert.notEqual(next.localPublicationRevisionId, previous.localPublicationRevisionId);
  assert.equal(next.localPublicationId, previous.localPublicationId);
  const updated = await browserCopy(state, role); assert.notEqual(updated.sha256, state.baseline[role].sha256);
  state.baseline[role] = updated; save(state); await pullCopy(state, role);

  stage = 'both remotes offline retain visible verified browser and pull artifacts';
  for (const remoteRole of remoteRoles) await offline(state, remoteRole);
  for (const remoteRole of remoteRoles) {
    assert.deepEqual(await browserCopy(state, remoteRole), state.baseline[remoteRole]);
    await pullCopy(state, remoteRole);
  }

  stage = 'home restart resumes durable remote work while serving cached bytes';
  exec(state, 'home', ['/command/s6-svc', '-d', '/run/service/worker']);
  exec(state, 'home', ['/command/s6-svwait', '-d', '-t', '30000', '/run/service/worker']);
  await sync(state, 'remote-b');
  const pending = db(state, 'home', `p.remoteSyncJob.findFirst({where:{subscriptionId:input.id,completedAt:null,event:{status:'pending'}},include:{event:true},orderBy:{scheduledAt:'desc'}})`, { id: state.remotes['remote-b'].subscriptionId });
  check(pending?.event, 'FIXTURE_DURABLE_JOB_MISSING');
  const restartedAt = Date.now(); await restartHome(state);
  for (const remoteRole of remoteRoles) assert.deepEqual(await browserCopy(state, remoteRole), state.baseline[remoteRole]);
  await wait(async () => {
    const current = db(state, 'home', 'p.outboxEvent.findUnique({where:{eventId:input.id}})', { id: pending.eventId });
    return current && current.attempts > pending.event.attempts;
  }, 100000);
  const restartRecoveryMs = Date.now() - restartedAt;

  stage = 'recovery and revoked credential keep last good local content';
  for (const remoteRole of remoteRoles) await online(state, remoteRole);
  await revokeA(state);
  assert.deepEqual(await browserCopy(state, 'remote-a'), state.baseline['remote-a']);
  await pullCopy(state, 'remote-a');
  assert.equal((await view(state, 'remote-a')).lastErrorCode, 'REMOTE_UNAUTHORIZED');
  stage = 'secret-free application database and log audit'; audit(state);
  return { restartRecoveryMs, conditional304: { A: counter(state, 'remote-a')['304'] || 0, B: counter(state, 'remote-b')['304'] || 0 } };
}
async function summary(state) {
  const rows = await views(state);
  return { home: 'http://127.0.0.1:18728/remotes', statePath,
    subscriptions: rows.map(row => ({ name: row.name, subscriptionId: row.subscriptionId, status: row.status,
      remoteRevision: row.remoteRevision, localPublicationId: row.localPublicationId, lastErrorCode: row.lastErrorCode })),
    displays: remoteRoles.map(role => ({ deviceId: state.devices[role].id, url: `http://127.0.0.1:18728/display/${state.devices[role].externalId}` })) };
}
async function main() {
  let state, cleanupAfter = false;
  try {
    const command = process.argv[2];
    if (command === 'setup' || command === 'smoke') {
      state = newState(); cleanupAfter = true; await prepare(state);
      if (command === 'smoke') {
        const results = await smoke(state); console.info(JSON.stringify({ result: 'WP27 real three-server smoke passed', ...results }));
      } else {
        await browserEnrollments(state); audit(state); const result = await summary(state);
        cleanupAfter = false; console.info(JSON.stringify(result));
      }
      return;
    }
    check(['inspect', 'offlineA', 'offlineB', 'onlineA', 'onlineB', 'revokeA', 'restartHome', 'cleanup'].includes(command), 'FIXTURE_COMMAND_INVALID');
    state = load();
    if (command === 'cleanup') { cleanup(state); console.info('Own WP27 fixture removed'); return; }
    check(state.ready, 'FIXTURE_SETUP_INCOMPLETE');
    await login(state, 'home');
    stage = command;
    if (command === 'offlineA' || command === 'offlineB') await offline(state, command.endsWith('A') ? 'remote-a' : 'remote-b');
    if (command === 'onlineA' || command === 'onlineB') await online(state, command.endsWith('A') ? 'remote-a' : 'remote-b');
    if (command === 'revokeA') await revokeA(state);
    if (command === 'restartHome') await restartHome(state);
    console.info(JSON.stringify(await summary(state)));
  } catch (error) {
    process.exitCode = 1; console.error(`WP27 fixture failed at ${stage}`);
    if (typeof error?.message === 'string' && /^FIXTURE_[A-Z_]+$/.test(error.message)) console.error(error.message);
    if (Number.isFinite(error?.actual) && Number.isFinite(error?.expected)) console.error(`Numeric assertion: actual=${error.actual} expected=${error.expected}`);
    const location = typeof error?.stack === 'string' && error.stack.match(/(?:remote-container-fixture|remote-fixture-runtime)\.cjs:(\d+):(\d+)/);
    if (location) console.error(`Fixture location: ${location[1]}:${location[2]}`);
  } finally {
    if (cleanupAfter && state) {
      try { cleanup(state); } catch { process.exitCode = 1; console.error(`Own WP27 fixture cleanup needs inspection; state retained at ${statePath}`); }
    }
  }
}
if (require.main === module) void main();
module.exports = { prepare, createDevice, rendered, views, sync, waitView, browserCopy, adminBoundaries };
