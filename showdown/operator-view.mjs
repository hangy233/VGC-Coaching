// Reader-only rendering of a retained, sanitized operator response. This module
// never calls MCP, selects actions, changes a deadline, or rewrites the receipt.
import {isDeepStrictEqual} from 'node:util';
import {isNativeSimulation, isNativeSimulationBatch, isSimulationDecisionView, projectSimulationDecisionView,
  projectSimulationBatchDecisionView} from './simulation-decision-view.mjs';

const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const reserved = value => ['sent', 'uncertain', 'accepted', 'execution-observed'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
// Property ordering is a presentation aid only. Keep every other source field,
// including unknown future fields, and never mutate the retained observation.
const first = (value, keys) => ({...pick(value, keys), ...Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))});

function requestView(request, actions, checkedAt) {
  const action = actions.find(value => value.token === request.token && value.room === request.room && value.rqid === request.rqid);
  const actionableAtObservation = Boolean(action && action.actionable !== false && !reserved(action.submissionStatus));
  const protectedAtObservation = request.hasFallback === true || reserved(request.submissionStatus) ||
    action?.actionable === false || reserved(action?.submissionStatus);
  const age = timestamp(request.receivedAt) && checkedAt >= request.receivedAt ? checkedAt - request.receivedAt : null;
  const remaining = field => timestamp(request[field]) ? Math.max(0, request[field] - checkedAt) : null;
  const cutoff = remaining('cutoffAt');
  const commitNow = actionableAtObservation && !protectedAtObservation &&
    (age !== null && age >= 10000 || cutoff !== null && cutoff <= 5000 || request.urgency === 'plan-overdue');
  return {...request, reader: {checkedAt, requestAgeMs: age,
    planningRemainingMs: remaining('planningDeadlineAt'), cutoffRemainingMs: cutoff,
    hardRemainingMs: remaining('hardDeadlineAt'), actionableAtObservation, protectedAtObservation,
    commitNow, attention: commitNow ? 'stage-or-submit-current-choice-now' : actionableAtObservation && !protectedAtObservation ? 'plan-current-choice' : 'preserve-existing-reservation',
    limitation: 'Retained-observation age; local budgets are not server deadlines. Live state may have advanced.'}};
}

function eventView(events) {
  if (!events || !Array.isArray(events.lines) || events.lines.length <= 5) return events;
  const earlier = events.lines.slice(0, -5);
  // Current HP is already explicit on the board. Keep all earlier move-order,
  // denial, switch, status, field, item/ability and variance observations, rather
  // than hiding them behind a last-five-lines limit. Residual/source-labelled HP
  // changes remain too because their cause can change the next decision.
  const decisionEvents = earlier.filter(line => {
    if (typeof line !== 'string') return true;
    const kind = line.split('|', 3)[1];
    return !['-damage', '-heal'].includes(kind) || /\[from\]|\[of\]/.test(line);
  });
  const omitted = earlier.length - decisionEvents.length;
  return {...events, earlierDecisionEvents: decisionEvents, lines: events.lines.slice(-5),
    decisionViewOmittedHpLines: omitted,
    ...(omitted ? {decisionViewNote: 'Earlier plain HP updates omitted from this rendering only; current HP, consequential events and the full retained response remain available.'} : {})};
}

function roomHistoryView(state) {
  if (!Array.isArray(state.rooms)) return {};
  // Only trim known, completed summaries from *other* sets. Establish the exact
  // current parent from matching action/board request identities, never from an
  // alias guess, array order or the last historical room. Ambiguous/terminal
  // observations and unknown room fields stay complete.
  const parents = new Set(), currentRooms = new Set();
  for (const action of state.actions) {
    if (typeof action.room !== 'string' || action.actionable === false || reserved(action.submissionStatus)) continue;
    const board = state.boards.find(value => value.room === action.room && value.request?.rqid === action.rqid);
    if (!board || typeof board.parentId !== 'string' || action.parentId !== board.parentId) return {};
    parents.add(board.parentId); currentRooms.add(action.room);
  }
  if (parents.size !== 1) return {};
  const parent = [...parents][0];
  const rooms = state.rooms.filter(room => !object(room) || room.ended !== true ||
    typeof room.id !== 'string' || typeof room.parentId !== 'string' ||
    room.parentId === parent || room.id === parent || currentRooms.has(room.id) ||
    Object.keys(room).some(key => !['id', 'parentId', 'ended', 'result'].includes(key)));
  const omitted = state.rooms.length - rooms.length;
  return omitted ? {rooms, decisionViewHistoricalRooms: {omitted, currentParentId: parent,
    retained: 'Complete prior-set room summaries remain in the immutable matching response; all current-set, live and unknown-schema rooms remain here.'}} : {};
}

