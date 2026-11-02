// Pure fake-dispatcher unit tests. These deliberately mint no actual-MCP proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSpreadCandidates as generate,spreadCandidatePointsSchema} from './spread-candidates.mjs';
import {digest} from '../planning/identity.mjs';
const HASH='a'.repeat(64),zero={atk:0,def:0,spa:0,spd:0,spe:0};
const knownPoints={hp:32,atk:32,def:2,spa:0,spd:0,spe:0};
const snapshot=(label)=>({label,species:'Fixture species',ability:'Fixture ability',item:'',status:'',boosts:{...zero},tailwind:false,abilitySuppressed:false,itemSuppressed:false});
function fixture(){return {
  source:{teamId:HASH,sessionId:'fixture-session',parentId:'fixture-parent',gameId:'fixture-game',sourceSha256:HASH,boardSha256:'b'.repeat(64)},
  publishedSet:{species:'Fixture species',nature:'Serious',ability:'Fixture ability',item:'',moves:['Fixture physical move','Fixture special move','Protect','Other move']},
  currentForme:'Fixture species',conditions:{weather:'',trickRoom:false},relevantMoves:[{name:'Fixture physical move',category:'Physical'}],observations:[],poolLimit:16,maxCalls:128,
};}
function speed(input){return {id:'observed-order',kind:'move-order',sourceSha256:input.source.sourceSha256,currentForme:input.currentForme,candidateIndex:0,beforeIndex:0,
  verification:{identityVerified:true,bothExecuted:true,samePriority:true,forcedOrder:false,conditionsKnown:true,abilityItemKnown:true},
  input:{gen:0,pokemon:[snapshot('candidate'),{...snapshot('known-other'),nature:'Serious',statPoints:{...knownPoints}}],field:{weather:'',terrain:'',trickRoom:false,magicRoom:false,weatherSuppressed:false}},
};}
function damage(input){return {id:'observed-damage',kind:'damage',sourceSha256:input.source.sourceSha256,currentForme:input.currentForme,candidateRole:'defender',amount:40,
  verification:{identityVerified:true,directMoveDamage:true,conditionsKnown:true,allOtherInvestmentsKnown:true,exactHp:true,roundedHp:false,crit:false,multihit:false,uncapped:true,additionalHpChanges:false},
  input:{gen:0,attacker:'Known attacker',attackerOptions:{ability:'Known ability',item:'',nature:'Serious',evs:{...knownPoints},boosts:{...zero},status:'',curHP:150},defender:input.currentForme,defenderOptions:{ability:'Fixture ability',item:'',boosts:{...zero},status:'',curHP:150},move:'Fixture physical move',moveOptions:{isCrit:false,hits:1},field:{gameType:'Doubles',weather:'',terrain:''}},
};}
function fakeDispatcher(log=[]){
  const call=async(tool,args,options)=>{
    log.push({tool,args:structuredClone(args),options});
    if(tool==='calculate_speed')return {content:[{type:'text',text:JSON.stringify({gen:0,format:'gen9championsvgc2026regmc',pokemon:args.pokemon.map((p,index)=>({index,label:p.label,species:p.species,nature:p.nature,statPoints:p.statPoints,actionSpeed:index===0?(p.statPoints.spe===32?75:50):75,orderingWarnings:[]}))})}]};
    return {structuredContent:{gen:0,contractVersion:'champions-damage-v2',damage:[args.defenderOptions.evs.def===32?20:40],range:[20,40],defenderHP:{current:150,max:200,unit:'actual-hp'}}};
  };
  call.runtimeVersion='pure-fake-fixture-v1';return call;
}
const options=extra=>({deadlineAt:Date.now()+5000,...extra});

test('representative profiles allocate legal66 points, preserve known nature and choose offense families only by supplied move relevance',async()=>{
  const input=fixture(),before=structuredClone(input),report=await generate(input,options());
  assert.equal(report.records.length,0);assert(report.candidates.every(c=>spreadCandidatePointsSchema.safeParse(c.statPoints).success&&c.nature==='Serious'));
  assert(report.coverage.families.includes('physical-speed'));assert(!report.coverage.families.includes('special-speed'));assert.equal(report.coverage.exhaustive,false);
  assert.equal(report.hiddenHpVariants.supported,false);assert.equal(report.provenance.actualSdkReceiptVerified,false);assert.deepEqual(input,before);
  input.relevantMoves=[{name:'Protect',category:'Status'}];const status=await generate(input,options());assert(!status.coverage.families.some(f=>f.startsWith('physical-')&&!f.endsWith('bulk')));
  assert.equal(report.actions,undefined);assert.equal(report.hypotheses,undefined);
});

