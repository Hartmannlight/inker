// WP28 disposable infrastructure. Never adopts a container, volume, network or database.
const { execFileSync, execFile, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '../../..');
const statePath = path.join(root, '.tmp/wp28-operations-fixture-state.json');
const base = 'http://127.0.0.1:18731';
const label = 'inker.wp28.fixture';
const mounts = ['uploads', 'secrets', 'render-cache'];
const options = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000, windowsHide: true, maxBuffer: 12 * 1024 * 1024 };
function check(value, code) { if (!value) throw new Error(code); }
function validate(state) {
  check(state && state.version === 1 && /^[a-f0-9]{16}$/.test(state.runId)
    && typeof state.password === 'string' && /^[a-f0-9]{48}$/.test(state.password)
    && Array.isArray(state.secrets) && state.secrets.every(value => typeof value === 'string' && value.length > 0), 'FIXTURE_STATE_INVALID');
  return state;
}
function prefix(state) { validate(state); return `inker-wp28-${state.runId}`; }
function container(state) { return `${prefix(state)}-home`; }
function network(state) { return `${prefix(state)}-network`; }
function volume(state, mount) { check(mounts.includes(mount), 'FIXTURE_VOLUME_INVALID'); return `${prefix(state)}-${mount}`; }
function docker(args, input, env) {
  try { return execFileSync('docker', args, { ...options, input, env: { ...process.env, ...env } }); }
  catch { throw new Error('FIXTURE_DOCKER_COMMAND_FAILED'); }
}
function dockerAsync(args) {
  return new Promise((resolve, reject) => execFile('docker', args, options,
    (error, stdout) => error ? reject(new Error('FIXTURE_DOCKER_COMMAND_FAILED')) : resolve(stdout)));
}
function inspect(kind, name) {
  const result = spawnSync('docker', [kind, 'inspect', name], options);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  if (result.status === 1 && /No such (?:object|container|network|volume)|not found/i.test(String(result.stderr))) return null;
  throw new Error('FIXTURE_DOCKER_INSPECTION_FAILED');
}
function owned(state, kind, name, optional = false) {
  const names = kind === 'container' ? [container(state)] : kind === 'network' ? [network(state)]
    : kind === 'volume' ? mounts.map(mount => volume(state, mount)) : [];
  check(names.includes(name), 'FIXTURE_RESOURCE_INVALID');
  const value = inspect(kind, name);
  if (!value && optional) return null;
  check(value && (kind === 'container' ? value.Config?.Labels : value.Labels)?.[label] === state.runId
    && value.Name === (kind === 'container' ? `/${name}` : name), 'FIXTURE_OWNERSHIP_MISMATCH');
  return value;
}
function exec(state, args, input) {
  const name = container(state); owned(state, 'container', name);
  return docker(['exec', '-i', name, ...args], input);
}
function remember(state, value) { if (typeof value === 'string' && value.length && !state.secrets.includes(value)) state.secrets.push(value); }
function save(state, first = false) {
  validate(state);
  check(spawnSync('git', ['check-ignore', '--quiet', statePath], { ...options, cwd: root }).status === 0, 'FIXTURE_STATE_NOT_IGNORED');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!first) check(load().runId === state.runId, 'FIXTURE_STATE_OWNERSHIP_MISMATCH');
  fs.writeFileSync(statePath, JSON.stringify(state), { flag: first ? 'wx' : 'w', mode: 0o600 });
}
function load() { return validate(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
function newState() {
  check(!fs.existsSync(statePath), 'FIXTURE_ALREADY_EXISTS');
  const image = process.env.INKER_SMOKE_IMAGE || 'inker:wp28-test';
  check(/^(?:sha256:[a-f0-9]{64}|inker:wp28-test)$/.test(image), 'FIXTURE_IMAGE_INVALID');
  const state = { version: 1, runId: randomBytes(8).toString('hex'), password: randomBytes(24).toString('hex'), secrets: [], ready: false, image };
  remember(state, state.password); save(state, true); return state;
}
async function wait(predicate, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('FIXTURE_CONDITION_TIMEOUT');
}
function request(state, requestPath, { method = 'GET', data, admin = false, headers = {} } = {}) {
  validate(state); check(typeof requestPath === 'string' && requestPath.startsWith('/') && !requestPath.startsWith('//'), 'FIXTURE_HTTP_PATH_INVALID');
  owned(state, 'container', container(state));
  const bytes = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 18731, path: requestPath, method, agent: false,
      signal: AbortSignal.timeout(10000), headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(admin ? { Cookie: state.cookie, 'X-CSRF-Token': state.csrf } : {}), ...headers } }, response => {
      const chunks = []; let size = 0;
      response.on('error', () => reject(new Error('FIXTURE_HTTP_FAILED')));
      response.on('data', chunk => { size += chunk.length; if (size > 3 * 1024 * 1024) response.destroy(new Error('FIXTURE_HTTP_LIMIT')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', () => reject(new Error('FIXTURE_HTTP_FAILED')));
    req.setTimeout(10000, () => req.destroy(new Error('FIXTURE_HTTP_TIMEOUT'))); req.end(bytes);
  });
}
function json(response) {
  check(response.bytes.length <= 256 * 1024, 'FIXTURE_JSON_LIMIT');
  const parsed = JSON.parse(response.bytes.toString('utf8')); return parsed.data ?? parsed;
}
async function login(state) {
  const response = await request(state, '/api/auth/login', { method: 'POST', data: { password: state.password } });
  check(response.status === 200, 'FIXTURE_LOGIN_FAILED');
  check(Array.isArray(response.headers['set-cookie']) && typeof response.headers['x-csrf-token'] === 'string', 'FIXTURE_SESSION_MISSING');
  state.cookie = response.headers['set-cookie'][0].split(';')[0]; state.csrf = response.headers['x-csrf-token'];
  remember(state, state.cookie.split('=')[1]); remember(state, state.csrf); save(state);
}
function drain(expression) {
  return `const bytes=Buffer.from(JSON.stringify(${expression}));if(bytes.length>8*1024*1024)throw new Error('FIXTURE_OUTPUT_LIMIT');
    const {writeSync}=require('node:fs');const deadline=Date.now()+5000;
    for(let offset=0;offset<bytes.length;){if(Date.now()>deadline)throw new Error('FIXTURE_OUTPUT_TIMEOUT');
      try{offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}
      catch(e){if(e.code!=='EAGAIN')throw e;await new Promise(resolve=>setTimeout(resolve,1));}}`;
}
function db(state, expression, input = {}) {
  const source = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();const input=JSON.parse(await Bun.stdin.text());
    let value;try{value=await (${expression});}finally{await p.$disconnect();}${drain('value')}`;
  return JSON.parse(exec(state, ['bun', '-e', source], JSON.stringify(input)));
}
function createInfrastructure(state) {
  check(/^(?:sha256:[a-f0-9]{64}|inker:wp28-test)$/.test(state.image), 'FIXTURE_IMAGE_INVALID');
  check(!inspect('container', container(state)) && !inspect('network', network(state)), 'FIXTURE_RESOURCE_EXISTS');
  docker(['network', 'create', '--label', `${label}=${state.runId}`, network(state)]);
  for (const mount of mounts) {
    const name = volume(state, mount); check(!inspect('volume', name), 'FIXTURE_RESOURCE_EXISTS');
    docker(['volume', 'create', '--label', `${label}=${state.runId}`, name]);
  }
  // Test-generated ADMIN_PIN goes through the child environment, never a command argument.
  docker(['create', '--name', container(state), '--label', `${label}=${state.runId}`, '--network', network(state),
    '--memory', '1536m', '--cpus', '2', '--log-driver', 'json-file', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=3',
    '-p', '127.0.0.1:18731:80', '-e', 'ADMIN_PIN', '-e', 'THROTTLE_LIMIT=1000', '-e', 'LOG_FORMAT=json',
    '-e', 'PAIRING_ALLOW_INSECURE_HTTP=true', '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1',
    ...mounts.flatMap(mount => ['--mount', `type=volume,source=${volume(state, mount)},destination=/app/${mount}`]),
    state.image], undefined, { ADMIN_PIN: state.password });
  owned(state, 'container', container(state)); docker(['start', container(state)]);
}
async function ready(state) {
  await wait(async () => { try { return (await request(state, '/ready')).status === 200; } catch { return false; } });
}
async function service(state, name, up) {
  check(['worker', 'redis'].includes(name) && typeof up === 'boolean', 'FIXTURE_SERVICE_INVALID');
  const target = container(state); owned(state, 'container', target);
  await dockerAsync(['exec', target, '/command/s6-svc', up ? '-u' : '-d', `/run/service/${name}`]);
  await dockerAsync(['exec', target, '/command/s6-svwait', up ? '-u' : '-d', '-t', '35000', `/run/service/${name}`]);
  if (!up && name === 'worker') check(exec(state, ['/command/s6-svstat', '-o', 'up,exitcode,signal', '/run/service/worker']).trim() === 'false 0 NA', 'FIXTURE_WORKER_NOT_CLEANLY_STOPPED');
}
function noSecrets(state, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of state.secrets) check(!text.includes(secret), 'FIXTURE_SECRET_LEAK');
}
function logs(state) {
  const source = `const fs=require('node:fs');const texts={};let size=0;
    const paths=['/var/log/nginx/access.log','/var/log/nginx/error.log'];
    if(fs.existsSync('/app/logs'))for(const entry of fs.readdirSync('/app/logs',{withFileTypes:true}))if(entry.isFile())paths.push('/app/logs/'+entry.name);
    for(const file of paths)if(fs.existsSync(file)&&fs.statSync(file).isFile()){
      size+=fs.statSync(file).size;if(size>6*1024*1024)throw new Error('FIXTURE_LOG_LIMIT');texts[file]=fs.readFileSync(file,'utf8');}
    ${drain('texts')}`;
  const files = JSON.parse(exec(state, ['bun', '-e', source])); noSecrets(state, files);
  const rows = [];
  for (const [file, text] of Object.entries(files)) if (/\/app\/logs\/(?:api|worker)-.*\.log$/.test(file)) {
    for (const line of text.split('\n').filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { throw new Error('FIXTURE_LOG_NOT_JSON'); }
      check(row && typeof row.code === 'string' && typeof row.level === 'string' && ['api', 'worker'].includes(row.role), 'FIXTURE_LOG_SCHEMA_INVALID');
      rows.push(row);
    }
  }
  check(rows.length > 0, 'FIXTURE_LOGS_MISSING'); return rows;
}
function audit(state) {
  owned(state, 'container', container(state));
  // A tail could hide an early bootstrap failure or secret before recovery.
  // maxBuffer bounds the complete log stream and overflow fails closed below.
  const output = spawnSync('docker', ['logs', container(state)], options);
  check(output.status === 0, 'FIXTURE_LOG_READ_FAILED');
  const containerLogs = String(output.stdout) + String(output.stderr); noSecrets(state, containerLogs);
  check(!/\b(?:API_START_FAILED|WORKER_START_FAILED|P1008)\b/.test(containerLogs), 'FIXTURE_BOOTSTRAP_FAILURE');
  logs(state);
  const tables = db(state, `Promise.all([p.sourceSecret.findMany(),p.sourceDefinition.findMany(),p.sourceSnapshot.findMany(),
    p.sourceRefreshJob.findMany(),p.adminSession.findMany(),p.deviceCredential.findMany(),p.deviceEnrollment.findMany(),
    p.publicationRevision.findMany(),p.outboxEvent.findMany(),p.deviceLog.findMany()])`);
  noSecrets(state, tables);
}
async function cleanup(state) {
  validate(state); let failed = false;
  try {
    if (owned(state, 'container', container(state), true)) {
      try { await dockerAsync(['stop', '--timeout', '35', container(state)]); } catch { /* Verified owned name only; force removal below. */ }
      owned(state, 'container', container(state)); docker(['rm', '-f', '-v', container(state)]);
    }
  } catch { failed = true; }
  for (const mount of mounts) {
    const name = volume(state, mount);
    try { if (owned(state, 'volume', name, true)) docker(['volume', 'rm', name]); } catch { failed = true; }
  }
  try { if (owned(state, 'network', network(state), true)) docker(['network', 'rm', network(state)]); } catch { failed = true; }
  check(!failed, 'FIXTURE_CLEANUP_FAILED');
  if (fs.existsSync(statePath)) { check(load().runId === state.runId, 'FIXTURE_STATE_OWNERSHIP_MISMATCH'); fs.unlinkSync(statePath); }
}
module.exports = { statePath, base, check, validate, container, network, volume, exec, save, load, newState, wait,
  request, json, login, db, createInfrastructure, ready, service, remember, noSecrets, logs, audit, cleanup };
