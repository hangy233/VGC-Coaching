// Read-only recovery for the already armed, retained operator. This helper never
// selects a pair, sends a choice, changes a policy, or acquires control.
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {boardDigest, digest, requestDigest} from '../planning/identity.mjs';

const MAX_RESPONSE_BYTES = 240000;
const MAX_BUNDLE_BYTES = 262144;
const HASH = /^[a-f0-9]{64}$/u;
const PARENT = /^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const CHILD = /^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*(?:-[a-z0-9]+pw)?$/u;
const ID = /^[A-Za-z0-9_-]{1,60}$/u;
const KINDS = new Set(['ready','preview','turn','switch','replacement']);
const RESERVED = new Set(['sent','sent-not-acknowledged','uncertain','accepted','reserved','submitting','execution-observed','resolution-observed']);
const PRIVATE = /^(?:sessionid|apikey|password|passwd|passphrase|controllerlease|controllease|lease|readreceipt|assertion|challstr|credential|credentials|secret|clientsecret|accesstoken|refreshtoken|authorization|cookie|setcookie|capability|capabilities|watchurl|accessurl)$/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const canonical = value => typeof value === 'string' ? value.replace(/-[a-z0-9]+pw$/u,'') : null;
const epoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const failed = value => value?.error || value?.ok === false || value?.isError === true;
const bytes = value => Buffer.byteLength(JSON.stringify(value),'utf8');
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const sameRequest = (row, action) => row?.room === action.room && row?.rqid === action.rqid && row?.token === action.token;
function protectionFor(rows) {
  const statuses=[...new Set(rows.map(row=>row.submissionStatus).filter(value=>typeof value==='string'))];
  const attempted=rows.some(row=>row.attempted===true),reserved=statuses.some(value=>RESERVED.has(value)) || attempted;
  const authoredStage=rows.some(row=>row.hasFallback===true && row.fallbackSource==='fallback' && row.attempted===false);
  const staged=rows.some(row=>row.hasFallback===true);
  const state=statuses.includes('uncertain')?'uncertain':statuses.includes('execution-observed')||statuses.includes('resolution-observed')?'execution-observed':
    statuses.includes('accepted')?'accepted':statuses.includes('sent')||statuses.includes('sent-not-acknowledged')?'sent':reserved?'reserved':
      authoredStage?'staged':staged?'fallback-provenance-unverified':'unprotected';
  return {reserved,protection:{state,submissionStatuses:statuses,sendAttemptObserved:attempted,
    sentOrAccepted:statuses.some(value=>['sent','sent-not-acknowledged','accepted','execution-observed','resolution-observed'].includes(value))?true:reserved?null:false,
    acceptanceEstablished:statuses.includes('accepted'),qualityEstablished:false}};
}

// Inspect descriptors before JSON serialization; unexpected accessors, cycles,
// prototypes and huge strings must not run code or yield a partial board.
function boundedJson(value) {
  let nodes = 0, characters = 0; const active = new Set();
  function visit(item,depth = 0) {
    requireThat(++nodes <= 30000 && depth <= 48,'response-structure-unavailable');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      characters += item.length;
      requireThat(item.length <= MAX_RESPONSE_BYTES && characters <= MAX_RESPONSE_BYTES,'response-too-large'); return;
    }
    if (typeof item === 'number') { requireThat(Number.isFinite(item),'response-structure-unavailable'); return; }
    requireThat((Array.isArray(item) || plain(item)) && !active.has(item),'response-structure-unavailable');
    active.add(item);
    const keys = Reflect.ownKeys(item);
    requireThat(keys.every(key => typeof key === 'string'),'response-structure-unavailable');
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item,key);
      requireThat(descriptor.enumerable && Object.hasOwn(descriptor,'value'),'response-structure-unavailable');
      characters += key.length; requireThat(characters <= MAX_RESPONSE_BYTES,'response-too-large');
      visit(descriptor.value,depth+1);
    }
    if (Array.isArray(item)) requireThat(Object.keys(item).length === item.length && Object.keys(item).every((key,index) => key === String(index)),'response-structure-unavailable');
    active.delete(item);
  }
  visit(value); requireThat(bytes(value) <= MAX_RESPONSE_BYTES,'response-too-large');
  return structuredClone(value);
}

