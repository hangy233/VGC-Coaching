// Maintained transport orchestration. Actions are supplied by the agent verbatim;
// this module does not choose moves, calculate battle outcomes, or extend scope.
import {timingEvent, withTimingSpan} from '../observability/timing.mjs';
import {validateTurnPlan,validatePreviewPlan} from './turn-plan.mjs';
const stateOf = value => value?.result ?? value;
const isReplyError = value => value?.ok === false || value?.isError === true;
const actionable = action => action.actionable !== false && !['sent','uncertain'].includes(action.submissionStatus);
const different = (action, origin) => !origin || (action.token && origin.token ? action.token !== origin.token : action.room !== origin.room || action.rqid !== origin.rqid);
const canonicalRoom = id => typeof id === 'string' ? id.replace(/-[a-z0-9]+pw$/u,'') : id;
const sameRoom = (a,b) => typeof a === 'string' && typeof b === 'string' && canonicalRoom(a)===canonicalRoom(b);
const excludedParent = (id,priorParentIds) => priorParentIds.some(prior=>sameRoom(id,prior));
const eligibleParents = (state,priorParentIds) => (state?.rooms || []).filter(room => room.id?.startsWith('game-bestof3-') && !excludedParent(room.id,priorParentIds));
function uniqueRoom(rooms,id) {
  const exact=rooms.find(room=>room.id===id);
  if(exact)return exact;
  const matches=rooms.filter(room=>sameRoom(room.id,id));
  return matches.length===1 ? matches[0] : undefined;
}
function actionParent(state,action) {
  return action?.parentId ?? (action?.room?.startsWith('game-bestof3-') ? action.room :
    uniqueRoom(state?.rooms || [],action?.room)?.parentId);
}
const freshAction = (state, origin, autoReady, priorParentIds=[],scopedParentId) => (state?.actions || []).find(action => {
  const parentId=actionParent(state,action);
  return actionable(action) && !excludedParent(parentId,priorParentIds) && (!scopedParentId || sameRoom(parentId,scopedParentId)) &&
    (action.kind !== 'ready' || autoReady !== true) && different(action, origin);
});

function terminal(state, {parentId,priorParentIds=[]}={}) {
  if (!state || typeof state !== 'object') return null;
  if (state.stopped || state.connected === false || state.authenticated === false) return {reason:'disconnected-or-stopped'};
  const parents=eligibleParents(state,priorParentIds);
  const search=state.search;
  const noGames=search && Object.hasOwn(search,'games') && (search.games === null || typeof search.games === 'object' && !Object.keys(search.games).length);
  const idle=search && Array.isArray(search.searching) && !search.searching.length && noGames && !state.awaitingSet && !state.searchPending && !state.switchingTeam;
  // A transient empty server game map cannot override a live owned parent.
  // Completed history has no ordering contract: identify an explicit/observed
  // parent, or require exactly one candidate before naming an official result.
  if (idle && !parents.some(room => !room.ended)) {
    const parent=parentId ? uniqueRoom(parents,parentId) : parents.length===1 ? parents[0] : undefined;
    if (parent?.ended && ['win','tie'].includes(parent.result?.type)) return {reason:'official-parent-ended-and-idle',parentId:parent.id,result:parent.result,replayPreservationPending:state.savingReplays === true};
    return {reason:'server-idle',officialParentEnded:false};
  }
  return null;
}

class CallTimeout extends Error {
  constructor(name) { super(`Bounded ${name} response did not arrive; mutation outcome is not inferred`); this.name='OperatorCallTimeout'; }
}

// The shared absolute budget bounds waiting, not the server clock or model time.
// Aborting an IPC/SDK wait is NOT evidence that a mutation was cancelled.
async function boundedCall(call,name,args,timeoutMs) {
  const controller=new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(name,args,{timeoutMs,signal:controller.signal})),
      new Promise((_resolve,reject) => { timer=setTimeout(() => {
        timingEvent('operator.rpc_wait_timeout', {tool: name, timeoutMs, outcomeCertainty: 'unknown'});
        controller.abort();reject(new CallTimeout(name));
      },Math.max(1,timeoutMs)); }),
    ]);
  } finally { clearTimeout(timer); }
}
const remaining = (deadline,now,cap=20000) => Math.max(1,Math.min(cap,Math.floor(deadline-now())));
function budget(value) {
  if (!Number.isFinite(value) || value < 1 || value > 20000) throw new TypeError('Transport wait budget must be 1-20000 ms');
  return value;
}