test('declared interval witnesses use the same verified history filters without changing whole legal allocations',async()=>{
  const input=fixture(),points=spe=>({hp:0,atk:0,def:0,spa:0,spd:0,spe});
  input.candidateSpreads=[{nature:'Serious',statPoints:points(0)},{nature:'Serious',statPoints:points(32)}];
  input.observations=[speed(input)];const before=structuredClone(input),calls=[];
  const result=await generate(input,options({call:fakeDispatcher(calls)}));
  assert.deepEqual(input,before);assert.equal(calls.length,2);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].statPoints.spe,32);
  assert.equal(result.candidates[0].family,'declared-range');assert.equal(result.rejected.length,1);assert.equal(result.coverage.exhaustive,false);
  assert.equal(result.provenance.actualSdkReceiptVerified,false);
});

test('unknown nature and capped families remain labeled nonexhaustive hypotheses rather than inserted facts',async()=>{
  const input=fixture();input.publishedSet.nature=null;input.poolLimit=9;input.relevantMoves.push({name:'Fixture special move',category:'Special'});
  const report=await generate(input,options());assert.equal(report.candidates.length,9);assert(report.coverage.omittedByPoolBound>0);assert.equal(input.publishedSet.nature,null);
  assert(report.candidates.every(c=>c.provenance.natureSource==='explicit-representative-hypothesis'));assert(report.coverage.families.includes('mixed-offense-speed'));
});

test('Speed filtering uses only injected native actionSpeed, retains possible ties and does not change conditions or counterpart facts',async()=>{
  const input=fixture();input.observations=[speed(input)];const before=structuredClone(input),log=[],deadlineAt=Date.now()+5000;
  const report=await generate(input,{call:fakeDispatcher(log),deadlineAt});
  assert(report.candidates.length>0);assert(report.rejected.length>0);assert(report.candidates.every(c=>c.statPoints.spe===32));
  assert(report.candidates.every(c=>c.checks[0].status==='compatible-including-possible-tie'));
  for(const entry of log){assert.equal(entry.tool,'calculate_speed');assert.deepEqual(entry.args.pokemon[1],input.observations[0].input.pokemon[1]);assert.deepEqual(entry.args.field,input.observations[0].input.field);assert.equal(entry.options.deadlineAt,deadlineAt);assert.deepEqual(entry.options.source,input.source);}
  assert.deepEqual(input,before);assert(report.records.every(r=>r.inputSha256===digest(r.input)&&r.resultSha256===digest(r.result)));
});

test('damage uses exact native roll membership; an in-range but absent roll excludes the bounded pool without fallback',async()=>{
  const input=fixture();input.observations=[damage(input)];
  const call=async()=>({structuredContent:{gen:0,contractVersion:'champions-damage-v2',damage:[30,50],range:[30,50]}});
  const report=await generate(input,options({call}));assert.equal(report.status,'contradiction-or-unavailable');assert.equal(report.candidates.length,0);assert.equal(report.rejected.length,report.coverage.evaluatedPool);
  assert.equal(report.fallback,undefined);assert.match(report.limitations[1],/not impossibility/);
});

test('rounded HP, crit, multihit, unknown conditions, forced order and stale/form-changed observations are ignored with reasons and no calls',async()=>{
  for(const mutate of [
    o=>o.verification.roundedHp=true,o=>o.verification.crit=true,o=>o.verification.multihit=true,o=>o.verification.conditionsKnown=false,o=>o.sourceSha256='c'.repeat(64),o=>o.currentForme='Different forme',
  ]){const input=fixture(),o=damage(input);mutate(o);input.observations=[o];const log=[],report=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert.equal(report.ignoredConstraints.length,1);assert(report.candidates.length>0);}
  const input=fixture(),o=speed(input);o.verification.forcedOrder=true;input.observations=[o];const log=[],report=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert(report.ignoredConstraints[0].reasons.includes('forced-or-unknown-order'));
});

test('no default counterpart investments, candidate stat overrides or unknown weather are silently adopted',async()=>{
  for(const mutate of [o=>delete o.input.pokemon[1].statPoints,o=>o.input.pokemon[0].statPoints={...knownPoints},o=>delete o.input.field.weather]){
    const input=fixture(),o=speed(input);mutate(o);input.observations=[o];const log=[],report=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert.equal(report.ignoredConstraints.length,1);
  }
});

