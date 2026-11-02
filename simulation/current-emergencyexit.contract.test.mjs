import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {buildObservedPosition,supportedObservedCurrentAbilities} from './observed-position.mjs';
import {buildApproximateObservedPosition} from './approximate-position.mjs';
import {collectObservedPositionDiagnostics} from './observed-position-diagnostics.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';

// Pure source/adapter contracts. No Battle, worker, live source or calculator is used.
const require=createRequire(import.meta.url);
const {Teams,TeamValidator,Dex}=require('pokemon-showdown');
const dex=Dex.forFormat('gen9championsvgc2026regmc');
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const zero={atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0};

function emergencyExitFixture({active=false,fainted=false}={}){
  const input=currentFixture(),index=active?0:2,board=input.observed.boards[0],own=board.sides[0];
  const set={species:'Golisopod',ability:'Emergency Exit',item:'Golisopite',nature:'Brave',level:50,
    evs:{hp:32,atk:32,def:0,spa:0,spd:2,spe:0},moves:['Sucker Punch','Iron Head','Leech Life','Protect']};
  const team=Teams.import(input.teamText),prior=own.pokemon[index];
  team[team.findIndex(value=>value.species===prior.species)]=set;
  input.teamText=Teams.export(team);
  const locked=Teams.import(input.teamText);
  assert.equal(new TeamValidator('gen9championsvgc2026regmc').validateTeam(locked),null);
  input.expected.teamId=createHash('sha256').update(Teams.pack(locked)).digest('hex');
  Object.assign(prior,{species:set.species,ability:set.ability,hp:{current:fainted?0:182,max:182,precision:'server-own-exact'},
    status:null,fainted,mega:null,boosts:{...zero},abilitySuppressed:false,volatiles:{}});
  const entry=input.observed.actions[0].legalActions.pokemon[index];
  Object.assign(entry,{ident:'p1: Golisopod',details:'Golisopod, L50, M',condition:fainted?'0 fnt':'182/182',
    ability:set.ability,item:set.item,moves:set.moves.map(value=>dex.moves.get(value).id)});
  if(active)input.observed.actions[0].legalActions.active[0].moves=set.moves.map(move=>({move,pp:12,target:dex.moves.get(move).target,disabled:false}));
  return {input,id:prior.id,index};
}

test('CURRENT Emergency Exit support retains exact active, reserve and fainted source state',()=>{
  assert.equal(supportedObservedCurrentAbilities.has('emergencyexit'),true);
  for(const options of [{active:true},{},{fainted:true}]){
    const {input,id}=emergencyExitFixture(options),before=structuredClone(input),digest=sha(input),built=buildObservedPosition(input);
    const side=built.position.sides[0],pokemon=side.pokemon.find(value=>value.id===id);
    assert.equal(pokemon.species,'Golisopod');assert.equal(pokemon.ability,'Emergency Exit');
    assert.equal(pokemon.hp,options.fainted?0:182);
    assert.deepEqual(pokemon.pp,input.hypotheses.own[id].pp);
    assert.deepEqual(pokemon.lifecycle,input.hypotheses.own[id].lifecycle);
    assert.deepEqual(pokemon.boosts,input.hypotheses.own[id].boosts);
    assert.equal(side.active.includes(id),options.active===true);
    assert.equal(sha(input),digest);assert.deepEqual(input,before);
  }
});

test('narrow Emergency Exit support preserves lifecycle, PP, boosts and suppression refusals',()=>{
  const checks=[
    [value=>delete value.input.hypotheses.own[value.id].lifecycle,/lifecycle/],
    [value=>delete value.input.hypotheses.own[value.id].pp,/reserve PP/],
    [value=>{value.input.observed.boards[0].sides[0].pokemon[value.index].boosts.atk=null;delete value.input.hypotheses.own[value.id].boosts;},/unknown boosts/],
    [value=>value.input.observed.boards[0].sides[0].pokemon[value.index].abilitySuppressed=true,/ability suppression/],
  ];
  for(const [mutate,pattern]of checks){
    const value=emergencyExitFixture();mutate(value);const before=structuredClone(value.input);
    assert.throws(()=>buildObservedPosition(value.input),pattern);assert.deepEqual(value.input,before);
  }
  const active=emergencyExitFixture({active:true});active.input.hypotheses.own[active.id].pp=[11,12,12,12];
  assert.throws(()=>buildObservedPosition(active.input),/PP hypothesis conflicts with fresh request/);
});

