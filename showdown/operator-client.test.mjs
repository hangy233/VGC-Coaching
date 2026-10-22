import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {createOperator, runOperator, unpackToolResult} from './operator-client.mjs';

const TEAM = 'a'.repeat(64), LEASE = 'b'.repeat(64), TOKEN = 'c'.repeat(64), NEXT_TOKEN = 'd'.repeat(64);
const RECEIPT = '51d70d21-3a42-4b6d-82f4-110a7e8fdd43';
const SESSION = 'fixture-session', ROOM = 'battle-gen9championsvgc2026regmcbo3-123';
const pair = [{type: 'move', slot: 1, target: 1}, {type: 'move', slot: 2, target: 2}];
const raw = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const reply = result => raw({ok: true, result});
const idle = overrides => ({sessionId: SESSION, teamSha256: TEAM, username: 'fixture-owner',
  connected: true, authenticated: true, stopped: false, revision: 1, searchesSent: 0, authorizedSets: 4,
  controller: {generation: 0}, actions: [], rooms: [], search: {searching: [], games: null}, ...overrides});
const action = (token = TOKEN, rqid = 9) => ({room: ROOM, parentId: 'game-bestof3-gen9championsvgc2026regmcbo3-123',
  rqid, revision: rqid, token, kind: 'turn', actionable: true,
  legalActions: {active: [{moves: [{slot: 1, targets: [1, 2]}]}, {moves: [{slot: 2, targets: [1, 2]}]}]}});
const compact = (token = TOKEN, rqid = 9) => ({sessionId: SESSION, connected: true, authenticated: true,
  stopped: false, revision: rqid, observedAt: 1000 + rqid, actions: [action(token, rqid)],
  rooms: [{id: ROOM, ended: false}], search: {searching: [], games: {[ROOM]: true}},
  timing: {requests: [{token, room: ROOM, rqid, receivedAt: 900, requestAgeMs: 109,
    planningRemainingMs: 800, hardRemainingMs: 28000, urgency: 'planning'}]},
  boards: [{room: ROOM, requestAgeMs: 109, clock: {turnSeconds: 28, bankSeconds: 72},
    sides: [{id: 'p1', pokemon: [{id: 'fixture-mon', hp: '80/100', status: '', boosts: {atk: 1}, volatiles: []}]}]}]});

function fixture(handler = () => reply(idle()), options = {}) {
  const calls = [], publications = [];
  const client = {
    async callTool(request, schema, requestOptions) {
      calls.push({request, schema, options: requestOptions});
      return handler(request.name, request.arguments, requestOptions, calls.length);
    },
    async listTools(params, requestOptions) {
      calls.push({listTools: true, params, options: requestOptions});
      return {tools: [{name: 'battle_status', inputSchema: {}}, {name: 'battle_start', inputSchema: {}},
        {name: 'battle_authorize_sets', inputSchema: {}}, {name: 'arbitrary_shell', inputSchema: {}}]};
    },
  };
  const operator = createOperator({client, responseFile: 'cache/fixture-operator.json',
    publish: async (file, id, payload, publishOptions) => publications.push({file, id, payload, options: structuredClone(publishOptions)}),
    ...options});
  return {operator, client, calls, publications};
}

async function arm(operator, id = 'arm') {
  return operator.dispatch({id, op: 'arm', confirmed: true, expectedSessionId: SESSION,
    expectedTeamId: TEAM, expectedAccount: 'fixture-owner'});
}
async function claim(operator, id = 'claim') {
  return operator.dispatch({id, op: 'call', name: 'battle_control_claim', args: {confirmed: true,
    commandId: 'fixture-claim', controllerId: 'fixture-controller'}});
}
function standardHandler(name) {
  if (name === 'battle_status') return reply(idle());
  if (name === 'battle_control_claim') return reply({controllerLease: LEASE, controller: {generation: 1}});
  if (name === 'battle_turn_status') return reply(compact());
  return reply({done: true});
}