function unwrap(reply) {
  let value = reply;
  for (let depth=0;depth<5;depth++) {
    requireThat(plain(value) && !failed(value),'native-read-failed');
    if (typeof value.sessionId === 'string' && Array.isArray(value.actions) && Array.isArray(value.boards)) return value;
    value = value.result ?? value.data;
  }
  throw new Error('native-turn-unavailable');
}

function safeResponse(reply,sessionId,privateSource) {
  const secrets = new Set([sessionId]);
  const keyName = key => key.toLowerCase().replace(/[^a-z0-9]/gu,'');
  function encoded(value,depth) {
    if (typeof value !== 'string' || !/^\s*[\[{]/u.test(value)) return null;
    try { const parsed=JSON.parse(value); boundedJson(parsed); return {value:parsed,depth:depth+1}; } catch { return null; }
  }
  function collectSecret(value) {
    if (typeof value === 'string' && value) secrets.add(value);
    else if (Array.isArray(value) || plain(value)) for (const child of Object.values(value)) collectSecret(child);
  }
  function collect(value,depth=0) {
    requireThat(depth <= 48,'response-structure-unavailable');
    const parsed=encoded(value,depth); if(parsed) return collect(parsed.value,parsed.depth);
    if (Array.isArray(value)) { for(const child of value) collect(child,depth+1); }
    else if(plain(value)) for(const [key,child] of Object.entries(value)) {
      if(PRIVATE.test(keyName(key))) collectSecret(child); else collect(child,depth+1);
    }
  }
  collect(reply);
  if(privateSource!==undefined)collect(privateSource);
  const ordered=[...secrets].sort((a,b)=>b.length-a.length);
  const redact=value=>{for(const secret of ordered)value=value.replaceAll(secret,'[redacted]');return value;};
  function clean(value,depth=0) {
    requireThat(depth <= 48,'response-structure-unavailable');
    const parsed=encoded(value,depth); if(parsed) return JSON.stringify(clean(parsed.value,parsed.depth));
    if(typeof value==='string')return redact(value);
    if(Array.isArray(value))return value.map(child=>clean(child,depth+1));
    if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE.test(keyName(key))).map(([key,child])=>[redact(key),clean(child,depth+1)]));
    return value;
  }
  return clean(reply);
}

function assertTeam(value,identity,depth=0) {
  requireThat(depth <= 48,'response-structure-unavailable');
  if(Array.isArray(value)){for(const child of value)assertTeam(child,identity,depth+1);return;}
  if(!plain(value))return;
  for(const [key,child] of Object.entries(value)) {
    if(['teamId','teamSha256'].includes(key) && child !== undefined && child !== null) requireThat(child === identity.teamId,'team-identity-changed');
    if(key === 'sessionId' && child !== undefined) requireThat(child === identity.sessionId,'session-identity-changed');
    assertTeam(child,identity,depth+1);
  }
}

