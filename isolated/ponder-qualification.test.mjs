// Dependency fakes only. No CLI/login/model/native SDK process or battle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {digest} from '../planning/identity.mjs';
import {buildModelToolContext} from './model-tool-cycle.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {qualifyPonderRuntime,hasPonderQualificationReceipt,verifyPonderQualificationReceipt,ponderQualificationSourcePins,createPonderQualificationWaitFixture,describePonderCaseQualification} from './ponder-qualification.mjs';
import {createCompactModelToolQualificationAdapter,hasCompactModelToolQualificationReceipt} from './compact-model-tool-qualification.mjs';
import {simulationChoicesToolSchema} from '../simulation/choice-schemas.mjs';
import {executeSimulation} from '../simulation/mcp-tools.mjs';
import {simulateNativeTurn} from '../simulation/turn-simulator.mjs';
import {z} from 'zod';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const names=['Rillaboom','Incineroar','Farigiraf','Politoed','Hydreigon','Sylveon'],abilities=['Grassy Surge','Intimidate','Armor Tail','Drizzle','Levitate','Pixilate'];
const teamText=names.map((name,index)=>`${name}\nAbility: ${abilities[index]}\nLevel: 50\nAdamant Nature\n- Protect\n- Tackle`).join('\n\n');
const teamId=createHash('sha256').update(Teams.pack(Teams.import(teamText))).digest('hex'),sessionId='ponder-qualification-fixture',room='battle-gen9championsvgc2026regmcbo3-9800011',parentId='game-bestof3-gen9championsvgc2026regmcbo3-9800010';
function saved(){
  const sheet=names.map((species,index)=>({species,ability:abilities[index],moves:['Protect','Tackle'],item:'',nature:'Adamant'}));
  const legalActions={teamPreview:false,pokemon:names.slice(0,4).map((name,index)=>({ident:`p1: ${name}`,details:`${name}, L50`,condition:'100/100',active:index<2})),active:[1,2].map(()=>({moves:[{move:'Protect',target:'self',pp:10},{move:'Tackle',target:'normal',pp:20}]}))};
  const action={kind:'turn',room,parentId,rqid:2,revision:2,token:'b'.repeat(64),receivedAt:1000,actionable:true,legalActions};
  const side=id=>({id,active:[{slot:1,pokemon:`${id}-0`},{slot:2,pokemon:`${id}-1`}],reserves:[`${id}-2`,`${id}-3`],conditions:{},pokemon:names.slice(0,4).map((species,index)=>({id:`${id}-${index}`,species,requestIndex:id==='p1'?index+1:null,activeSlot:index<2?index+1:null,hp:{current:100,max:100,precision:id==='p1'?'server-own-exact':'server-display'},fainted:false,boosts:{},status:null,ability:abilities[index],item:'',itemKnown:true,moves:['Protect','Tackle'],volatiles:{},selection:'selected'}))});
  const state={sessionId,teamSha256:teamId,username:'PonderFixture',connected:true,authenticated:true,stopped:false,actions:[action],rooms:[{id:room,parentId,ended:false}],boards:[{room,parentId,turn:1,ownSide:'p1',request:{rqid:2},field:{weather:null,terrain:null,conditions:{}},sides:[side('p1'),side('p2')],opponentSheets:{p2:sheet},recentEvents:{lines:[]}}]};
  const context=buildModelToolContext({state,ownTeamText:teamText,opponentSheet:sheet,...ISOLATED_POLICY_SOURCE}),decision={actions:[{type:'move',slot:1},{type:'move',slot:1}],planUpdate:{objective:'Fixture only.'},reason:'Fixture only.'};
  return{context,state,action,identity:{sessionId,teamId,account:'PonderFixture'},ownTeamText:teamText,opponentSheet:sheet,provenance:{kind:'synthetic-test-only'},materialRequired:true,decision};
}
const output=()=>({summary:'Synthetic control exercise only.',proposals:[{label:'Question',idea:'Revalidate current facts.',assumptions:[],questions:[],factPaths:[]}],limitations:['No numerical or battle evidence is established by injected fixtures.']});
function fixture({unavailable=false,badMarker=false,hangUntilAbort=false,rangeOnly=false,bothEndpoints=false,rangeCatalog=true,requestOverride,returnedDecision}={}){
  const request=requestOverride??saved(),models=[],preflights=[],closes=[],nativeCalls=[],proofs=new WeakMap();
  const provider={decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision(){assert.fail('No main model call');}}};
  const nativeClient={listTools:async()=>({tools:[{name:'simulate_choices',description:'Synthetic compact callback; not native evidence.',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{ourActions:{type:'array'},opposingActions:{type:'array'},source:{type:'object'},analysis:{type:'string'},freezeId:{type:'string'},evidenceContext:{type:'object'}},required:['ourActions','opposingActions','source'],additionalProperties:false}},...(rangeCatalog?[{name:'calculate_damage_range',description:'Synthetic gen0 scalar range; not paired evidence.',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{gen:{const:0},move:{type:'string'},evidenceContext:{type:'object'}},additionalProperties:false}}]:[])]}),callTool:async(input,_schema,options)=>{
    nativeCalls.push({input:structuredClone(input),options});
    if(hangUntilAbort&&nativeCalls.length===2)return new Promise((_,reject)=>{const abort=()=>reject(Object.assign(Error('fixture abort'),{code:'aborted'}));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});});
    if(input.name==='calculate_damage_range')return{structuredContent:{kind:'champions-damage-range-v1',gen:0,status:'partial-candidate-envelope',damageRange:{min:10,max:20,scope:'evaluated-legal-witnesses-only'},coverage:{completed:1,exhaustive:false}}};
    return{structuredContent:{engine:{gen:0},samples:[{fixture:true}]}};
  }};
  const providerFactory=()=>({contextMode:'session',preflight:async()=>{preflights.push(true);return{authMode:'chatgpt',model:'gpt-6.1-sol',reasoningEffort:'low',requestedServiceTier:'fast'};},close:async()=>{closes.push(true);},decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:async call=>{
    models.push(call);if(rangeOnly)assert(call.modelTools.definitions.some(t=>t.name==='calculate_damage_range'));const response=await call.modelTools.call(rangeOnly?{name:'calculate_damage_range',callId:'range-'+models.length,arguments:{move:'Tackle'}}:{name:'simulate_choices',callId:'fixture-'+models.length,arguments:{ourActions:request.decision.actions,opposingActions:request.decision.actions}});
    if(bothEndpoints&&models.length===1)await call.modelTools.call({name:'calculate_damage_range',callId:'normal-self-authored-range',arguments:{gen:0,move:'Tackle'}});
    if(call.signal.aborted)throw Object.assign(Error('fixture provider aborted'),{code:'aborted'});
    assert(response);return{decision:returnedDecision??output(),telemetry:{telemetrySource:'injected-fixture'}};
  }}});
  const adapterFactory=async()=>{
    const binding=request.context.binding,marker={freezeId:randomUUID(),source:{sessionId:binding.sessionId,teamId:binding.teamId,room:binding.room,rqid:binding.rqid,token:badMarker?'wrong':binding.token},frozenAt:Date.now(),choiceAuthority:false};
    const adapter={frozenMarker:()=>structuredClone(marker),receipt:result=>proofs.get(result),execute:async({args,signal,deadlineAt,callNative})=>{
      if(unavailable)throw Object.assign(Error('Synthetic source unavailable'),{code:'SOURCE_UNAVAILABLE'});
      const startedAt=Date.now(),input={request:{kind:'explicit',fixtureOnly:true}},native=await callNative({name:'simulate_turn',arguments:input},undefined,{signal,timeout:Math.max(1,deadlineAt-Date.now())});
      if(signal.aborted)throw Object.assign(Error('Synthetic result canceled'),{code:'aborted'});
      const result={kind:'native-choice-simulation-v1',source:{liveFreshness:false,choiceAuthority:false},samples:[{fixtureOnly:true}]};
      proofs.set(result,{pairedSimulation:true,sourceProvenanceVerified:true,readinessVerified:true,frozenSourceSha256:digest(request.state),authoredInputSha256:digest(args),resultSha256:digest(result),nativeCalls:[{name:'simulate_turn',inputSha256:digest(input),resultSha256:digest(native),startedAt,settledAt:Date.now()}]});return result;
    }};return adapter;
  };
  const args={provider,mainQualification:{rows:[{requestDigest:request.context.binding.requestDigest,authoredDecision:request.decision,localChoice:{actions:request.decision.actions}}]},request,nativeClient,providerFactory,adapterFactory,adapterReceiptVerifier:(_adapter,result)=>proofs.has(result)};
  return{args,models,preflights,closes,nativeCalls,request,provider};
}

