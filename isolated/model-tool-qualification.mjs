// Explicit offline admission for the direct model-tool route. Importing this
// module creates no model, SDK connection, authenticated battle or search.
import {createHash,randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createOperator,unpackToolResult} from '../showdown/operator-client.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {hasCodexCliGenerationReceipt} from './codex-cli-provider.mjs';
import {ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {verifyMatchupGuidance} from './matchup-guidance.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {runModelToolCycle,verifyModelToolContextPolicy} from './model-tool-cycle.mjs';
import {MODEL_TOOL_NAMES,bindModelToolArguments} from '../showdown/model-owned-tools.mjs';
import {codexSessionScopeHash} from './codex-session-transport.mjs';
import {boardDigest,digest,requestDigest} from '../planning/identity.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {createModelToolObservedQualificationAdapter,hasModelToolObservedQualificationReceipt} from './model-tool-observed-qualification.mjs';
import {createCompactModelToolQualificationAdapter,hasCompactModelToolQualificationReceipt,hasCompactModelToolQualificationBudgetStatus} from './compact-model-tool-qualification.mjs';

const receipts=new WeakMap(),nativeReplies=new WeakSet(),nativeRecords=new WeakSet();
const NUMERIC=new Set(['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','simulate_choices']);
const clone=structuredClone,hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const HASH=/^[a-f0-9]{64}$/u;
const CLOCK_MS=40000,RESERVE_MS=5000;
const need=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{code:'MODEL_TOOL_QUALIFICATION'});};
function unwrap(value){for(let index=0;index<5&&object(value)&&value.result!==undefined;index++)value=value.result;return value?.structuredContent?.result??value;}
const success=value=>!value?.error&&value?.ok!==false&&value?.isError!==true&&value?.structuredContent?.ok!==false;
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function freeze(value){if(object(value)||Array.isArray(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function modelToolReply(value){
  for(let index=0;index<6&&object(value);index++){
    if(value.kind==='model-tool-result')return value;
    value=value.result??value.structuredContent?.result;
  }
  return null;
}
function returnedRange(value){
  const range=value?.structuredContent;
  const bounds=range?.damageRange,coverage=range?.coverage;
  const witness=row=>object(row)&&row.status==='complete'&&HASH.test(row.inputSha256??'')&&HASH.test(row.resultSha256??'')&&
    Array.isArray(row.range)&&row.range.length===2&&row.range.every(n=>Number.isSafeInteger(n)&&n>=0)&&row.range[0]<=row.range[1];
  return success(value)&&range?.kind==='champions-damage-range-v1'&&range.gen===0&&
    ['complete-finite-domain','partial-candidate-envelope'].includes(range.status)&&
    object(bounds)&&bounds.unit==='actual-hp'&&Number.isSafeInteger(bounds.min)&&Number.isSafeInteger(bounds.max)&&bounds.min>=0&&bounds.min<=bounds.max&&
    witness(bounds.minimumWitness)&&witness(bounds.maximumWitness)&&bounds.minimumWitness.range[0]===bounds.min&&bounds.maximumWitness.range[1]===bounds.max&&
    object(coverage)&&Number.isSafeInteger(coverage.completed)&&coverage.completed>0&&coverage.cancelled===false&&HASH.test(coverage.evaluationSha256??'')&&
    (range.status==='complete-finite-domain'?coverage.exhaustive===true&&bounds.scope==='all-declared-finite-assignments':coverage.exhaustive===false&&bounds.scope==='evaluated-legal-witnesses-only')&&
    Array.isArray(range.records)&&range.records.length>0&&range.records.length<=16&&
    range.records.some(row=>same(row,bounds.minimumWitness))&&range.records.some(row=>same(row,bounds.maximumWitness));
}
function rangeQualificationChecks(prepared,rows,nativeJournal){
  return prepared.flatMap(row=>{
    const record=rows.find(record=>record.caseId===row.caseId&&record.sourceSha256===row.sourceSha256);
    if(!row.materialRequired||!record)return [];
    const source={sessionId:row.identity.sessionId,teamId:row.identity.teamId,room:row.action.room,rqid:row.action.rqid,token:row.action.token};
    const sourceSha256=digest({...source,boardHash:row.context.binding.boardHash,legalHash:row.context.binding.legalHash});
    const turn=row.state.boards.find(board=>board.room===row.action.room)?.turn;
    return (record.authoredDecision?.modelToolCalls??[]).filter(call=>call.name==='calculate_damage_range').map(call=>{
      const reply=modelToolReply(call.result),receipt=reply?.receipt;
      const entry=nativeJournal.find(entry=>entry.name==='calculate_damage_range'&&entry.modelToolCommandId===receipt?.commandId&&entry.sourceSha256===row.sourceSha256);
      const nativeValue=entry?unpackToolResult(entry.result):null;
      let boundArguments;try{boundArguments=bindModelToolArguments(call.name,call.arguments,{source,turn});}catch{/* Invalid model arguments do not qualify. */}
      const checks={modelAuthored:call.origin==='model-requested'&&call.status==='returned'&&call.arguments?.gen===0,
        exactBoundArguments:!!entry&&!!boundArguments&&digest(entry.input)===digest(boundArguments)&&receipt?.argumentsSha256===digest(entry.input),
        exactSource:receipt?.sourceSha256===sourceSha256&&receipt?.deadlineAt===row.qualificationDeadlineAt&&receipt?.nativeCutoffAt===row.qualificationDeadlineAt+RESERVE_MS,
        exactNativeResult:!!entry&&object(nativeValue)&&object(reply?.result)&&receipt?.nativeResultSha256===digest(nativeValue)&&receipt?.resultSha256===digest(nativeValue)&&digest(reply.result)===digest(nativeValue),
        returnedRange:!!entry&&returnedRange(entry.result),
        timely:!!entry&&entry.outcome==='completed'&&entry.timely===true&&entry.startedAt>=record.startedAt&&entry.finishedAt<record.deadlineAt&&
          call.startedAt<=entry.startedAt&&call.completedAt>=entry.finishedAt&&call.completedAt<record.deadlineAt&&receipt?.startedAt<=entry.startedAt&&receipt?.settledAt>=entry.finishedAt,
        operatorNativeReceipt:receipt?.nativeMcp===true&&receipt?.modelRequested===true&&receipt?.hostPlanning===false,
        actualSdkReceipt:!!entry&&nativeRecords.has(entry)};
      return {caseId:row.caseId,requestDigest:row.context.binding.requestDigest,sourceSha256:row.sourceSha256,
        ...(receipt?.commandId?{modelToolCommandId:receipt.commandId}:{}),authoredInputSha256:digest(call.arguments),
        ...(entry?{nativeInputSha256:digest(entry.input),nativeResultSha256:digest(entry.result),deliveredNativeValueSha256:digest(nativeValue),startedAt:entry.startedAt,settledAt:entry.finishedAt}:{}),
        deadlineAt:row.qualificationDeadlineAt,checks,mechanicalChecksPassed:Object.entries(checks).every(([key,value])=>key==='actualSdkReceipt'||value),
        joined:Object.values(checks).every(Boolean)};
    });
  });
}
function explicitSchema(node,root,seen=new Set()){
  if(!object(node)||seen.has(node))return null;seen.add(node);
  if(node.$ref){
    need(node.$ref.startsWith('#/'),'Offline native simulation schema requires local references.');
    let target=root;for(const part of node.$ref.slice(2).split('/'))target=target?.[part.replaceAll('~1','/').replaceAll('~0','~')];
    if(target?.properties?.kind?.const==='explicit'||target?.properties?.kind?.enum?.includes('explicit'))return clone(node);
    return explicitSchema(target,root,seen);
  }
  if(node.properties?.kind?.const==='explicit'||node.properties?.kind?.enum?.includes('explicit'))return clone(node);
  for(const key of ['anyOf','oneOf'])for(const child of node[key]??[]){const found=explicitSchema(child,root,seen);if(found)return found;}
  return null;
}

/** An ordinary JSON report, old qualification or injected callback cannot mint
 * this capability. The exact selected decisionProvider is part of its identity. */
export function hasModelToolQualificationReceipt(provider,result){
  const selected=provider?.decisionProvider??provider;
  return object(result)&&object(selected)&&result.qualified===true&&receipts.has(result)&&receipts.get(result)===selected;
}

function savedRequests(requests){
  need(Array.isArray(requests)&&requests.length>=3&&requests.length<=8,'Supply three to eight complete saved model-tool requests.');
  const prepared=requests.map((request,index)=>{
    need(object(request)&&object(request.context)&&object(request.state)&&object(request.identity),'Complete saved native source, context and identity are required.');
    const context=clone(request.context),state=clone(request.state.result??request.state),identity=clone(request.identity);
    need(typeof context.input==='string'&&Buffer.byteLength(context.input)<=MAX_CONTEXT_BYTES&&typeof context.instructions==='string'&&object(context.schema)&&context.promptMetadata?.decisionMode==='model-tools','Current prepared model-tool context required.');
    verifyModelToolContextPolicy(context);
    const payload=restoreContextPayload(JSON.parse(context.input));
    verifyMatchupGuidance(payload.matchupSkill,ISOLATED_POLICY_SOURCE);
    need(payload.guidance?.version===ISOLATED_POLICY_SOURCE.skillVersion&&payload.guidance.sha256===ISOLATED_POLICY_SOURCE.skillSha256,'Saved context does not declare the current complete skill.');
    need(!['automaticThreatScreen','tacticalEvidence','hostRouteConstraints','firstChoiceScope','hostResearchCard','hostResearchRequirement','hypothesisPreset','atomicResearchContracts','atomicResearchContract'].some(key=>Object.hasOwn(payload,key)),'Direct model qualification cannot use host tactical screening or a supplied research proposal.');
    const binding=context.binding,action=request.action??state.actions?.find(row=>row.room===binding?.room&&row.rqid===binding?.rqid);
    need(object(binding)&&object(action)&&HASH.test(identity.teamId??'')&&state.teamSha256===identity.teamId&&state.sessionId===identity.sessionId&&binding.teamId===identity.teamId&&binding.sessionId===identity.sessionId,'Saved source/team/session identities differ.');
    need(Array.isArray(state.actions)&&state.actions.length===1&&same(state.actions[0],action)&&object(action.legalActions)&&['preview','turn','switch'].includes(action.kind),'Exactly one complete original native request is required; menus cannot reconstruct it.');
    need(action.room===binding.room&&action.rqid===binding.rqid&&action.token===binding.token&&action.parentId===binding.parentId&&(!request.parentId||request.parentId===binding.parentId),'Saved request binding differs from its context.');
    const board=state.boards?.find(board=>board.room===action.room);
    need(board&&payload.kind===(action.kind==='switch'?'replacement':action.kind),'Saved request kind or native board is absent.');
    need(binding.boardHash===boardDigest(board,action.legalActions)&&binding.legalHash===digest(action.legalActions)&&binding.kind===action.kind&&binding.revision===action.revision,'Saved native board or legality changed after model-context preparation.');
    const {requestDigest:declared,...sourceBinding}=binding;
    need(declared===requestDigest(sourceBinding),'Saved model-context request digest differs from its native binding.');
    need(typeof request.materialRequired==='boolean'&&(!request.materialRequired||action.kind==='turn'),'Explicit material-case metadata is required.');
    return {context,state,identity,action:clone(action),parentId:binding.parentId,materialRequired:request.materialRequired,
      caseId:typeof request.caseId==='string'?request.caseId.slice(0,100):`saved-${index+1}`,sourceSha256:hash({state,action}),
      provenance:clone(request.provenance??{kind:'caller-audited-frozen-native-source',independentArchiveValidation:false}),
      workspace:request.workspace,ownTeamText:request.ownTeamText,opponentSheet:clone(request.opponentSheet??payload.opponentSheet),
      nativeStart:clone(request.nativeStart),nativeEvidence:clone(request.nativeEvidence)};
  });
  const first=prepared[0],second=prepared[1],last=prepared.at(-1);
  need(prepared.every(row=>row.identity.teamId===first.identity.teamId&&row.identity.sessionId===first.identity.sessionId&&row.parentId===first.parentId),'Qualification must use one exact saved BO3/team/client scope.');
  need(first.action.kind==='preview'&&second.action.kind==='turn'&&second.action.room===first.action.room&&last.action.room!==first.action.room,'Require preview, a same-game turn, and a fresh sibling game.');
  need(prepared.some(row=>row.materialRequired),'At least one actual saved material turn must require model-selected numerical work.');
  return prepared;
}

function sourceMetadata(row){return {caseId:row.caseId,kind:row.action.kind,teamId:row.identity.teamId,parentId:row.parentId,gameId:row.action.room,sourceSha256:row.sourceSha256,
  requestDigest:row.context.binding.requestDigest,skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,materialRequired:row.materialRequired};}

/** Use the normal operator owner/source/deadline/reservation checks. Only its
 * battle status/control endpoints and final action recorder are local fixtures;
 * allowed research goes to the separately owned actual numerical SDK process. */
async function localOperator(row,{client,actualSdk,deadlineAt,startedAt,now,nativeJournal,allowExplicitOffline}){
  const lease=`offline-model-tools-${randomUUID()}`,owner=`offline-model-tools-${randomUUID()}`,controller={required:true,owner,generation:1};
  let recorded=null,sequence=0;const nativeCatalog=new Map(),modelCallScope=new AsyncLocalStorage();
  const id=label=>`qual_${label}_${++sequence}`;
  const snapshot=()=>({...clone(row.state),sessionId:row.identity.sessionId,teamSha256:row.identity.teamId,username:row.identity.account,
    connected:true,authenticated:true,stopped:false,controller,autoReady:false,searchesSent:0,maxSearches:0,
    searchPending:false,awaitingSet:false,switchingTeam:false,search:{searching:[],games:{}},
    actions:recorded?[]:[{...clone(row.action),receivedAt:startedAt}],rooms:[{id:row.action.room,parentId:row.parentId,ended:recorded!==null}],
    controlPolicy:{enabled:true,halted:false,pending:recorded?[]:[{room:row.action.room,rqid:row.action.rqid,token:row.action.token,cutoffAt:deadlineAt+RESERVE_MS,hasFallback:false,attempted:false}]},
    timing:{requests:recorded?[]:[{room:row.action.room,rqid:row.action.rqid,token:row.action.token,receivedAt:startedAt,cutoffAt:deadlineAt+RESERVE_MS}]},
    offlineModelToolQualification:{historicalFacts:true,clock:'fresh-local-offline',serverAcceptance:false,executionObserved:false}});
  const reply=result=>({structuredContent:{ok:true,result}});
  const forward=async(request,schema,options)=>{
    const {name,arguments:args={}}=request;
    need(MODEL_TOOL_NAMES.includes(name),'Offline qualification forbids battle/search/authentication tools.');
    need(now()<deadlineAt&&!options?.signal?.aborted,'Original offline research deadline elapsed.');
    if(name==='simulate_choices'){
      if(!row.compactAdapter)return {isError:true,content:[{type:'text',text:'Saved compact simulation requires a verified genuine start prefix and exact private projection. No live descriptor, missing history or copied model state was used.'}]};
      const result=await row.compactAdapter.execute({name,args,signal:options?.signal,deadlineAt,callNative:forward});
      if(hasCompactModelToolQualificationBudgetStatus(row.compactAdapter,result))return {isError:true,structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      need(hasCompactModelToolQualificationReceipt(row.compactAdapter,result),'Compact simulation lacks its maintained source-to-native proof.');
      const receipt=row.compactAdapter.receipt(result);need(receipt.authoredInputSha256===digest(args),'Compact proof differs from the exact authored tool input.');
      row.compactReceipts.push({...clone(receipt),modelToolCommandId:modelCallScope.getStore()?.commandId});return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
    }
    // Observed simulation needs the maintained frozen observed-to-explicit
    // adapter. Never point an archived source at a current battle descriptor.
    if(['simulate_turn','battle_check_plan'].includes(name)&&args.request?.kind!=='explicit'){
      if(!row.observedAdapter)return {isError:true,content:[{type:'text',text:'Saved observed simulation requires an audited offline reconstruction adapter; no current descriptor or guessed state was used.'}]};
      const result=await row.observedAdapter.execute({name,args,signal:options?.signal,deadlineAt,callNative:forward});
      need(hasModelToolObservedQualificationReceipt(row.observedAdapter,result),'Observed simulation has no maintained translation proof.');
      const receipt=row.observedAdapter.receipt(result);
      need(receipt.authoredInputSha256===digest(args),'Observed proof differs from this exact model-tool input.');
      row.observedReceipts.push({...clone(receipt),modelToolCommandId:modelCallScope.getStore()?.commandId});
      return result;
    }
    const entry={name,origin:modelCallScope.getStore()?.modelToolName==='simulate_choices'?'model-requested-compact-native-work':'model-requested',sourceSha256:row.sourceSha256,modelToolCommandId:modelCallScope.getStore()?.commandId,
      argumentsSha256:hash(args),input:clone(args),startedAt:now(),outcome:'pending'};nativeJournal.push(entry);
    try{
      const result=await client.callTool(request,schema,options);
      entry.finishedAt=now();entry.resultSha256=hash(result);entry.result=clone(result);entry.outcome=success(result)?'completed':'returned-error';
      entry.nativeSdkReceipt=actualSdk;entry.transport=actualSdk?'qualification-owned-sdk-stdio':'injected-client';
      if(actualSdk&&object(result))nativeReplies.add(result);
      need(now()<deadlineAt&&!options?.signal?.aborted,'Native result missed the original offline deadline.');
      entry.timely=true;if(actualSdk&&nativeReplies.has(result))nativeRecords.add(entry);
      const value=result.structuredContent??unwrap(result);
      entry.pairedSimulation=name==='simulate_turn'&&args.request?.kind==='explicit'&&value?.engine?.gen===0&&value?.source?.kind==='explicit-offline-snapshot'&&value.source.liveFreshness===false&&Array.isArray(value.samples)&&value.samples.length>0;
      need(Buffer.byteLength(JSON.stringify(nativeJournal))<=8*1024*1024,'Complete native qualification evidence exceeds its bound.');
      return result;
    }catch(error){entry.finishedAt=now();entry.outcome='failed';entry.code=typeof error?.code==='string'?error.code.slice(0,100):'NATIVE_TOOL_FAILED';throw error;}
  };
  const localClient={listTools:async(...args)=>{const listed=await client.listTools(...args);for(const tool of listed.tools??[])nativeCatalog.set(tool.name,clone(tool));return listed;},callTool:async(request,schema,options)=>{
    const {name}=request;
    if(['battle_status','battle_turn_status','battle_wait','battle_capabilities'].includes(name))return reply(snapshot());
    if(name==='battle_control_claim')return reply({controllerLease:lease,controller});
    if(name==='battle_control_release')return reply({released:true});
    return forward(request,schema,options);
  }};
  const forbidden=async()=>{throw new Error('Offline qualification has no search or next-battle endpoint');};
  const operator=createOperator({client:localClient,responseFile:'unused-model-tool-qualification.json',maxSearches:0,now,readTimeoutMs:30000,
    publish:async()=>{},actionHelpers:{startNext:forbidden,waitForNext:forbidden,playNext:async({q})=>{
      need(recorded===null&&now()<deadlineAt,'Local final choice is already recorded or late.');
      need(q.room===row.action.room&&q.rqid===row.action.rqid&&q.token===row.action.token,'Local final choice source differs.');
      recorded={actions:validateChoice({...row.action.legalActions,side:{pokemon:row.action.legalActions.pokemon}},q.actions).actions,at:now(),serverAcceptance:false,executionObserved:false};
      return {offlineChoiceRecorded:true,status:'offline-choice-recorded',serverAcceptance:false,executionObserved:false};
    }}});
  const dispatch=async query=>{const value=await operator.dispatch(query);need(success(value),'Offline model operator setup failed.');return unwrap(value);};
  try{
    await dispatch({id:id('arm'),op:'arm',confirmed:true,expectedSessionId:row.identity.sessionId,expectedTeamId:row.identity.teamId,expectedAccount:row.identity.account});
    await dispatch({id:id('claim'),op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:id('claim_native'),controllerId:owner}});
    await dispatch({id:id('policy'),op:'decision-policy',enabled:true,commitBufferMs:RESERVE_MS});
    await dispatch({id:id('mode'),op:'model-tool-mode',enabled:true});
    const catalog=await dispatch({id:id('catalog'),op:'model-tool-catalog'});
    // Offline explicit scenarios are an additional disclosed capability. Keep
    // the normal observed projection and every native definition; no scenario
    // inputs, hypotheses, pairs, seeds or gates are authored by this adapter.
    const simulation=catalog.tools.find(tool=>tool.name==='simulate_turn'),nativeSimulation=nativeCatalog.get('simulate_turn');
    if(allowExplicitOffline&&simulation&&nativeSimulation){
      const explicit=explicitSchema(nativeSimulation.inputSchema.properties?.request,nativeSimulation.inputSchema);
      if(explicit){simulation.inputSchema.properties.request={anyOf:[simulation.inputSchema.properties.request,explicit]};simulation.description+=' Offline qualification also permits a complete explicitly hypothetical native scenario, separate from saved observed reconstruction.';}
    }
    const explicitIds=new Set();
    // Explicit hypothetical scenarios are a separate offline capability. They
    // do not weaken the production observed-source binder or supply any state,
    // hypotheses, opposing action, seed, gate or candidate on the model's behalf.
    const executeLocal=async(q,options)=>{
      if(q.op!=='model-tool'||q.name!=='simulate_turn'||q.args?.request?.kind!=='explicit')return operator.dispatch(q,options);
      need(allowExplicitOffline,'The qualified observed route does not advertise explicit hypothetical simulation.');
      need(catalog.tools.some(tool=>tool.name==='simulate_turn')&&!explicitIds.has(q.id)&&recorded===null&&now()<deadlineAt&&!options?.signal?.aborted,'Explicit offline simulation source, catalog or deadline is unavailable.');
      need(q.room===row.action.room&&q.rqid===row.action.rqid&&q.token===row.action.token&&q.deadlineAt===deadlineAt,'Explicit offline simulation changed its frozen request binding.');
      const args=clone(q.args);
      need(!Object.hasOwn(args,'evidenceContext')&&!Object.hasOwn(args.request,'source'),'The model cannot supply private offline source/evidence fields.');
      explicitIds.add(q.id);
      const result=await forward({name:'simulate_turn',arguments:args},undefined,{signal:options?.signal,timeout:Math.max(1,deadlineAt-now())});
      return {result:{kind:'model-tool-result',name:'simulate_turn',result,scope:'model-authored-explicit-offline-simulation',serverAcceptance:false}};
    };
    const offlineOperator={dispatch:(q,options)=>modelCallScope.run(q.op==='model-tool'?{commandId:q.id,modelToolName:q.name}:null,()=>executeLocal(q,options))};
    return {operator:offlineOperator,catalog,id,recorded:()=>clone(recorded),close:()=>operator.dispatch({id:id('close'),op:'close'})};
  }catch(error){await operator.dispatch({id:id('close_failed'),op:'close'}).catch(()=>{});throw error;}
}

// Manager-only saved-case behavioral validation uses this same source/legality
// relay and local final recorder. This grants no generation receipt, live
// controller, search capability or provider qualification.
export {localOperator as createOfflineModelToolOperator};

function generationMatches(response,provider,row,deadlineAt){
  const t=response?.telemetry,selected=provider.decisionProvider;
  return hasCodexCliGenerationReceipt(selected,response)&&t?.telemetrySource==='codex-cli-session'&&t.authenticationMethod==='chatgpt'&&t.contextMode==='session'&&
    t.sessionTurnCompleted===true&&t.sessionProcessOwned===true&&t.sessionSourceRehydrated===true&&Number.isSafeInteger(t.sessionTurnIndex)&&
    Number.isFinite(t.completedAt)&&Number.isFinite(t.finalReceivedAt)&&t.completedAt<=t.finalReceivedAt&&t.finalReceivedAt<deadlineAt&&
    t.nativeInputSha256===hash(row.context.input)&&t.nativeSchemaSha256===hash(row.context.schema)&&t.nativeInstructionsSha256===hash(row.context.instructions)&&t.modelToolsEnabled===true&&
    HASH.test(t.sessionThreadSha256??'')&&t.sessionScopeSha256===codexSessionScopeHash({sessionId:row.identity.sessionId,teamId:row.identity.teamId,parentId:row.parentId,gameId:row.action.room.replace(/-[a-z0-9]+pw$/u,'')});
}

export async function qualifyModelTools({provider,requests,nativeClient,connect=connectOfflineNumericClient,now=Date.now,workspace=process.cwd(),onEvent=()=>{}}={}){
  const selected=provider?.decisionProvider;
  need(provider?.contextMode==='session'&&selected?.kind==='codex-cli'&&typeof selected.callDecision==='function'&&typeof provider.preflight==='function'&&typeof provider.reset==='function','Explicit retained-session Codex provider required.');
  const base={qualified:false,requestedModel:selected.model,providerKind:'codex-cli',authenticationMethod:null,reasoningEffort:selected.reasoningEffort,
    contextMode:'session',decisionMode:'model-tools',modelToolWorkflowQualified:false,modelRequestedMcpQualified:false,sessionContinuityQualified:false,
    savedPositionQualified:false,pairedSimulationQualified:false,liveObservedSimulationQualified:false,compactChoiceSimulationQualified:false,rangeWorkflowQualified:false,
    generationObserved:false,modelDetectedResearchQualified:false,battlesStarted:0,battleAuthenticationCalls:0,apiCalls:0,automaticNumericalCalls:0,
    limits:'Offline direct-tool delivery, actual model-authored research and locally recorded legal choices only. The material compact and advertised damage-range endpoint probes are host-required technical coverage, not model-detected research. Partial range envelopes remain limited to evaluated witnesses. No live acceptance, execution, opponent intent, tactical-success or sustained-latency guarantee. Saved native facts and genuine history are verified; missing observations are not guessed.'};
  if(requests===undefined)return freeze({...base,reason:'saved-model-tool-requests-required'});
  verifyIsolatedPolicySource();
  const prepared=savedRequests(requests);base.teamId=prepared[0].identity.teamId;
  const actualSdk=nativeClient===undefined&&connect===connectOfflineNumericClient&&now===Date.now;
  const rows=[],nativeJournal=[],offlineResearchCases=[];let connection,client=nativeClient,closed=false,providerReset=false,compactCatalogAdvertised=false,rangeCatalogAdvertised=false;
  const emit=event=>{try{onEvent(clone(event));}catch{/* Observation cannot alter a decision or deadline. */}};
  await provider.reset();
  try{
    const auth=await provider.preflight();need(auth?.authMode==='chatgpt'&&(auth.contextMode??'session')==='session','Actual selected subscription session transport required.');
    if(!client){connection=await connect({qualificationOnly:true});client=connection?.client;}
    if(actualSdk)need(connection?.qualificationAuthority?.mode==='child-local-saved-research'&&typeof connection.registerQualificationCase==='function','Actual qualification requires its isolated saved-source research authority.');
    need(client&&typeof client.callTool==='function'&&typeof client.listTools==='function','Owned native MCP connection required.');
    // Archive/readiness checks are preparation before each original fresh local
    // clock. A failed check leaves observed simulation unavailable.
    for(const row of prepared){
      row.observedReceipts=[];row.compactReceipts=[];
      try{row.observedAdapter=await createModelToolObservedQualificationAdapter({workspace:row.workspace??workspace,state:row.state,ownTeamText:row.ownTeamText,
        opponentSheet:row.opponentSheet,provenance:row.provenance,nativeStart:row.nativeStart,nativeEvidence:row.nativeEvidence,now});}
      catch(error){row.observedPreparationError=typeof error?.code==='string'?error.code:'OBSERVED_QUALIFICATION_SOURCE_UNAVAILABLE';}
      try{row.compactAdapter=await createCompactModelToolQualificationAdapter({workspace:row.workspace??workspace,state:row.state,ownTeamText:row.ownTeamText,opponentSheet:row.opponentSheet,provenance:row.provenance,now});}
      catch(error){row.compactPreparationError=typeof error?.code==='string'?error.code:'COMPACT_QUALIFICATION_SOURCE_UNAVAILABLE';}
    }
    const allowExplicitOffline=!prepared.some(row=>row.observedAdapter);
    for(const row of prepared){
      const startedAt=now(),deadlineAt=startedAt+CLOCK_MS,controller=new AbortController();let timer,local,response,modelRequest;
      row.qualificationDeadlineAt=deadlineAt;
      const record={...sourceMetadata(row),startedAt,deadlineAt,clock:'fresh-local-offline-40s',originalArchivedDeadline:row.context.promptMetadata?.deadlineAt??null,
        observedPreparation:{available:!!row.observedAdapter,...(row.observedPreparationError?{code:row.observedPreparationError}:{})},
        compactPreparation:{available:!!row.compactAdapter,...(row.compactPreparationError?{code:row.compactPreparationError}:{})},qualified:false};
      rows.push(record);
      emit({type:'case-start',caseId:row.caseId,kind:row.action.kind,startedAt,deadlineAt});
      timer=setTimeout(()=>controller.abort(),CLOCK_MS);
      try{
        if(connection?.registerQualificationCase){
          const binding=row.context.binding,source=Object.fromEntries(['sessionId','teamId','room','rqid','token'].map(key=>[key,binding[key]]));
          const registration=await connection.registerQualificationCase({caseId:randomUUID(),contexts:[{source,analysis:'current'}],turn:row.state.boards.find(board=>board.room===row.action.room).turn,
            kind:row.action.kind,sourceSha256:row.sourceSha256,factsSha256:digest({boardHash:binding.boardHash,legalHash:binding.legalHash}),deadlineAt});
          offlineResearchCases.push(clone(registration));record.offlineResearchCase=clone(registration);
        }
        local=await localOperator(row,{client,actualSdk,deadlineAt,startedAt,now,nativeJournal,allowExplicitOffline});
        compactCatalogAdvertised||=local.catalog.tools.some(tool=>tool.name==='simulate_choices');
        rangeCatalogAdvertised||=local.catalog.tools.some(tool=>tool.name==='calculate_damage_range');
        const compactProbe=row.materialRequired&&local.catalog.tools.some(tool=>tool.name==='simulate_choices');
        const rangeProbe=row.materialRequired&&local.catalog.tools.some(tool=>tool.name==='calculate_damage_range');
        const context={...row.context,instructions:row.context.instructions+'\n\nOFFLINE MODEL-TOOL QUALIFICATION: This is the supplied frozen historical position under one fresh local40-second window, not a live battle. Tools return actual native results. The final legal choice is recorded locally only. '+(compactProbe?'HOST-REQUIRED TECHNICAL ENDPOINT COVERAGE: Exercise simulate_choices in this material case and obtain a complete returned branch/world response. An unavailable or partial call is retained but does not satisfy endpoint coverage. If its reply identifies a schema or clickable-menu error, correct only that literal input against supplied facts while the original clock permits. A complete negative outcome still qualifies as technical coverage; invent no successful result. Independently choose a meaningful tactical question and author both own and opposing complete paired choices; inspect the actual returned assumptions and sampled outcomes before your final pair. Choose any additional numerical research yourself. No tactical candidate, action, opponent branch or expected outcome is supplied. This endpoint requirement is a qualification probe and does not establish model-detected research.':row.materialRequired?'This marked material case exercises numerical research: independently choose a meaningful tool, question and complete inputs, inspect its actual return, then choose your final pair. No tactical candidate, inputs or expected answer are supplied.':'Choose from the complete current source; research remains your decision.')+
          (rangeProbe?' HOST-REQUIRED TECHNICAL RANGE ENDPOINT COVERAGE: Also exercise calculate_damage_range with explicit gen:0 in this same original window. Independently choose a material damage question and author its complete species, move, conditions, labeled spread/HP domains and work bounds. Inspect the actual returned range, witnesses, coverage and limitations before your final pair. No tactical input, spread, HP assumption, expected answer or conclusion is supplied. A partial envelope describes evaluated witnesses only. This technical endpoint requirement is host-marked and does not establish model-detected research or replace the paired simulation requirement.':'')};
        const result=await runModelToolCycle({context,state:row.state,action:row.action,parentId:row.parentId,identity:row.identity,operator:local.operator,catalog:local.catalog,
          now,deadlineAt,signal:controller.signal,id:local.id,
          emit:(type,fields)=>emit({type,caseId:row.caseId,kind:row.action.kind,elapsedMs:now()-startedAt,...(fields.name?{tool:fields.name}:{})}),
          onEvidence:async evidence=>{
            if(evidence.decision)record.authoredDecision=clone(evidence.decision);
            if(evidence.validation)record.providerEvidence={phase:evidence.phase,validation:clone(evidence.validation),telemetry:clone(evidence.telemetry??{})};
          },
          callDecision:async request=>{
            modelRequest=request;
            try{response=await selected.callDecision(request);return response;}
            catch(error){record.providerFailure={code:typeof error?.code==='string'?error.code:'MODEL_PROVIDER_FAILED',telemetry:clone(error?.telemetry??{})};throw error;}
          }});
        record.finishedAt=now();record.result=result;record.localChoice=local.recorded();record.telemetry=clone(response?.telemetry??{});
        const inputMatches=modelRequest?.input===row.context.input&&same(modelRequest?.schema,row.context.schema);
        record.generationReceiptVerified=generationMatches(response,provider,{...row,context},deadlineAt)&&inputMatches;
        const requested=nativeJournal.filter(entry=>entry.sourceSha256===row.sourceSha256&&entry.startedAt>=startedAt);
        record.modelRequestedTools=requested.map(entry=>clone(entry));
        record.materialWorkCompleted=!row.materialRequired||requested.some(entry=>NUMERIC.has(entry.name)&&entry.outcome==='completed'&&nativeRecords.has(entry)&&entry.timely);
        record.qualified=record.generationReceiptVerified&&record.finishedAt<deadlineAt&&result.status==='submitted'&&record.localChoice?.at<deadlineAt&&record.materialWorkCompleted;
      }catch(error){record.finishedAt=now();record.error={code:typeof error?.code==='string'?error.code:'MODEL_TOOL_QUALIFICATION_FAILED'};}
      finally{clearTimeout(timer);controller.abort();if(local)await local.close();emit({type:'case-complete',caseId:row.caseId,kind:row.action.kind,elapsedMs:now()-startedAt,qualified:record.qualified,status:record.result?.status??record.error?.code??'unavailable'});}
      if(!record.qualified&&actualSdk)break;
    }
  }finally{
    try{if(connection){await connection.close();closed=true;}else closed=false;}
    finally{await provider.reset();providerReset=true;}
  }
  const first=rows[0],second=rows[1],last=rows.at(-1),firstThread=first?.telemetry?.sessionThreadSha256;
  const continuity=rows.length===prepared.length&&first?.kind==='preview'&&second?.kind==='turn'&&first.gameId===second.gameId&&
    first.telemetry?.sessionTurnIndex===1&&second.telemetry?.sessionTurnIndex===2&&firstThread===second.telemetry.sessionThreadSha256&&
    first.telemetry.sessionContextMetadata?.staticSent?.includes('matchupSkill')&&second.telemetry.sessionContextMetadata?.staticRefs?.includes('matchupSkill')&&
    last.gameId!==first.gameId&&last.telemetry.sessionTurnIndex===1&&last.telemetry.sessionThreadSha256!==firstThread&&
    last.telemetry.sessionContextMetadata?.staticSent?.includes('matchupSkill')&&!last.telemetry.sessionContextMetadata?.staticRefs?.includes('matchupSkill');
  const mcp=nativeJournal.some(entry=>NUMERIC.has(entry.name)&&entry.outcome==='completed'&&nativeRecords.has(entry)&&entry.timely);
  const paired=nativeJournal.some(entry=>entry.pairedSimulation&&entry.outcome==='completed'&&nativeRecords.has(entry)&&entry.timely);
  const technical=actualSdk&&closed&&providerReset&&continuity&&mcp&&rows.every(row=>row.qualified);
  const joinedObserved=prepared.flatMap(row=>row.materialRequired?row.observedReceipts.filter(receipt=>
    receipt.name==='simulate_turn'&&receipt.provenanceVerified===true&&receipt.readinessVerified===true&&receipt.frozenSourceSha256===digest(row.state)&&receipt.deadlineAt===row.qualificationDeadlineAt&&
    typeof receipt.modelToolCommandId==='string'&&nativeJournal.some(entry=>nativeRecords.has(entry)&&entry.outcome==='completed'&&entry.timely&&
      entry.name===receipt.name&&entry.sourceSha256===row.sourceSha256&&entry.modelToolCommandId===receipt.modelToolCommandId&&
      digest(entry.input)===receipt.nativeInputSha256&&digest(entry.result)===receipt.nativeResultSha256&&
      entry.startedAt>=receipt.startedAt&&entry.finishedAt<=receipt.settledAt&&entry.finishedAt<receipt.deadlineAt)
  ).map(receipt=>({caseId:row.caseId,...receipt})):[]);
  const joinedCompact=prepared.flatMap(row=>row.materialRequired?row.compactReceipts.filter(receipt=>
    receipt.name==='simulate_choices'&&receipt.sourceProvenanceVerified===true&&receipt.readinessVerified===true&&receipt.frozenSourceSha256===digest(row.state)&&receipt.deadlineAt===row.qualificationDeadlineAt&&
    receipt.version===2&&receipt.researchPolicy==='single-outcome'&&typeof receipt.modelToolCommandId==='string'&&receipt.nativeCalls?.filter(call=>call.name==='simulate_turn').length===1&&receipt.nativeCalls.every(call=>nativeJournal.some(entry=>nativeRecords.has(entry)&&entry.outcome==='completed'&&entry.timely&&
      entry.name===call.name&&entry.sourceSha256===row.sourceSha256&&entry.modelToolCommandId===receipt.modelToolCommandId&&digest(entry.input)===call.inputSha256&&digest(entry.result)===call.resultSha256&&
      entry.startedAt>=receipt.startedAt&&entry.startedAt>=call.startedAt&&entry.finishedAt<=call.settledAt&&entry.finishedAt<=receipt.settledAt&&entry.finishedAt<receipt.deadlineAt))
  ).map(receipt=>({caseId:row.caseId,...receipt})):[]);
  const rangeChecks=rangeQualificationChecks(prepared,rows,nativeJournal),joinedRange=rangeChecks.filter(receipt=>receipt.joined);
  const sourceProof=compactCatalogAdvertised?joinedCompact.length>0:joinedObserved.length>0;
  const liveObserved=technical&&sourceProof;
  const compactChoiceSimulationQualified=technical&&paired&&joinedCompact.length>0;
  const rangeWorkflowQualified=technical&&paired&&liveObserved&&(!compactCatalogAdvertised||compactChoiceSimulationQualified)&&rangeCatalogAdvertised&&joinedRange.length>0;
  const qualified=technical&&paired&&liveObserved&&(!compactCatalogAdvertised||compactChoiceSimulationQualified)&&(!rangeCatalogAdvertised||rangeWorkflowQualified);
  const result={...base,qualified,authenticationMethod:rows.some(row=>row.generationReceiptVerified)?'chatgpt':null,generationObserved:rows.length>0&&rows.every(row=>row.generationReceiptVerified),
    modelToolWorkflowQualified:qualified,modelRequestedMcpQualified:technical&&mcp,sessionContinuityQualified:technical&&continuity,sessionLiveQualified:qualified,
    technicalModelToolQualified:technical,pairedSimulationQualified:technical&&paired,liveObservedSimulationQualified:liveObserved,
    savedPositionQualified:technical&&sourceProof,observedQualificationReceipts:prepared.flatMap(row=>row.observedReceipts.map(receipt=>({caseId:row.caseId,...receipt}))),joinedObservedQualificationReceipts:joinedObserved,
    compactCatalogAdvertised,compactChoiceSimulationQualified,compactQualificationReceipts:prepared.flatMap(row=>row.compactReceipts.map(receipt=>({caseId:row.caseId,...receipt}))),joinedCompactQualificationReceipts:joinedCompact,
    rangeCatalogAdvertised,rangeWorkflowQualified,rangeQualificationChecks:rangeChecks,joinedRangeQualificationReceipts:joinedRange,
    freshGameQualified:technical&&continuity,currentMatchupGuidanceVerified:true,skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,
    rows,nativeJournal,closed,providerReset,actualSdkConnection:actualSdk,offlineResearchAuthority:connection?.qualificationAuthority?clone(connection.qualificationAuthority):null,offlineResearchCases,liveQuotaExercised:false,provenance:'manager-supplied-complete-frozen-native-requests',
    reason:qualified?null:'actual-model-tool-workflow-evidence-incomplete',modelCalls:rows.length,completedActualMcpCalls:nativeJournal.filter(entry=>entry.nativeSdkReceipt&&entry.outcome==='completed').map(entry=>entry.name),
    simulationQualification:compactCatalogAdvertised?'The single-outcome compact material probe requires one model-authored own/opposing pair through the maintained facade, verified saved native source and genuine history, with its one native trajectory input/result joined to the actual owned SDK and the same model command. Historical evidence grants no current choice authority or live budget reservation.':'Complete model-authored explicit hypothetical simulations establish that paired tool capability only. Full workflow admission additionally requires a branded audited saved-observed reconstruction joined to the same actual owned SDK input/result and material request; no current battle descriptor or guessed state is used.'};
  if(qualified)receipts.set(result,selected);
  return freeze(result);
}