function stateView(state, checkedAt, {preserveSheets = false} = {}) {
  const previewRooms = new Set(state.actions.filter(action => action.kind === 'preview').map(action => action.room));
  const boards = state.boards.map(board => {
    const projected = {...board, ...(Object.hasOwn(board, 'recentEvents') ? {recentEvents: eventView(board.recentEvents)} : {})};
    if (!preserveSheets && !previewRooms.has(board.room) && Object.hasOwn(projected, 'opponentSheets')) {
      delete projected.opponentSheets;
      projected.opponentSheetsOmitted = 'Repeated registered sheet omitted outside preview; preserved in the full retained response.';
    }
    return projected;
  });
  return first({...state, ...roomHistoryView(state), boards, ...(object(state.timing) ? {timing: {...state.timing,
    ...(Array.isArray(state.timing.requests) ? {requests: state.timing.requests.map(request => requestView(request, state.actions, checkedAt))} : {})}} : {})},
  ['actions', 'timing', 'boards', 'controlPolicy', 'choices', 'controller']);
}

/** Small source-bound index before transport/history metadata. The complete
 * legality, board and safety objects stay at their exact paths below. An index
 * lists every distinct observation; it never chooses one as the live state.
 */
function readyIndex({value: state, path}, checkedAt) {
  const timings = Array.isArray(state.timing?.requests) ? state.timing.requests : [];
  const entries = state.actions.map((action, index) => ({action, actionPath: `${path}.actions[${index}]`}));
  // Native compact actions omits sent requests. Keep their explicit timing
  // reservations visible without turning them back into actionable requests.
  timings.forEach((timing, index) => {
    if (reserved(timing.submissionStatus) && !state.actions.some(action => action.token === timing.token &&
        action.room === timing.room && action.rqid === timing.rqid)) {
      entries.push({action: {...pick(timing, ['room', 'token', 'rqid', 'submissionStatus']), actionable: false},
        timing, timingPath: `${path}.timing.requests[${index}]`});
    }
  });
  const requests = entries.map(({action, actionPath, timing: reservationTiming, timingPath}) => {
    const matches = item => item.token === action.token && item.room === action.room && item.rqid === action.rqid;
    const timing = reservationTiming ?? timings.find(matches);
    const pendingIndex = Array.isArray(state.controlPolicy?.pending) ? state.controlPolicy.pending.findIndex(matches) : -1;
    const pending = pendingIndex < 0 ? undefined : state.controlPolicy.pending[pendingIndex];
    const submissionReserved = reserved(action.submissionStatus) || reserved(timing?.submissionStatus) || pending?.attempted === true;
    const fallbackObserved = timing?.hasFallback === true || pending?.hasFallback === true;
    const authoredFallbackObserved = pending?.hasFallback === true && pending.fallbackSource === 'fallback' && pending.attempted === false;
    const attention = submissionReserved ? 'preserve-existing-reservation' : action.actionable === false ? 'preserve-existing-status' :
      fallbackObserved ? 'existing-fallback-observed' : 'unprotected-request-observed';
    const nextActionFocus = submissionReserved ? 'Preserve the send reservation and observe; missing acknowledgment does not authorize a resend.' :
      action.actionable === false ? 'Observe the existing status; do not invent an actionable request.' :
      action.kind === 'ready' ? 'Handle this current readiness before extended ranking, reports or handoff.' :
      authoredFallbackObserved ? 'Commit or revise the stored authored choice within the original deadline. Staging is not a send or acceptance.' :
      fallbackObserved ? 'Inspect the existing fallback provenance; an agent-authored stored pair is not established by this observation alone.' :
      action.kind === 'preview' ? 'Author the complete legal preview order with stage-next or play-next as the next tool, before extended ranking, reports or handoff.' :
      'Author the first useful complete legal pair with stage-next or play-next as the next tool, before extended ranking, reports or handoff.';
    return {...pick(action, ['kind', 'room', 'token', 'rqid', 'actionable', 'submissionStatus']),
      attention, nextActionFocus,
      ...(timingPath ? {reservationPath: timingPath, requestSource: 'timing-reservation-only'} : {}),
      reader: timing ? pick(requestView(timing, state.actions, checkedAt).reader,
        ['checkedAt', 'requestAgeMs', 'planningRemainingMs', 'cutoffRemainingMs', 'hardRemainingMs']) : null,
      ...(Object.hasOwn(action, 'clock') ? {clockPath: `${actionPath}.clock`} : {}),
      ...(Object.hasOwn(action, 'legalActions') ? {legalActionsPath: `${actionPath}.legalActions`} : {}),
      boardPaths: state.boards.flatMap((board, boardIndex) => board.room === action.room ? [`${path}.boards[${boardIndex}]`] : []),
      ...(pending ? {pendingSafety: pick(pending, ['state', 'hasFallback', 'fallbackSource', 'attempted', 'submissionStatus']),
        pendingSafetyPath: `${path}.controlPolicy.pending[${pendingIndex}]`} : {}),
    };
  });
  return {statePath: path, ...pick(state, ['sessionId', 'revision', 'observedAt', 'connected', 'authenticated', 'stopped', 'autoReady']),
    ...(object(state.controller) ? {controllerPath: `${path}.controller`} : {}),
    ...(object(state.controlPolicy) ? {policy: pick(state.controlPolicy, ['enabled', 'halted', 'haltReason', 'observationFault', 'disposed']),
      safetyPath: `${path}.controlPolicy`,
      ...(state.controlPolicy.halted === true ? {haltScope: 'Observed halt blocks future search; continue only already user-authorized CURRENT SET recovery. It grants no new permission, policy reset or search.'} : {})} : {}),
    requests,
    ...(requests.length ? {} : {attention: 'no-action-in-this-observation'}),
  };
}