export async function waitForNext({call,observe=async()=>{},origin,parentId,priorParentIds=[],initial,deadlineAt,now=Date.now,budgetMs=20000,autoReady,continueOnIdle=false,returnOnCommitted=false}) {
  const began=now(), deadline=deadlineAt ?? began+budget(budgetMs);
  let value=initial,state,convertedFull=false,observedParentId;
  for (;;) {
    if (value === undefined) {
      if (now() >= deadline) return {reason:'bounded-wait-ended',elapsedMs:now()-began,state:null};
      try {value=await boundedCall(call,'battle_turn_status',{},remaining(deadline,now));}
      catch {return {reason:'read-unavailable',elapsedMs:now()-began,state:null,retry:false};}
    }
    if (isReplyError(value)) return {reason:'read-rejected',elapsedMs:now()-began,state:value.recovery?.state ?? null,retry:false};
    await observe(value); state=stateOf(value);
    if (typeof state?.autoReady === 'boolean') autoReady=state.autoReady;
    if (!parentId) {
      const parents=eligibleParents(state,priorParentIds),live=parents.filter(room=>!room.ended);
      // Remember only positive identity evidence, never numeric room order.
      // A uniquely live set supersedes a stale origin from a previous set.
      observedParentId=live.length===1 ? live[0].id : observedParentId ?? uniqueRoom(parents,actionParent(state,origin))?.id;
    }
    const scope={parentId:parentId ?? observedParentId,priorParentIds};
    const end=terminal(state,scope);
    if (end) return {...end,elapsedMs:now()-began,state:value};
    if (freshAction(state,origin,autoReady,priorParentIds,parentId)) {
      if (Array.isArray(state.boards)) return {reason:'fresh-action',elapsedMs:now()-began,state:value};
      // Backward-compatible old full wait response: one compact read, within
      // the ORIGINAL deadline. New clients need no extra read round trip.
      if (convertedFull) return {reason:'compact-view-unavailable',elapsedMs:now()-began,state:value,retry:false};
      convertedFull=true;
      value=undefined; continue;
    }
    // Trusted script-only handoff: return the existing first observation after
    // a known local send so an independent reader can use opponent wait. No
    // command, deadline extension, acceptance claim or additional read is added.
    if(returnOnCommitted&&origin&&state?.connected===true&&state.authenticated===true&&state.stopped===false&&Array.isArray(state.actions)&&state.actions.length===0){
      const choices=(state.choices??[]).filter(choice=>choice.room===origin.room&&choice.rqid===origin.rqid);
      const room=state.rooms?.find(room=>room.id===origin.room),choice=choices[0];
      if(choices.length===1&&room?.ended===false&&['sent','accepted'].includes(choice.status)&&Array.isArray(choice.evidence)&&choice.evidence.length===0&&!choice.uncertain&&!choice.executionObserved&&!choice.boundary){
        return {reason:'committed-opponent-wait',elapsedMs:now()-began,state:value,serverAcceptance:choice.status==='accepted',choiceAuthority:false};
      }
    }
    if (now() >= deadline) return {reason:'bounded-wait-ended',elapsedMs:now()-began,state:value};
    const revision=state?.revision ?? 0,transportMs=remaining(deadline,now);
    // Leave room for snapshot serialization and IPC inside the ORIGINAL budget.
    // An unchanged server wait must return before the SDK/outer abort deadline.
    const waitedAt=now();
    try {value=await boundedCall(call,'battle_wait',{afterRevision:revision,timeoutMs:Math.max(0,transportMs-100),format:'compact'},transportMs);}
    catch {return {reason:'read-unavailable',elapsedMs:now()-began,state:state ?? null,retry:false};}
    const next=stateOf(value);
    if (!isReplyError(value) && next?.revision === revision && !freshAction(next,origin,autoReady,priorParentIds,parentId) && !terminal(next,scope)) {
      await observe(value);
      // Continue a genuine idle long poll, never hot-poll an immediate unchanged
      // reply. The optional post-send window keeps one absolute deadline.
      if (continueOnIdle && now()<deadline && now()-waitedAt>=Math.min(100,transportMs)) continue;
      return {reason:'bounded-wait-ended',elapsedMs:now()-began,state:value};
    }
  }
}

