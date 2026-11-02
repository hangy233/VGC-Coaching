import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,currentFixture} from './observed-position.fixtures.mjs';
import {buildObservedPosition,publishedSheetDigest} from './observed-position.mjs';
import {inspectObservedPositionReadiness} from './observed-position-readiness.mjs';
import {simulationToolSchema} from './schemas.mjs';
import {deliveryCheckSchema} from '../planning/delivery.mjs';
import {translateOfflineObservedSimulation} from '../observability/offline-observed-simulation.mjs';
import {compileObservedSimulation as compile,projectObservedReadinessCard as project,observedSimulationPreparationOptionsSchema} from './observed-position-preparation.mjs';

const copy=structuredClone,sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function source(make=currentFixture){
  const input=make();input.observed.teamSha256=input.expected.teamId;
  input.observed.boards[0].opponentSheets={p2:copy(input.opposingSheet)};return input;
}
function options(name='simulate_turn'){
  return {name,ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],budgetMs:1000,
    branches:[{id:'explicit-pressure',opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:1,target:2}],gate:{kind:'delivery',requiredActionsBy:['own1'],survive:['own1']}}],
    seeds:[[1,2,3,4],[5,6,7,8]]};
}
function assertBlocked(result){assert.equal(result.compiled,false);assert.equal(result.status,'blocked');assert.equal(result.card.ready,false);assert.equal(result.call,undefined);assert.equal(result.dispatches,0);}

test('opening/current preparation preserves exact observed requests and actual exported schema contracts for both tools',()=>{
  for(const make of [fixture,currentFixture])for(const name of ['simulate_turn','battle_check_plan']){
    const input=source(make),authored=options(name),before=copy({input,authored}),result=compile(input,authored);
    assert.equal(result.status,'prepared');assert.equal(result.compiled,true);assert.equal(result.card.ready,true);
    assert.deepEqual({input,authored},before);assert.equal(result.call.name,name);
    const args=result.call.arguments;(name==='simulate_turn'?simulationToolSchema:deliveryCheckSchema).parse(args);
    assert.equal(args.request.kind,'observed');assert.deepEqual(args.request.hypotheses,input.hypotheses);
    assert.deepEqual(args.request.source,{sessionId:input.observed.sessionId,...input.expected,opposingSheetSha256:publishedSheetDigest(input.opposingSheet)});
    assert.deepEqual(args.request.seeds,authored.seeds);assert.equal(result.receipt.inputJsonSha256,sha(input));
    assert.equal(result.receipt.observedSourceSha256,buildObservedPosition(input).provenance.sourceSha256);
    assert.equal(result.receipt.requestJsonSha256,sha(args.request));assert.equal(result.receipt.nativeArgumentsJsonSha256,sha(args));
    assert.deepEqual(result.callOptions,{timeoutMs:1000});assert.equal(result.receipt.dispatches,0);assert.equal(result.receipt.nativeAcceptance,false);
    assert.equal(result.receipt.evidenceWritten,false);assert.equal(result.receipt.sourceFreshness,false);
    if(name==='simulate_turn'){
      assert.equal(args.budgetMs,undefined);assert.deepEqual(args.evidenceContext,{teamId:input.expected.teamId,roomId:'battle-gen9championsvgc2026regmcbo3-123',turn:1});
    }else{assert.equal(args.budgetMs,1000);assert.equal(args.evidenceContext,undefined);}
  }
});

test('pure offline comparison explicitly removes evidence metadata, retaining the original compiled request and both hashes',()=>{
  for(const name of ['simulate_turn','battle_check_plan']){
    const input=source(),result=compile(input,options(name)),compiled=copy(result.call.arguments);
    const {evidenceContext,...offline}=copy(compiled);
    if(name==='simulate_turn'){assert(evidenceContext);assert.throws(()=>translateOfflineObservedSimulation(name,compiled,input),/cannot write calculation evidence/);assert.notEqual(sha(offline),result.receipt.nativeArgumentsJsonSha256);}
    const translated=translateOfflineObservedSimulation(name,offline,{observed:input.observed,teamText:input.teamText,opposingSheet:input.opposingSheet});
    assert.equal(translated.translation.authoredInputSha256.length,64);assert.equal(translated.input.request.kind,'explicit');
    assert.deepEqual(translated.input.request.position,buildObservedPosition(input).position);
    assert.deepEqual(translated.input.request.branches,compiled.request.branches);assert.deepEqual(translated.input.request.seeds,compiled.request.seeds);
    assert.deepEqual(result.call.arguments,compiled);assert.equal(result.receipt.nativeArgumentsJsonSha256,sha(compiled));
  }
});

test('one explicit own pair is copied into every retained opposing branch without inventing IDs, gates or seeds',()=>{
  const input=source(),authored=options();authored.branches.push({...copy(authored.branches[0]),id:'explicit-counter',opposingActions:[{type:'move',slot:4},{type:'move',slot:2,target:1}]});
  const result=compile(input,authored);assert.equal(result.compiled,true);
  for(const [index,branch]of result.call.arguments.request.branches.entries()){
    assert.deepEqual(branch,{...authored.branches[index],ourActions:authored.ourActions});
  }
  assert.notEqual(result.call.arguments.request.branches[0].ourActions,result.call.arguments.request.branches[1].ourActions);
  assert.equal(result.receipt.authoredOurActionsJsonSha256,sha(authored.ourActions));
});

