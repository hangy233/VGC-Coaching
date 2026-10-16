import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSkillStatus, readSkill, syncSkill, verifySkillRead } from '../workflow/skill-service.mjs';
import { getReview, reviewStatus, saveReview } from '../workflow/reviews.mjs';
import { registerTeamFromText } from '../metrics/import.mjs';
import { saveBattle } from '../metrics/store.mjs';
import { saveGameEvidence, reviewedCheckpoint } from '../metrics/retention.mjs';
import { deleteTeamReport } from '../metrics/team-cleanup.mjs';
import { annotateGame } from '../metrics/annotations.mjs';

const ROOM = 'battle-gen9championsvgc2026regmcbo3-1002';
const PARENT = 'game-bestof3-gen9championsvgc2026regmcbo3-1001';
const TEAM = [['Golisopod', 'Emergency Exit'], ['Kommo-o', 'Soundproof'], ['Rillaboom', 'Grassy Surge'], ['Politoed', 'Drizzle'], ['Farigiraf', 'Armor Tail'], ['Sylveon', 'Pixilate']].map(([name, ability]) => `${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const write = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'vgc-workflow-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const source = join(workspace, 'skills/champions-mc-matchups'), target = join(workspace, 'installed/champions-mc-matchups');
  await write(join(source, 'SKILL.md'), '---\nname: champions-mc-matchups\ndescription: Fixture guidance\n---\nRead the cycle and use tool evidence.\n');
  await write(join(source, 'references/headless-battle-cycle.md'), 'Review each official set and preserve counterexamples.\n');
  await write(join(source, 'scripts/sync-skill.mjs'), await readFile(fileURLToPath(new URL('../skills/champions-mc-matchups/scripts/sync-skill.mjs', import.meta.url)), 'utf8'));
  await cp(source, target, { recursive: true });
  return { workspace, source, target, skillOptions: { target } };
}
function record(teamId, changes = {}) {
  return { schemaVersion: 1, roomId: ROOM, parentId: PARENT, teamId, username: 'Fixture', ownSide: 'p1', outcome: 'win', completed: true, turns: 1, players: { p1: 'Fixture', p2: 'Opponent' }, opponentRoster: ['Pikachu'], selected: ['Golisopod'], selectionKnown: false, leads: ['Golisopod'], pokemon: [{ key: 'golisopod', species: 'Golisopod', forms: [], selected: true, lead: true, moves: [{ move: 'Protect', uses: 1 }] }], quality: { complete: true, operational: false, warnings: [] }, team: { roster: ['Golisopod', 'Kommo-o', 'Rillaboom', 'Politoed', 'Farigiraf', 'Sylveon'], format: 'gen9championsvgc2026regmc' }, metadata: { setResult: { outcome: 'win', completed: true, expectedChildIds: [ROOM] } }, ...changes };
}
const events = () => [['gametype', 'doubles'], ['tier', '[Gen 9] Champions VGC 2026 Reg M-C (Bo3)'], ['player', 'p1', 'Fixture'], ['player', 'p2', 'Opponent'], ['start'], ['turn', '1'], ['move', 'p1a: Golisopod', 'Protect', 'p1a: Golisopod'], ['win', 'Fixture']].map(([type, ...data]) => ({ type, data }));
async function prepared(t) {
  const value = await fixture(t), { teamId } = await registerTeamFromText({ workspace: value.workspace, teamText: TEAM, name: 'Fixture team' });
  await saveBattle({ workspace: value.workspace, record: record(teamId) });
  await saveGameEvidence({ workspace: value.workspace, teamId, roomId: ROOM, events: events() });
  return { ...value, teamId };
}
const review = () => ({ decisionReview: [{ roomId: ROOM, turn: 1, knownBefore: 'Protect was present on the own sheet.', opposingRead: 'The opponent could attack either slot; no next-action claim is established.', selected: 'No private selected action journal was retained.', accepted: 'Unknown.', executed: 'Protect is in the observed protocol.', partnerProgress: 'The fixture contains no partner action evidence.', limitation: 'No feasible alternative can be validated from this abbreviated fixture.' }], positiveEvidence: [{ roomId: ROOM, turn: 1, observation: 'Protect executed.', whyPreserve: 'Preserve observed execution separately from unknown selection and intent.' }], executionAndVariance: [], reusableOutcome: { kind: 'no-change', reason: 'The short observed game supplies no new reusable tactical rule.', evidence: [{ roomId: ROOM, turn: 1, observation: 'Only Protect is observed; no numerical benchmark is claimed.' }] }, validation: [{ check: 'Evidence boundaries', result: 'Reviewed', evidence: 'Unknown selected/accepted choices were not inferred from an executed move.' }] });

test('skill status and read inspect every file and bind receipts to current source contents', async t => {
  const value = await fixture(t), status = await getSkillStatus(value);
  assert.equal(status.synchronized, true); assert.equal(status.files, 3);
  const read = await readSkill(value);
  assert.equal(read.filesRead.length, 3); assert(read.filesRead.some(file => file.path === 'references/headless-battle-cycle.md'));
  const adoption = await verifySkillRead({ ...value, readReceipt: read.readReceipt });
  assert.equal(adoption.syncVerified, true); assert.equal(adoption.sourceSha256, status.sourceSha256);
  await assert.rejects(verifySkillRead({ ...value, readReceipt: 'unchecked-boolean-is-not-a-receipt' }), /read the current complete/);
  await write(join(value.source, 'references/headless-battle-cycle.md'), 'New reviewed contents.\n');
  assert.equal((await getSkillStatus(value)).synchronized, false);
  await assert.rejects(verifySkillRead({ ...value, readReceipt: read.readReceipt }), /differ/);
});

test('skill sync is dry-run by default, uses a fixed script with backup and invalidates old reads', async t => {
  const value = await fixture(t), read = await readSkill(value);
  const changed = join(value.source, 'SKILL.md'), installed = join(value.target, 'SKILL.md'), before = await readFile(installed, 'utf8');
  await write(changed, before + 'A reviewed change.\n');
  const plan = await syncSkill(value); assert.equal(plan.dryRun, true); assert.equal(plan.changed, false);
  assert.equal(await readFile(installed, 'utf8'), before);
  await assert.rejects(syncSkill({ ...value, dryRun: false }), /confirmed:true/);
  const applied = await syncSkill({ ...value, dryRun: false, confirmed: true });
  assert.equal(applied.synchronized, true); assert.equal(applied.changed, true); assert.equal(applied.requiresRead, true);
  assert.equal(await readFile(join(applied.backup, 'SKILL.md'), 'utf8'), before);
  await assert.rejects(verifySkillRead({ ...value, readReceipt: read.readReceipt }), /read the current complete/);
  assert.equal((await verifySkillRead({ ...value, readReceipt: (await readSkill(value)).readReceipt })).syncVerified, true);
});

test('skill sync retains installed extras and rejects linked instruction paths', async t => {
  const value = await fixture(t);
  await write(join(value.target, 'personal.md'), 'Keep this independent file.\n');
  await write(join(value.source, 'SKILL.md'), 'Changed source.\n');
  await assert.rejects(syncSkill({ ...value, dryRun: false, confirmed: true }), /extra paths/);
  assert.equal(await readFile(join(value.target, 'personal.md'), 'utf8'), 'Keep this independent file.\n');
  const linked = join(value.source, 'linked');
  try { await symlink(value.target, linked, 'junction'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Link creation unavailable on this host.'); return; } throw error; }
  await assert.rejects(getSkillStatus(value), /link/);
});

test('BO3 review derives exact facts, verifies delivery and adoption, and exposes replay/intent limitations', async t => {
  const value = await prepared(t);
  const missing = await reviewStatus({ ...value, parentId: PARENT }); assert.equal(missing.complete, false); assert.equal(missing.exists, false);
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt: 'missing', ...review() }), /read the current complete/);
  const readReceipt = (await readSkill(value)).readReceipt;
  const saved = await saveReview({ ...value, parentId: PARENT, readReceipt, ...review() });
  assert.equal(saved.complete, true); assert.equal(saved.revision, 1); assert.equal(saved.checkpoint.officialResult.outcome, 'win');
  assert.deepEqual(saved.checkpoint.expectedChildIds, [ROOM]); assert.equal(saved.replayCoverage.verified, 0);
  assert.equal(saved.checkpoint.children[0].decisionEvidenceIncluded, false);
  assert.match(saved.checkpoint.children[0].decisionLimitation, /intent/);
  assert.equal(saved.checkpoint.metricsEvidence.cachedSheetMatch, true);
  assert.equal(reviewedCheckpoint(saved.checkpoint, { teamId: value.teamId, parentId: PARENT }), true);
  assert.equal((await reviewStatus({ ...value, parentId: PARENT })).complete, true);
  const queried = await getReview({ ...value, parentId: PARENT }); assert.equal(queried.checkpoint.revision, 1); assert.equal(queried.complete, true);
});

test('a completed parent with one missing recorded child cannot validate a partial BO3 review', async t => {
  const value=await fixture(t),{teamId}=await registerTeamFromText({workspace:value.workspace,teamText:TEAM});
  const second='battle-gen9championsvgc2026regmcbo3-1003';
  const metadata={setResult:{outcome:'win',completed:true,expectedChildIds:[ROOM,second]}};
  await saveBattle({workspace:value.workspace,record:record(teamId,{metadata})});
  await saveGameEvidence({workspace:value.workspace,teamId,roomId:ROOM,events:events()});
  const readReceipt=(await readSkill(value)).readReceipt,args={...value,teamId,parentId:PARENT,readReceipt,...review()};
  const partial=await reviewStatus(args);assert.equal(partial.complete,false);assert.deepEqual(partial.expectedChildIds,[ROOM,second]);assert.match(partial.blockers.join(' '),/expected child.*missing/i);
  await assert.rejects(saveReview({...args,expectedChildIds:[ROOM]}),/expected child.*missing/i);
  await saveBattle({workspace:value.workspace,record:record(teamId,{roomId:second,metadata})});
  await saveGameEvidence({workspace:value.workspace,teamId,roomId:second,events:events()});
  const saved=await saveReview(args);assert.equal(saved.complete,true);assert.deepEqual(saved.checkpoint.expectedChildIds,[ROOM,second]);
});

test('caller-provided child IDs cannot turn unknown parent membership into a complete review', async t => {
  const value=await fixture(t),{teamId}=await registerTeamFromText({workspace:value.workspace,teamText:TEAM});
  await saveBattle({workspace:value.workspace,record:record(teamId,{metadata:{setResult:{outcome:'win',completed:true}}})});
  await saveGameEvidence({workspace:value.workspace,teamId,roomId:ROOM,events:events()});
  const args={...value,teamId,parentId:PARENT,readReceipt:(await readSkill(value)).readReceipt,expectedChildIds:[ROOM],...review()};
  assert.match((await reviewStatus(args)).blockers.join(' '),/coverage is unknown/);
  await assert.rejects(saveReview(args),/coverage is unknown/);
});

test('review updates require optimistic revision and retain team-owned history for cascade deletion', async t => {
  const value = await prepared(t), readReceipt = (await readSkill(value)).readReceipt;
  await saveReview({ ...value, parentId: PARENT, readReceipt, ...review() });
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, ...review() }), /expectedRevision/);
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, expectedRevision: 0, ...review() }), /revision changed/);
  const updated = await saveReview({ ...value, parentId: PARENT, readReceipt, expectedRevision: 1, retrospective: true, ...review() });
  assert.equal(updated.revision, 2); assert.equal(updated.checkpoint.status, 'review-complete-retrospective');
  const historyName = `${PARENT}--${value.teamId}--r0001.json`;
  assert.equal(JSON.parse(await readFile(join(value.workspace, 'cache/champions-mc-reviews', historyName), 'utf8')).revision, 1);
  const plan = await deleteTeamReport({ workspace: value.workspace, teamId: value.teamId });
  assert(plan.files.some(file => file.path.endsWith(historyName)));
  const removed = await deleteTeamReport({ workspace: value.workspace, teamId: value.teamId, dryRun: false, confirmed: true });
  assert.equal(removed.complete, true);
  await assert.rejects(lstat(join(value.workspace, updated.checkpointFile)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(value.workspace, 'cache/champions-mc-reviews')), []);
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, ...review() }), /deleted/);
});

test('review rejects missing official results, mismatched references, invalid turns and changed skills', async t => {
  const value = await prepared(t), readReceipt = (await readSkill(value)).readReceipt;
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, expectedChildIds: [ROOM + '9'], ...review() }), /exactly match/);
  const badRef = review(); badRef.positiveEvidence[0].roomId += '9';
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, ...badRef }), /cite a child/);
  const badTurn = review(); badTurn.decisionReview[0].turn = 9;
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, ...badTurn }), /outside/);
  await write(join(value.source, 'SKILL.md'), 'Changed source pending review.\n');
  await assert.rejects(saveReview({ ...value, parentId: PARENT, readReceipt, ...review() }), /differ/);
  const incomplete = await fixture(t), { teamId } = await registerTeamFromText({ workspace: incomplete.workspace, teamText: TEAM });
  await saveBattle({ workspace: incomplete.workspace, record: record(teamId, { metadata: {} }) });
  await assert.rejects(saveReview({ ...incomplete, teamId, parentId: PARENT, readReceipt: (await readSkill(incomplete)).readReceipt, ...review() }), /official parent result/);
});

test('latest review status is explicit without prior sets and blocks new late child evidence', async t => {
  const empty = await fixture(t), { teamId } = await registerTeamFromText({ workspace: empty.workspace, teamText: TEAM });
  const none = await reviewStatus({ ...empty, teamId }); assert.equal(none.required, false); assert.equal(none.complete, true); assert.equal(none.reason, 'no-prior-recorded-set');
  const value = await prepared(t), readReceipt = (await readSkill(value)).readReceipt;
  await saveReview({ ...value, parentId: PARENT, readReceipt, ...review() });
  assert.equal((await reviewStatus(value)).parentId, PARENT);
  await saveBattle({ workspace: value.workspace, record: record(value.teamId, { roomId: ROOM + '1' }) });
  const late = await reviewStatus(value); assert.equal(late.complete, false); assert.match(late.blockers.join(' '), /exact stored child|changed after/);
  await assert.rejects(getReview({ ...value, teamId: 'b'.repeat(64), parentId: PARENT }), /another exact team/);
});

test('review status verifies retained bytes and detects changed report exclusions', async t => {
  const value = await prepared(t), readReceipt = (await readSkill(value)).readReceipt;
  const saved = await saveReview({ ...value, parentId: PARENT, readReceipt, ...review() });
  await annotateGame({ workspace: value.workspace, teamId: value.teamId, roomId: ROOM, action: 'exclude', reason: 'Fixture technical exclusion recorded after the original review.' });
  assert.match((await reviewStatus(value)).blockers.join(' '), /changed after/);
  const revised = await saveReview({ ...value, parentId: PARENT, readReceipt, expectedRevision: saved.revision, ...review() });
  assert.deepEqual(revised.checkpoint.metricsEvidence.excludedChildIds, [ROOM]);
  assert.equal((await reviewStatus(value)).complete, true);
  await writeFile(join(value.workspace, revised.checkpoint.children[0].evidence.path), 'corrupt compressed evidence');
  const broken = await reviewStatus(value); assert.equal(broken.complete, false); assert.match(broken.blockers.join(' '), /evidence could not be verified/);
});
