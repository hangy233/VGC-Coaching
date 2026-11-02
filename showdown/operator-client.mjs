import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {publishResponse, sanitizeResponse} from './operator-response.mjs';
import * as defaultActions from './action-next.mjs';
import {validateChoice} from './choice-validation.mjs';
import {validateTurnPlan,validatePreviewPlan} from './turn-plan.mjs';
import {boundAction,createObservedPlanningSheetCache} from '../planning/source.mjs';
import {boardDigest,digest} from '../planning/identity.mjs';
import {timingSpan, timingEvent, timingImport, withTimingSpan, currentTimingContext, timingRequestKey} from '../observability/timing.mjs';
import {MODEL_TOOL_NAMES,bindModelToolArguments,modelToolDefinition} from './model-owned-tools.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
// Capture once when this helper module is loaded. A later source edit cannot
// make an older running operator claim that it adopted the changed code.
const OPERATOR_INFO=Object.freeze({
  kind:'local-maintained-operator-info',loadedAt:new Date().toISOString(),
  features:{localReadOnlyInfo:true,readOnlyRegisteredSheets:true,retainedObservedSheetCache:true,previewTeamShorthand:true,timingTraceOptIn:true,deadlineOwnedSubmission:true,modelOwnedToolExecutor:true,modelInterrupt:false},
  modules:Object.fromEntries(['showdown/operator-client.mjs','showdown/client.mjs','showdown/battle-state.mjs','showdown/protocol-action.mjs',
    'showdown/action-next.mjs','showdown/choice-validation.mjs','showdown/operator-response.mjs','showdown/operator-view.mjs','showdown/simulation-decision-view.mjs','showdown/turn-plan.mjs',
    'planning/source.mjs','planning/identity.mjs','showdown/model-owned-tools.mjs','planning/research-budget.mjs','simulation/choice-presentation.mjs',
    'simulation/turn-simulator.mjs','simulation/move-support.mjs','simulation/native-state.mjs','simulation/approximate-position.mjs','simulation/history-state.mjs','simulation/schemas.mjs','simulation/turn-worker.mjs','simulation/observed-position.mjs','simulation/mcp-tools.mjs',
    'observability/timing.mjs','observability/store.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../'+name,import.meta.url))).digest('hex')])),
  limitation:'Local helper source fingerprints captured at module load; no battle-client or calculator-server adoption, authentication, control ownership, tactical correctness or live timing guarantee is established.',
});
const ID = /^[A-Za-z0-9_.:-]{1,60}$/;
const COMMAND_ID = /^[A-Za-z0-9_-]{1,70}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const SHEET_ROOM = /^(?:battle|game-bestof3)-[a-z0-9-]{1,190}$/;
const MAX_SHEET_VIEW_BYTES = 65536;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// This is an explicit transport surface, not an arbitrary MCP proxy. In
// particular, login, allowance extension, roster changes and deletion are absent.
const READ_TOOLS = new Set([
  'battle_status', 'battle_turn_status', 'battle_wait', 'battle_capabilities',
  'battle_control_trace', 'battle_decision_notes', 'battle_skill_status',
  'battle_skill_read', 'battle_review_get', 'battle_review_status',
  'battle_preflight', 'battle_calculation_evidence', 'battle_timing_report',
  'team_metrics_health', 'team_metrics_game_annotations', 'team_metrics_compare',
  'team_metrics_viewer_status', 'team_metrics_list', 'team_metrics_report',
  'team_metrics_agent_report', 'team_metrics_game_evidence',
  'calculate_damage', 'calculate_damage_range', 'calculate_speed', 'simulate_turn', 'simulate_turn_batch', 'battle_turn_brief', 'battle_check_plan', 'battle_prepare_checks', 'battle_resolve_checks', 'battle_run_checks', 'get_type_effectiveness',
  'get_pokemon', 'get_movepool', 'get_move', 'search_pokemon', 'search_move',
  'search_item', 'search_ability', 'search_nature', 'validate_pokemon',
  'validate_team', 'classify_team', 'get_usage_stats', 'get_pokemon_usage',
  'get_champions_usage_stats', 'get_champions_pokemon_usage',
]);
const WRITE_TOOLS = new Set([
  'battle_control_claim', 'battle_control_release', 'battle_set_control_policy', 'battle_withdraw_fallback',
  'battle_ready', 'battle_cancel_search', 'battle_forfeit', 'battle_save_replays',
  'battle_set_timer', 'battle_set_timer_policy', 'battle_set_replay_policy', 'battle_stop',
  'battle_note_decision', 'battle_skill_sync', 'battle_review_save',
  'team_metrics_sync_battles', 'team_metrics_finalize_bo3',
  'team_metrics_annotate_game', 'team_metrics_import',
  'team_metrics_import_replays', 'team_metrics_export',
]);
// These operations may verify several retained games, hashes and replay files.
// Their local recording/retention budget must not inherit a live choice's short
// socket deadline. This does not change the client's turn or watchdog budgets.
const POST_SET_WRITE_TOOLS = new Set([
  'battle_save_replays', 'battle_skill_sync', 'battle_review_save',
  'team_metrics_sync_battles', 'team_metrics_finalize_bo3',
  'team_metrics_annotate_game', 'team_metrics_import',
  'team_metrics_import_replays', 'team_metrics_export',
]);
const POST_SET_FAILURE = Symbol('post-set-rpc-failure');
const MODEL_SOURCE_REFUSAL=Symbol('model-pre-mutation-source-refusal');
const LEASED_TOOLS = new Set([
  'battle_control_release', 'battle_set_control_policy', 'battle_ready', 'battle_withdraw_fallback',
  'battle_cancel_search', 'battle_forfeit', 'battle_save_replays',
  'battle_set_timer', 'battle_set_timer_policy', 'battle_set_replay_policy', 'battle_stop',
  'battle_start', 'battle_stage_fallback', 'battle_choose',
]);
const HELPER_TOOLS = new Set(['battle_start', 'battle_stage_fallback', 'battle_choose']);
const SCHEMA_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...HELPER_TOOLS]);
const body = value => value?.data ?? value?.result ?? value;
const failed = value => value?.ok === false || value?.isError === true;
const succeeded = value => value && !failed(value);
const epoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const IMMEDIATE_READ_TOOLS = new Set(['battle_status', 'battle_turn_status', 'battle_wait', 'battle_capabilities']);
const BETWEEN_SET_TOOLS = new Set([...POST_SET_WRITE_TOOLS, 'battle_skill_read', 'team_metrics_health',
  'team_metrics_report', 'team_metrics_agent_report', 'team_metrics_compare', 'team_metrics_game_evidence',
  'battle_review_get', 'battle_review_status', 'battle_preflight', 'battle_timing_report']);

function retainedSkillReadProof(value,commandId,now){
  const data=body(value),expiresAt=Date.parse(data?.receiptExpiresAt);
  if(failed(value)||data?.skill!=='champions-mc-matchups'||data.synchronized!==true||!TOKEN.test(data.sourceSha256??'')||
    data.installedSha256!==data.sourceSha256||typeof data.readReceipt!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(data.readReceipt)||
    !Number.isFinite(expiresAt)||expiresAt<=now()||!Number.isInteger(data.files)||data.files<1||data.files>512||!Array.isArray(data.filesRead)||data.filesRead.length!==data.files)return null;
  let total=0;const paths=new Set(),rows=[];
  for(const file of data.filesRead){
    if(!plainObject(file)||typeof file.path!=='string'||!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,1024}$/u.test(file.path)||paths.has(file.path)||
      typeof file.content!=='string'||!TOKEN.test(file.sha256??''))return null;
    const contentBytes=Buffer.byteLength(file.content,'utf8');total+=contentBytes;
    if(contentBytes>1024*1024||total>8*1024*1024||createHash('sha256').update(file.content,'utf8').digest('hex')!==file.sha256)return null;
    paths.add(file.path);rows.push([file.path,file.sha256,contentBytes]);
  }
  rows.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return {kind:'operator-retained-skill-read-proof',version:1,commandId,skill:data.skill,sourceSha256:data.sourceSha256,installedSha256:data.installedSha256,
    files:data.files,deliverySha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),receiptExpiresAt:data.receiptExpiresAt,receiptRetained:true};
}

