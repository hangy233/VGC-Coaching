import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,currentFixture} from './observed-position.fixtures.mjs';
import {buildObservedPosition} from './observed-position.mjs';
import {collectObservedPositionDiagnostics as collect} from './observed-position-diagnostics.mjs';
import {OBSERVED_POSITION_READINESS_MAX_BYTES} from './observed-position-readiness.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function retainReserve(input,index=2){
  const board=input.observed.boards[0],p=board.sides[0].pokemon[index],entry=input.observed.actions[0].legalActions.pokemon[index];
  p.nickname=entry.ident.slice(4);board.ownPpObservation={version:1,epoch:2,connected:true,continuous:true,startObserved:true,sequence:4,lastRequestRqid:4};
  p.ownPpSnapshot={version:1,status:'bench-retained',actorId:p.id,ident:entry.ident,details:entry.details,moves:[...entry.moves],pp:[12,12,12,12],requestState:{item:entry.item,ability:entry.ability,condition:entry.condition},rqid:3,epoch:2,requestSequence:1,exitSequence:2,benchVerifiedSequence:4,benchVerifiedRqid:4,exitKind:'observed-hard-switch',continuous:true};
  return p;
}

test('synthetic reproduction returns both missing reserve PP, active PP conflict and absent opposing investment/HP together',()=>{
  const input=currentFixture(),own=input.observed.boards[0].sides[0].pokemon;
  delete input.hypotheses.own.own2.pp;delete input.hypotheses.own.own3.pp;
  own[3].fainted=true;own[3].hp.current=0;input.observed.actions[0].legalActions.pokemon[3].condition='0 fnt';
  input.hypotheses.own.own0.pp=[11,12,12,12];delete input.hypotheses.opposing.foe1;
  const before=structuredClone(input),report=collect(input),paths=report.diagnostics.map(row=>row.path.join('.'));
  for(const path of ['hypotheses.own.own2.pp','hypotheses.own.own3.pp','hypotheses.own.own0.pp','hypotheses.opposing.foe1.statPoints','hypotheses.opposing.foe1.hp'])assert(paths.includes(path),path);
  const conflict=report.diagnostics.find(row=>row.status==='conflict');
  assert.deepEqual(conflict.conflictingIndices,[0]);assert.equal(conflict.sourceKind,'fresh-private-active-request');
  assert.equal(conflict.observedValueSha256,sha([12,12,12,12]));assert.equal(conflict.authoredValueSha256,sha([11,12,12,12]));
  assert.deepEqual(conflict.sourcePath,['observed','actions',0,'legalActions','active',0,'moves']);
  assert.equal(report.ready,false);assert.equal(report.coverage.semantic,'first-refusal');assert.equal(report.coverage.allMissingAndConflictingFieldsEnumerated,false);
  assert.equal(report.coverage.calculationsRun,0);assert.deepEqual(input,before);assert.equal(report.reconstruction,undefined);
  assert.throws(()=>buildObservedPosition(input),/PP hypothesis conflicts with fresh request/);
});

test('valid current and opening inputs retain exact builder readiness without returning private source or reconstruction',()=>{
  for(const make of [currentFixture,fixture]){
    const input=make(),before=structuredClone(input),report=collect(input,{expectedInputSha256:sha(input)});
    assert.equal(report.ready,true);assert.equal(report.diagnostics.length,0);assert.equal(report.binding.inputJsonSha256,sha(input));
    assert.equal(report.binding.observedSourceSha256,buildObservedPosition(input).provenance.sourceSha256);
    assert.equal(report.coverage.semanticEnumerationComplete,true);assert.equal(report.coverage.allMissingAndConflictingFieldsEnumerated,false);
    assert.deepEqual(input,before);const text=JSON.stringify(report);
    assert(!text.includes(input.expected.token));assert(!text.includes(input.expected.room));assert(!text.includes(input.teamText));assert.equal(report.reconstruction,undefined);
  }
});

