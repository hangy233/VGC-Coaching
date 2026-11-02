import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeEvents, parseTrace, summarize, unionDuration} from './analyze.mjs';

function trace() {
  const events = []; let sequence = 0;
  const event = (name, time, extra = {}) => events.push({schemaVersion: 1, traceId: 'trace-1', processInstanceId: 'process-1',
    clockDomain: 'clock-1', component: 'fixture', sequence: ++sequence, event: 'event', name, epochMs: 1000 + time, monotonicMs: time, ...extra});
  const span = (name, start, end, extra = {}) => {
    const spanId = `span-${sequence}`;
    event(name, start, {event: 'span.start', spanId, ...extra});
    event(name, end, {event: 'span.end', spanId, durationMs: end - start, status: 'ok', ...extra});
  };
  return {events, event, span};
}

test('quantiles retain zero, omit unknown and use nearest-rank p95', () => {
  assert.deepEqual(summarize([0, 5, 10, undefined, null, NaN]), {n: 3, medianMs: 5, p95Ms: 10, maxMs: 10});
  assert.deepEqual(summarize([]), {n: 0, medianMs: null, p95Ms: null, maxMs: null});
  assert.equal(summarize([0, 10]).medianMs, 5);
  assert.equal(unionDuration([[0, 10], [3, 5], [5, 15], [20, 22]]), 17);
});

test('isolated decisions and calculator names do not imply late observations',()=>{
  const t=trace();
  t.event('isolated.decision.received',1,{status:'ok'});
  t.span('isolated.decision',2,3,{status:'ok'});
  t.span('calculate_damage',4,5,{status:'completed'});
  t.event('isolated.calculate_speed.completed',6,{outcome:'returned'});
  assert.deepEqual({...analyzeEvents(t.events).exceptions},{});
  t.event('isolated.decision.completed',7,{status:'late'});
  t.event('operator.mcp_late_settlement',8,{status:'late'});
  const report=analyzeEvents(t.events);
  assert.equal(report.exceptions.late,1);
  assert.equal(report.exceptions.lateSettlement,1);
  assert.equal(report.exceptions.timeoutOrAbort,undefined);
});

test('per-process union never sums nested, overlapping or separate-clock work', () => {
  const t = trace();
  t.span('operator.command', 0, 100);
  t.span('operator.execute', 5, 90);
  t.span('operator.mcp_call', 10, 30, {tool: 'simulate_turn'});
  t.span('operator.post_send_wait', 60, 95);
  t.span('simulation.native_engine', 500, 800, {processInstanceId: 'worker', clockDomain: 'worker-clock', tool: 'simulate_turn'});
  const report = analyzeEvents(t.events);
  const parent = report.domains.find(item => item.processInstanceId === 'process-1');
  assert.equal(parent.observedSpanUnionMs, 100);
  assert.equal(parent.observedActiveUnionMs, 65);
  assert.equal(parent.afterSendOrOpponentWaitUnionMs, 35);
  assert.equal(report.domains.find(item => item.processInstanceId === 'worker').observedSpanUnionMs, 300);
  assert.equal(report.metrics.afterSendWait.medianMs, 35);
  assert.equal(report.metrics.modelDelivery.n, 0);
  assert.match(report.unknown.join(' '), /Model delivery/);
});

test('queue span is one sample; per-tool operator RTT and server engine stay distinct', () => {
  const t = trace();
  t.event('operator.input_received', 0, {commandId: 'q1'});
  t.span('operator.queue', 0, 7, {commandId: 'q1'});
  t.event('operator.command_started', 7, {commandId: 'q1'});
  t.span('operator.mcp_call', 7, 37, {tool: 'calculate_damage'});
  t.span('mcp.tool', 10, 30, {tool: 'calculate_damage', processInstanceId: 'server', clockDomain: 'server-clock'});
  t.span('calculator.engine', 12, 24, {tool: 'calculate_damage', processInstanceId: 'server', clockDomain: 'server-clock'});
  t.span('operator.publish', 38, 43);
  const report = analyzeEvents(t.events);
  assert.deepEqual(report.metrics.queue, {n: 1, medianMs: 7, p95Ms: 7, maxMs: 7});
  assert.equal(report.perTool.calculate_damage.operatorElapsed.medianMs, 30);
  assert.equal(report.perTool.calculate_damage.serverElapsed.medianMs, 20);
  assert.equal(report.perTool.calculate_damage.engine.medianMs, 12);
  assert.equal(report.metrics.responsePublication.medianMs, 5);
});

