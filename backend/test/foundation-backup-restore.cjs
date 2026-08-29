// node backend/test/foundation-backup-restore.cjs [cleanup]
// Real stopped three-volume backup, restored application and predecessor migration.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const r = require('./fixtures/foundation-backup-runtime.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MISSING_SECRET_REFUSAL = 'Fatal instance secret setup error: The instance secret is missing for an existing database; restore the matching secret backup';
function isExpectedMissingSecretRefusal(exitCode, stderr, expected = MISSING_SECRET_REFUSAL) {
  return exitCode === 1 && Buffer.from(stderr).toString('utf8').trim() === expected;
}
let stage = 'initialization';
function phase(value) { stage = value; console.log(`WP29 backup: ${value}`); }
const bindSet = (role, readOnly = false) => r.mounts.map(mount => ({ role, mount, at: `/app/${mount}`, readOnly }));
const archiveBinding = readOnly => ({ role: 'archive', mount: 'data', at: '/backup', readOnly });

// This trusted offline helper has no network or app services. Key material never
// leaves its volume; only hashes, counts and the non-secret key ID are returned.
async function archives() {
  const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const names = ['uploads', 'secrets', 'render-cache'];
  const digest = value => createHash('sha256').update(value).digest('hex');
  const check = value => { if (!value) throw new Error('BACKUP_ARCHIVE_INVALID'); };
  function files(directory) {
    const rows = []; let size = 0;
    function visit(relative) {
      const target = path.join(directory, relative), stat = fs.lstatSync(target);
      check(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()));
      if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
      else {
        size += stat.size; check(size <= 64 * 1024 * 1024 && rows.length < 5000);
        rows.push({ path: relative, size: stat.size, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, sha256: digest(fs.readFileSync(target)) });
      }
    }
    visit(''); return rows;
  }
  if (input.operation === 'backup') {
    const inventory = { version: 1, image: input.image, archives: {}, files: {}, keyId: JSON.parse(fs.readFileSync('/app/secrets/instance.json', 'utf8')).keyId };
    for (const name of names) {
      inventory.files[name] = files(`/app/${name}`);
      const target = `/backup/${name}.tar`;
      execFileSync('tar', ['--numeric-owner', '-cpf', target, '-C', `/app/${name}`, '.']); fs.chmodSync(target, 0o600);
      const bytes = fs.readFileSync(target); inventory.archives[name] = { size: bytes.length, sha256: digest(bytes) };
    }
    fs.writeFileSync('/backup/inventory.json', JSON.stringify(inventory), { mode: 0o600 });
    console.log(JSON.stringify({ inventoryHash: digest(fs.readFileSync('/backup/inventory.json')), keyId: inventory.keyId,
      fileCounts: Object.fromEntries(names.map(name => [name, inventory.files[name].length])) }));
    return;
  }
  const bytes = fs.readFileSync('/backup/inventory.json'); check(digest(bytes) === input.inventoryHash);
  const inventory = JSON.parse(bytes);
  for (const name of names) {
    const target = `/backup/${name}.tar`, bytes = fs.readFileSync(target);
    check(bytes.length === inventory.archives[name].size && digest(bytes) === inventory.archives[name].sha256);
    check(files(`/app/${name}`).length === 0);
    const entries = execFileSync('tar', ['-tf', target], { encoding: 'utf8' }).trim().split('\n');
    check(entries.every(entry => entry === './' || entry.startsWith('./') && !entry.split('/').includes('..')));
    execFileSync('tar', ['--numeric-owner', '-xpf', target, '-C', `/app/${name}`]);
    check(JSON.stringify(files(`/app/${name}`)) === JSON.stringify(inventory.files[name]));
  }
  const secret = JSON.parse(fs.readFileSync('/app/secrets/instance.json', 'utf8'));
  check(secret.keyId === inventory.keyId && (fs.statSync('/app/secrets/instance.json').mode & 0o777) === 0o600);
  check((fs.statSync('/app/secrets').mode & 0o777) === 0o700 && (fs.statSync('/app/render-cache').mode & 0o777) === 0o700);
  console.log(JSON.stringify({ matchingFiles: true, matchingKeyId: true, restrictedPermissions: true }));
}