test('retained PP conflict uses shared exact guard, never overwrites the authored or retained array',()=>{
  const input=currentFixture(),p=retainReserve(input);input.hypotheses.own[p.id].pp=[12,11,12,12];
  const before=structuredClone(input),report=collect(input),conflict=report.diagnostics.find(row=>row.status==='conflict');
  assert.equal(report.ready,false);assert.deepEqual(conflict.path,['hypotheses','own',p.id,'pp']);
  assert.equal(conflict.sourceKind,'shared-validated-retained-private-request');assert.deepEqual(conflict.conflictingIndices,[1]);
  assert(conflict.sourcePath.includes('ownPpSnapshot'));assert.deepEqual(input,before);
  assert.throws(()=>buildObservedPosition(input),/PP hypothesis conflicts with retained/);
});

test('claimed retained PP with invalid continuity remains unusable rather than adopted or prose-classified',()=>{
  const input=currentFixture();retainReserve(input);input.observed.boards[0].ownPpObservation.continuous=false;
  const before=structuredClone(input),report=collect(input),row=report.diagnostics.find(row=>row.code==='retained-own-pp-refused');
  assert.equal(row.status,'unusable-source-evidence');assert.equal(row.origin,'shared-retained-PP-validator');
  assert.equal(report.diagnostics.some(value=>value.status==='conflict'),false);assert.equal(report.ready,false);assert.deepEqual(input,before);
  assert.match(row.reason,/No PP is adopted/);assert(!row.reason.includes('connection continuity unavailable'));
});

test('all authoritative schema issues are retained alongside the missing field inventory',()=>{
  const input=currentFixture();delete input.teamText;delete input.hypotheses.opposing.foe0.statPoints.spe;delete input.hypotheses.reserves[1].hp;
  const report=collect(input),schema=report.diagnostics.filter(row=>row.origin==='authoritative-schema');
  for(const path of ['teamText','hypotheses.opposing.foe0.statPoints.spe','hypotheses.reserves.1.hp'])assert(schema.some(row=>row.path.join('.')===path),path);
  assert.equal(report.coverage.schema,'failed');assert.equal(report.coverage.allSchemaIssuesRetained,true);assert.equal(report.ready,false);
});

test('opening cannot bypass current guards and omitted mode is never inferred',()=>{
  const input=currentFixture();input.hypotheses.mode='opening';input.observed.boards[0].turn=2;
  const report=collect(input);assert.equal(report.ready,false);assert.equal(report.coverage.ownPp.status,'not-applicable');assert.equal(input.observed.boards[0].turn,2);
  delete input.hypotheses.mode;const absent=collect(input);assert.equal(absent.ready,false);assert.equal(input.hypotheses.mode,undefined);
  assert(absent.diagnostics.some(row=>row.path.join('.')==='hypotheses.mode'));
});

test('other semantic conflicts remain explicitly unenumerated instead of a false all-fields claim',()=>{
  const input=currentFixture();input.hypotheses.field.terrain.remainingTurns=4;
  const report=collect(input);assert.equal(report.ready,false);assert.match(report.authoritativeFirstRefusal.message,/duration hypothesis conflicts/);
  assert.equal(report.coverage.allMissingAndConflictingFieldsEnumerated,false);assert.equal(report.coverage.semanticEnumerationComplete,false);
  assert.equal(report.diagnostics.length,0);assert(report.limitations.some(text=>/other later semantic conflicts/.test(text)));
});

test('bounded invalid data and expected hash mismatch never invoke getters, proxies or typed fact comparisons',()=>{
  let accessed=0;const getter={};Object.defineProperty(getter,'observed',{enumerable:true,get(){accessed++;throw new Error('must not execute');}});
  const proxy=new Proxy({}, {get(){accessed++;throw new Error('must not execute');},ownKeys(){accessed++;throw new Error('must not execute');}});
  const cycle={};cycle.self=cycle;
  for(const input of [getter,proxy,cycle,{payload:'x'.repeat(OBSERVED_POSITION_READINESS_MAX_BYTES+1)}]){
    const report=collect(input);assert.equal(report.ready,false);assert.equal(report.coverage.ownPp.status,'unevaluated');assert.equal(report.coverage.schema,'unevaluated');
  }
  const input=currentFixture();input.hypotheses.own.own0.pp=[11,12,12,12];
  const mismatch=collect(input,{expectedInputSha256:'b'.repeat(64)});assert.equal(mismatch.ready,false);assert.equal(mismatch.coverage.ownPp.status,'unevaluated');
  assert.equal(mismatch.diagnostics.some(row=>row.status==='conflict'),false);assert.equal(accessed,0);
});