/** Opt-in decision rendering, preserving the response's ID and error/recovery
 * structure. Call only after the reader matched and sanitized the full receipt.
 * `now` is the reader's epoch observation; it is never a model-delivery timestamp.
 */
export function projectDecisionView(envelope, {now = Date.now()} = {}) {
  if (!timestamp(now)) throw new TypeError('Decision-view time must be epoch milliseconds');
  let states = 0;
  const observations = [], statePaths = new Map();
  const childPath = (path, key) => /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  function collect(value, path = '$') {
    if (Array.isArray(value)) { value.forEach((child, index) => collect(child, `${path}[${index}]`)); return; }
    if (!object(value)) return;
    if (typeof value.sessionId === 'string' && Array.isArray(value.actions) && Array.isArray(value.boards)) {
      states++;
      // Compare complete raw observations before any presentation omissions.
      // Matching revision/request IDs alone cannot establish identical clocks,
      // safety, reveals or uncertainty. Keep every genuinely different state.
      const duplicate = observations.find(observation => isDeepStrictEqual(observation.value, value));
      statePaths.set(path, duplicate?.path ?? path);
      if (!duplicate) observations.push({value, path});
      return;
    }
    for (const [key, child] of Object.entries(value)) collect(child, childPath(path, key));
  }
  collect(envelope);
  function visit(value, path = '$') {
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}[${index}]`));
    if (!object(value)) return value;
    if (isSimulationDecisionView(value)) return value;
    if (isNativeSimulationBatch(value)) return projectSimulationBatchDecisionView(value);
    if (isNativeSimulation(value)) return projectSimulationDecisionView(value);
    if (statePaths.has(path)) {
      const originalPath = statePaths.get(path);
      if (originalPath !== path) return {decisionViewStateRef: originalPath, exactObservationDuplicate: true};
      // Different observations can contain a changed sheet. Keep their sheets
      // visible instead of assuming they repeat a single registered sheet.
      return stateView(value, now, {preserveSheets: observations.length > 1});
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      visit(child, childPath(path, key))]));
  }
  const projected = visit(envelope);
  return states && object(projected) ? {decisionReady: {kind: 'retained-observation-index', readerCheckedAt: now,
    focusContract: 'Use each exact observed request below. This is presentation guidance, not a new choice gate, action selection or proof of acceptance.',
    distinctObservations: observations.length,
    observations: observations.map(observation => readyIndex(observation, now)),
    limitation: 'Lists every distinct observation without selecting a current variant or actions. Inspect exact paths and errors below; freshness/model delivery unknown.'},
  ...projected, decisionView: {kind: 'retained-response-decision-view', readerCheckedAt: now,
    fullResponseRetained: true, compactStates: states, uniqueCompactStates: observations.length,
    compactStateReferences: states - observations.length,
    limitation: 'Rendering only; duplicate states reference their complete first rendering. Legality, safety, clocks and uncertainty preserved; no action selected/sent.'}} : projected;
}
