import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildObservedPosition} from './observed-position.mjs';
import {fixture,currentFixture} from './observed-position.fixtures.mjs';
import {observedPositionInputSchema} from './schemas.mjs';
import {inspectObservedPositionReadiness as inspect,OBSERVED_POSITION_READINESS_MAX_BYTES} from './observed-position-readiness.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const first=report=>report.blockers.find(row=>row.origin==='authoritative-builder-first-refusal');

test('valid opening and current fixtures return the exact authoritative reconstruction without mutation or native work',()=>{
  for(const make of [fixture,currentFixture]){
    const input=make(),before=structuredClone(input),expected=buildObservedPosition(input),report=inspect(input,{expectedInputSha256:sha(input)});
    assert.deepEqual(input,before);assert.equal(report.ready,true);assert.deepEqual(report.reconstruction,expected);
    assert.equal(report.binding.inputJsonSha256,sha(input));assert.equal(report.binding.observedSourceSha256,expected.provenance.sourceSha256);
    assert.equal(report.binding.builderSourceSha256,undefined);assert.equal(report.binding.observedSourceSha256,sha({action:input.observed.actions[0],board:input.observed.boards[0]}));
    assert.match(report.binding.observedSourceHashSemantics,/not executable source/);
    assert.equal(report.binding.sourceValidation,'authoritative-builder-passed');assert.equal(report.coverage.semantic,'passed');
    assert.equal(report.blockers.length,0);assert.equal(report.coverage.calculationsRun,0);
    assert(report.unevaluated.some(row=>row.check==='native-reconstruction-and-branches'));
  }
});

test('every simultaneous schema issue is retained with missing hypotheses separate from invalid source',()=>{
  const input=currentFixture();delete input.teamText;delete input.expected.token;
  delete input.hypotheses.opposing.foe0.statPoints.spe;delete input.hypotheses.reserves[1].hp;
  const report=inspect(input),paths=report.blockers.map(row=>row.path.join('.'));
  assert.equal(report.ready,false);assert.equal(report.coverage.schema,'failed');assert.equal(report.coverage.allSchemaIssuesRetained,true);
  assert.deepEqual(report.blockers.map(({path,code,message})=>({path,code,message})),observedPositionInputSchema.safeParse(input).error.issues.map(({path,code,message})=>({path,code,message})));
  for(const path of ['teamText','expected.token','hypotheses.opposing.foe0.statPoints.spe','hypotheses.reserves.1.hp'])assert(paths.includes(path),path);
  assert(report.blockers.some(row=>row.category==='missing-hypothesis'));assert(report.blockers.some(row=>row.category==='invalid-source'));
  assert.equal(report.coverage.semantic,'unevaluated');assert.equal(report.binding.sourceValidation,'unverified');
  assert.equal(report.reconstruction,undefined);assert(report.unevaluated.some(row=>/no placeholders/i.test(row.reason)));
});

test('source-bound snapshot rejects expected-input drift and actual token, team and sheet drift',()=>{
  const original=fixture(),bound=sha(original),changed=structuredClone(original);changed.observed.revision++;
  const mismatch=inspect(changed,{expectedInputSha256:bound});assert.equal(mismatch.ready,false);assert.equal(mismatch.blockers[0].origin,'expected-input-binding');
  for(const mutate of [input=>input.expected.token='b'.repeat(64),input=>input.expected.teamId='b'.repeat(64),input=>input.opposingSheet[2].moves[0]='Fiery Dance']){
    const input=fixture();mutate(input);const report=inspect(input);
    assert.equal(report.ready,false);assert.equal(first(report).category,'invalid-source');assert.equal(report.binding.sourceValidation,'unverified');
  }
});

test('known native current ability stays unchanged when a future Mega pair is recorded in observation metadata',()=>{
  const input=currentFixture(),foe=input.observed.boards[0].sides[1].pokemon[0];
  foe.ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  const before=inspect(input);assert.equal(before.ready,true);assert.equal(first(before),undefined);
  assert.equal(before.reconstruction.position.sides[1].pokemon.find(p=>p.id==='foe0').ability,'Static');
  input.observed.actions[0].prospectiveAuthoredPair=[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:1,target:2}];
  const after=inspect(input);assert.equal(after.ready,true);assert.equal(first(after),undefined);
  assert(after.currentAbilitySupport.some(row=>row.pokemonId==='foe0'&&row.ability==='Static'&&row.listedSupported===true));
  const actor=buildObservedPosition(input).position.sides[1].pokemon.find(p=>p.id==='foe0');assert.equal(actor.species,'Raichu');assert.equal(actor.ability,'Static');
});

