// The official CLI owns subscription authentication. The native controller owns
// battle authority, current source validation, research and command execution.
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createCodexSessionTransport} from './codex-session-transport.mjs';
import {createCodexSessionContext,rehydrateCodexSessionContext} from './codex-session-context.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {prepareCodexDecisionContext,decodeCodexDecision} from './codex-wire.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const generationReceipts=new WeakMap();
const REFRESH_MIN_REMAINING_MS=35000,CONTEXT_FRAME_TOKEN_RESERVE=4096;
export function hasCodexCliGenerationReceipt(provider,response){return generationReceipts.get(provider)?.has(response)===true;}
export function createCodexCliDecisionProvider({workspace=process.cwd(),model,reasoningEffort,artifactDirectory=resolve(workspace,'cache/codex-cli-transient'),
  transportFactory,contextMode='session',now=Date.now,...transportOptions}={}){
  if(contextMode!=='session')throw Object.assign(new Error('Unsupported Codex context mode.'),{code:'invalid_configuration'});
  const expectedFactory=createCodexSessionTransport;
  transportFactory??=expectedFactory;
  const transport=transportFactory({workspace,model,reasoningEffort,artifactDirectory,now,...transportOptions});
  const retained=contextMode==='session'?createCodexSessionContext():undefined;
  let checked,scopeKey,retainedProof,decisionInFlight=false;
  async function reset(){retained?.reset();scopeKey=undefined;retainedProof=undefined;await transport.reset?.();}
  async function close(){retained?.reset();scopeKey=undefined;retainedProof=undefined;await transport.close?.();}
  async function preflight(){if(decisionInFlight)throw Object.assign(new Error('A decision is already in flight.'),{code:'provider_busy'});checked=undefined;await reset();const value=await transport.preflight();checked=Object.freeze({...value,contextMode});return {...checked};}
  async function callDecisionOwned(request){
    if(!checked||checked.authMode!=='chatgpt')throw Object.assign(new Error('Codex ChatGPT authentication must be checked before a decision.'),{code:'preflight_required'});
    const admit=()=>{if(request.signal?.aborted)throw Object.assign(new Error('Codex decision was aborted.'),{code:'aborted'});
      if(!Number.isFinite(request.deadlineAt)||now()>=request.deadlineAt)throw Object.assign(new Error('Codex decision exceeded its original deadline.'),{code:'deadline_exceeded'});};
    admit();
    if(request.modelTools&&contextMode!=='session')throw Object.assign(new Error('Model-owned MCP tools require the explicit retained session transport.'),{code:'invalid_configuration'});
    const startedAt=now();
    const prepared=prepareCodexDecisionContext(request);
    const presentationPreparedAt=now();
    admit();
    let packet,proof,refresh;
    if(retained){
      // A lost/compacted CLI thread cannot satisfy previously committed refs.
      if(retainedProof&&typeof transport.status==='function'&&transport.status().active!==true)await reset();
      const scope=request.sessionScope;
      if(!scope||typeof scope.parentId!=='string'||!scope.parentId||typeof scope.teamId!=='string'||!scope.teamId)throw Object.assign(new Error('A host-owned BO3 and team scope are required.'),{code:'session_scope_required'});
      const key=JSON.stringify([scope.sessionId??null,scope.teamId,scope.parentId,scope.gameId??null]);
      if(scopeKey!==undefined&&scopeKey!==key)await reset();
      scopeKey=key;
      const assemble=()=>{
        packet=retained.prepare({instructions:prepared.instructions,input:prepared.input,schema:prepared.schema,scope});
        proof=rehydrateCodexSessionContext(packet,retainedProof);
        if(proof.instructions!==prepared.instructions||!isDeepStrictEqual(JSON.parse(proof.input),restoreContextPayload(JSON.parse(prepared.input)))||!isDeepStrictEqual(proof.schema,prepared.schema)){
          throw Object.assign(new Error('Retained source failed exact reconstruction.'),{code:'session_source_mismatch'});
        }
      };
      assemble();
      const state=transport.status?.(),usageKnown=state?.active===true&&state.tokenUsageKnown===true&&
        Number.isSafeInteger(state.lastInputTokens)&&state.lastInputTokens>=0&&Number.isSafeInteger(state.lastOutputTokens)&&state.lastOutputTokens>=0&&
        Number.isSafeInteger(state.modelContextWindowTokens)&&state.modelContextWindowTokens>0;
      // A byte is a conservative token upper bound for the new UTF8 packet.
      // This projects against the CLI's ACTUAL reported token window; it is not
      // another application byte cap or a claim to an exact tokenizer count.
      const projected=usageKnown?state.lastInputTokens+state.lastOutputTokens+packet.metadata.deliveredBytes+CONTEXT_FRAME_TOKEN_RESERVE:0;
      if(retainedProof&&usageKnown&&projected>=state.modelContextWindowTokens){
        const remainingMs=request.deadlineAt-now();
        const evidence={telemetrySource:'codex-cli-session',contextMode,modelAttempted:false,sessionContextRefreshRequired:true,
          sessionRefreshReason:'reported-model-window',sessionRefreshPreviousInputTokens:state.lastInputTokens,sessionRefreshPreviousOutputTokens:state.lastOutputTokens,
          sessionRefreshReportedWindowTokens:state.modelContextWindowTokens,sessionRefreshProjectedTokenUpperBound:projected,
          sessionRefreshNextPacketBytes:packet.metadata.deliveredBytes,sessionRefreshRemainingMs:Math.max(0,remainingMs),sessionRefreshMinimumRemainingMs:REFRESH_MIN_REMAINING_MS,
          sessionRefreshOriginalDeadlineAt:request.deadlineAt};
        if(request.contextRefreshAllowed!==true||state.busy===true)throw Object.assign(new Error('Context refresh requires current controller admission with no uncertain native submission.'),{code:'session_context_refresh_unsafe',telemetry:evidence});
        if(remainingMs<REFRESH_MIN_REMAINING_MS)throw Object.assign(new Error('Original decision window cannot safely refresh the model context.'),{code:'session_context_refresh_window',telemetry:evidence});
        // Only the model thread is closed. Native state, writer ownership,
        // reservations and the original action deadline are never modified.
        await reset();scopeKey=key;admit();
        if(request.deadlineAt-now()<REFRESH_MIN_REMAINING_MS)throw Object.assign(new Error('Original model window became insufficient while closing the old thread.'),{code:'session_context_refresh_window',telemetry:evidence});
        assemble();
        refresh={...evidence,modelAttempted:true,sessionContextRefreshed:true,sessionRefreshCompletedAt:now(),sessionRefreshFullSnapshot:true};
      }
    }
    let response,decoded;
    try{
      response=await transport.callDecision({...request,...(packet?{requiresRetainedSession:packet.metadata.baseSequence!==null}:{}),instructions:packet?.instructions??prepared.instructions,input:packet?.input??prepared.input,schema:prepared.schema});
      decoded=decodeCodexDecision(response.decision,{metadata:prepared.metadata});
      if(request.signal?.aborted||now()>=request.deadlineAt)throw Object.assign(new Error('Codex decision exceeded its original deadline.'),{code:'deadline_exceeded',telemetry:response.telemetry});
      packet?.commit();
      if(proof)retainedProof=proof.retained;
    }catch(error){packet?.invalidate();await reset();throw error;}
    const result={decision:decoded.decision,telemetry:{...response.telemetry,providerStartedAt:startedAt,presentationPreparedAt,providerFinishedAt:now(),
      contextMode,...(refresh??{}),...(packet?{sessionSourceRehydrated:true,sessionSourceSha256:sha(prepared.input),
        retainedStaticReferences:packet.metadata.staticRefs.length,sessionNewInputBytes:packet.metadata.deliveredInputBytes,
        sessionFullInputBytes:packet.metadata.fullInputBytes,sessionSavedInputBytes:packet.metadata.savedInputBytes,
        sessionNewPacketBytes:packet.metadata.deliveredBytes,sessionFullPacketBytes:packet.metadata.fullBytes,
        sessionSavedPacketBytes:packet.metadata.savedBytes,sessionContextSequence:packet.metadata.sequence,
        sessionContextMetadata:packet.metadata}:{}),
      presentationMode:prepared.metadata.format,
      nativeInputSha256:sha(request.input),nativeInstructionsSha256:sha(request.instructions),nativeSchemaSha256:sha(request.schema),
      modelInputSha256:sha(packet?.input??prepared.input),modelInstructionsSha256:sha(packet?.instructions??prepared.instructions),modelSchemaSha256:sha(prepared.schema),
      inputPreserved:(packet?.input??prepared.input)===request.input,wireDecoded:decoded.metadata.format==='structured-command',
      presentationReason:prepared.metadata.reason,sourceInputBytes:prepared.metadata.sourceInputBytes,sourceInstructionsBytes:prepared.metadata.sourceInstructionsBytes,
      outputSchemaBytes:Buffer.byteLength(JSON.stringify(prepared.schema)),preparedInstructionsBytes:Buffer.byteLength(prepared.instructions),
      commandBytes:decoded.metadata.commandBytes??0}};
    if(transportFactory===expectedFactory&&now===Date.now&&!transportOptions.spawn&&!transportOptions.terminateProcess)generationReceipts.get(decisionProvider).add(result);
    return result;
  }
  async function callDecision(request){
    if(decisionInFlight)throw Object.assign(new Error('A decision is already in flight.'),{code:'provider_busy'});
    decisionInFlight=true;try{return await callDecisionOwned(request);}finally{decisionInFlight=false;}
  }
  const decisionProvider=Object.freeze({kind:'codex-cli',model,reasoningEffort,callDecision});
  generationReceipts.set(decisionProvider,new WeakSet());
  async function qualifyCodex(options={}){
    if(options.decisionMode!==undefined&&options.decisionMode!=='model-tools')throw Object.assign(new Error('Only model-owned MCP qualification is supported.'),{code:'invalid_configuration'});
    const {qualifyModelTools}=await import('./model-tool-qualification.mjs');
    try{return await qualifyModelTools({provider:{decisionProvider,preflight,contextMode,reset},workspace,...options,decisionMode:'model-tools'});}finally{await reset();}
  }
  return Object.freeze({decisionProvider,preflight,qualifyCodex,contextMode,reset,close});
}
