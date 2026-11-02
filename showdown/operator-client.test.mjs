import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createOperator, runOperator, unpackToolResult} from './operator-client.mjs';
import {createTimingRecorder, timingRequestKey, withTimingSpan} from '../observability/timing.mjs';

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
const previewCompact = () => ({...compact(), actions: [{...action(), kind: 'preview', legalActions: {
  teamPreview: true, maxChosenTeamSize: 4, pokemon: Array.from({length: 6}, (_, index) => ({ident: `p1: Preview ${index + 1}`})),
}}]});
const previewHandler = (name, args) => {
  if (['battle_turn_status', 'battle_wait'].includes(name)) return reply(previewCompact());
  if (name === 'battle_stage_fallback') return reply({pending: [{token: args.token, hasFallback: true, fallbackSource: 'fallback', attempted: false}]});
  if (name === 'battle_choose') return reply({status: 'sent-not-acknowledged'});
  return standardHandler(name);
};

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
test('native observation callback sees actual snapshots synchronously and its failure cannot alter delivery',async()=>{
  const seen=[],f=fixture(()=>reply(compact()),{onState:state=>{seen.push(structuredClone(state));throw Error('Synthetic optional observer fault');}});
  const result=await f.operator.dispatch({id:'observe-with-callback',op:'turn',full:true});
  assert.equal(seen.length,1);assert.deepEqual(seen[0].actions,compact().actions);
  assert.equal(result.error,undefined);assert.equal(f.calls.length,1);
  let delivered=f.publications[0].payload;while(delivered.result)delivered=delivered.result;
  assert.deepEqual(delivered.actions,compact().actions);
});
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

test('local action-format, bounded-plan and post-send option errors leave an unsent token available for a corrected authored command',async()=>{
  for(const invalid of [{postSendWaitMs:0},{postSendWaitMs:1.5},{postSendWaitMs:55001},{actions:['move 1 1','move 2 2']},{turnPlan:{objective:'Retain the useful paired action.',risk:'x'.repeat(181)}}]){
    const {operator,calls}=fixture((name,args)=>{
      if(name==='battle_wait')return reply(compact());
      if(name==='battle_stage_fallback')return reply({pending:[{token:args.token,hasFallback:true,fallbackSource:'fallback',attempted:false}]});
      if(name==='battle_choose')return reply({status:'sent-not-acknowledged'});
      return standardHandler(name);
    });
    await arm(operator);await claim(operator);await operator.dispatch({id:'current',op:'turn'});
    const base={op:'play-next',room:ROOM,rqid:9,token:TOKEN,actions:pair};
    const rejected=await operator.dispatch({...base,...invalid,id:'invalid-local'});
    assert.match(rejected.error,/postSendWaitMs|Structured action|risk|180/);
    assert.equal(calls.filter(call=>['battle_stage_fallback','battle_choose'].includes(call.request.name)).length,0);
    const corrected=await operator.dispatch({...base,id:'corrected-local'});
    assert.equal(corrected.error,undefined);
    assert.equal(calls.filter(call=>call.request.name==='battle_choose').length,1);
    const reserved=await operator.dispatch({...base,id:'never-resend'});assert.match(reserved.error,/reservation/);
  }
});

test('observed explicit preview team inputs keep their exact order through canonical staging and sending', async () => {
  // Orders retained from the independent baseline01 and low02 failed inputs;
  // this later contract repair does not amend their historical A/B outcomes.
  for (const team of [[2, 4, 3, 5], [6, 4, 3, 5]]) {
    const {operator, calls} = fixture(previewHandler);
    const info = await operator.dispatch({id: 'loaded-info', op: 'operator-info'});
    assert.equal(info.result.features.previewTeamShorthand, true);
    assert.match(info.result.modules['showdown/operator-client.mjs'], /^[a-f0-9]{64}$/);
    await arm(operator); await claim(operator); await operator.dispatch({id: 'observe-preview', op: 'turn'});
    const authored = {id: 'authored-preview', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, team};
    const result = await operator.dispatch(authored);
    assert.equal(result.error, undefined);
    assert.equal(result.result.sent.ok, true);
    for (const call of calls.filter(item => ['battle_stage_fallback', 'battle_choose'].includes(item.request.name))) {
      assert.deepEqual(call.request.arguments.actions, [{type: 'team', order: team}]);
      assert.equal(call.request.arguments.team, undefined);
      assert.equal(call.request.arguments.controllerLease, LEASE);
      assert.equal(call.request.arguments.token, TOKEN);
    }
    assert.equal(calls.filter(item => item.request.name === 'battle_choose').length, 1);
    assert.deepEqual(authored.team, team); assert.equal(authored.actions, undefined);
    const before = calls.length;
    const retry = await operator.dispatch({...authored, id: 'same-token-again'});
    assert.match(retry.error, /reservation/); assert.equal(calls.length, before);
  }
});

test('atomic preview plan survives operator staging and commit without changing the exact authored order',async()=>{
  const {operator,calls}=fixture(previewHandler);await arm(operator);await claim(operator);await operator.dispatch({id:'preview-intent-observe',op:'turn'});
  const previewPlan={objective:'Use the authored opening.',risk:'If control is contested retain independent pressure.',preserveIds:['selected-reserve'],nextTurnCondition:'Convert the first reserve action.',unverified:['Opposing selection.']},team=[6,4,3,5];
  const q={id:'preview-intent-stage',op:'stage-next',room:ROOM,rqid:9,token:TOKEN,kind:'preview',team,previewPlan},before=structuredClone(q);
  const staged=await operator.dispatch(q);assert.equal(staged.error,undefined);assert.deepEqual(q,before);
  const stageCall=calls.find(item=>item.request?.name==='battle_stage_fallback');assert.deepEqual(stageCall.request.arguments.previewPlan,{...previewPlan,chosenTeamOrder:team});
  const committed=await operator.dispatch({id:'preview-intent-commit',op:'commit-next',room:ROOM,rqid:9,token:TOKEN});assert.equal(committed.error,undefined);
  const choose=calls.find(item=>item.request?.name==='battle_choose');assert.deepEqual(choose.request.arguments.previewPlan,stageCall.request.arguments.previewPlan);assert.deepEqual(choose.request.arguments.actions,[{type:'team',order:team}]);
});

