import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentReport, renderAgentReportMarkdown } from './agent-report.mjs';

const ID = 'a'.repeat(64);
const roster = ['Golisopod', 'Farigiraf'];
const registeredTeam = [
  { species: 'Golisopod', item: 'Golisopite', ability: 'Emergency Exit', nature: 'Brave', level: 50, evs: { hp: 32, atk: 32, spd: 2 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 0 }, moves: ['Knock Off', 'Protect', 'Leech Life', 'Iron Head'] },
  { species: 'Farigiraf', item: 'Grassy Seed', ability: 'Armor Tail', nature: 'Sassy', level: 50, evs: { hp: 32, def: 16, spd: 18 }, moves: ['Psychic', 'Helping Hand', 'Trick Room', 'Protect'] },
];
const game = (roomId = 'battle-test-1', override = {}) => ({
  roomId, parentId: 'bestof3-test-1', outcome: 'loss', completed: true, turns: 5, opponent: 'Opponent', playedAt: '2026-10-15T12:00:00Z',
  selected: ['Golisopod'], leads: ['Golisopod'], selectionKnown: true,
  opponentRoster: ['Archaludon', 'Corviknight'], opponentSelected: ['Archaludon'], opponentLeads: ['Archaludon'], opponentMega: [], opponentSelectionKnown: false,
  pokemon: [{ species: 'Golisopod', selected: true, lead: true, forms: ['Golisopod-Mega'], megaEvolved: true, switchIns: 1, faints: 1, knockouts: 1, indirectKnockouts: 0, itemRemovals: 1, couldNotAct: 1, moves: [
    { move: 'Knock Off', uses: 2, calledUses: 0, failed: 0, missed: 1, blocked: 1, knockouts: 1, itemRemovals: 1 },
    { move: 'Protect', uses: 1, calledUses: 0, failed: 1, missed: 0, blocked: 0, knockouts: 0, itemRemovals: 0 },
  ] }], quality: { complete: true, operational: false, warnings: [] },
  ...override,
});

function report(games = [game()], overrides = {}) {
  const known = games.filter(game => game.selectionKnown);
  const result = {
    schemaVersion: 1,
    team: { teamId: ID, name: 'Rain core', format: 'gen9championsvgc2026regmc', roster },
    filters: { teamId: ID, opponentSpecies: null, selectedSpecies: null, outcome: null, includeIncomplete: false, includeOperational: false, from: null, to: null },
    totals: { games: games.length, wins: games.filter(game => game.outcome === 'win').length, losses: games.filter(game => game.outcome === 'loss').length, ties: games.filter(game => game.outcome === 'tie').length, unknown: games.filter(game => game.outcome === 'unknown').length, sets: { records: [] } },
    quality: { storedGames: games.length, matchingGames: games.length, includedGames: games.length, incompleteGames: 0, operationalGames: 0, incompleteOperationalGames: 0, excludedIncomplete: 0, excludedOperational: 0, excludedTotal: 0, warnings: [] },
    selection: { gamesWithSelection: known.length, gamesWithoutSelection: games.length - known.length, gamesWithKnownLeads: games.filter(game => game.leads.length).length, gamesWithKnownLeadPairs: games.filter(game => game.leads.length === 2).length, gamesWithKnownOpponentSelection: games.filter(game => game.opponentSelectionKnown).length, gamesWithoutKnownOpponentSelection: games.filter(game => !game.opponentSelectionKnown).length },
    pokemon: roster.map(species => {
      const entries = games.flatMap(game => game.pokemon.filter(row => row.species === species));
      const selectedGames = known.filter(game => game.selected.includes(species));
      const aggregate = {};
      for (const field of ['switchIns', 'faints', 'knockouts', 'indirectKnockouts', 'itemRemovals', 'couldNotAct']) aggregate[field] = entries.reduce((sum, row) => sum + (row[field] ?? 0), 0);
      const moves = new Map();
      for (const entry of entries) for (const move of entry.moves) {
        if (!moves.has(move.move)) moves.set(move.move, { move: move.move });
        for (const field of ['uses', 'calledUses', 'failed', 'missed', 'blocked', 'knockouts', 'itemRemovals']) moves.get(move.move)[field] = (moves.get(move.move)[field] ?? 0) + (move[field] ?? 0);
      }
      return { species, forms: [], observedGames: entries.length, observedSelectedGames: games.filter(game => game.selected.includes(species)).length, selectedGames: selectedGames.length, selectionDenominator: known.length, leadGames: games.filter(game => game.leads.includes(species)).length, leadDenominator: games.filter(game => game.leads.length).length, winsWhenSelected: selectedGames.filter(game => game.outcome === 'win').length, lossesWhenSelected: selectedGames.filter(game => game.outcome === 'loss').length, tiesWhenSelected: selectedGames.filter(game => game.outcome === 'tie').length, unknownWhenSelected: selectedGames.filter(game => game.outcome === 'unknown').length, megaGames: entries.filter(row => row.megaEvolved).length, megaWins: 0, megaLosses: entries.filter(row => row.megaEvolved).length, megaTies: 0, megaUnknown: 0, ...aggregate, moves: [...moves.values()] };
    }),
    opponents: ['Archaludon', 'Corviknight'].map(species => {
      const matching = games.filter(game => game.opponentRoster.includes(species));
      return { species, games: matching.length, wins: matching.filter(game => game.outcome === 'win').length, losses: matching.filter(game => game.outcome === 'loss').length, ties: matching.filter(game => game.outcome === 'tie').length, unknown: matching.filter(game => game.outcome === 'unknown').length, rosterGames: matching.length, observedOnlyGames: 0, observedSelectedGames: matching.filter(game => game.opponentSelected.includes(species)).length, observedLeadGames: matching.filter(game => game.opponentLeads.includes(species)).length, observedMegaGames: 0, knownUnselectedGames: 0, unavailableSelectionGames: matching.filter(game => !game.opponentSelected.includes(species)).length };
    }),
    leadPairs: [], games,
  };
  return { ...result, ...overrides };
}