function missingPlan(state) {
  return state.actions?.find(action => {
    if (action.kind === 'ready') return state.autoReady !== true && action.actionable !== false;
    if (action.actionable === false || ['sent', 'uncertain', 'accepted', 'execution-observed'].includes(action.submissionStatus)) return false;
    const record = state.controlPolicy?.pending?.find(item => item.token === action.token && item.room === action.room && item.rqid === action.rqid);
    return !(record?.hasFallback === true && record.fallbackSource === 'fallback' && record.attempted !== true);
  });
}

/** Preserve structured negative replies as values, including their recovery
 * state. An MCP isError bit is metadata, never grounds to discard a JSON board.
 */
export function unpackToolResult(response) {
  let value = response?.structuredContent;
  if (value === undefined) {
    const text = response?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (text !== undefined) {
      try { value = JSON.parse(text); } catch { value = {text}; }
    } else value = response;
  }
  // The native wrapper's receipt is separate from the calculator's numerical
  // payload. Keep its actual remaining allowance visible through the bridge.
  if(plainObject(response?.researchBudget))value=plainObject(value)?{...value,researchBudget:response.researchBudget}:{value,researchBudget:response.researchBudget};
  if (response?.isError === true) return plainObject(value) ? {...value, isError: true} : {value, isError: true};
  return value;
}

// Actual turnSnapshot values are already bounded by the session. Keep all board,
// legal-action, clock, request-age and urgency fields verbatim. Only an explicitly
// requested full status may expose the historical full snapshot.
export function compactView(value) {
  if (Array.isArray(value)) return value.map(compactView);
  if (!plainObject(value)) return value;
  if (Array.isArray(value.boards)) return value;
  if (value.sessionId && Array.isArray(value.rooms)) {
    return {...value, notices: value.notices?.slice(-4), rooms: value.rooms.map(room => {
      const {state, sheets, ...compactRoom} = room;
      return compactRoom;
    })};
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactView(item)]));
}

// A local presentation of one actual native status read, never a token-bearing
// board or an alternate session/IPC implementation. Keep complete native sheets
// and explicit provenance while excluding status history and capabilities even
// when the caller requests full output. Exceeding the bound fails explicitly;
// it never silently drops members, sides, characters or selected rooms.
function registeredSheets(value, room, readSettledAt) {
  const data = body(value);
  if (failed(value) || !plainObject(data) || typeof data.sessionId !== 'string' || !data.sessionId ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.rooms)) {
    throw new Error('Native battle_status did not provide source-bound registered sheets');
  }
  const observed = data.rooms.filter(item => plainObject(item) && typeof item.id === 'string' &&
    SHEET_ROOM.test(item.id) && (room === undefined ? item.ended === false : item.id === room));
  if (new Set(observed.map(item => item.id)).size !== observed.length) throw new Error('Native sheet room identity is ambiguous');
  const rooms = observed.flatMap(item => {
    const sheets = {};
    for (const side of ['p1', 'p2']) {
      if (!plainObject(item.sheets) || !Object.hasOwn(item.sheets, side) || item.sheets[side] === '') continue;
      if (typeof item.sheets[side] !== 'string') throw new Error('Native registered sheet format is unsupported; no partial sheet was published');
      sheets[side] = item.sheets[side];
    }
    return Object.keys(sheets).length ? [{roomId: item.id,
      ...(typeof item.teamId === 'string' && TOKEN.test(item.teamId) ? {teamId: item.teamId} : {}),
      ...(typeof item.ended === 'boolean' ? {ended: item.ended} : {}), sheets}] : [];
  });
  const result = {kind: 'registered-open-team-sheets', source: {tool: 'battle_status', sessionId: data.sessionId,
    snapshotRevision: data.revision, readSettledAt},
    ...(room === undefined ? {roomScope: 'observed-live-rooms'} : {roomScope: 'exact-observed-room', requestedRoom: room}),
    status: rooms.length ? 'sheets-observed' : room !== undefined && !observed.length ? 'room-not-observed' : 'no-sheets-observed',
    format: 'native-pokemon-showdown-packed-open-team', rooms,
    completeness: 'Every returned side retains its complete observed packed sheet, without decoding or truncation.',
    uncertainty: 'Registered six are not selected four. Unknown opposing investments and next actions remain unknown. No action token or handoff readiness is established; the receiver must obtain its own fresh turn.'};
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SHEET_VIEW_BYTES) {
    throw new Error('Complete registered sheets exceed the 65536-byte view bound; use an exact observed room filter. No partial sheet was published');
  }
  return result;
}

function verifyIdentity(value, identity) {
  const data = body(value);
  if (failed(value) || data?.sessionId !== identity.sessionId || data.teamSha256 !== identity.teamId ||
      data.connected !== true || data.authenticated !== true || data.stopped === true ||
      identity.account !== undefined && data.username !== identity.account) {
    throw new Error('The expected connected, authenticated session and approved team are not available');
  }
  return data;
}

