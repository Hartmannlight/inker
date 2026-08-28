// Explicit WP26 production-image acceptance fixture. Never targets existing services.
// Run after building inker:wp26-test: bun test/federation-container-smoke.cjs
// Uses only loopback ports 18726/18727, its own container/volumes, and the image's OpenSSL.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { FEDERATION_LIMITS, parseFederationCapabilities, parseFederationPublicationFeed, parseInteractionEvent } = require('../../contracts/dist/index.cjs');

const runId = randomUUID().slice(0, 8);
const name = `inker-wp26-${runId}`;
const image = process.env.INKER_SMOKE_IMAGE || 'inker:wp26-test';
const password = randomBytes(24).toString('hex');
const secrets = [password];
const volumes = [];
let started = false, ca, cookie, csrf, stage = 'container creation';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000, windowsHide: true,
  maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ADMIN_PIN: password } };
const docker = (...args) => execFileSync('docker', args, options);
function inputDocker(args, input) { return execFileSync('docker', args, { ...options, input }); }

function check(condition, code) { if (!condition) throw new Error(code); }
async function until(predicate, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* A stopped listener is expected during startup/restart. */ }
    await sleep(100);
  }
  throw new Error('FEDERATION_SMOKE_TIMEOUT');
}

function request(path, { method = 'GET', data, admin = false, headers = {}, plaintext = false, trustCA = true } = {}) {
  const bytes = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const request = (plaintext ? http : https).request({ hostname: '127.0.0.1', port: plaintext ? 18727 : 18726,
      path, method, agent: false, ...(plaintext ? {} : { ca: trustCA ? ca : undefined, rejectUnauthorized: true }),
      headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(admin ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...headers },
    }, response => {
      const chunks = []; let total = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        total += chunk.length;
        if (total > FEDERATION_LIMITS.artifactBytes + FEDERATION_LIMITS.manifestBytes) {
          response.destroy(new Error('FEDERATION_RESPONSE_LIMIT')); return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('FEDERATION_REQUEST_TIMEOUT')));
    request.end(bytes);
  });
}

function json(response, wrapped = false) {
  check(response.bytes.length <= FEDERATION_LIMITS.manifestBytes, 'FEDERATION_JSON_LIMIT');
  const value = JSON.parse(response.bytes.toString('utf8'));
  return wrapped ? value.data : value;
}

async function adminLogin() {
  const response = await request('/api/auth/login', { method: 'POST', data: { password } });
  assert.equal(response.status, 200);
  const setCookie = response.headers['set-cookie'];
  check(Array.isArray(setCookie) && setCookie.length > 0, 'FEDERATION_SESSION_MISSING');
  cookie = setCookie[0].split(';')[0]; csrf = response.headers['x-csrf-token'];
  check(typeof csrf === 'string' && csrf.length > 16, 'FEDERATION_CSRF_MISSING');
  secrets.push(cookie.split('=')[1], csrf);
}

function db(expression, input = {}) {
  // Capture a bounded result and drain after disconnect; Bun can otherwise drop a large final pipe write.
  const source = `const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient();
    const input=JSON.parse(await Bun.stdin.text()); let result;
    try { result=await (${expression}); } finally {await p.$disconnect();}
    const bytes=Buffer.from(JSON.stringify(result)), {writeSync}=require('node:fs');
    if(bytes.length>4*1024*1024)throw new Error('FEDERATION_DB_LIMIT');
    const deadline=Date.now()+5000;
    for(let offset=0;offset<bytes.length;) {
      if(Date.now()>deadline)throw new Error('FEDERATION_DB_OUTPUT_TIMEOUT');
      try {offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}
      catch(error) {if(error.code!=='EAGAIN')throw error;await new Promise(resolve=>setTimeout(resolve,1));}
    }`;
  return JSON.parse(inputDocker(['exec', '-i', name, 'bun', '-e', source], JSON.stringify(input)));
}

