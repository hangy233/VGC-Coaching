// Maintained transport orchestration. Actions are supplied by the agent verbatim;
// this module does not choose moves, calculate battle outcomes, or extend scope.
const stateOf = value => value?.result ?? value;
const isReplyError = value => value?.ok === false || value?.isError === true;
const actionable = action => action.actionable !== false && !['sent','uncertain'].includes(action.submissionStatus);
const different = (action, origin) => !origin || (action.token && origin.token ? action.token !== origin.token : action.room !== origin.room || action.rqid !== origin.rqid);
const freshAction = (state, origin, autoReady) => (state?.actions || []).find(action => actionable(action) &&
  (action.kind !== 'ready' || autoReady !== true) && different(action, origin));

function terminal(state, {parentId,priorParentIds=[]}={}) {
  if (!state || typeof state !== 'object') return null;
  if (state.stopped || state.connected === false || state.authenticated === false) return {reason:'disconnected-or-stopped'};
  const parents=(state.rooms || []).filter(room => room.id?.startsWith('game-bestof3-') && (parentId ? room.id === parentId : !priorParentIds.includes(room.id)));
  const parent=parents.find(room => room.ended && ['win','tie'].includes(room.result?.type));
  const search=state.search;
  const noGames=search && Object.hasOwn(search,'games') && (search.games === null || typeof search.games === 'object' && !Object.keys(search.games).length);
  const idle=search && Array.isArray(search.searching) && !search.searching.length && noGames && !state.awaitingSet && !state.searchPending && !state.switchingTeam;
  if (parent && idle) return {reason:'official-parent-ended-and-idle',parentId:parent.id,result:parent.result,replayPreservationPending:state.savingReplays === true};
  if (idle && !parent && !parents.some(room => !room.ended)) return {reason:'server-idle',officialParentEnded:false};
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
      new Promise((_resolve,reject) => { timer=setTimeout(() => {controller.abort();reject(new CallTimeout(name));},Math.max(1,timeoutMs)); }),
    ]);
  } finally { clearTimeout(timer); }
}
const remaining = (deadline,now,cap=20000) => Math.max(1,Math.min(cap,Math.floor(deadline-now())));
function budget(value) {
  if (!Number.isFinite(value) || value < 1 || value > 20000) throw new TypeError('Transport wait budget must be 1-20000 ms');
  return value;
}

export async function waitForNext({call,observe=async()=>{},origin,parentId,priorParentIds=[],initial,deadlineAt,now=Date.now,budgetMs=20000,autoReady,continueOnIdle=false}) {
  const began=now(), deadline=deadlineAt ?? began+budget(budgetMs);
  let value=initial,state,convertedFull=false;
  for (;;) {
    if (value === undefined) {
      if (now() >= deadline) return {reason:'bounded-wait-ended',elapsedMs:now()-began,state:null};
      try {value=await boundedCall(call,'battle_turn_status',{},remaining(deadline,now));}
      catch {return {reason:'read-unavailable',elapsedMs:now()-began,state:null,retry:false};}
    }
    if (isReplyError(value)) return {reason:'read-rejected',elapsedMs:now()-began,state:value.recovery?.state ?? null,retry:false};
    await observe(value); state=stateOf(value);
    if (typeof state?.autoReady === 'boolean') autoReady=state.autoReady;
    const end=terminal(state,{parentId,priorParentIds});
    if (end) return {...end,elapsedMs:now()-began,state:value};
    if (freshAction(state,origin,autoReady)) {
      if (Array.isArray(state.boards)) return {reason:'fresh-action',elapsedMs:now()-began,state:value};
      // Backward-compatible old full wait response: one compact read, within
      // the ORIGINAL deadline. New clients need no extra read round trip.
      if (convertedFull) return {reason:'compact-view-unavailable',elapsedMs:now()-began,state:value,retry:false};
      convertedFull=true;
      value=undefined; continue;
    }
    if (now() >= deadline) return {reason:'bounded-wait-ended',elapsedMs:now()-began,state:value};
    const revision=state?.revision ?? 0,transportMs=remaining(deadline,now);
    // Leave room for snapshot serialization and IPC inside the ORIGINAL budget.
    // An unchanged server wait must return before the SDK/outer abort deadline.
    const waitedAt=now();
    try {value=await boundedCall(call,'battle_wait',{afterRevision:revision,timeoutMs:Math.max(0,transportMs-100),format:'compact'},transportMs);}
    catch {return {reason:'read-unavailable',elapsedMs:now()-began,state:state ?? null,retry:false};}
    const next=stateOf(value);
    if (!isReplyError(value) && next?.revision === revision && !freshAction(next,origin,autoReady) && !terminal(next,{parentId,priorParentIds})) {
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

/** Protect one exact agent-authored request without spending the remainder of
 * its planning window waiting for the next board. No ordinary move is sent.
 */
export async function stageNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000,mutationTimeoutMs=5000,observed}) {
  const began=now(),deadlineAt=began+budget(budgetMs),timing={inputReceivedAt:began,modelDeliveredAt:null};
  if (!Number.isInteger(mutationTimeoutMs) || mutationTimeoutMs < 1 || mutationTimeoutMs > 30000) throw new TypeError('Mutation timeout must be 1-30000 ms');
  if (typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,70}$/.test(q.id) || typeof q.room !== 'string' || !Number.isInteger(q.rqid) || !Array.isArray(q.actions) || !q.actions.length || q.actions.length > 2) throw new TypeError('Authored staging requires an exact request and complete legal actions');
  const action=(stateOf(observed)?.actions || []).find(a => a.room===q.room && a.rqid===q.rqid && a.token===q.token && actionable(a) && (!q.kind || a.kind===q.kind));
  if (!action) return {...await recovery({localNotSent:true,call,observe,now,deadlineAt}),timing};
  let staged;
  timing.stageDispatchedAt=now();
  try {
    staged=await boundedCall(call,'battle_stage_fallback',{confirmed:true,commandId:q.id,token:action.token,actions:structuredClone(q.actions)},remaining(deadlineAt,now,mutationTimeoutMs));
  } catch {
    return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,stageWaitEndedAt:now()}};
  }
  timing.stageSettledAt=now();
  if (isReplyError(staged)) return {...await recovery({reply:staged,call,observe,now,deadlineAt}),timing};
  const pending=stateOf(staged)?.pending?.find(item=>item.token===action.token);
  return {staged,protection:{token:action.token,staged:pending?.hasFallback===true && pending?.fallbackSource==='fallback' && pending?.attempted!==true,
    attempted:pending?.attempted===true,acceptance:'not-established-by-staging'},timing};
}

