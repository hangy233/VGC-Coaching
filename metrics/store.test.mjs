import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveBattle, listBattles, listTeams, getTeamReport, registerMetricsTeam, restoreMetricsTeam, isMetricsTeamActive, MAX_ACTIVE_TEAMS } from './store.mjs';
import {exportReport} from './dashboard.mjs';

const TEAM = 'a'.repeat(64);
const OTHER_TEAM = 'b'.repeat(64);
function record(overrides = {}) {
  return {
    schemaVersion: 1, roomId: 'battle-gen9championsvgc2026regmc-123', parentId: 'bestof3-gen9championsvgc2026regmc-20',
    teamId: TEAM, username: 'TofuRotom', ownSide: 'p1', outcome: 'win', completed: true, turns: 7,
    players: { p1: 'TofuRotom', p2: 'Opponent' },
    opponentRoster: ['Archaludon', 'Charizard'], selected: ['Golisopod', 'Farigiraf'], selectionKnown: true, leads: ['Farigiraf'],
    pokemon: [{
      key: 'golisopod', species: 'Golisopod', forms: ['Golisopod-Mega'], selected: true, lead: false,
      switchIns: 1, faints: 0, knockouts: 2, indirectKnockouts: 0, itemRemovals: 1, couldNotAct: 1,
      moves: [
        { move: 'Knock Off', uses: 2, calledUses: 1, failed: 0, missed: 0, blocked: 0, knockouts: 1, itemRemovals: 1 },
        { move: 'Protect', uses: 1, failed: 1, missed: 0, blocked: 0, knockouts: 0, itemRemovals: 0 },
      ],
    }],
    quality: { complete: true, operational: false, warnings: [] },
    team: { name: 'Rain core', format: 'gen9championsvgc2026regmc', roster: ['Golisopod', 'Farigiraf', 'Rillaboom'] },
    metadata: { sources: ['cache/battle-events.jsonl'], startedAt: '2026-10-15T10:00:00Z', endedAt: '2026-10-15T10:05:00Z' },
    ...overrides,
  };
}
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vgc-team-metrics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('idempotent reimport preserves per-Pokémon move, knockout and item-removal totals', async t => {
  const dir = await workspace(t);
  const first = await saveBattle({ workspace: dir, record: record() });
  assert.equal(first.status, 'created');
  const again = await saveBattle({ workspace: dir, record: record() });
  assert.equal(again.status, 'unchanged');
  assert.equal((await readdir(join(dir, 'cache', 'team-metrics'))).filter(name => name.endsWith('.json')).length, 1);
  const report = await getTeamReport({ workspace: dir, teamId: TEAM });
  assert.equal(report.totals.games, 1);
  assert.equal(report.totals.winRate, 100);
  assert.equal(report.totals.winRateDenominator, 1);
  const golisopod = report.pokemon.find(pokemon => pokemon.species === 'Golisopod');
  assert.equal(golisopod.knockouts, 2);
  assert.equal(golisopod.itemRemovals, 1);
  assert.equal(golisopod.couldNotAct, 1);
  assert.equal(golisopod.selectedGames, 1);
  assert.equal(golisopod.selectionDenominator, 1);
  assert.equal(golisopod.moves[0].move, 'Knock Off');
  assert.equal(golisopod.moves[0].uses, 2);
  assert.equal(golisopod.moves[0].knockouts, 1);
  assert.equal(golisopod.moves[0].itemRemovals, 1);
  assert.equal(golisopod.moves[0].calledUses, 1);
  assert.equal(golisopod.moves[0].usageDenominator, 3);
  assert.equal(golisopod.moves[0].usagePercent, 2 / 3 * 100);
  assert.equal(report.pokemon.find(pokemon => pokemon.species === 'Rillaboom').selectedGames, 0);
  assert.deepEqual(golisopod.forms, ['Golisopod-Mega']);
});

