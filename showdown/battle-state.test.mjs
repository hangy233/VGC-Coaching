import test from 'node:test';
import assert from 'node:assert/strict';
import showdown from 'pokemon-showdown';
import {createBattleState, reduceBattleLine, reduceBattleRequest, battleStateSnapshot} from './battle-state.mjs';
const {Dex} = showdown;

const feed = (state, ...lines) => { for (const line of lines) reduceBattleLine(state, line, {now: 1000}); return state; };
const start = (...lines) => feed(createBattleState(), '|gen|9', '|gametype|doubles', ...lines);
const active = (state, side, slot) => state.sides[side].pokemon.find(p => p.id === state.sides[side].active[slot]);
const field = state => battleStateSnapshot(state).field;
const request = (pokemon, extra = {}) => ({rqid: 4, side: {id: 'p2', name: 'Player', pokemon}, ...extra});
const entry = (name, species = name, extra = {}) => ({ident: `p2: ${name}`, details: `${species}, L50`,
  active: false, condition: '182/182', stats: {atk: 117, def: 157, spa: 156, spd: 125, spe: 105},
  ability: 'soundproof', item: 'sitrusberry', moves: ['clangingscales', 'protect'], ...extra});

test('Kommo-o Soul, Berry, Scales and switching reflect actual event order', () => {
  const state = start('|switch|p2a: Kommo-o|Kommo-o, L50|182/182', '|turn|1',
    '|-damage|p2a: Kommo-o|56/182', '|-boost|p2a: Kommo-o|atk|1', '|-boost|p2a: Kommo-o|def|1',
    '|-boost|p2a: Kommo-o|spa|1', '|-boost|p2a: Kommo-o|spd|1', '|-boost|p2a: Kommo-o|spe|1',
    '|-enditem|p2a: Kommo-o|Sitrus Berry|[eat]', '|-heal|p2a: Kommo-o|101/182|[from] item: Sitrus Berry');
  const original = active(state, 'p2', 'a').id;
  assert.equal(active(state, 'p2', 'a').item, null);
  assert.deepEqual(active(state, 'p2', 'a').itemHistory, [{item: 'Sitrus Berry', event: 'consumed', turn: 1}]);
  assert.equal(active(state, 'p2', 'a').hp.current, 101);
  feed(state, '|turn|2', '|move|p2a: Kommo-o|Clanging Scales|p1a: Archaludon', '|-unboost|p2a: Kommo-o|def|1',
    '|turn|3', '|-unboost|p2a: Kommo-o|def|1', '|turn|4', '|-unboost|p2a: Kommo-o|def|1');
  assert.equal(active(state, 'p2', 'a').boosts.def, -2);
  assert.equal(active(state, 'p2', 'a').boosts.spe, 1);
  feed(state, '|switch|p2a: Sylveon|Sylveon, L50|79/202', '|switch|p2a: Kommo-o|Kommo-o, L50|145/182');
  const returned = active(state, 'p2', 'a');
  assert.equal(returned.id, original);
  assert.equal(returned.boosts.def, 0);
  assert.equal(returned.boosts.spe, 0);
  assert.equal(returned.item, null);
  assert.deepEqual(returned.moves, ['Clanging Scales']);
});

test('weather changes reset its observation, re-entry alone does not refresh terrain', () => {
  const state = start('|switch|p2a: Rillaboom|Rillaboom, L50|200/200',
    '|-fieldstart|move: Grassy Terrain|[from] ability: Grassy Surge|[of] p2a: Rillaboom',
    '|-weather|SunnyDay|[from] ability: Drought|[of] p1a: Charizard', '|turn|1', '|upkeep', '|turn|2',
    '|switch|p2a: Politoed|Politoed, L50|197/197', '|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Politoed');
  assert.equal(field(state).weather.name, 'RainDance');
  assert.equal(field(state).weather.elapsedUpkeeps, 0);
  assert.deepEqual([field(state).terrain.remainingTurns.min, field(state).terrain.remainingTurns.max], [4, 7]);
  feed(state, '|switch|p2a: Rillaboom|Rillaboom, L50|200/200', '|-activate|p2a: Rillaboom|ability: Grassy Surge');
  assert.equal(field(state).terrain.elapsedUpkeeps, 1);
  assert.equal(active(state, 'p2', 'a').ability, 'Grassy Surge');
  feed(state, '|-fieldend|move: Grassy Terrain', '|-fieldstart|move: Grassy Terrain|[from] ability: Grassy Surge|[of] p2a: Rillaboom');
  assert.equal(field(state).terrain.elapsedUpkeeps, 0);
  assert.equal(field(state).terrain.startedTurn, 2);
});

