// Genuine archived source -> maintained mechanical history -> unchanged compact
// facade. This adapter owns no model, battle socket, action or SDK capability.
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest,boardDigest} from '../planning/identity.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {createChoiceStateHistory,assembleChoiceState} from '../simulation/choice-state.mjs';
import {executeSimulationChoices} from '../simulation/choice-simulation.mjs';
import {simulationChoicesToolSchema} from '../simulation/choice-schemas.mjs';
import {loadVerifiedSavedModelToolSource} from './model-tool-observed-qualification.mjs';
import {sanitizeResponse} from '../showdown/operator-response.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown'),adapters=new WeakMap();
const clone=structuredClone,HASH=/^[a-f0-9]{64}$/u,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=id=>String(id).replace(/-[a-z0-9]+pw$/u,'');
const need=(ok,message)=>{if(!ok)throw Object.assign(Error(`Compact qualification: ${message}`),{code:'COMPACT_MODEL_TOOL_QUALIFICATION'});};
function safeDiagnostic(value,secrets,limit=500){
  const text=sanitizeResponse({text:String(value??'').slice(0,8192)},{redactValues:secrets}).text;
  return text.replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]').replace(/\b[A-Za-z]:\\[^\s<>"']+/gu,'[redacted-path]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted-secret]')
    .replace(/\b(?:password|authorization|credential|token|sessionId)\s*[:=]\s*[^\s,;]+/giu,'[redacted-secret]')
    .replace(/[\x00-\x1f\x7f]+/gu,' ').slice(0,limit);
}
function nativeDiagnostic(reply,secrets){
  for(const value of [reply?.structuredContent?.reason,reply?.structuredContent?.error,reply?.reason,reply?.error])if(typeof value==='string'&&value.trim())return safeDiagnostic(value,secrets);
  for(const block of (reply?.content??[]).slice(0,4))if(block?.type==='text'&&typeof block.text==='string'&&block.text.trim()){
    let parsed;try{parsed=JSON.parse(block.text);}catch{}
    return safeDiagnostic(parsed?.reason??parsed?.error??parsed?.message??block.text,secrets);
  }
  return 'Native MCP error without a textual reason';
}
function incompleteDiagnostic(result,secrets){
  const reasons=[result?.reason,...(result?.nativeRefusals??[]).slice(0,3).map(row=>row?.reason)].filter(value=>typeof value==='string'&&value.trim());
  return [...new Set(reasons.map(value=>safeDiagnostic(value,secrets)))].join('; ').slice(0,800)||'No complete native coverage returned';
}
async function regular(root,relativePath,limit){
  need(typeof relativePath==='string'&&relativePath&&!isAbsolute(relativePath),'relative evidence path required');
  const path=resolve(root,relativePath),part=relative(root,path);need(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part),'evidence path escapes workspace');
  const info=await lstat(path);need(info.isFile()&&!info.isSymbolicLink()&&info.size<=limit&&await realpath(path)===path,'bounded ordinary evidence file required');
  return readFile(path);
}