test('a partial reimport cannot erase a complete record but can add ledger attribution', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  const saved = await saveBattle({ workspace: dir, record: record({
    completed: false, outcome: 'unknown', turns: 1, pokemon: [], selected: [], selectionKnown: false,
    quality: { complete: false, operational: true, warnings: ['Pilot defaulted a choice'] },
    metadata: { sources: ['cache/recovered-events.jsonl'], ledgerIndex: 10, attribution: 'Reviewed operational default', setResult: { outcome: 'loss', completed: true } },
  }) });
  assert.equal(saved.status, 'preserved');
  assert.equal(saved.record.turns, 7);
  assert.equal(saved.record.outcome, 'win');
  assert.equal(saved.record.quality.complete, true);
  assert.equal(saved.record.quality.operational, true);
  assert.equal(saved.record.pokemon[0].knockouts, 2);
  assert.equal(saved.record.metadata.ledgerIndex, 10);
  assert.deepEqual(saved.record.metadata.sources, ['cache/battle-events.jsonl', 'cache/recovered-events.jsonl']);
  assert.equal((await getTeamReport({ workspace: dir, teamId: TEAM })).totals.games, 0);
  assert.equal((await getTeamReport({ workspace: dir, teamId: TEAM, includeOperational: true })).totals.sets.losses, 1);
});

test('exact team versions occupy distinct files even when the room is the same', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  await saveBattle({ workspace: dir, record: record({ teamId: OTHER_TEAM, outcome: 'loss', team: { name: 'Revised rain', roster: ['Golisopod', 'Sylveon'] } }) });
  assert.equal((await listBattles({ workspace: dir })).length, 2);
  assert.equal((await listTeams({ workspace: dir })).length, 2);
  assert.equal((await getTeamReport({ workspace: dir, teamId: TEAM })).totals.wins, 1);
  assert.equal((await getTeamReport({ workspace: dir, teamId: OTHER_TEAM })).totals.losses, 1);
  await assert.rejects(getTeamReport({ workspace: dir }), /choose a teamId/u);
});

test('incomplete starts and operational games are excluded with disjoint exclusion counts', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-2', quality: { complete: false, operational: false, warnings: ['Missing start'] } }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-3', quality: { complete: true, operational: true, warnings: ['Inactivity'] } }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-4', quality: { complete: false, operational: true, warnings: ['Missing start', 'Inactivity'] } }) });
  const normal = await getTeamReport({ workspace: dir });
  assert.equal(normal.totals.games, 1);
  assert.equal(normal.quality.storedGames, 4);
  assert.equal(normal.quality.incompleteGames, 2);
  assert.equal(normal.quality.operationalGames, 2);
  assert.equal(normal.quality.incompleteOperationalGames, 1);
  assert.equal(normal.quality.excludedIncomplete, 2);
  assert.equal(normal.quality.excludedOperational, 1);
  assert.equal(normal.quality.excludedTotal, 3);
  const incomplete = await getTeamReport({ workspace: dir, includeIncomplete: true });
  assert.equal(incomplete.totals.games, 2);
  assert.equal(incomplete.quality.excludedIncomplete, 0);
  assert.equal(incomplete.quality.excludedOperational, 2);
  assert.equal((await getTeamReport({ workspace: dir, includeIncomplete: true, includeOperational: true })).totals.games, 4);
});

test('selection rates do not treat unknown selections as zero or include ties in win-rate denominators', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-2', outcome: 'tie' }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-3', outcome: 'loss', selectionKnown: false, selected: ['Golisopod'] }) });
  const report = await getTeamReport({ workspace: dir });
  assert.equal(report.totals.winRate, 50);
  assert.equal(report.totals.winRateDenominator, 2);
  assert.equal(report.selection.gamesWithSelection, 2);
  assert.equal(report.selection.gamesWithoutSelection, 1);
  const golisopod = report.pokemon.find(pokemon => pokemon.species === 'Golisopod');
  assert.equal(golisopod.selectedGames, 2);
  assert.equal(golisopod.observedSelectedGames, 3);
  assert.equal(golisopod.selectionDenominator, 2);
  assert.equal(golisopod.selectionRate, 100);
  assert.equal(golisopod.selectionWinRateDenominator, 1);
  assert.equal(golisopod.selectionWinRate, 100);
});