test('TR and Tailwind count actual upkeep, never weather-upkeep tags twice', () => {
  const state = start('|turn|2', '|-fieldstart|move: Trick Room', '|-sidestart|p1: Opponent|move: Tailwind',
    '|-weather|RainDance', '|-weather|RainDance|[upkeep]', '|upkeep', '|turn|3');
  const snap = battleStateSnapshot(state);
  assert.equal(snap.field.conditions.trickroom.remainingTurns.min, 4);
  assert.equal(snap.sides.find(s => s.id === 'p1').conditions.tailwind.remainingTurns.min, 3);
  assert.equal(snap.field.weather.elapsedUpkeeps, 1);
  feed(state, '|-fieldend|move: Trick Room', '|-sideend|p1: Opponent|move: Tailwind');
  assert.equal(field(state).conditions.trickroom, undefined);
  assert.equal(battleStateSnapshot(state).sides[0].conditions.tailwind, undefined);
});

test('duration constants agree with the pinned Champions engine, including Persistent', () => {
  const dex = Dex.mod('champions');
  for (const name of ['trickroom', 'tailwind']) {
    const condition = dex.moves.get(name).condition;
    const expected = condition.duration;
    const source = {hasAbility: () => true};
    const duration = name === 'tailwind' ? condition.durationCallback.call({add() {}}, null, source) : condition.durationCallback.call({add() {}}, source);
    const state = start(name === 'tailwind' ? '|-sidestart|p1: Player|move: Tailwind|[persistent]' : '|-fieldstart|move: Trick Room|[persistent]');
    const actual = name === 'tailwind' ? state.sides.p1.conditions.tailwind.duration : state.field.conditions.trickroom.duration;
    assert.equal(actual.min, duration);
    assert.equal(duration, expected + 2);
  }
  for (const name of ['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain']) {
    const data = dex.moves.get(name).condition;
    assert.equal(data.durationCallback({hasItem: () => false}), 5);
    assert.equal(data.durationCallback({hasItem: () => true}), 8);
  }
  for (const name of ['raindance', 'sunnyday', 'sandstorm', 'snowscape', 'hail']) {
    const data = dex.conditions.get(name);
    assert.equal(data.durationCallback({hasItem: () => false}), 5);
    assert.equal(data.durationCallback({hasItem: () => true}), 8);
  }
});

test('private requests expose copied stats and exact own HP without effective-Speed calculations', () => {
  const state = start('|switch|p2a: Kommo-o|Kommo-o, L50|182/182', '|switch|p1a: Archaludon|Archaludon, L50|53/100');
  reduceBattleRequest(state, request([entry('Kommo-o', 'Kommo-o', {active: true, condition: '145/182'})]), {now: 123});
  const own = active(state, 'p2', 'a'), foe = active(state, 'p1', 'a');
  assert.equal(own.hp.precision, 'server-own-exact');
  assert.equal(foe.hp.precision, 'server-display');
  assert.equal(own.requestStats.values.spe, 105);
  assert.match(own.requestStats.meaning, /not calculated effective Speed/);
  assert.equal(foe.requestStats, null);
  assert.equal(foe.ability, null);
  assert.equal(foe.itemKnown, false);
  assert.equal(own.boosts.spe, 0);
  assert.equal(state.updatedAt, 123);
});