test('creation and unarmed commands remain read-only without a startup claim or search', async () => {
  const {operator, calls} = fixture(standardHandler, {maxSearches: 4});
  assert.equal(calls.length, 0);
  for (const [id, command] of [
    ['claim', {op: 'call', name: 'battle_control_claim', args: {confirmed: true}}],
    ['ready', {op: 'call', name: 'battle_ready', args: {confirmed: true}}],
    ['review', {op: 'call', name: 'battle_review_save'}],
    ['start', {op: 'start-next', confirmed: true}],
  ]) assert.match((await operator.dispatch({id, ...command})).error, /Read-only/);
  assert.equal(calls.length, 0);
  const view = await operator.dispatch({id: 'turn', op: 'turn'});
  assert.deepEqual(view.result.result, compact());
  assert.deepEqual(calls.map(value => value.request.name), ['battle_turn_status']);
});

test('arm checks its own fresh status and exact session, team and optional account', async () => {
  let actual = idle({username: 'different-owner'});
  const {operator, calls} = fixture(() => reply(actual));
  const missing = await operator.dispatch({id: 'missing', op: 'arm', expectedSessionId: SESSION, expectedTeamId: TEAM});
  assert.match(missing.error, /confirmed:true/);
  assert.equal(calls.length, 0);
  assert.match((await arm(operator, 'wrong-account')).error, /not available/);
  actual = idle({sessionId: 'wrong-session'});
  assert.match((await arm(operator, 'wrong-session')).error, /not available/);
  actual = idle({teamSha256: 'e'.repeat(64)});
  assert.match((await arm(operator, 'wrong-team')).error, /not available/);
  actual = idle();
  assert.equal((await arm(operator, 'correct')).result.armed, true);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.request.name === 'battle_status'));
  const before = calls.length;
  assert.match((await operator.dispatch({id: 'new-identity', op: 'arm', confirmed: true,
    expectedSessionId: 'other-session', expectedTeamId: TEAM})).error, /cannot change/);
  assert.equal(calls.length, before);
});

test('lease and complete guidance receipt stay in memory and are injected into the right tools', async () => {
  const {operator, calls, publications} = fixture(name => {
    if (name === 'battle_turn_status') return reply({...idle(), boards: []});
    if (name === 'battle_skill_read') return raw({readReceipt: RECEIPT, filesRead: [{path: 'SKILL.md', content: 'Complete current guidance'}], text: `receipt ${RECEIPT}`});
    if (name === 'battle_review_save') return raw({complete: true, echoedReceipt: RECEIPT});
    if (name === 'battle_ready') return reply({done: true, leaseEcho: `private ${LEASE}`});
    return standardHandler(name);
  });
  await arm(operator);
  const claimed = await claim(operator);
  assert.equal(claimed.result.result.controllerLease, undefined);
  const guidance = await operator.dispatch({id: 'guidance', op: 'call', name: 'battle_skill_read'});
  assert.equal(guidance.result.filesRead[0].content, 'Complete current guidance');
  assert.equal(guidance.result.readReceipt, undefined);
  await operator.dispatch({id: 'review', op: 'call', name: 'battle_review_save', args: {readReceipt: 'untrusted-receipt'}});
  await operator.dispatch({id: 'ready', op: 'call', name: 'battle_ready', args: {confirmed: true, token: TOKEN,
    controllerLease: 'untrusted-lease'}});
  assert.equal(calls.find(call => call.request.name === 'battle_review_save').request.arguments.readReceipt, RECEIPT);
  assert.equal(calls.find(call => call.request.name === 'battle_ready').request.arguments.controllerLease, LEASE);
  assert.equal(calls.find(call => call.request.name === 'battle_skill_read').request.arguments.controllerLease, undefined);
  const rendered = JSON.stringify(publications.map(item => item.payload));
  assert.equal(rendered.includes(LEASE), false);
  assert.equal(rendered.includes(RECEIPT), false);
  assert.equal(JSON.stringify(claimed).includes(LEASE), false);
  assert.equal(JSON.stringify(guidance).includes(RECEIPT), false);
});