test('missing request or unbranded main proof cannot start a real shadow, SDK or authentication preflight',async()=>{
  const f=fixture();const missing=await qualifyPonderRuntime({provider:f.provider});assert.equal(missing.qualified,false);assert.equal(missing.reason,'saved-material-request-required');
  const rejected=await qualifyPonderRuntime({provider:f.provider,request:f.request,mainQualification:{qualified:true}});assert.equal(rejected.reason,'current-branded-main-qualification-required');assert.equal(hasPonderQualificationReceipt(f.provider,rejected),false);assert.equal(await verifyPonderQualificationReceipt(f.provider,{...rejected,qualified:true}),false);
});

test('per-case diagnostic qualification requires every existing strict eligibility predicate and grants no live admission',()=>{
  const checks={actualDependencies:true,mainQualificationVerified:true,sourcePinsUnchanged:true,cleanupVerified:true,workflowQualified:true};
  const passing=describePonderCaseQualification(checks);
  assert.equal(passing.qualified,true);assert.equal(passing.qualificationScope,'offline-shadow-case-diagnostic-only');assert.equal(passing.grantsLiveAdmission,false);assert.deepEqual(passing.qualificationChecks,checks);
  assert.equal(hasPonderQualificationReceipt(fixture().provider,passing),false,'pure diagnostic output cannot create the combined opaque receipt');
  for(const key of Object.keys(checks)){
    const failed=describePonderCaseQualification({...checks,[key]:false});assert.equal(failed.qualified,false,key);assert.equal(failed.qualificationChecks[key],false,key);
    assert.equal(describePonderCaseQualification({...checks,[key]:'true'}).qualified,false,`${key} must be a computed boolean`);
  }
  assert.equal(describePonderCaseQualification().qualified,false);
});