test('a child win never establishes a BO3 result without explicit completed parent evidence', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  let sets = (await getTeamReport({ workspace: dir })).totals.sets;
  assert.equal(sets.played, 1);
  assert.equal(sets.wins, 0);
  assert.equal(sets.unknown, 1);
  assert.equal(sets.incomplete, 1);
  assert.equal(sets.winRate, null);
  await saveBattle({ workspace: dir, record: record({ metadata: { setResult: { outcome: 'win', completed: true } } }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-2', outcome: 'loss' }) });
  sets = (await getTeamReport({ workspace: dir })).totals.sets;
  assert.equal(sets.played, 1);
  assert.equal(sets.wins, 1);
  assert.equal(sets.incomplete, 0);
  assert.equal(sets.records[0].source, 'official');
});

test('roster, selection, outcome and date filters select games without claiming enemy selection', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-test-2', outcome: 'loss', opponentRoster: ['Sableye'], selected: ['Farigiraf'], pokemon: [], metadata: { endedAt: '2026-10-14T10:00:00Z' } }) });
  const report = await getTeamReport({ workspace: dir, opponentSpecies: 'ARCHALUDON', selectedSpecies: 'Golisopod', outcome: 'win', from: '2026-10-15T00:00:00Z', to: '2026-10-16T00:00:00Z' });
  assert.equal(report.totals.games, 1);
  assert.deepEqual(report.opponents.map(entry => entry.species), ['Archaludon', 'Charizard']);
  assert.equal(report.games[0].opponent, 'Opponent');
  assert.equal(report.quality.matchingGames, 1);
  assert.equal(report.quality.storedGames, 2);
  assert.match(report.definitions.opponentMatchups, /not inferred selection/u);
});

test('concurrent reimports serialize and never multiply aggregate counts', async t => {
  const dir = await workspace(t);
  await Promise.all(Array.from({ length: 15 }, () => saveBattle({ workspace: dir, record: record() })));
  assert.equal((await listBattles({ workspace: dir })).length, 1);
  const report = await getTeamReport({ workspace: dir });
  assert.equal(report.totals.games, 1);
  assert.equal(report.pokemon.find(entry => entry.species === 'Golisopod').moves[0].uses, 2);
  assert.equal((await readdir(join(dir, 'cache', 'team-metrics'))).filter(name => name.endsWith('.tmp')).length, 0);
});

test('stored rows whitelist fields and reject unsafe identities, sources and counters', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record({ rawLog: 'PRIVATE PROTOCOL', password: 'SECRET', metadata: { rawLog: 'SECRET', token: 'SECRET', sources: ['cache/review.json'] } }) });
  const [stored] = await listBattles({ workspace: dir });
  assert.equal(stored.rawLog, undefined);
  assert.equal(stored.password, undefined);
  assert.equal(stored.metadata.rawLog, undefined);
  const file = join(dir, 'cache', 'team-metrics', `${stored.roomId}--${TEAM}.json`);
  assert.doesNotMatch(await readFile(file, 'utf8'), /PRIVATE PROTOCOL|SECRET/u);
  for (const roomId of ['../../outside', 'battle-test-1-secretpw?', 'battle-test-1-secretpw', 'BATTLE-TEST', 'battle-test-1/secret']) {
    await assert.rejects(saveBattle({ workspace: dir, record: record({ roomId }) }), /normalized room ID/u);
  }
  await assert.rejects(saveBattle({ workspace: dir, record: record({ teamId: '../other' }) }), /SHA-256/u);
  await assert.rejects(saveBattle({ workspace: dir, record: record({ metadata: { sources: ['../outside'] } }) }), /safe workspace-relative/u);
  await assert.rejects(saveBattle({ workspace: dir, record: record({ metadata: { sources: ['cache/showdown-session.json'] } }) }), /safe workspace-relative/u);
  const bad = record();
  bad.pokemon[0].moves[0].uses = -1;
  await assert.rejects(saveBattle({ workspace: dir, record: bad }), /nonnegative integer/u);
  await assert.rejects(saveBattle({ workspace: dir, record: record({ turns: 0.5 }) }), /nonnegative integer/u);
  await assert.rejects(getTeamReport({ workspace: dir, from: 'bad-date' }), /valid timestamp/u);
  await assert.rejects(getTeamReport({ workspace: dir, includeOperational: 'true' }), /boolean/u);
});

