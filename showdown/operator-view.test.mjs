import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDecisionView} from './operator-view.mjs';

const ROOM = 'battle-gen9championsvgc2026regmcbo3-123';
const TOKEN = 'a'.repeat(64);
const action = overrides => ({kind: 'turn', room: ROOM, rqid: 3, token: TOKEN, receivedAt: 1000,
  clock: {source: 'unavailable', remainingMs: null, deadlineAt: null},
  legalActions: {forceSwitch: null, active: [{moves: [{slot: 1, disabled: false, targets: [1, 2]}]}],
    replacements: [{pokemonId: 'p1-4', slot: 4, species: 'Farigiraf'}],
    replacementPairs: [[{type: 'pass'}, {type: 'switch', pokemonId: 'p1-4'}]]}, ...overrides});
const state = overrides => ({sessionId: 'fixture', revision: 8, observedAt: 2000,
  actions: [action()],
  controller: {owner: 'fixture-controller', generation: 2},
  controlPolicy: {enabled: true, halted: false, unknownClockMs: 20000, pending: [{token: TOKEN, cutoffAt: 21000}]},
  timing: {requests: [{token: TOKEN, room: ROOM, rqid: 3, receivedAt: 1000, requestAgeMs: 1000,
    firstChoiceMissing: true, hasFallback: false, hardDeadlineAt: null, cutoffAt: 21000,
    planningDeadlineAt: 31000, urgency: 'planning'}]},
  boards: [{room: ROOM, ownSide: 'p2', clock: {source: 'unavailable', remainingMs: null},
    timer: {request: null, serverObservation: null}, field: {weather: 'RainDance'},
    sides: [{id: 'p2', unrevealedSelected: 0, reserves: ['p2-4'], active: [{slot: 'a', pokemon: 'p2-1'}],
      pokemon: [{id: 'p2-1', species: 'Golisopod-Mega', requestIndex: 1,
        hp: {current: 89, max: 182, precision: 'server-own-exact'}, ability: 'Tough Claws',
        abilitySuppressed: false, item: null, itemHistory: [{item: 'Golisopite', reason: 'mega'}],
        moves: ['leechlife'], boosts: {atk: -1}, volatiles: {healblock: {turns: 1}}}]}],
    recentEvents: {lines: [], omitted: 0, truncated: false}}],
  choices: [{room: ROOM, rqid: 1, status: 'sent'}], ...overrides});
const envelope = value => ({format: 'vgc-operator-response-v1', id: 'fixture-id', payload: {result: {ok: true, result: value}}});

test('simulation decision rendering keeps gates/order/risk/final state beside next request without repeated full snapshots',()=>{
  const simulation={engine:{gen:0,format:'gen9championsvgc2026regmc'},source:{room:ROOM,token:TOKEN},hypotheses:['Unknown foe spread candidate'],calculationRef:{id:'receipt'},summary:{allGatesPassed:false},limitations:['Samples only'],samples:[{branchId:'pair',seed:[1,2,3,4],start:{sides:[]},openingEvents:[],events:[{index:1,type:'move',actorId:'a',targetId:'b',raw:'|move|a|Example|b'},{index:2,type:'-damage',actorId:'b',raw:'|-damage|b|1/200'},{index:3,type:'cant',actorId:'b',raw:'|cant|b|par'},{index:4,type:'faint',actorId:'b',raw:'|faint|b'}],actionOutcomes:[],accepted:{p1:{accepted:true}},gate:{passed:false,cleanSample:false},boundary:'forced-replacement',pendingActions:[{kind:'move'}],pendingPhases:['move','residual'],noPendingContinuation:false,stochastic:{sampleOnly:true,actionDenialEvents:['par']},final:{turn:1,field:{terrain:'grassyterrain'},sides:[{id:'p1',active:['a'],pokemon:[{id:'a',hp:1,maxhp:200,status:'',pp:[1,2,3,4],lifecycle:{activeMoveActions:1}}]}]}}]};
  const original=envelope({conditional:{calculations:[{name:'simulate_turn',result:simulation}]},next:{state:state()}}),before=structuredClone(original),projected=projectDecisionView(original,{now:5000}),result=projected.payload.result.result.conditional.calculations[0].result;
  assert.deepEqual(original,before);assert.equal(result.samples[0].start,undefined);assert.equal(result.samples[0].openingEvents,undefined);assert.deepEqual(result.samples[0].orderedEvents.map(event=>event.native.split('|')[1]),['move','-damage','cant','faint']);assert.deepEqual(result.samples[0].gate,simulation.samples[0].gate);assert.deepEqual(result.samples[0].pendingPhases,['move','residual']);assert.equal(result.samples[0].final.sides[0].pokemon[0].hp,1);assert.equal(result.samples[0].final.sides[0].pokemon[0].pp,undefined);assert.equal(result.decisionViewSimulation.fullResponseRetained,true);assert.deepEqual(projected.payload.result.result.next.state.actions,before.payload.result.result.next.state.actions);assert.equal(projected.decisionReady.distinctObservations,1);
});