test('range-only frozen numerical research reaches gen0 callback but cannot satisfy paired or genuine qualification',async()=>{
  const f=fixture({rangeOnly:true}),result=await qualifyPonderRuntime(f.args);
  assert.equal(f.nativeCalls.length,2);for(const call of f.nativeCalls){assert.equal(call.input.name,'calculate_damage_range');assert.equal(call.input.arguments.gen,0);assert.equal(Object.hasOwn(call.input.arguments,'evidenceContext'),false);assert.equal(call.options.signal.aborted,false);}
  assert.equal(result.nativeJournal.length,2);assert(result.nativeJournal.every(r=>r.name==='calculate_damage_range'&&r.outcome==='completed'));
  assert.equal(result.joinedCompactReceipts.length,0);assert.equal(result.frozenCompactQualified,false);assert.equal(result.frozenRangeWorkflowQualified,false);assert.equal(result.joinedFrozenRangeReceipts.length,0);assert.equal(result.qualified,false);assert.equal(result.generationObserved,false);assert.equal(result.mainQualificationVerified,false);assert.equal(hasPonderQualificationReceipt(f.provider,result),false);
  assert.equal(result.journal.records.length,2);assert(result.journal.records.every(r=>r.name==='calculate_damage_range'&&r.analysis==='frozen'&&r.liveFreshness===false&&r.choiceAuthority===false));
  assert(result.cases.every(record=>record.qualified===false&&record.qualificationChecks.workflowQualified===false));assert.equal(result.cases[1].controlExercised,false);
});

