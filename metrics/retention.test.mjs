import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { saveBattle, listBattles } from './store.mjs';
import { attachVerifiedReplay } from './replay-evidence.mjs';
import { buildCleanupPlan, cleanupBo3Files, readGameEvidence, saveGameEvidence } from './retention.mjs';

const TEAM = 'a'.repeat(64), ROOM = 'battle-gen9championsvgc2026regmc-123', PARENT = 'game-bestof3-gen9championsvgc2026regmcbo3-44';
const URL = 'https://replay.pokemonshowdown.com/gen9championsvgc2026regmc-123';
const CHECKPOINT = `cache/champions-mc-reviews/${PARENT}.json`;
const { Teams } = createRequire(import.meta.url)('pokemon-showdown');
const target = `cache/bo3-runs/${PARENT}/events.jsonl`;
const record = overrides => ({ schemaVersion: 1, roomId: ROOM, parentId: PARENT, teamId: TEAM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', completed: true, turns: 2, players: { p1: 'TofuRotom', p2: 'Opponent' }, opponentRoster: ['Archaludon'], selected: ['Golisopod'], selectionKnown: false, leads: ['Golisopod'], pokemon: [{ key: 'golisopod', species: 'Golisopod', forms: [], selected: true, lead: true, moves: [{ move: 'Protect', uses: 1 }] }], quality: { complete: true, operational: false, warnings: [] }, team: { name: 'Rain team', format: 'gen9championsvgc2026regmc', roster: ['Golisopod'] }, metadata: { setResult: { outcome: 'win', completed: true }, sources: ['cache/events.jsonl'] }, ...overrides });
const protocol = [ ['gametype', 'doubles'], ['tier', '[Gen 9] Champions VGC 2026 Reg M-C'], ['player', 'p1', 'TofuRotom'], ['player', 'p2', 'Opponent'], ['start'], ['turn', '1'], ['move', 'p1a: Golisopod', 'Protect', 'p1a: Golisopod'], ['turn', '2'], ['move', 'p1a: Golisopod', 'Leech Life', 'p2a: Archaludon'], ['win', 'TofuRotom'] ];
const values = () => protocol.map(([type, ...data]) => ({ room: ROOM, event: 'battle-event', type, data }));
const replayFetch = async () => new Response(JSON.stringify({ id: ROOM.slice(7), log: protocol.map(parts => `|${parts.join('|')}`).join('\n') }));
const checkpoint = overrides => ({ parentId: PARENT, teamSha256: TEAM, reviewedAt: new Date().toISOString(), status: 'review-complete', decisionReview: { positive: 'Observed Protect executed.', limitation: 'No paired action journal supplied.' }, reusableOutcome: { action: 'no-change', reason: 'Insufficient evidence for a new general rule.' }, adoption: { sourceSha256: 'b'.repeat(64), installedSha256: 'b'.repeat(64), syncVerified: true }, children: [{ id: ROOM }], ...overrides });
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'vgc-retention-')); t.after(() => rm(dir, { recursive: true, force: true })); await saveBattle({ workspace: dir, record: record() }); return dir; }
async function write(dir, file, content) { await mkdir(dirname(join(dir, file)), { recursive: true }); await writeFile(join(dir, file), content); }
const sourceText = () => values().map(value => JSON.stringify(value)).join('\n') + '\n';
async function prepared(t) { const dir = await workspace(t); await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: values() }); await attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: URL, fetchImpl: replayFetch }); await write(dir, CHECKPOINT, JSON.stringify(checkpoint())); await write(dir, target, sourceText()); return dir; }
const args = dir => ({ workspace: dir, teamId: TEAM, parentId: PARENT, checkpointFile: CHECKPOINT });