test('conditional activation and move/item history cannot silently use calculator defaults',async()=>{
  for(const [ability,field]of [['Unburden','unburdenActive'],['Slow Start','slowStartActive']]){
    const input=fixture(),o=speed(input);o.input.pokemon[0].ability=ability;input.observations=[o];
    const log=[],missing=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert.equal(missing.ignoredConstraints.length,1);
    o.input.pokemon[0][field]=false;const explicit=await generate(input,options({call:fakeDispatcher(log)}));assert(log.length>0);assert.equal(explicit.ignoredConstraints.length,0);
  }
  for(const mutate of [
    o=>o.input.defenderOptions.ability='Flash Fire',o=>o.input.defenderOptions.ability='Protosynthesis',o=>o.input.defenderOptions.ability='Download',o=>o.input.move='Rage Fist',o=>o.input.attackerOptions.item='Metronome',
  ]){const input=fixture(),o=damage(input);mutate(o);input.observations=[o];const log=[],report=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert.equal(report.ignoredConstraints.length,1);}
  const input=fixture(),o=speed(input);o.input.pokemon[0].ability='Quark Drive';o.input.pokemon[0].boosterEnergyActive=false;input.observations=[o];const log=[],report=await generate(input,options({call:fakeDispatcher(log)}));assert.equal(log.length,0);assert(report.ignoredConstraints[0].reasons.includes('unsupported-speed-activation-stat-history'));
  const explicit=fixture(),d=damage(explicit);d.input.defenderOptions.ability='Flash Fire';d.input.defenderOptions.abilityOn=false;explicit.observations=[d];const allowed=[];await generate(explicit,options({call:fakeDispatcher(allowed)}));assert(allowed.length>0);
});

test('cache is full-source/conditions/form/runtime bound, result copies cannot poison it, and unbranded entries cannot supply evidence',async()=>{
  const input=fixture();input.observations=[speed(input)];const cache=new Map(),log=[],call=fakeDispatcher(log);
  const first=await generate(input,options({call,cache})),count=log.length;first.records[0].result.pokemon[0].actionSpeed=99999;
  const second=await generate(input,options({call,cache}));assert.equal(log.length,count);assert.equal(second.coverage.cachedCalls,count);assert.notEqual(second.records[0].result.pokemon[0].actionSpeed,99999);
  input.conditions.trickRoom=true;await generate(input,options({call,cache}));assert(log.length>count);
  const before=log.length;call.runtimeVersion='new-runtime';await generate(input,options({call,cache}));assert(log.length>before);
  for(const [key,value]of cache)cache.set(key,structuredClone(value));const cloned=log.length;await generate(input,options({call,cache}));assert(log.length>cloned);
  const beforeExpired=log.length,expired=await generate(input,{call,cache,deadlineAt:Date.now()-1});assert.equal(log.length,beforeExpired);assert.equal(expired.coverage.cachedCalls,0);assert.equal(expired.rejected.length,0);
});

test('cache-only automatic inference dispatches no supported damage or Speed checks and keeps every unchecked candidate explicitly unavailable',async()=>{
  const input=fixture();input.observations=[speed(input),damage(input)];const before=structuredClone(input),cache=new Map(),calls=[];
  const baseline=await generate({...structuredClone(input),observations:[]},options({numericPolicy:'cache-only'}));
  const report=await generate(input,options({call:fakeDispatcher(calls),cache,numericPolicy:'cache-only'}));
  assert.deepEqual(input,before);assert.equal(calls.length,0);assert.equal(cache.size,0);
  assert.equal(report.coverage.usableObservations,2);assert.equal(report.ignoredConstraints.length,0);
  assert.deepEqual(report.candidates.map(c=>[c.id,c.nature,c.statPoints]),baseline.candidates.map(c=>[c.id,c.nature,c.statPoints]));
  assert.equal(report.rejected.length,0);assert.equal(report.status,'representative-pool-partially-or-not-filtered');
  assert(report.records.length>0);assert(report.records.every(record=>record.status==='unavailable'&&record.reason==='model-first-new-inference-deferred'&&!record.cached));
  assert(report.candidates.every(candidate=>candidate.checks.length===2&&candidate.checks.every(check=>check.status==='unavailable'&&check.reason==='model-first-new-inference-deferred'&&!Object.hasOwn(check,'compatible'))),'unchecked is neither compatibility nor exclusion evidence');
  assert.equal(report.coverage.attemptedCalls,0);assert.equal(report.coverage.completedCalls,0);assert.equal(report.coverage.cachedCalls,0);assert.equal(report.coverage.maxConcurrentCalls,0);
  assert.equal(report.coverage.deferredCalls,report.records.length);assert.equal(report.coverage.numericPolicy,'cache-only');
});