test('agent report preserves native team points and explicit numeric denominators', () => {
  const brief = buildAgentReport({ report: report(), registeredTeam });
  assert.equal(brief.kind, 'vgc-team-agent-report');
  assert.equal(brief.schemaVersion, 1);
  assert.equal(brief.team.teamId, ID);
  assert.equal(brief.team.teamSheet.pokemon[0].evs.hp, 32);
  assert.equal(brief.team.teamSheet.pokemon[0].evs.spa, null);
  assert.equal(brief.team.teamSheet.pokemon[0].ivs.spe, 0);
  assert.equal(brief.team.teamSheet.pokemon[1].ivs.spe, null);
  assert.match(brief.team.teamSheet.investmentSystem, /native stat points/u);
  const goli = brief.pokemon[0];
  assert.deepEqual(goli.rates.selection, { numerator: 1, denominator: 1, percent: 100 });
  assert.deepEqual(goli.moves[0].rates.usage, { numerator: 2, denominator: 3, percent: 2 / 3 * 100 });
  assert.deepEqual(goli.moves[0].rates.missed, { numerator: 1, denominator: 2, percent: 50 });
  assert.equal(goli.moves[0].itemRemovals, 1);
  assert.equal(goli.couldNotAct, 1);
  assert.equal(brief.games, undefined);
  assert.equal(brief.reviewSignals.find(row => row.id === 'unused-golisopod-leechlife').metrics.knownSelectedGames, 1);
  assert.equal(brief.reviewSignals.find(row => row.id === 'unselected-farigiraf').metrics.knownSelectionGames, 1);
});

test('partial selections do not become selection absences; missing snapshots remain explicit', () => {
  const brief = buildAgentReport({ report: report([game(undefined, { selectionKnown: false })]), registeredTeam });
  assert.equal(brief.selection.gamesWithSelection, 0);
  assert.deepEqual(brief.pokemon[0].rates.selection, { numerator: 0, denominator: 0, percent: null });
  assert.ok(!brief.reviewSignals.some(signal => signal.category === 'registered-move' || signal.category === 'selection'));
  const missing = buildAgentReport({ report: report() });
  assert.equal(missing.team.teamSheet.status, 'missing-snapshot');
  assert.deepEqual(missing.team.teamSheet.pokemon, []);
  assert.ok(!missing.reviewSignals.some(signal => signal.category === 'registered-move'));
});

test('zero included games are distinct from an unused team or move', () => {
  const brief = buildAgentReport({ report: report([]), registeredTeam });
  assert.equal(brief.totals.games, 0);
  assert.equal(brief.totals.winRate.percent, null);
  assert.deepEqual(brief.reviewSignals.map(row => row.id), ['no-included-games']);
  assert.equal(brief.gameIndexCoverage.truncated, false);
  assert.equal(brief.pokemon[0].moves.length, 0);
});

