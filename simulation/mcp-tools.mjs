import {simulationToolSchema,simulationBatchToolSchema} from './schemas.mjs';
export {simulationRequestSchema,simulationToolSchema,simulationBatchRequestSchema,simulationBatchToolSchema} from './schemas.mjs';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {callLocalSession} from '../showdown/local-bridge.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {runTurnSimulation,runTurnSimulationBatch} from './turn-simulator.mjs';
import {buildObservedPosition,bindObservedActions} from './observed-position.mjs';
import {buildApproximateObservedPosition} from './approximate-position.mjs';
import {collectObservedPositionDiagnostics} from './observed-position-diagnostics.mjs';
import {timingSpan,timingEvent,createTimingRecorder} from '../observability/timing.mjs';
import {registerSimulationChoicesTool} from './choice-simulation.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const LOADED_MANIFEST=Object.freeze({loadedAt:new Date().toISOString(),modules:Object.fromEntries(['mcp-tools.mjs','registered-identity.mjs','observed-position.mjs','observed-position-diagnostics.mjs','observed-position-readiness.mjs','turn-worker.mjs','turn-simulator.mjs','move-support.mjs','native-state.mjs','approximate-position.mjs','history-state.mjs','schemas.mjs','choice-schemas.mjs','choice-simulation.mjs','choice-presentation.mjs','choice-ranges.mjs','choice-state.mjs','spread-candidates.mjs','spread-observations.mjs','spread-range.mjs'].map(name=>['simulation/'+name,createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')]))});
const check=(ok,message)=>{if(!ok)throw new Error(message);};
function publishedSheet(packed){const columns=String(packed).split(']').map(set=>set.split('|'));return (Teams.unpack(packed)||[]).map((set,index)=>({species:set.species,item:set.item||'',ability:set.ability||'',moves:set.moves,nature:columns[index]?.[5]?set.nature:null,level:columns[index]?.[10]?set.level:null}));}
const unwrap=reply=>{check(reply?.ok!==false&&!reply?.isError,'Fresh simulation source unavailable');return reply?.result??reply;};
function exactSource(observed,source){check(observed.sessionId===source.sessionId&&(!observed.teamSha256||observed.teamSha256===source.teamId),'Simulation source session/team changed');const match=observed.actions?.filter(action=>action.room===source.room&&action.rqid===source.rqid&&action.token===source.token);check(match?.length===1&&match[0].kind==='turn'&&match[0].actionable!==false&&!['sent','uncertain','accepted','execution-observed'].includes(match[0].submissionStatus),'Exact simulation request is stale or reserved');check(!observed.controlPolicy?.pending?.some(entry=>entry.token===source.token&&entry.attempted),'Simulation source already has a send reservation');}
// MCP metadata is correlation data only. Never copy the request, source token,
// capabilities or arbitrary metadata into a timing record.
export function timingToolContext(extra){
  const supplied=extra?._meta?.['vgc/timing'];if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))return {};
  const context={};
  for(const key of ['traceId','parentSpanId','teamId','commandId','requestKey','roomId','operation'])if(typeof supplied[key]==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/u.test(supplied[key]))context[key]=supplied[key];
  for(const key of ['rqid','turn','requestReceivedAt','cutoffAt'])if(Number.isSafeInteger(supplied[key])&&supplied[key]>=0)context[key]=supplied[key];
  return context;
}
export function wrapTimedTool(timingRecorder,tool,handler){
  return (args,extra)=>{
    const exportEvents=!timingRecorder&&extra?._meta?.['vgc/timing']?.returnEvents===true;
    const recorder=timingRecorder??(exportEvents?createTimingRecorder({component:'mcp-server',maxEvents:512}):undefined);
    const execute=()=>{const span=timingSpan('mcp.tool',{tool});return span.run(async()=>{const result=await handler(args,extra);if(result?.isError)span.end('error');return result;});};
    const result=recorder?recorder.run(timingToolContext(extra),execute):execute();
    return exportEvents?Promise.resolve(result).then(value=>({...value,_meta:{...value?._meta,'vgc/timing-events':recorder.snapshot()}})):result;
  };
}
/** Reads only the local existing session; isolated engine owns all resolution. */
async function executeNativeRequest(args,{workspace,call=callLocalSession,recordEvidence,run,loadTeam=loadMetricsTeam,signal}={},batch=false){
  const input=timingSpan('simulation.validation',{stage:'request'}).run(()=>(batch?simulationBatchToolSchema:simulationToolSchema).parse(args)),request=input.request;let core,provenance;const deadline=Date.now()+3500;let stage='source';
  const cases=batch?request.cases:[{branches:request.branches,seeds:request.seeds}];
  if(batch)check(new Set(cases.map(entry=>entry.id)).size===cases.length,'Batch case IDs must be unique');
  const boundedSource=async(work,span)=>{
    check(!signal?.aborted,'Simulation cancelled before source read');let timer,abort;
    try{return await Promise.race([Promise.resolve().then(work),new Promise((_resolve,reject)=>{
      timer=setTimeout(()=>{span.end('timeout');reject(new Error('Bounded simulation source read expired'));},Math.max(1,Math.min(750,deadline-Date.now())));
      abort=()=>reject(new Error('Simulation cancelled during source read'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    })]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
  const read=async(descriptor,command)=>{const span=timingSpan('simulation.source_read',{operation:command.op});return span.run(()=>boundedSource(()=>call(descriptor,{id:randomUUID(),...command}),span));};
  try{
  if(request.kind==='explicit'){const {kind,...rest}=request;core=rest;provenance={kind:'explicit-offline-snapshot',liveFreshness:false};}
  else{
    const source=request.source,descriptor=join(workspace,'cache','showdown-session.json');canonicalEvidenceRoom(source.room);
    check(input.evidenceContext&&input.evidenceContext.teamId===source.teamId&&input.evidenceContext.roomId===canonicalEvidenceRoom(source.room),'Observed simulation requires matching canonical team-owned evidence');
    // These reads and the locked team lookup have independent inputs. All are
    // awaited together; no speculative control command or result is issued.
    const teamSpan=timingSpan('simulation.team_load');
    const [observedReply,fullReply,own]=await Promise.all([read(descriptor,{op:'turn-status'}),read(descriptor,{op:'status'}),teamSpan.run(()=>boundedSource(()=>loadTeam({workspace,teamId:source.teamId}),teamSpan))]);
    const observed=unwrap(observedReply);exactSource(observed,source);
    const full=unwrap(fullReply);check(full.sessionId===source.sessionId&&full.teamSha256===source.teamId,'Simulation full source identity changed');
    const board=observed.boards?.find(board=>board.room===source.room);check(board,'Exact source board missing');
    const foeSide=board.ownSide==='p1'?'p2':'p1',packed=full.rooms?.find(room=>room.id===source.room)?.sheets?.[foeSide];
    const sheet=board.opponentSheets?.[foeSide]??(packed?publishedSheet(packed):null);check(sheet,'Actual registered opposing sheet is unavailable');
    observed.opponentSheets={[foeSide]:sheet};
    const {sessionId,...binding}=source;
    const builderInput={observed,teamText:Teams.export(own.team),opposingSheet:sheet,hypotheses:request.hypotheses,expected:binding};
    let built;
    try{built=timingSpan('simulation.reconstruction',{stage:'observed-position'}).run(()=>buildObservedPosition(builderInput));}
    catch(error){
      try{built=buildApproximateObservedPosition(builderInput,{reason:String(error.message??error)});}
      catch(conditionalError){
      // Give all known missing/conflicting paths at once, without supplying
      // values or making the unchanged authoritative reconstruction permissive.
      try{error.observedPositionDiagnostics=collectObservedPositionDiagnostics(builderInput);}catch{}
      throw conditionalError;
      }
    }
    const actualLegal=observed.actions.find(action=>action.room===source.room&&action.rqid===source.rqid&&action.token===source.token).legalActions;
    timingSpan('simulation.validation',{stage:'authored-actions'}).run(()=>{for(const branch of cases.flatMap(entry=>entry.branches))validateChoice({...actualLegal,side:{pokemon:actualLegal.pokemon}},branch.ourActions);});
    const normalized=cases.map(entry=>({...entry,branches:entry.branches.map(branch=>({...branch,ourActions:bindObservedActions(branch.ourActions,built),...(branch.continuations?{continuations:branch.continuations.map(step=>({...step,...(step.ourActions?{ourActions:bindObservedActions(step.ourActions,built,{replacement:true})}:{})}))}:{})}))}));
    core={position:built.position,...(batch?{cases:normalized}:{branches:normalized[0].branches,seeds:request.seeds}),hypotheses:built.assumptions};provenance=built.provenance;
    check(input.evidenceContext.turn===undefined||input.evidenceContext.turn===core.position.turn,'Simulation evidence turn changed');
    // Reconcile after all reads and team loading, before isolated research.
    exactSource(unwrap(await read(descriptor,{op:'turn-status'})),source);
  }
  check(input.evidenceContext?.turn===undefined||input.evidenceContext.turn===core.position.turn,'Simulation evidence turn differs from normalized position');
  check(deadline>Date.now(),'Bounded native simulation deadline exhausted before engine');
  check(!signal?.aborted,'Simulation cancelled before engine');
  stage='engine';
  const native=await (run??(batch?runTurnSimulationBatch:runTurnSimulation))(core,{timeoutMs:Math.min(3500,deadline-Date.now()),signal});
  check(Date.now()<=deadline,'Bounded native simulation deadline exhausted after engine');
  check(!signal?.aborted,'Simulation cancelled after engine');
  // A batch can do more research than one case. Reconcile again before its
  // result can become evidence; a replaced or already-sent request is refused.
  if(batch&&request.kind==='observed')exactSource(unwrap(await read(join(workspace,'cache','showdown-session.json'),{op:'turn-status'})),request.source);
  check(Date.now()<=deadline,'Bounded native simulation deadline exhausted during final reconciliation');
  check(!signal?.aborted,'Simulation cancelled during final reconciliation');
  const wrap=(value,original,normalized)=>({...value,source:provenance,submittedBranches:original.branches,testedBranches:normalized.branches,loadedManifest:structuredClone(LOADED_MANIFEST)});
  if(batch)check(Array.isArray(native.cases)&&native.cases.length===request.cases.length,'Native batch result case coverage changed');
  const result=batch?{...native,source:provenance,cases:native.cases.map((entry,index)=>{check(entry.id===request.cases[index].id,'Native batch result case identity changed');return {id:entry.id,result:wrap(entry.result,request.cases[index],core.cases[index])};})}:wrap(native,request,core);
  stage='evidence';
  if(input.evidenceContext){check(typeof recordEvidence==='function','Team-owned simulator evidence writer unavailable');result.calculationRef=await recordEvidence({tool:batch?'simulate_turn_batch':'simulate_turn',input:{request,normalized:core,source:provenance},result:structuredClone(result),context:input.evidenceContext});if(batch)for(const entry of result.cases)entry.result.calculationRef={...result.calculationRef,caseId:entry.id};}
  timingEvent('simulation.outcome',{outcome:'completed'});
  return result;
  }catch(error){timingEvent('simulation.outcome',{outcome:stage==='source'?'refused-before-engine':stage==='evidence'?'evidence-error-after-engine':'engine-error',stage});throw error;}
}
export async function executeSimulation(args,options={}){return executeNativeRequest(args,options);}
export async function executeSimulationBatch(args,options={}){return executeNativeRequest(args,options,true);}
function registerSimulationBatchTool(server,options){
  server.registerTool('simulate_turn_batch',{
    description:'Check 1–3 independent explicitly authored cases against one exact native Champions M-C source. Each case has at most 3 opposing paired-action branches and 3 explicit seeds (27 samples total). Source/team normalization and worker startup are shared; every sample remains an isolated native battle with sequential action resolution. Observed requests are reconciled again after research. No inferred opposing actions, automatic control, authentication or network battle. Finite samples and unknown investments remain hypotheses.',
    inputSchema:simulationBatchToolSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},
  },wrapTimedTool(options.timingRecorder,'simulate_turn_batch',async(args,extra)=>{
    try{const result=await executeSimulationBatch(args,{...options,signal:extra?.signal??options.signal});return timingSpan('simulation.serialization').run(()=>({structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}));}
    catch(error){return simulationRefusal(error);}
  }));
}
export function registerSimulationTools(server,options={}){registerSimulationChoicesTool(server,{...options,wrapHandler:handler=>wrapTimedTool(options.timingRecorder,'simulate_choices',handler)});registerSimulationBatchTool(server,options);server.registerTool('simulate_turn',{description:'Resolve exactly authored complete paired choices in an isolated pinned native Champions M-C engine. Genuine opening entry/Mega order or current state with explicit history assumptions. No move or ability support whitelist; native menu legality controls choice admission. Optional branch continuations provide ordered switch-or-pass pairs for native replacement requests. Stops with explicit turnComplete:false and legal replacement options when no continuation is supplied; never invents an opposing action or entrant. Returns ordered attempts/denials/faints, target removal before retaliation, final state and sampled risks. Explicit seeds and unknown investments remain hypotheses, never KO guarantees. Individual damage ranges/Speed still require calculate_damage/calculate_speed. No authentication, network battle or control mutation.',inputSchema:simulationToolSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},wrapTimedTool(options.timingRecorder,'simulate_turn',async(args,extra)=>{try{const result=await executeSimulation(args,{...options,signal:extra?.signal??options.signal});return timingSpan('simulation.serialization').run(()=>({structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}));}catch(error){return simulationRefusal(error);}}));}

function simulationRefusal(error){
  const diagnostics=error.observedPositionDiagnostics;
  return {isError:true,content:[{type:'text',text:error.message},...(diagnostics?[{type:'text',text:JSON.stringify({observedPositionDiagnostics:diagnostics})}]:[])],
    ...(diagnostics?{structuredContent:{kind:'observed-position-refusal',observedPositionDiagnostics:diagnostics,loadedManifest:structuredClone(LOADED_MANIFEST)}}:{})};
}
