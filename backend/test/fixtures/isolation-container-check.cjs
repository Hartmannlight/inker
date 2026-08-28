const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');

// All faults target only children inside the smoke runner's unique container.
module.exports = async function checkIsolation({ request, db, until, secrets, base, device, credential, setStage, login }) {
  setStage('WP22 packaged Liquid runtime');
  const liquid = db(`const {spawnSync}=require('node:child_process');
    const run=spawnSync(process.execPath,['--no-env-file','/app/dist/isolation-child.js'],{cwd:'/app/dist',env:{},input:JSON.stringify(input),encoding:'utf8',timeout:3000,maxBuffer:524288});
    if(run.status!==0)throw new Error('ISOLATION_CHILD_FAILED');console.log(run.stdout);`,
    { version: 1, kind: 'liquid', code: '<h1>{{ title | escape }}</h1>{{ 1234.5 | number_to_currency }}', data: { title: '<safe>' } });
  assert.deepEqual(liquid, { version: 1, ok: true, value: '<h1>&lt;safe&gt;</h1>$1,234.50' });
  setStage('WP22 real source transformation');
  const secret = randomBytes(32).toString('hex'); secrets.push(secret);
  const input = { protocolVersion: '1.0', name: 'WP22 isolated transformation', connectorType: 'fixture', schemaVersion: '1',
    configuration: { data: { value: 7 } }, secret, refreshIntervalSeconds: 3600, timeoutMs: 2000,
    concurrencyGroup: 'wp22-fixture', transformationCode: 'return {value: $.value * 2};' };
  const created = await request('/api/sources', { method: 'POST', admin: true, data: input });
  assert.equal(created.response.status, 201);
  const id = created.body.definition.sourceDefinitionId;
  let source;
  async function read() {
    const result = await request(`/api/sources/${id}`, { admin: true });
    assert.equal(result.response.status, 200); assert.equal(result.text.includes(secret), false);
    source = result.body; return source;
  }
  await until(async () => (await read()).snapshot?.freshness.state === 'fresh');
  const good = source.snapshot;
  assert.deepEqual(good.data, { value: 14 });
  assert.ok(good.connectorVersion.endsWith('+pure-js-v1'));
  const { secret: _secret, ...withoutSecret } = input;
  async function change(code) {
    const result = await request(`/api/sources/${id}`, { method: 'PUT', admin: true,
      data: { ...withoutSecret, expectedDefinitionVersion: source.definition.definitionVersion, transformationCode: code } });
    assert.equal(result.response.status, 200);
    return result.body.definition.definitionVersion;
  }
  for (const [label, code, expected] of [
    ['CPU loop', 'while(true){}', 'SOURCE_TIMEOUT'],
    ['memory pressure', 'const a=[]; for(let i=0;i<2000;i++)a.push(new Array(10000).fill(i)); return a.length;', 'SOURCE_TRANSFORM_FAILED'],
    ['token exfiltration', 'return globalThis["pro"+"cess"].env.PROVIDER_REFRESH_TOKEN;', 'SOURCE_TRANSFORM_FAILED'],
  ]) {
    setStage(`WP22 source ${label} and last-good fallback`);
    const version = await change(code);
    await until(async () => { await read(); return source.snapshot?.definitionVersion === version && source.snapshot?.error?.code === expected; });
    assert.equal(source.snapshot.freshness.state, 'stale');
    assert.deepEqual(source.snapshot.data, good.data);
    assert.deepEqual(db('console.log(JSON.stringify((await p.sourceSnapshot.findUniqueOrThrow({where:{snapshotId:input.id}})).data));', { id: good.snapshotId }), good.data);
  }
  setStage('WP22 source recovery');
  const version = await change('return {value: $.value * 3};');
  await until(async () => { await read(); return source.snapshot?.definitionVersion === version && source.snapshot.freshness.state === 'fresh'; });
  assert.deepEqual(source.snapshot.data, { value: 21 });

  setStage('WP22 corrupt credential disable and repair without public edits');
  db(`const source=await p.sourceDefinition.findUniqueOrThrow({where:{sourceDefinitionId:input.id}});
    await p.sourceSecret.update({where:{id:source.secretId},data:{ciphertext:'invalid-encrypted-format'}});console.log('true');`, { id });
  const repairInput = { ...withoutSecret, transformationCode: 'return {value: $.value * 3};' };
  const disabled = await request(`/api/sources/${id}`, { method: 'PUT', admin: true,
    data: { ...repairInput, expectedDefinitionVersion: version, enabled: false } });
  assert.equal(disabled.response.status, 200); assert.equal(disabled.body.eventId, null);
  const replacement = randomBytes(32).toString('hex'); secrets.push(replacement);
  const repaired = await request(`/api/sources/${id}`, { method: 'PUT', admin: true,
    data: { ...repairInput, expectedDefinitionVersion: version + 1, enabled: true, secret: replacement } });
  assert.equal(repaired.response.status, 200); assert.equal(repaired.text.includes(replacement), false);
  await until(async () => { await read(); return source.snapshot?.definitionVersion === version + 2 && source.snapshot.freshness.state === 'fresh'; });
  assert.deepEqual(source.snapshot.data, { value: 21 });

  setStage('WP22 hard parent deadline independent of guest interrupt');
  const dataSource = db(`console.log(JSON.stringify(await p.dataSource.create({data:{name:'WP22 persisted fixture',type:'json',url:'https://example.invalid/never-fetch',lastData:{value:7},lastFetchedAt:new Date()}})));`);
  const widget = await request('/api/custom-widgets', { method: 'POST', admin: true, data: {
    name: 'WP22 adversarial fixture', dataSourceId: dataSource.id, displayType: 'script',
    config: { scriptCode: 'while(true){}', scriptOutputMode: 'value' },
  } });
  assert.equal(widget.response.status, 201);
  const manifestPath = `/api/web-displays/${device.externalId}/presentation`, headers = { Authorization: `Bearer ${credential}` };
  const before = (await request(manifestPath, { headers })).body;
  const baseline = Buffer.from(await (await fetch(base + before.content.url, { headers })).arrayBuffer());
  const hash = createHash('sha256').update(baseline).digest('hex');
  const childPids = (stop = false) => db(`const fs=require('node:fs'); const pids=[];
    for(const item of fs.readdirSync('/proc')) { if(!/^\\d+$/.test(item))continue;
      try { const args=fs.readFileSync('/proc/'+item+'/cmdline','utf8').split('\\0');
        if(args.includes('/app/dist/isolation-child.js')) {pids.push(Number(item)); if(input.stop)process.kill(Number(item),'SIGSTOP');}
      } catch {} }
    console.log(JSON.stringify(pids));`, { stop });
  await until(() => childPids().length === 0);
  const started = performance.now();
  const blocked = request(`/api/custom-widgets/${widget.body.id}/preview`, { admin: true });
  let frozen = [];
  await until(() => { frozen = childPids(true); return frozen.length === 1; }, 20);
  const loginStart = performance.now(); assert.equal((await login()).response.status, 200);
  const loginMs = performance.now() - loginStart; assert.ok(loginMs < 1000);
  const durations = await Promise.all(Array.from({ length: 20 }, async () => {
    const start = performance.now();
    assert.deepEqual((await request(manifestPath, { headers })).body, before);
    const bytes = Buffer.from(await (await fetch(base + before.content.url, { headers })).arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    return performance.now() - start;
  }));
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * .95) - 1]; assert.ok(p95 < 1000);
  const failure = await blocked;
  assert.equal(failure.response.status, 503);
  const elapsed = performance.now() - started; assert.ok(elapsed >= 2400 && elapsed < 5000);
  assert.equal(childPids().length, 0);
  assert.equal(db('console.log(JSON.stringify(input.pids.some(pid=>require("node:fs").existsSync("/proc/"+pid))));', { pids: frozen }), false);
  setStage('WP22 API recovery after actual child kill');
  assert.equal((await request(`/api/custom-widgets/${widget.body.id}`, { method: 'PATCH', admin: true,
    data: { config: { scriptCode: 'return $.value * 3;', scriptOutputMode: 'value' } } })).response.status, 200);
  const recovery = await request(`/api/custom-widgets/${widget.body.id}/preview`, { admin: true });
  assert.equal(recovery.response.status, 200); assert.equal(recovery.body.renderedContent, '21');
  assert.equal(childPids().length, 0);
  console.info(`WP-22 actual CPU/memory/exfiltration failures, stale snapshot and recovery, SIGSTOP -> parent kill ${elapsed.toFixed(1)}ms, no remaining child, login ${loginMs.toFixed(1)}ms and 20 API/artifact reads p95 ${p95.toFixed(1)}ms passed`);
};
