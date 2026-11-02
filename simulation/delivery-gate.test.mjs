import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {openingFixture,currentFixture} from './fixtures.mjs';

function fakeOutFixture(ability='Sap Sipper'){
  const input=openingFixture();input.position.sides[0].pokemon[1].ability=ability;
  input.position.sides[1].pokemon[1].moves[3]='Protect';
  Object.assign(input.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['arch']}});
  return input;
}
test('delivery Protect on the other slot cannot cover a required actor denied by Fake Out',()=>{
  const sample=simulateNativeTurn(fakeOutFixture()).samples[0];
  assert.ok(sample.events.some(event=>event.actorId==='fari'&&event.move==='Protect'));
  assert.equal(sample.gate.passed,false);assert.equal(sample.gate.requiredActions[0].status,'failed');
  assert.ok(sample.gate.requiredActions[0].denials.some(event=>event.type==='cant'&&event.actorId==='arch'));
  const protectedSample=simulateNativeTurn(fakeOutFixture('Armor Tail')).samples[0];
  assert.equal(protectedSample.gate.requiredActions[0].status,'passed');assert.equal(protectedSample.gate.passed,true);
});
test('delivery requires successful native effect rather than a Protect-blocked attack attempt',()=>{
  const input=fakeOutFixture('Armor Tail');input.branches[0].opposingActions[0]={type:'move',slot:4};
  const sample=simulateNativeTurn(input).samples[0],goal=sample.gate.requiredActions[0];
  assert.equal(goal.attemptedMove,'Dragon Pulse');assert.equal(goal.status,'failed');assert.equal(sample.gate.passed,false);
  assert.ok(goal.denials.some(event=>event.type==='-activate'&&event.raw.includes('Protect')));
});
test('delivery proves Trick Room with its required setter and preserves survival as a separate goal',()=>{
  const input=openingFixture();Object.assign(input.branches[0],{ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:3}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['fari'],survive:['fari','toed'],field:{trickRoom:true}}});
  const sample=simulateNativeTurn(input).samples[0];
  assert.equal(sample.gate.passed,true);assert.equal(sample.gate.requiredActions[0].status,'passed');
  assert.equal(sample.gate.fieldGoals[0].establishedByRequiredAction,true);assert.equal(sample.gate.fieldGoals[0].status,'passed');
  assert.ok(sample.gate.surviveGoals.every(goal=>goal.status==='passed'));
});
test('delivery switch credits original actor departure and the exact authored new entry',()=>{
  const input=openingFixture();input.position.sides[1].pokemon[1].moves[3]='Protect';
  Object.assign(input.branches[0],{ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['arch'],survive:['toed'],field:{weather:'raindance'}}});
  const sample=simulateNativeTurn(input).samples[0],goal=sample.gate.requiredActions[0];
  assert.equal(goal.id,'arch');assert.equal(goal.entrantId,'toed');assert.equal(goal.status,'passed');assert.equal(sample.gate.passed,true);
  assert.equal(sample.final.sides[0].pokemon.find(pokemon=>pokemon.id==='arch').active,false);
  assert.equal(sample.gate.fieldGoals[0].establishedByRequiredAction,true);
});
test('delivery attributes native terrain entry to the required switch rather than a preexisting field',()=>{
  const input=openingFixture();input.position.sides[0].pokemon[2]={...structuredClone(input.position.sides[1].pokemon[1]),id:'own-rilla'};input.position.sides[1].active[1]='incin';
  Object.assign(input.branches[0],{ourActions:[{type:'switch',pokemonId:'own-rilla'},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['arch'],field:{terrain:'grassyterrain'}}});
  const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.gate.passed,true);assert.equal(sample.gate.fieldGoals[0].initial,'');assert.equal(sample.gate.fieldGoals[0].establishedByRequiredAction,true);
});
test('delivery can prove the required setter removed Trick Room using its native field-end event',()=>{
  const input=currentFixture();input.position.field.trickRoom={remainingTurns:3};input.position.sides[1].pokemon[1].moves[3]='Protect';input.position.sides[1].pokemon[1].pp[3]=1;
  Object.assign(input.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:3}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['fari'],field:{trickRoom:false}}});
  const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.gate.passed,true);assert.equal(sample.gate.fieldGoals[0].actual,false);assert.equal(sample.gate.fieldGoals[0].establishedByRequiredAction,true);
});
test('delivery cannot credit preexisting Trick Room when required Protect fails',()=>{
  const input=currentFixture();input.position.field.trickRoom={remainingTurns:3};input.position.sides[0].pokemon[1].lifecycle.protectCounter=729;
  input.position.sides[1].pokemon[1].moves[3]='Protect';input.position.sides[1].pokemon[1].pp[3]=1;
  Object.assign(input.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['fari'],field:{trickRoom:true}}});
  const sample=simulateNativeTurn(input).samples[0];
  assert.equal(sample.gate.requiredActions[0].status,'failed');assert.equal(sample.gate.fieldGoals[0].matchedAtBoundary,true);
  assert.equal(sample.gate.fieldGoals[0].establishedByRequiredAction,false);assert.equal(sample.gate.fieldGoals[0].status,'unknown');assert.equal(sample.gate.passed,false);
});
test('delivery stops at the first replacement and preserves pending actor/unknown survival',()=>{
  const input=openingFixture();input.position.sides[0].pokemon[0]={id:'gol',species:'Golisopod',nature:'Brave',ability:'Emergency Exit',item:'Golisopite',moves:['Sucker Punch','Iron Head','Leech Life','Protect'],statPoints:{hp:32,atk:32,spd:2}};input.position.sides[0].active[0]='gol';
  Object.assign(input.branches[0],{ourActions:[{type:'move',slot:3,target:2},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:4,mega:true},{type:'move',slot:1,target:1}],gate:{kind:'delivery',requiredActionsBy:['gol'],survive:['gol']}});
  const sample=simulateNativeTurn(input).samples[0];assert.equal(sample.boundary,'forced-replacement');assert.equal(sample.gate.requiredActions[0].status,'unknown');assert.equal(sample.gate.requiredActions[0].pendingAtBoundary,true);assert.equal(sample.gate.surviveGoals[0].status,'unknown');assert.equal(sample.gate.passed,false);assert.ok(!sample.events.some(event=>event.type==='switch'));
});
test('a delivered setup followed by residual faint remains delivered while an explicit survival goal fails',()=>{
  const input=currentFixture();input.position.sides[0].pokemon[1].hp=1;input.position.sides[0].pokemon[1].status='psn';input.position.sides[1].pokemon[1].moves[3]='Protect';input.position.sides[1].pokemon[1].pp[3]=1;
  Object.assign(input.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:3}],opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['fari'],survive:['fari']}});
  const sample=simulateNativeTurn(input).samples[0];
  assert.equal(sample.gate.requiredActions[0].status,'passed');assert.equal(sample.gate.requiredActions[0].aliveAtBoundary,false);assert.equal(sample.gate.surviveGoals[0].status,'failed');assert.equal(sample.gate.passed,false);
  delete input.branches[0].gate.survive;assert.equal(simulateNativeTurn(input).samples[0].gate.passed,true);
});
test('delivery rejects unknown/opposing/reserve required actors, duplicate goals and unsupported current state',()=>{
  for(const ids of [['raichu'],['toed'],['absent'],['arch','arch']]){const input=fakeOutFixture();input.branches[0].gate.requiredActionsBy=ids;assert.throws(()=>simulateNativeTurn(input),/unique own initial active/);}
  const input=currentFixture();input.branches[0].gate={kind:'delivery',requiredActionsBy:['arch']};delete input.position.sides[0].pokemon[0].lifecycle;assert.throws(()=>simulateNativeTurn(input),/require exact/);
  const invalid=fakeOutFixture();invalid.branches[0].gate.survive=['raichu'];assert.throws(()=>simulateNativeTurn(invalid),/survival goals/);
});
