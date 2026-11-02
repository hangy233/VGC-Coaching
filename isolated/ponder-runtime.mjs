// Native wait observations and an exclusively owned shadow CLI provider.
// No search, readiness, action, roster or authentication mutation is exposed.
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {digest} from '../planning/identity.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {MODEL_TOOL_NAMES,modelToolDefinition} from '../showdown/model-owned-tools.mjs';
import {sanitizeResponse} from '../showdown/operator-response.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {createCodexCliDecisionProvider,hasCodexCliGenerationReceipt} from './codex-cli-provider.mjs';
import {createPonderController,PONDER_PROFILE} from './ponder-controller.mjs';
import {isPonderErrorCode} from './ponder-evidence.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value),bytes=value=>Buffer.byteLength(JSON.stringify(value));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const need=(condition,code,message)=>{if(!condition)fail(code,message);};
const canonical=value=>typeof value==='string'?value.replace(/^(\S+-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*)-[a-z0-9]+pw$/u,'$1'):value;
const sameRoom=(a,b)=>typeof a==='string'&&typeof b==='string'&&canonical(a)===canonical(b);
const privateFields=['source','analysis','freezeId','evidenceContext','researchContext','controllerLease','readReceipt','authorization','password','token','sessionId','teamId'];
const staticTools=new Set(['get_pokemon','get_move','get_ability','get_movepool']),numericTools=new Set(['calculate_damage','calculate_damage_range','calculate_speed']);
const compactName='simulate_choices';
const MAX_PUBLIC_NOTES_BYTES=96*1024,MAX_PRIVATE_JOURNAL_BYTES=16*1024*1024;
function factsFrom(context){
  need(object(context?.binding)&&typeof context.input==='string','PONDER_CONTEXT','Complete logical decision context required');
  const payload=restoreContextPayload(JSON.parse(context.input));
  need(object(payload)&&object(payload.matchupSkill),'PONDER_CONTEXT','Complete matchup guidance required');
  const facts=clone(Object.fromEntries(Object.entries(payload).filter(([key])=>!['matchupSkill','ponderNotes','decisionClock'].includes(key))));
  return {facts,skill:payload.matchupSkill};
}
function identity(binding,sha){return {sessionId:binding.sessionId,teamId:binding.teamId,parentId:canonical(binding.parentId),gameId:canonical(binding.room),sourceSha256:sha};}
function exactFreeze(marker,binding){
  const source=marker?.source;
  return typeof marker?.freezeId==='string'&&/^[a-f0-9-]{36}$/iu.test(marker.freezeId)&&Number.isFinite(marker.frozenAt)&&marker.choiceAuthority===false&&
    object(source)&&source.sessionId===binding.sessionId&&source.teamId===binding.teamId&&source.room===binding.room&&source.rqid===binding.rqid&&source.token===binding.token;
}
function choicesIn(state){
  if(Array.isArray(state.choices))return state.choices;
  return (state.rooms??[]).filter(room=>object(room.choice)).map(room=>({room:room.id,...room.choice}));
}
function ownedSearchWait(state,binding){
  const search=state.search;
  if(search!==undefined&&(!object(search)||!Array.isArray(search.searching)||search.searching.length))return false;
  if(state.searchPending!==undefined&&typeof state.searchPending!=='boolean')return false;
  const games=search?.games;
  if(games!==undefined&&games!==null&&!object(games))return false;
  const ids=object(games)?Object.keys(games):[];
  if(!ids.length)return state.searchPending!==true;
  // updatesearch retains searchPending throughout a live BO3. Only the exact
  // cached parent/child reservation is an opponent wait, never another queue.
  return ids.length<=2&&new Set(ids.map(canonical)).size===ids.length&&ids.every(id=>sameRoom(id,binding.room)||sameRoom(id,binding.parentId));
}

/**
 * prepare() lists native tools and preflights one dedicated shadow CLI owner
 * before search. It performs no generation. Every later lease uses that checked
 * owner, waits for its own previous close only in background, and starts a fresh
 * thread after cancellation. Observer/hooks are synchronous and never await I/O.
 */
