import test from 'node:test';
import assert from 'node:assert/strict';
import {presentSingleChoiceOutcome} from './choice-presentation.mjs';
const fixture=()=>({source:{choiceAuthority:false},engine:{native:true},branches:[{id:'primary',ourActions:[{type:'pass'},{type:'pass'}]}],worlds:[{id:'world-1',profiles:[],assumptions:['Conditional HP/spread'],stateAssumptions:[{path:'own.counter',reason:'unknown',selected:0}],initialState:{turn:3},samples:[{branchId:'primary',seed:[1,2,3,4],accepted:{p1:true,p2:true},stateCoverage:{complete:false,approximate:true,assumptions:[{path:'own.counter',reason:'unknown',selected:0},{path:'foe.hp',reason:'bucket'}],diagnostics:['not exact']},events:[{type:'cant',actorId:'a',raw:'|cant|a|flinch'},{type:'faint',actorId:'b'}],final:{turn:3,sides:[{pokemon:[{id:'b',hp:0,status:'',boosts:{atk:1}}]}],field:{weather:'rain'}},actionOutcomes:[{id:'a',denied:true}],boundary:'forced-replacement',turnComplete:false,replacementRequest:{sides:[{sideId:'p2',forceSwitch:[true,false]}]},replacementDecisions:[],unusedContinuations:0,pendingActions:[{pokemonId:'a',move:'psychic'}],pendingPhases:['move'],noPendingContinuation:false,initializationEvents:[],stochastic:{deterministicSeed:true},hpHypotheses:[{selectedHp:11,minCompatibleHp:10,maxCompatibleHp:11}]}]}],coverage:{worlds:1,branches:1,samples:1,koProbability:false},spreadRangeCoverage:[]});
test('one-outcome view preserves exact end board, event order, pending trajectory and every assumption once',()=>{
  const input=fixture(),before=structuredClone(input),out=presentSingleChoiceOutcome(input),sample=input.worlds[0].samples[0];
  for(const key of ['final','events','actionOutcomes','replacementRequest','replacementDecisions','pendingActions','pendingPhases','hpHypotheses'])assert.deepEqual(out.outcome[key],sample[key]);
  assert.equal(out.outcome.turnComplete,false);assert.equal(out.outcome.noPendingContinuation,false);assert.equal(out.stateCoverage.complete,false);assert.equal(out.stateCoverage.available,true);assert.equal(out.stateCoverage.assumptions.length,2);assert.deepEqual(out.stateCoverage.diagnostics,['not exact']);assert.deepEqual(input,before);
  out.stateCoverage.assumptions[0].selected=5;assert.deepEqual(input,before,'presentation must not alias the private source');
});
test('compact inference summary retains cached and deferred coverage without claiming new numerical work',()=>{
  const input=fixture();input.inference={policy:'cache-only',modelFirst:true,newNumericCalls:0,cachedNumericChecks:2,deferredNumericChecks:3,actors:[{id:'foe',status:'representative-pool-partially-or-not-filtered'}]};
  const result=presentSingleChoiceOutcome(input);assert.deepEqual(result.inference,input.inference);result.inference.actors[0].status='changed';assert.equal(input.inference.actors[0].status,'representative-pool-partially-or-not-filtered');assert.equal(Object.hasOwn(result.hypotheses,'inference'),false);
});
test('missing native coverage is explicitly unavailable and source assumptions never vanish',()=>{
  const input=fixture();delete input.worlds[0].samples[0].stateCoverage;
  const out=presentSingleChoiceOutcome(input);assert.equal(out.stateCoverage.available,false);assert.deepEqual(out.stateCoverage.assumptions,input.worlds[0].stateAssumptions);
});
test('multi-world, multi-branch, empty and malformed coverage refuse rather than silently select an outcome',()=>{
  for(const change of [x=>x.worlds.push(x.worlds[0]),x=>x.branches.push(x.branches[0]),x=>x.worlds[0].samples.push(x.worlds[0].samples[0]),x=>x.worlds[0].samples=[]]){
    const input=fixture();change(input);assert.throws(()=>presentSingleChoiceOutcome(input),/exactly one/u);
  }
});
