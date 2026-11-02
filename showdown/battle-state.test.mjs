import test from 'node:test';
import assert from 'node:assert/strict';
import showdown from 'pokemon-showdown';
import {createBattleState, reduceBattleLine, reduceBattleRequest, battleStateSnapshot,validateOwnReservePpSnapshot} from './battle-state.mjs';
import {ShowdownClient} from './client.mjs';
import {compactTurnBoard} from './turn-board.mjs';
const {Dex} = showdown;

const feed = (state, ...lines) => { for (const line of lines) reduceBattleLine(state, line, {now: 1000}); return state; };
const start = (...lines) => feed(createBattleState(), '|gen|9', '|gametype|doubles', ...lines);
const active = (state, side, slot) => state.sides[side].pokemon.find(p => p.id === state.sides[side].active[slot]);
const field = state => battleStateSnapshot(state).field;
const request = (pokemon, extra = {}) => ({rqid: 4, side: {id: 'p2', name: 'Player', pokemon}, ...extra});

test('Toxic Spikes count native layers without a duration; missing prefix never invents the first layer',()=>{
  const state=createBattleState();
  const line=text=>reduceBattleLine(state,text,{epoch:1,connected:true,now:1000});
  line('|gen|9');line('|start');
  for(const expected of [1,2,2]){
    line('|-sidestart|p1: Owner|Toxic Spikes');
    const condition=battleStateSnapshot(state).sides.find(side=>side.id==='p1').conditions.toxicspikes;
    assert.equal(condition.layers,expected);assert.equal(condition.remainingTurns,null);
  }
  line('|-sideend|p1: Owner|Toxic Spikes');line('|-sidestart|p1: Owner|Toxic Spikes');
  assert.equal(state.sides.p1.conditions.toxicspikes.layers,1);
  const partial=createBattleState();
  reduceBattleLine(partial,'|-sidestart|p1: Owner|Toxic Spikes',{epoch:1,connected:true});
  assert.equal(partial.sides.p1.conditions.toxicspikes.layers,null);
  reduceBattleLine(partial,'|-sideend|p1: Owner|Toxic Spikes',{epoch:1,connected:true});
  reduceBattleLine(partial,'|-sidestart|p1: Owner|Toxic Spikes',{epoch:1,connected:true});
  assert.equal(partial.sides.p1.conditions.toxicspikes.layers,1);
});
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

test('preview default active flags do not assign battle positions or duplicate a reordered lead', () => {
  const state = start();
  const preview = [entry('First', 'Kommo-o', {active: true}), entry('Pivot', 'Rillaboom', {active: true}), entry('Partner', 'Sylveon')];
  reduceBattleRequest(state, request(preview, {teamPreview: true}));
  const pivot = state.sides.p2.pokemon.find(p => p.nickname === 'Pivot');
  const original = pivot.id;
  assert.deepEqual(state.sides.p2.active, {});
  assert.equal(pivot.activeSlot, null);
  feed(state, '|switch|p2a: Pivot|Rillaboom, L50|200/200', '|switch|p2b: Partner|Sylveon, L50|202/202');
  for (let rqid = 5; rqid < 8; rqid++) reduceBattleRequest(state, request([
    entry('Pivot', 'Rillaboom', {active: true}), entry('Partner', 'Sylveon', {active: true}), entry('First', 'Kommo-o'),
  ], {rqid}));
  assert.equal(active(state, 'p2', 'a').id, original);
  assert.equal(state.sides.p2.pokemon.filter(p => p.nickname === 'Pivot').length, 1);
});

