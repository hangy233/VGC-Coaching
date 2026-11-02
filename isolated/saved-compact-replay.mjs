// Offline regression only: exact authored choices and verified retained sources.
// No source reconstruction from model prose, battle ownership or qualification.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {digest,boardDigest} from '../planning/identity.mjs';
import {bindModelToolArguments} from '../showdown/model-owned-tools.mjs';
import {sanitizeResponse} from '../showdown/operator-response.mjs';
import {createCompactModelToolQualificationAdapter} from './compact-model-tool-qualification.mjs';
import {createRequire} from 'node:module';
import {readCalculation} from '../workflow/calculations.mjs';
import {applyChoiceStateOverrides} from '../simulation/choice-state.mjs';
import {buildObservedPosition} from '../simulation/observed-position.mjs';
import {executeSimulationChoices} from '../simulation/choice-simulation.mjs';
import {legacySimulationChoicesToolSchema} from '../simulation/choice-schemas.mjs';

const HASH=/^[a-f0-9]{64}$/u,TEAM_PARENT=/^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/u;
const clone=structuredClone,sha=x=>createHash('sha256').update(x).digest('hex');
const need=(ok,reason)=>{if(!ok)throw Object.assign(Error(reason),{code:'SAVED_COMPACT_REPLAY'});};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const canonical=x=>String(x??'').replace(/-[a-z0-9]+pw$/u,'');
const {Teams}=createRequire(import.meta.url)('pokemon-showdown'),captures=new WeakMap();
function toolBody(value){let x=value;for(let i=0;i<8;i++){if(x?.kind==='model-tool-result')return x;if(x?.result!==undefined)x=x.result;else break;}return null;}
function safeDiagnostic(error,secrets=[]){
  const value=sanitizeResponse({text:String(error?.message??error??'Replay unavailable').slice(0,3000)},{redactValues:secrets}).text;
  return value.replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]').replace(/\b[A-Za-z]:\\[^\s<>"']+/gu,'[redacted-path]').slice(0,500);
}

export function inventoryCompactSimulationRefusals(trace,{teamId,parentId,traceSha256}={}){
  need(HASH.test(teamId??'')&&TEAM_PARENT.test(parentId??'')&&HASH.test(traceSha256??''),'Exact trace identity and file hash required');
  need(trace?.teamId===teamId&&trace.parentId===parentId&&Array.isArray(trace.entries)&&trace.entries.length<=512,'Trace owner or entry bounds differ');
  const cases=[];
  for(const [entryIndex,entry]of trace.entries.entries()){
    need(entry.binding?.teamId===teamId&&entry.binding.parentId===parentId,'Decision owner differs');
    const calls=entry.decision?.modelToolCalls??[];need(Array.isArray(calls)&&calls.length<=64,'Bounded recorded calls required');
    for(const [toolIndex,call]of calls.entries()){
      if(call.name!=='simulate_choices'||call.status!=='refused')continue;
      const body=toolBody(call.result),receipt=body?.receipt,result=body?.result;
      need(receipt?.nativeMcp===true&&receipt.modelRequested===true&&HASH.test(receipt.sourceSha256??'')&&HASH.test(receipt.argumentsSha256??''),'Recorded source-bound native refusal receipt required');
      need(result?.kind==='simulation-choices-unavailable'&&result.isError===true&&typeof result.reason==='string','Exact structured refusal required');
      const context=JSON.parse(entry.context.input),turn=context.board?.turn;
      need(Number.isInteger(turn)&&turn>=1&&Number.isInteger(entry.binding.rqid)&&typeof call.arguments==='object','Recorded turn and authored inputs required');
      cases.push({id:`entry-${entryIndex}-tool-${toolIndex}`,entryIndex,toolIndex,roomId:canonical(entry.binding.room),rqid:entry.binding.rqid,turn,
        sourceSha256:receipt.sourceSha256,boundArgumentsSha256:receipt.argumentsSha256,authoredArguments:clone(call.arguments),authoredArgumentsSha256:digest(call.arguments),
        recordedStage:result.stage??null,recordedReason:result.reason,recordedResultSha256:receipt.nativeResultSha256??null,
        modelContextInputSha256:sha(entry.context.input),recordedReceiptOnly:true});
    }
  }
  need(cases.length<=64,'Bounded refusal case count exceeded');
  return freeze({kind:'saved-compact-refusal-inventory',version:1,teamId,parentId,traceSha256,cases,
    limitations:['Recorded hashes identify historical evidence; no SDK/model/live receipt is minted.','Model context is not the full native state or mechanical assembly. Missing retained source is unavailable, never reconstructed from menus or prose.']});
}

