import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperator} from './operator-client.mjs';

const TEAM = 'a'.repeat(64), LEASE = 'b'.repeat(64);
const receipt = 'e83d1536-2712-4fa8-9902-f2a1534a4c88';
const raw = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const reply = result => raw({ok: true, result});
const idle = () => ({sessionId: 'timeout-fixture', teamSha256: TEAM, username: 'Fixture',
  connected: true, authenticated: true, stopped: false, revision: 1,
  actions: [], rooms: [], search: {searching: [], games: null}});

// The fake SDK advances its clock by the remote work duration. It enforces the
// actual forwarded RequestOptions deadline without sleeping or opening a socket.
function fixture({durations = {}, rejection, ...options} = {}) {
  let clock = 1000;
  const calls = [], remoteEffects = [];
  const client = {async callTool(request, _schema, requestOptions) {
    calls.push({name: request.name, options: requestOptions});
    if (request.name === 'battle_status') return reply(idle());
    if (request.name === 'battle_turn_status') return reply({...idle(), boards: [], timing: {requests: []}});
    if (request.name === 'battle_control_claim') return reply({controllerLease: LEASE});
    if (request.name === 'battle_skill_read') return raw({readReceipt: receipt, filesRead: []});
    const duration = durations[request.name] ?? 0;
    remoteEffects.push(request.name);
    clock += Math.min(duration, requestOptions.timeout);
    if (duration > requestOptions.timeout) throw new Error('Fixture SDK response timed out after remote dispatch');
    if (rejection && rejection.name === request.name) return rejection.value;
    return raw({verified: true});
  }};
  const operator = createOperator({client, responseFile: 'unused-timeout-fixture.json',
    publish: async () => {}, now: () => clock, ...options});
  return {operator, calls, remoteEffects};
}

async function arm(operator) {
  const armed = await operator.dispatch({id: 'arm', op: 'arm', confirmed: true,
    expectedSessionId: 'timeout-fixture', expectedTeamId: TEAM, expectedAccount: 'Fixture'});
  assert.equal(armed.result.armed, true);
}

test('sync and retention completing after five seconds use the post-set budget once', async () => {
  const f = fixture({durations: {team_metrics_sync_battles: 6400, team_metrics_finalize_bo3: 7800}});
  await arm(f.operator);
  for (const [index, name] of ['team_metrics_sync_battles', 'team_metrics_finalize_bo3'].entries()) {
    const response = await f.operator.dispatch({id: `slow${index}`, op: 'call', name,
      args: {teamId: TEAM, confirmed: true}});
    assert.equal(response.result.verified, true);
    assert.ok(response.elapsedMs > 5000);
    assert.equal(f.calls.filter(call => call.name === name).length, 1);
    assert.equal(f.calls.find(call => call.name === name).options.timeout, 30000);
  }
  assert.deepEqual(f.remoteEffects, ['team_metrics_sync_battles', 'team_metrics_finalize_bo3']);
});

test('post-set work does not lengthen live socket controls or ordinary reads', async () => {
  const f = fixture();
  await arm(f.operator);
  await f.operator.dispatch({id: 'claim', op: 'call', name: 'battle_control_claim',
    args: {confirmed: true, commandId: 'fixture-claim', controllerId: 'Fixture'}});
  await f.operator.dispatch({id: 'guidance', op: 'call', name: 'battle_skill_read'});
  const postSetTools = ['battle_save_replays', 'battle_skill_sync', 'battle_review_save',
    'team_metrics_sync_battles', 'team_metrics_finalize_bo3', 'team_metrics_annotate_game',
    'team_metrics_import', 'team_metrics_import_replays', 'team_metrics_export'];
  for (const [index, name] of postSetTools.entries()) {
    const response = await f.operator.dispatch({id: `postset${index}`, op: 'call', name,
      args: {confirmed: true, commandId: `postset-${index}`}});
    assert.equal(response.result.verified, true);
    assert.equal(f.calls.find(call => call.name === name).options.timeout, 30000);
  }
  for (const [index, name] of ['battle_ready', 'battle_set_timer', 'battle_set_control_policy',
    'battle_note_decision', 'battle_forfeit'].entries()) {
    await f.operator.dispatch({id: `control${index}`, op: 'call', name,
      args: {confirmed: true, commandId: `control-${index}`}});
    assert.equal(f.calls.find(call => call.name === name).options.timeout, 5000);
  }
  await f.operator.dispatch({id: 'status', op: 'status'});
  assert.equal(f.calls.at(-1).options.timeout, 20000);
});

test('post-set transport timeout exposes uncertainty without repeating the mutation', async () => {
  const f = fixture({durations: {team_metrics_finalize_bo3: 31000}});
  await arm(f.operator);
  const response = await f.operator.dispatch({id: 'finalize-once', op: 'call',
    name: 'team_metrics_finalize_bo3', args: {teamId: TEAM, confirmed: true}});
  assert.match(response.error, /timed out/);
  assert.equal(response.retry, false);
  assert.equal(response.outcome, 'mutation-uncertain');
  assert.equal(response.requiresReconciliation, true);
  assert.equal(response.tool, 'team_metrics_finalize_bo3');
  assert.equal(response.timeoutMs, 30000);
  assert.equal(f.calls.filter(call => call.name === 'team_metrics_finalize_bo3').length, 1);
  assert.deepEqual(f.remoteEffects, ['team_metrics_finalize_bo3']);
  await assert.rejects(f.operator.dispatch({id: 'finalize-once', op: 'call',
    name: 'team_metrics_finalize_bo3'}), /already used/);
  assert.equal(f.remoteEffects.length, 1);
});

test('known post-set server rejection remains structured rather than transport uncertainty', async () => {
  const negative = {ok: false, error: 'Fixture retained-evidence mismatch', complete: false};
  const f = fixture({rejection: {name: 'team_metrics_finalize_bo3', value: {...raw(negative), isError: true}}});
  await arm(f.operator);
  const response = await f.operator.dispatch({id: 'known-rejection', op: 'call', name: 'team_metrics_finalize_bo3'});
  assert.equal(response.result.error, negative.error);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.complete, false);
  assert.equal(response.outcome, undefined);
  assert.equal(f.remoteEffects.length, 1);
});

test('post-set budget is independently bounded and never changes the fast control deadline', async () => {
  for (const value of [0, 30001, 1.5, '30000']) {
    assert.throws(() => fixture({postSetTimeoutMs: value}), /postSetTimeoutMs/);
  }
  const f = fixture({postSetTimeoutMs: 12000, mutationTimeoutMs: 1200,
    durations: {team_metrics_sync_battles: 6000, battle_ready: 2000}});
  await arm(f.operator);
  await f.operator.dispatch({id: 'claim', op: 'call', name: 'battle_control_claim', args: {confirmed: true}});
  const sync = await f.operator.dispatch({id: 'sync', op: 'call', name: 'team_metrics_sync_battles'});
  assert.equal(sync.result.verified, true);
  assert.equal(f.calls.find(call => call.name === 'team_metrics_sync_battles').options.timeout, 12000);
  const ready = await f.operator.dispatch({id: 'ready', op: 'call', name: 'battle_ready', args: {confirmed: true}});
  assert.match(ready.error, /timed out/);
  assert.equal(ready.retry, false);
  assert.equal(f.calls.find(call => call.name === 'battle_ready').options.timeout, 1200);
  assert.equal(f.calls.filter(call => call.name === 'battle_ready').length, 1);
});
