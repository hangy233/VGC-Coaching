import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireMetricsBattleLock, assertMetricsTeamWritable, beginMetricsTeamDeletion, finishMetricsTeamDeletion, getMetricsTeamDeletion, listMetricsCatalog, listMetricsTeamDeletions, materialBattleSignature, recordMetricsBattle, recreateDeletedMetricsTeam, registerMetricsTeam, restoreMetricsTeam } from './catalog.mjs';
import { saveBattle, listBattles, listTeams, isMetricsTeamActive } from './store.mjs';

const runFile = promisify(execFile);
const storeUrl = new URL('./store.mjs', import.meta.url).href;
const catalogUrl = new URL('./catalog.mjs', import.meta.url).href;
const teamId = index => index.toString(16).padStart(64, '0');
async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'vgc-catalog-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const battle = index => ({
  schemaVersion: 1, roomId: 'battle-concurrent-1', parentId: null, teamId: teamId(index), username: 'Player', ownSide: 'p1',
  outcome: 'win', completed: true, turns: 3, players: { p1: 'Player', p2: 'Opponent' }, opponentRoster: [],
  selected: [], selectionKnown: false, leads: [], pokemon: [], quality: { complete: true, operational: false, warnings: [] },
  team: { name: `Team ${index}`, roster: ['Golisopod'] }, metadata: {},
});
function worker(operation, args) {
  // execFile receives argument arrays directly; no shell or user data is evaluated as code.
  const code = `import { ${operation} } from ${JSON.stringify(storeUrl)}; await ${operation}(JSON.parse(process.argv[1]));`;
  return runFile(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(args)], { windowsHide: true, timeout: 20_000 });
}
function coordinatedWorker(t, code, args) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(args)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', signalReady, rejectReady;
  const ready = new Promise((resolve, reject) => { signalReady = resolve; rejectReady = reject; });
  child.stdout.on('data', data => { output += data; if (output.includes('READY')) signalReady(); });
  child.stderr.on('data', data => { errors += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', error => { rejectReady(error); reject(error); });
    child.on('close', code => {
      if (code === 0) { signalReady(); resolve(); }
      else { const error = new Error(`Metrics test worker failed: ${errors}`); rejectReady(error); reject(error); }
    });
  });
  // Consume errors promptly even if a readiness assertion fails before awaiting completion.
  done.catch(() => {});
  ready.catch(() => {});
  t.after(async () => { if (child.exitCode === null) child.kill(); await done.catch(() => {}); });
  return { ready, done };
}

test('native processes concurrently initialize and register teams without exceeding ten active entries', async t => {
  const dir = await workspace(t);
  await Promise.all(Array.from({ length: 14 }, (_, index) => worker('registerMetricsTeam', { workspace: dir, teamId: teamId(index + 1), name: `Concurrent ${index + 1}` })));
  const all = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  assert.equal(all.length, 10);
  assert.equal(all.filter(team => team.active).length, 10);
  assert.equal(all.filter(team => team.archived).length, 0);
  assert.equal(new Set(all.map(team => team.usageOrder)).size, 10);
  assert.equal((await listTeams({ workspace: dir })).length, 10);
  let deleted = 0;
  for (let index = 1; index <= 14; index++) if ((await getMetricsTeamDeletion({ workspace: dir, teamId: teamId(index) }))?.state === 'deleted') deleted++;
  assert.equal(deleted, 4);
});