export async function loadSavedCompactRefusals({workspace=process.cwd(),traceFile,traceSha256,teamId,parentId}={}){
  need(typeof traceFile==='string'&&!isAbsolute(traceFile)&&HASH.test(traceSha256??''),'Exact relative trace path/hash required');
  const root=await realpath(workspace),path=resolve(root,traceFile),part=relative(root,path);
  need(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part),'Trace path escapes workspace');
  const info=await lstat(path);need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024*1024&&await realpath(path)===path,'Bounded ordinary trace required');
  const bytes=await readFile(path);need(sha(bytes)===traceSha256,'Trace bytes changed');
  return inventoryCompactSimulationRefusals(JSON.parse(bytes.toString('utf8')),{teamId,parentId,traceSha256});
}

export function savedCompactSourceBinding(state){
  need(state?.actions?.length===1&&state?.boards?.length===1&&HASH.test(state.teamSha256??''),'One complete retained current state required');
  const action=state.actions[0],board=state.boards[0],source={sessionId:state.sessionId,teamId:state.teamSha256,room:action.room,rqid:action.rqid,token:action.token};
  need(typeof source.sessionId==='string'&&HASH.test(source.token??'')&&board.room===source.room&&board.request?.rqid===source.rqid&&action.legalActions,'Exact original source/board/legal projection required');
  return {source,turn:board.turn,parentId:canonical(action.parentId),sourceSha256:digest({...source,boardHash:boardDigest(board,action.legalActions),legalHash:digest(action.legalActions)})};
}

// Identity comparison only. It grants no source, SDK or qualification receipt.
export function matchesRetainedChoiceRequest(request,normalized,{allowSingleBranch=false}={}){
  if(request?.kind!=='explicit'||!Array.isArray(normalized))return false;
  return normalized.some(w=>digest({kind:'explicit',...w.core})===digest(request)||allowSingleBranch&&request.branches?.length===1&&
    w.core.branches.some(branch=>digest({kind:'explicit',...w.core,branches:[branch]})===digest(request)));
}