test('authored boundaries pair across command traces by request key and require authored source', () => {
  const t = trace();
  t.event('request.observed', 10, {requestKey: 'request-1', requestReceivedAt: 990});
  t.event('authored.stage', 15, {requestKey: 'request-1', source: 'watchdog'});
  t.event('authored.stage', 25, {requestKey: 'request-1', source: 'authored', traceId: 'another-command'});
  t.event('authored.send', 30, {requestKey: 'request-1', source: 'authored', traceId: 'another-command', cutoffAt: 1029});
  const report = analyzeEvents(t.events);
  assert.equal(report.metrics.observedRequestToFirstAuthoredStage.medianMs, 15);
  assert.equal(report.metrics.observedRequestToFirstAuthoredSend.medianMs, 20);
  assert.equal(report.metrics.requestToFirstAuthoredSend.n, 0);
  assert.equal(report.requests[0].crossProcessEpochEstimateToFirstAuthoredSendMs, 40);
  assert.match(report.requests[0].epochEstimateLimitation, /not a same-clock/);
  assert.equal(report.deadlines.missed, 1);
});

test('request receipt latency is unknown across clocks even when epoch values align', () => {
  const t = trace();
  t.event('request.received', 1, {requestKey: 'request-1', processInstanceId: 'server', clockDomain: 'server'});
  t.event('authored.send', 4, {requestKey: 'request-1', source: 'authored'});
  assert.equal(analyzeEvents(t.events).metrics.requestToFirstAuthoredSend.n, 0);
  t.event('request.received', 2, {requestKey: 'request-1'});
  assert.equal(analyzeEvents(t.events).metrics.requestToFirstAuthoredSend.medianMs, 2);
});

test('partial spans, malformed lines, refusals and late settlements stay explicit', () => {
  const t = trace();
  t.event('operator.mcp_call', 0, {event: 'span.start', spanId: 'unfinished'});
  t.event('tool', 1, {event: 'span.end', spanId: 'missing-start', durationMs: 1});
  t.event('operator.mcp_late_settlement', 2, {status: 'late', observationOwnership: false});
  t.event('tool.refused', 3, {status: 'refused'});
  t.event('server.default', 4, {outcomeCertainty: 'server-defaulted'});
  t.events.push({secret: 'not-a-timing-event'});
  const parsed = parseTrace(`${t.events.map(item => JSON.stringify(item)).join('\n')}\nnot json\n`);
  const report = analyzeEvents(parsed.events);
  assert.equal(parsed.errors.length, 1);
  assert.equal(report.diagnostics.unfinishedSpans, 1);
  assert.equal(report.diagnostics.orphanEnds, 1);
  assert.equal(report.diagnostics.invalidEvents, 1);
  assert.equal(report.exceptions.lateSettlement, 1);
  assert.equal(report.exceptions.refusal, 1);
  assert.equal(report.exceptions.serverDefault, 1);
  assert.equal(report.metrics.toolElapsed.n, 0);
  assert.equal(JSON.stringify(report).includes('not-a-timing-event'), false);
});

test('queue, reader and battle polling waits are excluded without calling the remainder CPU time', () => {
  const t = trace();
  t.span('operator.command', 0, 100);
  t.span('operator.queue', 0, 10);
  t.span('response.wait', 10, 30);
  t.span('operator.mcp_call', 20, 40, {tool: 'battle_wait'});
  t.span('operator.post_send_wait', 60, 100);
  const domain = analyzeEvents(t.events).domains[0];
  assert.equal(domain.knownWaitUnionMs, 80);
  assert.equal(domain.observedNonWaitUnionMs, 20);
  assert.equal(domain.afterSendOrOpponentWaitUnionMs, 40);
  assert.match(domain.limitation, /not CPU time or model thinking/);
});

test('named defaults and inactivity, cancelled spans and late spans remain distinct observations', () => {
  const t = trace();
  t.event('control.server_default', 1);
  t.event('watchdog.generated_default', 2);
  t.event('server.inactivity', 3);
  t.span('tool', 4, 5, {status: 'cancelled'});
  t.span('tool', 6, 7, {status: 'late'});
  const report = analyzeEvents(t.events);
  assert.equal(report.exceptions.serverDefault, 1);
  assert.equal(report.exceptions.generatedDefault, 1);
  assert.equal(report.exceptions.inactivity, 1);
  assert.equal(report.exceptions.cancelled, 1);
  assert.equal(report.exceptions.late, 1);
  assert.equal(report.exceptions.timeoutOrAbort, undefined);
});
