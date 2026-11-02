import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnedSimulationFixture,room} from '../simulation/owned-choice-fixture.mjs';

test('actual client structural feed assembles current native history and preserves a read-only pre-send frozen position',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const source=f.source(),first=f.session.simulationContext({source});
    assert.equal(first.assembly.coverage.completeHistory,true);assert.equal(first.assembly.coverage.auditedHistory,true);
    assert(first.assembly.facts.reserveEligibility.length);assert.equal(first.liveFreshness,true);
    const before=f.sent.length;
    const result=await f.session.execute({id:'synthetic-choice',op:'choose',confirmed:true,token:source.token,actions:[{type:'move',slot:4},{type:'move',slot:4}]});
    assert.equal(result.ok,true,result.error);assert(result.result.frozenSimulation);
    assert.equal(f.sent.length,before+1,'Only the native choice; source assembly adds no socket writes');
    assert.throws(()=>f.session.simulationContext({source}),/stale|reserved/);
    const freezeId=result.result.frozenSimulation.freezeId,saved=f.session.simulationContext({source,mode:'frozen',freezeId});
    assert.equal(saved.liveFreshness,false);assert.equal(saved.choiceAuthority,false);assert.equal(saved.semanticSha256,first.semanticSha256);
    assert.deepEqual(saved.assembly.facts,first.assembly.facts);
    assert.throws(()=>f.session.simulationContext({source:{...source,rqid:source.rqid+1},mode:'frozen',freezeId}),/differs/);
    f.choose('move 4, move 4','move 4, move 4');
    const next=f.session.simulationContext({source:f.source()});assert.notEqual(next.semanticSha256,first.semanticSha256);
    assert.equal(f.session.simulationContext({source,mode:'frozen',freezeId}).semanticSha256,first.semanticSha256);
    f.client.close();assert.throws(()=>f.session.simulationContext({source,mode:'frozen',freezeId}),/connected/);
  }finally{f.close();}
});
test('explicitly itemless published sets retain known empty items and conditional reserve freshness',async()=>{
  const f=await createOwnedSimulationFixture({itemless:true});try{
    const context=f.session.simulationContext({source:f.source()});
    assert.equal(context.opposingSheet.find(p=>p.species==='Golisopod').item,'');
    const reserve=context.assembly.facts.reserveEligibility.find(p=>p.species==='Golisopod');assert.ok(reserve);assert.equal(reserve.item,'');
  }finally{f.close();}
});
test('benign chat and timer observations do not change semantic facts; missing audit never prevents a normal legal choice',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const source=f.source(),first=f.session.simulationContext({source});
    f.tick();f.client.receive(`>${room}\n|c|Foe|hello\n|inactive|Time left: 55 sec this turn`);
    const second=f.session.simulationContext({source});assert.equal(second.semanticSha256,first.semanticSha256);
    assert.notEqual(second.assembly.binding.historySha256,first.assembly.binding.historySha256);
    f.session.choiceHistories.get(room).invalidate('Synthetic lost feed');
    const result=await f.session.execute({id:'choice-without-simulation',op:'choose',confirmed:true,token:source.token,actions:[{type:'move',slot:4},{type:'move',slot:4}]});
    assert.equal(result.ok,true,result.error);
    if(result.result.frozenSimulation){const saved=f.session.simulationContext({source,mode:'frozen',freezeId:result.result.frozenSimulation.freezeId});assert.equal(saved.assembly.coverage.auditedHistory,false);}
  }finally{f.close();}
});