export async function replaySavedCompactRefusals({workspace=process.cwd(),inventory,sourceRecords=[],callNative,adapterFactory=createCompactModelToolQualificationAdapter,
  signal,deadlineAt,caseBudgetMs=5000,now=Date.now}={}){
  need(inventory?.kind==='saved-compact-refusal-inventory'&&Array.isArray(inventory.cases)&&inventory.cases.length<=64,'Bounded inventory required');
  need(Array.isArray(sourceRecords)&&sourceRecords.length<=64&&typeof adapterFactory==='function'&&typeof now==='function','Bounded source records and adapter required');
  need(Number.isInteger(caseBudgetMs)&&caseBudgetMs>=1&&caseBudgetMs<=40000,'Original per-case budget must be1..40000ms');
  const bySource=new Map();
  for(const record of sourceRecords){const binding=savedCompactSourceBinding(record.state);
    need(binding.source.teamId===inventory.teamId&&binding.parentId===inventory.parentId,'Retained source owner differs from trace');
    need(!bySource.has(binding.sourceSha256),'Duplicate retained source is ambiguous');bySource.set(binding.sourceSha256,{record,binding});}
  const cases=[];
  for(const row of inventory.cases){
    const base={id:row.id,roomId:row.roomId,turn:row.turn,rqid:row.rqid,sourceSha256:row.sourceSha256,authoredArgumentsSha256:row.authoredArgumentsSha256,
      historical:{stage:row.recordedStage,reason:row.recordedReason},nativeCalls:[],historicalSourceUnchanged:true};
    const match=bySource.get(row.sourceSha256);
    if(!match){cases.push({...base,status:'source-unavailable',reason:'Complete hash-matching native source/assembly was not retained; model context and sanitized events cannot replace it.'});continue;}
    const {record,binding}=match,originalStateSha256=digest(record.state),originalArgumentsSha256=digest(row.authoredArguments),secrets=[binding.source.sessionId,binding.source.token];
    const cutoff=Math.min(Number.isFinite(deadlineAt)?deadlineAt:Infinity,now()+caseBudgetMs);
    if(signal?.aborted||now()>=cutoff){cases.push({...base,status:'deadline-unavailable'});continue;}
    let timer,abort;const controller=new AbortController();abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,Math.max(1,cutoff-now()));
    const bounded=async work=>{need(now()<cutoff&&!controller.signal.aborted,'Original replay deadline unavailable');let cancel;try{return await Promise.race([Promise.resolve().then(work),new Promise((_resolve,reject)=>{cancel=()=>reject(Error('Original replay deadline unavailable'));controller.signal.addEventListener('abort',cancel,{once:true});})]);}finally{controller.signal.removeEventListener('abort',cancel);}};
    try{
      need(binding.source.room===row.roomId||canonical(binding.source.room)===row.roomId,'Source room differs');need(binding.source.rqid===row.rqid&&binding.turn===row.turn,'Source request/turn differs');
      const args=bindModelToolArguments('simulate_choices',clone(row.authoredArguments),{source:binding.source,turn:binding.turn});
      need(digest(args)===row.boundArgumentsSha256,'Authored bound arguments differ from original native receipt');
      const adapter=await bounded(()=>adapterFactory({...clone(record),workspace,now}));
      need(adapter&&typeof adapter.execute==='function'&&typeof adapter.status==='function','Verified compact adapter required');
      const status=adapter.status();base.sourceProofSha256=digest(status.sourceProof??{});
      need(typeof callNative==='function','Actual registered native MCP dispatcher required');
      const result=await bounded(()=>adapter.execute({name:'simulate_choices',args,signal:controller.signal,deadlineAt:cutoff,callNative:async(request,schema,options)=>{
        const formatCorrect=request.name==='simulate_turn'?request.arguments?.request?.kind==='explicit'&&[undefined,0].includes(request.arguments.gen):request.arguments?.gen===0;
        need(['calculate_speed','calculate_damage','simulate_turn'].includes(request.name)&&formatCorrect&&now()<cutoff&&!controller.signal.aborted,'Only bounded Champions actual numerical MCP allowed');
        const call={name:request.name,inputSha256:digest(request.arguments),startedAt:now()};base.nativeCalls.push(call);
        const reply=await bounded(()=>callNative(clone(request),schema,{...options,signal:controller.signal,timeout:Math.max(1,cutoff-now())}));
        need(now()<cutoff&&!controller.signal.aborted,'Native result missed original replay deadline');
        call.settledAt=now();call.resultSha256=digest(reply);call.isError=reply?.isError===true;return reply;
      }}));
      need(now()<cutoff&&!controller.signal.aborted,'Replay missed original deadline');
      cases.push({...clone(base),status:result?.kind==='native-choice-simulation-v1'?'returned':'unavailable',resultKind:result?.kind??null,resultSha256:digest(result),
        adapterReceipt:adapter.receipt?.(result)??null,comparison:'Current offline return only; historical live refusal remains unchanged.'});
    }catch(error){cases.push({...clone(base),status:controller.signal.aborted||now()>=cutoff?'deadline-unavailable':'refused',reason:safeDiagnostic(error,secrets)});}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);need(digest(record.state)===originalStateSha256&&digest(row.authoredArguments)===originalArgumentsSha256,'Replay mutated retained facts or authored choices');}
  }
  return {kind:'saved-compact-refusal-replay-report',version:1,teamId:inventory.teamId,parentId:inventory.parentId,traceSha256:inventory.traceSha256,cases,
    adapterRoute:adapterFactory===createCompactModelToolQualificationAdapter?'maintained-compact-qualification':'explicit-caller-supplied-adapter',dispatcherVerification:'caller-owned-not-branded-by-this-harness',
    coverage:{historicalRefusals:cases.length,matchingRetainedSources:cases.filter(c=>c.status!=='source-unavailable').length,currentReturns:cases.filter(c=>c.status==='returned').length,
      sourceUnavailable:cases.filter(c=>c.status==='source-unavailable').length,actualNativeDispatches:cases.reduce((n,c)=>n+c.nativeCalls.length,0)},
    modelCalls:0,battlesStarted:0,authenticationCalls:0,qualification:false,nativeSdkVerified:false,liveFreshness:false,
    limits:'The dispatcher is caller-owned. This harness does not mint SDK/model/live qualification; test adapters cannot supply such proof. Historical missing source remains unavailable. Successful representative worlds are samples under disclosed hypotheses, never exhaustive spreads or guaranteed outcomes.'};
}

/** Verify the original persisted ledger, not merely a self-consistent copied
 * context. The returned local brand establishes integrity, never live ownership. */
