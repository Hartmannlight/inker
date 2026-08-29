// WP27 fixture infrastructure only. Every Docker operation is restricted to this run's labels and derived names.
const { execFileSync, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const temporary = path.resolve(__dirname, '../../../.tmp');
const statePath = path.join(temporary, 'wp27-remote-fixture-state.json');
const label = 'inker.wp27.fixture';
const roles = ['home', 'remote-a', 'remote-b'];
const mounts = ['uploads', 'secrets', 'render-cache'];
const ports = { home: 18728, 'remote-a': 18729, 'remote-b': 18730 };
const options = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
function check(value, code) { if (!value) throw new Error(code); }
function docker(args, input, env) { return execFileSync('docker', args, { ...options, input, env: env ? { ...process.env, ...env } : process.env }); }
function validate(state) {
  check(state && state.version === 1 && /^[a-f0-9]{16}$/.test(state.runId), 'FIXTURE_STATE_INVALID');
  check(state.servers && roles.every(role => state.servers[role] && typeof state.servers[role].password === 'string'), 'FIXTURE_STATE_INVALID');
  return state;
}
function prefix(state) { validate(state); return `inker-wp27-${state.runId}`; }
function container(state, role) { check(roles.includes(role), 'FIXTURE_ROLE_INVALID'); return `${prefix(state)}-${role}`; }
function network(state) { return `${prefix(state)}-network`; }
function volume(state, role, mount) { check(mounts.includes(mount), 'FIXTURE_VOLUME_INVALID'); return `${container(state, role)}-${mount}`; }
function caArchive(certificate) {
  // docker cp reads this ustar archive from stdin. Explicit 0644 is portable across Windows hosts
  // and lets the unprivileged worker read this PUBLIC trust anchor before its first startup.
  const bytes = Buffer.from(certificate, 'utf8');
  check(bytes.length > 0 && bytes.length <= 16384 && certificate.startsWith('-----BEGIN CERTIFICATE-----'), 'FIXTURE_CA_INVALID');
  const header = Buffer.alloc(512);
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  header.write('remote-fixture-ca.crt', 0, 100, 'ascii');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(bytes.length, 12), 124, 12, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]);
}
function inspect(kind, name) {
  const result = spawnSync('docker', [kind, 'inspect', name], options);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  const message = String(result.stderr);
  if (result.status === 1 && /No such (?:object|container|network|volume)|not found/i.test(message)) return null;
  throw new Error('FIXTURE_DOCKER_INSPECTION_FAILED');
}
function owned(state, kind, name, optional = false) {
  const validNames = kind === 'container' ? roles.map(role => container(state, role))
    : kind === 'volume' ? roles.flatMap(role => mounts.map(mount => volume(state, role, mount))) : [network(state)];
  check(validNames.includes(name), 'FIXTURE_RESOURCE_INVALID');
  const result = inspect(kind, name);
  if (!result && optional) return null;
  check(result && (kind === 'container' ? result.Config?.Labels : result.Labels)?.[label] === state.runId, 'FIXTURE_OWNERSHIP_MISMATCH');
  return result;
}
function exec(state, role, args, input) {
  const name = container(state, role); owned(state, 'container', name);
  return docker(['exec', '-i', name, ...args], input);
}
function control(state, role, command) {
  check(['start', 'stop', 'restart'].includes(command), 'FIXTURE_CONTROL_INVALID');
  const name = container(state, role); owned(state, 'container', name);
  return docker([command, ...(command === 'start' ? [] : ['--timeout', '35']), name]);
}
function writeContainer(state, role, destination, content) {
  check(['/tmp/wp27-fixture/server.ext', '/tmp/wp27-fixture/remote-b.csr', '/tmp/wp27-fixture/server.crt',
    '/etc/nginx/conf.d/default.conf'].includes(destination), 'FIXTURE_PATH_INVALID');
  exec(state, role, ['bun', '-e', `require('node:fs').writeFileSync(${JSON.stringify(destination)},await Bun.stdin.text(),{mode:0o600});`], content);
}
function remember(state, secret) {
  if (typeof secret === 'string' && secret.length && !state.secrets.includes(secret)) state.secrets.push(secret);
}
function acceptAdminCookie(state, role, headers) {
  check(roles.includes(role), 'FIXTURE_ROLE_INVALID');
  const session = state.servers?.[role];
  check(session && Array.isArray(state.secrets), 'FIXTURE_STATE_INVALID');
  const cookies = headers['set-cookie'] ?? [];
  check(Array.isArray(cookies) && cookies.length <= 8
    && cookies.every(value => typeof value === 'string' && value.length <= 4096), 'FIXTURE_SESSION_COOKIE_INVALID');
  const matches = cookies.filter(value => value.startsWith('inker_admin_session='));
  if (!matches.length) return false;
  check(matches.length === 1, 'FIXTURE_SESSION_COOKIE_INVALID');
  const match = /^inker_admin_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(matches[0]);
  check(match, 'FIXTURE_SESSION_COOKIE_INVALID');
  const cookie = `inker_admin_session=${match[1]}`;
  if (session.cookie === cookie) return false;
  remember(state, match[1]); session.cookie = cookie;
  return true;
}
function sendsKnownAdminCookie(state, role, admin, headers) {
  check(roles.includes(role), 'FIXTURE_ROLE_INVALID');
  if (admin === true) return true;
  const known = state.servers?.[role]?.cookie;
  const explicit = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'cookie');
  return typeof known === 'string' && known.length > 0 && explicit.length === 1 && explicit[0][1] === known;
}
function save(state, first = false) {
  validate(state); fs.mkdirSync(temporary, { recursive: true });
  if (first) fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  else {
    const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    check(current.runId === state.runId, 'FIXTURE_STATE_OWNERSHIP_MISMATCH');
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  }
}
function load() { return validate(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
function newState() {
  check(!fs.existsSync(statePath), 'FIXTURE_ALREADY_EXISTS');
  const state = { version: 1, runId: randomBytes(8).toString('hex'), ready: false, servers: {}, remotes: {}, devices: {}, secrets: [] };
  for (const role of roles) { state.servers[role] = { password: randomBytes(24).toString('hex') }; remember(state, state.servers[role].password); }
  save(state, true); return state;
}
async function wait(predicate, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('FIXTURE_CONDITION_TIMEOUT');
}
function request(state, role, requestPath, { method = 'GET', data, admin = false, headers = {}, trustCA = true } = {}) {
  check(roles.includes(role), 'FIXTURE_ROLE_INVALID');
  owned(state, 'container', container(state, role));
  const secure = role !== 'home', bytes = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  const session = state.servers[role];
  // Capture the actual caller intent before asynchronous responses can rotate
  // the shared jar. CSRF-negative requests may send its cookie explicitly.
  const acceptCookie = sendsKnownAdminCookie(state, role, admin, headers);
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request({ hostname: '127.0.0.1', port: ports[role], path: requestPath,
      signal: AbortSignal.timeout(10000),
      method, agent: false, ...(secure ? { ca: trustCA ? state.ca : undefined, rejectUnauthorized: true } : {}),
      headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(admin ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...headers },
    }, response => {
      const chunks = []; let size = 0;
      response.on('error', reject);
      response.on('data', chunk => { size += chunk.length; if (size > 3 * 1024 * 1024) response.destroy(new Error('FIXTURE_HTTP_LIMIT')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          if (acceptCookie && acceptAdminCookie(state, role, response.headers)) save(state);
          resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('FIXTURE_HTTP_TIMEOUT'))); request.end(bytes);
  });
}
function json(response, wrapped = true) {
  check(response.bytes.length <= 256 * 1024, 'FIXTURE_JSON_LIMIT');
  const parsed = JSON.parse(response.bytes.toString('utf8')); return wrapped ? parsed.data : parsed;
}
async function login(state, role) {
  const response = await request(state, role, '/api/auth/login', { method: 'POST', data: { password: state.servers[role].password } });
  check(response.status === 200, 'FIXTURE_LOGIN_FAILED');
  const cookies = response.headers['set-cookie'];
  check(Array.isArray(cookies) && typeof response.headers['x-csrf-token'] === 'string', 'FIXTURE_SESSION_MISSING');
  const session = state.servers[role]; session.cookie = cookies[0].split(';')[0]; session.csrf = response.headers['x-csrf-token'];
  remember(state, session.cookie.split('=')[1]); remember(state, session.csrf); save(state);
}
function drainSource(expression) {
  return `const result=await (${expression});const bytes=Buffer.from(JSON.stringify(result));
    if(bytes.length>8*1024*1024)throw new Error('FIXTURE_OUTPUT_LIMIT');
    const {writeSync}=require('node:fs');const deadline=Date.now()+5000;
    for(let offset=0;offset<bytes.length;){if(Date.now()>deadline)throw new Error('FIXTURE_OUTPUT_TIMEOUT');
      try{offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}
      catch(e){if(e.code!=='EAGAIN')throw e;await new Promise(resolve=>setTimeout(resolve,1));}}`;
}
function db(state, role, expression, input = {}) {
  const source = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();const input=JSON.parse(await Bun.stdin.text());
    let value;try{value=await (${expression});}finally{await p.$disconnect();}${drainSource('value')}`;
  return JSON.parse(exec(state, role, ['bun', '-e', source], JSON.stringify(input)));
}
function createInfrastructure(state) {
  check(!inspect('network', network(state)), 'FIXTURE_RESOURCE_EXISTS');
  // An internal bridge on Docker Desktop suppresses published ports. Use an own
  // bridge with loopback-only published ports; all services/data still belong to this run.
  docker(['network', 'create', '--label', `${label}=${state.runId}`, network(state)]);
  for (const role of roles) {
    for (const mount of mounts) {
      const name = volume(state, role, mount); check(!inspect('volume', name), 'FIXTURE_RESOURCE_EXISTS');
      docker(['volume', 'create', '--label', `${label}=${state.runId}`, name]);
    }
    const mountArgs = mounts.flatMap(mount => ['--mount', `type=volume,source=${volume(state, role, mount)},destination=/app/${mount}`]);
    const envArgs = ['-e', 'ADMIN_PIN', '-e', 'THROTTLE_LIMIT=1000', '-e', 'FEDERATION_TRUSTED_PROXIES=127.0.0.1,::1'];
    if (role === 'home') envArgs.push('-e', 'PAIRING_ALLOW_INSECURE_HTTP=true', '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1',
      '-e', 'FEDERATION_ALLOWED_ORIGINS=https://remote-a,https://remote-b', '-e', 'FEDERATION_PRIVATE_ORIGINS=https://remote-a,https://remote-b',
      '-e', 'NODE_EXTRA_CA_CERTS=/tmp/remote-fixture-ca.crt');
    docker(['create', '--name', container(state, role), '--label', `${label}=${state.runId}`, '--network', network(state), '--network-alias', role,
      '-p', `127.0.0.1:${ports[role]}:${role === 'home' ? 80 : 443}`, ...envArgs, ...mountArgs, process.env.INKER_SMOKE_IMAGE || 'inker:wp27-test'], undefined, { ADMIN_PIN: state.servers[role].password });
  }
}
async function internalReady(state, role) {
  await wait(async () => { try { return exec(state, role, ['bun', '-e', "const r=await fetch('http://127.0.0.1:3002/ready',{signal:AbortSignal.timeout(1500)});process.stdout.write(String(r.status));"]).trim() === '200'; } catch { return false; } });
}
async function ready(state, role) {
  await wait(async () => { try { return (await request(state, role, '/ready')).status === 200; } catch { return false; } });
}
async function configureRemotes(state) {
  const directory = '/tmp/wp27-fixture';
  for (const role of ['remote-a', 'remote-b']) { control(state, role, 'start'); await internalReady(state, role); exec(state, role, ['mkdir', '-m', '700', directory]); }
  exec(state, 'remote-a', ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
    '-subj', '/CN=Inker WP27 disposable CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', `${directory}/ca.key`, '-out', `${directory}/ca.crt`]);
  state.ca = exec(state, 'remote-a', ['cat', `${directory}/ca.crt`]);
  for (const role of ['remote-a', 'remote-b']) {
    exec(state, role, ['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${role}`,
      '-keyout', `${directory}/server.key`, '-out', `${directory}/server.csr`]);
    const csr = exec(state, role, ['cat', `${directory}/server.csr`]);
    writeContainer(state, 'remote-a', `${directory}/remote-b.csr`, csr);
    writeContainer(state, 'remote-a', `${directory}/server.ext`, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${role},IP:127.0.0.1\n`);
    exec(state, 'remote-a', ['openssl', 'x509', '-req', '-in', `${directory}/remote-b.csr`, '-CA', `${directory}/ca.crt`, '-CAkey', `${directory}/ca.key`,
      '-CAcreateserial', '-days', '2', '-sha256', '-extfile', `${directory}/server.ext`, '-out', `${directory}/signed.crt`]);
    writeContainer(state, role, `${directory}/server.crt`, exec(state, 'remote-a', ['cat', `${directory}/signed.crt`]));
    exec(state, role, ['chmod', '600', `${directory}/server.key`]);
    const original = exec(state, role, ['cat', '/etc/nginx/conf.d/default.conf']);
    check((original.match(/listen 80;/g) || []).length === 1, 'FIXTURE_NGINX_LAYOUT');
    const logged = original.replace(/(location \^~ \/api\/federation\/\s*\{\s*)access_log off;/, '$1access_log /tmp/wp27-federation-status.log wp27_status;');
    check(logged !== original, 'FIXTURE_NGINX_LOG_LAYOUT');
    const configured = "log_format wp27_status '$status';\n" + logged.replace('listen 80;', `listen 80;\nlisten 443 ssl;\nssl_certificate ${directory}/server.crt;\nssl_certificate_key ${directory}/server.key;\nssl_protocols TLSv1.2 TLSv1.3;`);
    writeContainer(state, role, '/etc/nginx/conf.d/default.conf', configured);
    exec(state, role, ['nginx', '-t']); exec(state, role, ['nginx', '-s', 'reload']); await ready(state, role);
  }
  exec(state, 'remote-a', ['chmod', '600', `${directory}/ca.key`]);
  // Public CA only, copied into the stopped home container before Bun/worker initialization.
  owned(state, 'container', container(state, 'home'));
  docker(['cp', '-', `${container(state, 'home')}:/tmp`], caArchive(state.ca));
  save(state); control(state, 'home', 'start'); await ready(state, 'home');
}
function counter(state, role) {
  const source = `const fs=require('node:fs');const lines=fs.existsSync('/tmp/wp27-federation-status.log')?fs.readFileSync('/tmp/wp27-federation-status.log','utf8').trim().split(/\\s+/).filter(Boolean):[];
    if(lines.some(line=>!/^\\d{3}$/.test(line)))throw new Error('FIXTURE_COUNTER_INVALID');${drainSource("lines.reduce((counts,status)=>(counts[status]=(counts[status]||0)+1,counts),{})")}`;
  return JSON.parse(exec(state, role, ['bun', '-e', source]));
}
function assertStartupLogs(logs) {
  check(typeof logs === 'string' && !/\b(?:API_START_FAILED|WORKER_START_FAILED|P1008)\b/.test(logs), 'FIXTURE_BOOTSTRAP_FAILURE');
}
function audit(state) {
  for (const role of roles) {
    const name = container(state, role); owned(state, 'container', name);
    const logs = spawnSync('docker', ['logs', name], options); check(logs.status === 0, 'FIXTURE_LOG_READ_FAILED');
    const tables = db(state, role, `Promise.all([p.remoteSubscription.findMany(),p.remoteCredential.findMany(),p.remoteSyncJob.findMany(),
      p.shareCredential.findMany(),p.adminSession.findMany(),p.deviceCredential.findMany(),p.deviceEnrollment.findMany(),
      p.publicationRevision.findMany(),p.outboxEvent.findMany(),p.deviceLog.findMany()])`);
    const fileLogs = exec(state, role, ['bun', '-e', `const fs=require('node:fs');const paths=['/var/log/nginx/access.log','/var/log/nginx/error.log','/tmp/wp27-federation-status.log'];
      if(fs.existsSync('/app/logs'))for(const entry of fs.readdirSync('/app/logs',{withFileTypes:true}))if(entry.isFile())paths.push('/app/logs/'+entry.name);
      let size=0;const texts=[];for(const file of paths)if(fs.existsSync(file)&&fs.statSync(file).isFile()){
        size+=fs.statSync(file).size;if(size>4*1024*1024)throw new Error('FIXTURE_LOG_LIMIT');texts.push(fs.readFileSync(file,'utf8'));}
      ${drainSource('texts')}`]);
    // A supervisor retry must not turn a failed bootstrap into a passing gate.
    // Inspect only log text: arbitrary persisted fixture data is not evidence.
    assertStartupLogs([logs.stdout, logs.stderr, fileLogs].join('\n'));
    const output = [logs.stdout, logs.stderr, JSON.stringify(tables), fileLogs].join('\n');
    for (const secret of state.secrets) check(!output.includes(secret), 'FIXTURE_SECRET_LEAK');
  }
}
function cleanup(state) {
  validate(state); let failed = false;
  for (const role of roles) {
    const name = container(state, role);
    try {
      if (!owned(state, 'container', name, true)) continue;
      try { docker(['stop', '--timeout', '35', name]); } catch { /* Removal below still targets the verified owned container. */ }
      docker(['rm', '-f', '-v', name]);
    } catch { failed = true; }
  }
  for (const role of roles) for (const mount of mounts) {
    const name = volume(state, role, mount);
    try { if (owned(state, 'volume', name, true)) docker(['volume', 'rm', name]); } catch { failed = true; }
  }
  try { if (owned(state, 'network', network(state), true)) docker(['network', 'rm', network(state)]); } catch { failed = true; }
  check(!failed, 'FIXTURE_CLEANUP_FAILED');
  // Only these fixed/derived files under the known temporary root are removed; no recursive host operations.
  if (fs.existsSync(statePath)) { check(load().runId === state.runId, 'FIXTURE_STATE_OWNERSHIP_MISMATCH'); fs.unlinkSync(statePath); }
}

module.exports = { statePath, roles, container, check, exec, control, save, load, newState, wait, request, json, login,
  db, createInfrastructure, configureRemotes, ready, counter, audit, cleanup, remember, caArchive, acceptAdminCookie, sendsKnownAdminCookie, assertStartupLogs };
