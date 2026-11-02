import test from 'node:test';
import assert from 'node:assert/strict';
import {enumerateSpreadDomain,executeDamageRange,registerDamageRangeTools,damageRangeToolSchema} from './spread-range.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {digest} from '../planning/identity.mjs';
import {packCalculationPayload,unpackCalculationPayload} from '../workflow/calculation-archive.mjs';
const copy=structuredClone,points=(patch={})=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...patch});
const exact=(patch={},nature='Serious')=>({kind:'candidates',label:'Explicit test domain; not a revealed opposing spread',candidates:[{nature,statPoints:points(patch)}]});
const ranged=(patch={},total={min:0,max:66},natures=['Serious'])=>({kind:'ranges',label:'Labeled test intervals; not observed investments',natures,statPoints:points(patch),total});
const base=()=>({gen:0,attacker:'Torkoal',attackerOptions:{ability:'Drought',item:'Charcoal',status:''},defender:'Blastoise',defenderOptions:{ability:'Torrent',item:'',status:''},move:'Eruption',field:{gameType:'Doubles',weather:'Sun',terrain:''},attackerDomain:exact({hp:32,spa:32,spd:2},'Modest'),defenderDomain:exact({hp:32,def:2,spd:32})});

test('finite domains enumerate all jointly legal witnesses and respect the total instead of mixing stat endpoints',()=>{
  const domain=ranged({atk:{min:0,max:1},spa:{min:0,max:1}},{min:1,max:1},['Adamant','Modest']),result=enumerateSpreadDomain(domain,{maxCandidates:8});
  assert.equal(result.coverage.legalCount,'4');assert.equal(result.coverage.returned,4);assert.equal(result.coverage.exhaustive,true);
  assert(result.candidates.every(c=>Object.values(c.statPoints).reduce((a,b)=>a+b,0)===1));assert.equal(new Set(result.candidates.map(c=>JSON.stringify([c.nature,c.statPoints]))).size,4);
  const published=enumerateSpreadDomain(domain,{publishedNature:'Modest'});assert.equal(published.coverage.legalCount,'2');assert.deepEqual(published.coverage.excludedNatures,['Adamant']);assert(published.candidates.every(c=>c.nature==='Modest'));
});

test('wide ranges return feasible attack, physical-bulk and special-bulk endpoints with exact count but partial coverage',()=>{
  const domain=ranged(Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(s=>[s,{min:0,max:32}])),{min:66,max:66},['Modest','Timid']);
  const result=enumerateSpreadDomain(domain,{maxCandidates:3,priorityStats:['spa','spe','hp','def','spd','atk']});
  assert(BigInt(result.coverage.legalCount)>3n);assert.equal(result.coverage.exhaustive,false);assert.equal(result.candidates.length,3);assert(result.candidates.every(c=>Object.values(c.statPoints).reduce((a,b)=>a+b,0)===66));
  assert.equal(result.candidates[0].statPoints.spa,32);assert.equal(result.candidates[0].statPoints.spe,32);assert.equal(result.candidates[1].statPoints.def,32);assert.equal(result.candidates[2].statPoints.spd,32);
});

test('contradictory, duplicate, missing and overbudget domains refuse before numerical work',async()=>{
  for(const domain of [ranged({hp:32,atk:32,def:3}),ranged({hp:{min:2,max:1}}),{...exact(),candidates:[{nature:'Serious',statPoints:points({hp:32,atk:32,def:3})}]},{...exact(),candidates:[...exact().candidates,...exact().candidates]},{...ranged(),natures:['Modest','Modest']}])assert.throws(()=>enumerateSpreadDomain(domain));
  assert.throws(()=>enumerateSpreadDomain(exact({},'Modest'),{publishedNature:'Adamant'}),/contradicts/u);
  const missing=ranged();delete missing.statPoints.def;assert.throws(()=>enumerateSpreadDomain(missing));
  let calls=0;await assert.rejects(executeDamageRange({...base(),attackerDomain:ranged({atk:{min:0,max:32}}),work:{maxCalculations:1,requireExhaustive:true}},{callTool:async()=>{calls++;}}),/exceeds/u);assert.equal(calls,0);
});