async function verifiedPrefix(workspace,source,state){
  const root=await realpath(workspace),board=state.boards[0],room=canonicalEvidenceRoom(source.room);
  need(board.turn===1,'complete genuine start prefix currently supported only for saved turn 1');
  const recordPath=join('cache','team-metrics',`${room}--${source.teamId}.json`),recordBytes=await regular(root,recordPath,2*1024*1024),record=JSON.parse(recordBytes);
  const evidence=record.metadata?.evidence;
  need(record.teamId===source.teamId&&record.roomId===room&&evidence?.kind==='sanitized-events'&&evidence.complete===true&&HASH.test(evidence.sha256??''),'complete exact team-owned events record required');
  const bytes=await regular(root,evidence.path,8*1024*1024),uncompressed=gunzipSync(bytes,{maxOutputLength:16*1024*1024});need(sha(uncompressed)===evidence.sha256,'retained events payload hash differs');
  const document=JSON.parse(uncompressed);
  need(document.kind==='sanitized-events'&&document.complete===true&&document.observedHistory?.started===true&&document.teamId===source.teamId&&document.roomId===room&&document.parentId===canonical(state.actions[0].parentId),'retained event owner or continuity differs');
  need(Array.isArray(document.events)&&document.events.length<=10000,'bounded genuine event stream required');
  const first=document.events.findIndex(e=>e.type==='turn');need(first>=0&&document.events[first].data?.[0]==='1','genuine first-turn boundary required');
  const prefix=document.events.slice(0,first+1),starts=prefix.filter(e=>e.type==='start');
  need(starts.length===1&&!prefix.some(e=>['move','cant','faint','drag','swap','replace'].includes(e.type)),'prefix contains prior action or ambiguous entry history');
  need(prefix.every(e=>object(e)&&typeof e.type==='string'&&(e.type==='request'||Array.isArray(e.data)&&e.data.every(v=>typeof v==='string'))),'complete original protocol event data required');
  return {prefix,proof:{kind:'verified-team-owned-start-to-t1-event-prefix',recordPath:recordPath.replaceAll('\\','/'),recordSha256:sha(recordBytes),archive:evidence.path,archiveSha256:sha(bytes),eventsPayloadSha256:sha(uncompressed),prefixSha256:digest(prefix),events:prefix.length,
    requestedCurrentTurn:board.turn,privateSanitizedRequestsSkipped:prefix.filter(e=>e.type==='request').length,fullHistoryDeclared:true,ownHpPrecision:'retained-private-event-and-exact-current-request',limitation:'The final exact private projection is materialized separately; omitted sanitized request fields are never guessed.'}};
}

function materializePrivateRequest(state){
  const action=state.actions[0],board=state.boards[0],legal=action.legalActions;
  need(action.kind==='turn'&&legal?.teamPreview===false&&!legal.forceSwitch&&legal.active?.length===2&&legal.pokemon?.length===4,'exact normal private legal projection required');
  need(legal.pokemon.every(p=>typeof p.ident==='string'&&typeof p.details==='string'&&typeof p.condition==='string'&&typeof p.ability==='string'&&typeof p.item==='string'&&Array.isArray(p.moves)&&p.moves.length===4),'complete preserved private party fields required');
  return {rqid:action.rqid,side:{id:board.ownSide,pokemon:clone(legal.pokemon)},active:clone(legal.active)};
}

function retainedProof(adapter,result){const entry=adapters.get(adapter)?.receipts.get(result);return entry&&entry.resultSha256===digest(result)?entry:null;}
export function hasCompactModelToolQualificationReceipt(adapter,result){try{return !!retainedProof(adapter,result);}catch{return false;}}
// A negative policy response is not, and can never become, a positive source or
// SDK receipt. The bridges return this exact refusal to the model for inspection.
export function hasCompactModelToolQualificationBudgetStatus(adapter,result){return adapters.get(adapter)?.budgetStatuses.has(result)===true;}