function assertIdle(data) {
  const search = data.search;
  const noGames = search && Object.hasOwn(search, 'games') && (search.games === null || plainObject(search.games) && !Object.keys(search.games).length);
  if (data.actions?.some(action => action.actionable !== false) || data.searchPending || data.awaitingSet ||
      data.savingReplays || data.switchingTeam || !Array.isArray(search?.searching) || search.searching.length ||
      !noGames || data.rooms?.some(room => room.id?.startsWith('game-bestof3-') && !room.ended)) {
    throw new Error('A fresh server-confirmed idle session is required for a search');
  }
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** Attach to an existing MCP client. Creation performs no tool calls, claims,
 * authentication, team changes or searches. Private capabilities never escape
 * this closure, including through dispatch's returned value.
 */
export function createOperator({client, responseFile, maxSearches = 0, publish = publishResponse,
  now = Date.now, actionHelpers = defaultActions, budgetMs = 20000, readTimeoutMs = 20000,
  mutationTimeoutMs = 5000, postSetTimeoutMs = 30000, timingRecorder, onTimingFlush,
  onState,returnAfterModelSend=false} = {}) {
  if (!client || typeof client.callTool !== 'function') throw new TypeError('An MCP SDK client is required');
  if (typeof responseFile !== 'string' || !responseFile) throw new TypeError('A response file is required');
  if (typeof publish !== 'function' || typeof now !== 'function') throw new TypeError('Publisher and clock functions are required');
  if (timingRecorder !== undefined && typeof timingRecorder?.run !== 'function') throw new TypeError('Timing recorder requires run(context, fn)');
  if (onTimingFlush !== undefined && typeof onTimingFlush !== 'function') throw new TypeError('Timing flush callback must be a function');
  if (onState !== undefined && typeof onState !== 'function') throw new TypeError('Native observation callback must be a function');
  if(typeof returnAfterModelSend!=='boolean')throw new TypeError('Post-send pondering handoff must be boolean');
  integer(maxSearches, 0, 100, 'maxSearches');
  integer(budgetMs, 1, 20000, 'budgetMs');
  integer(readTimeoutMs, 1, 30000, 'readTimeoutMs');
  integer(mutationTimeoutMs, 1, 30000, 'mutationTimeoutMs');
  integer(postSetTimeoutMs, 1, 30000, 'postSetTimeoutMs');
  for (const name of ['playNext', 'startNext', 'waitForNext']) {
    if (typeof actionHelpers[name] !== 'function') throw new TypeError(`actionHelpers.${name} is required`);
  }
  let armedIdentity, controllerLease, controllerProof, readReceipt, currentCompact, currentStatus, lastOrigin,guidanceReadProof,guidanceReadReceipt;
  let activeContext, dispatching = false, closed = false, searchesAttempted = 0;
  const usedIds = new Set(), searchReservations = new Set(), choiceReservations = new Map(), stagedPlans = new Map(), secrets = new Set();
  const observedSheets = createObservedPlanningSheetCache();
  let modelToolMode=false,modelToolCatalog;
  const modelAdmissions=new Map();
  let decisionPolicy={enabled:false,commitBufferMs:5000};
  const requireArmed = () => { if (!armedIdentity) throw new Error('Read-only mode: explicitly arm the expected existing session and team first'); };
  const requireOwner = () => { requireArmed(); if (!controllerLease) throw new Error('Explicit battle_control_claim is required before a leased operation'); };
  const rememberSecret = value => { if (typeof value === 'string' && value) secrets.add(value); };
  const flushTiming = () => { if (onTimingFlush) { try { Promise.resolve(onTimingFlush()).catch(() => {}); } catch {} } };
  const timingContext = q => {
    const request = (Array.isArray(currentCompact?.actions) ? currentCompact.actions : []).find(action => action.room === q.room && action.rqid === q.rqid && (!q.token || action.token === q.token));
    const timing = (Array.isArray(currentCompact?.timing?.requests) ? currentCompact.timing.requests : []).find(item => item.room === q.room && item.rqid === q.rqid && (!q.token || item.token === q.token));
    return {...currentTimingContext(), commandId: q.id, operation: q.op,
      ...(armedIdentity?.teamId ? {teamId: armedIdentity.teamId} : {}),
      ...(request ? {requestKey: timingRequestKey({sessionId: currentCompact.sessionId, roomId: request.room, rqid: request.rqid, token: request.token}),
        roomId: request.room, rqid: request.rqid, requestReceivedAt: timing?.receivedAt ?? request.receivedAt,
        cutoffAt: timing?.cutoffAt, turn: currentCompact.boards?.find(board => board.room === request.room)?.turn} : {})};
  };

  function observe(value, context) {
    if (context && activeContext !== context) return;
    const data = body(value);
    if (typeof data?.readReceipt === 'string' && succeeded(value)) {
      readReceipt = data.readReceipt; rememberSecret(readReceipt);
    }
    const originalState = value?.recovery?.state ?? data;
    if (!plainObject(originalState)) return value;
    const state = observedSheets.observe(originalState,armedIdentity);
    if (state.sessionId && state.teamSha256 && Array.isArray(state.rooms) && !failed(value)) {
      currentStatus = state;
    }
    if (state.sessionId && Array.isArray(state.boards)) {
      currentCompact = state;
      if (context) context.timing.boardCapturedAt = epoch(state.observedAt) ? state.observedAt : now();
      for (const action of Array.isArray(state.actions) ? state.actions : []) {
        const request = (Array.isArray(state.timing?.requests) ? state.timing.requests : []).find(item => item.room === action.room && item.rqid === action.rqid && item.token === action.token);
        const receivedAt = request?.receivedAt ?? action.receivedAt;
        if (epoch(receivedAt)) timingEvent('request.observed', {requestKey: timingRequestKey({sessionId: state.sessionId, roomId: action.room, rqid: action.rqid, token: action.token}),
          teamId: armedIdentity?.teamId, roomId: action.room, rqid: action.rqid,
          turn: state.boards.find(board => board.room === action.room)?.turn, requestReceivedAt: receivedAt, cutoffAt: request?.cutoffAt});
      }
    }
    // Read-only observers may cancel speculative work immediately. They never
    // own native control, change this response or delay the active request.
    if(state.sessionId&&Array.isArray(state.rooms))try{onState?.(state);}catch{}
    if(state===originalState)return value;
    if(value?.recovery?.state===originalState)return {...value,recovery:{...value.recovery,state}};
    if(value?.data===originalState)return {...value,data:state};
    if(value?.result===originalState)return {...value,result:state};
    return state;
  }

  async function call(context, name, supplied = {}, options = {}) {
    const modelRead=context.op==='model-tool'&&modelToolMode&&MODEL_TOOL_NAMES.includes(name);
    if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name) && !HELPER_TOOLS.has(name)&&!modelRead) throw new Error('Tool is not supported by this operator');
    if (!plainObject(supplied)) throw new TypeError('Tool arguments must be a JSON object');
    if (!READ_TOOLS.has(name)) requireArmed();
    const args = {...supplied};
    if(name==='battle_skill_read'){guidanceReadProof=undefined;guidanceReadReceipt=undefined;}
    // Caller-provided private capabilities are never accepted or forwarded.
    delete args.controllerLease;
    delete args.readReceipt;
    if ((LEASED_TOOLS.has(name) || name === 'battle_control_claim') && args.confirmed !== true) {
      throw new Error('This control operation requires an explicit confirmed:true command');
    }
    if (LEASED_TOOLS.has(name)) { requireOwner(); args.controllerLease = controllerLease; }
    if (HELPER_TOOLS.has(name) && !context.helper) throw new Error('Use the dedicated play-next or start-next operation');
    if (name === 'battle_review_save') {
      if (!readReceipt) throw new Error('Read the complete current guidance before saving a review');
      args.readReceipt = readReceipt;
    }
    if (name === 'battle_start') {
      if (context.op !== 'start-next' || args.confirmed !== true) throw new Error('Only an explicitly confirmed start-next may search');
      verifyIdentity(currentStatus, armedIdentity); assertIdle(currentStatus);
      if (searchReservations.has(args.commandId)) throw new Error('Search command already reserved; inspect the existing outcome without resending');
      if (searchesAttempted >= maxSearches) throw new Error('Operator search limit exhausted; it cannot extend the authorized allowance');
      // Consume BEFORE SDK I/O. Timeout, abort and transport uncertainty cannot
      // refund scope or be interpreted as proof that nothing was sent.
      searchReservations.add(args.commandId); searchesAttempted++;
    }
    if (name === 'battle_wait' && context.full !== true) args.format = 'compact';
    const defaultTimeoutMs = READ_TOOLS.has(name)||modelRead ? readTimeoutMs :
      POST_SET_WRITE_TOOLS.has(name) ? postSetTimeoutMs : mutationTimeoutMs;
    const timeoutMs = integer(options.timeoutMs ?? defaultTimeoutMs, 1, 30000, 'SDK timeoutMs');
    const dispatchedAt = now();
    context.timing.mcpDispatchedAt ??= dispatchedAt;
    // A broken transport can ignore the SDK timeout/AbortSignal and settle
    // after the helper has moved on to recovery. Its reply is no longer an
    // observation, even while this same dispatch is publishing a newer board.
    const ownsObservation = () => activeContext === context && options.signal?.aborted !== true;
    const span = timingSpan('operator.mcp_call', {tool: name, timeoutMs,
      phase: name === 'battle_wait' ? 'battle_wait' : 'tool'});
    const aborted = () => timingEvent('operator.mcp_wait_aborted', {tool: name, timeoutMs, observationOwnership: false, outcomeCertainty: 'unknown'});
    options.signal?.addEventListener('abort', aborted, {once: true});
    return span.run(async () => {
    try {
      // SDK RequestOptions is the THIRD argument, not a tool argument or result
      // schema. Aborting a wait does not establish a cancelled mutation.
      const correlation = currentTimingContext();
      context.nativeCallsStarted=(context.nativeCallsStarted??0)+1;
      const response = await client.callTool({name, arguments: args,
        ...(correlation ? {_meta: {'vgc/timing': {...correlation, returnEvents: true}}} : {})}, undefined,
        {timeout: timeoutMs, ...(options.signal ? {signal: options.signal} : {})});
      const remoteEvents = response?._meta?.['vgc/timing-events'];
      if (Array.isArray(remoteEvents)) timingImport(remoteEvents.slice(0, 512));
      const value = unpackToolResult(response);
      if (!ownsObservation()) {
        timingEvent('operator.mcp_late_settlement', {tool: name, status: failed(value) ? 'refused' : 'ok', observationOwnership: false, outcomeCertainty: 'returned'});
        span.end('late', {observationOwnership: false, outcomeCertainty: 'returned'});
      } else span.end(failed(value) ? 'refused' : 'ok', {observationOwnership: true, outcomeCertainty: 'returned'});
      const observedValue = ownsObservation() ? observe(value, context) : value;
      if(ownsObservation()&&name==='battle_skill_read'){
        const proof=retainedSkillReadProof(value,context.commandId,now);
        if(proof){guidanceReadProof=proof;guidanceReadReceipt=body(value).readReceipt;}
      }
      if (ownsObservation() && name === 'battle_control_claim' && succeeded(value)) {
        const lease = body(value)?.controllerLease;
        if (typeof lease === 'string' && lease) {
          rememberSecret(lease);
          {
            controllerLease = lease;
            const claim=body(value),owner=claim.owner??claim.controller?.owner,generation=claim.generation??claim.controller?.generation;
            controllerProof=typeof owner==='string'&&owner&&Number.isSafeInteger(generation)?{owner,generation}:undefined;
            modelToolMode=false;modelToolCatalog=undefined;
          }
        }
      }
      if (ownsObservation() && ['battle_control_release', 'battle_stop'].includes(name) && succeeded(value)) {controllerLease = undefined;controllerProof=undefined;modelToolMode=false;modelToolCatalog=undefined;modelAdmissions.clear();}
      if(ownsObservation()&&name==='battle_withdraw_fallback'&&succeeded(value)&&body(value)?.withdrawn===true){
        const result=body(value),plan=stagedPlans.get(result.token),action=currentCompact?.actions?.find(a=>a.room===result.room&&a.rqid===result.rqid&&a.token===result.token);
        if(plan?.room===result.room&&plan.rqid===result.rqid&&action){
          try{const request={...action.legalActions,side:{pokemon:action.legalActions.pokemon}};if(validateChoice(request,plan.actions).choice===validateChoice(request,result.expectedActions).choice)stagedPlans.delete(result.token);}catch{/* Do not erase an unrelated or unverified local replacement. */}
        }
      }
      return observedValue;
    } catch (error) {
      const late = !ownsObservation();
      span.end(late ? 'late' : options.signal?.aborted ? 'cancelled' : error?.code === -32001 || error?.name === 'TimeoutError' ? 'timeout' : 'error', {observationOwnership: !late, outcomeCertainty: 'unknown'});
      if (late) timingEvent('operator.mcp_late_settlement', {tool: name, status: 'error', observationOwnership: false, outcomeCertainty: 'unknown'});
      if (!POST_SET_WRITE_TOOLS.has(name)) throw error;
      // A transport timeout cannot prove that remote recording or cleanup did
      // not finish. Keep the uncertainty explicit; never resend automatically.
      const failure = new Error(error?.message ?? 'Post-set MCP response unavailable');
      failure[POST_SET_FAILURE] = {outcome: 'mutation-uncertain', requiresReconciliation: true,
        tool: name, timeoutMs};
      throw failure;
    } finally {
      options.signal?.removeEventListener('abort', aborted);
      if (ownsObservation()) context.timing.mcpSettledAt = now();
    }
    });
  }

  function assertModelOwner(state){
    requireOwner();verifyIdentity(currentStatus,armedIdentity);
    const control=state?.controller;
    if(!controllerProof||control?.required!==true||control.owner!==controllerProof.owner||control.generation!==controllerProof.generation)
      throw new Error('Model tools require the current exclusive controller owner');
  }
  async function modelWait(action,{timeoutMs,signal}={}){
    if(signal?.aborted)throw Object.assign(new Error('Model operation aborted before native dispatch'),{code:'MODEL_OPERATION_ABORTED'});
    const owned=new AbortController(),linked=signal?AbortSignal.any([owned.signal,signal]):owned.signal,deadline=now()+timeoutMs;
    let onAbort,timer,drain,settled=false;
    const pending=Promise.resolve().then(()=>{
      if(linked.aborted)throw Object.assign(new Error('Model operation aborted before native dispatch'),{code:'MODEL_OPERATION_ABORTED'});
      return action({signal:linked});
    });
    pending.then(()=>{settled=true;},()=>{settled=true;});
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{owned.abort();reject(Object.assign(new Error('Model operation aborted; no retry is authorized'),{code:'MODEL_OPERATION_ABORTED'}));};
      signal?.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{owned.abort();reject(Object.assign(new Error('Prepared research budget elapsed'),{code:'MODEL_OPERATION_DEADLINE'}));},timeoutMs);
    });
    try{
      const value=await Promise.race([pending,interrupted]);
      if(linked.aborted||now()>=deadline)throw Object.assign(new Error('Native model operation settled after its original deadline'),{code:'MODEL_OPERATION_DEADLINE'});
      return value;
    }catch(error){
      owned.abort();
      // Drain the actual SDK promise, not merely an aborted wrapper. A broken
      // transport may remain pending; its later reply cannot regain observation.
      if(!settled){await Promise.race([pending.catch(()=>{}),new Promise(resolve=>{drain=setTimeout(resolve,250);})]);
        if(!settled){error.code=signal?.aborted?'MODEL_OPERATION_ABORT_DRAIN_UNSETTLED':'MODEL_OPERATION_DEADLINE_DRAIN_UNSETTLED';error.message='Native model wait did not settle during bounded cancellation drain';}}
      throw error;
    }finally{clearTimeout(timer);clearTimeout(drain);owned.abort();signal?.removeEventListener('abort',onAbort);}
  }
  async function modelRequest(q,invoke,signal){
    if(!modelToolMode)throw new Error('Explicit owned model-tool-mode setup is required');
    requireOwner();
    if(!COMMAND_ID.test(q.id)||typeof q.room!=='string'||!Number.isInteger(q.rqid)||!TOKEN.test(q.token??'')||!epoch(q.deadlineAt)||q.deadlineAt<=now())
      throw new TypeError('Model operations require an exact request and live original absolute deadline');
    const prior=choiceReservations.get(q.token);
    if(prior&&prior.outcome!=='not-sent')throw new Error('Preserve the existing submission reservation; no model operation may retry it');
    const timeoutMs=Math.max(1,Math.floor(Math.min(1500,readTimeoutMs,q.deadlineAt-now())));
    const fresh=await modelWait(({signal})=>invoke('battle_turn_status',{}, {timeoutMs,signal}),{timeoutMs,signal});
    if(failed(fresh))throw new Error('Fresh model request is unavailable');
    const state=body(fresh);assertModelOwner(state);
    const source={sessionId:armedIdentity.sessionId,teamId:armedIdentity.teamId,room:q.room,rqid:q.rqid,token:q.token};
    let action,board;
    try{({action,board}=boundAction(state,source,{now}));}
    catch(error){
      if(q.op==='model-play'&&state.connected===true&&state.authenticated===true&&state.stopped===false){
        error.code='MODEL_REQUEST_NOT_CURRENT';
        error[MODEL_SOURCE_REFUSAL]={modelChoiceSourceRefusal:{version:1,stage:'fresh-source-validation',knownNotSent:true,nativeMutationAttempted:false,
          requestKeySha256:digest({room:q.room,rqid:q.rqid,token:q.token}),ownerGenerationSha256:digest({owner:controllerProof.owner,generation:controllerProof.generation})}};
      }
      throw error;
    }
    if(!['turn','switch','preview'].includes(action.kind)||q.kind!==undefined&&q.kind!==action.kind)throw new Error('Model operation kind differs from the exact current request');
    const cutoffs=[...(state.controlPolicy?.pending??[]),...(state.timing?.requests??[])].filter(row=>row.token===q.token&&row.room===q.room&&row.rqid===q.rqid).map(row=>row.cutoffAt).filter(Number.isFinite);
    if(!cutoffs.length)throw new Error('Original native model request cutoff is unavailable');
    const nativeCutoffAt=Math.min(...cutoffs),reserve=decisionPolicy.enabled?decisionPolicy.commitBufferMs:5000;
    if(q.deadlineAt>nativeCutoffAt-reserve)throw new Error('Model operation cannot extend the original native deadline or commit reserve');
    const boardHash=boardDigest(board,action.legalActions),legalHash=digest(action.legalActions);
    if(!plainObject(q.expectedSource)||Object.keys(q.expectedSource).length!==2||!TOKEN.test(q.expectedSource.boardHash??'')||!TOKEN.test(q.expectedSource.legalHash??'')||
      q.expectedSource.boardHash!==boardHash||q.expectedSource.legalHash!==legalHash)throw new Error('Model context source changed before the current operation');
    const sourceSha256=digest({...source,boardHash,legalHash}),admitted=modelAdmissions.get(q.token);
    if(admitted&&(admitted.sourceSha256!==sourceSha256||q.deadlineAt>admitted.deadlineAt))throw new Error('Model request source changed or its original deadline was extended');
    if(now()>=q.deadlineAt)throw new Error('Original model deadline elapsed during source validation');
    modelAdmissions.set(q.token,{sourceSha256,deadlineAt:q.deadlineAt});
    return {state,action,board,source,sourceSha256,deadlineAt:q.deadlineAt,nativeCutoffAt};
  }

  async function execute(q, context) {
    if (Object.hasOwn(q, 'team')) {
      if (Object.hasOwn(q, 'actions')) throw new TypeError('Supply either preview team or actions, never both');
      if (!['stage-next', 'play-next'].includes(q.op)) throw new TypeError('team shorthand is available only for an exact current preview with stage-next or play-next');
    }
    if (q.op === 'operator-info') return structuredClone(OPERATOR_INFO);
    if(q.op==='decision-policy'){
      requireArmed();
      if(Object.keys(q).some(key=>!['id','op','enabled','commitBufferMs'].includes(key)))throw new TypeError('Unsupported decision-policy field');
      if(q.enabled!==undefined&&typeof q.enabled!=='boolean')throw new TypeError('Decision policy enabled must be boolean');
      if(q.commitBufferMs!==undefined)integer(q.commitBufferMs,5000,15000,'commitBufferMs');
      decisionPolicy={...decisionPolicy,...Object.fromEntries(['enabled','commitBufferMs'].filter(key=>q[key]!==undefined).map(key=>[key,q[key]]))};
      return {kind:'decision-policy',...decisionPolicy,controlUnchanged:true,modelInterruptSupported:false};
    }
    const invoke = (name, args, options) => call(context, name, args, options);
    const helpers = {q, call: invoke, observe: value => observe(value, context), now, budgetMs,commitBufferMs:decisionPolicy.enabled?decisionPolicy.commitBufferMs:5000,
      mutationTimeoutMs, autoReady: currentCompact?.autoReady ?? currentStatus?.autoReady};
    if(q.op==='model-tool-mode'){
      if(Object.keys(q).some(key=>!['id','op','enabled','full'].includes(key))||typeof q.enabled!=='boolean')throw new TypeError('Model tool setup accepts only an explicit enabled flag');
      requireOwner();const fresh=await invoke('battle_status');assertModelOwner(body(fresh));
      modelToolMode=q.enabled;modelToolCatalog=undefined;
      return {kind:'model-tool-mode',enabled:modelToolMode,planning:'battle-model-owned',automaticResearch:false,automaticActionSelection:false};
    }
    if(q.op==='model-tool-catalog'){
      if(Object.keys(q).some(key=>!['id','op','full'].includes(key)))throw new TypeError('Model catalog accepts no capabilities or tool arguments');
      if(!modelToolMode)throw new Error('Explicit owned model-tool-mode setup is required');
      requireOwner();const fresh=await invoke('battle_status');assertModelOwner(body(fresh));
      if(typeof client.listTools!=='function')throw new Error('Native model tool catalog is unavailable');
      const listed=await modelWait(async({signal})=>{const tools=[],seen=new Set(),deadline=now()+readTimeoutMs;let cursor;
        for(let page=0;page<16;page++){
          if(signal.aborted||now()>=deadline)throw new Error('Native model catalog deadline elapsed');
          const reply=await client.listTools(cursor?{cursor}:undefined,{timeout:Math.max(1,Math.floor(deadline-now())),signal});
          if(!Array.isArray(reply?.tools))throw new Error('Native model tool catalog is malformed');tools.push(...reply.tools);
          if(Buffer.byteLength(JSON.stringify(tools))>8*1024*1024)throw new Error('Complete native model catalog exceeds its bounded source size');
          if(!reply.nextCursor)return {tools};
          if(typeof reply.nextCursor!=='string'||seen.has(reply.nextCursor))throw new Error('Native model catalog cursor is invalid or repeated');
          seen.add(reply.nextCursor);cursor=reply.nextCursor;
        }
        throw new Error('Complete native model catalog exceeds its bounded page count');
      },{timeoutMs:readTimeoutMs,signal:context.signal});
      const allowed=listed.tools.filter(tool=>MODEL_TOOL_NAMES.includes(tool.name)&&
        (tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true));
      if(new Set(allowed.map(tool=>tool.name)).size!==allowed.length)throw new Error('Native model tool catalog has ambiguous duplicate names');
      const tools=allowed.map(modelToolDefinition).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
      modelToolCatalog=new Map(tools.map(tool=>[tool.name,tool]));
      return {kind:'model-tool-catalog',tools,sha256:digest(tools),source:'actual-native-mcp-listTools',hostPlanning:false};
    }
    if(q.op==='model-tool'){
      if(Object.keys(q).some(key=>!['id','op','room','rqid','token','deadlineAt','expectedSource','name','args','full'].includes(key)))throw new TypeError('Unsupported model tool field');
      if(!modelToolCatalog?.has(q.name))throw new Error('Model tool was not advertised by the prepared native allowlist');
      const prepared=await modelRequest(q,invoke,context.signal),startedAt=now();
      const args=bindModelToolArguments(q.name,q.args,{source:prepared.source,turn:prepared.board.turn});
      const timeoutMs=Math.max(1,Math.floor(Math.min(30000,prepared.deadlineAt-now())));
      const native=await modelWait(({signal})=>invoke(q.name,args,{timeoutMs,signal}),{timeoutMs,signal:context.signal});
      if(now()>=prepared.deadlineAt)throw new Error('Native model tool result arrived after its original deadline');
      // Preserve every result field except private capabilities/source identity.
      // Numerical content is never projected, interpreted or used to select a pair.
      const result=sanitizeResponse(native,{redactValues:[...secrets,q.token,armedIdentity.sessionId]});
      return {kind:'model-tool-result',name:q.name,result,receipt:{commandId:q.id,sourceSha256:prepared.sourceSha256,
        argumentsSha256:digest(args),nativeResultSha256:digest(native),resultSha256:digest(result),
        startedAt,settledAt:now(),deadlineAt:prepared.deadlineAt,nativeCutoffAt:prepared.nativeCutoffAt,
        nativeMcp:true,modelRequested:true,hostPlanning:false,privateSourceRedacted:true}};
    }
    if(q.op==='model-play'){
      if(Object.keys(q).some(key=>!['id','op','room','rqid','token','deadlineAt','expectedSource','kind','actions','turnPlan','previewPlan','full'].includes(key)))throw new TypeError('Unsupported model final-choice field');
      const prepared=await modelRequest(q,invoke,context.signal);
      validateChoice({...prepared.action.legalActions,side:{...(prepared.action.legalActions.side??{}),pokemon:prepared.action.legalActions.pokemon??prepared.action.legalActions.side?.pokemon}},q.actions);
      if(q.turnPlan!==undefined){if(!['turn','switch'].includes(prepared.action.kind))throw new TypeError('Turn plan requires a turn or replacement');validateTurnPlan(q.turnPlan,{actions:q.actions});}
      if(q.previewPlan!==undefined){if(prepared.action.kind!=='preview')throw new TypeError('Preview plan requires preview');validatePreviewPlan(q.previewPlan,{actions:q.actions});}
      if(now()>=prepared.deadlineAt)throw new Error('Original model deadline elapsed before final choice');
      const {deadlineAt,full,expectedSource,...authored}=q;
      const reservation={commandId:q.id,outcome:'unknown'};choiceReservations.set(q.token,reservation);lastOrigin=prepared.action;context.helper=true;
      const waitMs=Math.max(1,Math.floor(Math.min(budgetMs,deadlineAt-now())));
      const result=await modelWait(({signal:playSignal})=>actionHelpers.playNext({...helpers,q:{...authored,op:'play-next'},observed:prepared.state,budgetMs:waitMs,returnAfterSend:returnAfterModelSend,
        call:(name,args,options={})=>{if(now()>=deadlineAt||playSignal.aborted)throw new Error('Original final-choice deadline elapsed or was aborted');return invoke(name,args,{...options,
          signal:options.signal?AbortSignal.any([options.signal,playSignal]):playSignal,
          timeoutMs:Math.max(1,Math.floor(Math.min(options.timeoutMs??mutationTimeoutMs,deadlineAt-now())))});}}),{timeoutMs:waitMs,signal:context.signal});
      if(result?.recovery?.outcome==='not-sent')reservation.outcome='not-sent';
      return {...result,modelOwnedChoice:{commandId:q.id,sourceSha256:prepared.sourceSha256,actionsSha256:digest(q.actions),deadlineAt,hostPlanning:false}};
    }
    // The owner must protect a freshly re-read request before optional work.
    // Observers stay read-only and can audit independently of the controller.
    const researchGate = async name => {
      if (!controllerLease) return null;
      let fresh;
      try { fresh = await invoke('battle_turn_status', {}, {timeoutMs: Math.min(readTimeoutMs, 1500)}); }
      catch { return {blocked: true, reason: 'current-request-unavailable', retry: false, requires: 'read current request before optional work'}; }
      const state = body(fresh);
      if (failed(fresh) || state?.sessionId !== armedIdentity.sessionId || !Array.isArray(state.actions)) {
        return {blocked: true, reason: 'current-request-unavailable', state: fresh, retry: false};
      }
      if (BETWEEN_SET_TOOLS.has(name)) {
        try { assertIdle(state); }
        catch { return {blocked: true, reason: 'between-sets-required', requires: 'finish the active set before reports or review', state: fresh, retry: false}; }
        // Idle reports/preflight can hash and inspect retained evidence. Give
        // that work its bounded post-set budget only AFTER the short fresh
        // request guard proves there is no live deadline to compromise.
        context.researchTimeoutMs=postSetTimeoutMs;
      }
      const action = missingPlan(state);
      if (action) return {blocked: true, reason: 'first-plan-required', requires: action.kind === 'ready' ? 'handle current readiness' : 'stage-next or play-next for this exact request', state: fresh, retry: false};
      const liveBattle = state.rooms?.some(room => room.id?.startsWith('battle-') && !room.ended);
      if (!liveBattle && (state.searchPending || state.awaitingSet || state.search?.searching?.length)) {
        return {blocked: true, reason: 'await-current-battle-request', requires: 'wait-next', state: fresh, retry: false};
      }
      if (liveBattle) context.researchTimeoutMs = Math.min(readTimeoutMs, 5000);
      const staged = state.controlPolicy?.pending?.filter(item => item.hasFallback && !item.attempted && item.fallbackSource === 'fallback') ?? [];
      if (liveBattle && staged.length) {
        const cutoffs = staged.map(item => item.cutoffAt).filter(Number.isFinite);
        const remaining = cutoffs.length ? Math.min(...cutoffs) - now() : 10000;
        const commitBufferMs=decisionPolicy.enabled?decisionPolicy.commitBufferMs:5000;
        if (remaining <= commitBufferMs) return {blocked: true, reason: 'commit-staged-plan-first', requires: 'commit-next or play-next before optional work', state: fresh, retry: false};
        context.researchTimeoutMs = Math.max(1, Math.min(readTimeoutMs, 5000, Math.floor(remaining - commitBufferMs)));
      }
      return null;
    };
    if (q.op === 'arm') {
      if (q.confirmed !== true || typeof q.expectedSessionId !== 'string' || !q.expectedSessionId ||
          !TOKEN.test(q.expectedTeamId ?? '') || q.expectedAccount !== undefined && typeof q.expectedAccount !== 'string') {
        throw new TypeError('Arming requires confirmed:true, expectedSessionId and expectedTeamId, with optional expectedAccount');
      }
      const identity = {sessionId: q.expectedSessionId, teamId: q.expectedTeamId,
        ...(q.expectedAccount === undefined ? {} : {account: q.expectedAccount})};
      if (armedIdentity && (armedIdentity.sessionId !== identity.sessionId || armedIdentity.teamId !== identity.teamId ||
          armedIdentity.account !== undefined && armedIdentity.account !== identity.account)) {
        throw new Error('An armed operator cannot change its session or approved team');
      }
      const fresh = verifyIdentity(await invoke('battle_status'), identity);
      armedIdentity = identity;
      return {armed: true, sessionId: fresh.sessionId, teamId: fresh.teamSha256, account: fresh.username,
        controller: fresh.controller, searchesAttempted, maxSearches, controlClaimed: Boolean(controllerLease)};
    }
    if (q.op === 'turn') return invoke('battle_turn_status');
    if (q.op === 'status') return invoke('battle_status');
    if (q.op === 'sheets') {
      if (Object.keys(q).some(key => !['id', 'op', 'room', 'full'].includes(key)) ||
          q.room !== undefined && (typeof q.room !== 'string' || !SHEET_ROOM.test(q.room))) {
        throw new TypeError('sheets accepts only an optional exact observed room ID and full output flag');
      }
      return registeredSheets(await invoke('battle_status'), q.room, now());
    }
    if (q.op === 'wait' || q.op === 'wait-next') return actionHelpers.waitForNext({...helpers,
      origin: q.origin ?? lastOrigin, parentId: q.parentId, priorParentIds: q.priorParentIds});
    if (['stage-next', 'commit-next', 'play-next'].includes(q.op)) {
      requireOwner();
      if (!COMMAND_ID.test(q.id) || !TOKEN.test(q.token ?? '') || typeof q.room !== 'string' || !Number.isInteger(q.rqid)) {
        throw new TypeError('A choice requires an exact cached room, rqid and token plus an alphanumeric command ID');
      }
      const action = currentCompact?.actions?.find(item => item.room === q.room && item.rqid === q.rqid && item.token === q.token &&
        item.actionable !== false && !['sent', 'uncertain'].includes(item.submissionStatus) && (!q.kind || item.kind === q.kind));
      if (!action || currentCompact.sessionId !== armedIdentity.sessionId) throw new Error('Authored actions do not match the cached compact request; read or wait for the current board');
      if (Object.hasOwn(q, 'team')) {
        const legal = action.legalActions;
        if (action.kind !== 'preview' || legal?.teamPreview !== true || !Array.isArray(legal.pokemon)) {
          throw new TypeError('team shorthand requires the exact current preview and its complete legality');
        }
        if (!Array.isArray(q.team) || !Array.from(q.team).every(Number.isInteger)) throw new TypeError('Invalid team-preview order');
        // Normalize only the explicitly authored order, then use the same
        // canonical validator and the ordinary leased stage/send path. Never
        // generate, reorder, complete or rebind a selection.
        const validated = validateChoice({teamPreview: true, maxChosenTeamSize: legal.maxChosenTeamSize,
          side: {pokemon: legal.pokemon}}, [{type: 'team', order: q.team}]);
        const {team, ...canonical} = q;
        helpers.q = {...canonical, actions: validated.actions};
      }
      if (q.op === 'commit-next') {
        if(q.previewPlan!==undefined)throw new TypeError('Commit cannot author a new previewPlan without the same explicit order; stage or play it instead');
        if(q.turnPlan!==undefined)validateTurnPlan(q.turnPlan);
        const plan = stagedPlans.get(q.token);
        if (!plan || plan.room !== q.room || plan.rqid !== q.rqid) throw new Error('No confirmed agent-staged pair for this exact request; inspect current state');
        if(q.expectedStagedActionsSha256!==undefined&&(!TOKEN.test(q.expectedStagedActionsSha256)||digest(plan.actions)!==q.expectedStagedActionsSha256))
          throw new Error('The confirmed staged pair changed before its bound commit; inspect current state');
        if (q.actions !== undefined) throw new TypeError('commit-next submits the stored staged actions; use play-next to author a changed pair');
        const {expectedStagedActionsSha256,...commit}=q;
        helpers.q = {...commit, actions: structuredClone(plan.actions),...(q.turnPlan===undefined&&plan.turnPlan?{turnPlan:structuredClone(plan.turnPlan)}:{}),...(plan.previewPlan?{previewPlan:structuredClone(plan.previewPlan)}:{})};
      }
      let authored = helpers.q;
      if (!Array.isArray(authored.actions) || !authored.actions.length || authored.actions.length > 2) throw new TypeError('Explicit complete actions are required');
      if(authored.actions.some(value=>!value||typeof value!=='object'||Array.isArray(value)))throw new TypeError('Structured action objects are required');
      // These are local input errors, before any mutation can have happened.
      // Reject them before reserving a token; uncertainty after dispatch still
      // keeps the existing reservation and never permits an automatic resend.
      if(authored.postSendWaitMs!==undefined&&(!Number.isInteger(authored.postSendWaitMs)||authored.postSendWaitMs<budgetMs||authored.postSendWaitMs>55000))throw new TypeError('postSendWaitMs must be between the original command budget and 55000 ms');
      if(authored.turnPlan!==undefined){
        if(!['turn','switch'].includes(action.kind))throw new TypeError('Turn plan metadata requires an active battle turn or replacement request');
        authored={...authored,turnPlan:validateTurnPlan(authored.turnPlan,{actions:authored.actions})};helpers.q=authored;
      }
      if(authored.previewPlan!==undefined){
        if(action.kind!=='preview')throw new TypeError('previewPlan metadata requires the current preview request');
        authored={...authored,previewPlan:validatePreviewPlan(authored.previewPlan,{actions:authored.actions})};helpers.q=authored;
      }
      const previous = choiceReservations.get(q.token);
      if (previous && previous.outcome !== 'not-sent') throw new Error('This request already has a submission reservation; no automatic resend is allowed');
      context.helper = true;
      if (q.op === 'stage-next') {
        stagedPlans.delete(q.token);
        const result = await (actionHelpers.stageNext??defaultActions.stageNext)({...helpers, observed: currentCompact});
        if (result.protection?.staged === true) stagedPlans.set(q.token, {room: q.room, rqid: q.rqid, actions: structuredClone(authored.actions),...(authored.turnPlan?{turnPlan:structuredClone(authored.turnPlan)}:{}),...(authored.previewPlan?{previewPlan:structuredClone(authored.previewPlan)}:{})});
        if (result.protection?.attempted === true || result.recovery?.outcome === 'mutation-uncertain') {
          stagedPlans.delete(q.token);
          choiceReservations.set(q.token, {commandId: q.id, outcome: 'unknown'});
        }
        return result;
      }
      const reservation = {commandId: q.id, outcome: 'unknown'};
      choiceReservations.set(q.token, reservation); lastOrigin = action;
      const result = await actionHelpers.playNext({...helpers, observed: currentCompact});
      if (result?.recovery?.outcome === 'not-sent') reservation.outcome = 'not-sent';
      return result;
    }
    if (q.op === 'start-next') {
      requireOwner();
      if (q.confirmed !== true || !COMMAND_ID.test(q.id)) throw new TypeError('start-next requires confirmed:true and an alphanumeric command ID');
      if (searchesAttempted >= maxSearches) throw new Error('Operator search limit exhausted; it cannot extend the authorized allowance');
      context.helper = true; lastOrigin = undefined;
      return actionHelpers.startNext(helpers);
    }
    if (q.op === 'schema') {
      const blocked = await researchGate('schema');
      if (blocked) return blocked;
      if (typeof client.listTools !== 'function') throw new Error('Tool schemas are unavailable');
      const names = q.names ?? (q.name === undefined ? undefined : [q.name]);
      if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !SCHEMA_TOOLS.has(name)))) throw new Error('Schema names must belong to the supported operator tools');
      context.timing.mcpDispatchedAt ??= now();
      try {
        const listed = await withTimingSpan('operator.mcp_call', {tool: 'list_tools', phase: 'schema', timeoutMs: context.researchTimeoutMs ?? readTimeoutMs},
          () => client.listTools(undefined, {timeout: context.researchTimeoutMs ?? readTimeoutMs}));
        return {tools: listed.tools.filter(tool => SCHEMA_TOOLS.has(tool.name) && (!names || names.includes(tool.name)))};
      } finally { context.timing.mcpSettledAt = now(); }
    }
    if (q.op === 'call') {
      if (!READ_TOOLS.has(q.name) && !WRITE_TOOLS.has(q.name)) throw new Error('Tool is not supported for generic calls; use the dedicated operation where available');
      if (READ_TOOLS.has(q.name) && !IMMEDIATE_READ_TOOLS.has(q.name) || BETWEEN_SET_TOOLS.has(q.name) || ['battle_note_decision', 'battle_set_timer'].includes(q.name)) {
        const blocked = await researchGate(q.name);
        if (blocked) return blocked;
      }
      return invoke(q.name, q.args ?? {}, context.researchTimeoutMs ? {timeoutMs: context.researchTimeoutMs} : undefined);
    }
    if (q.op === 'close') { closed = true; return {closed: true, battleClientUnaffected: true}; }
    throw new Error('Unknown operator operation');
  }

  return {
    get closed() { return closed; },
    // Safe in-process metadata only. The receipt remains private and is still
    // injected exclusively into the native review tool by this operator.
    getGuidanceReadProof({commandId}={}){
      if(closed||dispatching||!guidanceReadProof||guidanceReadProof.commandId!==commandId||readReceipt!==guidanceReadReceipt||Date.parse(guidanceReadProof.receiptExpiresAt)<=now())return null;
      return structuredClone(guidanceReadProof);
    },
    async dispatch(q, {inputReceivedAt = now(),signal} = {}) {
      if (!plainObject(q) || !ID.test(q.id ?? '')) throw new TypeError('A fresh short response ID is required');
      if (closed) throw new Error('Operator is closed');
      if (dispatching) throw new Error('Only one operator dispatch may be in flight');
      if (usedIds.has(q.id)) throw new Error('Response ID already used; read its retained response instead of dispatching again');
      if (!epoch(inputReceivedAt)) throw new TypeError('inputReceivedAt must be epoch milliseconds');
      // Snapshot the authored command before any asynchronous call. An API
      // caller cannot change the stored staged pair while its RPC is pending.
      q = structuredClone(q);
      usedIds.add(q.id); dispatching = true;
      const began = now(), context = {op: q.op, commandId:q.id, full: q.full === true, timing: {inputReceivedAt},
        ...(['model-tool','model-tool-catalog','model-play'].includes(q.op)?{signal}:{})};
      activeContext = context;
      const run = async () => withTimingSpan('operator.command', {operation: q.op}, async () => {
        timingEvent('operator.command_started', {operation: q.op});
      try {
        let payload;
        try {
          payload = {result: await withTimingSpan('operator.execute', {operation: q.op}, () => execute(q, context))};
        }
        catch (error) { payload = {error: error?.message ?? 'Operator command failed', retry: false,
          ...(['model-tool','model-tool-catalog','model-play'].includes(q.op)&&typeof error?.code==='string'?{code:error.code}:{}),
          ...error?.[POST_SET_FAILURE],...(q.op==='model-play'?error?.[MODEL_SOURCE_REFUSAL]:{})}; }
        payload.elapsedMs = Math.max(0, now() - began);
        payload.searchesAttempted = searchesAttempted;
        payload.maxSearches = maxSearches;
        const preparation = timingSpan('operator.response_prepare', {phase: 'compact_redact'});
        const clean = preparation.run(() => {
        const value = sanitizeResponse(q.full === true||['model-tool-catalog','model-tool','model-play'].includes(q.op) ? payload : compactView(payload), {redactValues: [...secrets]});
        return value;
        });
        const publication = await withTimingSpan('operator.publish', {phase: 'publication'},
          () => publish(responseFile, q.id, clean, {redactValues: [...secrets], timing: context.timing}));
        // Availability timestamps describe the writer invocation, never model delivery.
        // Retain them only as diagnostics; the immutable receipt remains unchanged.
        if (publication?.timing) timingEvent('operator.publication_observed', {phase: 'publication',
          preparedAt: publication.timing.preparedAt, idAvailableAt: publication.timing.idAvailableAt,
          publicationReturnedAt: publication.timing.publicationReturnedAt,
          source: publication.publication?.latestUpdated === false ? 'retained_id' : 'latest_and_id', outcomeCertainty: 'returned'});
        return clean;
      } finally { activeContext = undefined; dispatching = false; }
      });
      try { return await (timingRecorder ? timingRecorder.run(timingContext(q), run) : run()); }
      finally { flushTiming(); }
    },
  };
}