test('filtered scope supplies all tactical evidence; excluded quality totals are separate', () => {
  const input = report([game('battle-filtered-loss')]);
  input.filters.opponentSpecies = 'Archaludon';
  input.filters.outcome = 'loss';
  input.quality.storedGames = 40;
  input.quality.matchingGames = 3;
  input.quality.operationalGames = 1;
  input.quality.excludedIncomplete = 1;
  input.quality.excludedOperational = 1;
  input.quality.excludedTotal = 2;
  input.totals.sets = { excludedOperational: 1, records: [{ parentId: 'bestof3-filtered-ops', exclusionReason: 'operational', operational: true, included: false }] };
  input.rawLog = '|chat|This should never be passed on';
  const brief = buildAgentReport({ report: input });
  assert.equal(brief.scope.filters.opponentSpecies, 'Archaludon');
  assert.equal(brief.totals.games, 1);
  assert.equal(brief.quality.storedGames, 40);
  const losses = brief.reviewSignals.find(signal => signal.id === 'losses-with-archaludon');
  assert.deepEqual(losses.evidence.gameIds, ['battle-filtered-loss']);
  assert.equal(losses.metrics.games, 1);
  const quality = brief.reviewSignals.find(signal => signal.category === 'quality');
  assert.equal(quality.evidence.scope, 'matching-quality-summary');
  assert.equal(quality.evidence.matchedGames, null);
  assert.deepEqual(quality.evidence.gameIds, []);
  assert.deepEqual(quality.evidence.parentIds, ['bestof3-filtered-ops']);
  assert.doesNotMatch(JSON.stringify(brief), /This should never be passed on/u);
  assert.throws(() => buildAgentReport({ report: { ...input, filters: { teamId: 'b'.repeat(64) } } }), /different team versions/u);
  assert.throws(() => buildAgentReport({ report: report([game(undefined, { teamId: 'b'.repeat(64) })]) }), /different team version/u);
  assert.throws(() => buildAgentReport({ report: input, registeredTeam: [{ species: 'Pikachu' }] }), /roster does not match/u);
});

test('evidence and game index bounds disclose exact samples without duplicating full rows by default', () => {
  const games = Array.from({ length: 25 }, (_, index) => game(`battle-test-${String(index + 1).padStart(2, '0')}`, { parentId: `bestof3-test-${index + 1}` }));
  const brief = buildAgentReport({ report: report(games), registeredTeam, maxEvidence: 2 });
  const losses = brief.reviewSignals.find(signal => signal.id === 'losses-with-archaludon');
  assert.equal(losses.evidence.matchedGames, 25);
  assert.equal(losses.evidence.matchedParents, 25);
  assert.deepEqual(losses.evidence.gameIds, ['battle-test-01', 'battle-test-02']);
  assert.equal(losses.evidence.parentIds.length, 2);
  assert.equal(losses.evidence.truncated, true);
  assert.deepEqual(brief.gameIndexCoverage, { returned: 20, total: 25, truncated: true, order: 'Newest playedAt first, then room ID; missing timestamps sort last.' });
  assert.equal(brief.gameIndex.length, 20);
  assert.equal(brief.gameIndex[0].pokemon, undefined);
  const full = buildAgentReport({ report: report(games), includeGames: true, maxEvidence: 1 });
  assert.equal(full.games.length, 25);
  assert.equal(full.games[0].pokemon[0].moves[0].uses, 2);
  assert.equal(full.reviewSignals[0].evidence.gameIds.length, 1);
  assert.equal(full.reviewSignals[0].evidence.truncated, true);
  assert.throws(() => buildAgentReport({ report: report(), maxEvidence: 0 }), /1 to 20/u);
  assert.throws(() => buildAgentReport({ report: report(), maxEvidence: 21 }), /1 to 20/u);
});

test('signal truncation remains explicit and deterministic for many observed opponents', () => {
  const input = report();
  const opponents = Array.from({ length: 40 }, (_, index) => `Species ${index}`);
  input.games[0].opponentRoster = opponents;
  input.opponents = opponents.map(species => ({ species, games: 1, wins: 0, losses: 1 }));
  const brief = buildAgentReport({ report: input });
  assert.equal(brief.reviewSignals.length, 20);
  assert.equal(brief.reviewSignalCoverage.truncated, true);
  assert.ok(brief.reviewSignalCoverage.total >= 40);
  assert.deepEqual(buildAgentReport({ report: input }), brief);
});

