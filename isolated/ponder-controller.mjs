// Speculative, read-only work on a frozen position while the opponent is
// thinking. This controller has no battle mutation or action-execution API.
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {digest} from '../planning/identity.mjs';
import {verifyMatchupGuidance} from './matchup-guidance.mjs';
import {ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {createModelToolArgumentValidator} from './model-tool-validation.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const error=(code,message)=>Object.assign(new Error(message),{code});
const need=(value,code,message)=>{if(!value)throw error(code,message);};
const sourceFields=['sessionId','teamId','parentId','gameId'];
const names=new Set(['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_damage_range','calculate_speed','simulate_choices','simulate_turn','battle_check_plan']);
const textSchema=maxLength=>({type:'string',maxLength});
export const PONDER_PROFILE=Object.freeze({provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',contextMode:'session',authenticationMethod:'chatgpt'});
export const PONDER_LIMITS=Object.freeze({maxPonderMs:45000,maxToolCalls:8,maxToolMs:5000,maxSourcesPerGame:64,maxFactsBytes:2*1024*1024,
  maxInputBytes:MAX_CONTEXT_BYTES,maxArgumentBytes:1024*1024,maxResultBytes:2*1024*1024,maxTotalResultBytes:MAX_CONTEXT_BYTES,maxCandidateBytes:65536});
export const PONDER_PROTOCOL=`You are the battle model doing speculative read-only work during opponent wait. The exact frozen facts are in ponderFacts. Apply the complete supplied matchupSkill. You choose whether research is useful and author the proposed own/opposing action pairs and questions. When simulate_choices is available, prefer its compact interface: author ourActions and opposingActions, each with both actions, and optional alternative pairs when useful. The adapter supplies source, labeled reconstruction/spread assumptions, seeds and gate bookkeeping; read those labels and limitations rather than treating them as observed facts. Advanced simulate_turn or battle_check_plan contracts, if exposed for compatibility, still require their explicitly advertised authored inputs. No live request is available for you to answer and no action will be executed from this response. Do not request battle mutations, readiness, search, authentication, files, web or other agents. Tools and this analysis share the supplied background deadline and can be canceled immediately for a real request. Stop on cancellation. Results describe only the frozen position and labeled hypotheses; they establish no fresh-turn goal, server acceptance or execution. Return limited speculative proposals/questions, including any proposed move or switch branches as text. For each proposal, factPaths selects exact strings from factPathCatalog.paths. These JSON pointers are relative to the value of ponderFacts: copy the catalog strings without adding a /ponderFacts prefix. A top-level pointer binds its entire value and every descendant; the empty string binds all frozen facts. Unknown paths are rejected, never repaired. A fresh battle model must recheck current facts and every material dependency before acting. Do not claim a refusal is a negative simulation sample.`;
export const PONDER_OUTPUT_SCHEMA=freeze({type:'object',properties:{summary:textSchema(3000),proposals:{type:'array',maxItems:6,items:{type:'object',properties:{label:textSchema(120),idea:textSchema(2000),assumptions:{type:'array',maxItems:12,items:textSchema(500)},questions:{type:'array',maxItems:8,items:textSchema(500)},factPaths:{type:'array',maxItems:32,items:{...textSchema(500),enum:['']}}},required:['label','idea','assumptions','questions','factPaths'],additionalProperties:false}},limitations:{type:'array',maxItems:12,items:textSchema(500)}},required:['summary','proposals','limitations'],additionalProperties:false});

function outputContract(facts){
  const paths=['',...Object.keys(facts).sort().filter(key=>!['__proto__','constructor','prototype'].includes(key))
    .map(key=>'/'+key.replace(/~/gu,'~0').replace(/\//gu,'~1')).filter(path=>path.length<=500).slice(0,63)];
  const schema=clone(PONDER_OUTPUT_SCHEMA);schema.properties.proposals.items.properties.factPaths.items.enum=clone(paths);
  return freeze({schema,factPathCatalog:{kind:'ponder-fact-path-catalog-v1',pointerRoot:'ponderFacts',paths,selection:'root-and-bounded-top-level-pointers',
    omittedTopLevelPaths:Object.keys(facts).length-(paths.length-1),revalidation:'Entire selected value, including all descendants; the empty string binds every frozen fact.'}});
}

function validSource(source){return object(source)&&sourceFields.every(key=>typeof source[key]==='string'&&source[key].length>0&&source[key].length<=240)&&/^[a-f0-9]{64}$/u.test(source.sourceSha256??'');}
const sameIdentity=(left,right)=>sourceFields.every(key=>left[key]===right[key]);
const gameKey=source=>digest(Object.fromEntries(sourceFields.map(key=>[key,source[key]])));
const waitKey=source=>digest({...Object.fromEntries(sourceFields.map(key=>[key,source[key]])),sourceSha256:source.sourceSha256});
function idleReason(snapshot){
  if(!object(snapshot)||!validSource(snapshot.source))return 'missing-source';
  if(snapshot.ended===true||snapshot.stopped===true)return 'game-closed';
  if(snapshot.mainBusy===true)return 'main-busy';
  if(snapshot.phase!=='opponent-wait'||snapshot.choiceCommitted!==true||snapshot.uncertainSend!==false||snapshot.ended!==false||
    !Array.isArray(snapshot.actions)||snapshot.actions.length!==0)return 'not-committed-opponent-wait';
  if(!object(snapshot.facts))return 'missing-facts';
  return null;
}
function pointerValue(facts,path){
  need(typeof path==='string'&&path.length<=500&&(path===''||path.startsWith('/')),'PONDER_DEPENDENCY','Fact dependencies require JSON pointers');
  let value=facts;
  for(const encoded of path===''?[]:path.slice(1).split('/')){
    need(!/~(?:[^01]|$)/u.test(encoded),'PONDER_DEPENDENCY','Malformed JSON pointer');
    const part=encoded.replace(/~1/gu,'/').replace(/~0/gu,'~');
    need(value!==null&&typeof value==='object'&&Object.hasOwn(value,part)&&!['__proto__','constructor','prototype'].includes(part),'PONDER_DEPENDENCY','Fact dependency is absent from the frozen source');
    value=value[part];
  }
  return value;
}
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validateOutput(value){
  const texts=(array,count,length)=>Array.isArray(array)&&array.length<=count&&array.every(item=>typeof item==='string'&&item.length<=length);
  need(exact(value,['summary','proposals','limitations'])&&typeof value.summary==='string'&&value.summary.length<=3000&&Array.isArray(value.proposals)&&value.proposals.length<=6&&texts(value.limitations,12,500),'PONDER_OUTPUT','Invalid bounded speculative output');
  for(const proposal of value.proposals)need(exact(proposal,['label','idea','assumptions','questions','factPaths'])&&typeof proposal.label==='string'&&proposal.label.length<=120&&typeof proposal.idea==='string'&&proposal.idea.length<=2000&&texts(proposal.assumptions,12,500)&&texts(proposal.questions,8,500)&&texts(proposal.factPaths,32,500),'PONDER_OUTPUT','Invalid bounded speculative proposal');
  return value;
}
const refusal=(code,message)=>({isError:true,content:[{type:'text',text:message}],structuredContent:{code,backgroundOnly:true}});

/**
 * createProvider returns a separate owned provider descriptor:
 * {decisionProvider,contextMode,preflightResult,close}. No main provider may be
 * reused. prepareContext returns {instructions,input,catalog}; its JSON input
 * contains full verified matchupSkill and exact ponderFacts. executeReadOnly
 * receives unchanged model arguments plus the private frozen source and signal.
 */
export function createPonderController({createProvider,prepareContext,executeReadOnly,mainDecisionProvider,now=Date.now,onEvent=()=>{},limits={},setTimer=setTimeout,clearTimer=clearTimeout}={}){
  need(typeof createProvider==='function'&&typeof prepareContext==='function'&&typeof executeReadOnly==='function','PONDER_CONFIGURATION','Owned provider, context and read-only callbacks are required');
  const cap={...PONDER_LIMITS,...limits};
  for(const [key,value]of Object.entries(cap))need(Number.isSafeInteger(value)&&value>0&&value<=(key==='maxPonderMs'?60000:PONDER_LIMITS[key]),'PONDER_CONFIGURATION','Background limit is invalid or exceeds its ceiling');
  let active=null,slot=null,candidate=null,observation=null,closed=false,epoch=0,seenGame=null;const seen=new Set(),cleanup=new Set(),retired=new WeakSet(),retiredDecisions=new WeakSet();
  const counters={started:0,modelCalls:0,completed:0,preempted:0,discarded:0,toolCalls:0};
  const emit=(name,fields={})=>{try{onEvent({...fields,name,at:now()});}catch{/* Diagnostics do not own the active clock. */}};
  const current=job=>active===job&&!job.controller.signal.aborted&&!closed&&now()<job.deadlineAt&&observation&&idleReason(observation)===null&&waitKey(observation.source)===job.key;
  function closeProvider(provider,reason){
    if(!provider||mainDecisionProvider&&(provider===mainDecisionProvider||provider.decisionProvider===mainDecisionProvider))return;
    if(!object(provider)||retired.has(provider))return;retired.add(provider);if(object(provider.decisionProvider))retiredDecisions.add(provider.decisionProvider);
    const promise=Promise.resolve().then(()=>provider.close()).then(()=>emit('ponder.provider-closed',{reason}),cause=>emit('ponder.provider-close-failed',{reason,code:cause?.code??'PONDER_CLOSE'}));
    cleanup.add(promise);promise.finally(()=>cleanup.delete(promise));
  }
  function cancel(reason='preempted'){
    const job=active;if(!job)return {preempted:false,reason};
    active=null;epoch++;clearTimer(job.timer);job.controller.abort(reason);for(const child of job.tools)child.abort(reason);
    counters.preempted++;emit('ponder.preempted',{jobId:job.id,sourceSha256:job.source.sourceSha256,reason,startedAt:job.startedAt,preemptedAt:now()});
    if(slot?.provider===job.provider)slot=null;
    closeProvider(job.provider,reason);job.provider=null;
    return {preempted:true,reason,cleanupPending:cleanup.size};
  }
  function observe(snapshot){
    observation=snapshot;const reason=idleReason(snapshot);
    if(active&&(reason||waitKey(snapshot.source)!==active.key))cancel(reason??'source-changed');
    if(validSource(snapshot?.source)&&seenGame!==gameKey(snapshot.source)){
      seenGame=gameKey(snapshot.source);seen.clear();candidate=null;
      if(slot){closeProvider(slot.provider,'game-changed');slot=null;}
    }
    if(snapshot?.ended===true||snapshot?.stopped===true){candidate=null;if(slot){closeProvider(slot.provider,'game-closed');slot=null;}}
    return {eligible:!closed&&reason===null,reason:closed?'closed':reason};
  }
  function checkProvider(provider){
    const decision=provider?.decisionProvider,proof=provider?.preflightResult;
    need(provider!==mainDecisionProvider&&decision!==mainDecisionProvider&&object(provider)&&!retired.has(provider)&&object(decision)&&!retiredDecisions.has(decision)&&decision.kind==='codex-cli'&&decision.model===PONDER_PROFILE.model&&decision.reasoningEffort===PONDER_PROFILE.reasoningEffort&&typeof decision.callDecision==='function'&&provider.contextMode==='session'&&typeof provider.close==='function'&&proof?.authMode==='chatgpt'&&proof.model===PONDER_PROFILE.model&&proof.reasoningEffort===PONDER_PROFILE.reasoningEffort&&proof.requestedServiceTier==='fast','PONDER_PROVIDER','A separate preflighted Sol/Low/Fast ChatGPT session provider is required');
    return provider;
  }
  async function run(job){
    try{
      verifyIsolatedPolicySource();
      const contract=outputContract(job.snapshot.facts);
      const context=await prepareContext({snapshot:job.snapshot,source:job.source,profile:PONDER_PROFILE,deadlineAt:job.deadlineAt,signal:job.controller.signal,schema:clone(contract.schema),factPathCatalog:clone(contract.factPathCatalog),protocol:PONDER_PROTOCOL});
      if(!current(job))return discard(job,'context-preempted');
      need(typeof context?.instructions==='string'&&typeof context?.input==='string'&&bytes(context.input)+bytes(context.instructions)+bytes(PONDER_PROTOCOL)+bytes(contract.schema)<=cap.maxInputBytes,'PONDER_CONTEXT','Complete background context exceeds its bound');
      const payload=JSON.parse(context.input);verifyMatchupGuidance(payload.matchupSkill,ISOLATED_POLICY_SOURCE);
      need(isDeepStrictEqual(payload.ponderFacts,job.snapshot.facts),'PONDER_CONTEXT','Frozen model-visible facts differ from the bound source');
      need(!Object.hasOwn(payload,'factPathCatalog')||isDeepStrictEqual(payload.factPathCatalog,contract.factPathCatalog),'PONDER_CONTEXT','Frozen fact-path catalog differs from the output schema');
      payload.factPathCatalog=clone(contract.factPathCatalog);const modelInput=JSON.stringify(payload);
      need(bytes(modelInput)+bytes(context.instructions)+bytes(PONDER_PROTOCOL)+bytes(contract.schema)<=cap.maxInputBytes,'PONDER_CONTEXT','Complete background context and fact-path catalog exceed their bound');
      const definitions=context.catalog?.tools??context.catalog;
      need(Array.isArray(definitions)&&definitions.length>0&&definitions.length<=8&&bytes(definitions)<=1024*1024&&new Set(definitions.map(tool=>tool.name)).size===definitions.length&&definitions.every(tool=>names.has(tool.name)&&object(tool.inputSchema)&&typeof tool.description==='string'&&(tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint!==false)),'PONDER_TOOLS','Only the declared read-only battle tools are available to pondering');
      const authorable=definitions.map(({name,description,inputSchema})=>({name,description:description.trim()||`Read-only MCP tool ${name}.`,inputSchema:clone(inputSchema)}));
      const validate=createModelToolArgumentValidator(authorable);let count=0,resultBytes=0,toolBusy=false;const calls=new Set(),toolAudit=[];
      let provider=slot?.game===job.game?slot.provider:null;
      if(!provider){provider=await createProvider({purpose:'ponder',profile:PONDER_PROFILE,source:job.source,signal:job.controller.signal});
        if(!current(job)){closeProvider(provider,'provider-preempted');return discard(job,'provider-preempted');}
        job.provider=provider;checkProvider(provider);slot={provider,game:job.game};}
      job.provider=provider;
      const modelTools={definitions:authorable,call:async request=>{
        if(!current(job))return refusal('PONDER_PREEMPTED','Background work was preempted by current battle control.');
        if(toolBusy)return refusal('PONDER_TOOL_BUSY','Background MCP calls must be sequential.');
        if(count>=cap.maxToolCalls)return refusal('PONDER_TOOL_LIMIT','Background tool-call limit reached.');
        count++;counters.toolCalls++;
        if(!object(request)||!authorable.some(tool=>tool.name===request.name)||typeof request.callId!=='string'||request.callId.length>200||calls.has(request.callId)||!object(request.arguments))return refusal('PONDER_TOOL_REQUEST','Unknown, duplicate or malformed background tool call.');
        calls.add(request.callId);
        const audit={name:request.name,startedAt:now(),arguments:clone(request.arguments)};toolAudit.push(audit);
        emit('ponder.tool-started',{jobId:job.id,toolName:request.name,startedAt:audit.startedAt});
        const early=(status,result)=>{audit.status=status;audit.completedAt=now();emit('ponder.tool-completed',{jobId:job.id,toolName:request.name,status,startedAt:audit.startedAt,completedAt:audit.completedAt,backendCalled:false});return result;};
        if(bytes(request.arguments)>cap.maxArgumentBytes)return early('refused',refusal('PONDER_ARGUMENT_LIMIT','Background tool arguments exceed their bound.'));
        const invalid=validate(request.name,request.arguments);if(invalid)return early('invalid-arguments',invalid);
        const child=new AbortController();job.tools.add(child);const parentAbort=()=>child.abort(job.controller.signal.reason),requestAbort=()=>child.abort(request.signal.reason);
        job.controller.signal.addEventListener('abort',parentAbort,{once:true});request.signal?.addEventListener('abort',requestAbort,{once:true});if(request.signal?.aborted)child.abort(request.signal.reason);
        let timer,onChildAbort;toolBusy=true;
        const toolDeadline=Math.min(job.deadlineAt,now()+cap.maxToolMs);
        const pending=Promise.resolve().then(()=>{if(!current(job)||child.signal.aborted)throw error('PONDER_PREEMPTED','Background work was canceled');return executeReadOnly({name:request.name,arguments:clone(request.arguments),source:job.source,facts:job.snapshot.facts,signal:child.signal,deadlineAt:toolDeadline});});
        pending.then(()=>{
          audit.backendSettledAt=now();emit('ponder.tool-backend-settled',{jobId:job.id,toolName:request.name,startedAt:audit.startedAt,settledAt:audit.backendSettledAt});
          if(!current(job)||child.signal.aborted)emit('ponder.tool-result-discarded',{jobId:job.id,toolName:request.name,discardedAt:now()});
        },()=>{audit.backendSettledAt=now();emit('ponder.tool-backend-settled',{jobId:job.id,toolName:request.name,startedAt:audit.startedAt,settledAt:audit.backendSettledAt,outcome:'error'});}).finally(()=>{toolBusy=false;job.tools.delete(child);}).catch(()=>{});
        try{
          const result=await Promise.race([pending,new Promise((_,reject)=>{
            onChildAbort=()=>reject(error(child.signal.reason==='tool-deadline'?'PONDER_TOOL_DEADLINE':'PONDER_PREEMPTED','Background MCP was canceled'));
            child.signal.addEventListener('abort',onChildAbort,{once:true});if(child.signal.aborted)onChildAbort();
            timer=setTimer(()=>child.abort('tool-deadline'),Math.max(0,toolDeadline-now()));timer?.unref?.();
          })]);
          if(!current(job)||child.signal.aborted){audit.status='discarded';return refusal('PONDER_PREEMPTED','Late background MCP result was discarded.');}
          const size=bytes(result);need(size<=cap.maxResultBytes&&resultBytes+size<=cap.maxTotalResultBytes,'PONDER_RESULT_LIMIT','Complete background result exceeds its bound');resultBytes+=size;
          audit.result=clone(result);audit.resultSha256=digest(result);audit.status=result?.isError===true||result?.structuredContent?.ok===false?'refused':'returned';return result;
        }catch(cause){audit.status='refused';audit.code=cause?.code??'PONDER_TOOL_FAILED';return refusal(audit.code,'Background MCP unavailable; no result or tactical goal was established.');}
        finally{clearTimer(timer);audit.completedAt=now();child.signal.removeEventListener('abort',onChildAbort);job.controller.signal.removeEventListener('abort',parentAbort);request.signal?.removeEventListener('abort',requestAbort);emit('ponder.tool-completed',{jobId:job.id,toolName:request.name,status:audit.status,startedAt:audit.startedAt,completedAt:audit.completedAt});}
      }};
      if(!current(job))return discard(job,'model-dispatch-preempted');
      const modelStartedAt=now();emit('ponder.model-started',{jobId:job.id,startedAt:modelStartedAt,deadlineAt:job.deadlineAt});
      if(!current(job))return discard(job,'model-dispatch-preempted');
      let response;counters.modelCalls++;
      try{response=await provider.decisionProvider.callDecision({model:PONDER_PROFILE.model,reasoningEffort:PONDER_PROFILE.reasoningEffort,instructions:PONDER_PROTOCOL+'\n\n'+context.instructions,input:modelInput,schema:clone(contract.schema),deadlineAt:job.deadlineAt,signal:job.controller.signal,now,contextRefreshAllowed:true,
        sessionScope:{sessionId:job.source.sessionId,teamId:job.source.teamId,parentId:job.source.parentId,gameId:job.source.gameId},requestId:job.id,modelTools});
      }catch(cause){emit('ponder.model-completed',{jobId:job.id,startedAt:modelStartedAt,completedAt:now(),status:'unavailable',code:cause?.code??'PONDER_PROVIDER_FAILED'});throw cause;}
      emit('ponder.model-completed',{jobId:job.id,startedAt:modelStartedAt,completedAt:now(),status:'returned'});
      if(!current(job))return discard(job,'late-completion');
      const output=validateOutput(response?.decision);need(bytes(output)<=cap.maxCandidateBytes,'PONDER_OUTPUT','Speculative notes exceed their bound');
      const dependencies=[...new Set(output.proposals.flatMap(proposal=>proposal.factPaths))].map(path=>{
        const value=pointerValue(job.snapshot.facts,path);need(contract.factPathCatalog.paths.includes(path),'PONDER_DEPENDENCY','Fact dependency is not an advertised frozen-source pointer');
        return {path,sha256:digest(value)};
      });
      candidate=freeze({kind:'speculative-ponder-notes',jobId:job.id,source:clone(job.source),createdAt:now(),guidance:{skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256},output:clone(output),dependencies,toolAudit:clone(toolAudit),speculative:true,freshEvidence:false,goalPassed:false,serverAcceptance:false,requiresFreshMaterialChecks:true});
      counters.completed++;emit('ponder.completed',{jobId:job.id,sourceSha256:job.source.sourceSha256,startedAt:job.startedAt,completedAt:now(),toolCalls:count});
      return {status:'completed',jobId:job.id};
    }catch(cause){if(!current(job))return discard(job,'canceled-or-late');if(slot?.provider===job.provider)slot=null;closeProvider(job.provider,'failed');job.provider=null;emit('ponder.failed',{jobId:job.id,code:cause?.code??'PONDER_FAILED'});return {status:'unavailable',jobId:job.id,code:cause?.code??'PONDER_FAILED'};}
    finally{clearTimer(job.timer);if(active===job)active=null;}
  }
  function discard(job,reason){counters.discarded++;emit('ponder.discarded',{jobId:job.id,sourceSha256:job.source.sourceSha256,reason,discardedAt:now()});return {status:'discarded',jobId:job.id,reason};}
  function startIdle(snapshot){
    const admission=observe(snapshot);if(!admission.eligible)return {started:false,reason:admission.reason};
    if(active)return {started:false,reason:'ponder-busy'};
    if(bytes(snapshot.facts)>cap.maxFactsBytes)return {started:false,reason:'facts-too-large'};
    const key=waitKey(snapshot.source);if(seen.has(key))return {started:false,reason:'source-already-pondered'};if(seen.size>=cap.maxSourcesPerGame)return {started:false,reason:'source-limit'};
    seen.add(key);const controller=new AbortController(),job={id:'ponder_'+randomUUID(),epoch:++epoch,key,game:gameKey(snapshot.source),source:freeze(clone(snapshot.source)),snapshot:freeze(clone(snapshot)),controller,tools:new Set(),startedAt:now(),deadlineAt:now()+cap.maxPonderMs,provider:null};
    active=job;counters.started++;emit('ponder.started',{jobId:job.id,sourceSha256:job.source.sourceSha256,startedAt:job.startedAt,deadlineAt:job.deadlineAt});
    job.timer=setTimer(()=>{if(active===job)cancel('background-deadline');},cap.maxPonderMs);job.timer?.unref?.();
    const completion=run(job);return {started:true,jobId:job.id,deadlineAt:job.deadlineAt,completion};
  }
  function getCandidate({source,facts}={}){
    if(!candidate||closed||!validSource(source)||!object(facts)||!sameIdentity(candidate.source,source))return null;
    try{if(candidate.dependencies.some(item=>digest(pointerValue(facts,item.path))!==item.sha256))return null;}catch{return null;}
    return freeze({...clone(candidate),revalidation:{kind:'mechanical-identity-and-explicit-fact-dependencies',checkedAt:now(),freshSourceSha256:source.sourceSha256,sourceUnchanged:source.sourceSha256===candidate.source.sourceSha256,dependenciesMatched:true,tacticalValidation:false},speculative:true,freshEvidence:false,goalPassed:false,serverAcceptance:false,requiresFreshMaterialChecks:true});
  }
  function stop(reason='closed'){closed=true;cancel(reason);candidate=null;if(slot){closeProvider(slot.provider,reason);slot=null;}return {closed:true,cleanupPending:cleanup.size};}
  async function drain({timeoutMs=250}={}){need(Number.isSafeInteger(timeoutMs)&&timeoutMs>=0&&timeoutMs<=1000,'PONDER_CONFIGURATION','Cleanup wait must remain bounded');let timer;try{await Promise.race([Promise.allSettled([...cleanup]),new Promise(resolve=>{timer=setTimer(resolve,timeoutMs);})]);}finally{clearTimer(timer);}return {cleanupPending:cleanup.size,cleanupConfirmed:cleanup.size===0};}
  return Object.freeze({observe,startIdle,cancel,getCandidate,stop,drain,status:()=>({closed,active:active!==null,jobId:active?.id??null,deadlineAt:active?.deadlineAt??null,cleanupPending:cleanup.size,profile:PONDER_PROFILE,...counters})});
}