test('atomic preview plan mismatches refuse in the operator before stage or choose',async()=>{
  const {operator,calls}=fixture(previewHandler);await arm(operator);await claim(operator);await operator.dispatch({id:'bad-preview-observe',op:'turn'});
  const reply=await operator.dispatch({id:'bad-preview-intent',op:'play-next',room:ROOM,rqid:9,token:TOKEN,kind:'preview',team:[6,4,3,5],previewPlan:{objective:'This plan must match its order.',chosenTeamOrder:[1,2,3,4]}});
  assert.equal(typeof reply.error,'string');assert(!calls.some(item=>['battle_stage_fallback','battle_choose'].includes(item.request?.name)));
});

test('preview shorthand staging retains the canonical authored order for commit-next', async () => {
  const {operator, calls} = fixture(previewHandler);
  await arm(operator); await claim(operator); await operator.dispatch({id: 'preview', op: 'turn'});
  const staged = await operator.dispatch({id: 'preview-plan', op: 'stage-next', room: ROOM, rqid: 9, token: TOKEN, team: [6, 4, 3, 5]});
  assert.equal(staged.result.protection.staged, true);
  assert.equal(calls.some(item => item.request.name === 'battle_choose'), false);
  const committed = await operator.dispatch({id: 'preview-commit', op: 'commit-next', room: ROOM, rqid: 9, token: TOKEN});
  assert.equal(committed.error, undefined);
  assert.deepEqual(calls.find(item => item.request.name === 'battle_choose').request.arguments.actions, [{type: 'team', order: [6, 4, 3, 5]}]);
});

test('preview shorthand rejects malformed, simultaneous and stale inputs before mutation or reservation', async () => {
  const {operator, calls} = fixture(previewHandler);
  await arm(operator); await claim(operator); await operator.dispatch({id: 'preview', op: 'turn'});
  const base = {op: 'stage-next', room: ROOM, rqid: 9, token: TOKEN, team: [2, 4, 3, 5]};
  const inputs = [
    ...[null, '2435', [], [2, 4, 3], [2, 4, 3, 3], [0, 4, 3, 5], [7, 4, 3, 5], [2.5, 4, 3, 5], ['2', 4, 3, 5], [2, , 3, 5]].map(team => ({team})),
    {actions: [{type: 'team', order: base.team}]}, {actions: undefined}, {actions: [{type: 'team', order: [1, 2, 3, 4]}]},
    {room: `${ROOM}-wrong`}, {rqid: 10}, {token: NEXT_TOKEN}, {kind: 'turn'}, {op: 'commit-next'}, {op: 'turn'},
  ];
  for (const [index, input] of inputs.entries()) {
    const before = calls.length;
    const result = await operator.dispatch({...base, ...input, id: `invalid-preview-${index}`});
    assert.equal(typeof result.error, 'string', JSON.stringify(input));
    assert.equal(calls.length, before);
  }
  const valid = await operator.dispatch({...base, id: 'valid-after-rejections'});
  assert.equal(valid.result.protection.staged, true);
});

test('preview shorthand requires current preview legality, matching session and exclusive ownership', async () => {
  for (const mode of ['turn', 'missing-legality', 'wrong-session', 'unowned']) {
    const state = previewCompact();
    if (mode === 'turn') state.actions[0] = action();
    if (mode === 'missing-legality') delete state.actions[0].legalActions;
    if (mode === 'wrong-session') state.sessionId = 'other-session';
    const {operator, calls} = fixture((name, args) => name === 'battle_turn_status' ? reply(state) : previewHandler(name, args));
    await arm(operator); if (mode !== 'unowned') await claim(operator);
    await operator.dispatch({id: 'observed', op: 'turn'});
    const before = calls.length;
    const result = await operator.dispatch({id: 'forbidden-preview', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, team: [2, 4, 3, 5]});
    assert.equal(typeof result.error, 'string', mode); assert.equal(calls.length, before);
  }
});

test('existing canonical preview actions stay verbatim through the same leased path', async () => {
  const {operator, calls} = fixture(previewHandler);
  await arm(operator); await claim(operator); await operator.dispatch({id: 'preview', op: 'turn'});
  const actions = [{type: 'team', order: [5, 3, 4, 2]}];
  const result = await operator.dispatch({id: 'canonical-preview', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions});
  assert.equal(result.error, undefined);
  for (const call of calls.filter(item => ['battle_stage_fallback', 'battle_choose'].includes(item.request.name))) {
    assert.deepEqual(call.request.arguments.actions, actions);
  }
});

