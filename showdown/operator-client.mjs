import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishResponse, sanitizeResponse} from './operator-response.mjs';
import * as defaultActions from './action-next.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_.:-]{1,60}$/;
const COMMAND_ID = /^[A-Za-z0-9_-]{1,70}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// This is an explicit transport surface, not an arbitrary MCP proxy. In
// particular, login, allowance extension, roster changes and deletion are absent.
const READ_TOOLS = new Set([
  'battle_status', 'battle_turn_status', 'battle_wait', 'battle_capabilities',
  'battle_control_trace', 'battle_decision_notes', 'battle_skill_status',
  'battle_skill_read', 'battle_review_get', 'battle_review_status',
  'battle_preflight', 'battle_calculation_evidence',
  'team_metrics_health', 'team_metrics_game_annotations', 'team_metrics_compare',
  'team_metrics_viewer_status', 'team_metrics_list', 'team_metrics_report',
  'team_metrics_agent_report', 'team_metrics_game_evidence',
  'calculate_damage', 'calculate_speed', 'get_type_effectiveness',
  'get_pokemon', 'get_movepool', 'get_move', 'search_pokemon', 'search_move',
  'search_item', 'search_ability', 'search_nature', 'validate_pokemon',
  'validate_team', 'classify_team', 'get_usage_stats', 'get_pokemon_usage',
  'get_champions_usage_stats', 'get_champions_pokemon_usage',
]);
const WRITE_TOOLS = new Set([
  'battle_control_claim', 'battle_control_release', 'battle_set_control_policy',
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
const LEASED_TOOLS = new Set([
  'battle_control_release', 'battle_set_control_policy', 'battle_ready',
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
  'battle_review_get', 'battle_review_status', 'battle_preflight']);

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
  mutationTimeoutMs = 5000, postSetTimeoutMs = 30000} = {}) {
  if (!client || typeof client.callTool !== 'function') throw new TypeError('An MCP SDK client is required');
  if (typeof responseFile !== 'string' || !responseFile) throw new TypeError('A response file is required');
  if (typeof publish !== 'function' || typeof now !== 'function') throw new TypeError('Publisher and clock functions are required');
  integer(maxSearches, 0, 100, 'maxSearches');
  integer(budgetMs, 1, 20000, 'budgetMs');
  integer(readTimeoutMs, 1, 30000, 'readTimeoutMs');
  integer(mutationTimeoutMs, 1, 30000, 'mutationTimeoutMs');
  integer(postSetTimeoutMs, 1, 30000, 'postSetTimeoutMs');
  for (const name of ['playNext', 'startNext', 'waitForNext']) {
    if (typeof actionHelpers[name] !== 'function') throw new TypeError(`actionHelpers.${name} is required`);
  }
  let armedIdentity, controllerLease, readReceipt, currentCompact, currentStatus, lastOrigin;
  let activeContext, dispatching = false, closed = false, searchesAttempted = 0;
  const usedIds = new Set(), searchReservations = new Set(), choiceReservations = new Map(), stagedPlans = new Map(), secrets = new Set();
  const requireArmed = () => { if (!armedIdentity) throw new Error('Read-only mode: explicitly arm the expected existing session and team first'); };
  const requireOwner = () => { requireArmed(); if (!controllerLease) throw new Error('Explicit battle_control_claim is required before a leased operation'); };
  const rememberSecret = value => { if (typeof value === 'string' && value) secrets.add(value); };

  function observe(value, context) {
    if (context && activeContext !== context) return;
    const data = body(value);
    if (typeof data?.readReceipt === 'string' && succeeded(value)) {
      readReceipt = data.readReceipt; rememberSecret(readReceipt);
    }
    const state = value?.recovery?.state ?? data;
    if (!plainObject(state)) return;
    if (state.sessionId && state.teamSha256 && Array.isArray(state.rooms) && !failed(value)) currentStatus = state;
    if (state.sessionId && Array.isArray(state.boards)) {
      currentCompact = state;
      if (context) context.timing.boardCapturedAt = epoch(state.observedAt) ? state.observedAt : now();
    }
  }

  async function call(context, name, supplied = {}, options = {}) {
    if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name) && !HELPER_TOOLS.has(name)) throw new Error('Tool is not supported by this operator');
    if (!plainObject(supplied)) throw new TypeError('Tool arguments must be a JSON object');
    if (!READ_TOOLS.has(name)) requireArmed();
    const args = {...supplied};
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
    const defaultTimeoutMs = READ_TOOLS.has(name) ? readTimeoutMs :
      POST_SET_WRITE_TOOLS.has(name) ? postSetTimeoutMs : mutationTimeoutMs;
    const timeoutMs = integer(options.timeoutMs ?? defaultTimeoutMs, 1, 30000, 'SDK timeoutMs');
    const dispatchedAt = now();
    context.timing.mcpDispatchedAt ??= dispatchedAt;
    // A broken transport can ignore the SDK timeout/AbortSignal and settle
    // after the helper has moved on to recovery. Its reply is no longer an
    // observation, even while this same dispatch is publishing a newer board.
    const ownsObservation = () => activeContext === context && options.signal?.aborted !== true;
    try {
      // SDK RequestOptions is the THIRD argument, not a tool argument or result
      // schema. Aborting a wait does not establish a cancelled mutation.
      const value = unpackToolResult(await client.callTool({name, arguments: args}, undefined,
        {timeout: timeoutMs, ...(options.signal ? {signal: options.signal} : {})}));
      if (ownsObservation()) observe(value, context);
      if (ownsObservation() && name === 'battle_control_claim' && succeeded(value)) {
        const lease = body(value)?.controllerLease;
        if (typeof lease === 'string' && lease) { controllerLease = lease; rememberSecret(lease); }
      }
      if (ownsObservation() && ['battle_control_release', 'battle_stop'].includes(name) && succeeded(value)) controllerLease = undefined;
      return value;
    } catch (error) {
      if (!POST_SET_WRITE_TOOLS.has(name)) throw error;
      // A transport timeout cannot prove that remote recording or cleanup did
      // not finish. Keep the uncertainty explicit; never resend automatically.
      const failure = new Error(error?.message ?? 'Post-set MCP response unavailable');
      failure[POST_SET_FAILURE] = {outcome: 'mutation-uncertain', requiresReconciliation: true,
        tool: name, timeoutMs};
      throw failure;
    } finally { if (ownsObservation()) context.timing.mcpSettledAt = now(); }
  }

  async function execute(q, context) {
    const invoke = (name, args, options) => call(context, name, args, options);
    const helpers = {q, call: invoke, observe: value => observe(value, context), now, budgetMs,
      mutationTimeoutMs, autoReady: currentCompact?.autoReady ?? currentStatus?.autoReady};
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
        if (remaining <= 5000) return {blocked: true, reason: 'commit-staged-plan-first', requires: 'commit-next or play-next before optional work', state: fresh, retry: false};
        context.researchTimeoutMs = Math.max(1, Math.min(readTimeoutMs, 5000, Math.floor(remaining - 5000)));
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
      if (q.op === 'commit-next') {
        const plan = stagedPlans.get(q.token);
        if (!plan || plan.room !== q.room || plan.rqid !== q.rqid) throw new Error('No confirmed agent-staged pair for this exact request; inspect current state');
        if (q.actions !== undefined) throw new TypeError('commit-next submits the stored staged actions; use play-next to author a changed pair');
        helpers.q = {...q, actions: structuredClone(plan.actions)};
      }
      const authored = helpers.q;
      if (!Array.isArray(authored.actions) || !authored.actions.length || authored.actions.length > 2) throw new TypeError('Explicit complete actions are required');
      const previous = choiceReservations.get(q.token);
      if (previous && previous.outcome !== 'not-sent') throw new Error('This request already has a submission reservation; no automatic resend is allowed');
      context.helper = true;
      if (q.op === 'stage-next') {
        stagedPlans.delete(q.token);
        const result = await (actionHelpers.stageNext ?? defaultActions.stageNext)({...helpers, observed: currentCompact});
        if (result.protection?.staged === true) stagedPlans.set(q.token, {room: q.room, rqid: q.rqid, actions: structuredClone(q.actions)});
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
        const listed = await client.listTools(undefined, {timeout: context.researchTimeoutMs ?? readTimeoutMs});
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
    async dispatch(q, {inputReceivedAt = now()} = {}) {
      if (!plainObject(q) || !ID.test(q.id ?? '')) throw new TypeError('A fresh short response ID is required');
      if (closed) throw new Error('Operator is closed');
      if (dispatching) throw new Error('Only one operator dispatch may be in flight');
      if (usedIds.has(q.id)) throw new Error('Response ID already used; read its retained response instead of dispatching again');
      if (!epoch(inputReceivedAt)) throw new TypeError('inputReceivedAt must be epoch milliseconds');
      // Snapshot the authored command before any asynchronous call. An API
      // caller cannot change the stored staged pair while its RPC is pending.
      q = structuredClone(q);
      usedIds.add(q.id); dispatching = true;
      const began = now(), context = {op: q.op, full: q.full === true, timing: {inputReceivedAt}};
      activeContext = context;
      try {
        let payload;
        try { payload = {result: await execute(q, context)}; }
        catch (error) { payload = {error: error?.message ?? 'Operator command failed', retry: false,
          ...error?.[POST_SET_FAILURE]}; }
        payload.elapsedMs = Math.max(0, now() - began);
        payload.searchesAttempted = searchesAttempted;
        payload.maxSearches = maxSearches;
        const clean = sanitizeResponse(q.full === true ? payload : compactView(payload), {redactValues: [...secrets]});
        await publish(responseFile, q.id, clean, {redactValues: [...secrets], timing: context.timing});
        return clean;
      } finally { activeContext = undefined; dispatching = false; }
    },
  };
}