test('strict JSON and range tool contracts reject getters, proxies and stat/state injection without evaluating them',()=>{
  let called=0;const value={};Object.defineProperty(value,'kind',{enumerable:true,get(){called++;throw Error('getter');}});assert.throws(()=>enumerateSpreadDomain(value),/data-only/u);
  assert.throws(()=>enumerateSpreadDomain(new Proxy({},{ownKeys(){called++;throw Error('proxy');}})),/ordinary/u);assert.equal(called,0);
  for(const field of ['nature','evs','curHP','ivs','teraType'])assert.equal(damageRangeToolSchema.safeParse({...base(),attackerOptions:{...base().attackerOptions,[field]:1}}).success,false);
});

test('actual registered damage engine fully evaluates a small HP-dependent domain and retains whole-allocation extrema',async()=>{
  const connection=await connectOfflineNumericClient();try{
    const input={...base(),attackerDomain:{kind:'candidates',label:'Two explicit alternative legal allocations',candidates:[{id:'low-hp',nature:'Modest',statPoints:points({spa:32})},{id:'high-hp',nature:'Modest',statPoints:points({hp:32,spa:32,spd:2})}]},attackerHP:{kind:'values',values:[40,80]},work:{maxCalculations:4,requireExhaustive:true}},before=copy(input),calls=[];
    const result=await executeDamageRange(input,{callTool:async(name,args,options)=>{assert.equal(name,'calculate_damage');const reply=await connection.client.callTool({name,arguments:args},undefined,{signal:options.signal});calls.push({args:copy(args),result:copy(reply.structuredContent)});return reply;}});
    assert.deepEqual(input,before);assert.equal(calls.length,4);assert.equal(result.status,'complete-finite-domain');assert.equal(result.coverage.exhaustive,true);assert.equal(result.coverage.declaredAssignments,'4');
    assert.equal(result.damageRange.min,Math.min(...calls.map(c=>c.result.range[0])));assert.equal(result.damageRange.max,Math.max(...calls.map(c=>c.result.range[1])));assert.equal(new Set(calls.map(c=>c.result.attackerHP.max)).size,2);
    for(const r of result.records){assert.equal(r.attackerHP.current,r.witness.attacker.hp);assert(calls.some(c=>JSON.stringify(c.args.attackerOptions.evs)===JSON.stringify(r.witness.attacker.statPoints)&&c.args.attackerOptions.curHP===r.witness.attacker.hp&&JSON.stringify(c.result.range)===JSON.stringify(r.range)));}
    assert(result.damageRange.minimumWitness.witness.attacker.statPoints);assert.equal(result.damageRange.unit,'actual-hp');
  }finally{await connection.close();}
});

test('native cross-stat move uses each complete Defense allocation and wide ranges remain sampled under the bound',async()=>{
  const connection=await connectOfflineNumericClient();try{
    const args={...base(),attacker:'Blastoise',attackerOptions:{ability:'Rain Dish',item:''},move:'Body Press',attackerDomain:ranged({def:{min:0,max:32}}),work:{maxCalculations:2}},calls=[];
    const result=await executeDamageRange(args,{callTool:async(name,input)=>{calls.push(copy(input));return connection.client.callTool({name,arguments:input});}});
    assert.equal(calls.length,2);assert.equal(result.coverage.exhaustive,false);assert.equal(result.coverage.conservativeForDeclaredDomain,false);assert.equal(result.coverage.declaredAssignments,'33');assert.equal(result.damageRange.scope,'evaluated-legal-witnesses-only');
    assert.notEqual(result.records[0].witness.attacker.statPoints.def,result.records[1].witness.attacker.statPoints.def);assert.notDeepEqual(result.records[0].range,result.records[1].range);
  }finally{await connection.close();}
});

