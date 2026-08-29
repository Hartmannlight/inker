// Reuse the owned three-server TLS fixture. No production data or services are adopted.
const { execFile } = require('node:child_process');
const http = require('node:http');
const runtime = require('./remote-fixture-runtime.cjs');
const { check } = runtime;
const base = 'http://127.0.0.1:18728';
const options = { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 };
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, options, (error, stdout) => error
      ? reject(new Error('FOUNDATION_DOCKER_FAILED')) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function owned(state, role = 'home') {
  const name = runtime.container(state, role);
  const value = JSON.parse(await docker(['container', 'inspect', name]))[0];
  check(value?.Name === `/${name}` && value.Config?.Labels?.['inker.wp27.fixture'] === state.runId, 'FOUNDATION_OWNERSHIP_MISMATCH');
  return name;
}
async function exec(state, args, input, role = 'home') {
  const name = await owned(state, role); return docker(['exec', '-i', name, ...args], input);
}
async function control(state, role, up) {
  check(['remote-a', 'remote-b'].includes(role) && typeof up === 'boolean', 'FOUNDATION_CONTROL_INVALID');
  const name = await owned(state, role);
  return docker([up ? 'start' : 'stop', ...(up ? [] : ['--timeout', '35']), name]);
}
async function service(state, name, up) {
  check(['worker', 'redis'].includes(name) && typeof up === 'boolean', 'FOUNDATION_SERVICE_INVALID');
  await exec(state, ['/command/s6-svc', up ? '-u' : '-d', `/run/service/${name}`]);
  await exec(state, ['/command/s6-svwait', up ? '-u' : '-d', '-t', '35000', `/run/service/${name}`]);
}
async function resources(state) {
  const name = await owned(state);
  await docker(['update', '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2', name]);
  const value = JSON.parse(await docker(['container', 'inspect', name]))[0];
  check(value.HostConfig.Memory === 1536 * 1024 * 1024 && value.HostConfig.NanoCpus === 2e9, 'FOUNDATION_LIMITS_MISSING');
  return { image: value.Image, memoryLimitBytes: value.HostConfig.Memory, cpus: 2 };
}
function noSecrets(state, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of state.secrets) check(!text.includes(secret), 'FOUNDATION_SECRET_LEAK');
}
// Ownership is checked at phase boundaries, not by spawning Docker for each HTTP sample.
// That keeps host CLI startup outside the measured request latency and heartbeat loop.
function acceptAdminCookie(state, headers) {
  return runtime.acceptAdminCookie(state, 'home', headers);
}
function request(state, requestPath, { method = 'GET', data, admin = false, headers = {}, timeoutMs = 10000 } = {}) {
  check(requestPath.startsWith('/') && !requestPath.startsWith('//'), 'FOUNDATION_PATH_INVALID');
  check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10000, 'FOUNDATION_HTTP_TIMEOUT_INVALID');
  const bytes = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  const acceptCookie = runtime.sendsKnownAdminCookie(state, 'home', admin, headers);
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 18728, path: requestPath, method, agent: false,
      signal: AbortSignal.timeout(timeoutMs), headers: {
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(admin ? { Cookie: state.servers.home.cookie, 'X-CSRF-Token': state.servers.home.csrf } : {}), ...headers,
      } }, response => {
      let size = 0; const chunks = [];
      response.on('error', () => reject(new Error('FOUNDATION_HTTP_FAILED')));
      response.on('data', chunk => { size += chunk.length; if (size > 3 * 1024 * 1024) response.destroy(new Error('FOUNDATION_HTTP_LIMIT')); else chunks.push(chunk); });
      response.on('end', () => {
        const durationMs = performance.now() - start;
        try {
          if (acceptCookie && acceptAdminCookie(state, response.headers)) runtime.save(state);
          resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), durationMs });
        } catch { reject(new Error('FOUNDATION_SESSION_COOKIE_INVALID')); }
      });
    });
    req.on('error', () => reject(new Error('FOUNDATION_HTTP_FAILED'))); req.end(bytes);
  });
}
function json(response) {
  check(response.bytes.length <= 512 * 1024, 'FOUNDATION_JSON_LIMIT');
  const result = JSON.parse(response.bytes.toString('utf8')); return result.data ?? result;
}
async function db(state, expression, input = {}) {
  const code = `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();const input=JSON.parse(await Bun.stdin.text());
    let result;try{result=await (${expression});}finally{await p.$disconnect();}
    const bytes=Buffer.from(JSON.stringify(result));if(bytes.length>8*1024*1024)throw new Error('FOUNDATION_OUTPUT_LIMIT');
    const {writeSync}=require('node:fs');const end=Date.now()+5000;
    for(let offset=0;offset<bytes.length;){if(Date.now()>end)throw new Error('FOUNDATION_OUTPUT_TIMEOUT');
      try{offset+=writeSync(1,bytes,offset,Math.min(4096,bytes.length-offset));}
      catch(e){if(e.code!=='EAGAIN')throw e;await new Promise(r=>setTimeout(r,1));}}`;
  return JSON.parse(await exec(state, ['bun', '-e', code], JSON.stringify(input)));
}
async function memory(state) {
  return JSON.parse(await exec(state, ['bun', '-e', `const fs=require('node:fs');
    const value=Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8'));
    const peak=Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8'));
    const events=Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/memory.events','utf8').trim().split(String.fromCharCode(10)).map(x=>x.split(' ')));
    console.log(JSON.stringify({bytes:value,peakBytes:peak,oomKills:Number(events.oom_kill)}));`]));
}
async function workerEvents(state) {
  const rows = await db(state, `(async()=>{const fs=require('node:fs');const rows=[];let size=0;
    for(const name of fs.readdirSync('/app/logs'))if(/^worker-.*[.]log$/.test(name)){
      const file='/app/logs/'+name;size+=fs.statSync(file).size;
      if(size>8*1024*1024)throw new Error('FOUNDATION_LOG_LIMIT');
      for(const line of fs.readFileSync(file,'utf8').split(String.fromCharCode(10)).filter(Boolean)){
        const row=JSON.parse(line);
        if(['JOB_STARTED','JOB_COMPLETED','JOB_FAILED','JOB_STALE'].includes(row.code))
          rows.push({code:row.code,queue:row.queue,eventId:row.eventId,sourceDefinitionId:row.sourceDefinitionId,
            timestamp:row.timestamp,attempt:row.attempt});
      }
    }return rows;})()`);
  noSecrets(state, rows); return rows;
}
async function wait(predicate, milliseconds = 90000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('FOUNDATION_CONDITION_TIMEOUT');
}
module.exports = { base, docker, owned, exec, control, service, resources, noSecrets, acceptAdminCookie, request, json, db, memory, workerEvents, wait };