test('uncertain shorthand staging retains the exact canonical choice and blocks redispatch', async () => {
  const {operator, calls} = fixture((name, args) => {
    if (name === 'battle_stage_fallback') throw new Error('fixture uncertain preview staging');
    return previewHandler(name, args);
  });
  await arm(operator); await claim(operator); await operator.dispatch({id: 'preview', op: 'turn'});
  const command = {id: 'uncertain-preview', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, team: [2, 4, 3, 5]};
  const result = await operator.dispatch(command);
  assert.equal(result.result.recovery.outcome, 'mutation-uncertain');
  assert.equal(calls.filter(item => item.request.name === 'battle_stage_fallback').length, 1);
  assert.deepEqual(calls.find(item => item.request.name === 'battle_stage_fallback').request.arguments.actions, [{type: 'team', order: command.team}]);
  assert.equal(calls.some(item => item.request.name === 'battle_choose'), false);
  const before = calls.length;
  assert.match((await operator.dispatch({...command, id: 'no-preview-resend'})).error, /reservation/);
  assert.equal(calls.length, before);
});

test('known terminal-child recovery caches the newly observed preview for the next authored choice', async () => {
  const parentId='game-bestof3-gen9championsvgc2026regmcbo3-123';
  const nextRoom='battle-gen9championsvgc2026regmcbo3-124';
  const gap={...compact(),autoReady:true,actions:[],boards:[],rooms:[
    {id:parentId,parentId,ended:false},
    {id:ROOM,parentId,ended:true,result:{type:'win',winner:'fixture-opponent'}},
  ]};
  const preview={...compact(NEXT_TOKEN,2),revision:20,actions:[
    {...action(NEXT_TOKEN,2),room:nextRoom,parentId,kind:'preview'},
  ]};
  const turn={...compact('e'.repeat(64),4),revision:21,actions:[
    {...action('e'.repeat(64),4),room:nextRoom,parentId},
  ]};
  let previewSent=false;
  const {operator,calls}=fixture((name,args)=>{
    if(name==='battle_status')return reply(idle());
    if(name==='battle_control_claim')return reply({controllerLease:LEASE,controller:{generation:1}});
    if(name==='battle_turn_status')return reply(previewSent?turn:compact());
    if(name==='battle_stage_fallback' && args.token===TOKEN)return raw({ok:false,error:'terminal stale request',
      recovery:{outcome:'not-sent',retry:false,rebind:false,requiresNewDecision:true,state:gap}});
    if(name==='battle_wait')return reply(preview);
    if(name==='battle_stage_fallback')return reply({pending:[]});
    if(name==='battle_choose') {previewSent=true;return reply({status:'sent-not-acknowledged'});}
    throw Error('Unexpected fixture call');
  });
  await arm(operator);await claim(operator);await operator.dispatch({id:'before-terminal',op:'turn'});
  const recovered=await operator.dispatch({id:'stale-child',op:'play-next',room:ROOM,rqid:9,token:TOKEN,
    actions:pair,postSendWaitMs:55000});
  assert.equal(recovered.result.recovery.outcome,'not-sent');
  assert.equal(recovered.result.next.reason,'fresh-action');
  assert.equal(recovered.result.next.afterKnownNotSentChildTransition,true);
  assert.equal(calls.filter(c=>c.request?.name==='battle_turn_status').length,1);
  const chosen=await operator.dispatch({id:'authored-preview',op:'play-next',room:nextRoom,rqid:2,token:NEXT_TOKEN,
    kind:'preview',actions:[{type:'team',order:[4,2,1,3]}],postSendWaitMs:55000});
  assert.equal(chosen.result.next.reason,'fresh-action');
  const sent=calls.filter(c=>c.request?.name==='battle_choose');
  assert.equal(sent.length,1);
  assert.equal(sent[0].request.arguments.token,NEXT_TOKEN);
  assert.deepEqual(sent[0].request.arguments.actions,[{type:'team',order:[4,2,1,3]}]);
});

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

const registeredSix = label => Array.from({length: 6}, (_, index) =>
  `${label}${index + 1}|${label}${index + 1}|Sitrus Berry|Pressure|Protect,Thunderbolt|Serious|||||50|`).join(']');

test('read-only sheets uses one bounded native status call and preserves both complete six-member sheets without history or capabilities', async () => {
  const packed = {p1: registeredSix('Own'), p2: registeredSix('Foe')};
  const historicalRoom = `${ROOM}-old`, privateRoom = `${ROOM}-privatepw`;
  const native = idle({revision: 24, rooms: [
    {id: historicalRoom, ended: true, sheets: {p2: 'old-history-secret'}, result: {winner: 'history-winner'}},
    {id: privateRoom, teamId: TEAM, ended: false, sheets: {...packed, capability: 'opaque-sheet-capability'},
      state: {turn: 1, selectedFour: ['not-for-this-view']}, choice: {token: TOKEN}, recentEvents: ['history-event']},
  ], controller: {controllerLease: LEASE, capability: 'opaque-controller-capability'},
  transport: {address: 'private-local-socket'}, capabilities: {secret: 'opaque-native-capability'}, actions: [action()]});
  const before = structuredClone(native);
  const {operator, calls, publications} = fixture(name => {
    assert.equal(name, 'battle_status'); return reply(native);
  }, {maxSearches: 0, readTimeoutMs: 1234, now: () => 1000});
  for (const full of [false, true]) {
    const result = await operator.dispatch({id: `sheets-${full}`, op: 'sheets', full});
    assert.equal(result.error, undefined);
    assert.equal(result.maxSearches, 0); assert.equal(result.searchesAttempted, 0);
    const view = result.result;
    assert.deepEqual(view.source, {tool: 'battle_status', sessionId: SESSION, snapshotRevision: 24, readSettledAt: 1000});
    assert.equal(view.roomScope, 'observed-live-rooms'); assert.equal(view.status, 'sheets-observed');
    assert.equal(view.format, 'native-pokemon-showdown-packed-open-team');
    assert.deepEqual(view.rooms, [{roomId: privateRoom, teamId: TEAM, ended: false, sheets: packed}]);
    assert.equal(view.rooms[0].sheets.p2.split(']').length, 6);
    assert.match(view.completeness, /complete observed packed sheet.*without decoding or truncation/);
    assert.match(view.uncertainty, /Registered six are not selected four.*investments.*No action token.*own fresh turn/);
    for (const excluded of ['old-history-secret', 'history-winner', 'not-for-this-view', 'history-event', 'opaque-', 'private-local-socket', TOKEN, LEASE]) {
      assert.equal(JSON.stringify(result).includes(excluded), false, excluded);
      assert.equal(JSON.stringify(publications.at(-1).payload).includes(excluded), false, excluded);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 5000);
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.request.name === 'battle_status' && call.options.timeout === 1234));
  assert.ok(calls.every(call => Object.keys(call.request.arguments).length === 0));
  assert.deepEqual(native, before);
  const control = await operator.dispatch({id: 'still-unarmed', op: 'call', name: 'battle_control_claim', args: {confirmed: true}});
  assert.match(control.error, /Read-only/); assert.equal(calls.length, 2);
});