function writeContainer(path, content) {
  // The fixed destination is in this run's container; no host filesystem changes or shell interpolation.
  inputDocker(['exec', '-i', name, 'bun', '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(path)},await Bun.stdin.text(),{mode:0o600});`], content);
}

function configureTLS() {
  const directory = '/tmp/federation-smoke-tls';
  docker('exec', name, 'openssl', 'version');
  docker('exec', name, 'mkdir', '-m', '700', directory);
  docker('exec', name, 'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=Inker WP26 disposable test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', `${directory}/ca.key`, '-out', `${directory}/ca.crt`);
  docker('exec', name, 'openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', '/CN=127.0.0.1', '-keyout', `${directory}/server.key`, '-out', `${directory}/server.csr`);
  writeContainer(`${directory}/server.ext`, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
  docker('exec', name, 'openssl', 'x509', '-req', '-in', `${directory}/server.csr`, '-CA', `${directory}/ca.crt`,
    '-CAkey', `${directory}/ca.key`, '-CAcreateserial', '-days', '1', '-sha256', '-extfile', `${directory}/server.ext`, '-out', `${directory}/server.crt`);
  docker('exec', name, 'chmod', '600', `${directory}/ca.key`, `${directory}/server.key`);
  ca = docker('exec', name, 'cat', `${directory}/ca.crt`);
  const original = docker('exec', name, 'cat', '/etc/nginx/conf.d/default.conf');
  check((original.match(/listen 80;/g) || []).length === 1, 'FEDERATION_NGINX_LAYOUT');
  // Keep the actual image's routing/header rules. Its HTTP listener remains available for spoof-denial tests.
  writeContainer('/etc/nginx/conf.d/default.conf', original.replace('listen 80;', `listen 80;
    listen 443 ssl;
    ssl_certificate ${directory}/server.crt;
    ssl_certificate_key ${directory}/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;`));
  docker('exec', name, 'nginx', '-t');
  docker('exec', name, 'nginx', '-s', 'reload');
}

async function publish(key, expectedRevision, fixtureArtifacts) {
  const response = await request(`/api/publications/${key}/publish`, { method: 'POST', admin: true,
    data: { idempotencyKey: randomUUID(), expectedRevision, deviceIds: [], draft: { fixtureArtifacts },
      allowedActions: [{ action: 'timer.create', payloadSchemaVersion: '1.0' }] } });
  assert.equal(response.status, 201);
  const result = json(response, true);
  check(typeof result?.publicationId === 'string', 'FEDERATION_PUBLICATION_MISSING');
  return result;
}

async function createShare(publicationId, data = {}) {
  const response = await request(`/api/federation/publications/${publicationId}/shares`, { method: 'POST', admin: true, data });
  assert.equal(response.status, 201);
  const result = json(response, true);
  check(/^sp_share_[A-Za-z0-9_-]{64}$/.test(result?.token), 'FEDERATION_SHARE_MISSING');
  secrets.push(result.token);
  return result;
}

function assertDenied(response, message = 'SHARE_UNAUTHORIZED') {
  assert.equal(response.status, 401);
  assert.equal(json(response).message, message);
  assert.equal(response.headers['cache-control'], 'no-store');
}

function durableState() {
  return db(`Promise.all([p.publication.findMany({orderBy:{publicationId:'asc'}}),
    p.publicationRevision.findMany({orderBy:{publicationRevisionId:'asc'}}),
    p.shareCredential.findMany({orderBy:{credentialId:'asc'}}),p.federationIdentity.findMany(),
    p.interactionReceipt.count(),p.timer.count()])`);
}

function auditSecrets() {
  const logs = spawnSync('docker', ['logs', name], options);
  assert.equal(logs.status, 0);
  const durable = db(`Promise.all([p.shareCredential.findMany(),p.adminSession.findMany(),
    p.publicationRevision.findMany(),p.outboxEvent.findMany(),p.interactionReceipt.findMany(),
    p.sourceDefinition.findMany(),p.sourceSnapshot.findMany(),p.deviceLog.findMany()])`);
  const fileLogs = inputDocker(['exec', '-i', name, 'bun', '-e', `
    const fs=require('node:fs');const result=[];let size=0;
    const paths=['/var/log/nginx/access.log','/var/log/nginx/error.log'];
    if(fs.existsSync('/app/logs'))for(const entry of fs.readdirSync('/app/logs',{withFileTypes:true}))
      if(entry.isFile())paths.push('/app/logs/'+entry.name);
    for(const path of paths)if(fs.existsSync(path)&&fs.statSync(path).isFile()) {
      size+=fs.statSync(path).size;if(size>8*1024*1024)throw new Error('FEDERATION_LOG_LIMIT');
      result.push(fs.readFileSync(path,'utf8'));
    }
    const bytes=Buffer.from(JSON.stringify(result)),{writeSync}=fs;let offset=0;const deadline=Date.now()+5000;
    while(offset<bytes.length){if(Date.now()>deadline)throw new Error('FEDERATION_LOG_OUTPUT_TIMEOUT');
      try{offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}
      catch(e){if(e.code!=='EAGAIN')throw e;await new Promise(resolve=>setTimeout(resolve,1));}}
  `], '');
  const output = [logs.stdout, logs.stderr, JSON.stringify(durable), fileLogs].join('\n');
  for (const secret of secrets) check(!output.includes(secret), 'FEDERATION_SECRET_LEAK');
}

async function main() {
  try {
    for (const role of ['uploads', 'secrets', 'render-cache']) {
      const volume = `${name}-${role}`;
      docker('volume', 'create', '--label', `inker.federation-smoke=${runId}`, volume);
      volumes.push(volume);
    }
    const mounts = volumes.flatMap((volume, index) => ['--mount', `type=volume,source=${volume},destination=${['/app/uploads', '/app/secrets', '/app/render-cache'][index]}`]);
    docker('create', '--name', name, '--label', `inker.federation-smoke=${runId}`,
      '-p', '127.0.0.1:18726:443', '-p', '127.0.0.1:18727:80', '-e', 'ADMIN_PIN',
      '-e', 'FEDERATION_TRUSTED_PROXIES=127.0.0.1,::1', '-e', 'THROTTLE_LIMIT=1000', ...mounts, image);
    started = true;
    docker('start', name);
    await until(async () => (await request('/ready', { plaintext: true })).status === 200);

    stage = 'TLS configuration and CA verification';
    configureTLS();
    await until(async () => (await request('/ready')).status === 200);
    let untrustedRejected = false;
    try { await request('/api/federation/v1/capabilities', { trustCA: false }); }
    catch (error) { untrustedRejected = typeof error.code === 'string' && /CERT|ISSUER|VERIFY|SELF_SIGNED/.test(error.code); }
    check(untrustedRejected, 'FEDERATION_UNTRUSTED_TLS_ACCEPTED');
    const discovery = await request('/api/federation/v1/capabilities');
    assert.equal(discovery.status, 200);
    const capabilities = parseFederationCapabilities(json(discovery));
    check(capabilities.success, 'FEDERATION_CAPABILITIES_INVALID');
    const serverId = capabilities.data.serverId;
    check(typeof discovery.headers.etag === 'string', 'FEDERATION_CAPABILITIES_ETAG_MISSING');
    const discovery304 = await request('/api/federation/v1/capabilities', { headers: { 'If-None-Match': discovery.headers.etag } });
    assert.equal(discovery304.status, 304); assert.equal(discovery304.bytes.length, 0);

    stage = 'plaintext and forwarded-scheme spoof denial';
    for (const headers of [{}, { 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-Proto': 'https,http' }, { Forwarded: 'proto=https' }]) {
      const denied = await request('/api/federation/v1/capabilities', { plaintext: true, headers });
      assert.equal(denied.status, 403); assert.equal(json(denied).message, 'FEDERATION_HTTPS_REQUIRED');
    }

    stage = 'admin publish and scoped share commands';
    await adminLogin();
    const key = `wp26-shared-${runId}`;
    const published = await publish(key, 0, ['mono-800x480-white-png', 'mono-800x480-white-bmp']);
    const other = await publish(`wp26-other-${runId}`, 0, ['mono-800x480-black-bmp']);
    const sharesPath = `/api/federation/publications/${published.publicationId}/shares`;
    assert.equal((await request(sharesPath, { method: 'POST', data: {} })).status, 401);
    assert.equal((await request(sharesPath, { method: 'POST', data: {}, headers: { Cookie: cookie } })).status, 403);
    const share = await createShare(published.publicationId);
    assert.equal(share.publicationId, published.publicationId);
    assert.equal(share.expiresAt, null); assert.equal(share.revokedAt, null);
    const auth = { Authorization: `Bearer ${share.token}` };
    const feedPath = `/api/federation/v1/publications/${published.publicationId}`;
    const listing = await request(sharesPath, { admin: true });
    assert.equal(listing.status, 200);
    const metadata = json(listing, true);
    assert.equal(metadata.credentials.length, 1);
    check(!listing.bytes.includes(Buffer.from(share.token)), 'FEDERATION_LIST_TOKEN_LEAK');
    check(!Object.hasOwn(metadata.credentials[0], 'tokenHash') && !Object.hasOwn(metadata.credentials[0], 'token'), 'FEDERATION_LIST_HASH_LEAK');
    const stored = db('p.shareCredential.findUniqueOrThrow({where:{credentialId:input.id}})', { id: share.credentialId });
    assert.equal(stored.tokenHash, digest(`share:v1:${share.token}`));
    check(!JSON.stringify(stored).includes(share.token), 'FEDERATION_STORED_PLAINTEXT');

    stage = 'feed read-only projection and conditional requests';
    const beforeReads = durableState();
    const feedResponse = await request(feedPath, { headers: auth });
    assert.equal(feedResponse.status, 200);
    const parsed = parseFederationPublicationFeed(json(feedResponse));
    check(parsed.success, 'FEDERATION_FEED_INVALID');
    const feed = parsed.data;
    assert.equal(feed.serverId, serverId); assert.equal(feed.publicationId, published.publicationId);
    assert.equal(feed.publicationRevisionId, published.publicationRevisionId); assert.equal(feed.revision, 1);
    assert.equal(feed.artifacts.length, 2);
    assert.equal(feedResponse.headers['cache-control'], 'private, no-cache');
    check(feedResponse.headers.vary?.includes('Authorization'), 'FEDERATION_VARY_MISSING');
    check(!Object.hasOwn(feed, 'allowedActions') && !Object.hasOwn(feed, 'timerState') && !Object.hasOwn(feed, 'sourceSnapshot'), 'FEDERATION_DOMAIN_METADATA_LEAK');
    const etag = feedResponse.headers.etag;
    check(typeof etag === 'string' && etag.length > 2, 'FEDERATION_FEED_ETAG_MISSING');
    for (let index = 0; index < 10; index++) {
      const response = await request(feedPath, { headers: auth }); assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, feedResponse.bytes); assert.equal(response.headers.etag, etag);
    }
    await Promise.all(Array.from({ length: 10 }, async () => {
      const response = await request(feedPath, { headers: { ...auth, 'If-None-Match': etag } });
      assert.equal(response.status, 304); assert.equal(response.bytes.length, 0);
    }));

    stage = 'artifact bytes hashes and immutable conditional delivery';
    for (const artifact of feed.artifacts) {
      const response = await request(artifact.url, { headers: auth });
      assert.equal(response.status, 200); assert.equal(response.bytes.length, artifact.sizeBytes);
      assert.equal(digest(response.bytes), artifact.sha256); assert.equal(response.headers['content-type'], artifact.mimeType);
      assert.equal(response.headers.etag, `"${artifact.sha256}"`);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      if (artifact.format === 'png') assert.equal(response.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      else assert.equal(response.bytes.subarray(0, 2).toString(), 'BM');
      const unchanged = await request(artifact.url, { headers: { ...auth, 'If-None-Match': response.headers.etag } });
      assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes.length, 0);
      assertDenied(await request(artifact.url, { headers: { 'If-None-Match': response.headers.etag } }));
    }
    assert.deepEqual(durableState(), beforeReads);

    stage = 'constant authentication scope and admin/device separation';
    const invalidToken = `sp_share_${randomBytes(48).toString('base64url')}`; secrets.push(invalidToken);
    for (const headers of [{}, { Authorization: 'Bearer malformed' }, { Authorization: `Bearer ${invalidToken}` },
      { Cookie: cookie }, { 'If-None-Match': etag }]) assertDenied(await request(feedPath, { headers }));
    assertDenied(await request(`/api/federation/v1/publications/${other.publicationId}`, { headers: { ...auth, 'If-None-Match': etag } }));
    assertDenied(await request('/api/federation/v1/publications/nonexistent', { headers: auth }));
    assertDenied(await request(feed.artifacts[0].url.replace(published.publicationId, other.publicationId), { headers: auth }));
    assertDenied(await request(feedPath + `?token=${share.token}`));
    const refererResponse = await request(feedPath, { headers: { ...auth, Referer: `https://127.0.0.1/?token=${share.token}` } });
    assert.equal(refererResponse.status, 200);
    const spoof = await request(feedPath, { plaintext: true, headers: { ...auth, 'X-Forwarded-Proto': 'https' } });
    assert.equal(spoof.status, 403);
    for (const path of ['/api/devices', '/api/sources', sharesPath]) assert.equal((await request(path, { headers: auth })).status, 401);
    assert.equal((await request(sharesPath, { method: 'POST', headers: auth, data: {} })).status, 401);
    const deniedInteraction = { protocolVersion: '1.0', eventId: randomUUID(), deviceId: 'wp26-unregistered-device',
      credentialId: randomUUID(), publicationId: published.publicationId, revision: String(published.revision),
      action: 'timer.create', payload: { version: 1, durationMs: 1000, visibility: 'private' },
      occurredAt: new Date().toISOString() };
    check(parseInteractionEvent(deniedInteraction).success, 'FEDERATION_INTERACTION_FIXTURE_INVALID');
    // A valid command reaches credential authentication; malformed input would stop at validation with 400.
    assert.equal((await request('/api/interactions', { method: 'POST', headers: auth, data: deniedInteraction })).status, 401);
    assert.equal((await request('/api/interactions/context', { headers: auth })).status, 401);
    assert.equal((await request(`/api/publications/${key}/publish`, { method: 'POST', headers: auth, data: {} })).status, 401);

    stage = 'real credential expiry';
    const expiring = await createShare(published.publicationId, { expiresAt: new Date(Date.now() + 5000).toISOString() });
    const expiryAuth = { Authorization: `Bearer ${expiring.token}` };
    assert.equal((await request(feedPath, { headers: expiryAuth })).status, 200);
    await until(async () => (await request(feedPath, { headers: expiryAuth })).status === 401, 8000);
    assertDenied(await request(feedPath, { headers: { ...expiryAuth, 'If-None-Match': etag } }));
    assertDenied(await request(feed.artifacts[0].url, { headers: expiryAuth }));

    stage = 'new publication revision preserves old immutable artifacts';
    const second = await publish(key, 1, ['mono-800x480-black-bmp']);
    const current = await request(feedPath, { headers: { ...auth, 'If-None-Match': etag } });
    assert.equal(current.status, 200);
    const currentFeed = parseFederationPublicationFeed(json(current)); check(currentFeed.success, 'FEDERATION_FEED_INVALID');
    assert.equal(currentFeed.data.revision, 2); assert.equal(currentFeed.data.publicationRevisionId, second.publicationRevisionId);
    check(current.headers.etag !== etag, 'FEDERATION_ETAG_NOT_CHANGED');
    const oldArtifact = await request(feed.artifacts[0].url, { headers: auth });
    assert.equal(oldArtifact.status, 200); assert.equal(digest(oldArtifact.bytes), feed.artifacts[0].sha256);

    stage = 'container restart preserves identity credential and feed';
    const beforeRestart = durableState();
    docker('restart', '--time', '35', name);
    await until(async () => (await request('/ready')).status === 200);
    const afterDiscovery = await request('/api/federation/v1/capabilities');
    assert.equal(afterDiscovery.status, 200); assert.equal(json(afterDiscovery).serverId, serverId);
    assert.equal(afterDiscovery.headers.etag, discovery.headers.etag);
    const afterFeed = await request(feedPath, { headers: auth });
    assert.equal(afterFeed.status, 200); assert.deepEqual(afterFeed.bytes, current.bytes);
    assert.equal(afterFeed.headers.etag, current.headers.etag);
    assert.deepEqual(durableState(), beforeRestart);
    await adminLogin();

    stage = 'revocation denies bodies and conditional requests immediately';
    const revoked = await request(`${sharesPath}/${share.credentialId}`, { method: 'DELETE', admin: true });
    assert.equal(revoked.status, 200);
    check(typeof json(revoked, true).revokedAt === 'string', 'FEDERATION_REVOKE_MISSING');
    const repeated = await request(`${sharesPath}/${share.credentialId}`, { method: 'DELETE', admin: true });
    assert.equal(repeated.status, 200); assert.deepEqual(json(repeated, true), json(revoked, true));
    assertDenied(await request(feedPath, { headers: { ...auth, 'If-None-Match': current.headers.etag } }));
    assertDenied(await request(feed.artifacts[0].url, { headers: { ...auth, 'If-None-Match': `"${feed.artifacts[0].sha256}"` } }));

    stage = 'secret-free logs persistence and audit metadata';
    const finalList = await request(sharesPath, { admin: true }); assert.equal(finalList.status, 200);
    const finalMetadata = json(finalList, true);
    assert.equal(finalMetadata.credentials.length, 2);
    check(finalMetadata.credentials.some(row => row.credentialId === share.credentialId && row.revokedAt), 'FEDERATION_AUDIT_MISSING');
    for (const secret of secrets) check(!finalList.bytes.includes(Buffer.from(secret)), 'FEDERATION_LIST_SECRET_LEAK');
    auditSecrets();
    console.info('WP26 TLS smoke passed: CA verification, HTTP spoof denial, scoped share/expiry/revocation, feed/artifact ETags and hashes, read-only state, retained revisions, stable restart identity, secret audit');
  } catch (error) {
    process.exitCode = 1;
    console.error(`WP26 TLS smoke failed at ${stage}`);
    // Never print exception messages, tool commands, headers, response bodies or secrets.
    if (typeof error?.message === 'string' && /^FEDERATION_[A-Z_]+$/.test(error.message)) console.error(`Fixture code: ${error.message}`);
    if (Number.isFinite(error?.actual) && Number.isFinite(error?.expected)) console.error(`Numeric assertion: actual=${error.actual} expected=${error.expected}`);
    if (Number.isInteger(error?.status)) console.error(`Tool exit status: ${error.status}`);
    const location = typeof error?.stack === 'string' && error.stack.match(/federation-container-smoke\.cjs:(\d+):(\d+)/);
    if (location) console.error(`Smoke source location: ${location[1]}:${location[2]}`);
  } finally {
    let cleanupFailed = false;
    if (started) {
      try { docker('stop', '--timeout', '35', name); } catch { /* Forced removal below also handles a failed startup. */ }
      try { docker('rm', '-f', '-v', name); } catch { cleanupFailed = true; }
    }
    for (const volume of volumes.reverse()) {
      try { docker('volume', 'rm', volume); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      process.exitCode = 1;
      console.error(`WP26 own-fixture cleanup requires inspection: ${name}`);
    }
  }
}

void main();