test('preview preserves the complete registered opposing six and own legal request without editing the receipt', () => {
  const original = envelope(state({actions: [action({kind: 'preview'})]}));
  original.payload.result.result.boards[0].opponentSheets = {p1: Array.from({length: 6}, (_, index) => ({species: `fixture-${index}`, moves: ['Protect', 'Psychic Noise'], item: 'Sitrus Berry'}))};
  const copy = structuredClone(original), projected = projectDecisionView(original, {now: 5000});
  assert.deepEqual(original, copy);
  assert.deepEqual(projected.payload.result.result.boards[0].opponentSheets, copy.payload.result.result.boards[0].opponentSheets);
  assert.deepEqual(projected.payload.result.result.actions, copy.payload.result.result.actions);
  assert.equal(projected.id, 'fixture-id');
  assert.equal(projected.decisionView.fullResponseRetained, true);
});

test('turn rendering preserves exact named replacements, legality, side identity, denial and move order', () => {
  const s = state({actions: [action({kind: 'switch', legalActions: {forceSwitch: [false, true],
    replacements: [{pokemonId: 'p2-4', slot: 4, species: 'Farigiraf'}],
    replacementPairs: [[{type: 'pass'}, {type: 'switch', pokemonId: 'p2-4'}]]}})]});
  const lines = ['|move|p1a: Enemy|Throat Chop|p2a: Ally', '|cant|p2a: Ally|Throat Chop|Leech Life',
    '|-damage|p2a: Ally|89/182', '|-ability|p1b: Enemy|Armor Tail',
    '|move|p1b: Enemy|Parting Shot|p2b: Ally', '|switch|p1b: Recipient|Incineroar|100/100',
    '|-heal|p1b: Recipient|100/100|[from] Grassy Terrain', '|-boost|p1b: Recipient|atk|2',
    '|-fieldend|move: Trick Room', '|turn|8'];
  s.boards[0].recentEvents = {lines, available: lines.length, omitted: 0, truncated: false};
  s.boards[0].opponentSheets = {p1: ['repeated registered sheet']};
  const original = structuredClone(s), view = projectDecisionView(envelope(s), {now: 18000}).payload.result.result;
  assert.deepEqual(view.actions, original.actions);
  assert.deepEqual(view.boards[0].sides, original.boards[0].sides);
  assert.deepEqual(view.boards[0].field, original.boards[0].field);
  assert.deepEqual(view.boards[0].timer, original.boards[0].timer);
  assert.deepEqual(view.controller, original.controller);
  assert.deepEqual(view.controlPolicy, original.controlPolicy);
  assert.deepEqual(view.choices, original.choices);
  const events = view.boards[0].recentEvents;
  assert.equal(events.lines.length, 5);
  assert.deepEqual(events.earlierDecisionEvents, lines.slice(0, 5).filter(line => !line.startsWith('|-damage|')));
  assert.equal(events.decisionViewOmittedHpLines, 1);
  assert.equal(view.boards[0].opponentSheets, undefined);
  assert.match(view.boards[0].opponentSheetsOmitted, /preserved/);
  assert.deepEqual(s, original);
});

