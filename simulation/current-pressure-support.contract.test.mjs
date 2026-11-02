import test from 'node:test';
import assert from 'node:assert/strict';
import {buildObservedPosition,supportedObservedCurrentAbilities} from './observed-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';

// Pure adapter fixture. This file never constructs a Battle or starts a worker.
function pressureFixture(){
  const input=currentFixture(),foes=input.observed.boards[0].sides[1].pokemon;
  const replacements=[
    {species:'Blastoise',nature:'Modest',ability:'Rain Dish',item:'Blastoisinite',moves:['Terrain Pulse','Water Spout','Aura Sphere','Protect']},
    {species:'Grimmsnarl',nature:'Adamant',ability:'Prankster',item:'Fairy Feather',moves:['Misty Terrain','Reflect','Light Screen','Spirit Break']},
  ];
  for(const [index,set]of replacements.entries()){
    input.opposingSheet[index===0?4:0]=set;
    Object.assign(foes[index],{species:set.species,ability:set.ability,abilitySuppressed:false});
    Object.assign(input.hypotheses.opposing[`foe${index}`],{ability:set.ability,item:set.item});
  }
  input.observed.opponentSheets.p2=structuredClone(input.opposingSheet);
  return input;
}

test('CURRENT adapter admits native Rain Dish/Prankster while retaining authored state',()=>{
  const input=pressureFixture(),built=buildObservedPosition(input);
  for(const [index,ability]of ['Rain Dish','Prankster'].entries()){
    const mon=built.position.sides[1].pokemon.find(p=>p.id===`foe${index}`);
    assert.equal(mon.ability,ability);
    assert.deepEqual(mon.lifecycle,input.hypotheses.opposing[mon.id].lifecycle);
    assert.deepEqual(mon.pp,input.hypotheses.opposing[mon.id].pp);
  }
  assert.equal(supportedObservedCurrentAbilities.has('raindish'),true);
  assert.equal(supportedObservedCurrentAbilities.has('prankster'),true);
});

test('native ability registry preserves state conflicts while allowing known and hypothetical copied abilities',()=>{
  for(const mutate of [
    value=>value.observed.boards[0].sides[1].pokemon[0].abilitySuppressed=true,
    value=>delete value.hypotheses.opposing.foe0.lifecycle,
    value=>delete value.hypotheses.field,
    value=>{value.observed.boards[0].sides[1].pokemon[0].volatiles={encore:{}};},
    value=>{value.hypotheses.opposing.foe1.ability='Rain Dish';},
  ]){
    const input=pressureFixture();mutate(input);assert.throws(()=>buildObservedPosition(input));
  }
  assert.equal(supportedObservedCurrentAbilities.has('torrent'),true);
  const input=pressureFixture();input.observed.boards[0].sides[1].pokemon[0].ability='Torrent';input.hypotheses.opposing.foe0.ability='Torrent';
  assert.equal(buildObservedPosition(input).position.sides[1].pokemon.find(p=>p.id==='foe0').ability,'Torrent');
  const copied=pressureFixture();copied.hypotheses.opposing.foe1.ability='Rain Dish';copied.observed.boards[0].sides[1].pokemon[1].ability=null;
  const actor=buildObservedPosition(copied).position.sides[1].pokemon.find(p=>p.id==='foe1');assert.equal(actor.ability,'Rain Dish');assert.equal(actor.nativeState.baseAbility,'Prankster');
  assert.equal(supportedObservedCurrentAbilities.has('notanativeability'),false);
  const unknown=pressureFixture();unknown.observed.boards[0].sides[1].pokemon[0].ability='Not A Native Ability';unknown.hypotheses.opposing.foe0.ability='Not A Native Ability';assert.throws(()=>buildObservedPosition(unknown));
});

test('narrow ability support retains exact source and complete opposing allocation requirements',()=>{
  const stale=pressureFixture();stale.expected.token='b'.repeat(64);assert.throws(()=>buildObservedPosition(stale),/room\/rqid\/token/);
  const missing=pressureFixture();delete missing.hypotheses.opposing.foe0.statPoints.spe;assert.throws(()=>buildObservedPosition(missing));
  const changed=pressureFixture();changed.opposingSheet[4].moves[0]='Ice Beam';assert.throws(()=>buildObservedPosition(changed),/published sheet/);
});