test('future Mega metadata changes no current facts; copied abilities require agreeing sources and preserve base ability',()=>{
  const base=emergencyExitFixture({active:true});base.input.observed.actions[0].prospectiveAuthoredPair=[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:1,target:2}];
  const unchanged=buildObservedPosition(base.input).position.sides[0].pokemon.find(p=>p.id===base.id);assert.equal(unchanged.species,'Golisopod');assert.equal(unchanged.ability,'Emergency Exit');
  for(const mutate of [value=>value.input.observed.actions[0].legalActions.pokemon[value.index].ability='Tough Claws',value=>value.input.observed.boards[0].sides[0].pokemon[value.index].ability='Tough Claws']){const value=emergencyExitFixture({active:true});mutate(value);assert.throws(()=>buildObservedPosition(value.input),/current ability conflicts/);}
  const copied=emergencyExitFixture({active:true});copied.input.observed.actions[0].legalActions.pokemon[copied.index].ability='Tough Claws';copied.input.observed.boards[0].sides[0].pokemon[copied.index].ability='Tough Claws';
  for(const build of [buildObservedPosition,buildApproximateObservedPosition]){const copiedActor=build(copied.input).position.sides[0].pokemon.find(p=>p.id===copied.id);assert.equal(copiedActor.species,'Golisopod');assert.equal(copiedActor.ability,'Tough Claws');assert.equal(copiedActor.nativeState.baseAbility,'Emergency Exit');}
  const value=emergencyExitFixture({active:true}),pokemon=value.input.observed.boards[0].sides[0].pokemon[value.index];
  Object.assign(pokemon,{species:'Golisopod-Mega',ability:'Tough Claws',mega:true});
  value.input.observed.actions[0].legalActions.pokemon[value.index].ability='Tough Claws';
  value.input.hypotheses.sideMegaUsed.p1=true;
  for(const build of [buildObservedPosition,buildApproximateObservedPosition]){const current=build(value.input).position.sides[0].pokemon.find(entry=>entry.id===value.id);
    assert.equal(current.species,'Golisopod-Mega');assert.equal(current.ability,'Tough Claws');assert.notEqual(current.nativeState?.baseAbility,'Emergency Exit','A genuine Mega ability must not reset to its pre-Mega ability on switching');if(current.nativeState?.baseAbility)assert.equal(current.nativeState.baseAbility,'Tough Claws');}
});

test('native ability coverage preserves source, start-turn and selected identity guards',()=>{
  for(const [mutate,pattern]of [
    [value=>value.expected.token='b'.repeat(64),/room\/rqid\/token/],
    [value=>value.expected.teamId='b'.repeat(64),/locked team packed hash/],
    [value=>value.observed.teamSha256='b'.repeat(64),/observation belongs to another locked team/],
    [value=>value.observed.actions[0].submissionStatus='uncertain',/not an unsubmitted start-of-turn pair/],
    [value=>value.observed.actions[0].legalActions.forceSwitch=[true,false],/fresh complete four-Pokemon legal turn/],
    [value=>value.observed.boards[0].request.wait=true,/unsupported partial\/forced request/],
    [value=>value.observed.boards[0].sides[0].pokemon[2].requestIndex=1,/requestIndex mapping is duplicated/],
    [value=>value.opposingSheet[0].moves[0]='Protect',/published sheet/],
  ]){
    const {input}=emergencyExitFixture();mutate(input);assert.throws(()=>buildObservedPosition(input),pattern);
  }
  assert.equal(supportedObservedCurrentAbilities.has('wimpout'),true);
  assert.equal(supportedObservedCurrentAbilities.has('static'),true);
  const {input}=emergencyExitFixture();input.observed.boards[0].sides[1].pokemon[0].ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  assert.equal(buildObservedPosition(input).position.sides[1].pokemon.find(p=>p.id==='foe0').ability,'Static');
  input.observed.boards[0].sides[1].pokemon[0].ability='Not A Native Ability';input.hypotheses.opposing.foe0.ability='Not A Native Ability';assert.throws(()=>buildObservedPosition(input));
});

test('removing only the Emergency Exit guard cannot fill an incomplete reserve/current hypothesis inventory',()=>{
  const {input,id}=emergencyExitFixture();delete input.hypotheses.own[id];
  const before=structuredClone(input),digest=sha(input),report=collectObservedPositionDiagnostics(input,{expectedInputSha256:digest});
  const paths=report.diagnostics.map(row=>row.path.join('.'));
  assert.equal(report.ready,false);assert.equal(report.coverage.semantic,'first-refusal');assert.equal(report.coverage.calculationsRun,0);
  assert.equal(report.binding.inputJsonSha256,digest);assert.equal(sha(input),digest);assert.deepEqual(input,before);
  assert(paths.includes(`hypotheses.own.${id}.pp`));assert(paths.includes(`hypotheses.own.${id}.lifecycle`));
  assert.match(report.authoritativeFirstRefusal.message,/reserve PP/);
  assert.doesNotMatch(report.authoritativeFirstRefusal.message,/unsupported stateful\/current ability Emergency Exit/);
  assert.equal(report.coverage.allMissingAndConflictingFieldsEnumerated,false);assert.equal(report.reconstruction,undefined);
});