export async function verifyPrivateChoiceCapture({workspace=process.cwd(),record,expected}={}){
  need(expected&&HASH.test(expected.teamId??'')&&HASH.test(expected.sha256??'')&&typeof expected.id==='string'&&typeof expected.roomId==='string'&&Number.isInteger(expected.turn),'Exact ledger identity/hash/turn required');
  const retained=await readCalculation({workspace,teamId:expected.teamId,id:expected.id});
  need(retained.sha256===expected.sha256&&digest(retained)===digest(record),'Original calculation ledger or incoming read differs');
  need(retained.kind==='mcp-calculation-evidence'&&retained.provenance==='actual-mcp-tool'&&retained.tool==='simulate_choices'&&retained.teamId===expected.teamId&&retained.roomId===expected.roomId&&retained.turn===expected.turn,'Calculation identity/scope differs');
  const capture=retained.input?.sourceCapture;let context=capture?.context;
  need(capture?.kind==='private-owned-choice-input-v1'&&context?.kind==='owned-simulation-context-v1'&&capture.contextSha256===digest(context),'Private capture context digest differs');
  if(capture.contextJson!==undefined){
    need(typeof capture.contextJson==='string'&&Buffer.byteLength(capture.contextJson)<=8*1024*1024,'Bounded ordered native context JSON required');
    const ordered=JSON.parse(capture.contextJson);
    need(JSON.stringify(ordered)===capture.contextJson&&digest(ordered)===capture.contextSha256&&digest(ordered)===digest(context),'Ordered context JSON differs from captured facts');context=ordered;
  }
  const team=Teams.import(capture.ownTeamText??'');need(team?.length===6&&sha(Teams.pack(team))===expected.teamId&&capture.ownTeamSha256===expected.teamId,'Captured packed team differs');
  const request=legacySimulationChoicesToolSchema.parse(retained.input.request),source=request.source,assembly=context.assembly;
  need(context.choiceAuthority===false&&source.teamId===expected.teamId&&canonical(source.room)===expected.roomId&&request.evidenceContext?.teamId===expected.teamId&&request.evidenceContext.roomId===expected.roomId&&request.evidenceContext.turn===expected.turn,'Captured request evidence scope differs');
  need(['sessionId','teamId','room','rqid','token'].every(k=>source[k]===context.source?.[k]&&source[k]===assembly?.binding?.[k]),'Captured source/context/assembly tuple differs');
  // Native public observations omit the private registered-team hash. The
  // ledger, packed own team, source and assembly tuple above bind that owner;
  // a present observation hash must still match. Never inject a missing field.
  need(context.observed?.sessionId===source.sessionId&&(context.observed.teamSha256===undefined||context.observed.teamSha256===source.teamId),'Captured observed session/team differs');
  const actions=context.observed.actions?.filter(a=>a.room===source.room&&a.rqid===source.rqid&&a.token===source.token),boards=context.observed.boards?.filter(b=>b.room===source.room&&b.request?.rqid===source.rqid);
  need(actions?.length===1&&boards?.length===1&&boards[0].turn===expected.turn,'Captured exact current request/turn differs');
  const boardHash=boardDigest(boards[0],actions[0].legalActions),legalHash=digest(actions[0].legalActions),operatorSourceSha256=digest({...source,boardHash,legalHash});
  need(!expected.sourceSha256||expected.sourceSha256===operatorSourceSha256,'Expected operator source hash differs');
  // Native board/legal digests precede the IPC JSON projection (which omits
  // undefined properties). Preserve those declared digests, but bind the
  // retained projection independently to the original operator receipt above.
  // Differing representations do not establish equal native/projected hashes.
  need((context.boardHash===undefined||HASH.test(context.boardHash))&&(context.legalHash===undefined||HASH.test(context.legalHash))&&HASH.test(context.semanticSha256??''),'Captured native hash declaration is malformed');
  const overlaid=applyChoiceStateOverrides({observed:context.observed,assembly});
  need(retained.input.assembly===undefined||digest(retained.input.assembly)===digest(assembly),'Duplicated retained assembly differs');
  const normalized=retained.input.normalized??[];need(Array.isArray(normalized)&&normalized.length<=3&&new Set(normalized.map(w=>w.id)).size===normalized.length,'Bounded unique normalized worlds required');
  const proof=freeze({kind:'verified-private-choice-capture',version:1,id:expected.id,sha256:expected.sha256,teamId:expected.teamId,roomId:expected.roomId,turn:expected.turn,
    contextSha256:capture.contextSha256,...(capture.contextJson!==undefined?{orderedContextJsonSha256:sha(capture.contextJson)}:{}),operatorSourceSha256,
    retainedProjectionHashes:{boardSha256:boardHash,legalSha256:legalHash},declaredNativeHashes:{boardSha256:context.boardHash??null,legalSha256:context.legalHash??null},
    hashRepresentation:'Retained JSON projection hashes are recomputed locally; declared pre-IPC native hashes are preserved opaque and are not asserted equal.',
    normalizedSha256:digest(normalized),normalizedWorlds:normalized.length,readinessDiagnosticsOnly:normalized.length===0,
    historicalOnly:true,liveFreshness:false,qualification:false,limitation:'Original ledger and local capture integrity verified; this does not authenticate a historical server or grant fresh source/model/SDK qualification.'});
  captures.set(proof,{workspace,record:clone(retained),team,context:clone(context),overlaid});return proof;
}

