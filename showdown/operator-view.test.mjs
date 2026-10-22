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
