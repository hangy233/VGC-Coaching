import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEmergencyActions} from './emergency-choice.mjs';
import {validateChoice} from './choice-validation.mjs';

const mon=(name,active=false,condition='100/100')=>({ident:`p1: ${name}`,details:`${name}, L50`,active,condition});
const move=(name,target='normal',extra={})=>({move:name,target,pp:10,...extra});
const request=()=>({rqid:7,side:{id:'p1',pokemon:[mon('Golisopod',true),mon('Politoed',true),mon('Hydreigon'),mon('Farigiraf')]},active:[{canMegaEvo:true,moves:[move('Sucker Punch'),move('Iron Head'),move('Protect','self')]},{moves:[move('Weather Ball'),move('Muddy Water','allAdjacentFoes'),move('Protect','self')]}]});
const checked=(q,options)=>{const actions=selectEmergencyActions(q,options);if(actions)assert.deepEqual(validateChoice(q,actions).actions,actions);return actions;};

test('preview selects the first registered four without changing the request',()=>{
  const q=request();q.teamPreview=true;q.side.pokemon.push(mon('Rillaboom'),mon('Sylveon'));
  const before=structuredClone(q);assert.deepEqual(checked(q),[{type:'team',order:[1,2,3,4]}]);assert.deepEqual(q,before);
  q.maxChosenTeamSize=3;assert.deepEqual(checked(q),[{type:'team',order:[1,2,3]}]);
  q.maxChosenTeamSize=7;assert.equal(checked(q),null);
});

test('ordinary attacks precede conditional attacks and never activate Mega',()=>{
  const q=request(),before=structuredClone(q);
  assert.deepEqual(checked(q),[{type:'move',slot:2,target:1},{type:'move',slot:1,target:1}]);
  assert.deepEqual(q,before);
  for(const name of ['Counter','Mirror Coat','Metal Burst','Focus Punch','Fake Out','First Impression','Upper Hand']){
    q.active[0].moves[0]=move(name);assert.equal(checked(q)[0].slot,2,name);
  }
});

test('disabled and zero-PP moves are unavailable, including a choice lock',()=>{
  const q=request();q.active[0].moves[1].disabled=true;q.active[0].moves[2].pp=0;
  assert.deepEqual(checked(q)[0],{type:'move',slot:1,target:1});
  q.active[0].moves[0].pp=0;
  assert.deepEqual(checked(q)[0],{type:'switch',slot:3});
  q.active[0].trapped=true;assert.equal(checked(q),null);
});

test('server-provided Struggle is usable without inventing a chosen target',()=>{
  const q=request();q.active[0].moves=[move('Struggle','randomNormal',{pp:1})];
  assert.deepEqual(checked(q)[0],{type:'move',slot:1});
});

test('explicitly verified sole foe slot is used; omitted context keeps both possible slots',()=>{
  const q=request();assert.deepEqual(checked(q,{foeSlots:[2]})[0],{type:'move',slot:2,target:2});
  assert.deepEqual(checked(q)[0],{type:'move',slot:2,target:1});
  q.active[1].moves=[move('Psychic')];q.active[0].moves=[move('Iron Head')];
  q.active[0].trapped=q.active[1].trapped=true;
  assert.equal(checked(q,{foeSlots:[]}),null);assert.equal(checked(q,{foeSlots:null}),null);
});

test('safe support or self moves precede collateral damage; only legal collateral remains usable',()=>{
  const q=request();q.active[0].moves=[move('Earthquake','allAdjacent'),move('Helping Hand','adjacentAlly'),move('Protect','self')];
  assert.deepEqual(checked(q)[0],{type:'move',slot:2,target:-2});
  q.active[0].moves=[move('Earthquake','allAdjacent'),move('Rock Slide','allAdjacentFoes')];
  assert.deepEqual(checked(q)[0],{type:'move',slot:2});
  q.active[0].moves=[move('Earthquake','allAdjacent')];assert.deepEqual(checked(q)[0],{type:'switch',slot:3});
  q.active[0].trapped=true;assert.deepEqual(checked(q)[0],{type:'move',slot:1});
});

test('status support chooses only its legal target categories and avoids a fainted ally when self is available',()=>{
  const q=request();q.active[0].moves=[move('Helping Hand','adjacentAlly'),move('Acupressure','adjacentAllyOrSelf'),move('Thunder Wave')];
  assert.deepEqual(checked(q)[0],{type:'move',slot:1,target:-2});
  q.side.pokemon[1].condition='0 fnt';
  assert.deepEqual(checked(q),[{type:'move',slot:2,target:-1},{type:'pass'}]);
  q.active[0].moves=[move('Helping Hand','adjacentAlly')];q.active[0].trapped=true;assert.equal(checked(q),null);
});

test('self-sacrificing status moves remain last resorts ahead of no choice',()=>{
  const q=request();q.active[0].moves=[move('Memento'),move('Protect','self')];
  assert.deepEqual(checked(q)[0],{type:'move',slot:2});
  q.active[0].moves=[move('Memento')];assert.deepEqual(checked(q)[0],{type:'switch',slot:3});
  q.active[0].trapped=true;assert.deepEqual(checked(q)[0],{type:'move',slot:1,target:1});
});

test('forced replacements use complete validated pairs, one remaining reserve, and reordered identity',()=>{
  const q=request();delete q.active;q.forceSwitch=[true,true];q.side.pokemon[0].condition=q.side.pokemon[1].condition='0 fnt';
  assert.deepEqual(checked(q),[{type:'switch',slot:3},{type:'switch',slot:4}]);
  q.side.pokemon[2].condition='0 fnt';assert.deepEqual(checked(q),[{type:'pass'},{type:'switch',slot:4}]);
  [q.side.pokemon[2],q.side.pokemon[3]]=[q.side.pokemon[3],q.side.pokemon[2]];
  assert.deepEqual(checked(q),[{type:'pass'},{type:'switch',slot:3}]);
});

test('forced revival selects an eligible fainted target, keeping the other slot passed',()=>{
  const q=request();delete q.active;q.forceSwitch=[false,true];q.side.pokemon[1].reviving=true;q.side.pokemon[2].condition='0 fnt';
  assert.deepEqual(checked(q),[{type:'pass'},{type:'switch',slot:3}]);
});

test('fainted slots pass, malformed and wait requests return null, and pairs never duplicate a reserve',()=>{
  const q=request();q.side.pokemon[0].condition='0 fnt';assert.equal(checked(q)[0].type,'pass');
  assert.equal(checked({...q,wait:true}),null);assert.equal(checked(null),null);assert.equal(checked({...q,active:[]}),null);
  q.side.pokemon[0].condition='100/100';q.active[0].moves=q.active[1].moves=[];q.side.pokemon[3].condition='0 fnt';assert.equal(checked(q),null);
});