/** Re-run maintained reconstruction under a disclosed new offline clock, then
 * require exact normalized core AND hypothesis/provenance equality. */
export async function replayPrivateChoiceCapture({verified,callNative,mode='reconstruct',signal,deadlineAt,caseBudgetMs=5000,now=Date.now}={}){
  const saved=captures.get(verified);need(saved,'Original verified capture object required');
  need(['reconstruct','normalized-worlds-only'].includes(mode)&&typeof now==='function'&&Number.isInteger(caseBudgetMs)&&caseBudgetMs>0&&caseBudgetMs<=40000,'Bounded replay mode/clock required');
  const {record,team,workspace}=saved,normalized=record.input.normalized??[],calls=[];
  const base={kind:'private-choice-capture-replay',mode,ledgerId:record.id,ledgerSha256:verified.sha256,historicalOnly:true,liveFreshness:false,qualification:false,nativeSdkVerified:false,modelCalls:0,nativeCalls:calls};
  if(!normalized.length)return {...base,status:'readiness-diagnostic-only',reason:record.result?.reason??'No normalized worlds were retained',normalizationReconstructed:false};
  need(typeof callNative==='function','Actual registered native MCP dispatcher required');
  const cutoff=Math.min(Number.isFinite(deadlineAt)?deadlineAt:Infinity,now()+caseBudgetMs),controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,Math.max(1,cutoff-now()));
  const bounded=async work=>{need(now()<cutoff&&!controller.signal.aborted,'Original offline replay deadline unavailable');let cancel;try{return await Promise.race([Promise.resolve().then(()=>{need(now()<cutoff&&!controller.signal.aborted,'Original offline replay deadline unavailable before dispatch');return work();}),new Promise((_r,reject)=>{cancel=()=>reject(Error('Original offline replay deadline unavailable'));controller.signal.addEventListener('abort',cancel,{once:true});})]);}finally{controller.signal.removeEventListener('abort',cancel);}};
  const dispatch=async(name,args)=>{
    need(['simulate_turn','calculate_damage','calculate_speed'].includes(name),'Only registered numerical replay tools allowed');
    if(name==='simulate_turn')need(matchesRetainedChoiceRequest(args?.request,normalized,{allowSingleBranch:mode==='reconstruct'}),
      'Normalized core or exact original branch subset differs from retained capture');
    else need(args?.gen===0,'Champions scalar replay required');
    const call={name,inputSha256:digest(args)};
    const result=await bounded(()=>{call.startedAt=now();calls.push(call);return callNative({name,arguments:clone(args)},undefined,{signal:controller.signal,timeout:Math.max(1,cutoff-now())});});
    need(now()<cutoff&&!controller.signal.aborted,'Late native replay return');Object.assign(call,{resultSha256:digest(result),settledAt:now(),isError:result?.isError===true});return result;
  };
  try{
    if(mode==='normalized-worlds-only'){
      const results=[];for(const world of normalized)results.push(await dispatch('simulate_turn',{request:{kind:'explicit',...clone(world.core)}}));
      return {...base,status:results.some(r=>r?.isError)?'native-refused':'native-worlds-returned',normalizationReconstructed:false,resultHashes:results.map(digest),
        limitation:'Only retained explicit worlds were dispatched. Current mechanical reconstruction was not revalidated; representative worlds remain hypotheses, not fresh facts or guaranteed outcomes.'};
    }
    const context=clone(saved.context),originalObserved=clone(context.observed),overlaid=clone(saved.overlaid);
    const {sessionId,...expected}=context.source,originalBuilt=new Map(normalized.map(world=>{
      const built=buildObservedPosition({observed:saved.overlaid,teamText:record.input.sourceCapture.ownTeamText,opposingSheet:context.opposingSheet,hypotheses:world.hypotheses,expected});
      // Archive canonicalization may reorder hypothesis object keys, whereas
      // the original core's ordered label array is retained losslessly. This
      // independent check proves state/provenance only; the actual rebuilt
      // core, including its exact ordered labels, is compared below.
      need(digest(built.position)===digest(world.core.position)&&digest(built.provenance)===digest(world.provenance),'Original normalized facts or provenance differ from the exact retained source');
      return [world.id,built];
    }));
    const removeClocks=o=>{if(o.controlPolicy)o.controlPolicy.pending=[];if(o.timing)o.timing.requests=[];for(const b of o.boards??[])if(b.clock)b.clock.deadlineAt=null;};
    removeClocks(context.observed);removeClocks(overlaid);
    context.assembly.binding.observedSha256=sha(JSON.stringify(context.observed));context.assembly.binding.assembledObservedSha256=sha(JSON.stringify(overlaid));
    const provenanceSourceRebase=[],offlineProjection=normalized.map(world=>{
      const built=buildObservedPosition({observed:overlaid,teamText:record.input.sourceCapture.ownTeamText,opposingSheet:context.opposingSheet,hypotheses:world.hypotheses,expected});
      const {sourceSha256:originalSourceSha256,...originalProvenance}=originalBuilt.get(world.id).provenance,{sourceSha256:offlineSourceSha256,...offlineProvenance}=built.provenance;
      need(digest(built.position)===digest(world.core.position)&&digest(originalProvenance)===digest(offlineProvenance),'Clock treatment changed non-clock normalized facts or provenance');
      provenanceSourceRebase.push({worldId:world.id,originalSourceSha256,offlineSourceSha256});
      // A separate expected comparison view. Original capture/worlds and their
      // source hashes remain untouched; only this proven clock-bound digest
      // can differ when the maintained facade rebuilds the offline view.
      return {...clone(world),provenance:built.provenance};
    });
    let reconstructed;const args=clone(record.input.request);
    const result=await bounded(()=>executeSimulationChoices(args,{researchPolicy:record.input.researchPolicy??(normalized.length>1?'offline-multi':'single-outcome'),workspace,now,deadlineAt:cutoff,signal:controller.signal,loadTeam:async()=>({team:clone(team)}),
      call:async(_path,q)=>{need(q.op==='simulation-context'&&digest(q.source)===digest(context.source)&&q.mode===args.analysis&&(!q.freezeId||q.freezeId===args.freezeId),'Historical context callback changed scope');return {ok:true,result:clone(context)};},
      callTool:dispatch,recordEvidence:async entry=>{reconstructed=clone(entry.input.normalized??[]);need(digest(reconstructed)===digest(offlineProjection),'Deep normalized worlds/hypotheses/non-clock provenance differ');return {offlineReplayOnly:true,sha256:digest(entry)};}}));
    need(reconstructed&&digest(reconstructed)===digest(offlineProjection),'Deep normalized reconstruction unavailable or changed');
    return {...base,status:['native-choice-simulation-v1','native-choice-outcome-v1'].includes(result.kind)?'reconstructed-native-return':'reconstructed-native-unavailable',resultKind:result.kind,resultSha256:digest(result),normalizationReconstructed:true,
      researchOutcome:result.researchOutcome??null,...(result.coverage?{coverage:clone(result.coverage)}:{}),...(result.nativeRefusals?{nativeRefusals:clone(result.nativeRefusals)}:{}),
      ...(result.worlds?{worldBranchResults:result.worlds.map(world=>({worldId:world.id,branchResults:clone(world.branchResults??[])}))}:{}),
      provenanceSourceRebase,normalizationComparison:'State, branches, seeds, hypotheses and non-clock provenance match exactly; original and explicitly clock-rebased source digests are independently verified, not asserted equal.',
      originalObservedSha256:sha(JSON.stringify(originalObserved)),replayObservedSha256:sha(JSON.stringify(context.observed)),clockTreatment:'Only archived pending/countdown clocks removed in a separate offline view; original capture and source hashes unchanged.',
      limitation:'Maintained current reconstruction reproduced the retained representative worlds; no fresh server observation, model decision or new qualification is claimed.'};
  }catch(error){return {...base,status:controller.signal.aborted||now()>=cutoff?'deadline-unavailable':'refused',reason:safeDiagnostic(error,[record.input.request.source.sessionId,record.input.request.source.token]),normalizationReconstructed:false};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