test('normal frozen host-marked coverage requests both endpoints while the preempt case stays compact-only',async()=>{
  const f=fixture({bothEndpoints:true}),result=await qualifyPonderRuntime(f.args);
  assert.equal(result.rangeCatalogAdvertised,true);assert.equal(result.models[0].hostRequiredRangeCoverage,true);assert.equal(result.models[1].hostRequiredRangeCoverage,false);
  assert(f.models[0].instructions.includes('HOST-REQUIRED FROZEN RANGE ENDPOINT COVERAGE'));assert(!f.models[1].instructions.includes('HOST-REQUIRED FROZEN RANGE ENDPOINT COVERAGE'));assert(f.models.every(call=>!call.instructions.includes('attackerOptions:')));
  assert.equal(result.cases.length,2);assert.equal(result.cases[0].controlExercised,true);assert.equal(result.cases[1].controlExercised,true);assert.equal(result.cases[1].preemption.signalAborted,true);assert.equal(result.cases[1].preemption.mainWaitedForCleanup,false);
  assert.deepEqual(f.nativeCalls.map(c=>c.input.name),['simulate_turn','calculate_damage_range','simulate_turn']);
  const range=f.nativeCalls.find(c=>c.input.name==='calculate_damage_range'),record=result.journal.records.find(r=>r.name==='calculate_damage_range');
  assert.deepEqual(range.input.arguments,{gen:0,move:'Tackle',researchContext:{source:record.frozenSource,analysis:'frozen',freezeId:record.freezeId}});
  assert.equal(record.analysis,'frozen');assert.equal(record.liveFreshness,false);assert.equal(record.choiceAuthority,false);assert.equal(record.inputSha256,digest(range.input.arguments));assert.equal(record.nativeResultSha256,result.nativeJournal.find(r=>r.name==='calculate_damage_range').resultSha256);
  assert.equal(result.frozenRangeWorkflowQualified,false);assert.equal(result.qualified,false);assert.equal(result.joinedFrozenRangeReceipts.length,0);assert.equal(hasPonderQualificationReceipt(f.provider,{...result,qualified:true,frozenRangeWorkflowQualified:true}),false);
});

test('legacy injected catalog without range can exercise compact control but cannot mint new range proof',async()=>{
  const f=fixture({rangeCatalog:false,hangUntilAbort:true}),result=await qualifyPonderRuntime(f.args);
  assert.equal(result.cases[0].controlExercised,true);assert.equal(result.cases[1].controlExercised,true);assert.equal(result.rangeCatalogAdvertised,false);assert.equal(result.frozenRangeWorkflowQualified,false);assert.equal(result.qualified,false);
  assert(result.models.every(record=>record.hostRequiredRangeCoverage===false));assert(f.models.every(call=>!call.instructions.includes('HOST-REQUIRED FROZEN RANGE ENDPOINT COVERAGE')));assert.equal(result.joinedFrozenRangeReceipts.length,0);assert.equal(hasPonderQualificationReceipt(f.provider,result),false);
});

test('actual runtime control with injected providers/SDK/adapter exercises normal and preemption but cannot mint a receipt',async()=>{
  const f=fixture({hangUntilAbort:true}),result=await qualifyPonderRuntime(f.args);
  assert.equal(result.cases.length,2);assert.equal(f.models.length,2);assert.equal(f.preflights.length,1);assert(f.closes.length>=1);
  assert.equal(result.cases[0].controlExercised,true);assert.equal(result.cases[0].unchangedWaitPreserved,true);assert.equal(result.cases[1].controlExercised,true);assert.equal(result.cases[1].preemption.signalAborted,true);assert.equal(result.cases[1].preemption.activeAfter,false);assert.equal(result.cases[1].preemption.mainWaitedForCleanup,false);
  for(const record of result.models){assert.equal(record.deadlineAt-record.startedAt<=40000,true);assert.equal(record.hostMarked,true);}
  for(const call of f.models){assert.equal(call.model,'gpt-6.1-sol');assert.equal(call.reasoningEffort,'low');assert(call.instructions.includes('host-marked, not independent research detection'));assert.equal(call.instructions.includes('ourActions:['),false);}
  for(const flag of ['qualified','mainQualificationVerified','generationObserved','frozenCompactQualified','preemptionQualified','actualSdkConnection'])assert.equal(result[flag],false,flag);
  assert.equal(result.modelDetectedResearchQualified,false);assert.equal(result.status.nativeCallsPending,0);assert.equal(result.cleanupVerified,true);assert.equal(result.battlesStarted,0);assert.equal(result.battleAuthenticationCalls,0);assert.equal(result.apiCalls,0);
  for(const record of result.cases){assert.equal(record.qualified,false);assert.equal(record.qualificationScope,'offline-shadow-case-diagnostic-only');assert.equal(record.grantsLiveAdmission,false);assert.equal(record.qualificationChecks.actualDependencies,false);assert.equal(record.qualificationChecks.mainQualificationVerified,false);assert.equal(record.qualificationChecks.sourcePinsUnchanged,true);assert.equal(record.qualificationChecks.cleanupVerified,true);}
  assert.equal(result.cases[0].qualificationChecks.workflowQualified,false,'injected generation/compact/range results cannot pass the normal evidence predicate');assert.equal(result.cases[1].qualificationChecks.workflowQualified,true,'the actual runtime preemption predicate is reported independently of fake dependency eligibility');
  assert.equal(hasPonderQualificationReceipt(f.provider,result),false);assert.equal(hasPonderQualificationReceipt(f.provider,structuredClone(result)),false);assert.equal(hasPonderQualificationReceipt(f.provider,{...result,qualified:true}),false);
});

