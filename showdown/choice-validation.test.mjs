import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChoice, replacementOptions, legalReplacementPairs} from './choice-validation.mjs';
import {ShowdownClient} from './client.mjs';

const room = 'battle-gen9championsvgc2026regmcbo3-123';
const pokemon = (name, {active = false, condition = '100/100', ...extra} = {}) => ({ident:`p2: ${name}`, details:`${name}, L50`, active, condition, ...extra});
const request = () => ({rqid:31, side:{id:'p2', pokemon:[pokemon('Farigiraf', {active:true}), pokemon('Golisopod', {active:true}), pokemon('Rillaboom'), pokemon('Hydreigon')]}, active:[{canMegaEvo:true, moves:[{move:'Leech Life', target:'normal', pp:10}, {move:'Protect', target:'self', pp:10}]}, {moves:[{move:'Psychic', target:'normal', pp:10}, {move:'Helping Hand', target:'adjacentAlly', pp:10}]}]});
function forcedIncident() {
  const q = request(); delete q.active; q.rqid = 33; q.forceSwitch = [true, true];
  for (const mon of q.side.pokemon.slice(0, 3)) mon.condition = '0 fnt';
  q.side.pokemon[3].condition = '88/167';
  return q;
}

test('sole surviving Hydreigon at reserve slot four yields both complete switch/pass pairs', () => {
  const q = forcedIncident(), before = structuredClone(q), options = replacementOptions(q);
  assert.equal(options.length, 1);
  assert.equal(options[0].slot, 4); assert.equal(options[0].name, 'Hydreigon'); assert.equal(options[0].condition, '88/167');
  assert.deepEqual(options[0].forSlots, [1, 2]); assert.match(options[0].pokemonId, /^pokemon-[a-f0-9]{24}$/);
  assert.deepEqual(legalReplacementPairs(q), [[{type:'pass'}, {type:'switch', slot:4}], [{type:'switch', slot:4}, {type:'pass'}]]);
  assert.deepEqual(validateChoice(q, [{type:'switch', pokemonId:options[0].pokemonId}, {type:'pass'}]), {choice:'switch 4, pass', actions:[{type:'switch', slot:4}, {type:'pass'}]});
  assert.throws(() => validateChoice(q, [{type:'switch', slot:3}, {type:'pass'}]), /Invalid switch/);
  assert.throws(() => validateChoice(q, [{type:'pass'}, {type:'pass'}]), /forced replacements/);
  assert.throws(() => validateChoice(q, [{type:'switch', slot:4}, {type:'switch', slot:4}]), /forced replacements/);
  assert.deepEqual(q, before);
});

test('identity target resolves against current array position and rejects stale, duplicate or mixed identifiers', () => {
  const q = forcedIncident(), id = replacementOptions(q)[0].pokemonId;
  [q.side.pokemon[2], q.side.pokemon[3]] = [q.side.pokemon[3], q.side.pokemon[2]];
  assert.equal(replacementOptions(q)[0].pokemonId, id);
  assert.equal(validateChoice(q, [{type:'switch', pokemonId:id}, {type:'pass'}]).choice, 'switch 3, pass');
  q.side.pokemon[2].condition = '70/167';
  assert.equal(replacementOptions(q)[0].pokemonId, id);
  assert.throws(() => validateChoice(q, [{type:'switch', slot:3, pokemonId:id}, {type:'pass'}]), /not both/);
  assert.throws(() => validateChoice(q, [{type:'switch', pokemonId:'unknown'}, {type:'pass'}]), /missing or ambiguous/);
  q.side.pokemon[3] = {...q.side.pokemon[2], condition:'0 fnt'};
  assert.equal(replacementOptions(q)[0].pokemonId, null);
  assert.throws(() => validateChoice(q, [{type:'switch', pokemonId:id}, {type:'pass'}]), /missing or ambiguous/);
});

test('both living replacements must be selected once, with non-forced slot passing', () => {
  const q = request(); delete q.active; q.forceSwitch = [true, true];
  assert.deepEqual(legalReplacementPairs(q), [[{type:'switch', slot:3}, {type:'switch', slot:4}], [{type:'switch', slot:4}, {type:'switch', slot:3}]]);
  q.forceSwitch = [false, true];
  assert.deepEqual(legalReplacementPairs(q), [[{type:'pass'}, {type:'switch', slot:3}], [{type:'pass'}, {type:'switch', slot:4}]]);
  q.side.pokemon[2].condition = q.side.pokemon[3].condition = '0 fnt';
  assert.deepEqual(legalReplacementPairs(q), [[{type:'pass'}, {type:'pass'}]]);
});