test('reader attention recomputes stale age and local budgets without inventing a server deadline', () => {
  const view = projectDecisionView(envelope(state()), {now: 17000}).payload.result.result;
  const request = view.timing.requests[0];
  assert.equal(request.requestAgeMs, 1000);
  assert.equal(request.reader.requestAgeMs, 16000);
  assert.equal(request.reader.cutoffRemainingMs, 4000);
  assert.equal(request.reader.planningRemainingMs, 14000);
  assert.equal(request.reader.hardRemainingMs, null);
  assert.equal(request.reader.commitNow, true);
  assert.equal(request.reader.protectedAtObservation, false);
  assert.equal(view.actions[0].clock.deadlineAt, null);
  assert.equal(view.boards[0].clock.remainingMs, null);
  assert.match(request.reader.limitation, /not server deadlines/);
  const future = state(); future.timing.requests[0].receivedAt = 30000;
  assert.equal(projectDecisionView(envelope(future), {now: 2000}).payload.result.result.timing.requests[0].reader.requestAgeMs, null);
});

test('a sent, uncertain or staged observation never becomes a fresh retry merely because the file is old', () => {
  for (const protection of ['sent', 'uncertain', 'staged']) {
    const s = state();
    if (protection === 'staged') s.timing.requests[0].hasFallback = true;
    else { s.actions[0].actionable = false; s.actions[0].submissionStatus = protection; }
    const read = projectDecisionView(envelope(s), {now: 60000}).payload.result.result.timing.requests[0].reader;
    assert.equal(read.protectedAtObservation, true);
    assert.equal(read.commitNow, false);
  }
  const mismatch = state(); mismatch.actions[0].token = 'b'.repeat(64);
  assert.equal(projectDecisionView(envelope(mismatch), {now: 60000}).payload.result.result.timing.requests[0].reader.commitNow, false);
});

test('nested first-turn and rejected-action recovery states stay visible with error and no-resend metadata intact', () => {
  const s = state(), recovery = {outcome: 'submission-reserved', retry: false, rebind: false, requiresNewDecision: true, state: s};
  const source = {format: 'vgc-operator-response-v1', id: 'rejected', payload: {result: {ok: false,
    error: 'Action token changed', recovery, next: {reason: 'action-rejected', state: {ok: true, result: s}}}}};
  const view = projectDecisionView(source, {now: 17000});
  assert.equal(view.payload.result.ok, false);
  assert.equal(view.payload.result.error, 'Action token changed');
  assert.equal(view.payload.result.recovery.retry, false);
  assert.equal(view.payload.result.recovery.rebind, false);
  assert.equal(view.payload.result.recovery.state.timing.requests[0].reader.commitNow, true);
  assert.deepEqual(view.payload.result.recovery.state.actions[0].legalActions, s.actions[0].legalActions);
  assert.deepEqual(view.payload.result.next.state.result, {
    decisionViewStateRef: '$.payload.result.recovery.state', exactObservationDuplicate: true});
  assert.equal(view.decisionView.compactStates, 2);
  assert.equal(view.decisionView.uniqueCompactStates, 1);
  assert.equal(view.decisionView.compactStateReferences, 1);
});

const rejectedReceipt = (first, next = structuredClone(first)) => ({
  format: 'vgc-operator-response-v1', id: 'recovery-fixture',
  payload: {result: {error: 'Authored request no longer matches the delivered request',
    recovery: {outcome: 'not-sent', retry: false, rebind: false, requiresNewDecision: true, state: first},
    next: {reason: 'action-rejected', state: next, observedAt: 2200},
    timing: {inputReceivedAt: 2000, modelDeliveredAt: null, stageDispatchedAt: 2000, stageSettledAt: 2200}},
  elapsedMs: 200, searchesAttempted: 1, maxSearches: 6},
  timing: {inputReceivedAt: 1990, mcpDispatchedAt: 2000, mcpSettledAt: 2200, boardCapturedAt: 2100, preparedAt: 2201},
});