export async function playNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000,mutationTimeoutMs=5000,autoReady,observed}) {
  const began=now(),deadlineAt=began+budget(budgetMs),timing={inputReceivedAt:began,modelDeliveredAt:null};
  if (!Number.isInteger(mutationTimeoutMs) || mutationTimeoutMs < 1 || mutationTimeoutMs > 30000) throw new TypeError('Mutation timeout must be 1-30000 ms');
  if (q.postSendWaitMs!==undefined && (!Number.isInteger(q.postSendWaitMs)||q.postSendWaitMs<budgetMs||q.postSendWaitMs>55000)) throw new TypeError('postSendWaitMs must be between the original command budget and 55000 ms');
  if (typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,70}$/.test(q.id) || typeof q.room !== 'string' || !Number.isInteger(q.rqid) || !Array.isArray(q.actions) || !q.actions.length) throw new TypeError('Authored actions require a command ID, exact observed room/rqid and a complete pair');
  const action=(stateOf(observed)?.actions || []).find(a => a.room === q.room && a.rqid === q.rqid && actionable(a) && (!q.kind || a.kind === q.kind));
  if (!action || q.token && q.token !== action.token) return {...await recovery({localNotSent:true,call,observe,now,deadlineAt}),timing};
  const args={confirmed:true,commandId:q.id,token:action.token,actions:structuredClone(q.actions)};
  let staged;
  if (now() >= deadlineAt) return {...await recovery({reply:{error:'Transport budget ended before staging'},localNotSent:true,call,observe,now,deadlineAt}),timing};
  timing.stageDispatchedAt=now();
  try {staged=await boundedCall(call,'battle_stage_fallback',{...args,commandId:q.id+'-stage'},remaining(deadlineAt,now,mutationTimeoutMs));}
  catch {return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,stageWaitEndedAt:now()}};}
  timing.stageSettledAt=now();
  if (isReplyError(staged)) return {...await recovery({reply:staged,call,observe,now,deadlineAt}),timing};
  const pending=stateOf(staged)?.pending?.find(item => item.token === action.token);
  let sent,ordinarySendSkipped;
  if (pending?.attempted) ordinarySendSkipped='staged request already attempted; preserve reservation';
  else {
    if (now() >= deadlineAt) return {...await recovery({reply:{error:'Transport budget ended after staging; preserve the staged pair',recovery:{outcome:'staged-only'}},call,observe,now,deadlineAt}),timing};
    timing.chooseDispatchedAt=now();
    try {sent=await boundedCall(call,'battle_choose',{...args,validForMs:10000},remaining(deadlineAt,now,mutationTimeoutMs));}
    catch {return {...await recovery({uncertain:true,call,observe,now,deadlineAt}),timing:{...timing,chooseWaitEndedAt:now()}};}
    timing.chooseSettledAt=now();
    if (isReplyError(sent)) return {...await recovery({reply:sent,call,observe,now,deadlineAt}),timing};
  }
  // Only this read-only phase after a send or preserved reservation may use the
  // opt-in larger total window. Staging,
  // choosing, rejection and uncertain-write recovery keep the original budget.
  const nextDeadlineAt=q.postSendWaitMs===undefined?deadlineAt:began+q.postSendWaitMs;
  const next=await waitForNext({call,observe,origin:action,parentId:action.parentId || (action.room.startsWith('game-bestof3-') ? action.room : undefined),deadlineAt:nextDeadlineAt,now,autoReady,continueOnIdle:q.postSendWaitMs!==undefined});
  return {sent,ordinarySendSkipped,next,timing};
}

export async function startNext({q,call,observe=async()=>{},now=Date.now,budgetMs=20000}) {
  const deadlineAt=now()+budget(budgetMs);
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
  return {started,next:await waitForNext({call,observe,priorParentIds,deadlineAt,now,autoReady:stateOf(before).autoReady})};
}
