// Offline selected-model qualification of the actual shadow runtime. Importing
// this module opens no provider/SDK and grants no battle or login allowance.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {digest,boardDigest,requestDigest} from '../planning/identity.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {createBattlePonderRuntime} from './ponder-runtime.mjs';
import {PONDER_PROFILE} from './ponder-controller.mjs';
import {createCodexCliDecisionProvider,hasCodexCliGenerationReceipt} from './codex-cli-provider.mjs';
import {hasModelToolQualificationReceipt} from './model-tool-qualification.mjs';
import {createCompactModelToolQualificationAdapter,hasCompactModelToolQualificationReceipt,hasCompactModelToolQualificationBudgetStatus} from './compact-model-tool-qualification.mjs';
import {verifyModelToolContextPolicy} from './model-tool-cycle.mjs';
import {verifyMatchupGuidance} from './matchup-guidance.mjs';
import {ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {codexSessionScopeHash} from './codex-session-transport.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),receipts=new WeakMap();
const clone=structuredClone,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),HASH=/^[a-f0-9]{64}$/u;
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const selected=provider=>provider?.decisionProvider??provider;
const canonical=value=>String(value??'').replace(/-[a-z0-9]+pw$/u,'');
const need=(condition,message)=>{if(!condition)throw Object.assign(Error(message),{code:'PONDER_QUALIFICATION'});};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const success=value=>value?.isError!==true&&value?.error===undefined&&value?.structuredContent?.ok!==false;
const CLOCK_MS=40000,CLEANUP_MS=5000;
const SOURCE_FILES=Object.freeze(['isolated/launch.mjs','isolated/qualification-budget.mjs','isolated/codex-cli-transport.mjs','isolated/codex-wire.mjs','observability/numeric-client.mjs','isolated/ponder-qualification.mjs','isolated/ponder-runtime.mjs','isolated/ponder-controller.mjs','isolated/ponder-evidence.mjs','isolated/runner.mjs',
  'isolated/context-limits.mjs','isolated/game-summary.mjs','isolated/decision-context.mjs','isolated/matchup-guidance.mjs',
  'isolated/native-controller.mjs','isolated/model-tool-cycle.mjs','isolated/model-tool-qualification.mjs','showdown/operator-client.mjs','showdown/action-next.mjs','showdown/agent-session.mjs','showdown/battle-state.mjs','showdown/protocol-action.mjs',
  'isolated/codex-cli-provider.mjs','isolated/codex-session-transport.mjs','isolated/codex-session-context.mjs','isolated/codex-tool-schema.mjs','isolated/model-tool-validation.mjs',
  'isolated/compact-model-tool-qualification.mjs','showdown/model-owned-tools.mjs','simulation/choice-simulation.mjs','simulation/choice-schemas.mjs','simulation/choice-state.mjs','simulation/choice-presentation.mjs','planning/research-budget.mjs','planning/mcp-tools.mjs',
  'simulation/spread-candidates.mjs','simulation/spread-observations.mjs','simulation/spread-range.mjs','simulation/choice-ranges.mjs','simulation/observed-position.mjs','simulation/turn-simulator.mjs','simulation/move-support.mjs','simulation/native-state.mjs','simulation/approximate-position.mjs','simulation/history-state.mjs','simulation/turn-worker.mjs','simulation/mcp-tools.mjs','simulation/schemas.mjs',
  'workflow/calculations.mjs','workflow/calculation-archive.mjs','planning/tool-client.mjs','dist/index.js','dist/speed/calculator.js','package-lock.json']);