test('actual rejected-response shape renders a complete observation once and retains every receipt and recovery field', () => {
  const s = state({connected: true, authenticated: true, stopped: false,
    timerPolicy: {unknownClockMs: 20000}, autoReady: true, savingReplays: false,
    awaitingSet: false, searchPending: false, switchingTeam: false});
  s.boards[0].uncertainty = ['Opponent investments unknown'];
  s.boards[0].warnings = ['Current request may have advanced'];
  s.boards[0].recentEvents.lines = ['|move|p1a: Foe|Psychic Noise|p2a: Ally', '|-start|p2a: Ally|move: Heal Block'];
  const source = rejectedReceipt(s), original = structuredClone(source);
  const view = projectDecisionView(source, {now: 17000});
  assert.deepEqual(source, original);
  assert.deepEqual(view.payload.result.next, {reason: 'action-rejected',
    state: {decisionViewStateRef: '$.payload.result.recovery.state', exactObservationDuplicate: true}, observedAt: 2200});
  const first = view.payload.result.recovery.state;
  for (const field of ['actions', 'controller', 'controlPolicy', 'timerPolicy', 'choices']) assert.deepEqual(first[field], s[field]);
  for (const field of ['sides', 'timer', 'clock', 'uncertainty', 'warnings', 'recentEvents']) assert.deepEqual(first.boards[0][field], s.boards[0][field]);
  assert.deepEqual(view.payload.result.timing, source.payload.result.timing);
  assert.deepEqual(view.timing, source.timing);
  assert.deepEqual({...view.payload.result.recovery, state: null}, {...source.payload.result.recovery, state: null});
  assert.equal(view.payload.result.error, source.payload.result.error);
  assert.equal(view.payload.searchesAttempted, 1);
  assert.equal(view.payload.maxSearches, 6);
  assert.equal(JSON.stringify(view).split(TOKEN).length < JSON.stringify(source).split(TOKEN).length, true);
});

test('same request or revision never collapses differing clocks, safety, uncertainty, sheets or revealed boards', () => {
  const changes = {
    revision: s => s.revision++,
    observation: s => s.observedAt++,
    token: s => { s.actions[0].token = 'b'.repeat(64); },
    request: s => s.actions[0].rqid++,
    legal: s => { s.actions[0].legalActions.active[0].moves[0].disabled = true; },
    hp: s => s.boards[0].sides[0].pokemon[0].hp.current--,
    reveal: s => { s.boards[0].sides[0].pokemon[0].moves.push('wideguard'); },
    clock: s => { s.actions[0].clock = {source: 'server', remainingMs: 7000, deadlineAt: 24000}; },
    safety: s => { s.controlPolicy.halted = true; },
    reservation: s => { s.actions[0].submissionStatus = 'uncertain'; s.actions[0].actionable = false; },
    cutoff: s => s.timing.requests[0].cutoffAt++,
    uncertainty: s => { s.boards[0].uncertainty = ['Ability unconfirmed']; },
    sheet: s => { s.boards[0].opponentSheets.p1[0].moves.push('Throat Chop'); },
  };
  for (const [label, change] of Object.entries(changes)) {
    const first = state(); first.boards[0].opponentSheets = {p1: [{species: 'Fixture', moves: ['Protect']}]};
    const next = structuredClone(first); change(next);
    const source = rejectedReceipt(first, next), original = structuredClone(source);
    const view = projectDecisionView(source, {now: 17000});
    assert.deepEqual(source, original, label);
    assert.equal(view.decisionView.uniqueCompactStates, 2, label);
    assert.equal(view.decisionView.compactStateReferences, 0, label);
    for (const [rendered, raw] of [[view.payload.result.recovery.state, first], [view.payload.result.next.state, next]]) {
      for (const field of ['sessionId', 'revision', 'observedAt', 'actions', 'controller', 'controlPolicy', 'boards', 'choices']) {
        assert.deepEqual(rendered[field], raw[field], `${label}: ${field}`);
      }
      assert.equal(rendered.decisionViewStateRef, undefined, label);
    }
  }
});