export function createBattlePonderRuntime({workspace,profile=PONDER_PROFILE,mainDecisionProvider,nativeClient,onEvent=()=>{},limits,
  providerFactory=createCodexCliDecisionProvider,toolDefinition=modelToolDefinition,now=Date.now,schedule=setImmediate,cancelSchedule=clearImmediate}={}){
  need(typeof workspace==='string'&&object(nativeClient)&&typeof nativeClient.listTools==='function'&&typeof nativeClient.callTool==='function','PONDER_CONFIGURATION','Workspace and existing native SDK client required');
  need((profile.provider??profile.kind)==='codex-cli'&&profile.model==='gpt-6.1-sol'&&profile.reasoningEffort==='low'&&profile.serviceTier==='fast'&&profile.contextMode==='session','PONDER_PROFILE','Pondering requires the selected Sol/Low/Fast CLI session profile');
  let prepared=false,preparation,blocked=null,closed=false,mainBusy=false,cached=null,lastState=null,scheduled=null,shadow=null,proof=null,preflightPending=false,shadowClosing=Promise.resolve(),lastModel=Promise.resolve(),modelPending=false,closingPending=false,ownerIdleClosed=true,lease=0;
  const frozen=new Map(),journal=[],privateJournal=[];let journalBytes=0,privateJournalBytes=0,privateJournalDropped=0,nativeCallsPending=0;const privateValues=new Set();
  const emit=(name,fields={})=>{try{onEvent({...fields,name,at:now()});}catch{/* Optional diagnostics cannot stop battle control. */}};
  const cancelLaunch=()=>{if(scheduled!==null){cancelSchedule(scheduled);scheduled=null;}};
  function closeShadow(reason){
    if(shadow===mainDecisionProvider||shadow?.decisionProvider===mainDecisionProvider)return Promise.resolve();
    if(!shadow||ownerIdleClosed||closingPending)return shadowClosing;
    ownerIdleClosed=true;closingPending=true;
    shadowClosing=Promise.resolve().then(()=>shadow.close()).then(()=>emit('ponder.runtime-shadow-closed',{reason}),cause=>{
      blocked='PONDER_SHADOW_CLOSE_UNCERTAIN';emit('ponder.runtime-blocked',{code:blocked,cause:cause?.code??'close-failed'});throw cause;
    }).finally(()=>{closingPending=false;});shadowClosing.catch(()=>{});return shadowClosing;
  }
  const core=createPonderController({now,onEvent,limits,mainDecisionProvider,
    prepareContext:async({snapshot})=>({instructions:'The source below is a frozen pre-submission position. alreadyCommittedActions are the model-authored pair already locally sent; local sent status alone proves no server acceptance. No fresh turn may be answered here.',
      input:JSON.stringify({matchupSkill:snapshot.skill,ponderFacts:snapshot.facts,alreadyCommittedActions:snapshot.committedActions,commitObservation:snapshot.commitObservation}),catalog:catalog}),
    createProvider:async({signal})=>{
      need(prepared&&!closed&&!blocked,'PONDER_UNAVAILABLE','Prepared shadow provider is unavailable');
      let onAbort;try{await Promise.race([Promise.all([shadowClosing,lastModel.catch(()=>{})]),new Promise((_,reject)=>{onAbort=()=>reject(Object.assign(new Error('Ponder preempted'),{code:'aborted'}));if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});})]);}finally{signal.removeEventListener('abort',onAbort);}
      need(!signal.aborted&&!closed&&!blocked,'PONDER_UNAVAILABLE','Shadow cleanup did not permit a new lease');
      const currentLease=++lease;ownerIdleClosed=false;let released=false;
      return {contextMode:'session',preflightResult:proof,decisionProvider:{kind:'codex-cli',model:profile.model,reasoningEffort:profile.reasoningEffort,callDecision:async request=>{
        need(!released&&currentLease===lease&&!closed&&!blocked,'PONDER_UNAVAILABLE','Shadow provider lease is no longer active');
        modelPending=true;lastModel=Promise.resolve().then(()=>shadow.decisionProvider.callDecision(request));lastModel.catch(()=>{});
        let response;try{response=await lastModel;}finally{modelPending=false;}
        emit('ponder.runtime-generation',{generationVerified:hasCodexCliGenerationReceipt(shadow.decisionProvider,response),lease:currentLease});return response;
      }},close:()=>{if(released)return shadowClosing;released=true;return closeShadow('lease-closed');}};
    },
    executeReadOnly:async({name,arguments:authored,source,facts,signal,deadlineAt})=>{
      const bound=frozen.get(source.sourceSha256);
      need(bound&&bound.factsSha256===digest(facts)&&sameRoom(source.gameId,bound.nativeSource.room)&&source.sessionId===bound.nativeSource.sessionId&&source.teamId===bound.nativeSource.teamId,'PONDER_SOURCE','Frozen research source differs');
      need(prepared&&!closed&&!blocked&&!signal.aborted&&now()<deadlineAt,'PONDER_DEADLINE','Frozen research is canceled or late');
      need(catalog.some(tool=>tool.name===name)&&object(authored)&&!privateFields.some(key=>Object.hasOwn(authored,key)),'PONDER_TOOL','Only model-authored read-only arguments are allowed');
      const args=clone(authored);
      if(name===compactName)Object.assign(args,{source:clone(bound.nativeSource),analysis:'frozen',freezeId:bound.freezeId,
        evidenceContext:{teamId:bound.nativeSource.teamId,roomId:canonicalEvidenceRoom(bound.nativeSource.room),turn:bound.turn}});
      else{
        need(staticTools.has(name)||numericTools.has(name),'PONDER_TOOL','Unsupported frozen research tool');
        need(args.gen===undefined||args.gen===0,'PONDER_GEN','Frozen M-C research requires gen0');args.gen=0;
        if(numericTools.has(name)){
          args.researchContext={source:clone(bound.nativeSource),analysis:'frozen',freezeId:bound.freezeId};
        }
      }
      const record={name,source:clone(source),frozenSource:clone(bound.nativeSource),sourceSha256:source.sourceSha256,factsSha256:bound.factsSha256,turn:bound.turn,freezeId:bound.freezeId,analysis:'frozen',evidenceScope:'frozen-pre-submission-only',liveFreshness:false,choiceAuthority:false,startedAt:now(),deadlineAt,inputSha256:digest(args),authoredArgumentsSha256:digest(authored)};
      let nativeResult,modelResult;
      nativeCallsPending++;
      try{
        const result=await nativeClient.callTool({name,arguments:args},undefined,{signal,timeout:Math.max(1,Math.floor(deadlineAt-now()))});
        nativeResult=result;
        record.settledAt=now();record.nativeResultSha256=digest(result);record.timely=!signal.aborted&&now()<deadlineAt;record.outcome=result?.isError?'returned-error':'returned';
        need(record.timely,'PONDER_DEADLINE','Frozen native result arrived after preemption/deadline');
        const visible=sanitizeResponse(result,{redactValues:[...privateValues]});modelResult=visible;record.modelResultSha256=digest(visible);return visible;
      }catch(cause){record.settledAt=now();record.outcome='unavailable';record.code=isPonderErrorCode(cause?.code)?cause.code:'PONDER_NATIVE_FAILED';throw cause;}
      finally{nativeCallsPending--;const {source:privateSource,frozenSource:privateFrozenSource,...statusRecord}=record;journal.push(statusRecord);journalBytes+=bytes(statusRecord);while(journal.length>64||journalBytes>262144)journalBytes-=bytes(journal.shift());
        const retained={...record,authoredArguments:clone(authored),input:clone(args),...(nativeResult===undefined?{}:{nativeResult:clone(nativeResult)}),...(modelResult===undefined?{}:{modelResult:clone(modelResult)})};
        privateJournal.push(retained);privateJournalBytes+=bytes(retained);while(privateJournal.length>64||privateJournalBytes>MAX_PRIVATE_JOURNAL_BYTES){privateJournalBytes-=bytes(privateJournal.shift());privateJournalDropped++;}
        emit('ponder.runtime-native-settled',{toolName:name,sourceSha256:record.sourceSha256,startedAt:record.startedAt,settledAt:record.settledAt,outcome:record.outcome,timely:record.timely===true});}
    }});
  let catalog=[];
  async function prepare(){
    if(preparation)return preparation;
    preparation=(async()=>{
      need(!closed,'PONDER_CLOSED','Ponder runtime is stopped');
      const listed=await nativeClient.listTools(),native=listed?.tools;
      need(Array.isArray(native)&&native.some(tool=>tool.name===compactName&&tool.annotations?.readOnlyHint===true),'PONDER_COMPACT_TOOL_REQUIRED','The native compact read-only simulation tool is required before pondering');
      catalog=native.filter(tool=>(MODEL_TOOL_NAMES.includes(tool.name)||tool.name===compactName)&&!['simulate_turn','battle_check_plan'].includes(tool.name)).map(toolDefinition).map(({name,description,inputSchema})=>({name,description:description?.trim()||`Read-only MCP tool ${name}.`,inputSchema}));
      need(catalog.some(tool=>tool.name===compactName),'PONDER_COMPACT_TOOL_REQUIRED','Compact model-authorable simulation schema is unavailable');
      shadow=providerFactory({workspace,model:profile.model,reasoningEffort:profile.reasoningEffort,contextMode:'session',serviceTier:'fast',artifactDirectory:resolve(workspace,'cache','ponder-cli-transient',randomUUID())});
      need(shadow!==mainDecisionProvider&&shadow?.decisionProvider!==mainDecisionProvider&&shadow?.decisionProvider?.kind==='codex-cli'&&shadow.decisionProvider.model===profile.model&&shadow.decisionProvider.reasoningEffort===profile.reasoningEffort&&shadow.contextMode==='session'&&typeof shadow.preflight==='function'&&typeof shadow.close==='function','PONDER_PROVIDER','A dedicated separate shadow CLI provider is required');
      ownerIdleClosed=false;preflightPending=true;try{proof=await shadow.preflight();}finally{preflightPending=false;}
      need(proof.authMode==='chatgpt'&&proof.model===profile.model&&proof.reasoningEffort===profile.reasoningEffort&&proof.requestedServiceTier==='fast'&&!closed,'PONDER_PROVIDER','Shadow opaque ChatGPT profile preflight differs');
      prepared=true;emit('ponder.runtime-prepared',{tools:catalog.map(tool=>tool.name),generationAttempted:false});return {prepared:true,tools:catalog.map(tool=>tool.name),generationAttempted:false};
    })().catch(async cause=>{blocked=cause?.code??'PONDER_PREPARE_FAILED';await closeShadow('preparation-failed').catch(()=>{});emit('ponder.runtime-blocked',{code:blocked});throw cause;});
    return preparation;
  }
  function setMainBusy(value){mainBusy=value===true;if(mainBusy){cancelLaunch();core.cancel('main-busy');}else if(lastState)observeState(lastState);}
  function setDecisionContext({context,state,decision}={}){
    try{
      const binding=context?.binding;
      need(object(binding)&&typeof binding.token==='string'&&typeof binding.room==='string'&&typeof binding.parentId==='string'&&/^[a-f0-9]{64}$/u.test(binding.requestDigest??'')&&state?.sessionId===binding.sessionId,'PONDER_CONTEXT','Exact native pre-decision source required');
      const action=state.actions?.find(value=>value.room===binding.room&&value.rqid===binding.rqid&&value.token===binding.token);
      need(action&&object(action.legalActions),'PONDER_CONTEXT','Matching raw legal request is unavailable');
      if(!cached||cached.binding.requestDigest!==binding.requestDigest){cancelLaunch();core.cancel('decision-source-changed');const preparedFacts=factsFrom(context);cached={binding:clone(binding),...preparedFacts,request:clone(action.legalActions),decision:null};}
      if(decision){const request={...cached.request,side:cached.request.side??{pokemon:cached.request.pokemon}};cached.decision=validateChoice(request,decision.actions).actions;}
      privateValues.add(binding.sessionId);privateValues.add(binding.token);while(privateValues.size>64)privateValues.delete(privateValues.values().next().value);
      return {cached:true,decisionAttached:!!cached.decision};
    }catch(cause){cancelLaunch();core.cancel('context-unavailable');cached=null;emit('ponder.runtime-context-unavailable',{code:cause?.code??'PONDER_CONTEXT'});return {cached:false,reason:cause?.code??'PONDER_CONTEXT'};}
  }
  function observeState(state){
    lastState=state;
    const notIdle=reason=>{cancelLaunch();core.cancel(reason);core.observe({phase:'not-idle',mainBusy,actions:state?.actions??[],ended:state?.stopped===true});return {eligible:false,reason};};
    if(closed||blocked||!prepared)return notIdle(closed?'closed':blocked??'not-prepared');
    if(mainBusy)return notIdle('main-busy');
    if(!Array.isArray(state?.actions))return notIdle('incomplete-native-state');
    if(state.actions.length)return notIdle('fresh-own-request');
    if(state.connected!==true||state.authenticated!==true||state.stopped!==false||state.awaitingSet)return notIdle('native-not-idle');
    if(!cached?.decision||state.sessionId!==cached.binding.sessionId||state.teamSha256!==undefined&&state.teamSha256!==cached.binding.teamId)return notIdle('source-identity-unavailable');
    if(!ownedSearchWait(state,cached.binding))return notIdle('queued-or-unbound-search');
    const matching=choicesIn(state).filter(choice=>sameRoom(choice.room,cached.binding.room));
    if(matching.length!==1)return notIdle('choice-unavailable');
    const choice=matching[0],rooms=state.rooms??[],room=rooms.find(value=>sameRoom(value.id,cached.binding.room)),parent=rooms.find(value=>sameRoom(value.id,cached.binding.parentId));
    if(!room||room.ended!==false||parent?.ended===true)return notIdle('game-ended');
    if(!['sent','accepted'].includes(choice.status)||!Array.isArray(choice.evidence)||choice.evidence.length||choice.boundary||choice.executionObserved||choice.uncertain)return notIdle('reply-or-uncertainty-observed');
    const marker=choice.frozenSimulation;
    if(choice.rqid!==cached.binding.rqid||!exactFreeze(marker,cached.binding)||marker.frozenAt>now()||now()-marker.frozenAt>=90000||!isDeepStrictEqual(choice.actions,cached.decision))return notIdle('committed-source-mismatch');
    privateValues.add(marker.freezeId);
    const sha=digest({binding:cached.binding,freezeId:marker.freezeId,facts:cached.facts}),source=identity(cached.binding,sha);
    if(!Number.isInteger(cached.facts.board?.turn)||cached.facts.board.turn<0||cached.facts.board.turn>10000)return notIdle('frozen-turn-unavailable');
    if(!frozen.has(sha)){frozen.set(sha,{nativeSource:clone(marker.source),freezeId:marker.freezeId,turn:cached.facts.board.turn,factsSha256:digest(cached.facts)});while(frozen.size>12)frozen.delete(frozen.keys().next().value);}
    const snapshot={phase:'opponent-wait',choiceCommitted:true,uncertainSend:false,mainBusy:false,actions:[],ended:false,source,facts:cached.facts,skill:cached.skill,committedActions:cached.decision,commitObservation:{status:choice.status,serverAcceptance:choice.status==='accepted',executionObserved:false}};
    const admission=core.observe(snapshot);
    if(admission.eligible&&scheduled===null&&!core.status().active){scheduled=schedule(()=>{scheduled=null;if(closed||mainBusy||blocked)return;const start=core.startIdle(snapshot);if(start.started)start.completion.catch(()=>{});});}
    return {eligible:admission.eligible,scheduled:scheduled!==null,sourceSha256:sha};
  }
  function notesFor({context,state}={}){
    try{
      need(state?.sessionId===context?.binding?.sessionId&&state.actions?.some(action=>action.room===context.binding.room&&action.rqid===context.binding.rqid&&action.token===context.binding.token),'PONDER_CONTEXT','Fresh native request required for notes');
      const {facts}=factsFrom(context),source=identity(context.binding,digest(context.binding)),notes=core.getCandidate({source,facts});if(!notes)return null;
      const {sessionId,...publicSource}=notes.source,{toolAudit,...proposalNotes}=notes;
      const toolResearch=toolAudit.map(call=>Object.fromEntries(['name','status','startedAt','completedAt','backendSettledAt','resultSha256','code'].filter(key=>call[key]!==undefined).map(key=>[key,call[key]])));
      const visible=sanitizeResponse({...proposalNotes,source:publicSource,toolResearch},{redactValues:[...privateValues]});
      if(bytes(visible)>MAX_PUBLIC_NOTES_BYTES){emit('ponder.runtime-notes-skipped',{reason:'bounded-notes-limit'});return null;}return visible;
    }catch{return null;}
  }
  function stop(reason='runtime-stopped'){closed=true;cancelLaunch();cached=null;frozen.clear();const result=core.stop(reason);closeShadow(reason).catch(()=>{});return result;}
  async function drain(options={}){const timeoutMs=options.timeoutMs??250;let timer;let coreResult;
    try{await Promise.allSettled([core.drain(options).then(value=>{coreResult=value;}),Promise.race([shadowClosing,new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})])]);}
    finally{clearTimeout(timer);}return {...coreResult,shadowClosePending:closingPending,shadowPreflightPending:preflightPending,shadowModelPending:modelPending,blocked};}
  return Object.freeze({prepare,setMainBusy,setDecisionContext,observeState,notesFor,stop,drain,
    // Private in-process evidence only: never spread this into public status or
    // fresh model context. Whole records are retained/dropped, never truncated.
    privateEvidence:()=>({kind:'private-frozen-ponder-journal',records:clone(privateJournal),bytes:privateJournalBytes,maxBytes:MAX_PRIVATE_JOURNAL_BYTES,droppedByBound:privateJournalDropped,complete:privateJournalDropped===0}),
    status:()=>({prepared,closed,mainBusy,blocked,scheduled:scheduled!==null,shadowPreflighted:!!proof,shadowPreflightPending:preflightPending,shadowClosePending:closingPending,shadowModelPending:modelPending,nativeCallsPending,core:core.status(),nativeJournal:clone(journal),privateJournalBytes,privateJournalDropped})});
}