test('markdown treats names, warnings and provenance as inert source data', () => {
  const attack = '<img src=x onerror=alert(1)> ![click](javascript:alert(1)) `\n# injected';
  const input = report();
  input.team.name = attack;
  input.games[0].opponent = attack;
  const brief = buildAgentReport({ report: input });
  brief.provenance = { teamSnapshot: { status: 'available', path: 'cache/team-metrics/teams/a.txt' }, latestMetricUpdateAt: '2026-10-15T12:00:00Z', latestGameAt: null, sourceFiles: [{ path: attack, kind: 'workspace-input' }], sourceFilesTruncated: false, totalSourceFiles: 1, gameSources: [{ roomId: 'battle-test-1', sources: [attack] }], turnEvidenceIncluded: false, decisionEvidenceIncluded: false };
  const rendered = renderAgentReportMarkdown(brief);
  assert.doesNotMatch(rendered, /<img|!\[click\]\(javascript:|\n# injected/u);
  assert.match(rendered, /&lt;img/u);
  assert.match(rendered, /Provenance and freshness/u);
  assert.match(rendered, /calculate\\_damage/u);
  assert.match(rendered, /cache\/team-metrics\/teams\/a\\.txt/u);
});

test('mismatched totals and selection denominators fail instead of yielding plausible advice', () => {
  const mismatched = report();
  mismatched.totals.games = 3;
  assert.throws(() => buildAgentReport({ report: mismatched }), /totals/u);
  const wrongKnown = report();
  wrongKnown.selection.gamesWithSelection = 2;
  assert.throws(() => buildAgentReport({ report: wrongKnown }), /denominators/u);
});

test('called executions are already included in uses and are not added to rate denominators', () => {
  const onlyCalled = game();
  onlyCalled.pokemon[0].moves = [{ move: 'Knock Off', uses: 1, calledUses: 1, failed: 0, missed: 0, blocked: 1, knockouts: 0, itemRemovals: 0 }];
  const brief = buildAgentReport({ report: report([onlyCalled]) });
  const move = brief.pokemon[0].moves[0];
  assert.deepEqual(move.rates.blocked, { numerator: 1, denominator: 1, percent: 100 });
  assert.deepEqual(move.rates.usage, { numerator: 1, denominator: 1, percent: 100 });
  assert.match(brief.definitions.moveUses, /subset of uses/u);
});

test('agent game index retains verified replay URLs and whitelisted compact evidence references',()=>{
  const roomId='battle-gen9championsvgc2026regmcbo3-123',url='https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123-privateaccesspw',hash='b'.repeat(64),prefix=`cache/team-metrics/evidence/${roomId}--${ID}`;
  const input=report([game(roomId,{replay:{url,verified:true,verifiedAt:'2026-10-15T12:00:01Z',logSha256:hash,evidencePath:`${prefix}.replay.log.gz`,rawLog:'must not survive'},evidence:{path:`${prefix}.events.json.gz`,sha256:hash,kind:'sanitized-events',version:1,complete:true,request:'private request must not survive'}})]);
  const brief=buildAgentReport({report:input,includeGames:true}),entry=brief.gameIndex[0];
  assert.deepEqual(entry.replay,{url,verified:true,verifiedAt:'2026-10-15T12:00:01Z',logSha256:hash,evidencePath:`${prefix}.replay.log.gz`});
  assert.deepEqual(entry.evidence,{path:`${prefix}.events.json.gz`,sha256:hash,kind:'sanitized-events',version:1,complete:true});
  assert.deepEqual(brief.games[0].replay,entry.replay);assert.deepEqual(brief.games[0].evidence,entry.evidence);
  assert.doesNotMatch(JSON.stringify(brief),/must not survive/);
  const markdown=renderAgentReportMarkdown(brief);assert(markdown.includes(`[Watch replay](${url})`));assert.match(markdown,/\| Game \| Parent \| Result \| Opponent \|/);assert(markdown.includes(`${roomId}--${ID}\\.events\\.json\\.gz`));
  assert(brief.limitations.some(line=>line.includes('public replay does not recover private selected-four')));
});

test('agent reports reject mismatched, unsafe and unverified replay links and unrelated evidence paths',()=>{
  const roomId='battle-gen9championsvgc2026regmcbo3-123',hash='b'.repeat(64),wrongPath=`cache/team-metrics/evidence/battle-gen9championsvgc2026regmcbo3-124--${ID}.events.json.gz`;
  for(const replay of [{url:'javascript:alert(1)',verified:true},{url:'https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-124',verified:true},{url:'https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123',verified:false},{url:'https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123-secretpw.evil.example',verified:true}]){
    const brief=buildAgentReport({report:report([game(roomId,{replay,evidence:{path:wrongPath,sha256:hash,kind:'sanitized-events',complete:true,version:1}})])});
    assert.equal(brief.gameIndex[0].replay,null);assert.equal(brief.gameIndex[0].evidence,null);assert(!renderAgentReportMarkdown(brief).includes('[Watch replay]('));assert.equal(JSON.stringify(brief).includes('javascript:'),false);
  }
});