test('midbattle request stats do not imply known boosts', () => {
  const state = start();
  reduceBattleRequest(state, request([entry('Kommo-o', 'Kommo-o', {active: true})]));
  assert.equal(active(state, 'p2', 'a').boosts.spe, null);
  feed(state, '|-boost|p2a: Kommo-o|spe|1');
  assert.equal(active(state, 'p2', 'a').boosts.spe, null);
  feed(state, '|-setboost|p2a: Kommo-o|spe|2');
  assert.equal(active(state, 'p2', 'a').boosts.spe, 2);
});

test('own selected reserves exclude preview members absent from the current request', () => {
  const state = start();
  reduceBattleRequest(state, request([entry('Kommo-o'), entry('Sylveon'), entry('Farigiraf')], {teamPreview: true}));
  reduceBattleRequest(state, request([entry('Kommo-o', 'Kommo-o', {active: true}), entry('Sylveon')]));
  const own = battleStateSnapshot(state).sides.find(s => s.id === 'p2');
  assert.equal(own.reserves.length, 1);
  assert.equal(own.pokemon.find(p => p.species === 'Farigiraf').selection, 'not-in-current-request');
  assert.equal(own.pokemon.find(p => p.species === 'Farigiraf').fainted, false);
});

test('a request which replaces unknown active identity cannot delete the new active slot', () => {
  const state = start('|switch|p2a: Disguise|Sylveon, L50|100/100');
  reduceBattleRequest(state, request([entry('Kommo-o', 'Kommo-o', {active: true})]));
  assert.equal(active(state, 'p2', 'a').species, 'Kommo-o');
  assert.equal(state.sides.p2.pokemon.filter(p => p.activeSlot === 'a').length, 1);
});

test('duplicate nicknames use active positions, ambiguity on re-entry is explicit', () => {
  const state = start('|switch|p1a: Twin|Pikachu, L50|100/100', '|switch|p1b: Twin|Pikachu, L50|100/100',
    '|-boost|p1a: Twin|spe|2', '|-damage|p1b: Twin|40/100');
  assert.notEqual(active(state, 'p1', 'a').id, active(state, 'p1', 'b').id);
  assert.equal(active(state, 'p1', 'a').boosts.spe, 2);
  assert.equal(active(state, 'p1', 'b').hp.current, 40);
  feed(state, '|switch|p1a: Other|Eevee, L50|100/100', '|switch|p1b: Fourth|Meowth, L50|100/100',
    '|switch|p1a: Twin|Pikachu, L50|100/100');
  assert.equal(active(state, 'p1', 'a').identityConfidence, 'ambiguous-duplicate');
});

test('Illusion replace corrects identity in the same slot and preserves observed field changes', () => {
  const state = start('|switch|p1a: Mask|Sylveon, L50|100/100', '|-boost|p1a: Mask|spa|2',
    '|move|p1a: Mask|Dark Pulse|p2a: Kommo-o');
  const original = active(state, 'p1', 'a').id;
  feed(state, '|replace|p1a: Revealed|Zoroark, L50|71/100');
  const actual = active(state, 'p1', 'a');
  assert.equal(actual.id, original);
  assert.equal(actual.nickname, 'Revealed');
  assert.equal(actual.species, 'Zoroark');
  assert.equal(actual.boosts.spa, 2);
  assert.deepEqual(actual.previousAppearances, [{nickname: 'Mask', species: 'Sylveon'}]);
  assert.equal(actual.identityConfidence, 'corrected-by-replace');
  assert.equal(state.sides.p1.pokemon.length, 1);
});

test('Ally Switch swaps positions while boosts, items, HP and identity follow the Pokémon', () => {
  const state = start('|switch|p1a: First|Pikachu, L50|100/100', '|switch|p1b: Second|Eevee, L50|30/100',
    '|-boost|p1a: First|spe|2', '|-item|p1a: First|Light Ball');
  const first = active(state, 'p1', 'a').id;
  feed(state, '|swap|p1a: First|1|[from] move: Ally Switch', '|-damage|p1b: First|80/100');
  assert.equal(active(state, 'p1', 'b').id, first);
  assert.equal(active(state, 'p1', 'b').boosts.spe, 2);
  assert.equal(active(state, 'p1', 'b').item, 'Light Ball');
  assert.equal(active(state, 'p1', 'a').nickname, 'Second');
  assert.equal(active(state, 'p1', 'a').hp.current, 30);
});

