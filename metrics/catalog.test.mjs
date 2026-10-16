import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMetricsBattleLock, listMetricsCatalog, materialBattleSignature } from './catalog.mjs';
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
  assert.equal(all.length, 14);
  assert.equal(all.filter(team => team.active).length, 10);
  assert.equal(all.filter(team => team.archived).length, 4);
  assert.equal(new Set(all.map(team => team.usageOrder)).size, 14);
  assert.equal((await listTeams({ workspace: dir })).length, 10);
});

test('concurrent identical background imports retain archival state and one material update touches once', async t => {
  const dir = await workspace(t);
  for (let index = 1; index <= 11; index++) await saveBattle({ workspace: dir, record: battle(index) });
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: teamId(1) }), false);
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
  assert.equal((await listBattles({ workspace: dir, includeArchived: true })).length, 11);
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