test('storage refuses linked directories and malformed records instead of changing totals', async t => {
  const dir = await workspace(t);
  const elsewhere = await workspace(t);
  await symlink(elsewhere, join(dir, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveBattle({ workspace: dir, record: record() }), /real directories/u);
  await rm(join(dir, 'cache'));
  await mkdir(join(dir, 'cache', 'team-metrics'), { recursive: true });
  await writeFile(join(dir, 'cache', 'team-metrics', `battle-test-1--${TEAM}.json`), '{broken');
  await assert.rejects(listBattles({ workspace: dir }), /JSON/u);
});

test('empty storage has explicit zero denominators and creates no directories on reads', async t => {
  const dir = await workspace(t);
  assert.deepEqual(await listBattles({ workspace: dir }), []);
  assert.deepEqual(await listTeams({ workspace: dir }), []);
  const report = await getTeamReport({ workspace: dir });
  assert.equal(report.totals.games, 0);
  assert.equal(report.totals.winRate, null);
  assert.equal(report.totals.winRateDenominator, 0);
  assert.equal(report.selection.gamesWithSelection, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('source registries in their own directory do not become battle rows', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record() });
  const registryDir = join(dir, 'cache', 'team-metrics', 'sources');
  await mkdir(registryDir);
  await writeFile(join(registryDir, 'registry.json'), '[]');
  assert.equal((await listBattles({ workspace: dir })).length, 1);
});

test('registered unused moves remain visible without implying an unselected Pokémon was observed', async t => {
  const dir = await workspace(t);
  const battle = record();
  battle.pokemon.push({ key: 'rillaboom:3', species: 'Rillaboom', forms: [], selected: false, lead: false,
    moves: [{ move: 'Wood Hammer', uses: 0 }, { move: 'Fake Out', uses: 0 }] });
  await saveBattle({ workspace: dir, record: battle });
  const rillaboom = (await getTeamReport({ workspace: dir })).pokemon.find(entry => entry.species === 'Rillaboom');
  assert.equal(rillaboom.selectedGames, 0);
  assert.equal(rillaboom.observedGames, 0);
  assert.equal(rillaboom.moves.length, 2);
  assert.equal(rillaboom.moves[0].uses, 0);
  assert.equal(rillaboom.moves[0].usageDenominator, 0);
  assert.equal(rillaboom.moves[0].usagePercent, null);
});

test('Mega performance counts actual Mega Evolution flags and excludes ties from its win-rate denominator', async t => {
  const dir = await workspace(t);
  const noMega = record(); // A registered/observed Mega form alone is not proof that the event occurred.
  await saveBattle({ workspace: dir, record: noMega });
  for (const [index, outcome] of ['win', 'loss', 'tie'].entries()) {
    const battle = record({ roomId: `battle-mega-${index + 2}`, outcome });
    battle.pokemon[0].megaEvolved = true;
    await saveBattle({ workspace: dir, record: battle });
  }
  const report = await getTeamReport({ workspace: dir });
  const golisopod = report.pokemon.find(entry => entry.species === 'Golisopod');
  assert.equal(golisopod.megaGames, 3);
  assert.equal(golisopod.megaWins, 1);
  assert.equal(golisopod.megaLosses, 1);
  assert.equal(golisopod.megaTies, 1);
  assert.equal(golisopod.megaWinRate, 50);
  assert.equal(golisopod.megaWinRateDenominator, 2);
  const [stored] = await listBattles({ workspace: dir });
  assert.equal(typeof stored.pokemon[0].megaEvolved, 'boolean');
  assert.equal(report.games.find(game => game.roomId === noMega.roomId).pokemon[0].megaEvolved, false);
  assert.equal(report.pokemon.find(entry => entry.species === 'Rillaboom').megaWinRate, null);
});

test('lead-pair metrics combine reversed leads and use only complete observed pairs', async t => {
  const dir = await workspace(t);
  await saveBattle({ workspace: dir, record: record({ leads: ['Golisopod', 'Farigiraf'] }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-leads-2', outcome: 'loss', leads: ['Farigiraf', 'Golisopod'] }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-leads-3', outcome: 'tie', leads: ['Farigiraf', 'Rillaboom'] }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-leads-4', outcome: 'win', leads: ['Farigiraf'] }) });
  const report = await getTeamReport({ workspace: dir });
  assert.equal(report.selection.gamesWithKnownLeadPairs, 3);
  assert.equal(report.leadPairs.length, 2);
  const pair = report.leadPairs.find(entry => entry.species.includes('Golisopod'));
  assert.deepEqual(pair.species, ['Farigiraf', 'Golisopod']);
  assert.equal(pair.games, 2);
  assert.equal(pair.wins, 1);
  assert.equal(pair.losses, 1);
  assert.equal(pair.winRate, 50);
  assert.equal(pair.winRateDenominator, 2);
  assert.equal(pair.usageDenominator, 3);
  assert.equal(pair.usagePercent, 2 / 3 * 100);
});

test('opposing attendance remains observed-only while hidden reserves stay unavailable', async t => {
  const dir = await workspace(t);
  const roster = ['Archaludon', 'Charizard', 'Farigiraf', 'Rillaboom', 'Gholdengo', 'Sableye'];
  await saveBattle({ workspace: dir, record: record({ opponentRoster: roster, opponentSelected: ['Archaludon', 'Charizard'], opponentLeads: ['Archaludon', 'Charizard'], opponentSelectionKnown: false, opponentMega: ['Charizard'] }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-foes-2', outcome: 'loss', opponentRoster: roster, opponentSelected: ['Archaludon', 'Charizard', 'Farigiraf', 'Gholdengo'], opponentLeads: ['Charizard', 'Farigiraf'], opponentSelectionKnown: true, opponentMega: [] }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-foes-3', opponentRoster: [], opponentSelected: ['Rotom-Wash'], opponentLeads: ['Rotom-Wash'], opponentSelectionKnown: false }) });
  const report = await getTeamReport({ workspace: dir });
  assert.equal(report.selection.gamesWithKnownOpponentSelection, 1);
  assert.equal(report.selection.gamesWithoutKnownOpponentSelection, 2);
  const rillaboom = report.opponents.find(entry => entry.species === 'Rillaboom');
  assert.equal(rillaboom.observedSelectedGames, 0);
  assert.equal(rillaboom.knownUnselectedGames, 1);
  assert.equal(rillaboom.unavailableSelectionGames, 1);
  const charizard = report.opponents.find(entry => entry.species === 'Charizard');
  assert.equal(charizard.observedSelectedGames, 2);
  assert.equal(charizard.observedLeadGames, 2);
  assert.equal(charizard.observedMegaGames, 1);
  assert.equal(charizard.unavailableSelectionGames, 0);
  const rotom = report.opponents.find(entry => entry.species === 'Rotom-Wash');
  assert.equal(rotom.rosterGames, 0);
  assert.equal(rotom.observedOnlyGames, 1);
  assert.equal(rotom.observedSelectedGames, 1);
  assert.equal((await getTeamReport({ workspace: dir, opponentSpecies: 'rotom-wash' })).totals.games, 1);
  assert.equal((await getTeamReport({ workspace: dir, opponentSpecies: 'Rotom-Heat' })).totals.games, 0);
  const stored = (await listBattles({ workspace: dir })).find(entry => entry.roomId === 'battle-foes-2');
  assert.equal(stored.opponentSelectionKnown, true);
  assert.deepEqual(stored.opponentLeads, ['Charizard', 'Farigiraf']);
  const invalid = record({ opponentSelected: ['Archaludon'], opponentSelectionKnown: true });
  await assert.rejects(saveBattle({ workspace: dir, record: invalid }), /exactly four/u);
});

test('an operational sibling contaminates the whole set even when a filter hides that child', async t => {
  const dir = await workspace(t);
  const setLoss = { setResult: { outcome: 'loss', completed: true } };
  const first = record({ metadata: setLoss });
  await saveBattle({ workspace: dir, record: first });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-contamination-2', outcome: 'loss', metadata: setLoss, quality: { complete: true, operational: true, warnings: ['Inactivity'] } }) });
  await saveBattle({ workspace: dir, record: record({ roomId: 'battle-clean-3', parentId: 'bestof3-test-21', metadata: { setResult: { outcome: 'win', completed: true } } }) });
  const normal = await getTeamReport({ workspace: dir });
  assert.equal(normal.totals.games, 2); // The clean child is still a valid game observation.
  assert.equal(normal.totals.sets.observed, 2);
  assert.equal(normal.totals.sets.played, 1);
  assert.equal(normal.totals.sets.wins, 1);
  assert.equal(normal.totals.sets.losses, 0);
  assert.equal(normal.totals.sets.excludedOperational, 1);
  assert.equal(normal.totals.sets.records.length, 2);
  const excluded = normal.totals.sets.records.find(entry => entry.parentId === first.parentId);
  assert.equal(excluded.outcome, 'loss');
  assert.equal(excluded.operational, true);
  assert.equal(excluded.included, false);
  assert.equal(excluded.exclusionReason, 'operational');
  assert.equal(normal.games.find(game => game.roomId === first.roomId).setOperational, true);
  const onlyWins = await getTeamReport({ workspace: dir, outcome: 'win' });
  assert.equal(onlyWins.totals.sets.excludedOperational, 1);
  assert.equal(onlyWins.totals.sets.records.find(entry => entry.parentId === first.parentId).storedGames, 2);
  const withOperational = await getTeamReport({ workspace: dir, includeOperational: true });
  assert.equal(withOperational.totals.sets.played, 2);
  assert.equal(withOperational.totals.sets.losses, 1);
  assert.equal(withOperational.totals.sets.winRate, 50);
  assert.equal(withOperational.totals.sets.excludedOperational, 0);
});

const numberedTeam = index => index.toString(16).padStart(64, '0');

test('the catalog keeps ten active teams and permanently cleans an evicted team history and exports', async t => {
  const dir = await workspace(t);
  assert.equal(MAX_ACTIVE_TEAMS, 10);
  for (let index = 1; index <= 10; index++) await saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(index), team: { name: `Team ${index}`, roster: ['Golisopod'] } }) });
  const initially = await listTeams({ workspace: dir });
  assert.equal(initially.length, 10);
  const initialFirst = initially.find(team => team.teamId === numberedTeam(1));
  await getTeamReport({ workspace: dir, teamId: numberedTeam(1), touch: false });
  const afterRead = (await listTeams({ workspace: dir })).find(team => team.teamId === numberedTeam(1));
  assert.equal(afterRead.usageOrder, initialFirst.usageOrder);
  assert.equal(afterRead.lastUsedAt, initialFirst.lastUsedAt);
  await getTeamReport({ workspace: dir, teamId: numberedTeam(1) });
  const exported=await exportReport({workspace:dir,report:await getTeamReport({workspace:dir,teamId:numberedTeam(2),touch:false}),format:'html',output:'removed-team-2.html'});
  await saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(11) }) });
  assert.equal((await listTeams({ workspace: dir })).length, 10);
  assert.equal((await listTeams({ workspace: dir, includeArchived: true })).length, 10);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(1) }), true);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(2) }), null);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(11) }), true);
  assert.equal((await listBattles({ workspace: dir })).length, 10);
  assert.equal((await listBattles({ workspace: dir, includeArchived: true })).length, 10);
  await assert.rejects(readFile(exported.path),{code:'ENOENT'});
  await assert.rejects(getTeamReport({ workspace: dir, teamId: numberedTeam(2) }),/unknown|deleted/u);
  assert.equal((await listTeams({ workspace: dir })).length, 10);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(3) }), true);
});