test('concurrent imports touch once and stale imports cannot recreate permanently evicted teams', async t => {
  const dir = await workspace(t);
  for (let index = 1; index <= 10; index++) await saveBattle({ workspace: dir, record: battle(index) });
  const before = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  await Promise.all(Array.from({ length: 5 }, () => worker('saveBattle', { workspace: dir, record: battle(1) })));
  const unchanged = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  assert.deepEqual(unchanged.map(team => [team.teamId, team.active, team.usageOrder]), before.map(team => [team.teamId, team.active, team.usageOrder]));
  const updated = { ...battle(1), turns: 4 };
  await Promise.all(Array.from({ length: 5 }, () => worker('saveBattle', { workspace: dir, record: updated })));
  const after = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  assert.equal(Math.max(...after.map(team => team.usageOrder)), Math.max(...before.map(team => team.usageOrder)) + 1);
  assert.equal(after.filter(team => team.active).length, 10);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: teamId(1) }), true);
  await saveBattle({ workspace: dir, record: battle(11) });
  assert.equal((await getMetricsTeamDeletion({ workspace: dir, teamId: teamId(2) })).state, 'deleted');
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: teamId(2) }), null);
  const beforeStale = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  await Promise.all(Array.from({ length: 5 }, () => assert.rejects(worker('saveBattle', { workspace: dir, record: battle(2) }), /deleted or is being deleted/u)));
  assert.deepEqual(await listMetricsCatalog({ workspace: dir, includeArchived: true }), beforeStale);
  assert.equal((await listBattles({ workspace: dir, includeArchived: true })).length, 10);
});

test('material signatures ignore provenance and ordering but detect actual metrics and quality changes', () => {
  const first = battle(1);
  first.selected = ['Golisopod', 'Farigiraf'];
  const changedProvenance = { ...first, selected: ['Farigiraf', 'Golisopod'], importedAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', metadata: { sources: ['cache/source.jsonl'], attribution: 'Reviewed' }, quality: { ...first.quality, warnings: ['New annotation'] } };
  assert.equal(materialBattleSignature(first), materialBattleSignature(changedProvenance));
  assert.notEqual(materialBattleSignature(first), materialBattleSignature({ ...first, turns: 4 }));
  assert.notEqual(materialBattleSignature(first), materialBattleSignature({ ...first, quality: { ...first.quality, operational: true } }));
});

test('a native per-row lease prevents a stale partial writer from erasing another process full import', async t => {
  const dir = await workspace(t);
  const partial = { ...battle(1), completed: false, outcome: 'unknown', turns: 5, quality: { complete: false, operational: false, warnings: [] } };
  await saveBattle({ workspace: dir, record: partial });
  const file = join(dir, 'cache', 'team-metrics', `${partial.roomId}--${partial.teamId}.json`);
  const releaseFile = join(dir, 'release-test-writer');
  const staleWriter = coordinatedWorker(t, `
    import { acquireMetricsBattleLock } from ${JSON.stringify(catalogUrl)};
    import { readFile,writeFile,rename } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const args=JSON.parse(process.argv[1]);
    const release=await acquireMetricsBattleLock(args);
    try {
      const stale=JSON.parse(await readFile(args.file,'utf8'));
      process.stdout.write('READY\\n');
      const deadline=Date.now()+10000;
      for(;;){try{await readFile(args.releaseFile);break;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw new Error('Test release was not received');await delay(10);}
      stale.turns=6;const temporary=args.file+'.test-pending';
      await writeFile(temporary,JSON.stringify(stale));await rename(temporary,args.file);
    } finally {await release();}
  `, { workspace: dir, roomId: partial.roomId, teamId: partial.teamId, file, releaseFile });
  await staleWriter.ready;
  const complete = { ...battle(1), turns: 10 };
  const fullWriter = coordinatedWorker(t, `import {saveBattle} from ${JSON.stringify(storeUrl)};const args=JSON.parse(process.argv[1]);process.stdout.write('READY\\n');await saveBattle(args);`, { workspace: dir, record: complete });
  await fullWriter.ready;
  let fullSettled = false;
  fullWriter.done.then(() => { fullSettled = true; }, () => { fullSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(fullSettled, false, 'the full writer must wait until the stale writer releases its row lease');
  await writeFile(releaseFile, 'release');
  await Promise.all([staleWriter.done, fullWriter.done]);
  const [stored] = await listBattles({ workspace: dir });
  assert.equal(stored.turns, 10);
  assert.equal(stored.completed, true);
  assert.equal(stored.quality.complete, true);
});

test('writer leases are bounded for live owners and safely reclaimed after a native owner exits', async t => {
  const dir = await workspace(t), args = { workspace: dir, roomId: 'battle-lock-1', teamId: teamId(1) };
  const release = await acquireMetricsBattleLock(args);
  await assert.rejects(acquireMetricsBattleLock({ ...args, timeoutMs: 60 }), /busy in another local process/u);
  await release();
  const code = `import {acquireMetricsBattleLock} from ${JSON.stringify(catalogUrl)};await acquireMetricsBattleLock(JSON.parse(process.argv[1]));process.exit(0);`;
  await runFile(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(args)], { windowsHide: true, timeout: 20_000 });
  const releaseRecovered = await acquireMetricsBattleLock(args);
  await releaseRecovered();
});

test('deletion excludes the exact team and prevents stale registration, restoration and battle writes', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: battle(1) });
  await saveBattle({ workspace: dir, record: battle(2) });
  const args = { workspace: dir, teamId: teamId(1) };
  const before = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  const deletion = await beginMetricsTeamDeletion(args);
  assert.equal(deletion.state, 'deleting');
  assert.equal(deletion.completedAt, null);
  assert.deepEqual(await beginMetricsTeamDeletion(args), deletion, 'a retry retains the original deletion identity');
  assert.deepEqual(await getMetricsTeamDeletion(args), deletion);
  assert.deepEqual(await listMetricsTeamDeletions({ workspace: dir }), [deletion]);
  assert.equal(await isMetricsTeamActive(args), null);
  assert.deepEqual((await listMetricsCatalog({ workspace: dir, includeArchived: true })).map(team => team.teamId), [teamId(2)]);
  const deleted = error => error.code === 'METRICS_TEAM_DELETED' && error.deletionState === 'deleting';
  await assert.rejects(registerMetricsTeam(args), deleted);
  await assert.rejects(restoreMetricsTeam(args), deleted);
  await assert.rejects(recordMetricsBattle({ workspace: dir, record: battle(1) }), deleted);
  await assert.rejects(acquireMetricsBattleLock({ ...args, roomId: 'battle-concurrent-1' }), deleted);
  await assert.rejects(assertMetricsTeamWritable(args), deleted);
  await assert.rejects(saveBattle({ workspace: dir, record: { ...battle(1), turns: 99 } }), deleted);
  await assertMetricsTeamWritable({ workspace: dir, teamId: teamId(2) });
  const after = await listMetricsCatalog({ workspace: dir, includeArchived: true });
  assert.deepEqual(after[0], before.find(team => team.teamId === teamId(2)), 'another team keeps its descriptor and LRU order');
});