test('duplicate references use unambiguous array and quoted-key JSON paths and point to the first complete rendering', () => {
  const source = {'nested.key': [state(), {later: state()}]};
  const view = projectDecisionView(source, {now: 17000});
  assert.equal(view['nested.key'][0].actions[0].token, TOKEN);
  assert.deepEqual(view['nested.key'][1].later, {
    decisionViewStateRef: '$["nested.key"][0]', exactObservationDuplicate: true});
});

test('pending and unrelated outputs retain their existing shape', () => {
  const pending = {id: 'still-pending', pending: true, reason: 'response-file-timeout', resend: false};
  assert.deepEqual(projectDecisionView(pending, {now: 10}), pending);
  const unrelated = {format: 'vgc-operator-response-v1', id: 'done', payload: {complete: true}};
  assert.deepEqual(projectDecisionView(unrelated, {now: 10}), unrelated);
  assert.throws(() => projectDecisionView(pending, {now: NaN}), /epoch/);
});

test('action-ready index precedes metadata and points to exact first-pair legality and board without selecting actions', () => {
  // Anonymized equivalent of the missed first pair: one fresh observation,
  // no optional tools or duplicate states, two active slots and one reserve.
  const s = state({connected: true, authenticated: true, stopped: false,
    transport: {incomingFrames: 900}, futureField: {keep: 'exact'}});
  s.actions[0].legalActions = {teamPreview: false, forceSwitch: null,
    active: [{moves: [{move: 'Protect', disabled: false, target: 'self'}]},
      {moves: [{move: 'Protect', disabled: false, target: 'self'}]}],
    pokemon: [{ident: 'p2: Active A', active: true}, {ident: 'p2: Active B', active: true},
      {ident: 'p2: Reserve', condition: '200/200', active: false}]};
  s.controlPolicy.pending = [{token: TOKEN, room: ROOM, rqid: 3, hasFallback: false,
    attempted: false, receivedAt: 1000, cutoffAt: 31000, hardDeadlineAt: 56000}];
  s.timing.requests[0].cutoffAt = 31000;
  s.timing.requests[0].hardDeadlineAt = 56000;
  const source = envelope(s), original = structuredClone(source);
  const view = projectDecisionView(source, {now: 1066});
  assert.equal(Object.keys(view)[0], 'decisionReady');
  assert.equal(view.decisionReady.distinctObservations, 1);
  const index = view.decisionReady.observations[0], request = index.requests[0];
  assert.equal(index.statePath, '$.payload.result.result');
  assert.equal(request.attention, 'unprotected-request-observed');
  assert.match(request.nextActionFocus, /first useful complete legal pair.*next tool.*before extended ranking, reports or handoff/);
  assert.equal(request.token, TOKEN);
  assert.equal(request.rqid, 3);
  assert.equal(request.reader.requestAgeMs, 66);
  assert.equal(request.reader.cutoffRemainingMs, 29934);
  assert.equal(request.reader.hardRemainingMs, 54934);
  assert.equal(request.legalActionsPath, '$.payload.result.result.actions[0].legalActions');
  assert.deepEqual(request.boardPaths, ['$.payload.result.result.boards[0]']);
  assert.deepEqual(request.pendingSafety, {hasFallback: false, attempted: false});
  assert.equal(request.pendingSafetyPath, '$.payload.result.result.controlPolicy.pending[0]');
  assert.equal(request.clockPath, '$.payload.result.result.actions[0].clock');
  assert.equal(index.safetyPath, '$.payload.result.result.controlPolicy');
  assert.equal(Object.hasOwn(request, 'actions'), false);
  assert.equal(Object.hasOwn(request, 'recommendedActions'), false);
  assert.deepEqual(Object.keys(view.payload.result.result).slice(0, 6),
    ['actions', 'timing', 'boards', 'controlPolicy', 'choices', 'controller']);
  assert.deepEqual(view.payload.result.result.actions[0].legalActions, s.actions[0].legalActions);
  assert.deepEqual(view.payload.result.result.futureField, s.futureField);
  assert.deepEqual(source, original);
});