test('stale reimports cannot recreate a purged team or alter the remaining LRU', async t => {
  const dir = await workspace(t);
  for (let index = 1; index <= 11; index++) await saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(index) }) });
  const before = await listTeams({ workspace: dir, includeArchived: true });
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(1) }), null);
  await assert.rejects(saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(1) }) }),/deleted/u);
  await assert.rejects(saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(1), metadata: { ...record().metadata, sources: ['cache/additional-source.jsonl'], attribution: 'Source provenance refreshed' } }) }),/deleted/u);
  const after = await listTeams({ workspace: dir, includeArchived: true });
  assert.deepEqual(after.map(team => [team.teamId, team.usageOrder, team.lastUsedAt, team.active]), before.map(team => [team.teamId, team.usageOrder, team.lastUsedAt, team.active]));
  await assert.rejects(saveBattle({ workspace: dir, record: record({ teamId: numberedTeam(1), turns: 8 }) }),/deleted/u);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(1) }), null);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: numberedTeam(2) }), true);
  assert.equal((await listBattles({workspace:dir,includeArchived:true})).some(game=>game.teamId===numberedTeam(1)),false);
});

test('explicitly registered empty teams appear in reports and capacity purge prevents implicit restoration', async t => {
  const dir = await workspace(t);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: TEAM }), null);
  await registerMetricsTeam({ workspace: dir, teamId: TEAM, name: 'New trial version', format: 'gen9championsvgc2026regmc', roster: ['Golisopod', 'Sylveon'] });
  const first = (await listTeams({ workspace: dir }))[0];
  assert.equal(first.storedGames, 0);
  assert.equal(first.eligibleGames, 0);
  const report = await getTeamReport({ workspace: dir, touch: false });
  assert.equal(report.team.teamId, TEAM);
  assert.equal(report.team.name, 'New trial version');
  assert.equal(report.totals.games, 0);
  assert.equal(report.pokemon.length, 2);
  for (let index = 1; index <= 10; index++) await registerMetricsTeam({ workspace: dir, teamId: numberedTeam(index) });
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: TEAM }), null);
  await assert.rejects(restoreMetricsTeam({ workspace: dir, teamId: TEAM }),/deleted/u);
  await assert.rejects(getTeamReport({workspace:dir,teamId:TEAM}),/unknown|deleted/u);
  assert.equal((await listTeams({ workspace: dir })).length, 10);
  await assert.rejects(restoreMetricsTeam({ workspace: dir, teamId: OTHER_TEAM }), /not present/u);
});