const PROBE='OFFLINE SHADOW MATERIAL QUALIFICATION (host-marked, not independent research detection): This is a saved historical position and an explicitly simulated local-submission wait, not an actual live submission. Choose a meaningful our/opposing paired-action question yourself, call simulate_choices with your own complete pairs, inspect its actual frozen result, then return bounded speculative proposals under the supplied output schema. No tactical pair, hypothesis, expected answer, or current-turn gate is supplied by the harness. One original 40-second local clock covers tools and final output. A fresh-request event may interrupt this read-only exercise immediately.';
const RANGE_PROBE='HOST-REQUIRED FROZEN RANGE ENDPOINT COVERAGE: In this normal completion case, also request calculate_damage_range for a material question you choose under native Champions gen:0. Independently author its species, move, fixed conditions, legal nature/stat-point domains and any HP hypotheses. Inspect the actual finite-domain or explicitly partial range and its coverage before returning proposals. Both simulate_choices and calculate_damage_range are required technical endpoint coverage for this case. No tactical pair, calculation input, domain, expected bound or probability is supplied. These are frozen historical hypotheses and establish no current action authority. This host-marked probe does not establish model-detected research, and shares the same original 40-second clock.';

export async function ponderQualificationSourcePins(){
  const files=await Promise.all(SOURCE_FILES.map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(ROOT,path))).digest('hex')})));
  return {files,sha256:digest(files),skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,profile:clone(PONDER_PROFILE)};
}
export function hasPonderQualificationReceipt(provider,result){return object(result)&&result.qualified===true&&receipts.get(result)===selected(provider);}
export async function verifyPonderQualificationReceipt(provider,result){
  if(!hasPonderQualificationReceipt(provider,result))return false;
  try{verifyIsolatedPolicySource();return digest(await ponderQualificationSourcePins())===digest(result.sourcePins);}catch{return false;}
}

// Report semantics only. This helper never creates or verifies a provider receipt;
// one passing case cannot admit the combined workflow to live use.
export function describePonderCaseQualification({actualDependencies,mainQualificationVerified,sourcePinsUnchanged,cleanupVerified,workflowQualified}={}){
  const checks={actualDependencies:actualDependencies===true,mainQualificationVerified:mainQualificationVerified===true,sourcePinsUnchanged:sourcePinsUnchanged===true,cleanupVerified:cleanupVerified===true,workflowQualified:workflowQualified===true};
  return {qualified:Object.values(checks).every(value=>value===true),qualificationScope:'offline-shadow-case-diagnostic-only',grantsLiveAdmission:false,qualificationChecks:checks};
}