/** Run JSON-lines commands through SDK -> this checkout's dist/index.js. Closing
 * this helper closes only its MCP connection, never the signed-in battle client.
 * Dependencies are injectable so tests do not authenticate or contact a battle.
 */
export async function runOperator({input = process.stdin, output = process.stdout, responseFile,
  maxSearches = 0, client, transport, now = Date.now, ...options} = {}) {
  let sdk = client;
  if (!sdk) {
    const [{Client}, {StdioClientTransport}] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    sdk = new Client({name: 'vgc-maintained-operator', version: '1.0.0'});
    transport = new StdioClientTransport({command: process.execPath, args: [resolve(PROJECT_ROOT, 'dist/index.js')],
      cwd: PROJECT_ROOT, stderr: 'pipe'});
    // Child diagnostics may contain source observations. Do not echo raw logs.
    transport.stderr?.resume();
  }
  let reader;
  try {
    if (transport) await sdk.connect(transport);
    const operator = createOperator({client: sdk, responseFile, maxSearches, now, ...options});
    output.write('OPERATOR_READY_READ_ONLY\n');
    reader = createInterface({input, terminal: false});
    let pending = Promise.resolve();
    reader.on('line', line => {
      const inputReceivedAt = now();
      if (!line.trim()) return;
      let q;
      try { q = JSON.parse(line); }
      catch { output.write('INPUT_ERROR invalid-json\n'); return; }
      pending = pending.then(async () => {
        if (operator.closed) return;
        try {
          await operator.dispatch(q, {inputReceivedAt});
          output.write(`READY ${q.id}\n`);
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
    return {closed: operator.closed};
  } finally { reader?.close(); await sdk.close(); }
}

function cliOptions(args) {
  let responseFile, maxSearches = 0;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--response', '--max-searches'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new TypeError('Usage: node showdown/operator-client.mjs --response cache/FILE.json [--max-searches 0..100]');
    seen.add(flag);
    if (flag === '--response') responseFile = resolve(PROJECT_ROOT, value);
    else {
      if (!/^\d+$/.test(value)) throw new TypeError('--max-searches must be an integer from 0 to 100');
      maxSearches = integer(Number(value), 0, 100, '--max-searches');
    }
  }
  if (!responseFile) throw new TypeError('--response is required');
  return {responseFile, maxSearches};
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
