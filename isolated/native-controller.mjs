// A host controller for one already-authorized BO3. The maintained operator is
// the sole battle writer; model output never receives its private capabilities.
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {rebudgetDecisionContext,updateStrategicMemory} from './decision-context.mjs';
import {createObservedPlanningSheetCache, observedPlanningSheet} from '../planning/source.mjs';
import {digest,boardDigest,requestDigest} from '../planning/identity.mjs';
import {timingRequestKey} from '../observability/timing.mjs';
import {verifyTeamGuidance} from './team-guidance.mjs';
import {MAX_CONTEXT_BYTES,SESSION_REFRESH_TELEMETRY_FIELDS} from './context-limits.mjs';
import {preparePreviousGameSummary} from './game-summary.mjs';
import {buildModelToolContext,runModelToolCycle} from './model-tool-cycle.mjs';

const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const check = (ok, message) => { if (!ok) throw new Error(message); };
function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 4 && plain(current) && current.result !== undefined && current.sessionId === undefined && current.status === undefined && current.reason === undefined; depth++) current = current.result;
  return current;
}
const failed = value => Boolean(value?.error || value?.ok === false || value?.isError === true);
const available = action => action?.actionable !== false && !['sent','uncertain','accepted','reserved','submitting','execution-observed'].includes(action?.submissionStatus);
const shortRoom = room => room?.replace(/-[a-z0-9]+pw$/u, '');
const exactFields = (value, fields) => plain(value) && Object.keys(value).every(key => fields.includes(key));
const aborted = signal => signal?.aborted === true;
const DEADLINE_GUARD = Symbol('isolated-controller-deadline-guard');
const BASE_TELEMETRY_FIELDS = new Set(['startedAt','dispatchAt','packetPublishedAt','packetReadAt','submittedAt','completedAt','parseStartedAt','parseCompletedAt','finishedAt','deadlineAt','requestBytes','inputBytes','outputBytes','parseDurationMs','requestWallTimeMs','errorCode','telemetrySource','controllerModelStartedAt','controllerModelDeadlineAt','controllerModelFailedAt','controllerAbortSettledAt','controllerAbortGraceMs','controllerErrorCode','transportErrorCode']);
const CODEX_TELEMETRY_FIELDS = new Set([...BASE_TELEMETRY_FIELDS,'spawnStartedAt','spawnedAt','stdinStartedAt','stdinCompletedAt','firstEventAt','firstTextAt','finalReceivedAt','exitAt','exitCode','eventCount','streamBytes','inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens','startupMs','stdinDurationMs','firstEventLatencyMs','completionLatencyMs','authenticationMethod','preflightCompletedAt','cliVersion','attempts','networkRetryCount','providerErrorCode','initialFailureCode']);
for(const key of ['providerStartedAt','presentationPreparedAt','providerFinishedAt','presentationMode','nativeInputSha256','nativeInstructionsSha256','nativeSchemaSha256','modelInputSha256','modelInstructionsSha256','modelSchemaSha256','inputPreserved','wireDecoded','presentationReason','sourceInputBytes','sourceInstructionsBytes','outputSchemaBytes','preparedInstructionsBytes','commandBytes'])CODEX_TELEMETRY_FIELDS.add(key);
for(const key of ['sourceSha256','instructionsSha256','requestDurationMs','applicationRetryCount','providerRetryCountKnown','skillCatalogOmitted','omittedSkillCount','requestedServiceTier','requestedWireServiceTier','cliStderrFirstDiagnosticAt','cliReportedTransportError','cliReportedHttpStatus'])CODEX_TELEMETRY_FIELDS.add(key);
for(const key of ['contextMode','sessionTurnIndex','sessionScopeSha256','sessionThreadSha256','sessionTurnCompleted','sessionProcessOwned','sessionSourceRehydrated','sessionSourceSha256','retainedStaticReferences','sessionNewInputBytes','sessionFullInputBytes','sessionSavedInputBytes','sessionNewPacketBytes','sessionFullPacketBytes','sessionSavedPacketBytes','sessionContextSequence','sessionPriorRequestBytes','sessionReused','compactionCount','modelContextWindowTokens','sessionCumulativeInputTokens','sessionCumulativeCachedInputTokens','sessionCumulativeOutputTokens','sessionCumulativeReasoningTokens'])CODEX_TELEMETRY_FIELDS.add(key);
for(const key of ['modelAttempted','coldContextBytes','remainingModelMs','minimumColdLargeModelMs'])CODEX_TELEMETRY_FIELDS.add(key);
for(const key of SESSION_REFRESH_TELEMETRY_FIELDS)CODEX_TELEMETRY_FIELDS.add(key);
function safeTelemetry(value,secret,providerKind) {
  if (!plain(value)) return {};
  const fields=CODEX_TELEMETRY_FIELDS;
  return Object.fromEntries(Object.entries(value).filter(([key,item]) => fields.has(key) && (item === null || providerKind==='codex-cli'&&typeof item==='boolean' || typeof item === 'number' && Number.isFinite(item) && item >= 0 || typeof item === 'string' && item.length <= 256 && /^[A-Za-z0-9_.:/ -]*$/u.test(item) && !(typeof secret==='string'&&secret&&item.includes(secret)))));
}
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8');
const DIAGNOSTIC_PRIVATE=/^(?:apiKey|api_key|authorization|password|credentials?|token|controllerLease|controlLease|readReceipt|sessionId|watchUrl|accessUrl|assertion)$/iu;
function diagnosticValue(value,secret,depth=0){
  check(depth<=32,'Controller diagnostic exceeds its structural bound');
  if(typeof value==='string')return (typeof secret==='string'&&secret?value.split(secret).join('[redacted-secret]'):value).replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted-secret]').replace(/((?:battle|game-bestof3)-[a-z0-9-]+-\d+)-[a-z0-9]+pw\b/gu,'$1');
  if(Array.isArray(value))return value.map(row=>diagnosticValue(row,secret,depth+1));
  if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key,item])=>!DIAGNOSTIC_PRIVATE.test(key)&&item!==undefined).map(([key,item])=>[key,diagnosticValue(item,secret,depth+1)]));
  check(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value),'Controller diagnostic requires bounded JSON');
  return value;
}
const preparationCode=error=>typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)?error.code:'CONTROLLER_PREPARATION_FAILED';
function responseError(stage,code,message,state){
  const error=new Error(message);error.responseStage=stage;error.code=code;
  if(state)error.responseState=state;
  return error;
}
async function deadlineBound(run,{deadlineAt,now,signal,captureAbortTelemetry=false}) {
  const controller = new AbortController(); let timer,onAbort,settled;
  const startedAt=now();
  const guardFailure=()=>{
    const error=new Error('Isolated operation unavailable before its deadline');
    error.code=aborted(signal)?'aborted':'deadline_exceeded';
    error[DEADLINE_GUARD]={startedAt,deadlineAt,failedAt:now()};
    return error;
  };
  const expiry = new Promise((_,reject) => {
    onAbort = () => {
      const error=guardFailure();controller.abort();reject(error);
    };
    signal?.addEventListener('abort',onAbort,{once:true});
    timer = setTimeout(onAbort,Math.max(0,deadlineAt-now()));
  });
  try {
    check(!aborted(signal) && now() < deadlineAt,'Isolated operation deadline unavailable');
    const pending=Promise.resolve().then(() => run(controller.signal)).then(value=>{settled={value};return value;},error=>{settled={error};throw error;});
    try{
      const value=await Promise.race([pending,expiry]);
      return value;
    }catch(error){
      if(captureAbortTelemetry&&error?.[DEADLINE_GUARD]){
        // The guard aborts at the original model deadline. Collect only the
        // already-aborted operation's diagnostics for at most 25 ms; a late
        // result can never become an authorized choice.
        let drain;
        try{if(!settled)await Promise.race([pending.catch(()=>{}),new Promise(resolve=>{drain=setTimeout(resolve,25);})]);}
        finally{clearTimeout(drain);}
        const inner=settled?.error,telemetry=inner?.telemetry??settled?.value?.telemetry;
        error.telemetry={...(plain(telemetry)?telemetry:{}),
          telemetrySource:plain(telemetry)?'transport-with-controller-deadline-guard':'controller-deadline-guard',
          controllerModelStartedAt:startedAt,controllerModelDeadlineAt:deadlineAt,controllerModelFailedAt:error[DEADLINE_GUARD].failedAt,
          controllerAbortSettledAt:settled?now():null,controllerAbortGraceMs:25,controllerErrorCode:error.code,
          ...(typeof inner?.code==='string'&&/^[a-z_]{1,50}$/u.test(inner.code)?{transportErrorCode:inner.code}:{})};
      }
      throw error;
    }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',onAbort); }
}

function terminalState(state, parentId) {
  if (state.stopped || state.connected !== true || state.authenticated !== true) return {status:'stopped',reason:'battle-connection-unavailable'};
  const parents = (state.rooms ?? []).filter(room => room.id?.startsWith('game-bestof3-'));
  const parent = parentId ? parents.find(room => shortRoom(room.id) === shortRoom(parentId)) : parents.length === 1 ? parents[0] : undefined;
  const search = state.search;
  const noGames = search && Object.hasOwn(search,'games') && (search.games === null || plain(search.games) && Object.keys(search.games).length === 0);
  const persistence = state.actionPlanPersistence;
  const writesReady = !persistence || persistence.pending === 0 && persistence.failures === 0 && persistence.dropped === 0;
  const idle = search && Array.isArray(search.searching) && search.searching.length === 0 && noGames && !state.awaitingSet && !state.searchPending && !state.switchingTeam && !state.savingReplays && writesReady &&
    Array.isArray(state.actions) && state.actions.every(action => action.kind === 'ready' && shortRoom(action.room) === shortRoom(parent?.id)) &&
    !parents.some(room => room.ended !== true) && !(state.rooms ?? []).some(room => shortRoom(room.parentId) === shortRoom(parent?.id) && room.ended !== true);
  if (parent?.ended === true && ['win','tie'].includes(parent.result?.type) && idle) return {status:'review-required',parentId:parent.id,officialIdle:true,result:structuredClone(parent.result)};
  return null;
}

/** Caller supplies an already armed and claimed createOperator instance.
 * This object cannot authenticate, search, change teams, publish or stop a
 * client. A completed set permanently pauses it for the external review cycle. */
export function createNativeController({operator,identity,ownTeamText,apiConfig,decisionProvider,skillVersion,skillSha256,matchupGuidance,
  callDecision,now = Date.now,commitReserveMs = 5000,maxModelMs = 40000,
  maxContextBytes = MAX_CONTEXT_BYTES,maxRichContextBytes = Math.max(maxContextBytes,48000),codexContextMode='session',decisionMode='model-tools',fastFirst = false,singleCallResearch = false,singleCallResearchMinRemainingMs = 0,compactHostAdoption = false,manualReady = false,previewClockWaitMs = 0,researchProvider,genericHypothesisProvider,automaticTacticalEvidence = false,teamGuidance,background,onEvent = () => {},onEvidence} = {}) {
  check(operator && typeof operator.dispatch === 'function','An armed maintained operator is required');
  check(plain(identity) && typeof identity.sessionId === 'string' && /^[a-f0-9]{64}$/u.test(identity.teamId),'Exact approved session/team identity is required');
  const team = Teams.import(ownTeamText ?? '');
  check(team?.length === 6 && createHash('sha256').update(Teams.pack(team)).digest('hex') === identity.teamId,'Own team export differs from the approved exact six');
  check(apiConfig===undefined&&callDecision===undefined&&researchProvider===undefined&&genericHypothesisProvider===undefined&&!compactHostAdoption,'Only the model-owned Codex CLI provider is supported');
  check(exactFields(decisionProvider,['kind','model','reasoningEffort','callDecision'])&&decisionProvider.kind==='codex-cli'&&typeof decisionProvider.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(decisionProvider.model)&&['low','medium','high'].includes(decisionProvider.reasoningEffort)&&typeof decisionProvider.callDecision==='function','Explicit Codex CLI provider required');
  check(decisionMode==='model-tools'&&codexContextMode==='session'&&fastFirst===false&&singleCallResearch===false&&automaticTacticalEvidence===false,'The retained model-owned MCP workflow is required');
  callDecision=decisionProvider.callDecision.bind(decisionProvider);
  const externalProvider=true,codex=true,providerKind='codex-cli',model=decisionProvider.model,reasoningEffort=decisionProvider.reasoningEffort,secret=undefined;
  const providerArguments={model,reasoningEffort},telemetryFor=value=>safeTelemetry(value,secret,providerKind);
  check(background===undefined||['setMainBusy','setDecisionContext','notesFor'].every(name=>typeof background?.[name]==='function'),'Read-only pondering requires model-owned MCP');
  const backgroundHook=(name,...args)=>{try{return background?.[name](...args);}catch{return null;}};
  check(typeof now==='function'&&typeof onEvent==='function'&&typeof onEvidence==='function','Clock, events and durable evidence required');
  check(Number.isInteger(commitReserveMs)&&commitReserveMs>=5000&&commitReserveMs<=15000,'Commit reserve must be 5000–15000 ms');
  check(Number.isInteger(maxModelMs)&&maxModelMs>=100&&maxModelMs<=120000,'Model budget must be 100–120000 ms');
  check(Number.isInteger(maxContextBytes)&&maxContextBytes>=4000&&maxContextBytes<=MAX_CONTEXT_BYTES,'Context byte limit must be 4000-8388608');
  check(typeof manualReady==='boolean','Manual readiness requirement must be boolean');
  check(Number.isInteger(previewClockWaitMs)&&previewClockWaitMs>=0&&previewClockWaitMs<=2000,'Preview clock acquisition must be 0–2000 ms');
  check(teamGuidance===undefined||verifyTeamGuidance(teamGuidance,{teamId:identity.teamId,skillSha256}),'Private team guidance differs from reviewed receipt');
  const sink=onEvidence;onEvidence=value=>sink({...value,provider:{kind:providerKind,model,reasoningEffort,selectionEvidence:'host-declared-request'}});
  const sheets = createObservedPlanningSheetCache(), prefix = 'iso_' + randomUUID().replaceAll('-','').slice(0,16);
  let sequence = 0,initialized = false,busy = false,paused = null,parentId,lastOrigin,memory = {},fullStatus,pendingPreviewClockRead,pendingGameSummary;
  const consumed = new Set();
  const modelRequests = new Set();
  const decisionAttempts = new Set(),recoveryAttempts = new Set(),requestBudgets = new Map(),recoveryPermit = {};
  const readinessReservations = new Set();
  let modelToolCatalog;
  const id = phase => `${prefix}_${++sequence}_${phase}`;
  const emit = (name,fields = {}) => {
    if(externalProvider){name=name.replace(/^decision\.api-/u,'decision.provider-');fields={...fields,providerKind,...(Object.hasOwn(fields,'apiAttempted')?{providerAttempted:fields.apiAttempted,apiAttempted:false}:{})};}
    const binding = Object.fromEntries(['teamId','parentId','room','rqid','requestDigest','requestKey'].filter(key => fields[key] !== undefined).map(key => [key,fields[key]]));
    try { onEvent({version:1,name,type:name,at:now(),...fields,...(Object.keys(binding).length ? {binding} : {})}); }
    catch { /* Recording cannot alter a deadline. */ }
  };
  const dispatch = q => operator.dispatch(q,{inputReceivedAt:now()});
  function verify(state, full = false) {
    check(!failed(state) && state?.sessionId === identity.sessionId && state.connected === true && state.authenticated === true && !state.stopped,'Expected battle connection is unavailable');
    for (const hash of [state.teamSha256,state.teamId]) if (hash !== undefined) check(hash === identity.teamId,'Approved team identity changed');
    if (full) check(state.teamSha256 === identity.teamId && (identity.account === undefined || state.username === identity.account),'Approved session/account/team changed');
    return sheets.observe({...state,teamId:identity.teamId},identity);
  }
  async function readFull() {
    const reply = await dispatch({id:id('status'),op:'status',full:true});
    check(!failed(reply),'Authoritative status read failed');
    return fullStatus = verify(unwrap(reply),true);
  }
  async function readTurn() {
    const reply = await dispatch({id:id('turn'),op:'turn',full:true});
    check(!failed(reply),'Authoritative turn read failed');
    return verify(unwrap(reply));
  }
  async function completeSheet(state, action) {
    let board = state.boards?.find(board => board.room === action.room);
    check(board,'Current battle board is unavailable');
    let sheet;
    try { sheet = observedPlanningSheet(board,undefined,action.room); }
    catch {
      await readFull();
      check(fullStatus.rooms?.some(room => room.id === action.room && room.ended === false && (!room.teamId || room.teamId === identity.teamId)),'Sheet is not owned by the current live child');
      sheet = observedPlanningSheet(board,fullStatus,action.room);
      const foe = board.ownSide === 'p1' ? 'p2' : 'p1';
      state = sheets.observe({...state,boards:state.boards.map(value => value === board ? {...value,opponentSheets:{[foe]:sheet}} : value)},identity);
      board = state.boards.find(value => value.room === action.room);
    }
    check(Array.isArray(sheet) && sheet.length === 6,'Complete observed opposing six are required');
    return {state,sheet,board};
  }
  function cutoff(state,action) {
    const rows = [...(state.timing?.requests ?? []),...(state.controlPolicy?.pending ?? [])].filter(row => row.token === action.token && (row.room === undefined || shortRoom(row.room) === shortRoom(action.room)) && (row.rqid === undefined || row.rqid === action.rqid));
    const cutoffs = rows.map(row => row.cutoffAt).filter(Number.isFinite);
    check(cutoffs.length > 0,'Authoritative current request cutoff is unavailable');
    return Math.min(...cutoffs);
  }
  function verifiedLongPreviewClock(action){
    const clock=action.clock,at=now();
    return clock?.source==='server-timer-observation'&&Number.isFinite(action.receivedAt)&&Number.isFinite(clock.observedAt)&&
      clock.observedAt>=action.receivedAt&&clock.observedAt<=at&&Number.isFinite(clock.deadlineAt)&&clock.deadlineAt-clock.observedAt>=90000&&
      clock.deadlineAt>at&&(clock.rqid===undefined||clock.rqid===action.rqid)&&(clock.revision===undefined||clock.revision===action.revision);
  }
  async function previewRead(query,deadlineAt){
    const pending=Promise.resolve().then(()=>dispatch(query));
    pendingPreviewClockRead=pending;
    void pending.finally(()=>{if(pendingPreviewClockRead===pending)pendingPreviewClockRead=undefined;}).catch(()=>{});
    let timer;
    try{return await Promise.race([pending,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(responseError('preview-clock-admission','PREVIEW_CLOCK_READ_TIMEOUT','Bounded preview clock read remains unresolved')),Math.max(1,deadlineAt-now()));})]);}
    finally{clearTimeout(timer);}
  }
  function previewAction(state,original){
    const matches=(state.actions??[]).filter(row=>shortRoom(row.room)===shortRoom(original.room)&&row.rqid===original.rqid&&row.token===original.token&&row.kind==='preview'&&available(row));
    return matches.length===1?matches[0]:undefined;
  }
  async function admitPreviewClock(state,action){
    if(!previewClockWaitMs||action.kind!=='preview')return {state,action};
    // This option is meaningful only with an explicitly loaded extended policy.
    // Until a same-request 90-second observation exists, retain the ORIGINAL
    // unknown-clock cutoff; neither waiting nor a later model call can reset its age.
    check(state.controlPolicy?.previewPlanningMs===60000&&state.controlPolicy.unknownClockMs===20000,'Extended preview admission requires the explicit 60s/20s policy');
    const unknownCutoff=Math.min(cutoff(state,action),action.receivedAt+20000);
    let latest=state,current=action,verified=verifiedLongPreviewClock(action),changedDuringWait=false,reconciled=false;
    const began=now(),deadlineAt=Math.min(began+previewClockWaitMs,unknownCutoff-commitReserveMs);
    for(let reads=0;!verified&&reads<2&&now()+100<deadlineAt&&Number.isSafeInteger(latest.revision);reads++){
      const window=Math.min(900,Math.max(1,deadlineAt-now()-100)),startedAt=now();
      const reply=await previewRead({id:id('preview_clock'),op:'call',name:'battle_wait',
        args:{afterRevision:latest.revision,timeoutMs:window,format:'compact'},full:true},deadlineAt);
      check(!failed(reply),'Preview clock read was refused');
      const fresh=verify(unwrap(reply)),freshAction=previewAction(fresh,action);
      if(!freshAction){const transition=endedRequest(fresh,action);if(transition)return{state:fresh,action,transition};}
      if(!freshAction||freshAction.receivedAt!==action.receivedAt||freshAction.revision!==action.revision||shortRoom(freshAction.parentId)!==shortRoom(action.parentId)||fresh.controlPolicy?.halted===true||manualReady&&fresh.autoReady!==false)
        throw responseError('preview-clock-admission','PREVIEW_CLOCK_REQUEST_CHANGED','Original preview changed during clock acquisition');
      const changed=fresh.revision!==latest.revision;
      changedDuringWait ||= changed;
      latest=fresh;current=freshAction;verified=verifiedLongPreviewClock(current);
      // Never spin on an immediate unchanged reply. Two bounded long polls are
      // enough to observe an initial timer message without inventing a clock.
      if(!changed&&now()-startedAt<100)break;
    }
    // A timer-transition long poll can deliver the earlier compact deadline
    // envelope while the native supervisor has just armed the longer cutoff.
    // Replace that entire observation once, before generation begins. Never pick
    // the maximum of conflicting rows or extend a model call already in flight.
    const armed=(latest.controlPolicy?.pending??[]).some(row=>row.token===action.token&&row.rqid===action.rqid&&shortRoom(row.room)===shortRoom(action.room)&&row.clockFreshForRequest===true&&row.clockSource==='observed-server-clock');
    if((changedDuringWait||armed||verified&&cutoff(latest,current)<=unknownCutoff)&&now()+100<deadlineAt){
      const reply=await previewRead({id:id('preview_reconcile'),op:'turn',full:true},deadlineAt);
      check(!failed(reply),'Preview clock reconciliation was refused');
      const fresh=verify(unwrap(reply)),freshAction=previewAction(fresh,action);
      if(!freshAction){const transition=endedRequest(fresh,action);if(transition)return{state:fresh,action,transition};}
      if(!freshAction||freshAction.receivedAt!==action.receivedAt||freshAction.revision!==action.revision||shortRoom(freshAction.parentId)!==shortRoom(action.parentId)||fresh.controlPolicy?.halted===true||manualReady&&fresh.autoReady!==false)
        throw responseError('preview-clock-admission','PREVIEW_CLOCK_REQUEST_CHANGED','Original preview changed during clock reconciliation');
      latest=fresh;current=freshAction;verified=verifiedLongPreviewClock(current);reconciled=true;
    }
    const matching=rows=>(rows??[]).filter(row=>row.token===current.token&&(row.room===undefined||shortRoom(row.room)===shortRoom(current.room))&&(row.rqid===undefined||row.rqid===current.rqid));
    const shortest=rows=>{const values=matching(rows).map(row=>row.cutoffAt).filter(Number.isFinite);return values.length?Math.min(...values):null;};
    const evidence={version:1,waitBudgetMs:previewClockWaitMs,waitedMs:now()-began,reconciled,verifiedLongClock:verified,
      requestReceivedAt:action.receivedAt,unknownCutoffAt:unknownCutoff,snapshotObservedAt:Number.isFinite(latest.observedAt)?latest.observedAt:null,
      timingCutoffAt:shortest(latest.timing?.requests),pendingCutoffAt:shortest(latest.controlPolicy?.pending),
      actionClockSource:['server-timer-observation','server-timer-disabled','unavailable'].includes(current.clock?.source)?current.clock.source:'unavailable',
      clockObservedAt:Number.isFinite(current.clock?.observedAt)?current.clock.observedAt:null,clockDeadlineAt:Number.isFinite(current.clock?.deadlineAt)?current.clock.deadlineAt:null};
    emit('preview.clock-admission',{teamId:identity.teamId,parentId:shortRoom(parentId),room:shortRoom(action.room),rqid:action.rqid,
      ...evidence,retry:false});
    return {state:latest,action:current,cutoffLimit:verified?Infinity:unknownCutoff,evidence};
  }
  function endedRequest(state,action){
    // Only an observed official result for this exact owned child can turn a
    // disappearing request into normal lifecycle progress. A stale token,
    // watchdog reservation, halt or different parent must still stop control.
    if(state.controlPolicy?.halted===true||manualReady&&state.autoReady!==false)return null;
    const pending=[...(state.controlPolicy?.pending??[]),...(state.pending??[])];
    if(pending.some(row=>row.token===action.token&&(row.attempted===true||['sent','uncertain','accepted','reserved','submitting','execution-observed'].includes(row.submissionStatus))))return null;
    if((state.actions??[]).some(row=>row.token===action.token&&!available(row)))return null;
    const child=state.rooms?.find(row=>shortRoom(row.id)===shortRoom(action.room));
    const parent=state.rooms?.find(row=>shortRoom(row.id)===shortRoom(parentId));
    if(!child||child.ended!==true||!['win','tie'].includes(child.result?.type)||shortRoom(child.parentId)!==shortRoom(parentId)||child.teamId&&child.teamId!==identity.teamId||!parent||parent.teamId&&parent.teamId!==identity.teamId)return null;
    const current=(state.actions??[]).filter(row=>['ready','turn','preview','switch','replacement'].includes(row.kind)&&available(row));
    if(current.some(row=>row.kind==='ready'?shortRoom(row.room)!==shortRoom(parentId):shortRoom(row.parentId)!==shortRoom(parentId)))return null;
    const end=terminalState(state,parentId);
    if(end?.status==='review-required')return end;
    if(parent.ended===true&&['win','tie'].includes(parent.result?.type)&&!current.length&&!end)return {status:'waiting',parentId,reason:'official-parent-ended-awaiting-idle',retry:false};
    if(parent.ended!==false||end)return null;
    return {status:'waiting',parentId,reason:'official-child-ended-during-decision',retry:false};
  }
  function requireCurrentResponse(state,action){
    const current=state.actions?.find(row=>row.room===action.room&&row.rqid===action.rqid&&row.token===action.token&&available(row));
    if(current)return current;
    const error=responseError('request-freshness','REQUEST_NOT_CURRENT','Original model request is stale or already reserved',state);
    const transition=endedRequest(state,action);
    if(transition){error.code='REQUEST_CHILD_ENDED';error.transition=transition;}
    throw error;
  }
  function correlation(binding) {
    return {teamId:identity.teamId,parentId:shortRoom(binding.parentId),room:shortRoom(binding.room),rqid:binding.rqid,requestDigest:binding.requestDigest,
      requestKey:timingRequestKey(binding)};
  }
  async function saveCompletedResponse(context,response,meta,error,{superseded=false}={}){
    const stage=error?.responseStage??'model-validation',code=typeof error?.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(error.code)?error.code:'MODEL_DECISION_INVALID';
    const state=error?.responseState;
    const validation={version:1,engineeringOnly:true,choiceAuthority:false,stage,code,capturedAt:now(),
      message:diagnosticValue(String(error?.message??'Completed model response was not authorized').slice(0,512),secret),
      ...(state?{source:{connected:state.connected,authenticated:state.authenticated,stopped:state.stopped,halted:state.controlPolicy?.halted===true,
        rooms:(state.rooms??[]).filter(row=>[shortRoom(meta.room),shortRoom(parentId)].includes(shortRoom(row.id))).map(row=>({id:shortRoom(row.id),parentId:shortRoom(row.parentId),ended:row.ended,result:row.result??null}))}}:{})};
    await deadlineBound(()=>onEvidence({phase:superseded?'decision-superseded':'decision-rejected',
      context:{instructions:context.instructions,input:context.input,schema:structuredClone(context.schema),promptMetadata:structuredClone(context.promptMetadata)},
      modelOutput:diagnosticValue(response.decision??null,secret),telemetry:response.telemetry,binding:meta,validation}),{deadlineAt:now()+1500,now});
  }
  async function responseFailure(context,response,meta,error,{status='invalid-decision',evidencePreserved=false}={}){
    try{if(!evidencePreserved)await saveCompletedResponse(context,response,meta,error,{superseded:Boolean(error?.transition)});}
    catch{return paused={status:'evidence-unavailable',parentId,reason:'completed-response-evidence-unavailable',retry:false};}
    if(error?.transition){emit('decision.superseded',{...meta,decisionPhase:context.promptMetadata.decisionPhase,stage:error.responseStage,code:error.code,retry:false});return error.transition;}
    emit('decision.invalid',{...meta,decisionPhase:context.promptMetadata.decisionPhase,stage:error?.responseStage??'model-validation',code:error?.code??'MODEL_DECISION_INVALID',retry:false});
    return {status,parentId,stage:error?.responseStage??'model-validation',code:error?.code??'MODEL_DECISION_INVALID',retry:false};
  }
  async function initialize(){
    if(initialized)return {initialized:true,decisionMode};
    const initial=await readFull();check(!manualReady||initial.autoReady===false,'Observed manual-ready session required');
    const reply=await dispatch({id:id('policy'),op:'decision-policy',enabled:true,commitBufferMs:commitReserveMs});check(!failed(reply)&&unwrap(reply).enabled===true,'Decision deadline policy was not adopted');
    const mode=await dispatch({id:id('model_tool_mode'),op:'model-tool-mode',enabled:true});check(!failed(mode),'Model-owned MCP mode refused');
    const catalog=await dispatch({id:id('model_tool_catalog'),op:'model-tool-catalog'});check(!failed(catalog),'Native MCP catalog unavailable');
    modelToolCatalog=unwrap(catalog);check(Array.isArray(modelToolCatalog?.tools)&&modelToolCatalog.tools.length>0,'Actual model MCP tools required');
    initialized=true;emit('controller.initialized',{teamId:identity.teamId,model,reasoningEffort,decisionMode,codexContextMode});return {initialized:true,decisionMode};
  }
  async function handleReady(state,action,{signal}={}){
    const origin={room:action.room,kind:'ready',token:action.token,parentId},key=digest([identity.sessionId,identity.teamId,shortRoom(parentId),action.token]);
    lastOrigin=origin;
    const meta={teamId:identity.teamId,parentId:shortRoom(parentId),room:shortRoom(action.room),requestKey:key};
    if(readinessReservations.has(key))return {status:'waiting',parentId,reason:'readiness-already-reserved',retry:false};
    const valid=current=>current.autoReady===false&&current.controlPolicy?.halted!==true&&/^[a-f0-9]{64}$/u.test(action.token??'')&&/^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u.test(shortRoom(parentId)??'')&&
      shortRoom(action.room)===shortRoom(parentId)&&current.rooms?.filter(room=>shortRoom(room.id)===shortRoom(parentId)&&room.ended===false&&(!room.teamId||room.teamId===identity.teamId)).length===1;
    if(!valid(state))return {status:'readiness-unavailable',parentId,reason:'manual-readiness-parent-or-policy-unverified',retry:false};
    let fresh;
    // Reuse the required readiness read for the completed game's final board.
    // No new preview clock has started and no extra context/choice round trip
    // is introduced. Compact turn views can omit ended child snapshots.
    try{fresh=codexContextMode==='session'&&memory.gameId?await readFull():await readTurn();}catch{return {status:'readiness-unavailable',parentId,reason:'fresh-readiness-unavailable',retry:false};}
    const end=terminalState(fresh,parentId);if(end)return end;
    const current=(fresh.actions??[]).filter(row=>['ready','turn','preview','switch','replacement'].includes(row.kind)&&available(row));
    if(!valid(fresh)||current.length!==1||current[0].kind!=='ready'||current[0].token!==action.token||shortRoom(current[0].room)!==shortRoom(action.room))
      return {status:'stale-readiness',parentId,reason:'readiness-source-changed-before-send',retry:false};
    if(codexContextMode==='session'&&memory.gameId)pendingGameSummary=preparePreviousGameSummary({state:fresh,gameId:memory.gameId,parentId,teamId:identity.teamId,account:identity.account})??pendingGameSummary;
    if(aborted(signal))return {status:'aborted',parentId,retry:false};
    // Readiness is a separate protocol acknowledgement, never a tactical
    // choice or an additional search. Reserve even if the send is uncertain.
    readinessReservations.add(key);
    emit('readiness.reserved',{...meta,operation:'battle_ready',retry:false});
    let reply;
    try{reply=await dispatch({id:id('ready'),op:'call',name:'battle_ready',args:{confirmed:true,commandId:id('ready_command'),token:action.token}});}
    catch{emit('readiness.uncertain',{...meta,operation:'battle_ready',retry:false});return {status:'reconciliation-required',parentId,reason:'readiness-send-uncertain',retry:false};}
    const result=unwrap(reply);
    if(failed(reply)||failed(result)||result?.status!=='sent-not-acknowledged'){
      emit('readiness.uncertain',{...meta,operation:'battle_ready',retry:false});
      return {status:'reconciliation-required',parentId,reason:'readiness-send-unverified',retry:false};
    }
    emit('readiness.sent',{...meta,operation:'battle_ready',outcome:'sent-not-acknowledged',retry:false});
    return {status:'submitted',parentId,operation:'battle_ready',readinessOutcome:'sent-not-acknowledged',retry:false};
  }
  function recoveryBlocked(reason) {
    emit('recovery.blocked',{teamId:identity.teamId,parentId:shortRoom(parentId),reason,retry:false});
    return {status:'recovery-blocked',parentId,reason,retry:false};
  }
  function recoveryAdmission(state,expectedRequest,recovery) {
    // Only recoverCurrent's private permit can admit an untouched tactical
    // request on this retained parent while future searches remain halted.
    // Disabled, disposed or faulted protection still supplies no authority.
    if(state.controlPolicy?.halted===true&&!(recovery.permit===recoveryPermit&&state.controlPolicy.enabled===true&&state.controlPolicy.disposed!==true&&state.controlPolicy.observationFault!==true))return 'control-policy-halted';
    if(manualReady&&state.autoReady!==false)return 'manual-readiness-mode-changed';
    if(state.awaitingSet||state.searchPending||state.switchingTeam||state.savingReplays)return 'owned-set-not-actionable';
    const parents=(state.rooms??[]).filter(room=>room.id?.startsWith('game-bestof3-')&&room.ended===false);
    if(parents.length!==1||shortRoom(parents[0].id)!==shortRoom(parentId)||parents[0].ended!==false||parents[0].teamId&&parents[0].teamId!==identity.teamId)return 'owned-parent-not-current';
    const actions=(state.actions??[]).filter(action=>['ready','turn','preview','switch','replacement'].includes(action.kind));
    if(actions.length!==1)return actions.length?'multiple-current-requests':'no-current-request';
    const action=actions[0];
    if(!['turn','switch','replacement'].includes(action.kind))return 'recovery-requires-tactical-request';
    if(action.room!==expectedRequest.room||action.rqid!==expectedRequest.rqid||action.token!==expectedRequest.token)return 'expected-request-not-current';
    const children=(state.rooms??[]).filter(room=>room.id===action.room);
    const observedParent=action.parentId??children[0]?.parentId;
    if(children.length!==1||children[0].ended!==false||children[0].teamId&&children[0].teamId!==identity.teamId||
      shortRoom(observedParent)!==shortRoom(parentId)||shortRoom(children[0].parentId)!==shortRoom(parentId))return 'request-not-owned-by-current-parent';
    const safety=[action,...(state.controlPolicy?.pending??[]),...(state.pending??[]),...(state.timing?.requests??[])].filter(row=>row.token===action.token);
    if(safety.some(row=>row.attempted===true||['sent','uncertain','accepted','reserved','submitting','execution-observed'].includes(row.submissionStatus)||
      ['submitting','sent-awaiting-server','send-uncertain','forfeit-attempted','forfeit-send-returned','forfeit-uncertain'].includes(row.state)||
      row.reservation===true||typeof row.reservation==='string'&&!['none','not-sent'].includes(row.reservation)))return 'existing-submission-reservation';
    if(safety.some(row=>row.hasFallback===true||row.staged!=null&&row.staged!==false||row.fallbackSource!=null||row.state==='fallback-staged'))return 'existing-staged-fallback';
    if(!available(action))return 'current-request-not-actionable';
    if(consumed.has(action.token))return 'submission-already-reserved';
    if(decisionAttempts.has(action.token))return 'request-already-attempted';
    let cutoffAt;try{cutoffAt=cutoff(state,action);}catch{return 'current-request-cutoff-unavailable';}
    if(now()>=cutoffAt-commitReserveMs)return 'current-request-deadline-unavailable';
    if(recovery.originalBudget&&now()>=Math.min(recovery.originalBudget.modelDeadlineAt,recovery.originalBudget.cutoffAt-commitReserveMs))return 'original-model-deadline-unavailable';
    return null;
  }
  async function performNext({signal,recovery} = {}) {
    check(initialized,'Initialize the controller before a decision');
    const recovering=recovery?.permit===recoveryPermit;
    if (paused&&!recovering) return structuredClone(paused);
    check(!busy,'Only one isolated decision may be in flight');
    if (aborted(signal)) return {status:'aborted',retry:false};
    busy = true;
    let failureStage='turn-read',failureSource,failureBinding,apiAttempted=false;
    function captureSource(state,action,sheet){
      failureSource=undefined;
      const board=state.boards?.find(row=>row.room===action.room);
      const rawBinding={sessionId:state.sessionId,teamId:identity.teamId,room:action.room,parentId,rqid:action.rqid,revision:action.revision,kind:action.kind,token:action.token,
        ...(board&&action.legalActions?{boardHash:boardDigest(board,action.legalActions),legalHash:digest(action.legalActions)}:{})};
      rawBinding.requestDigest=requestDigest(rawBinding);
      failureBinding={...correlation(rawBinding),revision:action.revision,kind:action.kind,boardHash:rawBinding.boardHash,legalHash:rawBinding.legalHash};
      const source=diagnosticValue({kind:'controller-preparation-source-v1',engineeringOnly:true,
        state:{teamId:identity.teamId,connected:state.connected,authenticated:state.authenticated,stopped:state.stopped,
          actions:[{...action,parentId}],boards:board?[board]:[],rooms:(state.rooms??[]).filter(row=>[action.room,parentId].includes(row.id)).map(row=>({id:row.id,parentId:row.parentId,ended:row.ended})),
          timing:{requests:state.timing?.requests??[]},controlPolicy:{pending:state.controlPolicy?.pending??[]}},
        ownTeamText,opponentSheet:sheet??null,strategicMemory:memory,skillVersion,skillSha256,
        limitation:'Engineering source only, never a model decision or tactical evidence. Private capability fields are removed; offline replay must use inert replacement identities.'},secret);
      check(bytes(source)<=MAX_CONTEXT_BYTES,'Controller diagnostic source exceeds 8 MiB');
      failureSource=source;
    }
    try {
      let state;const readStartedAt=now();
      try{state=await readTurn();}
      catch(error){if(recovering)return recoveryBlocked('fresh-native-source-unavailable');throw error;}
      if(recovering)emit('recovery.read-complete',{teamId:identity.teamId,parentId:shortRoom(parentId),readStartedAt,readCompletedAt:now(),retry:false});
      failureStage='request-selection';
      const end = terminalState(state,parentId);
      if (end) { if (end.status === 'review-required') paused = end; return end; }
      if(recovering){
        const reason=recoveryAdmission(state,recovery.expectedRequest,recovery);if(reason)return recoveryBlocked(reason);
        emit('recovery.authoring-start',{teamId:identity.teamId,parentId:shortRoom(parentId),room:shortRoom(recovery.expectedRequest.room),rqid:recovery.expectedRequest.rqid,retry:false});
      }
      const actions = (state.actions ?? []).filter(action => ['ready','turn','preview','switch','replacement'].includes(action.kind) && available(action));
      if (actions.length === 0) return {status:'waiting',parentId};
      check(actions.length === 1,'Exactly one current battle request is required');
      // Unchanged read-only opponent-wait polls do not interrupt background
      // work. The native observer already preempts on a fresh request; also
      // cancel here before any actionable preparation or model authoring.
      backgroundHook('setMainBusy',true);
      let action = actions[0];
      failureStage='request-binding';
      const observedParent = action.kind==='ready'?action.room:action.parentId ?? state.rooms?.find(room => room.id === action.room)?.parentId;
      check(typeof observedParent === 'string' && observedParent.startsWith('game-bestof3-'),'Current request lacks its BO3 identity');
      if (parentId) check(shortRoom(parentId) === shortRoom(observedParent),'A different BO3 requires the external review checkpoint');
      if(!recovering)parentId = observedParent;
      lastOrigin = {room:action.room,rqid:action.rqid,token:action.token,parentId};
      if(action.kind==='ready'){
        if(codexContextMode==='session'&&memory.gameId)pendingGameSummary=preparePreviousGameSummary({state,gameId:memory.gameId,parentId,teamId:identity.teamId,account:identity.account})??pendingGameSummary;
        return await handleReady(state,action,{signal});
      }
      check(!manualReady||state.autoReady===false,'Manual-readiness session mode changed');
      if (consumed.has(action.token)) return {status:'waiting',parentId,reason:'submission-already-reserved'};
      if(codexContextMode==='session'&&memory.gameId&&shortRoom(memory.gameId)!==shortRoom(action.room)){
        const observed=preparePreviousGameSummary({state,gameId:memory.gameId,parentId,teamId:identity.teamId,account:identity.account});
        const previousGameSummary=observed?.source?.snapshotFinalVerified?observed:pendingGameSummary??observed;
        memory=updateStrategicMemory(memory,undefined,{teamId:identity.teamId,parentId,gameId:action.room,previousGameSummary});
        pendingGameSummary=undefined;
      }
      decisionAttempts.add(action.token);
      failureStage='diagnostic-source';captureSource(state,action);
      failureStage='preview-clock-admission';
      const admission=await admitPreviewClock(state,action);state=admission.state;action=admission.action;
      if(admission.transition)return admission.transition;
      failureStage='diagnostic-source';captureSource(state,action);
      failureStage='request-deadline';
      const cutoffAt = Math.min(cutoff(state,action),admission.cutoffLimit??Infinity,recovery?.originalBudget?.cutoffAt??Infinity),
        modelDeadlineAt = Math.min(cutoffAt - commitReserveMs,recovery?.originalBudget?.modelDeadlineAt??((recovering?recovery.startedAt:now()) + maxModelMs));
      if(!requestBudgets.has(action.token))requestBudgets.set(action.token,{cutoffAt,modelDeadlineAt});
      if (modelDeadlineAt <= now()) return {status:'deadline-unavailable',parentId,retry:false};
      const controllerBudget={version:1,scope:'original-admitted-decision-window',admittedAt:now(),cutoffAt,modelDeadlineAt,commitReserveMs,
        previewClockAdmission:admission.evidence??null};
      failureStage='opponent-sheet';
      const current = await completeSheet(state,action); state = current.state;
      failureStage='diagnostic-source';captureSource(state,action,current.sheet);
      if (aborted(signal) || now() >= modelDeadlineAt) return {status:aborted(signal) ? 'aborted' : 'deadline-unavailable',parentId,retry:false};
      if(decisionMode==='model-tools'){
        failureStage='model-tool-context';
        let context=buildModelToolContext({state,ownTeamText,opponentSheet:current.sheet,strategicMemory:memory,skillVersion,skillSha256,matchupGuidance,teamGuidance:teamGuidance?.context,
          decisionClock:{...controllerBudget,remainingAtAssemblyMs:Math.max(0,modelDeadlineAt-now())},now,maxBytes:maxContextBytes});
        const ponderNotes=backgroundHook('notesFor',{context,state});
        if(ponderNotes)try{context=rebudgetDecisionContext(context,{payload:{...context.sourcePayload,ponderNotes},maxBytes:maxContextBytes});}
        catch{emit('ponder.notes-skipped',{teamId:identity.teamId,parentId,reason:'optional-notes-exceed-current-context-bound',retry:false});}
        backgroundHook('setDecisionContext',{context,state});
        context.promptMetadata.controllerBudget=controllerBudget;
        failureStage='model-tool-cycle';
        let completedResponse;
        const result=await deadlineBound(modelSignal=>runModelToolCycle({context,state,action,parentId,identity,operator,catalog:modelToolCatalog,
          callDecision:async request=>{const response=await callDecision(request);completedResponse=response;return response;},providerArguments,providerKind,now,
          deadlineAt:modelDeadlineAt,signal:modelSignal,id,emit,onEvidence,onModelAttempt:()=>{apiAttempted=true;},reserve:token=>consumed.add(token),
          observeDecision:decision=>{backgroundHook('setDecisionContext',{context,state,decision});memory=updateStrategicMemory(memory,decision,{teamId:identity.teamId,parentId,gameId:action.room,
            observedOrderConstraints:context.sourcePayload.observedOrderConstraints??[],events:current.board.recentEvents?.lines??[]});}}),
          {deadlineAt:modelDeadlineAt,now,signal,captureAbortTelemetry:true});
        const refusal=result.modelChoiceSourceRefusal;
        if(result.status==='reconciliation-required'&&completedResponse&&refusal?.version===1&&refusal.stage==='fresh-source-validation'&&refusal.knownNotSent===true&&refusal.nativeMutationAttempted===false&&
          refusal.requestKeySha256===digest({room:action.room,rqid:action.rqid,token:action.token})&&now()<modelDeadlineAt&&!aborted(signal)){
          // Only the trusted operator's pre-mutation refusal admits this read.
          // Ordinary decisions add no RPC, and unknown sends remain attention.
          let fresh;try{fresh=await deadlineBound(()=>readTurn(),{deadlineAt:Math.min(modelDeadlineAt,now()+1500),now,signal});}catch{/* Preserve the original reconciliation failure. */}
          if(fresh&&fresh.controller?.required===true&&refusal.ownerGenerationSha256===digest({owner:fresh.controller.owner,generation:fresh.controller.generation})&&
            Array.isArray(fresh.actions)&&(fresh.actions.length===0||fresh.actions.length===1&&fresh.actions[0].kind==='ready'&&
              shortRoom(fresh.actions[0].room)===shortRoom(parentId)&&available(fresh.actions[0])&&
              fresh.rooms?.some(room=>shortRoom(room.id)===shortRoom(parentId)&&room.ended===false))&&
            (fresh.controlPolicy?.pending??[]).length===0&&(fresh.pending??[]).length===0){
            // A fresh same-parent ready token may already follow the official
            // child result. Classify that boundary only; the normal next loop
            // owns readiness, and this obsolete model pair is never submitted.
            const transition=endedRequest(fresh,action);
            if(transition){const error=responseError('request-freshness','REQUEST_CHILD_ENDED','Official child result superseded the completed unsent model response',fresh);error.transition=transition;
              return responseFailure(context,completedResponse,correlation(context.binding),error);}
          }
        }
        return result;
      }
    } catch (error) {
      if(decisionMode==='model-tools'&&failureStage==='model-tool-cycle'&&apiAttempted&&externalProvider&&
        ['deadline_exceeded','aborted'].includes(error?.code)){
        const providerFailureCode=error.code,detectedAt=now(),code=providerFailureCode==='aborted'?'MODEL_PROVIDER_ABORTED':'MODEL_PROVIDER_DEADLINE_EXCEEDED';
        // The outer clock can win while the already-aborted provider drains.
        // That is an unavailable model decision, not source preparation failure.
        emit('decision.provider-failed',{...failureBinding,decisionPhase:'first',providerKind,providerAttempted:true,apiAttempted:false,
          code:providerFailureCode,telemetry:telemetryFor(error.telemetry??{}),retry:false});
        let diagnostic;
        try{
          check(failureSource&&failureBinding&&parentId,'Provider failure has no complete parent-bound engineering source');
          diagnostic=await deadlineBound(()=>onEvidence({phase:'controller-failure',binding:failureBinding,
            diagnostic:{version:1,engineeringOnly:true,apiAttempted:false,providerAttempted:true,stage:failureStage,code,capturedAt:now(),source:failureSource}}),
            {deadlineAt:now()+1500,now});
        }catch(diagnosticError){
          const diagnosticErrorCode=preparationCode(diagnosticError);
          emit('controller.diagnostic-failed',{...failureBinding,stage:failureStage,code:diagnosticErrorCode,primaryProviderFailureCode:providerFailureCode,retry:false});
          return paused={status:'diagnostic-evidence-unavailable',parentId,stage:failureStage,code:'CONTROLLER_DIAGNOSTIC_WRITE_FAILED',
            providerFailureCode,diagnosticErrorCode,detectedAt,diagnosticPreserved:false,retry:false};
        }
        return paused={status:'decision-unavailable',parentId,stage:failureStage,providerFailureCode,detectedAt,diagnosticPreserved:true,
          ...(typeof diagnostic?.path==='string'?{diagnosticPath:diagnostic.path}:{}),retry:false};
      }
      const code=preparationCode(error),detectedAt=now();let diagnostic,promptMetadata;
      emit('controller.preparation-failed',{...failureBinding,stage:failureStage,code,apiAttempted,retry:false});
      try{
        promptMetadata=plain(error?.promptMetadata)?diagnosticValue(error.promptMetadata,secret):undefined;
        check(failureSource&&failureBinding&&parentId,'Controller failure has no complete parent-bound engineering source');
        diagnostic=await deadlineBound(()=>onEvidence({phase:'controller-failure',binding:failureBinding,
          diagnostic:{version:1,engineeringOnly:true,apiAttempted:!externalProvider&&apiAttempted,...(externalProvider?{providerAttempted:apiAttempted}:{}),stage:failureStage,code,capturedAt:now(),...(promptMetadata?{promptMetadata}:{}),source:failureSource}}),
          {deadlineAt:now()+1500,now});
      }catch{
        paused={status:'diagnostic-evidence-unavailable',parentId,stage:failureStage,code:'CONTROLLER_DIAGNOSTIC_WRITE_FAILED',preparationCode:code,detectedAt,diagnosticPreserved:false,retry:false};
        emit('controller.diagnostic-failed',{...failureBinding,stage:failureStage,code:paused.code,outcome:code,apiAttempted,retry:false});
        return structuredClone(paused);
      }
      paused={status:'controller-unavailable',parentId,stage:failureStage,code,detectedAt,diagnosticPreserved:true,
        ...(typeof diagnostic?.path==='string'?{diagnosticPath:diagnostic.path}:{}),retry:false};
      emit('controller.unavailable',{...failureBinding,stage:failureStage,code,outcome:code,promptMetadata,apiAttempted,diagnosticPreserved:true,retry:false});
      return structuredClone(paused);
    } finally { busy = false; backgroundHook('setMainBusy',false); }
  }
  async function decideNext(options){
    const recovering=options?.recovery?.permit===recoveryPermit,priorPause=paused;
    const result=await performNext(options);
    if(recovering&&result.status==='submitted')paused=null;
    else if(recovering&&result.status==='recovery-blocked')paused=priorPause;
    else if(!['submitted','waiting','review-required'].includes(result.status))paused=structuredClone(result);
    return result;
  }
  /** Explicit one-request admission on the same controller and owned BO3.
   * A successful submission releases attention so the caller may explicitly
   * resume runSet. Refusals and uncertain outcomes preserve the existing latch;
   * this method never starts runSet, acknowledges readiness, searches or resets memory. */
  async function recoverCurrent({expectedRequest,signal}={}){
    if(!initialized)return recoveryBlocked('controller-not-initialized');
    if(busy)return recoveryBlocked('controller-busy');
    if(!parentId)return recoveryBlocked('owned-parent-uninitialized');
    if(!paused)return recoveryBlocked('attention-not-active');
    if(!['controller-unavailable','decision-unavailable','stale-decision','late-decision','deadline-unavailable','invalid-decision','invalid-independent-fallback','research-provider-unavailable'].includes(paused.status))return recoveryBlocked('attention-status-not-recoverable');
    if(aborted(signal))return recoveryBlocked('recovery-aborted');
    if(!exactFields(expectedRequest,['room','rqid','token'])||Object.keys(expectedRequest).length!==3||
      typeof expectedRequest.room!=='string'||expectedRequest.room.length>200||!Number.isInteger(expectedRequest.rqid)||expectedRequest.rqid<0||!/^[a-f0-9]{64}$/u.test(expectedRequest.token??''))return recoveryBlocked('exact-expected-request-required');
    if(recoveryAttempts.has(expectedRequest.token))return recoveryBlocked('recovery-already-attempted');
    recoveryAttempts.add(expectedRequest.token);
    const recovery={permit:recoveryPermit,expectedRequest:structuredClone(expectedRequest),startedAt:now()};
    emit('recovery.started',{teamId:identity.teamId,parentId:shortRoom(parentId),room:shortRoom(expectedRequest.room),rqid:expectedRequest.rqid,retry:false});
    const result=await decideNext({signal,recovery});
    if(result.status!=='recovery-blocked')emit(result.status==='submitted'?'recovery.submitted':'recovery.attention',{teamId:identity.teamId,parentId:shortRoom(parentId),status:result.status,...(result.reason?{reason:result.reason}:{}),retry:false});
    return result;
  }
  async function runSet({signal,maxRequests = 1000} = {}) {
    check(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 10000,'Set request limit must be 1–10000');
    for (let count = 0; count < maxRequests; count++) {
      const result = await decideNext({signal});
      if (!['submitted','waiting'].includes(result.status)) return result;
      if (aborted(signal)) return paused={status:'aborted',parentId,retry:false};
      const began = now();
      const reply = await dispatch({id:id('wait'),op:'wait-next',...(parentId ? {parentId} : {}),...(lastOrigin ? {origin:lastOrigin} : {})});
      if (failed(reply)) return paused={status:'reconciliation-required',parentId,retry:false};
      const waited = unwrap(reply), state = unwrap(waited?.state);
      const end = state && terminalState(state,parentId);
      if (end) { paused = end; return end; }
      if (waited?.reason === 'official-parent-ended-and-idle') {
        const parent = state?.rooms?.find(room => shortRoom(room.id) === shortRoom(parentId));
        if (!state || shortRoom(waited.parentId) !== shortRoom(parentId) || parent?.ended !== true || !['win','tie'].includes(parent.result?.type) ||
          !Array.isArray(state.actions) || state.actions.length !== 0) return paused={status:'reconciliation-required',parentId,reason:'post-result-source-unverified',retry:false};
        return paused={status:'post-result-pending',parentId,officialIdle:false,result:structuredClone(parent.result),retry:false};
      }
      if (waited?.reason !== 'fresh-action' && now() - began < 100) return paused={status:'waiting',parentId,reason:'bounded-wait-ended'};
    }
    return paused={status:'request-limit',parentId,retry:false};
  }
  return {initialize,decideNext,recoverCurrent,runSet,pendingRead:()=>pendingPreviewClockRead??null,status:() => ({initialized,busy,parentId,paused:paused?.status ?? null,consumedRequests:consumed.size,readinessReservations:readinessReservations.size,decisionMode,codexContextMode,maxContextBytes,fastFirst:false,singleCallResearch:false,manualReady})};
}
