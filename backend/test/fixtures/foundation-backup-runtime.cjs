// WP29 backup fixture infrastructure. All resource names derive from one random run ID.
const { execFileSync, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const statePath = path.join(root, '.tmp/wp29-backup-fixture-state.json');
const image = process.env.INKER_SMOKE_IMAGE;
const label = 'inker.wp29.backup';
const roles = ['source', 'restore', 'upgrade'];
const mounts = ['uploads', 'secrets', 'render-cache'];
const ports = { source: 18741, restore: 18742, upgrade: 18743 };
const options = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
function check(value, code) { if (!value) throw new Error(code); }
function prefix(state) { check(state?.version === 1 && /^[a-f0-9]{16}$/.test(state.id), 'BACKUP_STATE_INVALID'); return `inker-wp29-backup-${state.id}`; }
function container(state, role) { check(roles.includes(role) || /^tool-[0-9]{1,3}$/.test(role), 'BACKUP_ROLE_INVALID'); return `${prefix(state)}-${role}`; }
function volume(state, role, mount) {
  check((roles.includes(role) && mounts.includes(mount)) || (role === 'archive' && mount === 'data') || (role === 'missing' && mount === 'secrets'), 'BACKUP_VOLUME_INVALID');
  return `${prefix(state)}-${role}-${mount}`;
}
function docker(args, input, env) {
  try { return execFileSync('docker', args, { ...options, input, env: { ...process.env, ...env } }); }
  catch { throw new Error('BACKUP_DOCKER_FAILED'); }
}
function inspect(kind, name) {
  const result = spawnSync('docker', [kind, 'inspect', name], options);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  if (result.status === 1 && /No such (?:object|container|volume)|not found/i.test(String(result.stderr))) return null;
  throw new Error('BACKUP_INSPECT_FAILED');
}
function owned(state, kind, name, optional = false) {
  const valid = kind === 'container' ? state.containers : kind === 'volume' ? state.volumes : [];
  check(valid.includes(name) && name.startsWith(prefix(state) + '-'), 'BACKUP_RESOURCE_INVALID');
  const value = inspect(kind, name); if (!value && optional) return null;
  check(value && value.Name === (kind === 'container' ? '/' + name : name)
    && (kind === 'container' ? value.Config?.Labels : value.Labels)?.[label] === state.id, 'BACKUP_OWNERSHIP_MISMATCH');
  return value;
}
function save(state, first = false) {
  prefix(state);
  check(spawnSync('git', ['check-ignore', '--quiet', statePath], { ...options, cwd: root }).status === 0, 'BACKUP_STATE_NOT_IGNORED');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!first) check(load().id === state.id, 'BACKUP_STATE_CHANGED');
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600, flag: first ? 'wx' : 'w' });
}
function load() { const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); prefix(state); return state; }
function newState() {
  check(!fs.existsSync(statePath), 'BACKUP_ALREADY_EXISTS');
  check(typeof image === 'string' && image.length > 0, 'BACKUP_IMAGE_REQUIRED');
  check(/^(?:sha256:[a-f0-9]{64}|inker:[a-z0-9-]{1,80})$/.test(image), 'BACKUP_IMAGE_INVALID');
  docker(['image', 'inspect', image, '--format', '{{.Id}}']); // No implicit image pull.
  const state = { version: 1, id: randomBytes(8).toString('hex'), password: randomBytes(24).toString('hex'),
    containers: [], volumes: [], tools: 0, secrets: [] };
  state.secrets.push(state.password); save(state, true); return state;
}
function remember(state, secret) { if (typeof secret === 'string' && secret.length && !state.secrets.includes(secret)) state.secrets.push(secret); }
function noSecrets(state, value) { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const secret of state.secrets) check(!text.includes(secret), 'BACKUP_SECRET_LEAK'); }
function createVolume(state, role, mount) {
  const name = volume(state, role, mount); check(!inspect('volume', name), 'BACKUP_RESOURCE_EXISTS');
  state.volumes.push(name); save(state);
  docker(['volume', 'create', '--label', `${label}=${state.id}`, name]); return name;
}
function createSet(state, role) { for (const mount of mounts) createVolume(state, role, mount); }
function mount(state, role, target, readOnly = false) {
  const name = volume(state, role, target); owned(state, 'volume', name);
  return ['--mount', `type=volume,source=${name},destination=/app/${target}${readOnly ? ',readonly' : ''}`];
}
function createApp(state, role) {
  const name = container(state, role); check(!inspect('container', name), 'BACKUP_RESOURCE_EXISTS');
  state.containers.push(name); save(state);
  docker(['create', '--name', name, '--label', `${label}=${state.id}`, '--memory', '1536m', '--cpus', '2',
    '--log-driver', 'json-file', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '-p', `127.0.0.1:${ports[role]}:80`, '-e', 'ADMIN_PIN', '-e', 'PAIRING_ALLOW_INSECURE_HTTP=true',
    '-e', 'DEVICE_WS_TRUSTED_PROXIES=127.0.0.1,::1', '-e', 'THROTTLE_LIMIT=1000',
    ...mounts.flatMap(target => mount(state, role, target)), image], undefined, { ADMIN_PIN: state.password });
}
function control(state, role, action) {
  check(['start', 'stop'].includes(action), 'BACKUP_CONTROL_INVALID'); const name = container(state, role); owned(state, 'container', name);
  docker([action, ...(action === 'stop' ? ['--timeout', '35'] : []), name]);
}
function stopped(state, role) { check(owned(state, 'container', container(state, role)).State.Running === false, 'BACKUP_SOURCE_MUST_BE_STOPPED'); }
function exec(state, role, args, input) { const name = container(state, role); owned(state, 'container', name); return docker(['exec', '-i', name, ...args], input); }
function drain(expression) {
  return `const bytes=Buffer.from(JSON.stringify(${expression}));if(bytes.length>12*1024*1024)throw new Error('BACKUP_OUTPUT_LIMIT');
    const {writeSync}=require('node:fs');const deadline=Date.now()+5000;
    for(let n=0;n<bytes.length;){if(Date.now()>deadline)throw new Error('BACKUP_OUTPUT_TIMEOUT');
      try{n+=writeSync(1,bytes,n,Math.min(4096,bytes.length-n));}catch(e){if(e.code!=='EAGAIN')throw e;await Bun.sleep(1);}}`;
}
function db(state, role, expression, input = {}) {
  return JSON.parse(exec(state, role, ['bun', '-e', `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();const input=JSON.parse(await Bun.stdin.text());
    let result;try{result=await (${expression});}finally{await p.$disconnect();}${drain('result')}`], JSON.stringify(input)));
}
function tool(state, bindings, source, input = {}) {
  const role = `tool-${++state.tools}`, name = container(state, role); state.containers.push(name); save(state);
  const args = bindings.flatMap(({ role, mount: target, at, readOnly }) => {
    const name = volume(state, role, target); owned(state, 'volume', name);
    check(['/backup', '/original', '/app/uploads', '/app/secrets', '/app/render-cache'].includes(at), 'BACKUP_MOUNT_INVALID');
    return ['--mount', `type=volume,source=${name},destination=${at}${readOnly ? ',readonly' : ''}`];
  });
  // No services, no ports and no network in archive/migration helpers.
  const program = `const input=JSON.parse(await Bun.stdin.text());try{${source}}catch(error){
    const match=String(error?.message??'').match(/\\b(BACKUP_[A-Z_]{1,64})\\b/);
    console.error(match?.[1]??'BACKUP_HELPER_FAILED');process.exit(1);}`;
  docker(['create', '--name', name, '--label', `${label}=${state.id}`, '--network', 'none', '--memory', '768m', '--cpus', '1',
    '-i', ...args, '--entrypoint', 'bun', image, '-e', program]);
  owned(state, 'container', name);
  let result;
  try { result = execFileSync('docker', ['start', '-ai', name], { ...options, input: JSON.stringify(input) }); }
  catch (error) {
    // docker start -a can relay the helper's stderr through either captured
    // stream. Extract only the fixed diagnostic code, never raw archive or
    // process output that could contain fixture credentials.
    let captured = String(error?.stdout ?? '') + String(error?.stderr ?? '');
    try { captured += docker(['logs', name]); } catch {}
    const match = captured.match(/\b(BACKUP_[A-Z_]{1,64})\b/);
    throw new Error(match ? match[1] : 'BACKUP_HELPER_FAILED');
  }
  const exit = owned(state, 'container', name).State.ExitCode;
  check(exit === 0, 'BACKUP_HELPER_FAILED'); docker(['rm', name]); return result;
}
async function wait(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('BACKUP_CONDITION_TIMEOUT');
}
async function request(state, role, path, { method = 'GET', data, admin = false, headers = {} } = {}) {
  owned(state, 'container', container(state, role));
  const response = await fetch(`http://127.0.0.1:${ports[role]}${path}`, { method, signal: AbortSignal.timeout(10000),
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(admin ? { Cookie: state.cookie, 'X-CSRF-Token': state.csrf } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const bytes = Buffer.from(await response.arrayBuffer()); check(bytes.length <= 3 * 1024 * 1024, 'BACKUP_HTTP_LIMIT');
  if (admin) {
    // Match only the application's concrete session cookie, like a browser's
    // cookie jar. Authentication rotation is not a retry or a new login.
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
    for (const cookie of cookies) {
      const match = /^inker_admin_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookie);
      if (!match) continue;
      state.cookie = `inker_admin_session=${match[1]}`;
      remember(state, match[1]); save(state);
    }
  }
  if (response.status >= 400) {
    const surfaces = [
      ['readiness', /^\/ready$/], ['login', /^\/api\/auth\/login$/], ['devices', /^\/api\/devices$/],
      ['enrollment', /^\/api\/devices\/\d+\/enrollments$/], ['exchange', /^\/api\/device-enrollments\/exchange$/],
      ['source-create', /^\/api\/sources$/], ['source-refresh', /^\/api\/sources\/[^/]+\/refresh$/],
      ['publish', /^\/api\/publications\/[^/]+\/publish$/], ['interactions', /^\/api\/interactions$/],
      ['interaction-context', /^\/api\/interactions\/context$/], ['timers', /^\/api\/timers$/],
      ['presentation', /^\/api\/web-displays\/[^/]+\/presentation$/], ['artifact', /^\/api\/device-artifacts\//],
    ];
    state.lastHttpError = { surface: surfaces.find(([, pattern]) => pattern.test(path))?.[0] ?? 'other', status: response.status };
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
}
function json(response) { const value = JSON.parse(response.bytes.toString()); return value.data ?? value; }
async function ready(state, role) {
  await wait(async () => { try { return (await request(state, role, '/ready')).status === 200; } catch { return false; } });
  await wait(async () => {
    const response = await request(state, role, '/ready'); return response.status === 200 && json(response).background.status === 'ready';
  });
}
async function login(state, role) {
  const response = await request(state, role, '/api/auth/login', { method: 'POST', data: { password: state.password } });
  check(response.status === 200, 'BACKUP_LOGIN_FAILED'); state.cookie = response.headers['set-cookie'].split(';')[0]; state.csrf = response.headers['x-csrf-token'];
  remember(state, state.cookie.split('=')[1]); remember(state, state.csrf); save(state);
}
function audit(state, role) {
  const name = container(state, role); owned(state, 'container', name);
  // Read the complete bounded stream. A tail could discard an early bootstrap
  // failure or secret before a later supervisor retry reaches readiness.
  const result = spawnSync('docker', ['logs', name], options); check(result.status === 0, 'BACKUP_LOG_READ_FAILED');
  const logs = String(result.stdout) + String(result.stderr);
  noSecrets(state, logs);
  // s6 may restart a failed API or worker. Eventual readiness does not prove
  // that startup/restore succeeded without an intermediate fatal error.
  check(!/\b(?:API_START_FAILED|WORKER_START_FAILED|P1008)\b/.test(logs), 'BACKUP_BOOTSTRAP_FAILURE');
  noSecrets(state, db(state, role, `Promise.all([p.sourceSecret.findMany(),p.deviceCredential.findMany(),p.deviceEnrollment.findMany(),
    p.adminSession.findMany(),p.outboxEvent.findMany(),p.publicationRevision.findMany(),p.sourceSnapshot.findMany(),p.interactionReceipt.findMany()])`));
}
async function diagnose(state) {
  const markers = { storage: 'Preparing shared API/worker storage', security: 'Validating instance security',
    secretReady: 'Instance secret is ready', migrationStart: 'Applying versioned database migrations',
    migrationReady: 'Migrations applied; SQLite WAL', seedStart: 'Synchronizing reference data',
    initReady: 'Shared storage, migrations and reference data are ready',
    apiStart: 'Starting Inker API', workerStart: 'Starting Inker worker',
    secretFailed: 'Fatal instance secret setup error', migrationFailed: 'Fatal migration error' };
  for (const role of roles) {
    const name = container(state, role); if (!state.containers.includes(name)) continue;
    try {
      const value = owned(state, 'container', name, true); if (!value) continue;
      const result = spawnSync('docker', ['logs', '--tail', '3000', name], options);
      const logs = String(result.stdout) + String(result.stderr);
      const codes = [...new Set(logs.match(/\b(?:P[0-9]{4}|SQLITE_(?:BUSY|LOCKED|READONLY|CORRUPT|ERROR)|API_START_FAILED|WORKER_START_FAILED|REQUEST_FAILED)\b/g) ?? [])].slice(0, 12);
      let readyStatus = null, requestError = null, internalStatus = null;
      if (value.State.Running) {
        try { readyStatus = (await request(state, role, '/ready')).status; }
        catch (error) {
          const allowed = ['ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR',
            'BACKUP_INSPECT_FAILED', 'BACKUP_OWNERSHIP_MISMATCH', 'BACKUP_RESOURCE_INVALID', 'BACKUP_HTTP_LIMIT'];
          requestError = allowed.find(code => [error?.code, error?.cause?.code, error?.message].includes(code)) ?? 'OTHER';
        }
        try {
          internalStatus = JSON.parse(exec(state, role, ['bun', '-e', `const result={};for(const port of [80,3002]){
            try{result[port]=(await fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(2000)})).status;}
            catch{result[port]=null;}}console.log(JSON.stringify(result));`]));
        } catch { /* No raw diagnostic error. */ }
      }
      const mapping = value.NetworkSettings?.Ports?.['80/tcp'];
      const correctBinding = Array.isArray(mapping) && mapping.some(item => item.HostIp === '127.0.0.1' && item.HostPort === String(ports[role]));
      console.error(JSON.stringify({ diagnostic: 'BACKUP_STARTUP_STATE', role, running: value.State.Running,
        exitCode: value.State.ExitCode, oomKilled: value.State.OOMKilled, readyStatus, requestError, internalStatus, correctBinding,
        stages: Object.fromEntries(Object.entries(markers).map(([key, text]) => [key, logs.includes(text)])), codes, lastHttpError: state.lastHttpError ?? null }));
    } catch { console.error(JSON.stringify({ diagnostic: 'BACKUP_DIAGNOSTIC_UNAVAILABLE', role })); }
  }
}
function cleanup(state) {
  let failed = false;
  for (const name of [...state.containers].reverse()) try {
    if (!owned(state, 'container', name, true)) continue;
    try { docker(['stop', '--timeout', '35', name]); } catch { /* Force removal still requires the own name/label. */ }
    owned(state, 'container', name); docker(['rm', '-f', '-v', name]);
  } catch { failed = true; }
  for (const name of [...state.volumes].reverse()) try { if (owned(state, 'volume', name, true)) docker(['volume', 'rm', name]); } catch { failed = true; }
  check(!failed, 'BACKUP_CLEANUP_FAILED');
  check(load().id === state.id, 'BACKUP_STATE_CHANGED'); fs.unlinkSync(statePath);
}
module.exports = { statePath, image, roles, mounts, ports, check, container, volume, save, load, newState, remember, noSecrets,
  createVolume, createSet, createApp, control, stopped, exec, drain, db, tool, wait, request, json, ready, login, audit, diagnose, cleanup };
