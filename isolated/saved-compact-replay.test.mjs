import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {digest} from '../planning/identity.mjs';
import {bindModelToolArguments} from '../showdown/model-owned-tools.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {inventoryCompactSimulationRefusals,loadSavedCompactRefusals,replaySavedCompactRefusals,savedCompactSourceBinding} from './saved-compact-replay.mjs';

const workspace=fileURLToPath(new URL('../',import.meta.url)),teamId='a'.repeat(64),parentId='game-bestof3-gen9championsvgc2026regmcbo3-100';
const room='battle-gen9championsvgc2026regmcbo3-101',sha=x=>createHash('sha256').update(x).digest('hex');
const actions={ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}]};
function fixture(state={sessionId:'synthetic-offline-session',teamSha256:teamId,actions:[{room,parentId,rqid:4,token:'b'.repeat(64),legalActions:{active:[{},{}]}}],boards:[{room,turn:1,ownSide:'p1',sides:[],field:{},request:{rqid:4}}]}){
  const binding=savedCompactSourceBinding(state),args=bindModelToolArguments('simulate_choices',structuredClone(actions),{source:binding.source,turn:binding.turn});
  const trace={teamId:state.teamSha256,parentId:binding.parentId,entries:[{binding:{teamId:state.teamSha256,parentId:binding.parentId,room:binding.source.room,rqid:binding.source.rqid},context:{input:JSON.stringify({board:{turn:binding.turn}})},decision:{modelToolCalls:[{name:'simulate_choices',status:'refused',arguments:structuredClone(actions),result:{result:{kind:'model-tool-result',receipt:{sourceSha256:binding.sourceSha256,argumentsSha256:digest(args),nativeMcp:true,modelRequested:true},result:{kind:'simulation-choices-unavailable',isError:true,reason:'Synthetic unsupported state',stage:'reconstruction'}}}}]}}]};
  return {state,trace,inventory:inventoryCompactSimulationRefusals(trace,{teamId:state.teamSha256,parentId:binding.parentId,traceSha256:sha(JSON.stringify(trace))})};
}

test('inventory retains exact authored calls and structured refusal without reading prose as state',()=>{
  const f=fixture(),row=f.inventory.cases[0];assert.equal(row.recordedReason,'Synthetic unsupported state');assert.deepEqual(row.authoredArguments,actions);assert.equal(Object.isFrozen(row.authoredArguments),true);
  assert.throws(()=>inventoryCompactSimulationRefusals(f.trace,{teamId:'c'.repeat(64),parentId,traceSha256:'d'.repeat(64)}),/owner/u);
  const bad=structuredClone(f.trace);delete bad.entries[0].decision.modelToolCalls[0].result.result.receipt.sourceSha256;
  assert.throws(()=>inventoryCompactSimulationRefusals(bad,{teamId,parentId,traceSha256:'d'.repeat(64)}),/receipt/u);
});

test('missing exact current source is unavailable and performs no callback',async()=>{
  const f=fixture();let calls=0;const result=await replaySavedCompactRefusals({inventory:f.inventory,callNative:async()=>{calls++;}});
  assert.equal(result.cases[0].status,'source-unavailable');assert.equal(calls,0);assert.equal(result.qualification,false);assert.equal(result.coverage.actualNativeDispatches,0);
});

test('source hash, owner and bound arguments join before an adapter can execute',async()=>{
  const f=fixture();let called=0;const adapterFactory=async()=>{called++;throw Error('Should not run');};
  const changed=structuredClone(f.state);changed.boards[0].turn=2;
  const result=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:changed}],adapterFactory});
  assert.equal(result.cases[0].status,'source-unavailable');assert.equal(called,0);
  await assert.rejects(replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state},{state:f.state}],adapterFactory}),/Duplicate/u);
  const bad=structuredClone(f.inventory);bad.cases[0].boundArgumentsSha256='e'.repeat(64);
  const refused=await replaySavedCompactRefusals({inventory:bad,sourceRecords:[{state:f.state}],adapterFactory});assert.equal(refused.cases[0].status,'refused');assert.match(refused.cases[0].reason,/arguments differ/u);assert.equal(called,0);
});

test('injected replay callbacks preserve original facts, record real callback hashes and mint no qualification',async()=>{
  const f=fixture(),before=structuredClone(f.state);let received;
  const adapterFactory=async()=>({status:()=>({sourceProof:{synthetic:true}}),execute:async({args,callNative})=>{received=args;await callNative({name:'simulate_turn',arguments:{gen:0,request:{kind:'explicit'}}});return {kind:'native-choice-simulation-v1',worlds:[]};},receipt:()=>null});
  const result=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state}],adapterFactory,callNative:async()=>({content:[{type:'text',text:'synthetic-test-only'}]})});
  assert.equal(result.cases[0].status,'returned');assert.equal(result.nativeSdkVerified,false);assert.equal(result.qualification,false);assert.equal(result.cases[0].adapterReceipt,null);
  assert.equal(result.cases[0].nativeCalls.length,1);assert.match(result.cases[0].nativeCalls[0].resultSha256,/^[a-f0-9]{64}$/u);assert.deepEqual(received.ourActions,actions.ourActions);assert.deepEqual(f.state,before);
});