function timingFor(state,action,checkedAt) {
  const timings=state.timing?.requests ?? [], pending=state.controlPolicy.pending;
  requireThat(Array.isArray(timings) && Array.isArray(pending),'native-timing-unavailable');
  const exact=rows=>rows.filter(row=>sameRequest(row,action));
  const matching=[...exact(timings),...exact(pending)];
  requireThat(matching.every(row=>row.revision===undefined || row.revision===action.revision),'request-timing-stale');
  for(const row of [...timings,...pending]) if(row.room===action.room && row.rqid===action.rqid) requireThat(row.token===action.token,'request-timing-stale');
  const cutoffValues=matching.map(row=>row.cutoffAt).filter(epoch);
  const receivedValues=[action.receivedAt,...matching.map(row=>row.receivedAt)].filter(epoch);
  requireThat(cutoffValues.length > 0 && receivedValues.length > 0,'native-timing-unavailable');
  requireThat(receivedValues.every(value=>value===receivedValues[0]) && receivedValues[0]<=checkedAt,'request-clock-invalid');
  const receivedAt=receivedValues[0],cutoffAt=Math.min(...cutoffValues);
  requireThat(cutoffAt>=receivedAt,'request-clock-invalid');
  const minimum=field=>{const values=matching.map(row=>row[field]).filter(epoch);return values.length?Math.min(...values):null;};
  const planningDeadlineAt=minimum('planningDeadlineAt'),hardDeadlineAt=minimum('hardDeadlineAt');
  const remaining=value=>value===null?null:Math.max(0,value-checkedAt);
  return {checkedAt,receivedAt,requestAgeMs:checkedAt-receivedAt,cutoffAt,cutoffRemainingMs:remaining(cutoffAt),
    planningDeadlineAt,planningRemainingMs:remaining(planningDeadlineAt),hardDeadlineAt,hardRemainingMs:remaining(hardDeadlineAt),
    deadlineBasis:matching.find(row=>typeof row.deadlineBasis==='string')?.deadlineBasis ?? null,
    clock:action.clock ?? null,
    limitation:'Original native control budgets and observed clock only. Reading does not reset request age or extend any deadline; a local cutoff is not an exact server deadline.'};
}

function requestBinding(state,action,identity,parentId,board) {
  const binding={teamId:identity.teamId,parentId,room:action.room,kind:action.kind,
    ...(action.rqid===undefined?{}:{rqid:action.rqid}),...(action.revision===undefined?{}:{revision:action.revision}),token:action.token};
  if(board) {
    binding.boardHash=boardDigest(board,action.legalActions);
    binding.legalHash=digest(action.legalActions);
    binding.requestDigest=requestDigest({...binding,sessionId:state.sessionId});
  }
  return binding;
}

function contextCompleteness(action,board) {
  if(action.kind==='ready')return {scope:'control-only',opponentSheet:'unknown',missing:['next-game tactical plan'],
    limitation:'An exact ready request is observed; no tactical plan has been selected or validated.'};
  const completeBoard=['p1','p2'].includes(board?.ownSide) && Array.isArray(board.sides) && board.sides.length===2;
  const opposing=board?.opponentSheets?.[board.ownSide==='p1'?'p2':'p1'];
  const completeSheet=Array.isArray(opposing) && opposing.length===6 && opposing.every(set=>plain(set) && typeof set.species==='string' && set.species &&
    typeof set.ability==='string' && typeof set.item==='string' && Array.isArray(set.moves) && set.moves.length>0 && set.moves.every(move=>typeof move==='string' && move));
  return {scope:'control-only',board:completeBoard?'native-board-present':'native-board-incomplete',legalActions:'native-options-preserved',
    opponentSheet:completeSheet?'complete-registered-six':'unknown',
    missing:[...(completeBoard?[]:['complete native board sides']),...(completeSheet?[]:['complete registered opposing six']),
      'authored useful choice','required tactical research or explicit unsupported limits'],
    limitation:'Actionable describes current control authority only. Complete sheets establish neither selected four, investments, opposing actions, tactical quality nor required-check success. Missing evidence is never approximated.'};
}

function nextOperation(action,binding,protection) {
  if(action.kind==='ready')return {cue:'Prepare the next game plan, then explicitly acknowledge this exact ready request through the same owner.',
    requiresAuthoring:true,template:{op:'call',name:'battle_ready',args:{confirmed:true,token:binding.token,commandId:'AUTHOR_UNIQUE_COMMAND_ID'}}};
  const fields={room:binding.room,rqid:binding.rqid,token:binding.token,kind:action.kind==='replacement'?'switch':action.kind};
  if(protection.state==='staged')return {cue:'Inspect the existing staged pair and its intent; commit it promptly if useful, or explicitly author a changed complete pair. Staging proves neither tactical quality nor sending.',
    requiresAuthoring:false,template:{id:'AUTHOR_UNIQUE_COMMAND_ID',op:'commit-next',...fields},
    materialResearch:'The battle model chooses actual MCP questions within the unchanged deadline and shared research budget.'};
  return {cue:action.kind==='preview'?'Author a complete legal preview order as the next control input.':'Author the first useful complete legal pair as the next control input, before optional diagnosis or reports.',
    requiresAuthoring:true,template:{id:'AUTHOR_UNIQUE_COMMAND_ID',op:'stage-next',...fields,actions:[]},
    missingFields:action.kind==='preview'?['actions: complete explicit team order','previewPlan: authored intent']:['actions: both explicit legal choices','turnPlan: authored intent'],
    materialResearch:'Staging protects control only; any material research stays model-requested actual MCP work within the original deadline.'};
}

