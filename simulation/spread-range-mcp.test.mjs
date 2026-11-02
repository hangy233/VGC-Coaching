import test from 'node:test';
import assert from 'node:assert/strict';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';

test('registered range MCP fully covers a 0..32 spread interval with native damage witnesses',async t=>{
  const connection=await connectOfflineNumericClient();
  try{
    const tools=(await connection.client.listTools()).tools;assert(tools.some(tool=>tool.name==='calculate_damage_range'));
    const points=patch=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...patch});
    const started=performance.now();
    const reply=await connection.client.callTool({name:'calculate_damage_range',arguments:{gen:0,
      attacker:'Torkoal',attackerOptions:{ability:'Drought',item:'Charcoal'},defender:'Blastoise',defenderOptions:{ability:'Torrent',item:''},move:'Eruption',
      attackerDomain:{kind:'ranges',label:'Unrevealed SpA investment 0..32; explicit fixed other points',natures:['Modest'],statPoints:points({spa:{min:0,max:32}})},
      defenderDomain:{kind:'candidates',label:'One explicit bulky comparison hypothesis',candidates:[{nature:'Calm',statPoints:points({hp:32,spd:32,def:2})}]},
      field:{gameType:'Doubles',weather:'Sun',terrain:''},work:{maxCalculations:64,requireExhaustive:true}}});
    assert.notEqual(reply.isError,true,JSON.stringify(reply.content));const value=reply.structuredContent;
    assert.equal(value.kind,'champions-damage-range-v1');assert.equal(value.status,'complete-finite-domain');
    assert.equal(value.coverage.declaredAssignments,'33');assert.equal(value.coverage.completed,33);assert.equal(value.coverage.exhaustive,true);
    assert.equal(value.damageRange.scope,'all-declared-finite-assignments');assert(value.damageRange.min<value.damageRange.max);
    assert(value.records.every(row=>row.status==='complete'&&row.inputSha256&&row.resultSha256));
    for(const witness of [value.damageRange.minimumWitness,value.damageRange.maximumWitness]){
      assert(value.records.some(row=>row.id===witness.id));assert.equal(witness.attackerHP.current,witness.attackerHP.max);
    }
    t.diagnostic(JSON.stringify({actualRegisteredMcp:true,calculations:value.coverage.completed,elapsedMs:Math.round(performance.now()-started),damageRange:{min:value.damageRange.min,max:value.damageRange.max},qualification:'numeric-only; no model generation, live battle, source freshness or tactical guarantee'}));
    const broadStarted=performance.now(),broad=await connection.client.callTool({name:'calculate_damage_range',arguments:{gen:0,
      attacker:'Torkoal',attackerOptions:{ability:'Drought',item:'Charcoal'},defender:'Blastoise',defenderOptions:{ability:'Torrent',item:''},move:'Eruption',
      attackerDomain:{kind:'ranges',label:'Unknown SpA 0..32',natures:['Modest'],statPoints:points({spa:{min:0,max:32}})},
      defenderDomain:{kind:'ranges',label:'Unknown SpD 0..32',natures:['Calm'],statPoints:points({spd:{min:0,max:32}})},
      field:{gameType:'Doubles',weather:'Sun',terrain:''},work:{requireExhaustive:true}}});
    assert.notEqual(broad.isError,true,JSON.stringify(broad.content));const envelope=broad.structuredContent;
    assert.equal(envelope.coverage.completed,1089);assert.equal(envelope.coverage.exhaustive,true);assert(envelope.records.length<=16);
    assert(Buffer.byteLength(JSON.stringify(envelope))<32768);assert.equal(envelope.coverage.omittedPublicRecords,1089-envelope.records.length);
    t.diagnostic(JSON.stringify({actualRegisteredMcp:true,calculations:1089,elapsedMs:Math.round(performance.now()-broadStarted),publicBytes:Buffer.byteLength(JSON.stringify(envelope)),qualification:'complete declared finite damage domain only'}));
  }finally{await connection.close();}
});