test('canonical evidence retains state, sheets and explicit decision phases while removing credentials and chat', async t => {
  const dir = await workspace(t), events = values();
  events.splice(6, 0,
    { room: `${ROOM}-hiddenpw`, event: 'request', request: { rqid: 3, password: 'NEVER-PERSIST', assertion: 'NEVER-PERSIST', active: [{ moves: ['private'] }], side: { id: 'p1', name: 'TofuRotom', pokemon: [{ ident: 'p1: Golisopod', details: 'Golisopod, L50', condition: '100/100', active: true, password: 'NEVER-PERSIST' }] } } },
    { room: ROOM, event: 'action-status', status: 'selected', turn: 1, selected: true, accepted: false, actions: ['move 1, move 2'], password: 'NEVER-PERSIST' },
    { room: ROOM, event: 'action-status', status: 'accepted', turn: 1, accepted: true, executed: false },
    { room: ROOM, event: 'action-status', status: 'execution-observed', turn: 1, evidence: { type: 'move', move: 'Protect', executed: true, assertion: 'NEVER-PERSIST' } },
    { room: ROOM, event: 'battle-event', type: 'c', data: ['Opponent', 'NEVER-PERSIST'] },
    { room: ROOM, event: 'battle-event', type: '-message', data: ['NEVER-PERSIST https://play.pokemonshowdown.com/secret'] },
    { room: ROOM, event: 'sheet', side: 'p2', packed: Teams.pack([{ species: 'Archaludon', moves: ['Protect'] }]) },
  );
  const saved = await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events });
  assert.equal(saved.complete, true); assert.equal(saved.decisionEvidenceIncluded, true);
  const read = await readGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM });
  const serialized = JSON.stringify(read);
  assert.ok(!serialized.includes('NEVER-PERSIST')); assert.ok(!serialized.includes('hiddenpw')); assert.ok(!serialized.includes('secret')); assert.ok(!serialized.includes('password'));
  assert.equal(read.sheets.p2.split('|')[0], 'Archaludon');
  assert.equal(read.decisions[0].status, 'selected'); assert.equal(read.decisions[0].accepted, false);
  assert.equal(read.decisions[1].status, 'accepted'); assert.equal(read.decisions[1].executed, false);
  assert.equal(read.decisions[2].evidence.executed, true);
  const window = await readGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, fromTurn: 2, toTurn: 2 });
  assert.ok(window.events.some(event => event.type === 'player')); assert.ok(!window.events.some(event => event.type === 'turn' && event.data[0] === '1')); assert.ok(window.events.some(event => event.type === 'turn' && event.data[0] === '2')); assert.equal(window.decisions.length, 0);
});

test('preview journals retain legal team order and unknown acceptance without inventing execution or defaults',async t=>{
  const dir=await workspace(t),events=values();
  events.splice(4,0,
    {room:ROOM,event:'decision',phase:'preview',status:'selected',turn:0,rqid:1,selected:true,actions:[{type:'team',order:[4,2,1,3],password:'NEVER-PERSIST'}]},
    {room:ROOM,event:'decision',phase:'preview',status:'sent',turn:0,rqid:1,submitted:true,actions:[{type:'team',order:[4,2,1,3]}]},
    {room:ROOM,event:'decision',phase:'preview',status:'unknown',turn:0,rqid:1,submitted:true,reason:'Server acceptance was not observed.',evidence:{type:'preview-transition',transition:'battle-start',assertion:'NEVER-PERSIST'}},
  );
  await saveGameEvidence({workspace:dir,teamId:TEAM,roomId:ROOM,events});
  const read=await readGameEvidence({workspace:dir,teamId:TEAM,roomId:ROOM,fromTurn:2,toTurn:2});
  assert.deepEqual(read.decisions.map(value=>value.status),['selected','sent','unknown']);assert(read.decisions.every(value=>value.phase==='preview'&&value.turn===0));
  assert.deepEqual(read.decisions[0].actions,[{type:'team',order:[4,2,1,3]}]);
  assert.equal(read.decisions[2].accepted,undefined);assert.equal(read.decisions[2].executed,undefined);assert.equal(read.decisions[2].serverDefaulted,undefined);
  assert.equal(read.decisions[2].evidence.transition,'battle-start');assert(!JSON.stringify(read).includes('NEVER-PERSIST'));
});

test('partial evidence can complete but cannot downgrade completed evidence or rewrite conflicting history', async t => {
  const dir = await workspace(t);
  const partial = await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: values().slice(0, -1) }); assert.equal(partial.complete, false);
  const complete = await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: values() }); assert.equal(complete.complete, true);
  const preserved = await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: values().slice(0, 7) }); assert.equal(preserved.status, 'preserved'); assert.equal(preserved.evidence.sha256, complete.evidence.sha256);
  assert.equal((await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: values() })).status, 'unchanged');
  const conflicting = values(); conflicting[6].data[1] = 'Sucker Punch';
  await assert.rejects(saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events: conflicting }), /completed evidence differs/);
});