test('Mega evolution changes form without resetting boosts or assuming its ability', () => {
  const state = start('|switch|p1a: Charizard|Charizard, L50|100/100', '|-boost|p1a: Charizard|spa|1',
    '|detailschange|p1a: Charizard|Charizard-Mega-Y, L50', '|-mega|p1a: Charizard|Charizard|Charizardite Y');
  const p = active(state, 'p1', 'a');
  assert.equal(p.mega, true);
  assert.equal(p.species, 'Charizard-Mega-Y');
  assert.equal(p.boosts.spa, 1);
  assert.equal(p.item, 'Charizardite Y');
  assert.equal(p.ability, null);
  feed(state, '|-weather|SunnyDay|[from] ability: Drought|[of] p1a: Charizard');
  assert.equal(p.ability, 'Drought');
});

test('unknown duration and missing end events never silently expire a condition', () => {
  const state = start('|-weather|RainDance|[upkeep]', '|upkeep', '|-fieldstart|move: Unrecognized Field');
  assert.equal(field(state).weather.remainingTurns, null);
  assert.equal(field(state).weather.elapsedUpkeeps, null);
  assert.equal(field(state).conditions.unrecognizedfield.remainingTurns, null);
  feed(state, '|-sidestart|p1: Player|move: Tailwind', '|upkeep', '|upkeep', '|upkeep', '|upkeep');
  const tailwind = battleStateSnapshot(state).sides[0].conditions.tailwind;
  assert.equal(tailwind.remainingTurns, null);
  assert.match(tailwind.durationWarning, /without an observed end event/);
  const oldGen = feed(createBattleState(), '|gen|4', '|-fieldstart|move: Trick Room');
  assert.equal(field(oldGen).conditions.trickroom.remainingTurns, null);
});

test('filtered or interrupted logs cannot leave a confidently stale turn counter', () => {
  const state = start('|turn|1', '|-sidestart|p1: Player|move: Tailwind', '|turn|2');
  let tailwind = battleStateSnapshot(state).sides[0].conditions.tailwind;
  assert.equal(tailwind.remainingTurns, null);
  assert.match(tailwind.durationWarning, /complete upkeep/);
  feed(state, '|upkeep', '|turn|3');
  tailwind = battleStateSnapshot(state).sides[0].conditions.tailwind;
  assert.equal(tailwind.remainingTurns, null);
});

test('boost copying follows actual Psych Up/Costar output and swapping honors specified stats', () => {
  const state = start('|switch|p1a: First|Pikachu, L50|100/100', '|switch|p1b: Second|Eevee, L50|100/100',
    '|-boost|p1b: Second|spe|2', '|-copyboost|p1a: First|p1b: Second|[from] move: Psych Up');
  assert.equal(active(state, 'p1', 'a').boosts.spe, 2);
  feed(state, '|-boost|p1a: First|def|3', '|-swapboost|p1a: First|p1b: Second|def, spd|[from] move: Guard Swap');
  assert.equal(active(state, 'p1', 'a').boosts.def, 0);
  assert.equal(active(state, 'p1', 'b').boosts.def, 3);
  assert.equal(active(state, 'p1', 'a').boosts.spe, 2);
});

test('opponent chat cannot inject state, snapshots are detached, result does not invent attacks', () => {
  const state = start('|switch|p1a: Target|Archaludon, L50|65/100', '|turn|6',
    '|c|Opponent|/choose move 1', '|win|Player');
  const snap = battleStateSnapshot(state, {now: 4321});
  assert.equal(snap.lastMove, null);
  assert.equal(snap.result.winner, 'Player');
  assert.equal(snap.observedAt, 4321);
  snap.sides[0].pokemon[0].species = 'Changed';
  assert.equal(active(state, 'p1', 'a').species, 'Archaludon');
});