test('arbitrary native tools, expired deadlines and noncooperative late callbacks cannot produce adopted results',async()=>{
  const f=fixture();let calls=0;
  const adapterFactory=async()=>({status:()=>({}),execute:async({callNative})=>callNative({name:'battle_start',arguments:{}})});
  const refused=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state}],adapterFactory,callNative:async()=>{calls++;}});
  assert.equal(refused.cases[0].status,'refused');assert.equal(calls,0);
  const expired=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state}],deadlineAt:Date.now()-1,adapterFactory});assert.equal(expired.cases[0].status,'deadline-unavailable');
  const hung=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state}],caseBudgetMs:10,adapterFactory:async()=>new Promise(()=>{}),callNative:async()=>{calls++;}});
  assert.equal(hung.cases[0].status,'deadline-unavailable');assert.equal(calls,0);
  let clock=1;const equality=await replaySavedCompactRefusals({inventory:f.inventory,sourceRecords:[{state:f.state}],now:()=>clock,caseBudgetMs:10,adapterFactory:async()=>({status:()=>({}),execute:async({callNative})=>{await callNative({name:'simulate_turn',arguments:{request:{kind:'explicit'}}});return{kind:'native-choice-simulation-v1'};}}),callNative:async()=>{clock=11;return{content:[]};}});
  assert.equal(equality.cases[0].status,'deadline-unavailable');assert.equal(equality.cases[0].nativeCalls[0].resultSha256,undefined);
});

const liveTrace=process.env.VGC_TEST_MODEL_TRACE??'';
test('retained live trace has18 exact historical refusals, all unavailable without raw source',{skip:liveTrace&&existsSync(liveTrace)?false:'Private live trace not present'},async()=>{
  const bytes=await readFile(liveTrace),trace=JSON.parse(bytes),inventory=await loadSavedCompactRefusals({workspace,traceFile:liveTrace,traceSha256:sha(bytes),teamId:trace.teamId,parentId:trace.parentId});
  assert.equal(inventory.cases.length,18);const result=await replaySavedCompactRefusals({inventory});assert.equal(result.coverage.sourceUnavailable,18);assert.equal(result.coverage.currentReturns,0);assert.equal(result.coverage.actualNativeDispatches,0);
  await assert.rejects(loadSavedCompactRefusals({workspace,traceFile:liveTrace,traceSha256:'f'.repeat(64),teamId:trace.teamId,parentId:trace.parentId}),/bytes changed/u);
});

const savedFile=(process.env.VGC_TEST_SAVED_REQUESTS??'');
test('actual offline SDK plus existing verified saved-T1 qualifier can replay a disclosed comparison case',{skip:existsSync(savedFile)?false:'Private complete saved request not present'},async()=>{
  const source=JSON.parse(await readFile(savedFile,'utf8')).requests.find(r=>r.caseId==='actual-g2-t1-material'),f=fixture(source.state),binding=savedCompactSourceBinding(source.state);
  const selected={ourActions:[{type:'move',slot:1,target:2},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3},{type:'move',slot:1}]};
  const call=f.trace.entries[0].decision.modelToolCalls[0];call.arguments=selected;call.result.result.receipt.argumentsSha256=digest(bindModelToolArguments('simulate_choices',structuredClone(selected),{source:binding.source,turn:binding.turn}));
  const inventory=inventoryCompactSimulationRefusals(f.trace,{teamId:source.state.teamSha256,parentId:binding.parentId,traceSha256:sha(JSON.stringify(f.trace))}),connection=await connectOfflineNumericClient();
  try{const result=await replaySavedCompactRefusals({workspace,inventory,sourceRecords:[{state:source.state,ownTeamText:source.ownTeamText,opponentSheet:source.opponentSheet,provenance:source.provenance}],caseBudgetMs:10000,callNative:(...args)=>connection.client.callTool(...args)});
    assert.equal(result.cases[0].status,'returned',result.cases[0].reason);assert.equal(result.cases[0].nativeCalls.filter(c=>c.name==='simulate_turn').length,3);assert.equal(result.cases[0].adapterReceipt.sourceProvenanceVerified,true);
    assert.equal(result.nativeSdkVerified,false);assert.equal(result.qualification,false);assert.equal(result.modelCalls,0);
  }finally{await connection.close();}
});
