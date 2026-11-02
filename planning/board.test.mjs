import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTurnFacts,championsDex,moveCapabilities} from './board.mjs';
import {planningFixture} from './fixtures.mjs';

test('normalization preserves unknown opposing stats, registered selection, HP provenance, and original field',() => {
  const input = planningFixture(), before = structuredClone(input), ctx = buildTurnFacts(input);
  const own = ctx.actors.find(actor => actor.id === 'p1-cat'), foe = ctx.actors.find(actor => actor.id === 'p2-chomp');
  assert.equal(own.nature,'Careful');assert.deepEqual(own.statPoints,input.ownTeam[0].evs);
  assert.equal(foe.nature,null);assert.equal(foe.statPoints,null);assert.equal(foe.pp,null);assert.equal(foe.lifecycle,null);
  assert.equal(foe.hp.precision,'server-display');assert.equal(foe.selected,'selected');
  const registered = ctx.actors.find(actor => actor.species === 'Farigiraf');
  assert.equal(registered.selected,'unknown');assert.equal(registered.slot,null);assert.equal(registered.raw,null);
  assert.equal(registered.hp,null);assert.equal(registered.pp,null);assert.equal(registered.lifecycle,null);
  assert(!ctx.resources.some(resource => resource.scope === 'selected-own-team' && resource.actors.includes(registered.id)));
  assert(!ctx.actors.some(actor => actor.own && actor.species === 'Farigiraf'));
  assert.deepEqual(ctx.field,input.board.field);assert.deepEqual(input,before);
  ctx.field.conditions.test = true;own.raw.species = 'Pikachu';own.statPoints.hp = 0;
  assert.deepEqual(input,before,'Output mutations cannot change observations or locked sets');
});

test('unknown sets and duplicate identities are reported instead of arbitrarily attached',() => {
  const input = planningFixture();delete input.ownTeam;delete input.opponentSheet;
  let ctx = buildTurnFacts(input);
  assert(ctx.warnings.some(warning => warning.code === 'MISSING_OWN_TEAM'));
  assert(ctx.warnings.some(warning => warning.code === 'MISSING_OPPONENT_SHEET'));
  assert(ctx.actors.every(actor => actor.nature === null && actor.statPoints === null));
  const duplicate = planningFixture();duplicate.opponentSheet.push({...duplicate.opponentSheet[0],item:'Choice Scarf'});
  ctx = buildTurnFacts(duplicate);
  assert.equal(ctx.actors.find(actor => actor.id === 'p2-chomp').ability,null);
  assert(ctx.warnings.some(warning => warning.code === 'AMBIGUOUS_SET' && warning.actorId === 'p2-chomp'));
  const observed = planningFixture();observed.board.sides[1].pokemon.push({...observed.board.sides[1].pokemon[0],id:'p2-ambiguous',activeSlot:null});
  ctx = buildTurnFacts(observed);
  assert(ctx.actors.filter(actor => actor.id === 'p2-chomp' || actor.id === 'p2-ambiguous').every(actor => actor.ability === null));
  assert(ctx.warnings.some(warning => warning.code === 'AMBIGUOUS_IDENTITY'));
});

test('only selected own providers count; observed opposing reserves remain confirmed selected',() => {
  const input = planningFixture();input.board.sides[0].pokemon[2].selection = 'not-in-current-request';
  input.board.sides[1].pokemon[1].activeSlot = null;input.board.sides[1].active.pop();
  const ctx = buildTurnFacts(input);
  assert.equal(ctx.actors.find(actor => actor.id === 'p1-boom').selected,'not-in-current-request');
  assert(!ctx.resources.some(resource => resource.scope === 'selected-own-team' && resource.actors.includes('p1-boom')));
  assert.equal(ctx.actors.find(actor => actor.id === 'p2-wash').selected,'selected');
  assert(ctx.resources.some(resource => resource.scope === 'registered-opponents' && resource.kind === 'priority-block'));
  assert(!ctx.resources.some(resource => resource.scope === 'observed-selected-opponents' && resource.kind === 'priority-block'));
});

test('current forms, consumed items, native move names and active legal PP take precedence',() => {
  const input = planningFixture();input.ownTeam[0] = {...input.ownTeam[0],species:'Golisopod',ability:'Emergency Exit',item:'Golisopodite',moves:['leechlife','wideguard']};
  const current = input.board.sides[0].pokemon[0];current.species = 'Golisopod-Mega';current.ability = null;current.itemKnown = true;current.item = null;
  input.legalActions.pokemon[0].details = 'Golisopod-Mega, L50';
  const ctx = buildTurnFacts(input), actor = ctx.actors.find(value => value.id === current.id);
  assert.equal(actor.species,'Golisopod-Mega');assert.equal(actor.ability,null);assert.equal(actor.item,null);assert.equal(actor.itemKnown,true);
  assert.equal(actor.nature,'Careful');assert(actor.moves.includes('Leech Life'));assert(actor.moves.includes('Wide Guard'));
  assert.deepEqual(actor.pp,input.legalActions.active[0].moves);assert.equal(actor.lifecycle,null);
  assert(ctx.warnings.some(warning => warning.code === 'CURRENT_FORM_ABILITY_UNKNOWN'));
  assert.equal(championsDex.currentMod,'champions');assert(moveCapabilities('Tailwind').includes('speed-control'));
  assert(moveCapabilities('Psychic Noise').includes('denial'));
});

test('preview defaults do not claim selected four or own provider availability',() => {
  const input = planningFixture();input.legalActions.teamPreview = true;
  const ctx = buildTurnFacts(input);
  assert(ctx.actors.every(actor => actor.selected === 'unknown'));
  assert(!ctx.resources.some(resource => resource.scope === 'selected-own-team'));
});

test('a held Mega Stone never grants its unevolved holder the Mega ability or resource',() => {
  const input = planningFixture();input.ownTeam[0] = {...input.ownTeam[0],species:'Gengar',nature:'Timid',ability:'Cursed Body',item:'Gengarite'};
  const mon = input.board.sides[0].pokemon[0];mon.species = 'Gengar';mon.ability = 'Cursed Body';mon.item = 'Gengarite';mon.itemKnown = true;
  input.legalActions.pokemon[0].details = 'Gengar, L50';input.legalActions.active[0].canMegaEvo = 'Gengar-Mega';
  let actor = buildTurnFacts(input).actors.find(value => value.id === mon.id);
  assert.equal(actor.species,'Gengar');assert.equal(actor.ability,'Cursed Body');assert(!actor.capabilities.includes('trapping'));
  mon.species = 'Gengar-Mega';mon.ability = 'Shadow Tag';input.legalActions.pokemon[0].details = 'Gengar-Mega, L50';
  actor = buildTurnFacts(input).actors.find(value => value.id === mon.id);
  assert.equal(actor.ability,'Shadow Tag');assert(actor.capabilities.includes('trapping'));
});