/** Exactly one read against the SAME already armed operator. Identity is that
 * operator's previously verified locked identity: native compact turns omit the
 * team hash. Explicit hashes/source identities in the response must still match.
 * The complete response is retained except credential/private capability fields.
 */
export async function prepareRecoveryHandoff({operator,identity,parentId,now=Date.now,timeoutMs=1500,commandId}={}) {
  const base={state:'recovery-context',disposition:'unavailable',sameOwnerRequired:true,retry:false,actionsSelected:false};
  let timer;
  try {
    requireThat(operator && typeof operator.dispatch==='function' && plain(identity) && typeof identity.sessionId==='string' && identity.sessionId && HASH.test(identity.teamId ?? '') && typeof now==='function','recovery-input-invalid');
    requireThat(Number.isInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=1500,'recovery-input-invalid');
    const expectedParent=canonical(parentId);
    requireThat(PARENT.test(expectedParent ?? ''),'affected-parent-unavailable');
    const id=commandId ?? `iso_recovery_${randomUUID().replaceAll('-','')}`;
    requireThat(ID.test(id),'recovery-input-invalid');
    const startedAt=now(),wallStartedAt=performance.now();requireThat(epoch(startedAt),'recovery-clock-invalid');
    const expired=Symbol('expired');
    const reply=await Promise.race([
      Promise.resolve().then(()=>operator.dispatch({id,op:'turn',full:true},{inputReceivedAt:startedAt})),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),timeoutMs);}),
    ]);
    if(reply===expired)return {...base,reason:'native-read-timeout'};
    const checkedAt=now();
    requireThat(epoch(checkedAt) && checkedAt>=startedAt,'recovery-clock-invalid');
    requireThat(checkedAt-startedAt<timeoutMs && performance.now()-wallStartedAt<timeoutMs,'native-read-timeout');
    const native=boundedJson(reply),state=unwrap(native);
    requireThat(state.sessionId===identity.sessionId,'session-identity-changed');
    requireThat(state.connected===true && state.authenticated===true && state.stopped!==true,'connection-unavailable');
    requireThat(epoch(state.observedAt) && state.observedAt>=startedAt && state.observedAt<=checkedAt,'native-observation-stale');
    if(identity.account!==undefined && state.username!==undefined)requireThat(state.username===identity.account,'account-identity-changed');
    requireThat(Array.isArray(state.rooms),'owned-parent-unavailable');
    // A turn read keeps owned historical room summaries across roster versions.
    // Their ended-team attribution must remain intact, not be mistaken for the
    // current approved team. All live and affected-parent identities must agree.
    assertTeam({...state,rooms:state.rooms.filter(room=>room.ended!==true || canonical(room.id)===expectedParent || canonical(room.parentId)===expectedParent)},identity);
    const parents=state.rooms.filter(room=>canonical(room.id)===expectedParent);
    requireThat(parents.length===1,'owned-parent-unavailable');
    const parent=parents[0];
    const response=safeResponse(native,identity.sessionId);
    const common={...base,commandId:id,teamId:identity.teamId,parentId:expectedParent,observedAt:state.observedAt,checkedAt,
      identityVerification:{session:'exact-native-match',team:state.teamSha256!==undefined || state.teamId!==undefined?'exact-native-match':'retained-same-owner-approved-identity'},
      response,redaction:'Credential/private capability fields and session identity removed; request token, complete boards, sheets and legal options preserved.'};
    const noGames=state.search && Object.hasOwn(state.search,'games') && (state.search.games===null || plain(state.search.games) && Object.keys(state.search.games).length===0);
    const idle=Array.isArray(state.search?.searching) && state.search.searching.length===0 && noGames && !state.awaitingSet && !state.searchPending && !state.switchingTeam && !state.savingReplays && !state.rooms.some(room=>PARENT.test(canonical(room.id) ?? '') && room.ended!==true);
    let result;
    if(parent.ended===true) {
      requireThat(['win','tie'].includes(parent.result?.type),'official-result-unavailable');
      result={...common,disposition:idle?'review-required':'wait',reason:idle?'official-parent-ended-and-idle':'official-parent-ended-await-idle',nextOperation:{cue:idle?'Complete the private decision review and skill checkpoint before any further search.':'Observe this same parent until official idle; do not start another set.'}};
    } else {
      requireThat(parent.ended===false && !state.rooms.some(room=>PARENT.test(canonical(room.id) ?? '') && canonical(room.id)!==expectedParent && room.ended!==true),'parent-identity-changed');
      const policy=state.controlPolicy;
      // A safety halt blocks another search. It must not hide the exact board
      // from the same retained owner recovering this already authorized parent.
      // This read never resets protection, selects a pair or authorizes a send.
      requireThat(plain(policy) && policy.enabled===true && policy.disposed!==true && policy.observationFault!==true && Array.isArray(policy.pending),'control-policy-unavailable');
      if(policy.halted===true)common.recoveryScope={kind:'already-authorized-current-parent-only',parentId:expectedParent,haltPreserved:true,futureSearchAuthorized:false,policyReset:false};
      if(state.controller!==undefined)requireThat(plain(state.controller) && typeof state.controller.owner==='string' && state.controller.owner && Number.isSafeInteger(state.controller.generation) && state.controller.generation>=1,'control-owner-unavailable');
      requireThat(state.actions.every(action=>plain(action) && KINDS.has(action.kind)),'current-request-ambiguous');
      const current=state.actions.filter(action=>action.actionable!==false && !RESERVED.has(action.submissionStatus));
      requireThat(current.length<=1,'current-request-ambiguous');
      if(current.length===0) {
        const reservations=[...state.actions,...(state.timing?.requests ?? []),...policy.pending].filter(row=>RESERVED.has(row.submissionStatus)||row.attempted===true);
        result={...common,disposition:'wait',reason:reservations.length?'submission-reserved':'no-current-action',
          protection:reservations.length?protectionFor(reservations).protection:{state:'none',qualityEstablished:false},
          nextOperation:{cue:reservations.length?'Preserve the existing send reservation and observe this same owner; no resend or token rebinding.':'Observe this same authorized parent; no actionable request was supplied.'}};
      } else {
        const action=current[0];
        requireThat(HASH.test(action.token ?? ''),'request-token-unavailable');
        const isReady=action.kind==='ready';
        const roomMatches=state.rooms.filter(room=>room.id===action.room);
        requireThat(roomMatches.length===1 && roomMatches[0].ended===false,'request-room-unavailable');
        const child=roomMatches[0],boards=state.boards.filter(board=>board.room===action.room);
        requireThat(canonical(isReady?action.room:action.parentId ?? child.parentId)===expectedParent,'request-parent-changed');
        let board;
        if(isReady)requireThat(state.autoReady===false,'manual-ready-mode-unavailable');
        else {
          requireThat(CHILD.test(action.room) && Number.isSafeInteger(action.rqid) && action.rqid>=0 && Number.isSafeInteger(action.revision) && action.revision>=0 && plain(action.legalActions),'native-choice-unavailable');
          requireThat(boards.length===1 && boards[0].request?.rqid===action.rqid && canonical(boards[0].parentId ?? child.parentId)===expectedParent,'request-board-stale');board=boards[0];
          if(child.parentId!==undefined)requireThat(canonical(child.parentId)===expectedParent,'request-parent-changed');
        }
        const observations=[...state.actions,...(state.timing?.requests ?? []),...policy.pending];
        for(const row of observations)if(row.room===action.room && row.rqid===action.rqid)requireThat(row.token===action.token,'request-timing-stale');
        const rows=observations.filter(row=>sameRequest(row,action));
        const {reserved,protection}=protectionFor(rows);
        const binding=requestBinding(state,action,identity,expectedParent,board);
        const timing=isReady?{checkedAt,clock:action.clock ?? null,limitation:'Ready uses only its observed native clock; no local turn cutoff is invented.'}:timingFor(state,action,checkedAt);
        const serverClock=action.clock?.source==='server-timer-observation'?action.clock:null;
        if(serverClock)requireThat(epoch(serverClock.observedAt) && serverClock.observedAt<=checkedAt &&
          (isReady || serverClock.observedAt>=timing.receivedAt),'request-clock-invalid');
        const elapsed=!isReady && (timing.cutoffAt<=checkedAt || epoch(timing.hardDeadlineAt) && timing.hardDeadlineAt<=checkedAt) ||
          serverClock && [serverClock.deadlineAt,serverClock.bankDeadlineAt].some(value=>epoch(value) && value<=checkedAt);
        result={...common,disposition:reserved?'wait':elapsed?'unavailable':'actionable',reason:reserved?'submission-reserved':elapsed?'native-cutoff-expired':'exact-current-request',binding,timing,protection,
          expectedRequest:{room:action.room,...(action.rqid===undefined?{}:{rqid:action.rqid}),token:action.token},
          contextCompleteness:contextCompleteness(action,board),
          nextOperation:reserved?{cue:'Preserve the existing send reservation and observe; do not resend or rebind.'}:elapsed?{cue:'Original native cutoff is exhausted; reconcile through this same owner without resetting any timer.'}:nextOperation(action,binding,protection)};
      }
    }
    requireThat(bytes(result)<=MAX_BUNDLE_BYTES,'recovery-bundle-too-large');
    const finishedAt=now();
    requireThat(epoch(finishedAt) && finishedAt>=checkedAt,'recovery-clock-invalid');
    requireThat(finishedAt-startedAt<timeoutMs && performance.now()-wallStartedAt<timeoutMs,'native-read-timeout');
    // Serialization/redaction cannot turn a nearly expired snapshot into usable
    // late control authority. Return no tactical bundle if its cutoff passed.
    if(result.disposition==='actionable' && epoch(result.timing?.cutoffAt) && finishedAt>=result.timing.cutoffAt)return {...base,reason:'native-cutoff-expired'};
    // Timing carries the native clock object too; sanitize the whole outgoing
    // bundle so an unknown nested clock field cannot echo private capabilities.
    const safe=safeResponse(result,identity.sessionId,native);
    requireThat(safe.binding===undefined || safe.binding.token===result.binding.token,'private-request-identity-overlap');
    requireThat(bytes(safe)<=MAX_BUNDLE_BYTES,'recovery-bundle-too-large');
    const deliveredAt=now();requireThat(epoch(deliveredAt) && deliveredAt>=finishedAt,'recovery-clock-invalid');
    requireThat(deliveredAt-startedAt<timeoutMs && performance.now()-wallStartedAt<timeoutMs,'native-read-timeout');
    const finalDeadlines=[result.timing?.cutoffAt,result.timing?.hardDeadlineAt,
      ...(result.timing?.clock?.source==='server-timer-observation'?[result.timing.clock.deadlineAt,result.timing.clock.bankDeadlineAt]:[])].filter(epoch);
    if(result.disposition==='actionable' && finalDeadlines.some(value=>value<=deliveredAt))return {...base,reason:'native-cutoff-expired'};
    return safe;
  } catch(error) {
    const reason=typeof error?.message==='string' && /^[a-z][a-z0-9-]{1,79}$/u.test(error.message)?error.message:'native-read-unavailable';
    return {...base,reason};
  } finally { clearTimeout(timer); }
}
