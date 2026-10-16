import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { attachVerifiedReplay, canonicalReplayUrl, fetchVerifiedReplay, normalizeReplayReference } from './replay-evidence.mjs';
import { getTeamReport, listBattles, listTeams, saveBattle, updateBattleMetadata } from './store.mjs';

const TEAM = 'a'.repeat(64), ROOM = 'battle-gen9championsvgc2026regmc-123';
const URL = 'https://replay.pokemonshowdown.com/gen9championsvgc2026regmc-123';
const LOG = '|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C\n|player|p1|TofuRotom\n|player|p2|Opponent\n|start\n|turn|1\n|move|p1a: Golisopod|Protect|p1a: Golisopod\n|win|TofuRotom\n';
const record = overrides => ({ schemaVersion: 1, roomId: ROOM, parentId: 'bestof3-gen9championsvgc2026regmc-22', teamId: TEAM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', completed: true, turns: 1, players: { p1: 'TofuRotom', p2: 'Opponent' }, opponentRoster: ['Archaludon'], selected: ['Golisopod', 'Farigiraf', 'Rillaboom', 'Sylveon'], selectionKnown: true, leads: ['Golisopod', 'Farigiraf'], pokemon: [{ key: 'golisopod', species: 'Golisopod', forms: [], selected: true, lead: true, moves: [{ move: 'Protect', uses: 1 }] }], quality: { complete: true, operational: false, warnings: [] }, team: { name: 'Rain team', format: 'gen9championsvgc2026regmc', roster: ['Golisopod', 'Farigiraf', 'Rillaboom', 'Sylveon'] }, metadata: { sources: ['cache/events.jsonl'] }, ...overrides });
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'vgc-replay-evidence-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function fetcher(payload = { id: ROOM.slice(7), formatid: 'gen9championsvgc2026regmc', log: LOG }, inspect) {
  return async (url, options) => { inspect?.(url, options); return new Response(JSON.stringify(payload), { status: 200 }); };
}

test('canonical replay validation accepts official saved links and keeps private capabilities only in URL', () => {
  assert.equal(canonicalReplayUrl(`${URL}.json`, { roomId: ROOM }).url, URL);
  assert.equal(canonicalReplayUrl(`${URL}-secretpw.log`).url, `${URL}-secretpw`);
  for (const value of ['http://replay.pokemonshowdown.com/gen9championsvgc2026regmc-123', 'https://example.com/gen9championsvgc2026regmc-123', `${URL}?key=abc`, `${URL}#abc`, 'https://play.pokemonshowdown.com/battle-gen9championsvgc2026regmc-123', 'https://replay.pokemonshowdown.com/gen9ou-123', ` ${URL}`]) assert.throws(() => canonicalReplayUrl(value));
  assert.throws(() => canonicalReplayUrl(URL, { roomId: `${ROOM}4` }));
  assert.throws(() => normalizeReplayReference({ url: URL, verified: false, logSha256: TEAM, verifiedAt: new Date().toISOString() }));
});

test('fetch checks owner, exact game, completion, result and format without exposing private errors', async () => {
  const replay = await fetchVerifiedReplay({ url: `${URL}-secretpw`, roomId: ROOM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', fetchImpl: fetcher({ id: `${ROOM.slice(7)}-secretpw`, log: `${LOG}|c|Opponent|hidden chat\n|request|{"password":"secret"}\n|-message|secretpw\n` }, (url, options) => {
    assert.equal(url, `${URL}-secretpw.json`); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  }) });
  assert.equal(replay.metadata.url, `${URL}-secretpw`);
  assert.match(replay.metadata.logSha256, /^[a-f0-9]{64}$/);
  assert.ok(!replay.log.includes('hidden chat')); assert.ok(!replay.log.includes('secret'));
  const invalid = [
    { id: `${ROOM.slice(7)}4`, log: LOG },
    { id: ROOM.slice(7), log: LOG.replace('|start\n', '') },
    { id: ROOM.slice(7), log: LOG.replace('|win|TofuRotom', '|upkeep') },
    { id: ROOM.slice(7), log: LOG.replace('|player|p1|TofuRotom', '|player|p1|Other') },
    { id: ROOM.slice(7), log: LOG, formatid: 'gen9ou' },
    { id: ROOM.slice(7), log: LOG.replace('|win|TofuRotom', '|win|Opponent') },
    { id: ROOM.slice(7), log: `${LOG}|win|TofuRotom\n` },
  ];
  for (const payload of invalid) await assert.rejects(fetchVerifiedReplay({ url: URL, roomId: ROOM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', fetchImpl: fetcher(payload) }), /could not be verified/);
  await assert.rejects(fetchVerifiedReplay({ url: `${URL}-secretpw`, roomId: ROOM, username: 'TofuRotom', fetchImpl: async () => { throw new Error(`${URL}-secretpw`); } }), error => !error.message.includes('secretpw'));
});

test('verified replay retains historical owner and opponent identities after empty player departure lines', async () => {
  for (const side of ['p1', 'p2']) {
    const replay = await fetchVerifiedReplay({ url: URL, roomId: ROOM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', fetchImpl: fetcher({ id: ROOM.slice(7), log: `${LOG}|player|${side}|\n` }) });
    assert.equal(replay.outcome, 'win'); assert.ok(replay.log.endsWith(`|player|${side}|\n`));
  }
  await assert.rejects(fetchVerifiedReplay({ url: URL, roomId: ROOM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', fetchImpl: fetcher({ id: ROOM.slice(7), log: `${LOG}|player|p1|OtherNamedPlayer\n` }) }), /could not be verified/);
});

test('verified replay evidence survives reimport and appears in a game drilldown without LRU changes', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  const before = (await listTeams({ workspace: dir }))[0].usageOrder;
  const attached = await attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: `${URL}-privatepw`, fetchImpl: fetcher() });
  assert.equal(attached.replay.url, `${URL}-privatepw`);
  assert.ok(attached.replay.evidencePath.endsWith('.replay.log.gz'));
  assert.equal(gunzipSync(await readFile(join(dir, attached.replay.evidencePath))).toString(), LOG);
  assert.equal((await listTeams({ workspace: dir }))[0].usageOrder, before);
  assert.equal((await attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: `${URL}-privatepw`, fetchImpl: fetcher() })).status, 'unchanged');
  const incoming = record({ selected: ['Golisopod'], selectionKnown: false, parentId: null });
  await saveBattle({ workspace: dir, record: incoming });
  const report = await getTeamReport({ workspace: dir, teamId: TEAM, touch: false });
  assert.equal(report.games.length, 1);
  assert.equal(report.games[0].replay.url, `${URL}-privatepw`);
  assert.equal(report.games[0].parentId, 'bestof3-gen9championsvgc2026regmc-22');
  assert.equal(report.games[0].selected.length, 4);
  assert.equal(report.pokemon[0].moves[0].uses, 1);
});

test('metadata-only provenance patch preserves counters and validates exact durable evidence identity', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record({ turns: 4 }) });
  const evidence = { path: `cache/team-metrics/evidence/${ROOM}--${TEAM}.events.json.gz`, sha256: TEAM, complete: true, kind: 'sanitized-events', version: 1 };
  const updated = await updateBattleMetadata({ workspace: dir, teamId: TEAM, roomId: ROOM, metadata: { evidence } });
  assert.equal(updated.record.turns, 4);
  assert.deepEqual(updated.record.metadata.evidence, evidence);
  await saveBattle({ workspace: dir, record: record() });
  assert.deepEqual((await listBattles({ workspace: dir }))[0].metadata.evidence, evidence);
  await assert.rejects(updateBattleMetadata({ workspace: dir, teamId: TEAM, roomId: ROOM, metadata: { evidence: { ...evidence, path: 'cache/another.events.json.gz' } } }));
  await assert.rejects(updateBattleMetadata({ workspace: dir, teamId: TEAM, roomId: ROOM, metadata: { sources: [URL] } }));
});