test('owned fake SDK connection closes and emits once without mutating a frozen result during finally',async()=>{
  const f=fixture({hangUntilAbort:true}),client=f.args.nativeClient,events=[],registrations=[];let closes=0;delete f.args.nativeClient;
  f.args.connect=async options=>{assert.deepEqual(options,{qualificationOnly:true});return {client,qualificationAuthority:{mode:'child-local-saved-research',liveQuotaExercised:false,liveDescriptorAccessed:false},
    registerQualificationCase:async spec=>{registrations.push(structuredClone(spec));return {status:'registered',caseId:spec.caseId,sourceSha256:spec.sourceSha256,factsSha256:spec.factsSha256};},close:async()=>{closes++;}};};f.args.onEvent=event=>events.push(event);
  const result=await qualifyPonderRuntime(f.args);
  assert.equal(closes,1);assert.equal(result.numericSdkClosed,true);assert.equal(result.cleanupVerified,true);assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.events),true);
  assert.equal(events.filter(event=>event.name==='qualification.numeric-sdk-closed').length,1);assert.equal(result.events.filter(event=>event.name==='qualification.numeric-sdk-closed').length,1);
  assert.equal(result.cases[0].controlExercised,true);assert.equal(result.cases[1].controlExercised,true);assert.equal(result.qualified,false);assert.equal(hasPonderQualificationReceipt(f.provider,result),false);
  assert.equal(registrations.length,2);assert.notEqual(registrations[0].caseId,registrations[1].caseId);
  for(const [i,spec]of registrations.entries()){
    assert.equal(spec.contexts.length,2);assert.equal(spec.contexts[0].analysis,'current');assert.equal(spec.contexts[1].analysis,'frozen');assert.deepEqual(spec.contexts[0].source,spec.contexts[1].source);
    assert.equal(spec.contexts[1].freezeId,result.journal.records[i].freezeId);assert.equal(spec.deadlineAt,result.cases[i].deadlineAt);assert.equal(spec.deadlineAt-result.cases[i].startedAt,40000);
    assert.equal(spec.sourceSha256,result.savedSourceSha256);assert.equal(spec.turn,f.request.state.boards[0].turn);
  }
  assert.equal(result.liveQuotaExercised,false);
});

test('archived active-set search flags stay unchanged during the disclosed local-submission wait',async()=>{
  const f=fixture();f.request.state.searchPending=true;f.request.state.awaitingSet=false;f.request.state.search={searching:[],games:{[parentId]:'Owned parent',[room]:'Owned child'}};const before=structuredClone(f.request.state);
  const result=await qualifyPonderRuntime(f.args);assert.deepEqual(f.request.state,before);assert.equal(result.cases.length,2);assert.equal(result.cases[0].controlExercised,true);
  for(const record of result.cases){assert.equal(record.admission.eligible,true);assert.equal(record.waitFixtureProvenance.originalSearchPending,true);assert.equal(record.waitFixtureProvenance.searchMetadataPreserved,true);assert.equal(record.waitFixtureProvenance.originalSourceSha256,digest(before));assert.equal(record.waitFixtureProvenance.serverAcceptance,false);assert.equal(record.waitFixtureProvenance.executionObserved,false);assert.equal(record.waitFixtureProvenance.realBattleState,false);}
  for(const call of f.models){const payload=JSON.parse(call.input);assert.equal(payload.commitObservation.status,'sent');assert.equal(payload.commitObservation.serverAcceptance,false);assert.equal(payload.commitObservation.executionObserved,false);}
});



test('wait admission refusal retains its exact reason before generation and private diagnostic emission',async()=>{
  const f=fixture(),events=[];f.request.state.connected=false;f.args.onEvent=event=>events.push(event);
  await assert.rejects(qualifyPonderRuntime(f.args),error=>{assert.equal(error.code,'PONDER_QUALIFICATION');assert.equal(error.stage,'wait-admission');assert.equal(error.admissionReason,'native-not-idle');assert.equal(error.diagnostic.admission.reason,'native-not-idle');assert(error.message.includes('native-not-idle'));return true;});
  assert.equal(f.models.length,0);assert(events.some(event=>event.name==='qualification.wait-admission'&&event.admission.reason==='native-not-idle'));
});