test('completed canonical evidence keeps historical player identity when either player leaves afterward', async t => {
  for (const side of ['p1', 'p2']) {
    const dir = await workspace(t), events = [...values(), { room: ROOM, type: 'player', data: [side, ''] }];
    const saved = await saveGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM, events });
    assert.equal(saved.complete, true);
    const read = await readGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM });
    assert.equal(read.complete, true); assert.deepEqual(read.events.at(-1), { type: 'player', data: [side, ''] });
  }
});

test('corrupt canonical evidence fails reads and cleanup without deleting the source', async t => {
  const dir = await prepared(t), game = (await listBattles({ workspace: dir }))[0];
  await writeFile(join(dir, game.metadata.evidence.path), gzipSync('{}'));
  await assert.rejects(readGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM }), /hash verification failed/);
  const plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.ready, false); assert.match(plan.blockers.join(' '), /failed verification/);
  const cleaned = await cleanupBo3Files({ ...args(dir), files: [target], confirmed: true }); assert.equal(cleaned.removedCount, 0); assert.equal(await readFile(join(dir, target), 'utf8'), sourceText());
});

test('verified replay fallback exposes no invented private selection or decision journal', async t => {
  const dir = await workspace(t); await attachVerifiedReplay({ workspace: dir, teamId: TEAM, roomId: ROOM, url: URL, fetchImpl: replayFetch });
  const read = await readGameEvidence({ workspace: dir, teamId: TEAM, roomId: ROOM });
  assert.equal(read.sourceKind, 'verified-replay'); assert.equal(read.decisionEvidenceIncluded, false); assert.equal(read.decisions.length, 0); assert.equal(read.complete, true);
});

test('dry-run is read-only and confirmed cleanup removes exact generated files while protecting useful data', async t => {
  const dir = await prepared(t), keep = 'cache/bo3-runs/' + PARENT + '/review.json';
  const temp = `cache/bo3-runs/${PARENT}/scratch.tmp`;
  await write(dir, keep, '{"useful":true}'); await write(dir, temp, 'scratch');
  const before = await stat(join(dir, target));
  const plan = await buildCleanupPlan({ ...args(dir), files: [target, keep, temp, CHECKPOINT] });
  assert.equal(plan.ready, true); assert.equal(plan.eligibleCount, 2); assert.equal(plan.blocked.length, 2); assert.equal((await stat(join(dir, target))).mtimeMs, before.mtimeMs);
  await assert.rejects(cleanupBo3Files({ ...args(dir), files: [target] }), /dry-run/);
  const result = await cleanupBo3Files({ ...args(dir), files: [target, keep, temp, CHECKPOINT], confirmed: true });
  assert.equal(result.removedCount, 2); assert.equal(result.keptCount, 2);
  await assert.rejects(readFile(join(dir, target)), { code: 'ENOENT' }); assert.equal(await readFile(join(dir, keep), 'utf8'), '{"useful":true}'); assert.ok(await readFile(join(dir, CHECKPOINT), 'utf8'));
});

test('cleanup requires the exact reviewed team, adopted skill hash and all expected registered children', async t => {
  const dir = await prepared(t);
  for (const wrong of [checkpoint({ teamSha256: 'c'.repeat(64) }), checkpoint({ status: 'pending' }), checkpoint({ adoption: { syncVerified: true, sourceSha256: TEAM, installedSha256: 'c'.repeat(64) } }), checkpoint({ children: [{ id: `${ROOM}4` }] }), checkpoint({ decisionReview: {} })]) {
    await write(dir, CHECKPOINT, JSON.stringify(wrong)); const plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.ready, false); assert.equal(plan.files[0].eligible, false);
  }
  assert.equal(await readFile(join(dir, target), 'utf8'), sourceText());
});