test('cache-only policy reuses exact internally branded results from earlier allowed injected dispatch without starting another check',async()=>{
  const input=fixture(),points=spe=>({hp:0,atk:0,def:0,spa:0,spd:0,spe});
  input.candidateSpreads=[{nature:'Serious',statPoints:points(0)},{nature:'Serious',statPoints:points(32)}];input.observations=[speed(input)];
  const cache=new Map(),calls=[],backend=fakeDispatcher(calls),receipt={id:'00000000-0000-4000-8000-000000000001',tool:'calculate_speed',teamId:HASH,sha256:'d'.repeat(64)};
  const call=Object.assign(async(...args)=>{const reply=await backend(...args);return {structuredContent:{...JSON.parse(reply.content[0].text),calculationRef:receipt}};},{runtimeVersion:backend.runtimeVersion});
  const first=await generate(input,options({call,cache,numericPolicy:'allow-new-calls'}));
  assert.equal(calls.length,2);assert.equal(first.coverage.attemptedCalls,2);assert.equal(first.coverage.completedCalls,2);assert.equal(first.coverage.numericPolicy,'allow-new-calls');
  assert.equal(first.candidates.length,1);assert.equal(first.rejected.length,1);assert.equal(first.status,'filtered-representative-pool');
  let newCalls=0;const forbidden=Object.assign(async()=>{newCalls++;throw Error('A cache-only check must not dispatch');},{runtimeVersion:call.runtimeVersion});
  const reused=await generate(input,options({call:forbidden,cache,numericPolicy:'cache-only'}));
  assert.equal(newCalls,0);assert.equal(calls.length,2);assert.equal(reused.coverage.attemptedCalls,0);assert.equal(reused.coverage.completedCalls,0);assert.equal(reused.coverage.cachedCalls,2);assert.equal(reused.coverage.deferredCalls,0);
  assert.deepEqual(reused.binding,first.binding,'operational admission does not change the numerical input/cache identity');
  assert.deepEqual(reused.candidates.map(c=>c.statPoints),first.candidates.map(c=>c.statPoints));assert.deepEqual(reused.rejected.map(c=>c.statPoints),first.rejected.map(c=>c.statPoints));
  assert(reused.records.every(record=>record.cached&&record.status==='complete'&&record.resultSha256===first.records.find(prior=>prior.inputSha256===record.inputSha256).resultSha256));
  assert(reused.records.every(record=>digest(record.receipt)===digest(receipt)));
  assert.equal(first.provenance.actualSdkReceiptVerified,false);assert.equal(reused.provenance.actualSdkReceiptVerified,false,'the private cache brand is not a genuine SDK qualification receipt');
});

test('cache-only misses caused by changed facts, conditions, form, runtime or poisoned unbranded entries cannot reuse or launch checks',async()=>{
  const mutations=[
    ['source facts',({input})=>{input.source.boardSha256='c'.repeat(64);}],
    ['conditions',({input})=>{input.conditions.trickRoom=true;}],
    ['current form',({input})=>{input.currentForme='Changed fixture forme';input.observations[0].currentForme=input.currentForme;input.observations[0].input.pokemon[0].species=input.currentForme;}],
    ['runtime',({call})=>{call.runtimeVersion='changed-fake-runtime';}],
    ['poisoned unbranded entries',({cache})=>{for(const [key,value]of cache){const poisoned=structuredClone(value);poisoned.result.pokemon[0].actionSpeed=99999;poisoned.resultSha256=digest(poisoned.result);cache.set(key,poisoned);}}],
  ];
  for(const[label,mutate]of mutations){
    const input=fixture(),points=spe=>({hp:0,atk:0,def:0,spa:0,spd:0,spe});
    input.candidateSpreads=[{nature:'Serious',statPoints:points(0)},{nature:'Serious',statPoints:points(32)}];input.observations=[speed(input)];
    const cache=new Map(),calls=[],call=fakeDispatcher(calls),prior=await generate(input,options({call,cache,numericPolicy:'allow-new-calls'}));
    assert.equal(prior.rejected.length,1);assert.equal(calls.length,2);mutate({input,call,cache});
    const before=structuredClone(input),report=await generate(input,options({call,cache,numericPolicy:'cache-only'}));
    assert.deepEqual(input,before,label);assert.equal(calls.length,2,label+' must start no new backend work');
    assert.equal(report.coverage.usableObservations,1,label+' still tests a supported observation');assert.equal(report.ignoredConstraints.length,0,label);
    assert.equal(report.coverage.cachedCalls,0,label);assert.equal(report.coverage.attemptedCalls,0,label);assert.equal(report.coverage.completedCalls,0,label);
    assert.equal(report.candidates.length,2,label+' retains both untested allocations');assert.equal(report.rejected.length,0,label);
    assert.equal(report.coverage.deferredCalls,report.records.length,label);assert(report.records.every(record=>record.status==='unavailable'&&record.reason==='model-first-new-inference-deferred'),label);
    assert(report.candidates.every(candidate=>candidate.checks.every(check=>check.status==='unavailable'&&!Object.hasOwn(check,'compatible'))),label);
  }
});