async function recovery({reply,uncertain,localNotSent=false,call,observe,now,deadlineAt}) {
  let details=reply?.recovery,state=details?.state,observed=false;
  // New clients return current state with the known rejection. Older clients
  // and uncertain transport errors get ONE bounded read, never another send.
  if (!state && now() < deadlineAt) {
    try {
      const result=await boundedCall(call,'battle_turn_status',{},remaining(deadlineAt,now,1500));
      if (!isReplyError(result)) {state=stateOf(result);await observe(result);observed=true;}
    } catch { /* Missing recovery evidence stays explicitly unknown. */ }
  }
  if (state && !observed) await observe(state);
  return {
    error:typeof reply?.error === 'string' ? reply.error : uncertain ? 'Mutation reply unavailable; reconcile original command without replaying it' : 'Authored request no longer matches the delivered request',
    // A legacy negative reply may flatten an uncertain write. Only structured
    // server evidence or a local pre-dispatch check can establish not-sent.
    recovery:{...details,outcome:uncertain ? 'mutation-uncertain' : details?.outcome ?? (localNotSent ? 'not-sent' : 'rejection-unclassified'),retry:false,rebind:false,requiresNewDecision:true,state:state ?? null},
    next:{reason:uncertain ? 'mutation-uncertain' : 'action-rejected',state:state ?? null,observedAt:now()},
  };
}

// A stale choice can race a child's terminal event just before auto-ready
// delivers the next preview. Keep observation inside the original recovery
// budget in this exact known-not-sent case; never replay or rebind the choice.
async function observeChildTransition({recovered,q,call,observe,now,deadlineAt}) {
  const state=stateOf(recovered.recovery?.state);
  if (q.postSendWaitMs===undefined || recovered.recovery?.outcome!=='not-sent' ||
      state?.connected!==true || state.authenticated!==true || state.stopped ||
      !Array.isArray(state.actions) || state.actions.length || now()>=deadlineAt) return recovered;
  const child=(state.rooms || []).find(room => room.id===q.room && room.id?.startsWith('battle-'));
  const parent=child && (state.rooms || []).find(room => room.id===child.parentId);
  if (child?.ended!==true || parent?.ended!==false || !parent.id?.startsWith('game-bestof3-')) return recovered;
  const next=await waitForNext({call,observe,origin:q,parentId:parent.id,initial:state,
    deadlineAt,now,autoReady:state.autoReady,continueOnIdle:true});
  return {...recovered,next:{...next,afterKnownNotSentChildTransition:true}};
}

/** Protect one exact agent-authored request without spending the remainder of
 * its planning window waiting for the next board. No ordinary move is sent.
 */