test('actual 33 by 33 native domain completes by default, bounds public records and retains lossless full private evidence',async t=>{
  const connection=await connectOfflineNumericClient();try{
    let retained,calls=0;const input={...base(),move:'Weather Ball',attackerDomain:ranged({hp:32,spa:{min:0,max:32},spd:2},{min:0,max:66},['Modest']),defenderDomain:ranged({hp:32,def:2,spd:{min:0,max:32}}),work:{concurrency:1,requireExhaustive:true},evidenceContext:{teamId:'a'.repeat(64),roomId:'battle-gen9championsvgc2026regmcbo3-991',turn:1}};
    assert.equal(damageRangeToolSchema.parse(input).work.maxCalculations,2048);
    const started=Date.now(),result=await executeDamageRange(input,{callTool:async(name,args,{signal})=>{calls++;return connection.client.callTool({name,arguments:args},undefined,{signal});},recordEvidence:async record=>{retained=copy(record);return {tool:'calculate_damage_range',testOnly:true};}}),elapsed=Date.now()-started;
    assert.equal(calls,1089);assert.equal(result.coverage.declaredAssignments,'1089');assert.equal(result.coverage.completed,1089);assert.equal(result.coverage.exhaustive,true);assert.equal(result.status,'complete-finite-domain');assert.equal(result.coverage.unevaluated,'0');
    assert(result.records.length<=16);assert.equal(result.coverage.omittedPublicRecords,1089-result.records.length);assert(result.records.some(r=>r.id===result.damageRange.minimumWitness.id));assert(result.records.some(r=>r.id===result.damageRange.maximumWitness.id));assert(Buffer.byteLength(JSON.stringify(result))<32*1024);
    assert.equal(retained.input.evaluations.length,1089);assert.equal(retained.input.nativeCalculations.length,1089);assert.equal(digest(retained.input.evaluations),result.coverage.evaluationSha256);
    const payload={input:retained.input,result:retained.result},packed=packCalculationPayload({tool:'calculate_damage_range',...payload}),restored=unpackCalculationPayload({tool:'calculate_damage_range',...packed});
    assert(packed.payloadArchive);assert.deepEqual(restored,payload);assert.equal(digest(restored.input.evaluations),result.coverage.evaluationSha256);assert(Buffer.byteLength(JSON.stringify(packed))<=512*1024);
    t.diagnostic(`Actual native domain:1089 calculations, ${elapsed}ms; public ${Buffer.byteLength(JSON.stringify(result))} bytes; private ${packed.payloadArchive.rawBytes} raw / ${Buffer.byteLength(JSON.stringify(packed))} stored bytes.`);
  }finally{await connection.close();}
});

test('native HP-incompatible assignments are unavailable rather than silently clamped or used as domain extrema',async()=>{
  const connection=await connectOfflineNumericClient();try{
    const result=await executeDamageRange({...base(),attackerHP:{kind:'values',values:[10000]}},{callTool:(name,args)=>connection.client.callTool({name,arguments:args})});
    assert.equal(result.status,'unavailable');assert.equal(result.damageRange,null);assert.equal(result.coverage.completed,0);assert.equal(result.coverage.exhaustive,false);assert.equal(result.coverage.unavailable,1);
  }finally{await connection.close();}
});

test('shared original deadline cancels work and late or refused replies never become an envelope',async()=>{
  let cancelled=0,called=0;const result=await executeDamageRange({...base(),attackerDomain:ranged({atk:{min:0,max:1}}),work:{maxCalculations:2}},{deadlineAt:Date.now()+30,callTool:async(name,_args,{signal})=>{assert.equal(name,'calculate_damage');called++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(Error('cancelled'));},{once:true}));}});
  assert.equal(called,2);assert.equal(cancelled,2);assert.equal(result.damageRange,null);assert.equal(result.coverage.exhaustive,false);assert.equal(result.coverage.originalDeadlineExhausted,true);
  const controller=new AbortController();controller.abort();await assert.rejects(executeDamageRange(base(),{signal:controller.signal,callTool:async()=>{throw Error('must not call');}}),/cancellation/u);
});