test('original deadline, abort and call/concurrency bounds never turn unavailable checks into exclusions',async()=>{
  const input=fixture();input.observations=[speed(input)];input.maxCalls=2;const log=[],report=await generate(input,options({call:fakeDispatcher(log),concurrency:2}));
  assert.equal(log.length,2);assert.equal(report.coverage.attemptedCalls,2);assert(report.candidates.some(c=>c.checks.some(check=>check.status==='unavailable')));assert(report.coverage.maxConcurrentCalls<=2);
  const expired=await generate(input,{call:fakeDispatcher(log),deadlineAt:Date.now()-1});assert.equal(expired.coverage.attemptedCalls,0);assert.equal(expired.rejected.length,0);
  const controller=new AbortController();controller.abort();const aborted=await generate(input,options({call:fakeDispatcher(log),signal:controller.signal}));assert.equal(aborted.coverage.attemptedCalls,0);assert.equal(aborted.rejected.length,0);
});

test('in-flight callbacks receive cancellation at original deadline; late results are never cached or used',async()=>{
  const input=fixture();input.observations=[speed(input)];let aborted=0;
  const call=(_tool,_args,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled fake'));},{once:true}));call.runtimeVersion='fixture-timeout';
  const cache=new Map(),report=await generate(input,{call,cache,deadlineAt:Date.now()+30,concurrency:2});
  assert.equal(aborted,2);assert.equal(cache.size,0);assert.equal(report.rejected.length,0);assert.equal(report.coverage.deadlineExhausted,true);
});

test('a numerical result settling exactly at the original deadline cannot exclude or enter cache',async()=>{
  const input=fixture();input.observations=[speed(input)];let clock=1000;
  const ordinary=fakeDispatcher(),call=async(...args)=>{const reply=await ordinary(...args);clock=1001;return reply;};call.runtimeVersion='fixture-boundary';
  const cache=new Map(),report=await generate(input,{call,cache,now:()=>clock,deadlineAt:1001,concurrency:1});
  assert.equal(report.coverage.completedCalls,0);assert.equal(report.rejected.length,0);assert.equal(cache.size,0);assert.equal(report.coverage.deadlineExhausted,true);
});

test('MCP refusals, wrong gen, unsupported order and receipt scope mismatches never provide exclusion evidence',async()=>{
  for(const call of [async()=>({isError:true,content:[{type:'text',text:'fixture refusal'}]}),async()=>({structuredContent:{gen:9}}),async()=>({structuredContent:{gen:0,calculationRef:{tool:'calculate_damage',teamId:HASH,sha256:HASH}}})]){
    const input=fixture();input.observations=[speed(input)];const report=await generate(input,options({call}));assert.equal(report.rejected.length,0);assert(report.candidates.every(c=>c.checks[0].status==='unavailable'));
  }
});

test('strict bounded JSON and native callback allowlist reject executable inputs without invoking them',async()=>{
  let calls=0;const input=fixture();Object.defineProperty(input,'conditions',{enumerable:true,get(){calls++;throw new Error('must not execute');}});
  await assert.rejects(generate(input,options()),/ordinary data/);const proxy=new Proxy({}, {ownKeys(){calls++;throw new Error('must not execute');}});await assert.rejects(generate(proxy,options()),/ordinary finite JSON/);
  assert.equal(calls,0);const unrelated=fixture();unrelated.relevantMoves=[{name:'Unpublished move',category:'Physical'}];await assert.rejects(generate(unrelated,options()),/published set/);
  await assert.rejects(generate(fixture(),{}),/absolute deadline/);await assert.rejects(generate(fixture(),options({concurrency:7})),/1..6/);
  await assert.rejects(generate(fixture(),options({now:()=>NaN})),/finite clock/);
});