test('reordered switch slots bind to exact current identities and unmatched or active switch identities stay refused',()=>{
  const input=source(),legal=input.observed.actions[0].legalActions;
  legal.pokemon=[legal.pokemon[2],legal.pokemon[3],legal.pokemon[0],legal.pokemon[1]];
  for(const p of input.observed.boards[0].sides[0].pokemon)p.requestIndex={own0:3,own1:4,own2:1,own3:2}[p.id];
  const authored=options();authored.ourActions[0]={type:'switch',slot:1};const result=compile(input,authored);
  assert.equal(result.compiled,true);const order=buildObservedPosition(input).provenance.ownRequestOrder,identity=order.find(row=>row.snapshotId==='own2').controlPokemonId;
  assert.deepEqual(result.call.arguments.request.branches[0].ourActions[0],{type:'switch',pokemonId:identity});
  const named=copy(authored);named.ourActions[0]={type:'switch',pokemonId:'own2'};assert.deepEqual(compile(input,named).call.arguments.request,result.call.arguments.request);
  for(const pokemonId of ['unmatched','own0']){const wrong=copy(authored);wrong.ourActions[0]={type:'switch',pokemonId};assertBlocked(compile(input,wrong));}
});

test('changed hypotheses and source cannot reuse the exact prior input binding',()=>{
  const input=source(),authored=options(),first=compile(input,authored);authored.expectedInputSha256=first.receipt.inputJsonSha256;
  const changed=copy(input);changed.hypotheses.opposing.foe0.label='Changed explicit candidate';assertBlocked(compile(changed,authored));
  const unbound=options(),fresh=compile(changed,unbound);assert.equal(fresh.compiled,true);assert.notEqual(fresh.receipt.inputJsonSha256,first.receipt.inputJsonSha256);
  assert.deepEqual(fresh.call.arguments.request.hypotheses,changed.hypotheses);
  const stale=copy(input);stale.expected.token='b'.repeat(64);assertBlocked(compile(stale,options()));
});

test('missing hypotheses/reserves/PP/lifecycle never produce a prepared native call, including an authored future Mega',()=>{
  for(const mutate of [input=>delete input.hypotheses.mode,input=>input.hypotheses.reserves=[],input=>delete input.hypotheses.own.own2.pp,input=>delete input.hypotheses.own.own0.lifecycle]){
    const input=source();mutate(input);const authored=options();authored.ourActions[0].mega=true;
    const result=compile(input,authored);assertBlocked(result);assert.notEqual(result.card.coverage?.semantic,'passed');
  }
});

test('consistent catalog abilities compile without a species whitelist and preserve their registered base ability',()=>{
  const input=source(),foe=input.observed.boards[0].sides[1].pokemon[0];foe.ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  const result=compile(input,options());assert.equal(result.compiled,true);assert.equal(result.card.ready,true);
  const current=buildObservedPosition(input).position.sides[1].pokemon[0];
  assert.equal(current.species,'Raichu');assert.equal(current.ability,'Static');assert.equal(current.nativeState.baseAbility,'Lightning Rod');
  assert.equal(result.call.arguments.request.hypotheses.opposing.foe0.ability,'Static');
  assert.equal(result.receipt.nativeAcceptance,false);assert.equal(result.receipt.dispatches,0,'pure preparation is not native execution');
  const conflict=copy(input);conflict.hypotheses.opposing.foe0.ability='Drizzle';assertBlocked(compile(conflict,options()));
  assert.match(inspectObservedPositionReadiness(conflict).blockers[0].message,/ability hypothesis conflicts with observation/u);
});

test('invalid own pair, seed, branch, unsupported route and source override remain blocked by actual contracts',()=>{
  for(const mutate of [value=>value.ourActions.pop(),value=>value.ourActions[0].slot=99,value=>value.ourActions[0].target=-1,
    value=>value.seeds=[],value=>value.seeds[0][0]=65536,value=>value.seeds.push(copy(value.seeds[0])),value=>value.branches=[],
    value=>value.branches.push(copy(value.branches[0])),value=>delete value.branches[0].opposingActions,value=>delete value.branches[0].gate,
    value=>value.branches[0].ourActions=copy(value.ourActions),value=>value.name='simulate_turn_batch',value=>value.source={sessionId:'override'}]){
    const authored=options();mutate(authored);assertBlocked(compile(source(),authored));
  }
});