test('sheets exact-room filter never guesses parent, alias, selected four or fresh handoff readiness', async () => {
  const parent = 'game-bestof3-gen9championsvgc2026regmcbo3-123';
  const native = idle({revision: 25, rooms: [
    {id: parent, ended: false, children: [ROOM], sheets: {p2: registeredSix('ParentFoe')}},
    {id: ROOM, ended: false, sheets: {}},
    {id: `${ROOM}-ended`, ended: true, sheets: {p2: registeredSix('PastFoe')}},
  ]});
  const {operator, calls} = fixture(() => reply(native));
  const missing = await operator.dispatch({id: 'missing-alias', op: 'sheets', room: `${ROOM}-missingpw`});
  assert.equal(missing.result.status, 'room-not-observed'); assert.deepEqual(missing.result.rooms, []);
  const empty = await operator.dispatch({id: 'no-child-sheet', op: 'sheets', room: ROOM});
  assert.equal(empty.result.status, 'no-sheets-observed'); assert.deepEqual(empty.result.rooms, []);
  const exact = await operator.dispatch({id: 'exact-parent', op: 'sheets', room: parent});
  assert.equal(exact.result.roomScope, 'exact-observed-room');
  assert.equal(exact.result.rooms.length, 1); assert.equal(exact.result.rooms[0].roomId, parent);
  const ended = await operator.dispatch({id: 'exact-ended', op: 'sheets', room: `${ROOM}-ended`});
  assert.equal(ended.result.rooms[0].ended, true);
  for (const [id, extra] of [['bad-room', {room: '../room'}], ['no-args', {args: {room: ROOM}}], ['no-cap', {controllerLease: LEASE}]]) {
    assert.match((await operator.dispatch({id, op: 'sheets', ...extra})).error, /optional exact observed room/);
  }
  assert.equal(calls.length, 4);
  await arm(operator, 'sheet-reader-arm');
  const handoff = await operator.dispatch({id: 'no-turn-from-sheets', op: 'handoff-next'});
  assert.match(handoff.error, /Unknown operator operation/);
  assert.equal(calls.length, 5);
});

test('sheets fails explicitly without publishing partial sheets on missing provenance, unsupported format or size overflow', async () => {
  for (const [label, native] of [
    ['missing-revision', {...idle(), revision: undefined}],
    ['unsupported-format', idle({rooms: [{id: ROOM, ended: false, sheets: {p1: registeredSix('Own'), p2: [{species: 'partial'}]}}]})],
    ['too-large', idle({rooms: [{id: ROOM, ended: false, sheets: {p2: 'x'.repeat(65536)}}]})],
    ['ambiguous-room', idle({rooms: [{id: ROOM, ended: false, sheets: {p2: 'one'}}, {id: ROOM, ended: false, sheets: {p2: 'two'}}]})],
  ]) {
    const {operator, calls, publications} = fixture(() => reply(native));
    const result = await operator.dispatch({id: label, op: 'sheets', full: true});
    assert.equal(typeof result.error, 'string', label); assert.equal(result.result, undefined, label);
    assert.equal(calls.length, 1); assert.equal(publications[0].payload.result, undefined);
    assert.equal(result.retry, false); assert.equal(result.searchesAttempted, 0);
  }
});