export async function stageNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000,mutationTimeoutMs=5000,observed}) {
  const began=now(),deadlineAt=began+budget(budgetMs),timing={inputReceivedAt:began,modelDeliveredAt:null};
  if (!Number.isInteger(mutationTimeoutMs) || mutationTimeoutMs < 1 || mutationTimeoutMs > 30000) throw new TypeError('Mutation timeout must be 1-30000 ms');
  if (typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,70}$/.test(q.id) || typeof q.room !== 'string' || !Number.isInteger(q.rqid) || !Array.isArray(q.actions) || !q.actions.length || q.actions.length > 2) throw new TypeError('Authored staging requires an exact request and complete legal actions');
  if(q.turnPlan!==undefined)q={...q,turnPlan:validateTurnPlan(q.turnPlan,{actions:q.actions})};
  const action=(stateOf(observed)?.actions || []).find(a => a.room===q.room && a.rqid===q.rqid && a.token===q.token && actionable(a) && (!q.kind || a.kind===q.kind));
  if (!action) return {...await recovery({localNotSent:true,call,observe,now,deadlineAt}),timing};
  if(q.previewPlan!==undefined){if(action.kind!=='preview')throw new TypeError('previewPlan requires the current preview request');q={...q,previewPlan:validatePreviewPlan(q.previewPlan,{actions:q.actions})};}
  let staged;
  timing.stageDispatchedAt=now();
  try {
    staged=await withTimingSpan('operator.stage', {phase: 'stage'}, () => boundedCall(call,'battle_stage_fallback',{confirmed:true,commandId:q.id,token:action.token,actions:structuredClone(q.actions),...(q.turnPlan===undefined?{}:{turnPlan:structuredClone(q.turnPlan)}),...(q.previewPlan===undefined?{}:{previewPlan:structuredClone(q.previewPlan)})},remaining(deadlineAt,now,mutationTimeoutMs)));
  } catch {
    return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,stageWaitEndedAt:now()}};
  }
  timing.stageSettledAt=now();
  if (isReplyError(staged)) return {...await recovery({reply:staged,call,observe,now,deadlineAt}),timing};
  const pending=stateOf(staged)?.pending?.find(item=>item.token===action.token);
  if (pending?.hasFallback === true && pending.fallbackSource === 'fallback' && pending.attempted !== true) timingEvent('authored.stage', {source: 'authored', outcomeCertainty: 'observed'});
  return {staged,protection:{token:action.token,staged:pending?.hasFallback===true && pending?.fallbackSource==='fallback' && pending?.attempted!==true,
    attempted:pending?.attempted===true,acceptance:'not-established-by-staging'},timing};
}

export async function playNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000,mutationTimeoutMs=5000,autoReady,observed,operationStartedAt,returnAfterSend=false}) {
  const began=operationStartedAt ?? now();
  if (!Number.isSafeInteger(began) || began<0 || began>now()) throw new TypeError('Operation start must be an observed past timestamp');
  const deadlineAt=began+budget(budgetMs),timing={inputReceivedAt:began,modelDeliveredAt:null};
  if (!Number.isInteger(mutationTimeoutMs) || mutationTimeoutMs < 1 || mutationTimeoutMs > 30000) throw new TypeError('Mutation timeout must be 1-30000 ms');
  if(typeof returnAfterSend!=='boolean')throw new TypeError('Post-send handoff must be boolean');
  if (q.postSendWaitMs!==undefined && (!Number.isInteger(q.postSendWaitMs)||q.postSendWaitMs<budgetMs||q.postSendWaitMs>55000)) throw new TypeError('postSendWaitMs must be between the original command budget and 55000 ms');
  if (typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,70}$/.test(q.id) || typeof q.room !== 'string' || !Number.isInteger(q.rqid) || !Array.isArray(q.actions) || !q.actions.length) throw new TypeError('Authored actions require a command ID, exact observed room/rqid and a complete pair');
  if(q.turnPlan!==undefined)q={...q,turnPlan:validateTurnPlan(q.turnPlan,{actions:q.actions})};
  const recover=async args => observeChildTransition({
    recovered:await recovery({...args,call,observe,now,deadlineAt}),q,call,observe,now,deadlineAt,
  });
  const action=(stateOf(observed)?.actions || []).find(a => a.room === q.room && a.rqid === q.rqid && actionable(a) && (!q.kind || a.kind === q.kind));
  if (!action || q.token && q.token !== action.token) return {...await recover({localNotSent:true}),timing};
  if(q.previewPlan!==undefined){if(action.kind!=='preview')throw new TypeError('previewPlan requires the current preview request');q={...q,previewPlan:validatePreviewPlan(q.previewPlan,{actions:q.actions})};}
  const args={confirmed:true,commandId:q.id,token:action.token,actions:structuredClone(q.actions),...(q.turnPlan===undefined?{}:{turnPlan:structuredClone(q.turnPlan)}),...(q.previewPlan===undefined?{}:{previewPlan:structuredClone(q.previewPlan)})};
  let staged;
  if (now() >= deadlineAt) return {...await recovery({reply:{error:'Transport budget ended before staging'},localNotSent:true,call,observe,now,deadlineAt}),timing};
  timing.stageDispatchedAt=now();
  try {staged=await withTimingSpan('operator.stage', {phase: 'stage'}, () => boundedCall(call,'battle_stage_fallback',{...args,commandId:q.id+'-stage'},remaining(deadlineAt,now,mutationTimeoutMs)));}
  catch {return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,stageWaitEndedAt:now()}};}
  timing.stageSettledAt=now();
  if (isReplyError(staged)) return {...await recover({reply:staged}),timing};
  const pending=stateOf(staged)?.pending?.find(item => item.token === action.token);
  if (pending?.hasFallback === true && pending.fallbackSource === 'fallback' && pending.attempted !== true) timingEvent('authored.stage', {source: 'authored', outcomeCertainty: 'observed'});
  let sent,ordinarySendSkipped;
  if (pending?.attempted) ordinarySendSkipped='staged request already attempted; preserve reservation';
  else {
    if (now() >= deadlineAt) return {...await recovery({reply:{error:'Transport budget ended after staging; preserve the staged pair',recovery:{outcome:'staged-only'}},call,observe,now,deadlineAt}),timing};
    timing.chooseDispatchedAt=now();
    try {sent=await withTimingSpan('operator.choose', {phase: 'choose'}, () => boundedCall(call,'battle_choose',{...args,validForMs:10000},remaining(deadlineAt,now,mutationTimeoutMs)));}
    catch {return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,chooseWaitEndedAt:now()}};}
    timing.chooseSettledAt=now();
    if (isReplyError(sent)) return {...await recover({reply:sent}),timing};
    if (stateOf(sent)?.status === 'sent-not-acknowledged') timingEvent('authored.send', {source: 'authored', outcomeCertainty: 'sent_not_acknowledged'});
  }
  // Only this read-only phase after a send or preserved reservation may use the
  // opt-in larger total window. Staging,
  // choosing, rejection and uncertain-write recovery keep the original budget.
  const nextDeadlineAt=q.postSendWaitMs===undefined?deadlineAt:began+q.postSendWaitMs;
  const next=await withTimingSpan('operator.post_send_wait', {phase: 'post_send_wait'}, () => waitForNext({call,observe,origin:action,parentId:action.parentId || (action.room.startsWith('game-bestof3-') ? action.room : undefined),deadlineAt:nextDeadlineAt,now,autoReady,continueOnIdle:q.postSendWaitMs!==undefined,returnOnCommitted:returnAfterSend}));
  return {sent,ordinarySendSkipped,next,timing};
}

