import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importReplayUrls} from './replays.mjs';
import {registerTeamFromFile} from './import.mjs';
import {listBattles} from './store.mjs';

const ID = 'gen9championsvgc2026regmcbo3-123';
const URL = `https://replay.pokemonshowdown.com/${ID}`;
const TEAM = [['Golisopod', 'Emergency Exit'], ['Kommo-o', 'Soundproof'], ['Rillaboom', 'Grassy Surge'], ['Politoed', 'Drizzle'], ['Farigiraf', 'Armor Tail'], ['Sylveon', 'Pixilate']]
  .map(([name, ability]) => `${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const LOG = '|gametype|doubles\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|switch|p1a: Goli|Golisopod, L50|100/100\n|switch|p2a: Cat|Incineroar, L50|100/100\n|turn|1\n|move|p1a: Goli|Protect|p1a: Goli\n|win|Fixture';
const response = (payload = {id: ID, log: LOG}) => new Response(JSON.stringify(payload), {headers: {'Content-Type': 'application/json'}});
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'vgcm-replay-'));
  t.after(() => rm(workspace, {recursive: true, force: true}));
  await mkdir(join(workspace, 'teams'));
  await writeFile(join(workspace, 'teams/team.txt'), TEAM);
  return {workspace, urls: [URL], username: 'Fixture', teamFile: 'teams/team.txt'};
}

test('imports official saved replay JSON with bounded credential-free fetch and deduplicates URL variants', async t => {
  const args = await fixture(t), calls = [];
  const result = await importReplayUrls({...args, urls: [URL, URL + '.json', URL + '.log', URL + '/'], fetchImpl: async (url, options) => {
    calls.push({url, options}); return response();
  }});
  assert.equal(result.imported, 1); assert.equal(result.replayUrls, 1); assert.equal(calls.length, 1);
  assert.equal(result.replayWarnings.length, 1);
  assert.equal(calls[0].url, URL + '.json');
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const records = await listBattles({workspace: args.workspace});
  assert.equal(records[0].roomId, 'battle-' + ID);
  assert.equal(records[0].pokemon.find(p => p.species === 'Golisopod').moves.find(m => m.move === 'Protect').uses, 1);
  await assert.rejects(readFile(join(args.workspace, 'cache/team-metrics/sources/registry.json')), {code: 'ENOENT'});
});

test('private capabilities are used transiently but never cached or returned', async t => {
  const args = await fixture(t), capability = '-mysecrettokenpw';
  let requested;
  const result = await importReplayUrls({...args, urls: [URL, URL + capability], fetchImpl: async url => {
    requested = url;
    return response({id: ID + capability, password: capability, log: `>battle-${ID}${capability}\n${LOG}\n|c|Opponent|${URL}${capability}\n|-message|Room battle-${ID}${capability}`});
  }});
  assert.equal(requested, URL + capability + '.json');
  assert.doesNotMatch(JSON.stringify(result), /mysecrettokenpw/);
  const directory = join(args.workspace, 'cache/team-metrics/replays'), names = await readdir(directory);
  assert.deepEqual(names, [createHash('sha256').update(ID).digest('hex') + '.json']);
  const cached = await readFile(join(directory, names[0]), 'utf8');
  assert.doesNotMatch(cached, /mysecrettokenpw|password|\|c\|/);
  assert.equal(JSON.parse(cached).id, ID);
  assert.doesNotMatch(JSON.stringify(await listBattles({workspace: args.workspace})), /mysecrettokenpw/);
});

test('rejects external, insecure, credentialed, queried and malformed URLs before fetching', async t => {
  const args = await fixture(t); let fetched = false;
  for (const url of ['http://replay.pokemonshowdown.com/' + ID, 'https://evil.test/' + ID, 'https://127.0.0.1/' + ID,
    'https://replay.pokemonshowdown.com.evil.test/' + ID, 'https://user:secret@replay.pokemonshowdown.com/' + ID,
    URL + '?token=secret', URL + '#private', URL + '/extra', URL + '%2Fextra', 'file:///tmp/replay.json']) {
    await assert.rejects(importReplayUrls({...args, urls: [url], fetchImpl: async () => { fetched = true; return response(); }}));
  }
  assert.equal(fetched, false);
});

test('redirects, wrong identity, wrong player and oversized responses fail without persisting a partial batch', async t => {
  const args = await fixture(t);
  const invalid = [
    () => response({id: ID.replace('123', '999'), log: LOG}),
    () => response({id: ID.replace('123', '124'), log: LOG.replaceAll('Fixture', 'OtherAccount')}),
    () => new Response('{}', {headers: {'Content-Length': String(9 * 1024 * 1024)}}),
    () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    () => ({ok: true, redirected: true, url: 'https://evil.test/private-secretpw'}),
    () => ({ok: true, redirected: false, url: 'https://evil.test/private-secretpw'}),
  ];
  for (const bad of invalid) {
    let calls = 0;
    const error = await importReplayUrls({...args, urls: [URL, URL.replace('123', '124') + '-secretpw'], fetchImpl: async () => ++calls === 1 ? response() : bad()}).then(() => null, error => error);
    assert.ok(error); assert.equal(error.message, 'Saved replay could not be fetched or validated.');
    assert.doesNotMatch(error.message, /secretpw|evil/);
    await assert.rejects(readdir(join(args.workspace, 'cache/team-metrics')), {code: 'ENOENT'});
  }
});

test('transport errors never disclose a private endpoint and do not create a dataset', async t => {
  const args = await fixture(t);
  await assert.rejects(importReplayUrls({...args, urls: [URL + '-secretpw'], fetchImpl: async url => { throw new Error('Network failed for ' + url); }}), error => {
    assert.equal(error.message, 'Saved replay could not be fetched or validated.'); return true;
  });
  await assert.rejects(readdir(join(args.workspace, 'cache/team-metrics')), {code: 'ENOENT'});
});

test('wrong formats cannot be assigned to an M-C team and missing metadata stays explicit', async t => {
  const args = await fixture(t); let fetched = false;
  await assert.rejects(importReplayUrls({...args, urls: ['https://replay.pokemonshowdown.com/gen9ou-123'], fetchImpl: async () => { fetched = true; return response(); }}), /not Champions Regulation M-C/);
  assert.equal(fetched, false);
  for (const payload of [{id: ID, formatid: 'gen9ou', log: LOG}, {id: ID, log: '|tier|[Gen 9] OU\n' + LOG}]) {
    await assert.rejects(importReplayUrls({...args, fetchImpl: async () => response(payload)}), /could not be fetched or validated/);
  }
  await assert.rejects(readdir(join(args.workspace, 'cache/team-metrics')), {code: 'ENOENT'});
  const good = await importReplayUrls({...args, fetchImpl: async () => response({id: ID, formatid: 'gen9championsvgc2026regmcbo3', log: '|tier|[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)\n' + LOG})});
  assert.deepEqual(good.replayWarnings, []);
});

test('cache rejects junction escapes', async t => {
  const args = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'vgcm-replay-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await mkdir(join(args.workspace, 'cache/team-metrics'), {recursive: true});
  try { await symlink(outside, join(args.workspace, 'cache/team-metrics/replays'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symbolic links unavailable.'); return; } throw error; }
  await assert.rejects(importReplayUrls({...args, fetchImpl: async () => response()}), /real directories/);
  assert.deepEqual(await readdir(outside), []);
});

test('cache does not overwrite an unrelated existing file', async t => {
  const args = await fixture(t);
  await mkdir(join(args.workspace, 'cache/team-metrics/replays'), {recursive: true});
  const path = join(args.workspace, 'cache/team-metrics/replays', createHash('sha256').update(ID).digest('hex') + '.json');
  await writeFile(path, 'User-owned content');
  await assert.rejects(importReplayUrls({...args, fetchImpl: async () => response()}), /cannot be overwritten/);
  assert.equal(await readFile(path, 'utf8'), 'User-owned content');
});

test('incomplete rereads cannot downgrade a complete cached replay or its stored metrics', async t => {
  const args = await fixture(t);
  await importReplayUrls({...args, fetchImpl: async () => response()});
  await importReplayUrls({...args, fetchImpl: async () => response({id: ID, log: LOG.split('\n|turn|')[0]})});
  const [cached] = await readdir(join(args.workspace, 'cache/team-metrics/replays'));
  assert.match(await readFile(join(args.workspace, 'cache/team-metrics/replays', cached), 'utf8'), /win/);
  const records = await listBattles({workspace: args.workspace});
  assert.equal(records.length, 1); assert.equal(records[0].completed, true); assert.equal(records[0].turns, 1);
});

test('concurrent imports for one replay preserve the complete observation', async t => {
  const args = await fixture(t);
  await Promise.all([
    importReplayUrls({...args, fetchImpl: async () => response()}),
    importReplayUrls({...args, fetchImpl: async () => response({id: ID, log: LOG.split('\n|turn|')[0]})}),
  ]);
  const [cached] = await readdir(join(args.workspace, 'cache/team-metrics/replays'));
  assert.match(await readFile(join(args.workspace, 'cache/team-metrics/replays', cached), 'utf8'), /win/);
  const records = await listBattles({workspace: args.workspace});
  assert.equal(records.length, 1); assert.equal(records[0].completed, true);
});

test('supplied team still passes through the normal observed-sheet compatibility check', async t => {
  const args = await fixture(t);
  const result = await importReplayUrls({...args, fetchImpl: async () => response({id: ID, log: LOG + '\n|showteam|p1|Pikachu||||thunderbolt||||||'})});
  assert.equal(result.imported, 0);
  assert.match(result.skipped[0].reason, /team sheet differs/);
  assert.deepEqual(await listBattles({workspace: args.workspace}), []);
});

test('a saved team ID uses its immutable snapshot after the original team file changes', async t => {
  const args = await fixture(t), saved = await registerTeamFromFile(args);
  const edited = TEAM.replace('32 HP / 32 SpA / 2 SpD', '31 HP / 32 SpA / 3 SpD');
  await writeFile(join(args.workspace, 'teams/team.txt'), edited);
  const result = await importReplayUrls({...args, teamFile: undefined, teamId: saved.teamId, fetchImpl: async () => response()});
  assert.equal(result.teamId, saved.teamId); assert.equal(result.imported, 1);
  assert.equal(result.team.name, saved.team.name);
  const records = await listBattles({workspace: args.workspace});
  assert.equal(records.length, 1); assert.equal(records[0].teamId, saved.teamId);
  assert.equal(await readFile(join(args.workspace, 'teams/team.txt'), 'utf8'), edited);
});