test('a mixed-room or unrecognized log is retained even inside the completed set directory', async t => {
  const dir = await prepared(t);
  await write(dir, target, sourceText() + JSON.stringify({ room: 'battle-gen9championsvgc2026regmc-999', type: 'turn', data: ['1'] }) + '\n');
  let plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.files[0].eligible, false); assert.match(plan.files[0].reason, /another or unknown room/);
  await write(dir, target, JSON.stringify({ event: 'debug', text: 'No room or covered evidence' }) + '\n');
  plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.files[0].eligible, false); assert.match(plan.files[0].reason, /no verified room/);
  await write(dir, CHECKPOINT, JSON.stringify(checkpoint({ children: undefined })));
  plan = await buildCleanupPlan({ ...args(dir), files: [] }); assert.equal(plan.ready, false); assert.match(plan.blockers.join(' '), /enumerate/);
});

test('same-room new turns, decisions, sheets and unknown JSON remain protected until retained', async t => {
  const dir = await prepared(t);
  const sources = [
    [...values(), { room: ROOM, type: 'turn', data: ['3'] }],
    [...values(), { room: ROOM, event: 'action-status', status: 'accepted', turn: 2, accepted: true }],
    [...values(), { room: ROOM, event: 'sheet', side: 'p2', packed: Teams.pack([{ species: 'Archaludon', moves: ['Protect'] }]) }],
    [...values(), { room: ROOM, event: 'calculation', tool: 'calculate_damage', result: 'unarchived useful data' }],
  ];
  for (const source of sources) {
    await write(dir, target, source.map(value => JSON.stringify(value)).join('\n') + '\n');
    const plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.files[0].eligible, false); assert.match(plan.files[0].reason, /absent|unarchived/);
  }
  const json = `cache/bo3-runs/${PARENT}/unknown.json`; await write(dir, json, JSON.stringify({ useful: true }));
  const plan = await buildCleanupPlan({ ...args(dir), files: [json] }); assert.equal(plan.files[0].eligible, false);
});

test('parent results are removable only when their whitelisted facts match the retained official outcome', async t => {
  const dir = await prepared(t);
  const parent = { room: PARENT, event: 'result', type: 'win', winner: 'TofuRotom', at: Date.now() };
  await write(dir, target, sourceText() + JSON.stringify(parent) + '\n');
  let plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.files[0].eligible, true);
  for (const unsafe of [{ ...parent, winner: 'Opponent' }, { ...parent, privateDecisionReview: 'Useful and not archived' }, { ...parent, type: 'tie' }]) {
    await write(dir, target, sourceText() + JSON.stringify(unsafe) + '\n');
    plan = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(plan.files[0].eligible, false); assert.match(plan.files[0].reason, /Parent source/);
  }
});

test('registered shared logs, active session files, other-parent files and linked files remain protected', async t => {
  const dir = await prepared(t), shared = `cache/bo3-runs/${PARENT}/shared.jsonl`, other = 'cache/bo3-runs/game-bestof3-gen9championsvgc2026regmcbo3-45/events.log';
  await write(dir, shared, 'shared'); await write(dir, other, 'other');
  await write(dir, 'cache/team-metrics/sources/registry.json', JSON.stringify([{ files: [shared] }]));
  await write(dir, 'cache/showdown-session.json', JSON.stringify({ pid: process.pid, capability: 'NEVER-PRINT' }));
  const plan = await buildCleanupPlan({ ...args(dir), files: [shared, other, 'cache/showdown-session.json'] });
  assert.equal(plan.activeClient, true); assert.equal(plan.eligibleCount, 0); assert.ok(plan.blocked.every(entry => entry.reason)); assert.ok(!JSON.stringify(plan).includes('NEVER-PRINT'));
  const open = await buildCleanupPlan({ ...args(dir), files: [target] }); assert.equal(open.files[0].eligible, false); assert.match(open.files[0].reason, /open client/);
  const closed = await buildCleanupPlan({ ...args(dir), files: [target, shared], closedFiles: [target, shared] }); assert.equal(closed.files[0].eligible, true); assert.equal(closed.files[1].eligible, false);
  const linked = `cache/bo3-runs/${PARENT}/linked.log`;
  try { await symlink(join(dir, shared), join(dir, linked)); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Windows symbolic links unavailable; other active/protected guards verified.'); return; } throw error; }
  const links = await buildCleanupPlan({ ...args(dir), files: [linked] }); assert.equal(links.files[0].eligible, false);
});
