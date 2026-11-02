import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createCompactModelToolQualificationAdapter,hasCompactModelToolQualificationReceipt,hasCompactModelToolQualificationBudgetStatus} from './compact-model-tool-qualification.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {digest} from '../planning/identity.mjs';
import {executeSimulation} from '../simulation/mcp-tools.mjs';
import {simulateNativeTurn} from '../simulation/turn-simulator.mjs';

const workspace=fileURLToPath(new URL('../',import.meta.url)),savedFile=(process.env.VGC_TEST_SAVED_REQUESTS??'');
const savedAvailable=existsSync(savedFile),copy=structuredClone;
const saved=async()=>JSON.parse(await readFile(savedFile,'utf8'));
async function fixture(){const document=await saved(),row=document.requests.find(r=>r.caseId==='actual-g2-t1-material');return {row,options:{workspace,state:row.state,ownTeamText:row.ownTeamText,opponentSheet:row.opponentSheet,provenance:row.provenance}};}
function argumentsFor(adapter,frozen=false){const marker=adapter.frozenMarker();return {source:marker.source,analysis:frozen?'frozen':'current',...(frozen?{freezeId:marker.freezeId}:{}),ourActions:[{type:'move',slot:1,target:2},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3},{type:'move',slot:1}],evidenceContext:{teamId:marker.source.teamId,roomId:canonicalEvidenceRoom(marker.source.room),turn:1}};}
const options={skip:savedAvailable?false:'Private complete native request and hash-bound metrics prefix unavailable'};

test('genuine archived T1 joins verified 28-event prefix to exact private projection with no generated state',options,async()=>{
  const f=await fixture(),before=copy(f.row.state),adapter=await createCompactModelToolQualificationAdapter(f.options),status=adapter.status(),proof=status.sourceProof;
  assert.equal(status.ready,true);assert.equal(status.executed,0);assert.equal(status.nativeSdkVerified,false);assert.equal(status.liveFreshness,false);
  assert.equal(proof.prefix.events,28);assert.equal(proof.prefix.privateSanitizedRequestsSkipped,1);assert.equal(proof.strictNativeCapture,true);
  assert.equal(proof.privateProjection.originalRawPacketClaimed,false);assert.equal(proof.privateProjection.legalSha256,digest(f.row.state.actions[0].legalActions));assert.equal(status.frozenSourceSha256,digest(f.row.state));
  assert.deepEqual(f.row.state,before);assert.equal(f.row.state.boards[0].opponentSheets,undefined);assert.equal(adapter.frozenMarker().choiceAuthority,false);
  const second=await createCompactModelToolQualificationAdapter(f.options);assert.notEqual(adapter.frozenMarker().freezeId,second.frozenMarker().freezeId);
});

test('wrong exact source, missing archived proof, later history and changed private fields refuse before native callbacks',options,async()=>{
  const f=await fixture();for(const change of [o=>o.state.boards[0].sides[0].pokemon[0].hp.current--,o=>o.provenance.archiveSha256='a'.repeat(64),o=>delete o.provenance,o=>o.state.actions[0].legalActions.active[0].moves[0].pp--]){const altered=copy(f.options);change(altered);await assert.rejects(createCompactModelToolQualificationAdapter(altered));}
  const late=(await saved()).requests.find(r=>r.caseId==='actual-earlier-g1-t8-fresh-thread');await assert.rejects(createCompactModelToolQualificationAdapter({workspace,...late}),/only for saved turn 1/u);
  const adapter=await createCompactModelToolQualificationAdapter(f.options),args=argumentsFor(adapter,true);args.freezeId='c49f27f8-0052-4f07-92cd-af04ab5884e9';let called=0;
  await assert.rejects(adapter.execute({name:'simulate_choices',args,deadlineAt:Date.now()+5000,callNative:async()=>{called++;}}),/marker differs/u);assert.equal(called,0);
});

test('cancelled or expired compact qualification cannot call a native tool or mint a receipt',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),controller=new AbortController();controller.abort();let called=0;
  for(const extra of [{signal:controller.signal,deadlineAt:Date.now()+5000},{deadlineAt:Date.now()-1}])await assert.rejects(adapter.execute({name:'simulate_choices',args:argumentsFor(adapter),...extra,callNative:async()=>{called++;}}));
  assert.equal(called,0);assert.equal(hasCompactModelToolQualificationReceipt(adapter,{}),false);assert.equal(adapter.receipt({}),null);
});