// Previous-schema fixture only: deploy genuine older migrations into a new DB,
// copy our own representative application rows, never alter migration history.
async function previousVersion() {
  const fs = require('node:fs'), { Database } = require('bun:sqlite'), { createHash } = require('node:crypto');
  const check = value => { if (!value) throw new Error('BACKUP_PREDECESSOR_INVALID'); };
  let predecessorStage = 'BACKUP_PREDECESSOR_SETUP';
  try {
  const directory = '/tmp/wp29-previous/prisma'; fs.mkdirSync(directory + '/migrations', { recursive: true });
  const latest = '20260907000000_foundation_batch_checkpoints';
  const names = fs.readdirSync('/app/prisma/migrations').filter(name => /^20/.test(name) && name < latest).sort();
  check(names.at(-1) === '20260906000000_observability');
  for (const name of names) fs.cpSync('/app/prisma/migrations/' + name, directory + '/migrations/' + name, { recursive: true });
  fs.copyFileSync('/app/prisma/migrations/migration_lock.toml', directory + '/migrations/migration_lock.toml');
  const schema = fs.readFileSync('/app/prisma/schema.prisma', 'utf8');
  const previous = schema
    .replace(/^\s*preparedAt\s+DateTime\?\s+@map\("prepared_at"\)\s*$/m, '')
    .replace(/^\s*progressCursor\s+String\?\s+@map\("progress_cursor"\)\s*$/m, '')
    .replace(/^\s*@@index\(\[publishedAt\]\)\s*$/m, '');
  check(previous !== schema); fs.writeFileSync(directory + '/schema.prisma', previous);
  predecessorStage = 'BACKUP_PREDECESSOR_DEPLOY';
  const deployed = Bun.spawnSync(['bun', '/app/scripts/migrate-database.ts'], { env: { ...process.env,
    DATABASE_URL: 'file:/app/uploads/previous.db', PRISMA_SCHEMA_PATH: directory + '/schema.prisma' }, stdout: 'pipe', stderr: 'pipe' });
  check(deployed.exitCode === 0);
  predecessorStage = 'BACKUP_PREDECESSOR_COPY';
  const old = new Database('/app/uploads/previous.db');
  old.exec("PRAGMA foreign_keys=OFF; ATTACH DATABASE '/app/uploads/inker.db' AS original");
  const tables = old.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_prisma_migrations' ORDER BY name").all().map(row => row.name);
  const triggers = old.query("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all();
  for (const trigger of triggers) {
    check(/^[a-zA-Z0-9_]+$/.test(trigger.name) && typeof trigger.sql === 'string');
    old.exec(`DROP TRIGGER "${trigger.name}"`);
  }
  const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');
  let rows = 0;
  old.transaction(() => {
    for (const table of tables) {
      predecessorStage = `BACKUP_PREDECESSOR_COPY_${table.toUpperCase().replace(/[^A-Z_]/g, '_').slice(0, 32)}`;
      check(/^[a-zA-Z0-9_]+$/.test(table));
      const columns = old.query(`PRAGMA table_info("${table}")`).all().map(row => row.name);
      check(columns.every(name => /^[a-zA-Z0-9_]+$/.test(name)));
      const fields = columns.map(name => `"${name}"`).join(',');
      old.exec(`DELETE FROM "${table}"; INSERT INTO "${table}"(${fields}) SELECT ${fields} FROM original."${table}"`);
      const prior = old.query(`SELECT ${fields} FROM original."${table}"`).all(), copied = old.query(`SELECT ${fields} FROM "${table}"`).all();
      check(digest(prior) === digest(copied)); rows += copied.length;
    }
  })();
  predecessorStage = 'BACKUP_PREDECESSOR_TRIGGERS';
  for (const trigger of triggers) old.exec(trigger.sql);
  const restoredTriggers = old.query("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all();
  check(digest(restoredTriggers) === digest(triggers));
  predecessorStage = 'BACKUP_PREDECESSOR_VERIFY';
  check(old.query('PRAGMA foreign_key_check').all().length === 0);
  check(old.query("SELECT COUNT(*) n FROM _prisma_migrations WHERE migration_name=? AND finished_at IS NOT NULL").get(latest).n === 0);
  check(old.query('PRAGMA table_info(outbox_events)').all().some(row => row.name === 'correlation_id'));
  const effectColumns = old.query('PRAGMA table_info(outbox_effects)').all().map(row => row.name);
  check(!effectColumns.includes('prepared_at') && !effectColumns.includes('progress_cursor'));
  old.exec('DETACH DATABASE original; PRAGMA wal_checkpoint(TRUNCATE)'); old.close();
  // Only this disposable restore-set DB is replaced; the backup remains read-only.
  predecessorStage = 'BACKUP_PREDECESSOR_REPLACE';
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync('/app/uploads/inker.db' + suffix)) fs.unlinkSync('/app/uploads/inker.db' + suffix);
  fs.renameSync('/app/uploads/previous.db', '/app/uploads/inker.db');
  console.log(JSON.stringify({ priorMigrations: names.length, preservedTables: tables.length, preservedRows: rows, pendingMigration: latest }));
  } catch { throw new Error(predecessorStage); }
}

async function post(state, role, path, data, admin = true, headers = {}, expected = 201) {
  const response = await r.request(state, role, path, { method: 'POST', data, admin, headers });
  assert.equal(response.status, expected); return jsonAndCheck(state, response);
}
function jsonAndCheck(state, response) { r.noSecrets(state, response.bytes.toString()); return r.json(response); }
async function enroll(state, device, role = 'source') {
  const response = await r.request(state, role, `/api/devices/${device.id}/enrollments`, { method: 'POST', data: {}, admin: true });
  assert.equal(response.status, 201); const enrollment = r.json(response); r.remember(state, enrollment.code); return enrollment;
}
async function exchange(state, code, role = 'source') {
  const response = await r.request(state, role, '/api/device-enrollments/exchange', { method: 'POST', data: { code } });
  assert.equal(response.status, 200); const credential = r.json(response); r.remember(state, credential.credential); return credential;
}
async function renderReady(state, role) {
  await r.wait(() => {
    const binding = r.db(state, role, 'p.renderBinding.findFirst({where:{deviceId:input.id},include:{ready:true,device:{include:{publicationState:true}}}})', { id: state.device.id });
    return binding?.readyKey === binding?.desiredKey && binding?.ready?.completedAt
      && binding.ready.publicationRevisionId === binding.device.publicationState.desiredPublicationRevisionId;
  });
}
async function artifact(state, role) {
  const headers = { Authorization: `Bearer ${state.credential.credential}` };
  const response = await r.request(state, role, `/api/web-displays/${state.device.externalId}/presentation`, { headers });
  assert.equal(response.status, 200); const presentation = jsonAndCheck(state, response);
  const image = await r.request(state, role, presentation.content.url, { headers }); assert.equal(image.status, 200);
  assert.equal(hash(image.bytes), presentation.content.url.split('/').pop());
  const cached = await r.request(state, role, presentation.content.url, { headers: { ...headers, 'If-None-Match': image.headers.etag } });
  assert.equal(cached.status, 304); return hash(image.bytes);
}
async function seed(state) {
  phase('create isolated source app and authenticated fixture'); r.createSet(state, 'source'); r.createApp(state, 'source'); r.control(state, 'source', 'start');
  await r.ready(state, 'source'); await r.login(state, 'source');
  const made = await r.request(state, 'source', '/api/devices', { method: 'POST', admin: true, data: { name: 'WP29 restored display', deviceType: 'web-display' } });
  assert.equal(made.status, 201); state.device = r.json(made); r.remember(state, state.device.pairingToken); r.remember(state, state.device.apiKey);
  state.revoked = await exchange(state, (await enroll(state, state.device)).code);
  state.credential = await exchange(state, (await enroll(state, state.device)).code);
  const other = await r.request(state, 'source', '/api/devices', { method: 'POST', admin: true, data: { name: 'WP29 pending enrollment', deviceType: 'web-display' } });
  assert.equal(other.status, 201); state.unpaired = r.json(other); r.remember(state, state.unpaired.pairingToken); r.remember(state, state.unpaired.apiKey);
  state.enrollment = await enroll(state, state.unpaired);
  const secret = randomBytes(32).toString('hex'); r.remember(state, secret);
  const source = await post(state, 'source', '/api/sources', { protocolVersion: '1.0', name: 'WP29 encrypted source', connectorType: 'fixture', schemaVersion: '1',
    configuration: { data: { fixtureArtifacts: ['mono-800x480-white-png'] } }, secret, refreshIntervalSeconds: 3600, timeoutMs: 1000, concurrencyGroup: 'wp29-backup' });
  state.sourceId = source.definition.sourceDefinitionId; r.save(state);
  await r.wait(() => r.db(state, 'source', 'p.sourceSnapshot.count({where:{sourceDefinitionId:input.id,freshnessState:"fresh"}})', { id: state.sourceId }) === 1);
  state.snapshot = r.db(state, 'source', 'p.sourceSnapshot.findFirstOrThrow({where:{sourceDefinitionId:input.id}})', { id: state.sourceId });
  // A real upload file referenced by a Screen, plus separate private cache pixels.
  const created = r.exec(state, 'source', ['bun', '-e', `const fs=require('node:fs'),sharp=require('sharp'),{PrismaClient}=require('@prisma/client');const p=new PrismaClient();
    const data=await sharp({create:{width:800,height:480,channels:3,background:'#224466'}}).png().toBuffer();fs.writeFileSync('/app/uploads/screens/wp29-backup.png',data);
    const screen=await p.screen.create({data:{name:'WP29 stored upload',imageUrl:'/uploads/screens/wp29-backup.png'}});await p.$disconnect();${r.drain('screen')}`]);
  state.screen = JSON.parse(created);
  state.sourcePublication = await post(state, 'source', '/api/publications/wp29-source/publish', { idempotencyKey: randomUUID(), expectedRevision: 0, deviceIds: [], draft: { sourceSnapshotId: state.snapshot.snapshotId } });
  const actions = ['create', 'pause', 'resume', 'cancel', 'acknowledge'].map(action => ({ action: `timer.${action}`, payloadSchemaVersion: '1.0' }));
  state.publication = await post(state, 'source', '/api/publications/wp29-backup/publish', { idempotencyKey: randomUUID(), expectedRevision: 0,
    deviceIds: [state.device.id], allowedActions: actions, draft: { screenId: state.screen.id, expectedUpdatedAt: state.screen.updatedAt } });
  await renderReady(state, 'source'); state.originalArtifact = await artifact(state, 'source');
  const auth = { Authorization: `Bearer ${state.credential.credential}` };
  const contextResponse = await r.request(state, 'source', '/api/interactions/context', { headers: auth }); assert.equal(contextResponse.status, 200);
  const context = r.json(contextResponse); assert.equal(context.allowedActions.length, 5);
  r.exec(state, 'source', ['/command/s6-svc', '-d', '/run/service/worker']);
  r.exec(state, 'source', ['/command/s6-svwait', '-d', '-t', '35000', '/run/service/worker']);
  for (const [key, durationMs] of [['due', 60000], ['future', 3600000]]) {
    const event = { protocolVersion: '1.0', eventId: randomUUID(), deviceId: state.device.externalId, credentialId: context.credentialId,
      publicationId: context.publicationId, revision: context.revision, action: 'timer.create', payload: { version: 1, visibility: 'shared', durationMs }, occurredAt: new Date().toISOString() };
    const result = await post(state, 'source', '/api/interactions', event, false, auth, 200); assert.equal(result.status, 'accepted');
    state[key] = result.result; if (key === 'due') state.replay = event;
  }
  state.pendingPublication = await post(state, 'source', '/api/publications/wp29-backup/publish', { idempotencyKey: randomUUID(), expectedRevision: 1,
    deviceIds: [state.device.id], allowedActions: actions, draft: { fixtureArtifacts: ['mono-800x480-black-bmp'] } });
  state.pendingEvents = r.db(state, 'source', 'p.outboxEvent.findMany({where:{status:"pending"},select:{eventId:true,eventType:true,aggregateId:true,correlationId:true}})');
  assert.ok(state.pendingEvents.some(row => row.eventType === 'timer.completion.due'));
  // Publish commits desired-state intent. The stopped worker cannot yet derive
  // its render.requested event; recovery must perform both steps after restore.
  assert.ok(state.pendingEvents.some(row => row.eventType === 'device.publication.desired-revision.changed'));
  state.immutable = r.db(state, 'source', 'Promise.all([p.publicationRevision.findMany({orderBy:{publicationRevisionId:"asc"}}),p.sourceSnapshot.findMany({orderBy:{snapshotId:"asc"}})])');
  r.audit(state, 'source'); r.save(state); r.control(state, 'source', 'stop'); r.stopped(state, 'source');
  assert.ok(Date.now() < Date.parse(state.due.endsAt), 'Timer must still be active when the stopped backup begins');
}

async function verify(state, role) {
  phase(`${role}: real application startup and overdue work recovery`);
  r.createApp(state, role); r.control(state, role, 'start'); await r.ready(state, role);
  const response = await r.request(state, role, '/api/devices', { admin: true }); assert.equal(response.status, 200, 'Restored admin session remains valid');
  const auth = { Authorization: `Bearer ${state.credential.credential}` };
  const revoked = await r.request(state, role, '/api/timers', { headers: { Authorization: `Bearer ${state.revoked.credential}` } }); assert.equal(revoked.status, 401);
  let timers;
  await r.wait(async () => {
    const response = await r.request(state, role, '/api/timers', { headers: auth }); assert.equal(response.status, 200);
    timers = jsonAndCheck(state, response).timers; return timers.some(timer => timer.timerId === state.due.timerId && timer.status === 'completed');
  });
  const due = timers.find(timer => timer.timerId === state.due.timerId), future = timers.find(timer => timer.timerId === state.future.timerId);
  assert.equal(due.version, 2); assert.equal(due.completedAt, state.due.endsAt); assert.equal(future.status, 'running'); assert.equal(future.version, 1);
  assert.equal(future.endsAt, state.future.endsAt);
  const replay = await post(state, role, '/api/interactions', state.replay, false, auth, 200); assert.equal(replay.status, 'duplicate'); assert.equal(replay.result.timerId, due.timerId);
  await renderReady(state, role); assert.notEqual(await artifact(state, role), state.originalArtifact);
  const rows = r.db(state, role, 'Promise.all([p.publicationRevision.findMany({orderBy:{publicationRevisionId:"asc"}}),p.sourceSnapshot.findMany({orderBy:{snapshotId:"asc"}})])');
  assert.deepEqual(rows, state.immutable);
  const dueIntent = state.pendingEvents.find(row => row.eventType === 'timer.completion.due' && row.aggregateId === due.timerId);
  assert.ok(dueIntent);
  await r.wait(() => r.db(state, role, 'p.outboxEvent.findUniqueOrThrow({where:{eventId:input.id},select:{status:true}})', { id: dueIntent.eventId }).status === 'delivered');
  assert.equal(r.db(state, role, 'p.outboxEffect.count({where:{eventId:input.id}})', { id: dueIntent.eventId }), 1);
  assert.equal(r.db(state, role, 'p.timer.count()'), 2);
  const events = r.db(state, role, 'p.outboxEvent.findMany({where:{eventId:{in:input.ids}}})', { ids: state.pendingEvents.map(row => row.eventId) });
  assert.equal(events.length, state.pendingEvents.length); assert.ok(events.some(row => row.status === 'delivered'));
  for (const row of events) assert.equal(row.correlationId, state.pendingEvents.find(event => event.eventId === row.eventId).correlationId);
  const credential = await exchange(state, state.enrollment.code, role); assert.ok(credential.credential);
  const repeat = await r.request(state, role, '/api/device-enrollments/exchange', { method: 'POST', data: { code: state.enrollment.code } }); assert.equal(repeat.status, 400);
  const refresh = await post(state, role, `/api/sources/${state.sourceId}/refresh`, {}); assert.ok(refresh.eventId);
  await r.wait(() => r.db(state, role, 'p.sourceSnapshot.count({where:{sourceDefinitionId:input.id,freshnessState:"fresh"}})', { id: state.sourceId }) === 2);
  const next = r.db(state, role, 'p.sourceSnapshot.findFirstOrThrow({where:{sourceDefinitionId:input.id},orderBy:{revision:"desc"}})', { id: state.sourceId });
  assert.equal(next.errorCode, null); assert.deepEqual(next.data, state.snapshot.data);
  const migration = r.db(state, role, 'p.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name")');
  assert.equal(migration.at(-1).migration_name, '20260907000000_foundation_batch_checkpoints');
  r.exec(state, role, ['node', '/app/node_modules/prisma/build/index.js', 'migrate', 'diff', '--exit-code', '--from-url', 'file:/app/uploads/inker.db', '--to-schema-datamodel', '/app/prisma/schema.prisma']);
  r.audit(state, role); r.control(state, role, 'stop');
}

async function main() {
  if (process.argv[2] === 'cleanup') { if (existsSync(r.statePath)) r.cleanup(r.load()); console.log('WP29 backup cleanup complete'); return; }
  assert.equal(process.argv[2], undefined); const state = r.newState();
  try {
    await seed(state);
    phase('archive all stopped uploads, secret and private cache files'); r.createVolume(state, 'archive', 'data');
    state.inventory = JSON.parse(r.tool(state, [...bindSet('source', true), archiveBinding(false)], `await (${archives.toString()})()`, { operation: 'backup', image: r.image }));
    assert.ok(state.inventory.fileCounts.uploads >= 2); assert.equal(state.inventory.fileCounts.secrets, 1); assert.ok(state.inventory.fileCounts['render-cache'] >= 1);
    r.save(state); r.stopped(state, 'source');
    for (const role of ['restore', 'upgrade']) {
      phase(`${role}: verify archives, file hashes and permissions into new empty volumes`); r.createSet(state, role);
      const result = JSON.parse(r.tool(state, [...bindSet(role), archiveBinding(true)], `await (${archives.toString()})()`, { operation: 'restore', inventoryHash: state.inventory.inventoryHash }));
      assert.deepEqual(result, { matchingFiles: true, matchingKeyId: true, restrictedPermissions: true });
      if (role === 'upgrade') {
        const previous = JSON.parse(r.tool(state, bindSet(role), `await (${previousVersion.toString()})()`));
        assert.ok(previous.preservedTables > 20 && previous.preservedRows > 20); assert.equal(previous.pendingMigration, '20260907000000_foundation_batch_checkpoints');
      }
      // No running app can complete this timer while its deadline passes.
      await r.wait(() => Date.now() >= Date.parse(state.due.endsAt) + 100, 65000);
      await verify(state, role);
    }
    phase('missing secret snapshot is rejected without generating a replacement key'); r.createVolume(state, 'missing', 'secrets');
    const missing = JSON.parse(r.tool(state, [{ role: 'source', mount: 'uploads', at: '/app/uploads', readOnly: true },
      { role: 'missing', mount: 'secrets', at: '/app/secrets' }], `const fs=require('node:fs');const result=Bun.spawnSync(['bun','/app/scripts/prepare-instance-secrets.ts','--initialize'],
      {env:{...process.env,ADMIN_PIN:input.password,INKER_INSTANCE_SECRET_PATH:'/app/secrets/instance.json',DATABASE_URL:'file:/app/uploads/inker.db'},stdout:'pipe',stderr:'pipe'});
      const expected=${JSON.stringify(MISSING_SECRET_REFUSAL)};
      const verify=${isExpectedMissingSecretRefusal.toString()};
      console.log(JSON.stringify({refused:verify(result.exitCode,result.stderr,expected),
        keyCreated:fs.existsSync('/app/secrets/instance.json')}));`, { password: state.password }));
    assert.deepEqual(missing, { refused: true, keyCreated: false });
  } catch (error) { await r.diagnose(state); throw error; }
  finally { r.cleanup(state); }
  console.log('WP29 backup/restore passed: complete stopped volume set, exact hashes/permissions, active timers, durable outbox, publications, sources, sessions, revoked/current credentials, one-time pairing, predecessor migration, missing-key refusal; all own resources removed');
}
if (require.main === module) main().catch(error => {
  const code = error instanceof Error && /^BACKUP_[A-Z_]+$/.test(error.message) ? error.message : 'BACKUP_ASSERTION_FAILED';
  const frames = typeof error?.stack === 'string' ? error.stack.split('\n').flatMap(line => {
    const match = /^\s+at\s/.test(line) && line.match(/(?:[/\\])(foundation-backup-restore\.cjs|foundation-backup-runtime\.cjs):(\d+):(\d+)\)?\s*$/);
    return match ? [{ file: match[1], line: Number(match[2]), column: Number(match[3]) }] : [];
  }).slice(0, 6) : [];
  const actual = typeof error?.actual === 'number' && Number.isFinite(error.actual) ? error.actual : undefined;
  const expected = typeof error?.expected === 'number' && Number.isFinite(error.expected) ? error.expected : undefined;
  console.error(JSON.stringify({ code, stage, frames, actual, expected })); process.exitCode = 1;
});
module.exports = { MISSING_SECRET_REFUSAL, isExpectedMissingSecretRefusal, archives, previousVersion, seed };