test('missing reserves, reserve PP and current lifecycle remain explicit first refusals without filling state',()=>{
  for(const [mutate,pattern]of [
    [input=>input.hypotheses.reserves.pop(),/reserve count/],
    [input=>delete input.hypotheses.own.own2.pp,/reserve PP/],
    [input=>delete input.hypotheses.own.own0.lifecycle,/lifecycle/],
  ]){
    const input=currentFixture();mutate(input);const before=structuredClone(input),report=inspect(input);
    assert.equal(report.ready,false);assert.equal(first(report).category,'missing-hypothesis');assert.match(first(report).message,pattern);
    assert.equal(report.coverage.semanticEnumerationComplete,false);assert.deepEqual(input,before);assert.equal(report.reconstruction,undefined);
  }
});

test('advisory source paths distinguish supplied facts and missing authored slots while coverage remains incomplete',()=>{
  const input=currentFixture();delete input.hypotheses.own.own0.lifecycle;delete input.hypotheses.own.own2.pp;delete input.hypotheses.opposing.foe1;
  const report=inspect(input),missing=report.authoredRequirements.filter(row=>row.status==='missing').map(row=>row.path.join('.'));
  assert(report.knownInputs.some(row=>row.path.join('.')==='teamText'&&row.origin==='supplied locked six'));
  for(const path of ['hypotheses.own.own0.lifecycle','hypotheses.own.own2.pp','hypotheses.opposing.foe1.statPoints'])assert(missing.includes(path),path);
  assert.equal(report.reserveSelection.expectedUnrevealedSelected,2);assert.equal(report.reserveSelection.suppliedHypotheticalReserves,2);
  assert.equal(report.blockers.filter(row=>row.origin==='authoritative-builder-first-refusal').length,1);
  assert(report.unevaluated.some(row=>row.check==='remaining-semantic-checks'&&/unknown/.test(row.reason)));
  assert.match(report.scope,/advisory subset/);assert(report.knownInputs.every(row=>row.validation===(row.path[0]==='observed'?'supplied-container-binding-only':'unverified-until-authoritative-build')));
});

test('empty opposing reserves never become an automatic selected four',()=>{
  const input=fixture();input.hypotheses.reserves=[];const report=inspect(input);
  assert.equal(report.ready,false);assert.match(first(report).message,/reserve count/);
  assert.equal(report.reserveSelection.expectedUnrevealedSelected,2);assert.equal(report.reserveSelection.suppliedHypotheticalReserves,0);
});

test('empty reserves can pass when all four opposing identities are actually represented',()=>{
  const input=currentFixture(),foe=input.observed.boards[0].sides[1];
  for(const reserve of input.hypotheses.reserves){
    const set=input.opposingSheet.find(row=>row.species===reserve.species),{id,species,...hypothesis}=reserve;
    foe.pokemon.push({id,species,hp:{current:100,max:100,precision:'server-display'},status:reserve.status,fainted:false,mega:null,
      boosts:structuredClone(reserve.boosts),abilitySuppressed:false,ability:set.ability,itemKnown:true,item:set.item,volatiles:structuredClone(reserve.volatiles)});
    input.hypotheses.opposing[id]=hypothesis;
  }
  input.hypotheses.reserves=[];foe.unrevealedSelected=0;
  const report=inspect(input);assert.equal(report.ready,true);assert.deepEqual(report.reconstruction,buildObservedPosition(input));
  assert.equal(report.reserveSelection.expectedUnrevealedSelected,0);assert.equal(report.reserveSelection.suppliedHypotheticalReserves,0);
});

test('opening mode is not used as a shortcut around current history',()=>{
  // Keep hypotheses valid for opening mode so this reaches the history guard,
  // rather than failing schema validation on forbidden current-state overrides.
  const input=fixture();input.observed.boards[0].turn=2;
  const report=inspect(input);assert.equal(report.ready,false);assert.match(first(report).message,/opening reconstruction requires first turn/);
});

test('strict bounded JSON rejects oversized, cyclic, nonfinite and accessor inputs without invoking getters',()=>{
  let getterCalls=0;const accessor={};Object.defineProperty(accessor,'observed',{enumerable:true,get(){getterCalls++;throw new Error('must not run');}});
  const cyclic={};cyclic.self=cyclic;
  for(const value of [{payload:'x'.repeat(OBSERVED_POSITION_READINESS_MAX_BYTES+1)},cyclic,{value:Infinity},accessor]){
    const report=inspect(value);assert.equal(report.ready,false);assert.equal(report.blockers[0].origin,'bounded-JSON');assert.equal(report.coverage.schema,'unevaluated');
  }
  assert.equal(getterCalls,0);
});

