// Reader-only rendering of a retained, sanitized operator response. This module
// never calls MCP, selects actions, changes a deadline, or rewrites the receipt.
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const reserved = value => ['sent', 'uncertain', 'accepted', 'execution-observed'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
    limitation: 'Age is recomputed from this retained observation. Local planning/cutoff budgets are not server deadlines; current live state may have advanced.'}};
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

function stateView(state, checkedAt) {
  const previewRooms = new Set(state.actions.filter(action => action.kind === 'preview').map(action => action.room));
  const boards = state.boards.map(board => {
    const projected = {...board, ...(Object.hasOwn(board, 'recentEvents') ? {recentEvents: eventView(board.recentEvents)} : {})};
    if (!previewRooms.has(board.room) && Object.hasOwn(projected, 'opponentSheets')) {
      delete projected.opponentSheets;
      projected.opponentSheetsOmitted = 'Repeated registered sheet omitted outside preview; preserved in the full retained response.';
    }
    return projected;
  });
  return {...state, boards, ...(object(state.timing) ? {timing: {...state.timing,
    ...(Array.isArray(state.timing.requests) ? {requests: state.timing.requests.map(request => requestView(request, state.actions, checkedAt))} : {})}} : {})};
}

/** Opt-in decision rendering, preserving the response's ID and error/recovery
 * structure. Call only after the reader matched and sanitized the full receipt.
 * `now` is the reader's epoch observation; it is never a model-delivery timestamp.
 */
export function projectDecisionView(envelope, {now = Date.now()} = {}) {
  if (!timestamp(now)) throw new TypeError('Decision-view time must be epoch milliseconds');
  let states = 0;
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!object(value)) return value;
    if (typeof value.sessionId === 'string' && Array.isArray(value.actions) && Array.isArray(value.boards)) {
      states++;
      return stateView(value, now);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  }
  const projected = visit(envelope);
  return states && object(projected) ? {...projected, decisionView: {kind: 'retained-response-decision-view', readerCheckedAt: now,
    fullResponseRetained: true, compactStates: states,
    limitation: 'Rendering only. Legal actions, safety/clock fields and uncertainty are preserved; no action is selected or sent.'}} : projected;
}