test('normal post-send index presents the fresh request while preserving the previous send receipt', () => {
  const s = state(), sent = {ok: true, result: {rqid: 2, status: 'sent-not-acknowledged'}};
  const source = {format: 'vgc-operator-response-v1', id: 'normal',
    payload: {result: {sent, next: {reason: 'fresh-action', state: {ok: true, result: s}}}}};
  const view = projectDecisionView(source, {now: 2500});
  assert.equal(view.decisionReady.observations[0].statePath, '$.payload.result.next.state.result');
  assert.equal(view.decisionReady.observations[0].requests[0].rqid, 3);
  assert.deepEqual(view.payload.result.sent, sent);
  assert.equal(view.payload.result.next.reason, 'fresh-action');
});

test('action-ready index preserves reserved, uncertain, staged and nonactionable observations even when old', () => {
  for (const status of ['sent', 'uncertain', 'accepted', 'execution-observed']) {
    const s = state(); s.actions[0].submissionStatus = status;
    const request = projectDecisionView(envelope(s), {now: 90000}).decisionReady.observations[0].requests[0];
    assert.equal(request.attention, 'preserve-existing-reservation', status);
    assert.equal(request.submissionStatus, status);
    assert.match(request.nextActionFocus, /Preserve the send reservation and observe/);
    assert.doesNotMatch(request.nextActionFocus, /Author the first/);
  }
  const staged = state();
  staged.controlPolicy.pending = [{token: TOKEN, room: ROOM, rqid: 3, hasFallback: true, fallbackSource: 'fallback', attempted: false}];
  assert.equal(projectDecisionView(envelope(staged), {now: 90000}).decisionReady.observations[0].requests[0].attention,
    'existing-fallback-observed');
  assert.match(projectDecisionView(envelope(staged), {now: 90000}).decisionReady.observations[0].requests[0].nextActionFocus,
    /Commit or revise the stored authored choice.*original deadline.*not a send or acceptance/);
  staged.controlPolicy.pending[0].attempted = true;
  assert.equal(projectDecisionView(envelope(staged), {now: 90000}).decisionReady.observations[0].requests[0].attention,
    'preserve-existing-reservation');
  const inactive = state(); inactive.actions[0].actionable = false;
  assert.equal(projectDecisionView(envelope(inactive), {now: 90000}).decisionReady.observations[0].requests[0].attention,
    'preserve-existing-status');
});

test('a fallback with unknown or emergency provenance is never presented as a confirmed agent-staged pair', () => {
  for (const fallbackSource of [undefined, 'emergency-default']) {
    const s = state();
    s.controlPolicy.pending = [{token: TOKEN, room: ROOM, rqid: 3, hasFallback: true, fallbackSource, attempted: false}];
    const request = projectDecisionView(envelope(s), {now: 1066}).decisionReady.observations[0].requests[0];
    assert.equal(request.attention, 'existing-fallback-observed');
    assert.match(request.nextActionFocus, /Inspect the existing fallback provenance/);
    assert.doesNotMatch(request.nextActionFocus, /Commit the stored/);
    assert.equal(request.pendingSafety.fallbackSource, fallbackSource);
  }
});