test('unknown top-level authored actions are refused instead of changing the reconstruction contract',()=>{
  const input=currentFixture();input.actions=[{type:'move',slot:1,mega:true},{type:'move',slot:1}];
  const report=inspect(input);assert.equal(report.ready,false);assert(report.blockers.some(row=>row.code==='unrecognized_keys'));
  assert.equal(report.coverage.semantic,'unevaluated');
});

test('unrelated observation rows are bound as supplied containers and receive no authoritative endorsement',()=>{
  const input=fixture();input.observed.actions.push({room:'unrelated',rqid:99,token:'other',arbitrary:true});
  input.observed.boards.push({room:'unrelated',request:{rqid:99},arbitrary:true});
  const report=inspect(input);assert.equal(report.ready,true);
  for(const key of ['actions','boards']){
    const container=report.knownInputs.find(row=>row.path.join('.')===`observed.${key}`);
    assert.equal(container.validation,'supplied-container-binding-only');assert.equal(container.jsonSha256,sha(input.observed[key]));
    const consumed=report.consumedObservationInputs.find(row=>row.path[1]===key);
    assert.deepEqual(consumed.path,['observed',key,0]);assert.equal(consumed.jsonSha256,sha(input.observed[key][0]));
    assert.equal(consumed.validation,'authoritative-builder-passed');
  }
  assert.equal(report.consumedObservationInputs.length,2);assert(!report.consumedObservationInputs.some(row=>row.path[2]===1));
});

test('unknown opposing suppression accepts explicit false, but observed true and own unknown remain unoverridable',()=>{
  const input=currentFixture(),foe=input.observed.boards[0].sides[1].pokemon[0];
  foe.abilitySuppressed=null;delete input.hypotheses.opposing.foe0.abilitySuppressed;
  const unknown=inspect(input);assert.equal(unknown.ready,false);assert.equal(first(unknown).category,'missing-hypothesis');
  let refusal;try{buildObservedPosition(input);}catch(error){refusal=error.message;}assert.equal(first(unknown).message,refusal);
  input.hypotheses.opposing.foe0.abilitySuppressed=false;assert.equal(inspect(input).ready,true);
  foe.abilitySuppressed=true;const active=inspect(input);assert.equal(active.ready,false);assert.equal(first(active).category,'unsupported-mechanic');
  assert.equal(first(active).message,refusal);
  const own=currentFixture();own.observed.boards[0].sides[0].pokemon[0].abilitySuppressed=null;
  const ownUnknown=inspect(own);assert.equal(ownUnknown.ready,false);assert.equal(first(ownUnknown).category,'unsupported-mechanic');
});

test('an inherited Object prototype name never counts as a supplied hypothesis',()=>{
  const input=currentFixture(),foe=input.observed.boards[0].sides[1];
  foe.pokemon[0].id='constructor';foe.active[0].pokemon='constructor';delete input.hypotheses.opposing.foe0;
  const report=inspect(input);assert.equal(report.ready,false);
  for(const field of ['label','statPoints','hp','pp','lifecycle']){
    const row=report.authoredRequirements.find(value=>value.path.join('.')===`hypotheses.opposing.constructor.${field}`);
    assert.equal(row.status,'missing',field);
  }
});

test('Proxy values are rejected before any input or option reflection trap can run or throw null',()=>{
  let traps=0;const handler={ownKeys(){traps++;throw null;},getPrototypeOf(){traps++;throw null;},get(){traps++;throw null;},getOwnPropertyDescriptor(){traps++;throw null;}};
  const proxy=new Proxy({},handler),revocable=Proxy.revocable([],handler);revocable.revoke();
  for(const value of [proxy,{nested:proxy},revocable.proxy]){
    let report;assert.doesNotThrow(()=>{report=inspect(value);});
    assert.equal(report.ready,false);assert.equal(report.blockers[0].origin,'bounded-JSON');assert.match(report.blockers[0].message,/Proxy/);
  }
  let options;assert.doesNotThrow(()=>{options=inspect(fixture(),proxy);});assert.equal(options.blockers[0].origin,'bounded-options');
  assert.equal(traps,0);
});

test('oversized property names are refused before inspecting or serializing their values',()=>{
  const input={[`key${'x'.repeat(OBSERVED_POSITION_READINESS_MAX_BYTES)}`]:()=>{throw null;}};
  const report=inspect(input);assert.equal(report.ready,false);assert.match(report.blockers[0].message,/Property name exceeds/);
  assert.equal(report.coverage.schema,'unevaluated');
});