test('actual owned SDK resolves one compact trajectory from genuine saved T1; source remains historical',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),connection=await connectOfflineNumericClient(),calls=[];
  try{
    const args=argumentsFor(adapter,true),before=copy(args),result=await adapter.execute({name:'simulate_choices',args,deadlineAt:Date.now()+10000,callNative:async(request,schema,options)=>{const startedAt=Date.now(),reply=await connection.client.callTool(request,schema,options);calls.push({name:request.name,inputSha256:digest(request.arguments),resultSha256:digest(reply),startedAt,settledAt:Date.now()});return reply;}});
    assert.equal(result.kind,'native-choice-outcome-v1');assert.equal(result.coverage.worlds,1);assert.equal(result.coverage.samples,1);assert.equal(typeof result.outcome.turnComplete,'boolean');assert.equal(result.source.analysis,'frozen');assert.equal(result.source.liveFreshness,false);assert.equal(result.source.choiceAuthority,false);assert.equal(result.offlineQualification.historicalFacts,true);
    assert.deepEqual(args,before);assert.equal(calls.length,1);assert(calls.every(c=>c.name==='simulate_turn'));
    assert.equal(hasCompactModelToolQualificationReceipt(adapter,result),true);assert.equal(hasCompactModelToolQualificationReceipt(adapter,copy(result)),false);assert.equal(hasCompactModelToolQualificationReceipt({},result),false);
    const receipt=adapter.receipt(result);assert.equal(receipt.authoredInputSha256,digest(args));assert.equal(receipt.resultSha256,digest(result));assert.equal(receipt.nativeSdkVerified,false);assert.equal(receipt.sourceProvenanceVerified,true);assert.equal(receipt.pairedSimulation,true);
    for(const call of receipt.nativeCalls)assert(calls.some(record=>record.name===call.name&&record.inputSha256===call.inputSha256&&record.resultSha256===call.resultSha256));
    result.source.liveFreshness=true;assert.equal(hasCompactModelToolQualificationReceipt(adapter,result),false);
  }finally{await connection.close();}
});

test('one unavailable native trajectory cannot mint compact qualification',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),connection=await connectOfflineNumericClient();let calls=0;
  try{
    await assert.rejects(adapter.execute({name:'simulate_choices',args:argumentsFor(adapter,true),deadlineAt:Date.now()+10000,
      callNative:async(request,schema,callOptions)=>{if(++calls===1)return {isError:true,content:[{type:'text',text:'Simulated unavailable world'}]};return connection.client.callTool(request,schema,callOptions);}}),/complete single compact native outcome unavailable/u);
    assert.equal(calls,1);assert.equal(adapter.status().journal[0].status,'failed');
  }finally{await connection.close();}
});

test('exact native target diagnostics reach compact qualification failure without granting partial coverage a receipt',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),args=argumentsFor(adapter),before=copy(args);args.opposingActions[0].target=1;let calls=0;
  const callNative=async request=>{calls++;assert.equal(request.name,'simulate_turn');try{const result=await executeSimulation((({researchContext,...native})=>native)(request.arguments),{workspace,run:simulateNativeTurn});return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};}
    catch(error){return {isError:true,content:[{type:'text',text:error.message+' token='+args.source.token+' password=DO_NOT_RETAIN https://private.example/value C:\\private\\file '+'x'.repeat(2000)}]};}};
  let refusal;await assert.rejects(adapter.execute({name:'simulate_choices',args,deadlineAt:Date.now()+10000,callNative}),error=>{refusal=error;assert.equal(error.code,'COMPACT_MODEL_TOOL_QUALIFICATION');assert.match(error.message,/complete single compact native outcome unavailable/u);assert.match(error.message,/Move does not accept a chosen target/u);assert.match(error.message,/p2a Malamar move\[3\]=Trick Room menuTarget=all providedTarget=1/u);assert(error.message.length<900);for(const secret of [args.source.sessionId,args.source.token,'DO_NOT_RETAIN','private.example','C:\\private'])assert(!error.message.includes(secret));return true;});
  assert.equal(calls,1);assert.equal(hasCompactModelToolQualificationReceipt(adapter,refusal),false);assert.equal(adapter.receipt(refusal),null);assert.equal(adapter.status().journal[0].status,'failed');assert.deepEqual(args,{...before,opposingActions:[{...before.opposingActions[0],target:1},before.opposingActions[1]]},'the refused target is not rewritten');
  const changed=argumentsFor(adapter);changed.source.rqid++;const count=calls;await assert.rejects(adapter.execute({name:'simulate_choices',args:changed,deadlineAt:Date.now()+10000,callNative}),/source differs/u);assert.equal(calls,count);assert.equal(hasCompactModelToolQualificationReceipt(adapter,{}),false);
  const spent=await adapter.execute({name:'simulate_choices',args:argumentsFor(adapter),deadlineAt:Date.now()+10000,callNative});assert.equal(spent.kind,'research-budget-status');assert.equal(spent.status,'budget-used');assert.equal(hasCompactModelToolQualificationBudgetStatus(adapter,spent),true);assert.equal(hasCompactModelToolQualificationReceipt(adapter,spent),false);assert.equal(calls,1,'a correction after actual native dispatch cannot obtain another trajectory');
  const fresh=await createCompactModelToolQualificationAdapter(f.options),valid=await fresh.execute({name:'simulate_choices',args:argumentsFor(fresh),deadlineAt:Date.now()+10000,callNative});assert.equal(valid.coverage.completeBranchCoverage,true);assert.equal(hasCompactModelToolQualificationReceipt(fresh,valid),true);assert.equal(fresh.receipt(valid).nativeSdkVerified,false,'injected engine callbacks grant no SDK or full provider qualification');
});