test('native timing-only send reservations remain visible without inventing an action or acceptance', () => {
  for (const submissionStatus of ['sent', 'uncertain']) {
    const s = state({actions: []});
    s.timing.requests[0].submissionStatus = submissionStatus;
    const source = envelope(s), before = structuredClone(source);
    const view = projectDecisionView(source, {now: 90000});
    const request = view.decisionReady.observations[0].requests[0];
    assert.equal(request.attention, 'preserve-existing-reservation');
    assert.equal(request.submissionStatus, submissionStatus);
    assert.equal(request.actionable, false);
    assert.equal(request.reservationPath, '$.payload.result.result.timing.requests[0]');
    assert.match(request.nextActionFocus, /missing acknowledgment does not authorize a resend/);
    assert.equal(request.legalActionsPath, undefined);
    assert.deepEqual(view.payload.result.result.actions, []);
    assert.deepEqual(source, before);
  }
});

test('halt preserves current-set recovery scope without interpreting retired exposure metadata', () => {
  const s = state(); s.controlPolicy.halted = true; s.controlPolicy.haltReason = 'prior-control-failure';
  const source = envelope(s);
  source.payload.operatorExposure = {transferDue: true, successorId: 'prepared-successor', publishedCharacters: 7000};
  const before = structuredClone(source), view = projectDecisionView(source, {now: 1066});
  const index = view.decisionReady.observations[0];
  assert.equal(index.policy.halted, true);
  assert.match(index.haltScope, /blocks future search.*already user-authorized CURRENT SET recovery.*no new permission, policy reset or search/);
  assert.equal(view.decisionReady.exposureAttention, undefined);
  assert.match(index.requests[0].nextActionFocus, /first useful complete legal pair.*next tool/);
  assert.equal(index.requests[0].attention, 'unprotected-request-observed');
  assert.deepEqual(view.payload.operatorExposure, source.payload.operatorExposure);
  assert.deepEqual(source, before);
});

test('every distinct observation has its own index; none is selected across changed recovery variants', () => {
  const first = state(), next = structuredClone(first);
  next.actions[0].token = 'b'.repeat(64);
  next.actions[0].rqid = 4;
  next.actions[0].submissionStatus = 'uncertain';
  next.timing.requests[0].token = next.actions[0].token;
  next.timing.requests[0].rqid = 4;
  const source = rejectedReceipt(first, next), view = projectDecisionView(source, {now: 17000});
  assert.equal(view.decisionReady.distinctObservations, 2);
  const entries = view.decisionReady.observations;
  assert.deepEqual(entries.map(entry => entry.statePath), ['$.payload.result.recovery.state', '$.payload.result.next.state']);
  assert.deepEqual(entries.map(entry => entry.requests[0].token), [TOKEN, 'b'.repeat(64)]);
  assert.deepEqual(entries.map(entry => entry.requests[0].attention),
    ['unprotected-request-observed', 'preserve-existing-reservation']);
  assert.equal(Object.hasOwn(view.decisionReady, 'currentObservation'), false);
  assert.match(view.decisionReady.limitation, /without selecting a current variant/);
  assert.equal(view.payload.result.recovery.retry, false);
  assert.equal(view.payload.result.recovery.rebind, false);
  assert.equal(view.payload.result.error, source.payload.result.error);
});

test('no-action and mismatched timing indices invent neither a request nor a countdown', () => {
  const empty = state({actions: []}), view = projectDecisionView(envelope(empty), {now: 17000});
  assert.deepEqual(view.decisionReady.observations[0].requests, []);
  assert.equal(view.decisionReady.observations[0].attention, 'no-action-in-this-observation');
  const mismatch = state(); mismatch.timing.requests[0].token = 'b'.repeat(64);
  mismatch.controlPolicy.pending = [{token: 'b'.repeat(64), room: ROOM, rqid: 3, hasFallback: true, attempted: true}];
  const request = projectDecisionView(envelope(mismatch), {now: 17000}).decisionReady.observations[0].requests[0];
  assert.equal(request.reader, null);
  assert.equal(request.pendingSafety, undefined);
  assert.equal(request.attention, 'unprotected-request-observed');
});