test('operator-info fingerprints current model-owned helpers without removed host planning routes', async () => {
  const {operator, calls} = fixture();
  const result = await operator.dispatch({id: 'presentation-info', op: 'operator-info'});
  assert.equal(calls.length, 0);
  assert.equal(result.result.features.readOnlyRegisteredSheets, true);
  assert.equal(result.result.features.retainedObservedSheetCache, true);
  assert.match(result.result.modules['planning/source.mjs'], /^[a-f0-9]{64}$/);
  assert.match(result.result.modules['showdown/battle-state.mjs'], /^[a-f0-9]{64}$/);
  assert.equal(result.result.features.modelOwnedToolExecutor, true);
  for(const name of ['guardedAutomaticThreatScreen','inlineDecisionPacket','candidateCommandCue','atomicResearchPolicy'])assert.equal(result.result.features[name],undefined);
  for(const name of ['isolated/threat-screen.mjs','showdown/conditional-next.mjs','showdown/planning-next.mjs','showdown/research-next.mjs'])assert.equal(result.result.modules[name],undefined);
  for (const [name, hash] of Object.entries(result.result.modules)) {
    assert.equal(hash, createHash('sha256').update(readFileSync(new URL(`../${name}`, import.meta.url))).digest('hex'), name);
  }
  assert.match(result.result.limitation, /no battle-client or calculator-server adoption/);
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

test('guidance proof binds exact successful read, UTF8 content, private retained receipt and expiry without publishing the receipt',async()=>{
  let now=1000,invalid=false;
  const filesRead=[{path:'SKILL.md',content:'Complete current fixture guidance — UTF8.'},{path:'references/headless-battle-cycle.md',content:'Complete current cycle.'}]
    .map(file=>({...file,sha256:createHash('sha256').update(file.content,'utf8').digest('hex')}));
  const {operator,publications}=fixture(name=>{
    if(name==='battle_skill_read')return raw({skill:'champions-mc-matchups',synchronized:true,sourceSha256:TEAM,installedSha256:TEAM,files:2,
      filesRead:invalid?filesRead.slice(0,1):filesRead,readReceipt:RECEIPT,receiptExpiresAt:new Date(61000).toISOString()});
    return standardHandler(name);
  },{now:()=>now});
  assert.equal(operator.getGuidanceReadProof({commandId:'read'}),null);
  const value=await operator.dispatch({id:'read',op:'call',name:'battle_skill_read',full:true});
  assert.equal(value.result.readReceipt,undefined);
  const proof=operator.getGuidanceReadProof({commandId:'read'});
  assert.equal(proof.receiptRetained,true);assert.equal(proof.files,2);assert.equal(proof.commandId,'read');
  assert.equal(operator.getGuidanceReadProof({commandId:'old-read'}),null);
  assert(!JSON.stringify(proof).includes(RECEIPT));assert(!JSON.stringify(publications.map(item=>item.payload)).includes(RECEIPT));
  proof.files=99;assert.equal(operator.getGuidanceReadProof({commandId:'read'}).files,2);
  now=61000;assert.equal(operator.getGuidanceReadProof({commandId:'read'}),null);
  now=1000;invalid=true;await operator.dispatch({id:'incomplete-read',op:'call',name:'battle_skill_read',full:true});
  assert.equal(operator.getGuidanceReadProof({commandId:'read'}),null);
  assert.equal(operator.getGuidanceReadProof({commandId:'incomplete-read'}),null);
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

test('start-next forwards the optional absolute observation window and caches a native delayed preview',async()=>{
  for(const delayed of [false,true]) {
    const began=1792734065382;
    let tick=began,waits=0;
    const searching={...idle(),revision:241,boards:[],search:{searching:['gen9championsvgc2026regmcbo3'],games:null}};
    const preview={...compact(NEXT_TOKEN,3),revision:242,actions:[{...action(NEXT_TOKEN,3),kind:'preview'}],
      observedAt:began+21887,boards:[{room:ROOM,parentId:action().parentId,requestAgeMs:0,
        request:{rqid:3,teamPreview:true,source:'server-request'}}]};
    const {operator,calls}=fixture((name,args)=>{
      if(name==='battle_status')return reply(idle());
      if(name==='battle_control_claim')return reply({controllerLease:LEASE,controller:{generation:1}});
      if(name==='battle_start'){tick+=6;return raw({id:'one-owned-search',ok:true,
        result:{status:'sent-not-acknowledged',searchesSent:1,authorizedSets:1}});}
      if(name==='battle_turn_status')return reply(delayed?searching:preview);
      if(name==='battle_wait') {
        if(++waits===1){tick=began+19904;return reply(searching);}
        tick=began+21887;return reply(preview);
      }
      if(name==='battle_stage_fallback')return reply({pending:[{token:args.token,hasFallback:true,fallbackSource:'fallback',attempted:false}]});
      throw Error('Unexpected fixture call');
    },{maxSearches:1,now:()=>tick});
    await arm(operator);await claim(operator);
    const result=await operator.dispatch({id:'one-owned-search',op:'start-next',confirmed:true,postSendWaitMs:55000});
    assert.equal(result.result.next.reason,'fresh-action');
    assert.equal(result.result.next.state.result.actions[0].token,NEXT_TOKEN);
    assert.equal(result.searchesAttempted,1);
    assert.equal(waits,delayed?2:0);
    assert.equal(tick-began,delayed?21887:6);
    const staged=await operator.dispatch({id:'first-authored-preview',op:'stage-next',room:ROOM,rqid:3,token:NEXT_TOKEN,
      kind:'preview',actions:[{type:'team',order:[4,2,1,3]}]});
    assert.equal(staged.result.protection.staged,true);
    assert.equal(calls.filter(c=>c.request?.name==='battle_turn_status').length,1);
    assert.equal(calls.filter(c=>c.request?.name==='battle_start').length,1);
    const search=calls.find(c=>c.request?.name==='battle_start');
    assert.equal(search.request.arguments.controllerLease,LEASE);
    assert.equal(search.request.arguments.postSendWaitMs,undefined);
    assert(search.options.timeout<=5000);
    for(const call of calls.filter(c=>c.request?.name==='battle_wait')) {
      assert(call.options.timeout<=20000);assert(call.options.signal instanceof AbortSignal);
      assert.equal(call.request.arguments.format,'compact');
    }
  }
});

test('a late SDK preview after the start-next read abort cannot replace its owned cached observation',async()=>{
  let finishLateWait;
  const searching={...idle(),boards:[],search:{searching:['fixture'],games:null}};
  const {operator,calls}=fixture(name=>{
    if(name==='battle_status')return reply(idle());
    if(name==='battle_control_claim')return reply({controllerLease:LEASE,controller:{generation:1}});
    if(name==='battle_start')return reply({status:'sent-not-acknowledged'});
    if(name==='battle_turn_status')return reply(searching);
    if(name==='battle_wait')return new Promise(done=>{finishLateWait=()=>done(reply(compact(NEXT_TOKEN,3)));});
    throw Error('Unexpected fixture call');
  },{maxSearches:1,budgetMs:20,publish:async(_file,id,_payload,options)=>{
    if(id!=='late-preview-search')return;
    const before=structuredClone(options.timing);
    finishLateWait();
    await new Promise(done=>setImmediate(done));
    assert.deepEqual(options.timing,before);
  }});
  await arm(operator);await claim(operator);
  const result=await operator.dispatch({id:'late-preview-search',op:'start-next',confirmed:true,postSendWaitMs:40});
  assert.equal(result.result.next.reason,'read-unavailable');
  const before=calls.length;
  const stale=await operator.dispatch({id:'not-delivered-preview',op:'stage-next',room:ROOM,rqid:3,token:NEXT_TOKEN,
    actions:[{type:'team',order:[4,2,1,3]}]});
  assert.match(stale.error,/cached compact request/);
  assert.equal(calls.length,before);
  assert.equal(calls.filter(c=>c.request?.name==='battle_start').length,1);
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

test('owned between-set reads use the bounded post-set budget only after the short fresh idle guard',async()=>{
  for(const name of ['battle_preflight','team_metrics_agent_report','battle_timing_report']){
    const {operator,calls}=fixture((tool,args)=>tool==='battle_turn_status'?reply(idle()):standardHandler(tool,args),{readTimeoutMs:1500,postSetTimeoutMs:30000});
    await arm(operator);await claim(operator);const before=calls.length;
    const result=await operator.dispatch({id:'idle-'+name,op:'call',name,args:{}});assert.equal(result.error,undefined);
    const observed=calls.slice(before);assert.deepEqual(observed.map(row=>[row.request.name,row.options.timeout]),[['battle_turn_status',1500],[name,30000]]);
    assert.equal(observed.filter(row=>row.request.name===name).length,1);
  }
  assert.throws(()=>fixture(standardHandler,{postSetTimeoutMs:30001}),/postSetTimeoutMs/);
});

test('active or unverifiable requests block between-set reads before their longer budget is used',async()=>{
  for(const name of ['battle_preflight','team_metrics_agent_report'])for(const unavailable of [false,true]){
    const {operator,calls}=fixture((tool,args)=>{
      if(tool==='battle_turn_status'){if(unavailable)throw Object.assign(new Error('Fixture fresh read timeout'),{code:-32001});return reply(compact());}
      return standardHandler(tool,args);
    },{readTimeoutMs:1500,postSetTimeoutMs:30000});
    await arm(operator);await claim(operator);const before=calls.length;
    const result=await operator.dispatch({id:name+unavailable,op:'call',name,args:{}});
    assert.equal(result.result.blocked,true);assert.equal(result.result.reason,unavailable?'current-request-unavailable':'between-sets-required');
    assert.deepEqual(calls.slice(before).map(row=>[row.request.name,row.options.timeout]),[['battle_turn_status',1500]]);
  }
});

test('unowned observer reads and live calculator reads retain their existing short budgets',async()=>{
  const observer=fixture((name)=>reply({done:true}),{readTimeoutMs:1500,postSetTimeoutMs:30000});
  await observer.operator.dispatch({id:'observer-preflight',op:'call',name:'battle_preflight',args:{}});
  assert.deepEqual(observer.calls.map(row=>[row.request.name,row.options.timeout]),[['battle_preflight',1500]]);
  const staged={...compact(),controlPolicy:{pending:[{room:ROOM,rqid:9,token:TOKEN,hasFallback:true,fallbackSource:'fallback',attempted:false,cutoffAt:Date.now()+45000}]}};
  const live=fixture((name,args)=>name==='battle_turn_status'?reply(staged):standardHandler(name,args),{readTimeoutMs:1500,postSetTimeoutMs:30000});
  await arm(live.operator);await claim(live.operator);const before=live.calls.length;
  await live.operator.dispatch({id:'live-speed',op:'call',name:'calculate_speed',args:{}});
  assert.deepEqual(live.calls.slice(before).map(row=>[row.request.name,row.options.timeout]),[['battle_turn_status',1500],['calculate_speed',1500]]);
});

test('an idle read timeout remains bounded and never retries the read or changes later immediate-read budgets',async()=>{
  const {operator,calls}=fixture((name,args)=>{
    if(name==='battle_turn_status')return reply(idle());
    if(name==='battle_preflight')throw Object.assign(new Error('Fixture SDK timeout'),{code:-32001});
    return standardHandler(name,args);
  },{readTimeoutMs:1500,postSetTimeoutMs:6000});
  await arm(operator);await claim(operator);
  const failed=await operator.dispatch({id:'preflight-timeout',op:'call',name:'battle_preflight',args:{}});
  assert.match(failed.error,/Fixture SDK timeout/);const checks=calls.filter(row=>row.request.name==='battle_preflight');assert.equal(checks.length,1);assert.equal(checks[0].options.timeout,6000);
  await operator.dispatch({id:'after-timeout',op:'turn'});assert.equal(calls.at(-1).request.name,'battle_turn_status');assert.equal(calls.at(-1).options.timeout,1500);
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

test('default stdin is released after normal close and SDK shutdown failure', async () => {
  for (const failClose of [false, true]) {
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const input = Readable.from(['{"id":"stdin-close","op":"close"}\n']);
    const pause = input.pause;
    let sdkClosed = false, releasedAfterSdk = 0, unreferenced = 0;
    input.pause = function () { if (sdkClosed) releasedAfterSdk++; return pause.call(this); };
    input.unref = () => { unreferenced++; };
    Object.defineProperty(process, 'stdin', {configurable: true, value: input});
    const published = [];
    try {
      const done = runOperator({client: {
        async callTool() { throw new Error('No battle calls expected'); },
        async close() { sdkClosed = true; if (failClose) throw new Error('fixture SDK close failure'); },
      }, output: new Writable({write(_chunk, _encoding, callback) { callback(); }}),
      responseFile: 'unused-stdin-shutdown.json', publish: async (_file, id, payload) => published.push({id, payload})});
      if (failClose) await assert.rejects(done, /fixture SDK close failure/);
      else assert.equal((await done).closed, true);
      assert.equal(releasedAfterSdk, 1);
      assert.equal(unreferenced, 1);
      assert.equal(published.length, 1);
      assert.equal(published[0].id, 'stdin-close');
      assert.deepEqual(published[0].payload.result, {closed: true, battleClientUnaffected: true});
    } finally {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  }
});

test('runner leaves caller-owned custom input reference ownership unchanged', async () => {
  const input = Readable.from(['{"id":"custom-close","op":"close"}\n']);
  const pause = input.pause;
  let sdkClosed = false, releasedAfterSdk = 0, unreferenced = 0;
  input.pause = function () { if (sdkClosed) releasedAfterSdk++; return pause.call(this); };
  input.unref = () => { unreferenced++; };
  await runOperator({input, client: {
    async callTool() { throw new Error('No battle calls expected'); }, async close() { sdkClosed = true; },
  }, output: new Writable({write(_chunk, _encoding, callback) { callback(); }}),
  responseFile: 'unused-custom-shutdown.json', publish: async () => {}});
  assert.equal(releasedAfterSdk, 0);
  assert.equal(unreferenced, 0);
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

test('opt-in timing separates individual calls, post-send observation and publication without exposing control capabilities', async () => {
  let tick = 0, sent = false;
  const timingRecorder = createTimingRecorder({component: 'operator-fixture', now: () => 1000 + tick, monotonic: () => tick});
  const {operator, calls, publications} = fixture((name, args) => {
    if (name === 'battle_stage_fallback') { tick += 3; return reply({pending: [{token: args.token, hasFallback: true, fallbackSource: 'fallback', attempted: false}]}); }
    if (name === 'battle_choose') { tick += 5; sent = true; return reply({status: 'sent-not-acknowledged'}); }
    if (name === 'battle_turn_status') { tick += 11; return reply(sent ? compact(NEXT_TOKEN, 10) : compact()); }
    return standardHandler(name);
  }, {timingRecorder, now: () => 1000 + tick, publish: async (_file, _id, _payload, options) => {
    publications.push({options});
    const preparedAt = 1000 + tick; tick += 7;
    return {timing: {...options.timing, preparedAt, idAvailableAt: preparedAt + 2, publicationReturnedAt: preparedAt + 7}};
  }});
  await arm(operator); await claim(operator); await operator.dispatch({id: 'board', op: 'turn'});
  await operator.dispatch({id: 'timed-pair', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  const entries = timingRecorder.snapshot().filter(entry => entry.commandId === 'timed-pair');
  const ends = name => entries.filter(entry => entry.name === name && entry.event === 'span.end');
  assert.deepEqual(ends('operator.mcp_call').map(entry => [entry.tool, entry.durationMs]),
    [['battle_stage_fallback', 3], ['battle_choose', 5], ['battle_turn_status', 11]]);
  assert.equal(ends('operator.post_send_wait')[0].durationMs, 11);
  assert.equal(ends('operator.execute')[0].durationMs, 19);
  assert.equal(ends('operator.publish')[0].durationMs, 7);
  assert.equal(ends('operator.command')[0].durationMs, 26);
  assert.equal(ends('operator.response_prepare')[0].durationMs, 0);
  assert.equal(entries.filter(entry => entry.name === 'authored.stage').length, 1);
  assert.equal(entries.filter(entry => entry.name === 'authored.send').length, 1);
  const key = timingRequestKey({sessionId: SESSION, roomId: ROOM, rqid: 9, token: TOKEN});
  assert.equal(ends('operator.command')[0].requestKey, key);
  assert.equal(ends('operator.command')[0].requestReceivedAt, 900);
  const publication = entries.find(entry => entry.name === 'operator.publication_observed');
  assert.equal(publication.publicationReturnedAt - publication.preparedAt, 7);
  assert.equal(publication.idAvailableAt - publication.preparedAt, 2);
  assert.equal(JSON.stringify(entries).includes(TOKEN), false);
  assert.equal(JSON.stringify(entries).includes(LEASE), false);
  const chosen = calls.find(call => call.request.name === 'battle_choose').request;
  assert.equal(chosen._meta['vgc/timing'].requestKey, key);
  assert.equal(chosen._meta['vgc/timing'].teamId, TEAM);
  assert.equal(Object.hasOwn(chosen._meta['vgc/timing'], 'token'), false);
});

test('opt-in queued commands and output callbacks have independent boundaries without delaying the next command', async () => {
  let tick = 0, closeExecuted = false;
  const timingRecorder = createTimingRecorder({component: 'operator-queue-fixture', now: () => 1000 + tick, monotonic: () => tick});
  const outputCallbacks = [];
  const output = {write(value, callback) { if (value.startsWith('READY')) outputCallbacks.push(callback); return true; }};
  const done = runOperator({timingRecorder, now: () => 1000 + tick,
    client: {async callTool() { tick += 20; return reply(compact()); }, async close() {}},
    input: Readable.from(['{"id":"slow","op":"turn"}\n{"id":"queued","op":"close"}\n']), output,
    responseFile: 'unused-timing-fixture.json', publish: async (_file, id) => { if (id === 'queued') closeExecuted = true; }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeExecuted, true);
  assert.equal(outputCallbacks.length, 2);
  let entries = timingRecorder.snapshot();
  assert.equal(entries.filter(entry => entry.name === 'operator.marker_written').length, 0);
  assert.equal(entries.find(entry => entry.commandId === 'queued' && entry.name === 'operator.queue' && entry.event === 'span.end').durationMs, 20);
  tick += 13; outputCallbacks.forEach(callback => callback());
  await done;
  entries = timingRecorder.snapshot();
  assert.equal(entries.filter(entry => entry.name === 'operator.marker_written').length, 2);
  assert(entries.filter(entry => entry.name === 'operator.marker_written').every(entry => entry.monotonicMs === 33));
  for (const commandId of ['slow', 'queued']) assert.equal(new Set(entries.filter(entry => entry.commandId === commandId).map(entry => entry.traceId)).size, 1);
});

test('timing preserves a late SDK settlement after a bounded wait without counting it as cancellation or another send', async () => {
  let finishLate;
  const timingRecorder = createTimingRecorder({component: 'operator-late-fixture'});
  const {operator, calls} = fixture(name => {
    if (name === 'battle_stage_fallback') return new Promise(done => { finishLate = () => done(reply({pending: []})); });
    return standardHandler(name);
  }, {timingRecorder, budgetMs: 10, mutationTimeoutMs: 5});
  await arm(operator); await claim(operator); await operator.dispatch({id: 'board', op: 'turn'});
  await operator.dispatch({id: 'bounded', op: 'play-next', room: ROOM, rqid: 9, token: TOKEN, actions: pair});
  finishLate(); await new Promise(resolve => setImmediate(resolve));
  const events = timingRecorder.snapshot().filter(entry => entry.commandId === 'bounded');
  assert.equal(events.filter(entry => entry.name === 'operator.rpc_wait_timeout').length, 1);
  assert.equal(events.filter(entry => entry.name === 'operator.mcp_wait_aborted').length, 1);
  const settlement = events.find(entry => entry.name === 'operator.mcp_late_settlement');
  assert.equal(settlement.observationOwnership, false);
  const span = events.find(entry => entry.name === 'operator.mcp_call' && entry.tool === 'battle_stage_fallback' && entry.event === 'span.end');
  assert.equal(span.status, 'late');
  assert.equal(calls.filter(call => call.request.name === 'battle_stage_fallback').length, 1);
  assert.equal(calls.filter(call => call.request.name === 'battle_choose').length, 0);
});

test('opt-in correlation imports bounded validated remote timing without publishing its envelope or raw attributes', async () => {
  let serverTime = 500;
  const timingRecorder = createTimingRecorder({component: 'operator-import-fixture'});
  const remote = createTimingRecorder({component: 'server-import-fixture', now: () => 1000 + serverTime, monotonic: () => serverTime});
  const {operator, calls, publications} = fixture(() => {
    const context = calls.at(-1).request._meta['vgc/timing'];
    assert.equal(context.returnEvents, true);
    remote.run(context, () => withTimingSpan('mcp.tool', {tool: 'battle_turn_status', password: 'fixture-private'}, () => { serverTime += 8; }));
    return {...reply(compact()), _meta: {'vgc/timing-events': [...remote.drain(), {password: 'fixture-private'}]}};
  }, {timingRecorder});
  const result = await operator.dispatch({id: 'import', op: 'turn'});
  const events = timingRecorder.snapshot();
  const imported = events.find(entry => entry.component === 'server-import-fixture' && entry.event === 'span.end');
  assert.equal(imported.durationMs, 8);
  assert.equal(imported.traceId, events.find(entry => entry.name === 'operator.command').traceId);
  assert.equal(JSON.stringify(events).includes('fixture-private'), false);
  assert.equal(Object.hasOwn(result.result, '_meta'), false);
  assert.equal(JSON.stringify(publications).includes('vgc/timing-events'), false);
  const plain = fixture(standardHandler);
  await plain.operator.dispatch({id: 'plain', op: 'turn'});
  assert.equal(plain.calls[0].request._meta, undefined);
});


test('removed host strategy operations refuse before any native read or mutation',async()=>{
  const {operator,calls}=fixture();await arm(operator);await claim(operator);
  const before=calls.length;
  for(const [index,op] of ['threat-screen','brief-next','play-plan','prepare-checks-next','stage-check-next','calculate-play-next','simulate-play-next','checks-play-next','delivery-play-next','call-batch','handoff-next','exposure','exposure-budget'].entries()){
    const result=await operator.dispatch({id:`removed-${index}`,op});
    assert.match(result.error,/Unknown operator operation/);assert.equal(result.retry,false);
  }
  assert.equal(calls.length,before);
  const rejected=await operator.dispatch({id:'removed-policy',op:'decision-policy',enabled:true,inlineBrief:true,requireAtomicResearch:true});
  assert.match(rejected.error,/Unsupported decision-policy/);assert.equal(calls.length,before);
  const policy=await operator.dispatch({id:'current-policy',op:'decision-policy',enabled:true,commitBufferMs:6000});
  assert.equal(policy.result.commitBufferMs,6000);assert.equal(policy.result.inlineBrief,undefined);
});