test('queued native work rechecks cancellation and exact cutoff at dispatch, before calling any later candidate',async()=>{
  const reply={structuredContent:{gen:0,contractVersion:'champions-damage-v2',range:[10,20],attackerHP:{current:100,max:100,unit:'actual-hp'},defenderHP:{current:100,max:100,unit:'actual-hp'}}};
  for(const kind of ['abort','cutoff']){
    const controller=new AbortController();let clock=1000,calls=0;
    const result=await executeDamageRange({...base(),attackerDomain:ranged({atk:{min:0,max:3}}),work:{maxCalculations:4,concurrency:4}},{signal:controller.signal,deadlineAt:1100,now:()=>clock,callTool:async(_name,_args,{signal})=>{assert.equal(signal.aborted,false);calls++;if(kind==='abort')controller.abort();else clock=1100;return reply;}});
    assert.equal(calls,1,kind);assert.equal(result.coverage.dispatched,1);assert.equal(result.coverage.completed,0);assert.equal(result.damageRange,null);assert.equal(result.coverage.exhaustive,false);
  }
});

test('an evidence writer queued after completion cannot start once cancellation reaches its dispatch boundary',async()=>{
  const controller=new AbortController();let nativeReturned=false,afterNative=0,writes=0;
  const now=()=>{if(nativeReturned&&++afterNative===3)queueMicrotask(()=>controller.abort());return 1000;};
  await assert.rejects(executeDamageRange({...base(),evidenceContext:{teamId:'a'.repeat(64),roomId:'battle-gen9championsvgc2026regmcbo3-991'}},{signal:controller.signal,now,deadlineAt:2000,callTool:async()=>{nativeReturned=true;return {structuredContent:{gen:0,contractVersion:'champions-damage-v2',range:[10,20],attackerHP:{current:100,max:100,unit:'actual-hp'},defenderHP:{current:100,max:100,unit:'actual-hp'}}};},recordEvidence:async()=>{writes++;return {testOnly:true};}}),/deadline\/cancellation/u);
  assert.equal(writes,0);
});

test('registered wrapper publishes labeled range schema and emits a concise refusal without source or battle mutation',async()=>{
  const tools=new Map();registerDamageRangeTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},{});
  assert(tools.has('calculate_damage_range'));assert.equal(tools.get('calculate_damage_range').config.annotations.readOnlyHint,true);
  const result=await tools.get('calculate_damage_range').handler(base());assert.equal(result.isError,true);assert.match(result.content[0].text,/dispatcher/u);
});

test('zero-completion wrapper is an error; partial native coverage stays a returned range despite requireExhaustive',async()=>{
  const tools=new Map(),reply={structuredContent:{gen:0,contractVersion:'champions-damage-v2',range:[10,20],attackerHP:{current:100,max:100,unit:'actual-hp'},defenderHP:{current:100,max:100,unit:'actual-hp'}}};let calls=0;
  registerDamageRangeTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{callTool:async()=>({isError:true,content:[{type:'text',text:'Native fixture refusal; no numerical claim.'}]})});
  const unavailable=await tools.get('calculate_damage_range')(base());assert.equal(unavailable.isError,true);assert.equal(unavailable.structuredContent.status,'unavailable');assert.equal(unavailable.structuredContent.damageRange,null);
  registerDamageRangeTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{callTool:async()=>++calls===1?reply:{isError:true,content:[{type:'text',text:'One explicit candidate unavailable.'}]}});
  const partial=await tools.get('calculate_damage_range')({...base(),attackerDomain:ranged({atk:{min:0,max:1}}),work:{requireExhaustive:true}});
  assert.equal(partial.isError,undefined);assert.equal(partial.structuredContent.status,'partial-candidate-envelope');assert.equal(partial.structuredContent.coverage.exhaustive,false);assert.equal(partial.structuredContent.damageRange.min,10);
});