function prepareRequest(request,mainQualification,decision){
  need(object(request?.context)&&object(request.state)&&object(request.identity),'One complete saved material request is required.');
  const row=clone(request),state=row.state.result??row.state,context=row.context,binding=context.binding;
  verifyModelToolContextPolicy(context);const payload=restoreContextPayload(JSON.parse(context.input));verifyMatchupGuidance(payload.matchupSkill,ISOLATED_POLICY_SOURCE);
  const action=row.action??state.actions?.[0],board=state.boards?.find(value=>value.room===action?.room);
  need(row.materialRequired===true&&action?.kind==='turn'&&state.actions?.length===1&&digest(state.actions[0])===digest(action)&&board,'Exact saved material turn/board required.');
  need(binding?.teamId===row.identity.teamId&&binding.sessionId===row.identity.sessionId&&state.sessionId===binding.sessionId&&state.teamSha256===binding.teamId&&HASH.test(binding.teamId),'Saved team/session binding differs.');
  need(['room','rqid','token','parentId','revision','kind'].every(key=>binding[key]===action[key])&&binding.boardHash===boardDigest(board,action.legalActions)&&binding.legalHash===digest(action.legalActions),'Saved native source or legality differs.');
  const {requestDigest:declared,...sourceBinding}=binding;need(declared===requestDigest(sourceBinding),'Saved native digest differs.');
  const mainRow=mainQualification?.rows?.find(value=>value.requestDigest===binding.requestDigest);
  const authored=decision??mainRow?.authoredDecision;
  need(object(authored)&&Array.isArray(authored.actions),'Use a source-matching model-authored committed pair; the harness chooses none.');
  const actions=validateChoice({...action.legalActions,side:{pokemon:action.legalActions.pokemon}},authored.actions).actions;
  if(mainRow?.localChoice?.actions)need(digest(mainRow.localChoice.actions)===digest(actions),'Main qualified pair differs from the supplied committed pair.');
  return {...row,state,action,board,decision:{...clone(authored),actions},sourceSha256:digest(state)};
}
function generationVerified(owner,response,request,deadlineAt){
  const t=response?.telemetry,settings=t?.verifiedThreadSettings;
  return hasCodexCliGenerationReceipt(owner,response)&&t?.telemetrySource==='codex-cli-session'&&t.authenticationMethod==='chatgpt'&&t.contextMode==='session'&&
    t.sessionTurnCompleted===true&&t.sessionProcessOwned===true&&t.sessionSourceRehydrated===true&&t.modelToolsEnabled===true&&
    t.requestedServiceTier==='fast'&&t.requestedWireServiceTier==='priority'&&settings?.model==='gpt-6.1-sol'&&settings.reasoningEffort==='low'&&['fast','priority'].includes(settings.serviceTier)&&
    t.nativeInputSha256===sha(request.input)&&t.nativeSchemaSha256===sha(request.schema)&&t.nativeInstructionsSha256===sha(request.instructions)&&
    t.sessionScopeSha256===codexSessionScopeHash(request.sessionScope)&&HASH.test(t.sessionThreadSha256??'')&&t.sessionContextMetadata?.staticSent?.includes('matchupSkill')&&
    Number.isFinite(t.finalReceivedAt)&&t.finalReceivedAt<deadlineAt;
}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),ms);})]);}finally{clearTimeout(timer);}}

/** Offline observer fixture only: preserve the archived source separately and
 * disclose simulated local submission while preserving native search metadata. This is
 * never a native acknowledgement, live source or production-guard override. */
export function createPonderQualificationWaitFixture({state,action,committedActions,marker}={}){
  need(object(state)&&object(action)&&Array.isArray(committedActions)&&object(marker),'Complete offline wait fixture inputs required.');
  return {...clone(state),actions:[],
    rooms:[{id:action.room,parentId:action.parentId,ended:false},{id:action.parentId,ended:false}],
    choices:[{room:action.room,rqid:action.rqid,actions:clone(committedActions),status:'sent',evidence:[],boundary:null,uncertain:false,frozenSimulation:clone(marker)}],
    offlinePonderWaitFixture:{kind:'simulated-local-submission-wait',originalSourceSha256:digest(state),localSubmissionSimulated:true,realBattleState:false,serverAcceptance:false,executionObserved:false,
      nativeAcknowledgementClaimed:false,searchMetadataPreserved:true,originalSearchPending:state.searchPending??null,originalAwaitingSet:state.awaitingSet??null}};
}

/** Two cases only: complete frozen material work, then an actual tool dispatch
 * preempted by a synthetic delivery of the exact saved actionable request.
 * Main first/material/continuity qualification remains a separate genuine gate.
 * Dependency injection exercises control tests but can never mint this receipt.
 */