export async function startNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000}) {
  const began=now(),deadlineAt=began+budget(budgetMs);
  if (q.postSendWaitMs!==undefined && (!Number.isInteger(q.postSendWaitMs)||q.postSendWaitMs<budgetMs||q.postSendWaitMs>55000)) throw new TypeError('postSendWaitMs must be between the original command budget and 55000 ms');
  if (q.confirmed !== true || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,70}$/.test(q.id)) throw new TypeError('Explicit authored search confirmation and command ID required');
  const before=await boundedCall(call,'battle_status',{},remaining(deadlineAt,now));
  if (isReplyError(before)) return {started:before,next:{reason:'read-rejected',state:before.recovery?.state ?? null}};
  await observe(before);
  const priorParentIds=(stateOf(before).rooms || []).filter(r => r.id?.startsWith('game-bestof3-')).map(r => r.id);
  if (now() >= deadlineAt) return recovery({reply:{error:'Transport budget ended before search dispatch'},localNotSent:true,call,observe,now,deadlineAt});
  let started;
  try {started=await boundedCall(call,'battle_start',{confirmed:true,commandId:q.id},remaining(deadlineAt,now,5000));}
  catch {return recovery({uncertain:true,call,observe,now,deadlineAt});}
  if (isReplyError(started)) return {started,next:{reason:'search-rejected',state:started.recovery?.state ?? null}};
  // Only a successful owned search may enter the longer read-only window.
  // Search dispatch and uncertain/rejected recovery retain the original budget;
  // every individual read remains bounded and no search is ever repeated.
  const nextDeadlineAt=q.postSendWaitMs===undefined?deadlineAt:began+q.postSendWaitMs;
  return {started,next:await waitForNext({call,observe,priorParentIds,deadlineAt:nextDeadlineAt,now,
    autoReady:stateOf(before).autoReady,continueOnIdle:q.postSendWaitMs!==undefined})};
}