test('a form change invalidates a known base ability until current-form evidence arrives', () => {
  const state = start('|switch|p1a: Attacker|Staraptor, L50|100/100',
    '|-ability|p1a: Attacker|Intimidate', '|-boost|p1a: Attacker|atk|2');
  const original = active(state, 'p1', 'a').id;
  feed(state, '|detailschange|p1a: Attacker|Staraptor-Mega, L50',
    '|-mega|p1a: Attacker|Staraptor|Staraptite');
  const evolved = active(state, 'p1', 'a');
  assert.equal(evolved.id, original);
  assert.equal(evolved.boosts.atk, 2);
  assert.equal(evolved.ability, null);
  assert.equal(evolved.abilitySuppressed, null);
  feed(state, '|-ability|p1a: Attacker|Contrary', '|-ability|p1a: Attacker|Soundproof|[from] move: Skill Swap');
  assert.equal(evolved.ability, 'Soundproof');
  feed(state, '|detailschange|p1a: Attacker|Staraptor-Mega, L50, M');
  assert.equal(evolved.ability, 'Soundproof');
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


function retainedPpClient({prefix=true}={}) {
  const room='battle-gen9championsvgc2026regmcbo3-991',client=new ShowdownClient({now:()=>1234});
  client.connected=true;client.authenticated=true;client.epoch=7;client.ws={close(){}};
  const moves=['protect','tackle','helpinghand','substitute'];
  const pokemon=['A','B','C','D'].map((name,index)=>({ident:`p1: ${name}`,details:`${name}, L50`,condition:'100/100',active:index<2,moves:[...moves],ability:'Pressure',item:''}));
  const active=[{moves:moves.map((id,index)=>({id,move:id,pp:7+index}))},{moves:moves.map(id=>({id,move:id,pp:12}))}];
  const request={rqid:1,side:{id:'p1',pokemon},active};
  const feed=lines=>client.receive(`>${room}\n${lines}`);
  feed(`|gen|9\n|gametype|doubles\n${prefix?'|start\n':''}|switch|p1a: A|A, L50|100/100\n|switch|p1b: B|B, L50|100/100\n|turn|1`);
  feed('|request|'+JSON.stringify(request));
  const exit=()=>feed('|switch|p1a: C|C, L50|100/100');
  const benchRequest=()=>{const next=structuredClone(request);next.rqid=2;next.side.pokemon=[next.side.pokemon[2],next.side.pokemon[1],next.side.pokemon[0],next.side.pokemon[3]];next.side.pokemon.forEach((p,index)=>p.active=index<2);next.active=[active[1],active[1]];return next;};
  const read=()=>{const snapshot=client.battleSnapshot(room),q=client.state(room).request,board=compactTurnBoard(snapshot,{request:q}),p=board.sides[0].pokemon.find(p=>p.nickname==='A'),entry=q.side.pokemon.find(p=>p.ident==='p1: A');return {snapshot,board,p,entry,fact:validateOwnReservePpSnapshot({pokemon:p,requestEntry:entry,observation:board.ownPpObservation,rqid:q.rqid})};};
  return {client,room,feed,request,exit,benchRequest,read};
}

test('retained own PP comes only from a private active request through a clean observed hard switch',()=>{
  const f=retainedPpClient();f.exit();f.feed('|request|'+JSON.stringify(f.benchRequest()));
  const {fact,p,board}=f.read();assert.deepEqual(fact.pp,[7,8,9,10]);assert.equal(fact.provenance.epoch,7);assert.equal(fact.provenance.actorId,p.id);assert.equal(fact.provenance.rqid,1);assert.equal(fact.provenance.benchVerifiedRqid,2);
  assert.equal(board.sides[0].pokemon.find(p=>p.nickname==='D').ownPpSnapshot,undefined,'never-active PP is not inferred');
  fact.pp[0]=64;assert.equal(f.read().fact.pp[0],7,'consumer facts are detached');
});

test('retained own PP loses eligibility on active mutation, missing/replayed stream, epoch and ambiguous merge',()=>{
  const mutations=[
    f=>f.feed('|move|p1a: A|Tackle|p2a: Foe'),f=>f.feed('|cant|p1a: A|par'),
    f=>f.feed('|-transform|p1a: A|p2a: Foe'),f=>f.feed('|-formechange|p1a: A|A-Other'),
    f=>f.feed('|detailschange|p1a: A|A-Other, L50'),f=>f.feed('|-item|p1a: A|Leppa Berry'),
    f=>f.feed('|turn|3'),f=>f.feed('|turn|1'),f=>f.feed('|upkeep\n|upkeep'),
    f=>f.feed('|request|'+JSON.stringify(f.request)),f=>{f.client.epoch++;},f=>f.feed('|error|Malformed protocol state'),
    f=>f.client.close(),f=>{assert.throws(()=>f.feed('|request|{bad'));},
    f=>f.client.renameRoom(f.room,f.room+'-privatepw'),
    f=>{f.client.state(f.room).battle.sides.p1.pokemon[0].identityConfidence='ambiguous-duplicate';},
  ];
  for(const mutate of mutations){const f=retainedPpClient();mutate(f);f.exit();f.feed('|request|'+JSON.stringify(f.benchRequest()));assert.equal(f.read().fact,null,String(mutate));}
  const noPrefix=retainedPpClient({prefix:false});noPrefix.exit();noPrefix.feed('|request|'+JSON.stringify(noPrefix.benchRequest()));assert.equal(noPrefix.read().fact,null);
  const pivot=retainedPpClient();pivot.feed('|switch|p1a: C|C, L50|100/100|[from] move: U-turn');pivot.feed('|request|'+JSON.stringify(pivot.benchRequest()));assert.equal(pivot.read().fact,null);
  const missing=retainedPpClient();missing.feed('|request|'+JSON.stringify(missing.benchRequest()));assert.equal(missing.read().fact,null,'request-only unexplained exit cannot prove a switch');
});

test('retained own PP refuses conflicting consumer bindings and drops targeted bench or move-order changes',()=>{
  const f=retainedPpClient();f.exit();f.feed('|request|'+JSON.stringify(f.benchRequest()));
  const {p,entry,board}=f.read();
  assert.throws(()=>validateOwnReservePpSnapshot({pokemon:p,requestEntry:entry,observation:{...board.ownPpObservation,lastRequestRqid:1},rqid:2}),/observation order/);
  for(const change of [s=>{s.actorId='other';},s=>{s.epoch++;},s=>{delete s.epoch;},s=>{s.details='Other, L50';},s=>{s.moves.reverse();},s=>{s.benchVerifiedRqid++;},s=>{s.exitSequence=s.requestSequence;},s=>{s.exitSequence=String(s.exitSequence);},s=>{s.pp=new Array(4);}]){
    const altered=structuredClone(p);change(altered.ownPpSnapshot);assert.throws(()=>validateOwnReservePpSnapshot({pokemon:altered,requestEntry:entry,observation:board.ownPpObservation,rqid:2}),/Observed reserve PP/);
  }
  f.feed('|-item|p1: A|Leppa Berry');assert.equal(f.read().fact,null);
  for(const kind of ['order','identity']){const other=retainedPpClient();other.exit();const next=other.benchRequest();if(kind==='order')next.side.pokemon[2].moves.reverse();else next.side.pokemon[2].ident='p1: Different';other.feed('|request|'+JSON.stringify(next));assert.equal(other.read().fact,null);}
  for(const key of ['item','ability','condition']){
    const changed=retainedPpClient();changed.exit();changed.feed('|request|'+JSON.stringify(changed.benchRequest()));
    const next=changed.benchRequest();next.rqid=3;next.side.pokemon[2][key]=key==='item'?'Leppa Berry':key==='ability'?'Other Ability':'99/100';
    changed.feed('|request|'+JSON.stringify(next));assert.equal(changed.read().fact,null,key+' request-only change');
  }
  for(const incomplete of ['omitted','missing-side']){
    const changed=retainedPpClient();changed.exit();changed.feed('|request|'+JSON.stringify(changed.benchRequest()));
    const next=changed.benchRequest();next.rqid=3;if(incomplete==='omitted')next.side.pokemon.splice(2,1);else delete next.side;
    changed.feed('|request|'+JSON.stringify(next));const restored=changed.benchRequest();restored.rqid=4;
    changed.feed('|request|'+JSON.stringify(restored));assert.equal(changed.read().fact,null,incomplete+' cannot revive old PP');
  }
});

test('retained own PP is unavailable after the actual client reconnect path changes epoch',async()=>{
  const f=retainedPpClient();
  class Socket extends EventTarget {constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}close(){this.dispatchEvent(new Event('close'));}}
  f.client.ws.readyState=3;f.client.WebSocketImpl=Socket;
  await f.client.connect();f.exit();f.feed('|request|'+JSON.stringify(f.benchRequest()));
  assert.equal(f.read().fact,null);assert.equal(f.client.epoch,8);
  f.client.ws.dispatchEvent(new Event('error'));assert.equal(f.read().fact,null);
  f.client.ws.close();assert.equal(f.read().fact,null);
});