export async function qualifyPonderRuntime({workspace=ROOT,provider,mainQualification,request,decision,nativeClient,
  connect=connectOfflineNumericClient,providerFactory=createCodexCliDecisionProvider,adapterFactory=createCompactModelToolQualificationAdapter,
  adapterReceiptVerifier=hasCompactModelToolQualificationReceipt,now=Date.now,onEvent=()=>{}}={}){
  const main=selected(provider);
  need(main?.kind==='codex-cli'&&main.model==='gpt-6.1-sol'&&main.reasoningEffort==='low','Exact selected Sol/Low main provider required.');
  const actualDependencies=nativeClient===undefined&&connect===connectOfflineNumericClient&&providerFactory===createCodexCliDecisionProvider&&adapterFactory===createCompactModelToolQualificationAdapter&&adapterReceiptVerifier===hasCompactModelToolQualificationReceipt&&now===Date.now;
  const mainVerified=hasModelToolQualificationReceipt(main,mainQualification)&&mainQualification.skillSha256===ISOLATED_POLICY_SOURCE.skillSha256;
  const base={qualified:false,profile:clone(PONDER_PROFILE),providerKind:'codex-cli',requestedModel:main.model,reasoningEffort:main.reasoningEffort,contextMode:'session',mainQualificationVerified:mainVerified,
    generationObserved:false,frozenCompactQualified:false,frozenRangeWorkflowQualified:false,preemptionQualified:false,modelDetectedResearchQualified:false,hostMarkedMaterialProbe:true,battlesStarted:0,battleAuthenticationCalls:0,apiCalls:0,
    limits:'Two offline shadow cases only; local-submission and fresh-request events are disclosed fixtures over verified saved facts. Frozen results are speculative, not current material/acceptance/execution receipts. No sustained live timing guarantee.'};
  if(!request)return freeze({...base,reason:'saved-material-request-required'});
  if(actualDependencies&&!mainVerified)return freeze({...base,reason:'current-branded-main-qualification-required'});
  verifyIsolatedPolicySource();const sourcePins=await ponderQualificationSourcePins(),row=prepareRequest(request,mainQualification,decision);
  const events=[],models=[],nativeJournal=[],compactJournal=[],nativeRecords=new WeakSet();let connection,client=nativeClient,runtime,owner,activeCase,closed=false,shadowClosed=false,rangeCatalogAdvertised=false;
  const emit=event=>{if(events.length<1024)events.push(clone(event));try{onEvent(clone(event));}catch{}};
  let resolveCase;const terminal=event=>{
    emit(event);
    if(activeCase&&event.name==='ponder.model-started'){
      activeCase.jobId=event.jobId;const before=runtime.status().core.preempted;runtime.observeState(activeCase.waiting);activeCase.unchangedWaitPreserved=runtime.status().core.active&&runtime.status().core.preempted===before;
    }
    if(activeCase&&['ponder.completed','ponder.failed','ponder.discarded'].includes(event.name))resolveCase?.(event);
  };
  const forward=async(nativeRequest,schema,options)=>{
    need(['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','get_pokemon','get_move','get_ability','get_movepool'].includes(nativeRequest.name),'Shadow qualification exposes no battle mutations.');
    if(nativeRequest.name==='calculate_damage_range')need(nativeRequest.arguments?.gen===0,'Shadow range qualification requires native M-C gen:0.');
    const entry={caseId:activeCase.caseId,name:nativeRequest.name,input:clone(nativeRequest.arguments),inputSha256:digest(nativeRequest.arguments),startedAt:now(),deadlineAt:activeCase.deadlineAt,transport:actualDependencies?'qualification-owned-sdk-stdio':'injected-client',outcome:'pending'};nativeJournal.push(entry);
    need(now()<activeCase.deadlineAt&&!options?.signal?.aborted,'Original shadow deadline elapsed.');
    try{
      const pending=client.callTool(nativeRequest,schema,options);
      if(activeCase.preempt&&activeCase.compactInFlight&&!activeCase.preemption){
        const at=now(),start=performance.now(),observation=runtime.observeState(clone(row.state)),elapsedMs=performance.now()-start;
        activeCase.preemption={at,elapsedMs,observation,signalAborted:options?.signal?.aborted===true,activeAfter:runtime.status().core.active,mainWaitedForCleanup:false};
        emit({name:'qualification.fresh-request-preempted',caseId:activeCase.caseId,at,elapsedMs,signalAborted:activeCase.preemption.signalAborted});
      }
      const result=await pending;entry.settledAt=now();entry.result=clone(result);entry.resultSha256=digest(result);entry.timely=!options?.signal?.aborted&&now()<activeCase.deadlineAt;entry.outcome=success(result)?'completed':'returned-error';
      if(actualDependencies&&entry.timely&&entry.outcome==='completed')nativeRecords.add(entry);return result;
    }catch(error){entry.settledAt=now();entry.outcome='unavailable';entry.code=String(error?.code??'NATIVE_TOOL_FAILED').slice(0,100);throw error;}
  };
  try{
    if(!client){connection=await connect();client=connection?.client;}
    need(client&&typeof client.callTool==='function'&&typeof client.listTools==='function','Owned numerical SDK required.');
    const wrapperClient={listTools:(...args)=>client.listTools(...args),callTool:async(nativeRequest,schema,options)=>{
      if(nativeRequest.name!=='simulate_choices')return forward(nativeRequest,schema,options);
      const entry={caseId:activeCase.caseId,inputSha256:digest(nativeRequest.arguments),startedAt:now()};compactJournal.push(entry);activeCase.compactInFlight=true;
      try{const result=await activeCase.adapter.execute({name:nativeRequest.name,args:clone(nativeRequest.arguments),signal:options?.signal,deadlineAt:Math.min(activeCase.deadlineAt,now()+(options?.timeout??5000)),callNative:forward});
        if(hasCompactModelToolQualificationBudgetStatus(activeCase.adapter,result)){
          entry.settledAt=now();entry.resultSha256=digest(result);entry.proofVerified=false;entry.result=clone(result);entry.researchBudgetStatus=result.status;
          return {isError:true,structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
        }
        entry.settledAt=now();entry.resultSha256=digest(result);entry.proofVerified=adapterReceiptVerifier(activeCase.adapter,result);entry.proof=activeCase.adapter.receipt(result);entry.result=clone(result);return result;
      }finally{activeCase.compactInFlight=false;}
    }};
    runtime=createBattlePonderRuntime({workspace,mainDecisionProvider:main,nativeClient:wrapperClient,profile:PONDER_PROFILE,now,onEvent:terminal,limits:{maxPonderMs:CLOCK_MS},providerFactory:options=>{
      owner=providerFactory(options);need(owner?.decisionProvider!==main,'Shadow and main provider identities must differ.');
      // The diagnostic proxy appends only a disclosed neutral protocol probe.
      // Verify the real owner's generation brand, never the proxy's identity.
      const proxy={...owner,decisionProvider:{kind:owner.decisionProvider.kind,model:owner.decisionProvider.model,reasoningEffort:owner.decisionProvider.reasoningEffort,callDecision:async original=>{
        const requireRange=!activeCase.preempt&&rangeCatalogAdvertised,effective={...original,deadlineAt:Math.min(original.deadlineAt,activeCase.deadlineAt),instructions:original.instructions+'\n\n'+PROBE+(requireRange?'\n\n'+RANGE_PROBE:'')};
        need(typeof effective.input==='string'&&Buffer.byteLength(effective.input)<=MAX_CONTEXT_BYTES&&Buffer.byteLength(JSON.stringify(effective.schema))<=MAX_CONTEXT_BYTES,'Complete private shadow qualification source exceeds its bound.');
        const frozenFacts=JSON.parse(effective.input).ponderFacts,record={caseId:activeCase.caseId,startedAt:now(),deadlineAt:effective.deadlineAt,inputSha256:sha(effective.input),frozenFactsSha256:digest(frozenFacts),instructionsSha256:sha(effective.instructions),schemaSha256:sha(effective.schema),hostMarked:true,hostRequiredRangeCoverage:requireRange,
          source:{input:effective.input,instructions:effective.instructions,schema:clone(effective.schema),frozenFacts:clone(frozenFacts)},diagnosticScope:'private-returned-shadow-qualification-only',choiceAuthority:false,materialEvidenceClaimed:false};models.push(record);
        try{const response=await owner.decisionProvider.callDecision(effective);record.settledAt=now();record.telemetry=clone(response.telemetry??{});record.generationReceiptVerified=generationVerified(owner.decisionProvider,response,effective,activeCase.deadlineAt);
          // Capture the actual structured final before the runtime validates
          // proposal dependencies. A rejected final must remain inspectable;
          // this copy is no SDK/generation brand or successful proposal claim.
          if(response?.decision!==undefined){need(Buffer.byteLength(JSON.stringify(response.decision))<=256*1024,'Returned shadow diagnostic exceeds its bound.');record.returnedDecision=clone(response.decision);record.returnedDecisionSha256=digest(record.returnedDecision);}
          return response;}
        catch(error){record.settledAt=now();record.code=String(error?.code??'PROVIDER_FAILED');record.telemetry=clone(error?.telemetry??{});throw error;}
      }}};return proxy;
    }});
    const prepared=await runtime.prepare();rangeCatalogAdvertised=prepared.tools?.includes('calculate_damage_range')===true;
    const cases=[];
    for(const preempt of [false,true]){
      const adapter=await adapterFactory({workspace,state:row.state,ownTeamText:row.ownTeamText,opponentSheet:row.opponentSheet,provenance:row.provenance,now}),marker=adapter.frozenMarker();
      const startedAt=now(),deadlineAt=startedAt+CLOCK_MS;
      activeCase={caseId:preempt?'preempt-during-frozen-tool':'complete-frozen-material',preempt,adapter,startedAt,deadlineAt,qualified:false};cases.push(activeCase);
      activeCase.waiting=createPonderQualificationWaitFixture({state:row.state,action:row.action,committedActions:row.decision.actions,marker});
      activeCase.waitFixtureProvenance=clone(activeCase.waiting.offlinePonderWaitFixture);
      need(marker.source?.sessionId===row.context.binding.sessionId&&marker.source.teamId===row.context.binding.teamId&&['room','rqid','token'].every(key=>marker.source[key]===row.context.binding[key]),'Frozen adapter marker differs from the exact saved request.');
      // Each exercise explicitly delivers its saved actionable source before
      // the locally simulated submission; never schedule an old wait snapshot.
      runtime.setMainBusy(true);runtime.observeState(clone(row.state));const cached=runtime.setDecisionContext({context:row.context,state:row.state,decision:row.decision});need(cached.decisionAttached,'Model-authored committed pair could not bind.');runtime.setMainBusy(false);
      const finished=new Promise(resolve=>{resolveCase=resolve;});emit({name:'qualification.case-start',caseId:activeCase.caseId,at:startedAt,deadlineAt});
      const admission=runtime.observeState(activeCase.waiting);activeCase.admission=clone(admission);
      emit({name:'qualification.wait-admission',caseId:activeCase.caseId,at:now(),admission:clone(admission)});
      if(!admission.eligible){const admissionReason=admission.reason??'unavailable';throw Object.assign(Error(`Saved committed wait was refused: ${admissionReason}`),{code:'PONDER_QUALIFICATION',stage:'wait-admission',admissionReason,diagnostic:{stage:'wait-admission',caseId:activeCase.caseId,admission:clone(admission)}});}
      const end=await bounded(finished,Math.max(1,deadlineAt-now()));if(end?.timeout)runtime.setMainBusy(true);
      activeCase.finishedAt=now();activeCase.terminal=end?.name??'case-timeout';
      if(!preempt){activeCase.notes=runtime.notesFor({context:row.context,state:row.state});
        activeCase.controlExercised=end?.name==='ponder.completed'&&activeCase.unchangedWaitPreserved===true&&activeCase.notes?.speculative===true&&activeCase.notes.requiresFreshMaterialChecks===true&&activeCase.notes.goalPassed===false;
      }else activeCase.controlExercised=!!activeCase.preemption&&activeCase.preemption.elapsedMs<=50&&activeCase.preemption.signalAborted&&activeCase.preemption.activeAfter===false;
      emit({name:'qualification.case-complete',caseId:activeCase.caseId,at:now(),terminal:activeCase.terminal,controlExercised:activeCase.controlExercised});
      if(actualDependencies&&!activeCase.controlExercised)break;
    }
    runtime.stop('qualification-ended');await bounded(runtime.drain({timeoutMs:1000}),1100);
    const shadowClose=await bounded(Promise.resolve().then(()=>owner?.close()).then(()=>({closed:true})),CLEANUP_MS);shadowClosed=shadowClose?.closed===true;
    const status=runtime.status(),journal=runtime.privateEvidence(),sourcePinsAfter=await ponderQualificationSourcePins();
    const normal=cases[0],preempt=cases[1],normalModel=models.find(value=>value.caseId===normal?.caseId),normalCompact=compactJournal.filter(value=>value.caseId===normal?.caseId);
    const joined=normalCompact.filter(entry=>entry.proofVerified&&entry.proof?.pairedSimulation===true&&entry.proof.version===2&&entry.proof.researchPolicy==='single-outcome'&&entry.proof.sourceProvenanceVerified===true&&entry.proof.readinessVerified===true&&entry.proof.frozenSourceSha256===row.sourceSha256&&entry.proof.authoredInputSha256===entry.inputSha256&&entry.proof.resultSha256===entry.resultSha256&&entry.proof.nativeCalls?.filter(call=>call.name==='simulate_turn').length===1&&entry.proof.nativeCalls.every(call=>nativeJournal.some(native=>nativeRecords.has(native)&&native.caseId===entry.caseId&&native.name===call.name&&native.inputSha256===call.inputSha256&&native.resultSha256===call.resultSha256&&native.startedAt>=call.startedAt&&native.settledAt<=call.settledAt)));
    const markerSource=normal?.adapter.frozenMarker().source;
    const joinedRanges=journal.records.filter(record=>{
      const value=record.nativeResult?.structuredContent;
      return record.name==='calculate_damage_range'&&record.analysis==='frozen'&&record.evidenceScope==='frozen-pre-submission-only'&&record.liveFreshness===false&&record.choiceAuthority===false&&record.timely===true&&record.outcome==='returned'&&
        record.freezeId===normal?.adapter.frozenMarker().freezeId&&record.sourceSha256===normal.admission?.sourceSha256&&record.factsSha256===normalModel?.frozenFactsSha256&&record.startedAt>=normal.startedAt&&record.settledAt<=normal.finishedAt&&record.settledAt<record.deadlineAt&&record.deadlineAt<=normal.deadlineAt&&digest(record.frozenSource)===digest(markerSource)&&
        object(record.authoredArguments)&&record.authoredArgumentsSha256===digest(record.authoredArguments)&&digest({...record.authoredArguments,gen:0,researchContext:{source:clone(markerSource),analysis:'frozen',freezeId:normal.adapter.frozenMarker().freezeId}})===record.inputSha256&&record.input?.gen===0&&record.inputSha256===digest(record.input)&&record.nativeResultSha256===digest(record.nativeResult)&&record.modelResultSha256===digest(record.modelResult)&&
        value?.kind==='champions-damage-range-v1'&&value.gen===0&&['complete-finite-domain','partial-candidate-envelope'].includes(value.status)&&value.coverage?.completed>0&&Number.isFinite(value.damageRange?.min)&&Number.isFinite(value.damageRange?.max)&&value.damageRange.min>=0&&value.damageRange.min<=value.damageRange.max&&
        nativeJournal.some(native=>nativeRecords.has(native)&&native.caseId===normal.caseId&&native.name==='calculate_damage_range'&&native.inputSha256===record.inputSha256&&native.resultSha256===record.nativeResultSha256&&native.startedAt>=record.startedAt&&native.settledAt<=record.settledAt&&native.settledAt<record.deadlineAt);
    }).map(record=>({name:record.name,inputSha256:record.inputSha256,nativeResultSha256:record.nativeResultSha256,authoredArgumentsSha256:record.authoredArgumentsSha256,frozenSourceSha256:digest(record.frozenSource),sourceSha256:record.sourceSha256,factsSha256:record.factsSha256,startedAt:record.startedAt,settledAt:record.settledAt,deadlineAt:record.deadlineAt,analysis:'frozen',liveFreshness:false,choiceAuthority:false,rangeStatus:record.nativeResult.structuredContent.status,exhaustive:record.nativeResult.structuredContent.coverage.exhaustive===true}));
    const late=runtime.notesFor({context:row.context,state:row.state});
    const frozenQualified=!!normal?.controlExercised&&normal.finishedAt<normal.deadlineAt&&normalModel?.generationReceiptVerified===true&&joined.length>0;
    const frozenRangeQualified=rangeCatalogAdvertised&&frozenQualified&&normalModel?.hostRequiredRangeCoverage===true&&joinedRanges.length>0;
    const preemptQualified=!!preempt?.controlExercised&&preempt.finishedAt<preempt.deadlineAt&&models.some(value=>value.caseId===preempt.caseId&&['aborted','session_closed'].includes(value.code))&&late===null;
    if(connection){await connection.close();closed=true;emit({name:'qualification.numeric-sdk-closed',at:now()});}
    const clean=shadowClosed&&(!actualDependencies||closed)&&!status.shadowModelPending&&!status.shadowClosePending&&!status.shadowPreflightPending&&!status.nativeCallsPending&&status.core.cleanupPending===0&&!status.blocked;
    const qualified=actualDependencies&&mainVerified&&frozenQualified&&frozenRangeQualified&&preemptQualified&&clean&&digest(sourcePins)===digest(sourcePinsAfter);
    for(const record of cases)Object.assign(record,describePonderCaseQualification({actualDependencies,mainQualificationVerified:mainVerified,sourcePinsUnchanged:digest(sourcePins)===digest(sourcePinsAfter),cleanupVerified:clean,
      workflowQualified:record===normal?frozenQualified&&frozenRangeQualified:record===preempt?preemptQualified:false}));
    const result={...base,qualified,teamId:row.identity.teamId,sourcePins,sourcePinsUnchanged:digest(sourcePins)===digest(sourcePinsAfter),savedSourceSha256:row.sourceSha256,requestDigest:row.context.binding.requestDigest,
      generationObserved:normalModel?.generationReceiptVerified===true,frozenCompactQualified:actualDependencies&&frozenQualified,rangeCatalogAdvertised,frozenRangeWorkflowQualified:actualDependencies&&frozenRangeQualified,preemptionQualified:actualDependencies&&preemptQualified,actualSdkConnection:actualDependencies,numericSdkClosed:closed,
      cases:cases.map(({adapter,waiting,...record})=>record),models,nativeJournal,compactJournal,joinedCompactReceipts:joined.map(value=>clone(value.proof)),joinedFrozenRangeReceipts:joinedRanges,events,journal,status,shadowClosed,cleanupVerified:clean,
      generationReceiptOwner:'the original selected shadow provider, separate from the qualification-only neutral-probe proxy',reason:qualified?null:'shadow-model-tool-workflow-evidence-incomplete'};
    // Results must not freeze the arrays/records still owned by cleanup or late
    // diagnostic callbacks. Brand only the immutable detached snapshot.
    const snapshot=freeze(clone(result));if(qualified)receipts.set(snapshot,main);return snapshot;
  }finally{
    runtime?.stop('qualification-finally');if(owner&&!shadowClosed)await bounded(Promise.resolve().then(()=>owner.close()).catch(()=>({closed:false})),CLEANUP_MS);
    // `closed` is a local transport observation, never battle-client shutdown.
    if(connection&&!closed){await connection.close();closed=true;emit({name:'qualification.numeric-sdk-closed',at:now()});}
  }
}