test('concurrent replay attachments share immutable evidence and refuse a later conflicting protocol', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  await Promise.all(Array.from({ length: 4 }, () => attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: URL, fetchImpl: fetcher() })));
  const saved = (await listBattles({ workspace: dir }))[0];
  const bytes = await readFile(join(dir, saved.metadata.replay.evidencePath));
  assert.equal(gunzipSync(bytes).toString(), LOG);
  await assert.rejects(attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: URL, fetchImpl: fetcher({ id: ROOM.slice(7), log: LOG.replace('|turn|1', '|turn|2') }) }), /differs/);
  assert.deepEqual(await readFile(join(dir, saved.metadata.replay.evidencePath)), bytes);
  assert.equal((await listBattles({ workspace: dir }))[0].metadata.replay.logSha256, saved.metadata.replay.logSha256);
});

test('stale metadata-only callers cannot replace newer counters or downgrade complete local evidence', async t => {
  const dir = await workspace(t);
  const stale = record();
  await saveBattle({ workspace: dir, record: stale });
  await saveBattle({ workspace: dir, record: record({ turns: 5, pokemon: [{ ...stale.pokemon[0], moves: [{ move: 'Protect', uses: 5 }] }] }) });
  const evidence = { path: `cache/team-metrics/evidence/${ROOM}--${TEAM}.events.json.gz`, sha256: TEAM, complete: true, kind: 'sanitized-events', version: 1 };
  await saveBattle({ workspace: dir, record: { ...stale, metadata: { evidence } }, metadataOnly: true });
  await updateBattleMetadata({ workspace: dir, teamId: TEAM, roomId: ROOM, metadata: { evidence: { ...evidence, complete: false } } });
  const saved = (await listBattles({ workspace: dir }))[0];
  assert.equal(saved.turns, 5); assert.equal(saved.pokemon[0].moves[0].uses, 5); assert.equal(saved.metadata.evidence.complete, true);
});