test('unavailable compact reconstruction remains a refusal and cannot count as actual sampled work',async()=>{
  const f=fixture({unavailable:true}),result=await qualifyPonderRuntime(f.args);assert.equal(result.qualified,false);assert.equal(result.frozenCompactQualified,false);assert.equal(result.preemptionQualified,false);assert.equal(result.nativeJournal.length,0);assert.equal(result.joinedCompactReceipts.length,0);assert.equal(result.journal.records[0].outcome,'unavailable');assert.equal(result.journal.records[0].code,'SOURCE_UNAVAILABLE');
});

test('changed native source, altered archived board or a mismatched frozen marker is refused without generation',async()=>{
  const altered=fixture();altered.args.request.state.boards[0].turn=5;await assert.rejects(qualifyPonderRuntime(altered.args),{code:'PONDER_QUALIFICATION'});assert.equal(altered.models.length,0);
  const bad=fixture({badMarker:true});await assert.rejects(qualifyPonderRuntime(bad.args),{code:'PONDER_QUALIFICATION'});assert.equal(bad.models.length,0);assert(bad.closes.length>0);
});

test('loaded source pins bind full runtime/facade/projection and current skill, not a JSON claim',async()=>{
  const pins=await ponderQualificationSourcePins();assert.equal(pins.skillSha256,ISOLATED_POLICY_SOURCE.skillSha256);assert.equal(pins.skillVersion,ISOLATED_POLICY_SOURCE.skillVersion);assert.equal(pins.sha256,digest(pins.files));for(const path of ['isolated/attention-alert.mjs','isolated/ponder-runtime.mjs','isolated/ponder-controller.mjs','isolated/codex-session-transport.mjs','simulation/choice-simulation.mjs','showdown/protocol-action.mjs','showdown/battle-state.mjs','observability/qualification-research.mjs','simulation/registered-identity.mjs'])assert(pins.files.some(row=>row.path===path&&/^[a-f0-9]{64}$/u.test(row.sha256)));
  assert.equal(pins.files.find(row=>row.path==='showdown/battle-state.mjs').sha256,createHash('sha256').update(await readFile(new URL('../showdown/battle-state.mjs',import.meta.url))).digest('hex'));
  for(const name of ['context-limits.mjs','game-summary.mjs','decision-context.mjs','matchup-guidance.mjs','model-tool-observed-qualification.mjs']){
    const rows=pins.files.filter(row=>row.path==='isolated/'+name);assert.equal(rows.length,1,name);
    assert.equal(rows[0].sha256,createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex'),name);
  }
  assert.equal(await verifyPonderQualificationReceipt(fixture().provider,{qualified:true,sourcePins:pins}),false);
});

test('private qualifier retains exact returned proposals and source even when strict frozen-pointer validation rejects them',async()=>{
  const decision=output();decision.proposals[0].factPaths=['/missing-frozen-field'];
  const f=fixture({returnedDecision:decision,bothEndpoints:true}),result=await qualifyPonderRuntime(f.args),record=result.models[0],call=f.models[0];
  assert.equal(result.cases[0].terminal,'ponder.failed');assert(result.events.some(e=>e.name==='ponder.failed'&&e.code==='PONDER_DEPENDENCY'));
  assert.deepEqual(record.returnedDecision,decision);assert.equal(record.returnedDecisionSha256,digest(decision));
  assert.equal(record.source.input,call.input);assert.equal(record.source.instructions,call.instructions);assert.deepEqual(record.source.schema,call.schema);
  assert.deepEqual(record.source.frozenFacts,JSON.parse(call.input).ponderFacts);assert.equal(record.frozenFactsSha256,digest(record.source.frozenFacts));assert.equal(record.inputSha256,createHash('sha256').update(call.input).digest('hex'));
  assert.equal(record.choiceAuthority,false);assert.equal(record.materialEvidenceClaimed,false);assert.equal(record.diagnosticScope,'private-returned-shadow-qualification-only');
  assert.equal(record.generationReceiptVerified,false);assert.equal(result.qualified,false);assert.equal(result.frozenCompactQualified,false);assert.equal(hasPonderQualificationReceipt(f.provider,result),false);
  assert.equal(result.cases[0].qualified,false);assert.equal(result.cases[0].qualificationChecks.workflowQualified,false,'a rejected normal proposal cannot qualify its case');
  assert.equal(Object.isFrozen(record.returnedDecision),true);assert.equal(Object.isFrozen(record.source),true);
});

test('normal private shadow diagnostics bind the actual current logical source and never invent a final on preemption',async()=>{
  const f=fixture({hangUntilAbort:true,bothEndpoints:true}),result=await qualifyPonderRuntime(f.args);
  const normal=result.models[0],preempt=result.models[1];assert.deepEqual(normal.returnedDecision,output());assert.equal(normal.returnedDecisionSha256,digest(output()));
  assert.deepEqual(normal.source.frozenFacts.board,JSON.parse(f.request.context.input).board);assert(normal.source.frozenFacts.legalOptions);assert(normal.source.frozenFacts.actors);
  assert.equal(normal.source.schema.type,'object');assert.equal(normal.inputSha256,createHash('sha256').update(normal.source.input).digest('hex'));
  assert.equal(Object.hasOwn(preempt,'returnedDecision'),false);assert.equal(Object.hasOwn(preempt,'returnedDecisionSha256'),false);assert.equal(typeof preempt.source.input,'string');
  assert.equal(result.qualified,false);assert.equal(hasPonderQualificationReceipt(f.provider,{...result,qualified:true}),false);
});

test('shadow bridge returns a changed-query budget refusal to the author without a second normal-case native callback',async()=>{
  const path=(process.env.VGC_TEST_SAVED_REQUESTS??'');
  let document;try{document=JSON.parse(await readFile(path,'utf8'));}catch{return;}
  const request=document.requests.find(row=>row.materialRequired),workspace=fileURLToPath(new URL('../',import.meta.url));
  request.context=buildModelToolContext({state:request.state,ownTeamText:request.ownTeamText,opponentSheet:request.opponentSheet,...ISOLATED_POLICY_SOURCE});
  const pair={ourActions:[{type:'move',slot:1,target:2},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3},{type:'move',slot:1}]};
  request.decision={actions:pair.ourActions,planUpdate:{objective:'Read-only fixture.'},reason:'Read-only fixture.'};
  const f=fixture({requestOverride:request}),answers=[];let models=0;
  Object.assign(f.args,{workspace,adapterFactory:createCompactModelToolQualificationAdapter,adapterReceiptVerifier:hasCompactModelToolQualificationReceipt,
    nativeClient:{listTools:async()=>({tools:[{name:'simulate_choices',description:'Current one-trajectory schema.',annotations:{readOnlyHint:true},inputSchema:z.toJSONSchema(simulationChoicesToolSchema,{target:'draft-7'})}]}),callTool:async native=>{
      assert.equal(native.name,'simulate_turn');const {researchContext,...args}=native.arguments,result=await executeSimulation(args,{workspace,run:simulateNativeTurn});return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
    }},providerFactory:()=>({contextMode:'session',preflight:async()=>({authMode:'chatgpt',model:'gpt-6.1-sol',reasoningEffort:'low',requestedServiceTier:'fast'}),close:async()=>{},decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:async call=>{
      models++;const first=await call.modelTools.call({name:'simulate_choices',callId:'normal-original-'+models,arguments:pair,signal:call.signal});
      if(models===1){answers.push(first);answers.push(await call.modelTools.call({name:'simulate_choices',callId:'normal-changed',arguments:{...pair,ourActions:[{type:'move',slot:4},{type:'move',slot:4}]},signal:call.signal}));}
      if(call.signal.aborted)throw Object.assign(Error('fixture preempted'),{code:'aborted'});return {decision:output(),telemetry:{telemetrySource:'injected-fixture'}};
    }}})});
  const result=await qualifyPonderRuntime(f.args);
  assert.equal(answers.length,2);assert.equal(answers[1].isError,true);assert.equal(answers[1].structuredContent.kind,'research-budget-status');assert.equal(answers[1].structuredContent.status,'budget-used');
  assert.equal(result.nativeJournal.filter(entry=>entry.caseId==='complete-frozen-material'&&entry.name==='simulate_turn').length,1);
  assert.equal(result.compactJournal.filter(entry=>entry.caseId==='complete-frozen-material'&&entry.proofVerified).length,1);assert(result.compactJournal.some(entry=>entry.researchBudgetStatus==='budget-used'&&entry.proofVerified===false));assert.equal(result.qualified,false);
});