export async function createCompactModelToolQualificationAdapter({workspace=process.cwd(),state,ownTeamText,opponentSheet,provenance,now=Date.now}={}){
  const verified=await loadVerifiedSavedModelToolSource({workspace,state,ownTeamText,opponentSheet,provenance,now});
  need(verified.sourceKind==='retained-native-source','compact qualification requires genuine retained native state');
  const original=verified.original,source=verified.source,board=original.boards[0],prefix=await verifiedPrefix(workspace,source,original),request=materializePrivateRequest(original);
  const observed=clone(verified.reconstruction);
  // Historical time is not a fresh action clock. Preserve original archived
  // facts in the proof and replace only clock metadata in this offline view.
  observed.controlPolicy={...observed.controlPolicy,pending:[]};observed.timing={...observed.timing,requests:[]};
  if(observed.boards[0].clock)observed.boards[0].clock={...observed.boards[0].clock,deadlineAt:null};
  observed.opponentSheets={[board.ownSide==='p1'?'p2':'p1']:clone(opponentSheet)};
  const tracker=createChoiceStateHistory({sessionId:source.sessionId,teamId:source.teamId,room:source.room,epoch:1,teamText:ownTeamText,opposingSheet:opponentSheet});let sequence=0;
  const meta=()=>({sequence:++sequence,epoch:1,connected:true,observedAt:sequence});
  for(const event of prefix.prefix)if(event.type!=='request')tracker.observeLine('|'+event.type+'|'+event.data.join('|'),meta());
  tracker.observeRequest(request,meta());
  const {sessionId,...expected}=source,assembly=assembleChoiceState(tracker.capture({observed,expected,opposingSheet:opponentSheet}));
  need(assembly.coverage.completeHistory&&assembly.coverage.auditedHistory,'verified prefix did not establish supported complete native history');
  const semanticSha256=digest({boardHash:boardDigest(observed.boards[0],original.actions[0].legalActions),known:assembly.hypotheses,facts:assembly.facts}),frozenAt=now(),freezeId=randomUUID();
  const baseContext={kind:'owned-simulation-context-v1',source:clone(source),observed,opposingSheet:clone(opponentSheet),assembly,semanticSha256,frozenAt,choiceAuthority:false};
  const receipts=new WeakMap(),budgetStatuses=new WeakSet(),journal=[],marker={freezeId,source:clone(source),frozenAt,choiceAuthority:false};let trajectory=null;
  const budgetStatus=(entry)=>{
    const result={kind:'research-budget-status',status:trajectory?.status==='pending'?'pending':'budget-used',reason:'The saved-source single simulated trajectory is already reserved or spent; no second native simulation was dispatched.',
      budget:{simulationsUsed:1,simulationsRemaining:0,limits:{simulation:1}},backendAllowed:false,choiceAuthority:false,liveFreshness:false,qualificationScope:'offline-saved-source-policy-emulation',positiveQualificationReceipt:false};
    budgetStatuses.add(result);Object.assign(entry,{status:result.status,settledAt:now(),nativeCalls:[]});return result;
  };
  const reuse=(querySha256,entry)=>{
    if(trajectory?.querySha256!==querySha256||trajectory.status!=='completed'||!trajectory.cached)return null;
    const result=clone(trajectory.cached.result);receipts.set(result,clone(trajectory.cached.proof));Object.assign(entry,{status:'reused',settledAt:now(),resultSha256:digest(result),nativeCalls:[]});return result;
  };
  const sourceProof={kind:'verified-retained-compact-source',saved:clone(verified.sourceProof),registration:clone(verified.registrationProof),prefix:prefix.proof,
    privateProjection:{kind:'lossless-private-legal-projection-materialization',sourceStateSha256:verified.frozenSourceSha256,legalSha256:digest(original.actions[0].legalActions),requestSha256:digest(request),originalRawPacketClaimed:false},
    strictNativeCapture:true,assemblySha256:digest(assembly),originalRawStateUnchanged:true,clockTreatment:'Archived pending and countdown clocks removed only in disclosed offline reconstruction view.'};
  const adapter={
    frozenMarker:()=>clone(marker),
    status:()=>({kind:'compact-model-tool-qualification-adapter',sourceKind:'retained-native-source',frozenSourceSha256:verified.frozenSourceSha256,sourceProof:clone(sourceProof),ready:true,liveFreshness:false,choiceAuthority:false,executed:journal.length,journal:clone(journal),nativeSdkVerified:false,
      simulationBudget:{used:trajectory?1:0,remaining:trajectory?0:1,status:trajectory?.status??'available',scope:'offline-saved-source-policy-emulation'}}),
    receipt(result){const proof=retainedProof(adapter,result);return proof?clone(proof):null;},
    async execute({name,args,signal,deadlineAt,callNative}={}){
      need(name==='simulate_choices'&&typeof callNative==='function'&&Number.isFinite(deadlineAt)&&now()<deadlineAt&&!signal?.aborted,'bounded compact native callback required');
      const input=simulationChoicesToolSchema.parse(args);need(['sessionId','teamId','room','rqid','token'].every(k=>input.source[k]===source[k]),'authored compact source differs from saved source');
      need(input.analysis==='current'&&input.freezeId===undefined||input.analysis==='frozen'&&input.freezeId===freezeId,'compact frozen marker differs');
      const nativeCalls=[],startedAt=now(),authoredInputSha256=digest(args),entry={name,authoredInputSha256,startedAt,deadlineAt,status:'pending'},secrets=[source.sessionId,source.token,freezeId];journal.push(entry);
      const querySha256=digest({semanticSha256,args});
      if(trajectory)return reuse(querySha256,entry)??budgetStatus(entry);
      const context={...clone(baseContext),liveFreshness:input.analysis==='current',...(input.analysis==='frozen'?{freezeId}:{})};let evidence;
      let guarded=false,ownsTrajectory=false;
      try{
      const result=await executeSimulationChoices(input,{workspace,now,deadlineAt,signal,loadTeam:async()=>({team:Teams.import(ownTeamText)}),
        call:async(_path,command)=>{need(command.op==='simulation-context'&&command.mode===input.analysis&&digest(command.source)===digest(source)&&(!command.freezeId||command.freezeId===freezeId),'offline source callback changed scope');return {ok:true,result:clone(context)};},
        callTool:async(tool,arguments_,options)=>{
          need(['calculate_damage','calculate_speed','simulate_turn'].includes(tool)&&now()<deadlineAt&&!options?.signal?.aborted,'only bounded actual native research is allowed');
          if(tool==='simulate_turn'){
            // Synchronous reservation immediately before the actual callback.
            // Local source/schema/menu failures above this point cost no native
            // trajectory; failed/uncertain dispatch below never refunds it.
            if(trajectory){guarded=true;throw Object.assign(Error('Saved-source simulation trajectory already reserved or spent'),{code:'COMPACT_QUALIFICATION_BUDGET'});}
            trajectory={querySha256,status:'pending',dispatchedAt:now()};ownsTrajectory=true;
          }
          const call={name:tool,inputSha256:digest(arguments_),startedAt:now()};nativeCalls.push(call);
          const reply=await callNative({name:tool,arguments:clone(arguments_)},undefined,{signal:options?.signal,timeout:Math.max(1,deadlineAt-now())});
          call.settledAt=now();call.resultSha256=digest(reply);need(now()<deadlineAt&&!signal?.aborted,'actual native research failed or arrived late');
          need(!reply?.isError,`actual native research failed or arrived late: ${nativeDiagnostic(reply,secrets)}`);return reply;
        },recordEvidence:async record=>{evidence=clone(record);return {tool:'simulate_choices',teamId:source.teamId,offlineQualificationOnly:true,sha256:digest(record)};}});
      if(guarded)return reuse(querySha256,entry)??budgetStatus(entry);
      need(result.kind==='native-choice-outcome-v1'&&result.coverage?.completeBranchCoverage===true&&
        result.coverage.worlds===1&&result.coverage.branches===1&&result.coverage.seedsPerWorld===1&&result.coverage.samples===1&&result.coverage.requestedSamples===1&&
        result.authoredPair?.id==='primary'&&typeof result.outcome?.turnComplete==='boolean'&&
        nativeCalls.filter(c=>c.name==='simulate_turn').length===1&&evidence,
        `complete single compact native outcome unavailable: ${incompleteDiagnostic(result,secrets)}`);
      // This is an archived observed source, regardless of the facade's local
      // source reconciliation. It can never advertise a fresh live request.
      result.source={...result.source,liveFreshness:false,choiceAuthority:false,qualificationScope:'verified-saved-native-source-only'};
      result.offlineQualification={historicalFacts:true,serverAcceptance:false,executionObserved:false,sourceProofSha256:digest(sourceProof)};
      const settledAt=now(),proof={version:2,kind:'compact-model-tool-offline-qualification-receipt',researchPolicy:'single-outcome',name,authoredInputSha256,resultSha256:digest(result),frozenSourceSha256:verified.frozenSourceSha256,
        sourceProvenanceVerified:true,readinessVerified:true,completeBranchCoverage:true,sourceProof:clone(sourceProof),nativeCalls:clone(nativeCalls),startedAt,settledAt,deadlineAt,pairedSimulation:true,modelAuthoredChoices:true,
        assumptionsAssembledBy:'maintained-native-history-and-compact-facade',evidenceSha256:digest(evidence),evidenceWritten:false,nativeSdkVerified:false,liveFreshness:false,choiceAuthority:false};
      Object.assign(entry,{status:'complete',settledAt,resultSha256:proof.resultSha256,nativeCalls:clone(nativeCalls)});receipts.set(result,proof);
      trajectory.status='completed';trajectory.cached={result:clone(result),proof:clone(proof)};return result;
      }catch(error){
        Object.assign(entry,{status:'failed',settledAt:now(),nativeCalls:clone(nativeCalls),reason:safeDiagnostic(error?.message??error,secrets)});
        if(ownsTrajectory&&trajectory.status!=='completed')trajectory.status='failed';
        throw error;
      }
    },
  };
  adapters.set(adapter,{receipts,budgetStatuses});return Object.freeze(adapter);
}