test('absent mode leaves current-ability facts explicitly conditional without inserting a mode or reaching semantics',()=>{
  const input=currentFixture();delete input.hypotheses.mode;
  input.observed.boards[0].sides[1].pokemon[0].ability='Static';input.hypotheses.opposing.foe0.ability='Static';
  const report=inspect(input);assert.equal(report.ready,false);assert.equal(report.coverage.semantic,'unevaluated');
  assert.equal(report.currentAbilityDiagnostic.applicability,'conditional-mode-not-authored');assert.equal(report.currentAbilityDiagnostic.noModeInferred,true);
  assert(report.currentAbilitySupport.some(row=>row.ability==='Static'&&row.listedSupported===true&&row.appliesOnlyWhen==='current'));
  assert(report.blockers.some(row=>row.path.join('.')==='hypotheses.mode'&&row.category==='missing-hypothesis'));
  assert.equal(first(report),undefined);assert.equal(report.reconstruction,undefined);assert.equal(input.hypotheses.mode,undefined);
  const opening=inspect(fixture());assert.equal(opening.currentAbilityDiagnostic.applicability,'not-applicable-opening');assert.deepEqual(opening.currentAbilitySupport,[]);
});

test('input binding hashes exact JSON order rather than canonicalizing an otherwise equal builder input',()=>{
  const input=fixture(),{expected,...remaining}=input,reordered={expected,...remaining};
  const firstReport=inspect(input),second=inspect(reordered);assert.equal(firstReport.ready,true);assert.equal(second.ready,true);
  assert.deepEqual(firstReport.reconstruction,second.reconstruction);assert.notEqual(firstReport.binding.inputJsonSha256,second.binding.inputJsonSha256);
  assert.equal(firstReport.binding.observedSourceSha256,second.binding.observedSourceSha256);
  assert.match(second.binding.inputHashSemantics,/not canonical JSON/);
  assert.equal(inspect(reordered,{expectedInputSha256:firstReport.binding.inputJsonSha256}).ready,false);
});


test('readiness distinguishes retained private reserve PP and positive Mega facts from still-unknown authored state',()=>{
  const input=currentFixture(),board=input.observed.boards[0],p=board.sides[0].pokemon[2],entry=input.observed.actions[0].legalActions.pokemon[2];
  p.nickname=entry.ident.slice(4);board.ownPpObservation={version:1,epoch:2,connected:true,continuous:true,startObserved:true,sequence:4,lastRequestRqid:4};
  p.ownPpSnapshot={version:1,status:'bench-retained',actorId:p.id,ident:entry.ident,details:entry.details,moves:entry.moves,pp:[12,12,12,12],requestState:{item:entry.item,ability:entry.ability,condition:entry.condition},rqid:3,epoch:2,requestSequence:1,exitSequence:2,benchVerifiedSequence:4,benchVerifiedRqid:4,exitKind:'observed-hard-switch',continuous:true};
  delete input.hypotheses.own[p.id].pp;
  for(const side of board.sides)side.pokemon[0].mega=true;delete input.hypotheses.sideMegaUsed;
  const report=inspect(input),required=report.authoredRequirements.map(row=>row.path.join('.'));
  assert.equal(report.ready,true);assert.equal(required.includes('hypotheses.own.own2.pp'),false);assert.equal(required.some(path=>path.startsWith('hypotheses.sideMegaUsed')),false);
  assert(required.includes('hypotheses.own.own2.lifecycle'));assert(required.includes('hypotheses.opposing.foe0.pp'));
  assert(report.knownInputs.some(row=>row.origin==='verified private request PP through clean observed exit to bench'));
  input.hypotheses.own[p.id].pp=[11,12,12,12];
  const conflict=inspect(input);assert.equal(conflict.ready,false);assert.equal(conflict.knownInputs.some(row=>row.origin==='verified private request PP through clean observed exit to bench'),false);
  assert(conflict.blockers.some(row=>/PP hypothesis conflicts/.test(row.message)));delete input.hypotheses.own[p.id].pp;
  board.ownPpObservation.continuous=false;board.sides[0].pokemon[0].mega=null;
  const unavailable=inspect(input),missing=unavailable.authoredRequirements.map(row=>row.path.join('.'));
  assert(missing.includes('hypotheses.own.own2.pp'));assert(missing.includes('hypotheses.sideMegaUsed.p1'));assert.equal(unavailable.ready,false);
  board.ownPpObservation.continuous=true;input.hypotheses.sideMegaUsed={p1:false};
  const partial=inspect(input);assert.equal(partial.ready,true);assert.equal(partial.authoredRequirements.some(row=>row.path.join('.')==='hypotheses.sideMegaUsed.p2'),false);
});