test('one-time migration preserves all thirty legacy summaries byte for byte', async t => {
  const dir = await workspace(t), metricsDirectory = join(dir, 'cache', 'team-metrics');
  await mkdir(metricsDirectory, { recursive: true });
  const original = new Map();
  for (let index = 1; index <= 30; index++) {
    const battle = record({ roomId: `battle-legacy-${index}`, teamId: numberedTeam((index % 3) + 1), importedAt: new Date(Date.UTC(2026, 9, 15, 10, index)).toISOString() });
    const file = `${battle.roomId}--${battle.teamId}.json`, contents = JSON.stringify(battle);
    original.set(file, contents);
    await writeFile(join(metricsDirectory, file), contents);
  }
  const teams = await listTeams({ workspace: dir });
  assert.equal(teams.length, 3);
  assert.equal((await listBattles({ workspace: dir })).length, 30);
  assert.equal(teams.reduce((sum, team) => sum + team.storedGames, 0), 30);
  for (const [file, contents] of original) assert.equal(await readFile(join(metricsDirectory, file), 'utf8'), contents);
  const before = teams.map(team => [team.teamId, team.usageOrder]);
  await listTeams({ workspace: dir });
  assert.deepEqual((await listTeams({ workspace: dir })).map(team => [team.teamId, team.usageOrder]), before);
});

