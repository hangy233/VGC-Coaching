import {Readable, Writable} from 'node:stream';
import {runOperator} from '../../showdown/operator-client.mjs';
import {createTimingRecorder, withTimingSpan} from '../timing.mjs';
import {analyzeEvents} from '../analyze.mjs';

/** This exercises the maintained operator with its documented fake SDK seam.
 * All clocks and tool replies below are synthetic. No SDK connection is opened.
 * Advancing clocks (rather than sleeping) makes exact delay attribution testable.
 */
export async function runWorkflowFixture({engineMs = 7, transportMs = 5, publicationMs = 11,
  opponentWaitMs = 29} = {}) {
  for (const delay of [engineMs, transportMs, publicationMs, opponentWaitMs]) {
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10000) throw new Error('fixture delays must be 0..10000 ms');
  }
  let clock = 0, sent = false, staged = false;
  const epoch = 1700000000000, team = 'a'.repeat(64), lease = 'b'.repeat(64), token = 'c'.repeat(64);
  const room = 'battle-gen9championsvgc2026regmcbo3-1', sessionId = 'offline-synthetic-session';
  const operatorTrace = createTimingRecorder({component: 'offline.operator', now: () => epoch + clock, monotonic: () => clock});
  const serverTrace = createTimingRecorder({component: 'offline.server', now: () => epoch + clock, monotonic: () => 100000 + clock});
  const advance = async ms => { await Promise.resolve(); clock += ms; };
  const idle = () => ({sessionId, teamSha256: team, username: 'offline-fixture', connected: true,
    authenticated: true, stopped: false, revision: 1, actions: [], rooms: [], search: {searching: [], games: null}});
  const compact = ({next = false, waiting = false} = {}) => ({...idle(), revision: next ? 2 : 1, observedAt: epoch + clock,
    actions: [{room, rqid: next ? 2 : 1, token: next ? 'd'.repeat(64) : token, kind: 'turn', actionable: !waiting,
      ...(waiting ? {submissionStatus: 'sent'} : {}), legalActions: {active: [
        {moves: [{slot: 1, targets: [1, 2]}]}, {moves: [{slot: 2, targets: [1, 2]}]}]}}],
    rooms: [{id: room, ended: false}], search: {searching: [], games: {[room]: true}},
    controlPolicy: {pending: staged ? [{room, rqid: 1, token, hasFallback: true, fallbackSource: 'fallback', attempted: false, cutoffAt: epoch + 10000}] : []},
    timing: {requests: [{room, rqid: next ? 2 : 1, token: next ? 'd'.repeat(64) : token,
      receivedAt: epoch, cutoffAt: epoch + 10000}]},
    boards: [{room, turn: next ? 2 : 1, sides: []}]});
  const reply = result => ({structuredContent: {ok: true, result}});
  const calls = [], publications = [];
  const client = {
    async callTool(request) {
      calls.push(request.name);
      await advance(transportMs);
      return serverTrace.run(request._meta?.['vgc/timing'] ?? {}, () => withTimingSpan('mcp.tool', {tool: request.name}, async () => {
        if (request.name === 'battle_status') return reply(idle());
        if (request.name === 'battle_control_claim') return reply({controllerLease: lease});
        if (request.name === 'calculate_damage') return withTimingSpan('calculator.engine', {tool: request.name}, async () => {
          await advance(engineMs); return reply({synthetic: true, numericalDamageClaim: false});
        });
        if (request.name === 'battle_turn_status') return reply(compact({waiting: sent}));
        if (request.name === 'battle_stage_fallback') { staged = true; return reply({pending: [{token, hasFallback: true, fallbackSource: 'fallback', attempted: false}]}); }
        if (request.name === 'battle_choose') { sent = true; return reply({status: 'sent-not-acknowledged'}); }
        if (request.name === 'battle_wait') { await advance(opponentWaitMs); return reply(compact({next: true})); }
        throw new Error('Unexpected synthetic SDK call');
      }));
    },
    async close() {},
  };
  const commands = [
    {id: 'offline-arm', op: 'arm', confirmed: true, expectedSessionId: sessionId, expectedTeamId: team, expectedAccount: 'offline-fixture'},
    {id: 'offline-claim', op: 'call', name: 'battle_control_claim', args: {confirmed: true, commandId: 'offline-claim', controllerId: 'offline-fixture'}},
    {id: 'offline-observe', op: 'turn'},
    {id: 'offline-stage', op: 'stage-next', room, rqid: 1, token, actions: [{type: 'move', slot: 1, target: 1}, {type: 'move', slot: 2, target: 2}]},
    {id: 'offline-calculate', op: 'call', name: 'calculate_damage', args: {}},
    {id: 'offline-play', op: 'play-next', room, rqid: 1, token, actions: [{type: 'move', slot: 1, target: 1}, {type: 'move', slot: 2, target: 2}]},
  ];
  const output = [];
  await runOperator({client, responseFile: 'offline-fixture-never-written.json',
    input: Readable.from([commands.map(item => JSON.stringify(item)).join('\n') + '\n']),
    output: new Writable({write(chunk, _encoding, callback) { output.push(String(chunk)); callback(); }}),
    now: () => epoch + clock, timingRecorder: operatorTrace,
    publish: async (_path, id, payload) => { await advance(publicationMs); publications.push({id, payload}); },
  });
  const traceEvents = [...operatorTrace.snapshot(), ...serverTrace.snapshot()];
  return {schemaVersion: 1, kind: 'offline-synthetic-workflow-benchmark', modelCalls: 0,
    networkConnections: 0, clockBasis: 'deterministic injected virtual clocks; milliseconds are fixture delays, not measured production latency',
    configuredDelays: {engineMs, transportMs, publicationMs, opponentWaitMs},
    calls, publicationCount: publications.length, errors: publications.filter(item => item.payload.error).map(item => item.id),
    output: output.join(''), analysis: analyzeEvents(traceEvents), traceEvents,
    limitation: 'The operator and trace instrumentation execute locally. MCP replies, transport, publication and opponent delay are synthetic; this provides no low-versus-original model result or battle acceptance evidence.'};
}