/** Run JSON-lines commands through SDK -> this checkout's dist/index.js. Closing
 * this helper closes only its MCP connection, never the signed-in battle client.
 * Dependencies are injectable so tests do not authenticate or contact a battle.
 */
export async function runOperator({input, output = process.stdout, responseFile,
  maxSearches = 0, client, transport, now = Date.now, timingRecorder, onTimingFlush, timingTeam, ...options} = {}) {
  const ownsStdin = input === undefined;
  if (ownsStdin) input = process.stdin;
  if (timingTeam !== undefined && !/^[a-f0-9]{64}$/.test(timingTeam)) throw new TypeError('--timing-team requires an exact team fingerprint');
  let timingSink, timingUnavailable = false;
  if (timingTeam && !timingRecorder) {
    try {
      const {createTeamTiming} = await import('../observability/store.mjs');
      timingSink = await createTeamTiming({workspace: PROJECT_ROOT, teamId: timingTeam, component: 'operator'});
      timingRecorder = timingSink.recorder;
      onTimingFlush ??= () => timingSink.flush();
    } catch {
      timingUnavailable = true;
      process.stderr.write('operator-client: TIMING_UNAVAILABLE\n');
    }
  }
  let sdk = client;
  let reader;
  const pendingOutputs = new Set();
  try {
  if (!sdk) {
    const [{Client}, {StdioClientTransport}] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    sdk = new Client({name: 'vgc-maintained-operator', version: '1.0.0'});
    transport = new StdioClientTransport({command: process.execPath, args: [resolve(PROJECT_ROOT, 'dist/index.js')],
      cwd: PROJECT_ROOT, stderr: 'pipe', ...(timingTeam ? {env: {VGC_TIMING_TEAM: timingTeam}} : {})});
    // Child diagnostics may contain source observations. Do not echo raw logs.
    transport.stderr?.resume();
  }
    if (transport) await sdk.connect(transport);
    const operator = createOperator({client: sdk, responseFile, maxSearches, now, timingRecorder, onTimingFlush, ...options});
    output.write('OPERATOR_READY_READ_ONLY\n');
    reader = createInterface({input, terminal: false});
    let pending = Promise.resolve();
    reader.on('line', line => {
      const inputReceivedAt = now();
      if (!line.trim()) return;
      let q;
      try { q = JSON.parse(line); }
      catch { output.write('INPUT_ERROR invalid-json\n'); return; }
      let correlation = {commandId: q?.id, operation: q?.op};
      const beginQueue = () => {
        correlation = {...currentTimingContext(), ...correlation};
        timingEvent('operator.input_received', {...correlation, inputReceivedAt});
        return timingSpan('operator.queue', correlation);
      };
      const queued = timingRecorder ? timingRecorder.run(correlation, beginQueue) : beginQueue();
      pending = pending.then(async () => {
        if (operator.closed) { queued.end('cancelled'); return; }
        queued.end('ok');
        try {
          const dispatch = () => operator.dispatch(q, {inputReceivedAt});
          await (timingRecorder ? timingRecorder.run(correlation, dispatch) : dispatch());
          // Do not hold the next command behind stdout backpressure. Drain these
          // callbacks only at normal operator shutdown, before closing telemetry.
          let outputDone;
          const written = new Promise(done => { outputDone = done; });
          pendingOutputs.add(written);
          output.write(`READY ${q.id}\n`, error => {
            const observed = () => timingEvent('operator.marker_written', {commandId: q.id, operation: q.op, phase: 'output', outcomeCertainty: error ? 'failed' : 'observed'});
            if (timingRecorder) timingRecorder.run(correlation, observed); else observed();
            if (onTimingFlush) { try { Promise.resolve(onTimingFlush()).catch(() => {}); } catch {} }
            pendingOutputs.delete(written); outputDone();
          });
          if (operator.closed) reader.close();
        } catch {
          // Publication may fail AFTER a mutation. Never describe that as bad
          // input or as proof that the command was not sent. Do not echo input.
          output.write(ID.test(q?.id ?? '') ? `DISPATCH_ERROR ${q.id} outcome-unknown inspect-retained-response\n` : 'INPUT_ERROR invalid-command\n');
        }
      });
    });
    await new Promise((done, reject) => { reader.once('close', done); reader.once('error', reject); });
    await pending;
    await Promise.allSettled([...pendingOutputs]);
    return {closed: operator.closed, ...(timingTeam ? {timingStatus: timingUnavailable ? 'unavailable' : 'configured'} : {})};
  } finally {
    reader?.close();
    try { await sdk?.close(); }
    finally {
      if (timingSink) { try { await timingSink.close(); } catch {} }
      // Readline closure does not release every platform's stdin handle. Only
      // release our process input; injected streams remain their caller's own.
      if (ownsStdin) { input.pause(); input.unref?.(); }
    }
  }
}

function cliOptions(args) {
  let responseFile, maxSearches = 0, timingTeam;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--response', '--max-searches', '--timing-team'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new TypeError('Usage: node showdown/operator-client.mjs --response cache/FILE.json [--max-searches 0..100] [--timing-team HASH]');
    seen.add(flag);
    if (flag === '--response') responseFile = resolve(PROJECT_ROOT, value);
    else if (flag === '--timing-team') {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('--timing-team requires an exact team fingerprint');
      timingTeam = value;
    }
    else {
      if (!/^\d+$/.test(value)) throw new TypeError('--max-searches must be an integer from 0 to 100');
      maxSearches = integer(Number(value), 0, 100, '--max-searches');
    }
  }
  if (!responseFile) throw new TypeError('--response is required');
  return {responseFile, maxSearches, ...(timingTeam ? {timingTeam} : {})};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = cliOptions(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`operator-client: ${error.message}\n`); process.exitCode = 1; }
  if (options) runOperator(options).catch(() => {
    process.stderr.write('operator-client: connection or response publication failed; inspect retained responses before any retry\n');
    process.exitCode = 1;
  });
}