function withRoomHistory(s = state()) {
  const parent = 'game-bestof3-fixture-current';
  s.actions[0].parentId = parent;
  s.boards[0].parentId = parent;
  s.boards[0].request = {rqid: s.actions[0].rqid};
  s.rooms = [
    {id: 'game-bestof3-fixture-old', parentId: 'game-bestof3-fixture-old', ended: true, result: {type: 'win', winner: 'prior'}},
    {id: 'battle-fixture-old', parentId: 'game-bestof3-fixture-old', ended: true, result: {type: 'win', winner: 'prior'}},
    {id: parent, parentId: parent, ended: false, result: null},
    {id: 'battle-fixture-current-ended', parentId: parent, ended: true, result: {type: 'win', winner: 'current'}},
    {id: ROOM, parentId: parent, ended: false, result: null},
    {id: 'battle-other-live', parentId: 'game-bestof3-other-live', ended: false, result: null},
    {id: 'battle-old-unknown-schema', parentId: 'game-bestof3-fixture-old', ended: true, result: null, warning: 'keep exact'},
  ];
  return s;
}

test('decision rendering omits only completed prior-set summaries after exact action and board parent binding', () => {
  const s = withRoomHistory(), original = structuredClone(s);
  const view = projectDecisionView(envelope(s), {now: 17000}).payload.result.result;
  assert.deepEqual(view.rooms, original.rooms.slice(2));
  assert.equal(view.decisionViewHistoricalRooms.omitted, 2);
  assert.equal(view.decisionViewHistoricalRooms.currentParentId, s.actions[0].parentId);
  assert.match(view.decisionViewHistoricalRooms.retained, /immutable matching response/);
  for (const field of ['actions', 'controller', 'controlPolicy', 'choices', 'timerPolicy', 'boards']) {
    assert.deepEqual(view[field], original[field], field);
  }
  assert.deepEqual(s, original);
});

test('full preview sheets and all six own legal options survive unrelated completed-room omission', () => {
  const s = withRoomHistory(); s.actions[0].kind = 'preview';
  s.actions[0].legalActions.pokemon = Array.from({length: 6}, (_, index) => ({ident: `p2: Own ${index}`, slot: index + 1}));
  s.boards[0].opponentSheets = {p1: Array.from({length: 6}, (_, index) => ({species: `Opponent ${index}`, moves: ['Protect', 'Psychic Noise'], item: 'Sitrus Berry'}))};
  const view = projectDecisionView(envelope(s), {now: 17000}).payload.result.result;
  assert.equal(view.decisionViewHistoricalRooms.omitted, 2);
  assert.deepEqual(view.actions, s.actions);
  assert.deepEqual(view.boards[0].opponentSheets, s.boards[0].opponentSheets);
  assert.deepEqual(view.boards[0].sides, s.boards[0].sides);
});

test('terminal, reserved, mismatched, missing and multiple-parent observations keep complete room history', () => {
  const cases = {
    terminal: s => {s.actions = [];},
    reserved: s => {s.actions[0].submissionStatus = 'uncertain';},
    nonactionable: s => {s.actions[0].actionable = false;},
    request: s => {s.boards[0].request.rqid++;},
    room: s => {s.boards[0].room += '-alias';},
    parent: s => {s.actions[0].parentId += '-different';},
    missingParent: s => {delete s.actions[0].parentId;},
    missingBoardRequest: s => {delete s.boards[0].request;},
    multipleParents: s => {
      const a = structuredClone(s.actions[0]), b = structuredClone(s.boards[0]);
      a.room += '-other'; b.room = a.room; a.parentId += '-other'; b.parentId = a.parentId;
      s.actions.push(a); s.boards.push(b);
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const s = withRoomHistory(); change(s);
    const view = projectDecisionView(envelope(s), {now: 17000}).payload.result.result;
    assert.deepEqual(view.rooms, s.rooms, name);
    assert.equal(view.decisionViewHistoricalRooms, undefined, name);
  }
});