test('an unknown report fingerprint cannot register a phantom team or evict a known team', async t => {
  const dir = await workspace(t);
  for (let index = 1; index <= 10; index++) await registerMetricsTeam({ workspace: dir, teamId: numberedTeam(index) });
  const before = await listTeams({ workspace: dir, includeArchived: true });
  await assert.rejects(getTeamReport({ workspace: dir, teamId: OTHER_TEAM }), /teamId is unknown/u);
  await assert.rejects(getTeamReport({ workspace: dir, teamId: OTHER_TEAM, touch: false }), /teamId is unknown/u);
  assert.equal(await isMetricsTeamActive({ workspace: dir, teamId: OTHER_TEAM }), null);
  assert.deepEqual(await listTeams({ workspace: dir, includeArchived: true }), before);
});

test('a full public replay retains known private selections, parent and players while updating actual metrics', async t => {
  const dir = await workspace(t);
  const privateBattle = record({
    selected: ['Golisopod', 'Farigiraf', 'Rillaboom', 'Politoed'], leads: ['Golisopod', 'Farigiraf'],
    opponentRoster: ['Archaludon', 'Charizard', 'Rillaboom', 'Aegislash', 'Farigiraf', 'Sableye'],
    opponentSelected: ['Archaludon', 'Charizard', 'Rillaboom', 'Aegislash'], opponentSelectionKnown: true,
    opponentLeads: ['Archaludon', 'Charizard'], metadata: { setResult: { outcome: 'win', completed: true } },
  });
  for (const species of ['Farigiraf', 'Rillaboom', 'Politoed']) privateBattle.pokemon.push({ key: species.toLowerCase(), species, forms: [], selected: true, lead: species === 'Farigiraf', moves: [] });
  await saveBattle({ workspace: dir, record: privateBattle });
  const publicBattle = record({
    parentId: null, players: { p1: '', p2: '' }, selectionKnown: false, selected: ['Golisopod', 'Farigiraf'], leads: [],
    opponentRoster: ['Archaludon', 'Charizard'], opponentSelected: ['Archaludon', 'Charizard'], opponentSelectionKnown: false,
    opponentLeads: [], metadata: {},
  });
  publicBattle.pokemon[0].knockouts = 1; // A corrected reducer result replaces the old count; no blind maximum.
  publicBattle.pokemon[0].moves[0].uses = 1;
  for (const species of ['Farigiraf', 'Rillaboom', 'Politoed']) publicBattle.pokemon.push({ key: species.toLowerCase(), species, forms: [], selected: species === 'Farigiraf', lead: false, moves: [] });
  await saveBattle({ workspace: dir, record: publicBattle });
  const [stored] = await listBattles({ workspace: dir });
  assert.equal((await listBattles({ workspace: dir })).length, 1);
  assert.equal(stored.parentId, privateBattle.parentId);
  assert.deepEqual(stored.players, privateBattle.players);
  assert.equal(stored.selectionKnown, true);
  assert.deepEqual(stored.selected, privateBattle.selected);
  assert.equal(stored.pokemon.find(pokemon => pokemon.species === 'Politoed').selected, true);
  assert.equal(stored.pokemon[0].knockouts, 1);
  assert.equal(stored.pokemon[0].moves[0].uses, 1);
  assert.equal(stored.opponentSelectionKnown, true);
  assert.deepEqual(stored.opponentSelected, privateBattle.opponentSelected);
  assert.equal(stored.opponentRoster.length, 6);
  assert.deepEqual(stored.opponentLeads, privateBattle.opponentLeads);
  assert.deepEqual(stored.leads, privateBattle.leads);
  const report = await getTeamReport({ workspace: dir, touch: false });
  assert.equal(report.totals.sets.wins, 1);
  assert.equal(report.selection.gamesWithSelection, 1);
});
