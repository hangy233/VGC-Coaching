// Actual local numerical SDK + genuine synthetic engine history. No model,
// authentication, bridge, server search or live qualification is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {createNativeSpreadHistory,spreadFixtureSession,spreadFixtureRoom} from './spread-observations.fixture.mjs';
import {compileSpreadObservations} from './spread-observations.mjs';
import {generateSpreadCandidates} from './spread-candidates.mjs';

test('actual SDK filters representative spreads from synthetic native order/damage history and ignores HP-dependent countercase',async()=>{
  const fixture=createNativeSpreadHistory();let connection;
  try{
    const compiled=compileSpreadObservations(fixture.input),entry=Object.entries(compiled.spreadObservations).find(([,rows])=>rows.some(row=>row.kind==='damage'));
    assert(entry,'ordinary genuine native damage observation required');
    const [actorId,observations]=entry,actor=fixture.input.currentActors.find(actor=>actor.id===actorId),published=fixture.sheet.find(set=>set.species===actor.species);
    assert(observations.some(row=>row.kind==='move-order'));assert(published);
    const input={source:{teamId:fixture.input.binding.teamId,sessionId:spreadFixtureSession,parentId:'synthetic-parent',gameId:spreadFixtureRoom,sourceSha256:fixture.input.binding.sourceSha256},
      publishedSet:{species:published.species,nature:published.nature,ability:published.ability,item:published.item,moves:published.moves},currentForme:actor.species,conditions:{journalSha256:compiled.binding.journalSha256},
      relevantMoves:[{name:'Psychic',category:'Special'}],observations,poolLimit:8,maxCalls:32};
    connection=await connectOfflineNumericClient();const tools=[];
    const call=async(name,args,{signal,timeoutMs})=>{tools.push(name);return connection.client.callTool({name,arguments:args},undefined,{signal,timeout:timeoutMs});};
    const result=await generateSpreadCandidates(input,{call,deadlineAt:Date.now()+15000,concurrency:6});
    assert(tools.includes('calculate_speed'));assert(tools.includes('calculate_damage'));assert.equal(result.coverage.completedCalls,result.coverage.attemptedCalls,JSON.stringify(result.records.filter(row=>row.status!=='complete')));
    assert(result.rejected.length>0,'at least one actual numerical constraint must exclude a representative profile');
    assert(result.candidates.some(candidate=>candidate.checks.some(check=>check.compatible===true)),'at least one surviving hypothesis must match actual scalar constraints');
    assert(result.records.every(record=>record.rawReplySha256&&record.resultSha256));assert(result.records.filter(record=>record.tool==='calculate_damage').every(record=>record.input.attackerOptions.curHP===undefined));
    assert.equal(result.provenance.actualSdkReceiptVerified,false,'this helper does not mint a provider/live qualification brand');
    const dependent=structuredClone(input),damage=structuredClone(observations.find(row=>row.kind==='damage'));damage.input.move='Water Spout';dependent.publishedSet.moves[0]='Water Spout';dependent.relevantMoves=[{name:'Water Spout',category:'Special'}];dependent.observations=[damage];
    const before=tools.length,ignored=await generateSpreadCandidates(dependent,{call,deadlineAt:Date.now()+5000});assert.equal(tools.length,before,'HP-dependent evidence must never dispatch with guessed opposing HP');assert(ignored.ignoredConstraints[0].reasons.includes('attacker-HP-independence-not-proven'));
  }finally{await connection?.close();fixture.battle.destroy();}
});