test('finishing deletion removes catalog history but retains a tombstone against stale background imports', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: battle(1) });
  const args = { workspace: dir, teamId: teamId(1) };
  await assert.rejects(finishMetricsTeamDeletion(args), /deletion must begin/u);
  await beginMetricsTeamDeletion(args);
  const complete = await finishMetricsTeamDeletion(args);
  assert.equal(complete.state, 'deleted');
  assert.equal(typeof complete.completedAt, 'string');
  assert.deepEqual(await listMetricsTeamDeletions({ workspace: dir }), []);
  assert.deepEqual(await listMetricsTeamDeletions({ workspace: dir, state: 'deleted' }), [complete]);
  assert.deepEqual(await finishMetricsTeamDeletion(args), complete);
  assert.deepEqual(await beginMetricsTeamDeletion(args), complete, 'a cleanup retry does not erase the completed state');
  const database = new DatabaseSync(join(dir, 'cache', 'team-metrics', 'catalog.sqlite'));
  try {
    for (const table of ['teams', 'battle_signatures', 'battle_write_locks']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE team_id=?`).get(args.teamId).count, 0);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM deleted_teams WHERE team_id=?').get(args.teamId).count, 1);
  } finally { database.close(); }
  await assert.rejects(worker('registerMetricsTeam', args), /deleted or is being deleted/u);
  await assert.rejects(worker('saveBattle', { workspace: dir, record: battle(1) }), /deleted or is being deleted/u);
});

test('deletion waits for live writers and reclaims a confirmed dead native writer before blocking new leases', async t => {
  const dir = await workspace(t), args = { workspace: dir, roomId: 'battle-delete-1', teamId: teamId(1) };
  await registerMetricsTeam(args);
  const release = await acquireMetricsBattleLock(args);
  await assert.rejects(beginMetricsTeamDeletion(args), error => error.code === 'METRICS_TEAM_BUSY');
  assert.equal(await getMetricsTeamDeletion(args), null, 'a refused deletion must not block the active writer');
  await recordMetricsBattle({ workspace: dir, record: battle(1) });
  await release();
  const code = `import {acquireMetricsBattleLock} from ${JSON.stringify(catalogUrl)};await acquireMetricsBattleLock(JSON.parse(process.argv[1]));process.exit(0);`;
  await runFile(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(args)], { windowsHide: true, timeout: 20_000 });
  assert.equal((await beginMetricsTeamDeletion(args)).state, 'deleting');
  await assert.rejects(acquireMetricsBattleLock(args), error => error.code === 'METRICS_TEAM_DELETED');
});

test('an outdated capacity eviction cannot delete a team that was used again', async t => {
  const dir = await workspace(t), args = { workspace: dir, teamId: teamId(1), requireCapacityEviction: true };
  await registerMetricsTeam(args);
  assert.equal(await beginMetricsTeamDeletion(args), null, 'an active version is no longer an eviction candidate');
  const database = new DatabaseSync(join(dir, 'cache', 'team-metrics', 'catalog.sqlite'));
  try { database.prepare("UPDATE teams SET active=0,archive_reason='capacity' WHERE team_id=?").run(args.teamId); }
  finally { database.close(); }
  assert.equal((await beginMetricsTeamDeletion(args)).state, 'deleting');
});

test('only deliberate report recreation clears a completed tombstone', async t => {
  const dir = await workspace(t), args = { workspace: dir, teamId: teamId(1) };
  assert.deepEqual(await recreateDeletedMetricsTeam(args), { teamId: args.teamId, recreated: false });
  await registerMetricsTeam(args);
  await beginMetricsTeamDeletion(args);
  await assert.rejects(recreateDeletedMetricsTeam(args), error => error.code === 'METRICS_TEAM_BUSY');
  await finishMetricsTeamDeletion(args);
  await assert.rejects(registerMetricsTeam(args), error => error.code === 'METRICS_TEAM_DELETED');
  assert.deepEqual(await recreateDeletedMetricsTeam(args), { teamId: args.teamId, recreated: true });
  const fresh = await registerMetricsTeam({ ...args, name: 'Fresh report' });
  assert.equal(fresh.team.name, 'Fresh report');
  assert.equal(await getMetricsTeamDeletion(args), null);
});

test('shared registry coordination survives deletion of the reserved hash fixture', async t => {
  const dir = await workspace(t), args = { workspace: dir, teamId: '0'.repeat(64) };
  const release = await acquireMetricsBattleLock({ ...args, roomId: 'metrics-sources' });
  await beginMetricsTeamDeletion(args);
  await finishMetricsTeamDeletion(args);
  await release();
  const releaseAfterDeletion = await acquireMetricsBattleLock({ ...args, roomId: 'metrics-sources' });
  await releaseAfterDeletion();
  await assert.rejects(acquireMetricsBattleLock({ ...args, roomId: 'battle-normal-1' }), error => error.code === 'METRICS_TEAM_DELETED');
});

test('pending manual deletion does not consume an active team slot', async t => {
  const dir = await workspace(t);
  for (let index = 1; index <= 10; index++) await registerMetricsTeam({ workspace: dir, teamId: teamId(index) });
  await beginMetricsTeamDeletion({ workspace: dir, teamId: teamId(1) });
  const added = await registerMetricsTeam({ workspace: dir, teamId: teamId(11) });
  assert.deepEqual(added.evictedTeams, []);
  assert.equal((await listMetricsCatalog({ workspace: dir })).length, 10);
  assert.equal(await getMetricsTeamDeletion({ workspace: dir, teamId: teamId(2) }), null);
});