test('revival targets fainted active or reserve Pokemon without consuming healthy replacement capacity', () => {
  for (const reviver of [0, 1]) {
    const q = request(); delete q.active; q.forceSwitch = [false, false]; q.forceSwitch[reviver] = true;
    q.side.pokemon[reviver].reviving = true;
    q.side.pokemon[1 - reviver].condition = '0 fnt'; q.side.pokemon[2].condition = '0 fnt';
    const options = replacementOptions(q);
    assert.deepEqual(options.map(option => option.slot), [2 - reviver, 3]);
    assert(options.every(option => option.revival && option.forSlots.length === 1 && option.forSlots[0] === reviver + 1));
    assert.equal(legalReplacementPairs(q).length, 2);
    for (const option of options) {
      const actions = [{type:'pass'}, {type:'pass'}]; actions[reviver] = {type:'switch', pokemonId:option.pokemonId};
      assert.equal(validateChoice(q, actions).actions[reviver].slot, option.slot);
    }
  }
  const q = request(); delete q.active; q.forceSwitch = [true, true]; q.side.pokemon[1].reviving = true; q.side.pokemon[3].condition = '0 fnt';
  assert.deepEqual(legalReplacementPairs(q), [[{type:'switch', slot:3}, {type:'switch', slot:4}]]);
  assert.throws(() => validateChoice(q, [{type:'pass'}, {type:'switch', slot:4}]), /forced replacements/);
});

test('move compilation preserves target, PP, disabled, trap and Mega guards', () => {
  const q = request(), actions = [{type:'move', slot:1, target:1, mega:true}, {type:'move', slot:2, target:-1}];
  assert.deepEqual(validateChoice(q, actions), {choice:'move 1 1 mega, move 2 -1', actions});
  assert.throws(() => validateChoice(q, [{type:'move', slot:1, target:-1}, actions[1]]), /self/);
  assert.throws(() => validateChoice(q, [actions[0], {type:'move', slot:2, target:2}]), /ally/);
  assert.throws(() => validateChoice(q, [{type:'move', slot:2, target:1}, actions[1]]), /chosen target/);
  assert.throws(() => validateChoice(q, [{type:'move', slot:1}, actions[1]]), /Explicit target/);
  q.active[0].moves[0].pp = 0; assert.throws(() => validateChoice(q, actions), /unavailable/);
  q.active[0].moves[0].pp = 10; q.active[0].moves[0].disabled = true; assert.throws(() => validateChoice(q, actions), /unavailable/);
  q.active[0].moves[0].disabled = false; q.active[0].canMegaEvo = false; assert.throws(() => validateChoice(q, actions), /Mega unavailable/);
  q.active[0].trapped = true;
  assert(!replacementOptions(q).some(option => option.forSlots.includes(1)));
  assert.throws(() => validateChoice(q, [{type:'switch', slot:3}, actions[1]]), /trapped/);
  q.active[0].trapped = false;
  assert.throws(() => validateChoice(q, [{type:'switch', slot:1}, actions[1]]), /Invalid switch/);
  assert.throws(() => validateChoice(q, [null, actions[1]]), /Structured/);
  assert.deepEqual(legalReplacementPairs(q), []);
  assert.deepEqual(replacementOptions({...q, wait:true}), []);
});

test('team preview is a complete validated choice with copied canonical actions', () => {
  const q = request(); q.teamPreview = true; q.maxChosenTeamSize = 4;
  const actions = [{type:'team', order:[1, 2, 4, 3]}], result = validateChoice(q, actions);
  assert.equal(result.choice, 'team 1243'); result.actions[0].order[0] = 4;
  assert.equal(actions[0].order[0], 1);
  assert.throws(() => validateChoice(q, [{type:'team', order:[1, 1, 2, 3]}]), /order/);
  assert.deepEqual(replacementOptions(q), []); assert.deepEqual(legalReplacementPairs(q), []);
});

test('client validation is pure and canonical identities are used for the eventual send', () => {
  const c = new ShowdownClient({now:() => 1000}); c.connected = c.authenticated = true; c.epoch = 1;
  const sent = []; c.ws = {send:line => sent.push(line)};
  const q = forcedIncident(); c.receive(`>${room}\n|request|${JSON.stringify(q)}`);
  const id = replacementOptions(q)[0].pokemonId, revision = c.state(room).revision;
  const input = {rqid:33, revision, deadlineAt:2000, actions:[{type:'switch', pokemonId:id}, {type:'pass'}]};
  const before = structuredClone(c.snapshot()), grantCount = c.grants.size;
  assert.equal(c.validateChoice(room, input).choice, 'switch 4, pass');
  assert.deepEqual(c.snapshot(), before); assert.equal(c.grants.size, grantCount); assert.deepEqual(sent, []);
  assert.throws(() => c.validateChoice(room, {...input, revision:revision - 1}), /Stale/);
  assert.throws(() => c.validateChoice(room, {...input, deadlineAt:999}), /deadline/);
  assert.throws(() => c.validateChoice(room + '9', input), /fresh/); assert.equal(c.rooms.size, 1);
  c.authorize('choose', {room, confirmed:true}); c.choose(room, input);
  assert.equal(sent[0], `${room}|/choose switch 4, pass|33`);
  assert.deepEqual(c.state(room).lastAction.actions, [{type:'switch', slot:4}, {type:'pass'}]);
  c.connected = false; c.authorize('choose', {room, confirmed:true});
  assert.throws(() => c.choose(room, input), /Authenticated connection/);
});