test('budgets are explicit actual1..3500 constraints; only battle_check_plan accepts an authored top-level objective',()=>{
  for(const mutate of [value=>delete value.budgetMs,value=>value.budgetMs=0,value=>value.budgetMs=3501]){
    const authored=options();mutate(authored);assert.equal(observedSimulationPreparationOptionsSchema.safeParse(authored).success,false);assertBlocked(compile(source(),authored));
  }
  const raw=options();raw.objective={requiredActionsBy:['own1']};assertBlocked(compile(source(),raw));
  const delivery=options('battle_check_plan');delivery.objective={requiredActionsBy:['own1'],survive:['own1']};
  const result=compile(source(),delivery);assert.equal(result.compiled,true);assert.deepEqual(result.call.arguments.objective,delivery.objective);
});

test('default readiness card omits private reconstructed position and preserves labeled bindings and consumed facts',()=>{
  const input=source(),report=inspectObservedPositionReadiness(input);let privateReads=0;
  Object.defineProperty(report,'reconstruction',{get(){privateReads++;throw new Error('private snapshot must not be read');},enumerable:true,configurable:true});
  const card=project(report),serialized=JSON.stringify(card);assert.equal(privateReads,0);assert.equal(card.ready,true);assert(Buffer.byteLength(serialized)<=4096);
  assert.equal(card.hashes.inputJsonSha256,sha(input));assert.equal(card.hashes.observedSourceSha256,report.binding.observedSourceSha256);
  assert.equal(card.consumedObservationInputs.length,2);assert.equal(card.hashLabels.observedSourceSha256,'Consumed {action,board} input; not code');
  assert(!serialized.includes(input.teamText));assert(!serialized.includes('"position":'));assert(!serialized.includes('"hypotheses":'));assert(!serialized.includes('"reconstruction":'));
  for(const values of Object.values(card.counts))assert.equal(values[0],values[1]+values[2]);
});

test('bounded projection counts every omitted row and never promotes an overflowing or unevaluated report',()=>{
  const input=source();delete input.hypotheses.own.own0.lifecycle;const report=inspectObservedPositionReadiness(input);
  for(let i=0;i<120;i++)report.blockers.push({category:'projection-fixture',origin:'synthetic-projection-only',path:['long',i],message:'private error text '.repeat(30)});
  for(const maxBytes of [1024,1536,2048,4096]){
    const card=project(report,{maxBytes});assert(Buffer.byteLength(JSON.stringify(card))<=maxBytes);assert.equal(card.ready,false);assert.equal(card.status,'over-budget');
    assert.equal(card.counts.blockers[0],report.blockers.length);assert(card.counts.blockers[2]>0);assert.equal(card.counts.blockers[0],card.counts.blockers[1]+card.counts.blockers[2]);
    assert(card.firstSemanticRefusal||card.firstRefusal);assert(!JSON.stringify(card).includes('private error text '.repeat(30)));
  }
  const incomplete=inspectObservedPositionReadiness(source());incomplete.unevaluated.push({check:'remaining-semantic-checks',reason:'Synthetic uncompleted reconstruction guard'});
  assert.equal(project(incomplete).ready,false);
  for(const maxBytes of [0,1023,32769])assert.throws(()=>project(report,{maxBytes}),RangeError);
});

test('missing authored paths remain visible without inferring a mode or treating catalog membership as choice admission',()=>{
  const input=source();delete input.hypotheses.mode;input.observed.boards[0].sides[1].pokemon[0].ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  const report=inspectObservedPositionReadiness(input),card=project(report,{maxBytes:8192});assert.equal(card.ready,false);
  assert(card.missingAuthored.some(row=>row.path.join('.')==='hypotheses.mode'));
  assert.equal(card.currentAbilityApplicability.applicability,'conditional-mode-not-authored');
  assert.equal(card.currentAbilityApplicability.evaluation,'native-catalog-membership-only');
  assert(report.currentAbilitySupport.some(row=>row.ability==='Static'&&row.listedSupported===true&&row.appliesOnlyWhen==='current'));
  assert(!card.currentAbilityFacts.some(row=>row.ability?.text==='Static'),'known catalog rows are counted but omitted from warning rows');
  assert.match(report.readinessScope,/Exact-state reconstruction only.*not a move support gate/u);
  const unknown=copy(input);unknown.observed.boards[0].sides[1].pokemon[0].ability='NotAnActualNativeAbility';unknown.hypotheses.opposing.foe0.ability='NotAnActualNativeAbility';
  const unknownCard=project(inspectObservedPositionReadiness(unknown),{maxBytes:8192});
  assert.equal(unknownCard.ready,false);assert(unknownCard.currentAbilityFacts.some(row=>row.ability.text==='NotAnActualNativeAbility'&&row.listedSupported===false));
});

test('compiler options and report projection reject Proxy/accessor inputs without running callbacks',()=>{
  let calls=0;const proxy=new Proxy({},{get(){calls++;throw null;},ownKeys(){calls++;throw null;},getPrototypeOf(){calls++;throw null;}});
  assertBlocked(compile(source(),proxy));assert.throws(()=>project(proxy));
  const accessor={};Object.defineProperty(accessor,'name',{enumerable:true,get(){calls++;throw null;}});assertBlocked(compile(source(),accessor));assert.equal(calls,0);
});