test('generic calls cannot bypass dedicated search, exact action checks or excluded scope', async () => {
  const {operator, calls} = fixture(name => name === 'battle_turn_status' ? reply({...idle(), boards: []}) : standardHandler(name), {maxSearches: 1});
  await arm(operator); await claim(operator);
  const before = calls.length;
  for (const [index, name] of ['battle_start', 'battle_choose', 'battle_stage_fallback', 'battle_authorize_sets',
    'battle_switch_team', 'team_metrics_delete_team', 'arbitrary_shell'].entries()) {
    assert.match((await operator.dispatch({id: `blocked${index}`, op: 'call', name, args: {confirmed: true}})).error, /not supported/);
  }
  assert.equal(calls.length, before);
  const schema = await operator.dispatch({id: 'schema', op: 'schema'});
  assert.deepEqual(schema.result.tools.map(tool => tool.name), ['battle_status', 'battle_start']);
});

test('a structured stale rejection delivers its fresh compact recovery board without another read or a resend', async () => {
  const newer = compact(NEXT_TOKEN, 11);
  const negative = {id: 'play-stage', ok: false, error: 'Action token changed',
    recovery: {outcome: 'not-sent', retry: false, rebind: false, requiresNewDecision: true, state: newer}};
  const {operator, calls, publications} = fixture(name => {
    if (name === 'battle_stage_fallback') return {...raw(negative), isError: true};
    return standardHandler(name);
  });
  await arm(operator); await claim(operator); await operator.dispatch({id: 'turn', op: 'turn'});
  const before = calls.length;
  const result = await operator.dispatch({id: 'play', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.deepEqual(calls.slice(before).map(call => call.request.name), ['battle_stage_fallback']);
  assert.equal(result.result.error, 'Action token changed');
  assert.equal(result.result.recovery.retry, false);
  assert.equal(result.result.recovery.rebind, false);
  assert.deepEqual(result.result.recovery.state, newer);
  assert.deepEqual(result.result.next.state, newer);
  assert.equal(publications.at(-1).options.timing.boardCapturedAt, newer.observedAt);
  const mismatch = await operator.dispatch({id: 'old-decision', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.match(mismatch.error, /do not match/);
  assert.equal(calls.length, before + 1);
});

test('ordinary action uses the exact cached request and forwards SDK timeout and abort signal', async () => {
  const {operator, calls} = fixture(name => {
    if (name === 'battle_stage_fallback') return reply({pending: [{token: TOKEN, attempted: false}]});
    if (name === 'battle_choose') return reply({status: 'sent'});
    if (name === 'battle_turn_status') return reply(calls.filter(call => call.request.name === name).length === 1 ? compact() : compact(NEXT_TOKEN, 11));
    return standardHandler(name);
  });
  await arm(operator); await claim(operator); await operator.dispatch({id: 'turn', op: 'turn'});
  const before = calls.length;
  const result = await operator.dispatch({id: 'pair', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.equal(result.result.next.reason, 'fresh-action');
  assert.deepEqual(calls.slice(before).map(call => call.request.name), ['battle_stage_fallback', 'battle_choose', 'battle_turn_status']);
  for (const call of calls.slice(before)) {
    assert.equal(call.schema, undefined);
    assert.ok(Number.isInteger(call.options.timeout));
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.request.arguments.timeout, undefined);
  }
  const chosen = calls.find(call => call.request.name === 'battle_choose');
  assert.deepEqual(chosen.request.arguments.actions, pair);
  assert.equal(chosen.request.arguments.token, TOKEN);
  assert.equal(chosen.request.arguments.controllerLease, LEASE);
  assert.equal(chosen.options.timeout <= 5000, true);
});

test('uncertain action reserves the original token and does not permit another command to resend it', async () => {
  const {operator, calls} = fixture(name => {
    if (name === 'battle_stage_fallback') throw new Error('fixture transport disconnected');
    return standardHandler(name);
  });
  await arm(operator); await claim(operator); await operator.dispatch({id: 'turn', op: 'turn'});
  const result = await operator.dispatch({id: 'uncertain', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.equal(result.result.recovery.outcome, 'mutation-uncertain');
  const before = calls.length;
  assert.match((await operator.dispatch({id: 'no-resend', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair})).error, /reservation/);
  assert.equal(calls.length, before);
  assert.equal(calls.filter(call => call.request.name === 'battle_stage_fallback').length, 1);
  assert.equal(calls.some(call => call.request.name === 'battle_choose'), false);
});

test('bare legacy choose rejection plus unavailable recovery never establishes not-sent or permits same-token redispatch', async () => {
  let turnReads = 0;
  const {operator, calls} = fixture(name => {
    if (name === 'battle_turn_status') {
      if (turnReads++ === 0) return reply(compact());
      throw new Error('fixture recovery read unavailable');
    }
    if (name === 'battle_stage_fallback') return reply({pending: [{token: TOKEN, attempted: false}]});
    if (name === 'battle_choose') return {...raw({id: 'legacy', ok: false, error: 'legacy unclassified rejection'}), isError: true};
    return standardHandler(name);
  });
  await arm(operator); await claim(operator); await operator.dispatch({id: 'turn', op: 'turn'});
  const result = await operator.dispatch({id: 'legacy', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.equal(result.result.recovery.outcome, 'rejection-unclassified');
  assert.equal(result.result.recovery.state, null);
  assert.equal(result.result.recovery.retry, false);
  const before = calls.length;
  const blocked = await operator.dispatch({id: 'legacy-second', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.match(blocked.error, /reservation/);
  assert.equal(calls.length, before);
  assert.equal(calls.filter(call => call.request.name === 'battle_choose').length, 1);
});

test('an aborted SDK call settling during publication cannot replace the recovered board or mutate its timing', async () => {
  let finishLateStage, turnReads = 0, stageCalls = 0, tick = 2000;
  const recovered = compact(NEXT_TOKEN, 11), after = compact('e'.repeat(64), 13);
  const {operator, calls} = fixture(name => {
    if (name === 'battle_turn_status') return reply(++turnReads === 2 ? recovered : compact());
    if (name === 'battle_stage_fallback') {
      if (++stageCalls === 1) return new Promise(done => {finishLateStage = () => done({...raw({ok: false,
        error: 'late original reply', recovery: {outcome: 'not-sent', state: compact()}}), isError: true});});
      return {...raw({ok: false, error: 'fixture fresh request rejected',
        recovery: {outcome: 'not-sent', retry: false, rebind: false, state: after}}), isError: true};
    }
    return standardHandler(name);
  }, {now: () => tick++, mutationTimeoutMs: 5, budgetMs: 1000,
    publish: async (_file, id, _payload, options) => {
      if (id !== 'timeout') return;
      const before = structuredClone(options.timing);
      finishLateStage();
      // Let the noncompliant SDK's ignored promise settle while the original
      // dispatch remains active inside publication of the NEW recovery board.
      await new Promise(done => setImmediate(done));
      assert.deepEqual(options.timing, before);
    }});
  await arm(operator); await claim(operator); await operator.dispatch({id: 'turn', op: 'turn'});
  const timedOut = await operator.dispatch({id: 'timeout', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.equal(timedOut.result.recovery.outcome, 'mutation-uncertain');
  assert.deepEqual(timedOut.result.recovery.state, recovered);
  const before = calls.length;
  const fresh = await operator.dispatch({id: 'fresh11', op: 'play-next', room: ROOM, rqid: 11, token: NEXT_TOKEN, actions: pair});
  assert.equal(fresh.result.error, 'fixture fresh request rejected');
  assert.deepEqual(calls.slice(before).map(call => call.request.name), ['battle_stage_fallback']);
  // Even an explicit later observation of the original token cannot convert
  // the timed-out mutation into a confirmed not-sent reservation.
  await operator.dispatch({id: 'old-observation', op: 'turn'});
  const beforeRetry = calls.length;
  const retry = await operator.dispatch({id: 'old-token-retry', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  assert.match(retry.error, /reservation/);
  assert.equal(calls.length, beforeRetry);
});

test('search cap is consumed before uncertain SDK I/O and cannot be reset by arming again', async () => {
  const {operator, calls} = fixture(name => {
    if (name === 'battle_start') throw new Error('fixture search outcome uncertain');
    return standardHandler(name);
  }, {maxSearches: 1});
  await arm(operator); await claim(operator);
  const result = await operator.dispatch({id: 'one-search', op: 'start-next', confirmed: true});
  assert.equal(result.searchesAttempted, 1);
  assert.equal(result.result.recovery.outcome, 'mutation-uncertain');
  assert.equal((await arm(operator, 'rearm')).result.searchesAttempted, 1);
  const before = calls.length;
  const blocked = await operator.dispatch({id: 'second-search', op: 'start-next', confirmed: true});
  assert.match(blocked.error, /limit exhausted/);
  assert.equal(calls.length, before);
  assert.equal(calls.filter(call => call.request.name === 'battle_start').length, 1);
});

test('zero searches is the default even after an explicit control claim', async () => {
  const {operator, calls} = fixture(standardHandler);
  await arm(operator); await claim(operator);
  const before = calls.length;
  assert.match((await operator.dispatch({id: 'search', op: 'start-next', confirmed: true})).error, /limit exhausted/);
  assert.equal(calls.length, before);
  assert.throws(() => fixture(standardHandler, {maxSearches: 101}), /0 to 100/);
});

test('SDK isError metadata is retained alongside structured recovery, and ordinary query errors remain visible', async () => {
  const value = {ok: false, error: 'fixture rejected', recovery: {state: compact(), retry: false}};
  assert.deepEqual(unpackToolResult({...raw(value), isError: true}), {...value, isError: true});
  const {operator} = fixture(() => ({isError: true, content: [{type: 'text', text: 'fixture unavailable'}]}));
  const result = await operator.dispatch({id: 'status', op: 'status'});
  assert.deepEqual(result.result, {text: 'fixture unavailable', isError: true});
});

test('response timing records input, first dispatch, last settlement and actual compact observation', async () => {
  let tick = 2000;
  const {operator, calls, publications} = fixture(standardHandler, {now: () => tick++});
  await operator.dispatch({id: 'timed', op: 'turn'}, {inputReceivedAt: 1900});
  const timing = publications[0].options.timing;
  assert.equal(timing.inputReceivedAt, 1900);
  assert.equal(timing.boardCapturedAt, compact().observedAt);
  assert.ok(timing.mcpDispatchedAt < timing.mcpSettledAt);
  assert.equal(calls[0].options.timeout, 20000);
  assert.deepEqual(Object.keys(timing).sort(), ['inputReceivedAt', 'mcpDispatchedAt', 'mcpSettledAt', 'boardCapturedAt'].sort());
});

test('default status presentation omits full room state, while explicit full retains it', async () => {
  const state = idle({rooms: [{id: ROOM, ended: false, state: {largePrivateHistory: ['event']},
    sheets: {p2: 'registered six'}, clock: {turnSeconds: 28}}]});
  const {operator} = fixture(() => reply(state));
  const bounded = await operator.dispatch({id: 'bounded', op: 'status'});
  assert.equal(bounded.result.result.rooms[0].state, undefined);
  assert.equal(bounded.result.result.rooms[0].sheets, undefined);
  assert.deepEqual(bounded.result.result.rooms[0].clock, {turnSeconds: 28});
  const full = await operator.dispatch({id: 'full', op: 'status', full: true});
  assert.deepEqual(full.result.result.rooms[0].state, state.rooms[0].state);
});

test('JSON-lines runner prints only markers, captures per-line timing and closes only MCP', async () => {
  const lines = [{id: 'turn', op: 'turn'}, {id: 'close', op: 'close'}];
  let stdout = '', closed = 0;
  const published = [], calls = [];
  const client = {async callTool(request) {calls.push(request); return reply(compact());}, async close() {closed++;}};
  const result = await runOperator({client, input: Readable.from(['invalid-json\n', ...lines.map(line => `${JSON.stringify(line)}\n`)]),
    output: new Writable({write(chunk, _encoding, done) {stdout += chunk; done();}}), responseFile: 'cache/runner.json',
    publish: async (_file, id, payload, options) => published.push({id, payload, timing: options.timing})});
  assert.equal(result.closed, true);
  assert.equal(closed, 1);
  assert.deepEqual(calls.map(call => call.name), ['battle_turn_status']);
  assert.equal(stdout, 'OPERATOR_READY_READ_ONLY\nINPUT_ERROR invalid-json\nREADY turn\nREADY close\n');
  assert.equal(stdout.includes('fixture-mon'), false);
  assert.equal(published.every(item => Number.isInteger(item.timing.inputReceivedAt)), true);
  assert.equal(published[1].payload.result.battleClientUnaffected, true);
});

test('publication failure is labelled outcome-unknown rather than an unsent input error', async () => {
  let stdout = '', closed = 0;
  const client = {async callTool() {return reply(compact());}, async close() {closed++;}};
  await runOperator({client, input: Readable.from(['{"id":"observe","op":"turn"}\n']),
    output: new Writable({write(chunk, _encoding, done) {stdout += chunk; done();}}), responseFile: 'cache/runner.json',
    publish: async () => {throw new Error('fixture disk unavailable');}});
  assert.equal(stdout, 'OPERATOR_READY_READ_ONLY\nDISPATCH_ERROR observe outcome-unknown inspect-retained-response\n');
  assert.equal(closed, 1);
});

test('queued takeover and authored pair run sequentially with the new lease and preserve failed or reserved sends', async () => {
  for (const mode of ['ordinary', 'claim-rejected', 'already-reserved']) {
    const calls=[],published=[];
    let reads=0,closed=0;
    const client={async callTool(request){
      calls.push(request);
      if(request.name==='battle_status') return reply(idle());
      if(request.name==='battle_turn_status') return reply(++reads===1?compact():compact(NEXT_TOKEN,11));
      if(request.name==='battle_control_claim') return mode==='claim-rejected'
        ? raw({ok:false,error:'Controller generation changed'})
        : reply({controllerLease:LEASE,generation:2});
      if(request.name==='battle_stage_fallback') return reply({pending:[{token:TOKEN,hasFallback:true,fallbackSource:'fallback',attempted:mode==='already-reserved'}]});
      return reply({sent:true});
    },async close(){closed++;}};
    const lines=[
      {id:'arm',op:'arm',confirmed:true,expectedSessionId:SESSION,expectedTeamId:TEAM,expectedAccount:'fixture-owner'},
      {id:'observe',op:'turn'},
      {id:'takeover',op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:'queued-takeover',controllerId:'receiver',takeover:true,expectedGeneration:1}},
      {id:'pair',op:'play-next',room:ROOM,rqid:9,token:TOKEN,actions:pair},
      {id:'close',op:'close'},
    ];
    await runOperator({client,input:Readable.from([lines.map(line=>JSON.stringify(line)).join('\n')+'\n']),
      output:new Writable({write(_chunk,_encoding,done){done();}}),responseFile:'cache/queued-fixture.json',
      publish:async(_file,id,payload)=>published.push({id,payload})});
    assert.equal(closed,1);
    const control=calls.filter(call=>['battle_stage_fallback','battle_choose'].includes(call.name));
    if(mode==='claim-rejected') assert.equal(control.length,0);
    else {
      assert.deepEqual(control.map(call=>call.name),mode==='ordinary'?['battle_stage_fallback','battle_choose']:['battle_stage_fallback']);
      for(const call of control){assert.equal(call.arguments.controllerLease,LEASE);assert.equal(call.arguments.token,TOKEN);assert.deepEqual(call.arguments.actions,pair);}
    }
    assert.equal(JSON.stringify(published).includes(LEASE),false);
  }
});

test('response IDs are unique and a closed operator cannot dispatch again', async () => {
  const {operator, calls} = fixture(standardHandler);
  await operator.dispatch({id: 'one', op: 'turn'});
  await assert.rejects(operator.dispatch({id: 'one', op: 'turn'}), /already used/);
  await assert.rejects(operator.dispatch({id: 'bad\nmarker', op: 'turn'}), /short response ID/);
  await operator.dispatch({id: 'close', op: 'close'});
  await assert.rejects(operator.dispatch({id: 'after-close', op: 'turn'}), /closed/);
  assert.equal(calls.length, 1);
});