async function actualNative(request){
  assert.equal(request.name,'simulate_turn');const {researchContext,...input}=request.arguments;
  const result=await executeSimulation(input,{workspace,run:simulateNativeTurn});return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
}

test('same completed exact query reuses a detached native outcome; changed pair spends no second backend',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),args=argumentsFor(adapter),deadlineAt=Date.now()+10000;let calls=0;
  const callNative=async request=>{calls++;return actualNative(request);};
  const first=await adapter.execute({name:'simulate_choices',args,deadlineAt,callNative}),before=copy(first);
  first.outcome.final.turn=999;
  const reused=await adapter.execute({name:'simulate_choices',args:copy(args),deadlineAt,callNative});assert.deepEqual(reused,before);assert.equal(calls,1);assert.equal(hasCompactModelToolQualificationReceipt(adapter,reused),true);assert.equal(adapter.receipt(reused).nativeCalls.length,1);
  const changed=copy(args);changed.ourActions[0]={type:'move',slot:4};
  const refused=await adapter.execute({name:'simulate_choices',args:changed,deadlineAt,callNative});assert.equal(refused.status,'budget-used');assert.equal(refused.backendAllowed,false);assert.equal(refused.liveFreshness,false);assert.equal(refused.choiceAuthority,false);assert.equal(refused.qualificationScope,'offline-saved-source-policy-emulation');assert.equal(calls,1);assert.equal(hasCompactModelToolQualificationReceipt(adapter,refused),false);assert.equal(adapter.receipt(refused),null);assert.equal(hasCompactModelToolQualificationBudgetStatus(adapter,copy(refused)),false,'ordinary JSON cannot forge the negative bridge marker');
});

test('pending identical and changed questions return explicit status without awaiting or dispatching twice',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),args=argumentsFor(adapter),deadlineAt=Date.now()+10000;let calls=0,release,started;
  const begun=new Promise(resolve=>{started=resolve;});
  const pending=adapter.execute({name:'simulate_choices',args,deadlineAt,callNative:async request=>{calls++;started();await new Promise(resolve=>{release=resolve;});return actualNative(request);}});
  await begun;
  for(const next of [args,{...args,ourActions:[{type:'move',slot:4},{type:'move',slot:4}]}]){
    const refused=await adapter.execute({name:'simulate_choices',args:next,deadlineAt,callNative:()=>assert.fail('second backend')});assert.equal(refused.status,'pending');assert.equal(hasCompactModelToolQualificationBudgetStatus(adapter,refused),true);assert.equal(hasCompactModelToolQualificationReceipt(adapter,refused),false);
  }
  assert.equal(calls,1);release();const complete=await pending;assert.equal(hasCompactModelToolQualificationReceipt(adapter,complete),true);assert.equal(adapter.status().simulationBudget.used,1);
});

test('source/schema/local menu and predispatch cancellation stay correctable; cancellation after dispatch is spent',options,async()=>{
  const f=await fixture(),adapter=await createCompactModelToolQualificationAdapter(f.options),args=argumentsFor(adapter),deadlineAt=Date.now()+10000;let calls=0;
  const callNative=async request=>{calls++;return actualNative(request);};
  const aborted=new AbortController();aborted.abort();await assert.rejects(adapter.execute({name:'simulate_choices',args,deadlineAt,signal:aborted.signal,callNative}));
  const malformed=copy(args);malformed.ourActions[0].slot=9;await assert.rejects(adapter.execute({name:'simulate_choices',args:malformed,deadlineAt,callNative}));
  const illegal=copy(args);illegal.ourActions=[{type:'pass'},{type:'pass'}];await assert.rejects(adapter.execute({name:'simulate_choices',args:illegal,deadlineAt,callNative}),/complete single compact native outcome unavailable/u);
  assert.equal(calls,0);assert.equal(adapter.status().simulationBudget.used,0);
  const corrected=await adapter.execute({name:'simulate_choices',args,deadlineAt,callNative});assert.equal(corrected.kind,'native-choice-outcome-v1');assert.equal(calls,1);
  const second=await createCompactModelToolQualificationAdapter(f.options),controller=new AbortController();let failedCalls=0;
  await assert.rejects(second.execute({name:'simulate_choices',args:argumentsFor(second),deadlineAt,signal:controller.signal,callNative:async()=>{failedCalls++;controller.abort();throw Object.assign(Error('native work aborted'),{code:'aborted'});}}));
  const spent=await second.execute({name:'simulate_choices',args:argumentsFor(second),deadlineAt,callNative:()=>assert.fail('failed dispatch is not refunded')});assert.equal(spent.status,'budget-used');assert.equal(failedCalls,1);assert.equal(hasCompactModelToolQualificationReceipt(second,spent),false);
});
