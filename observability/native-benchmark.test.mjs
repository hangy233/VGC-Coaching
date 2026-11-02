import test from 'node:test';
import assert from 'node:assert/strict';
import {runNativeBenchmark} from './native-benchmark.mjs';

test('native benchmark exercises actual MCP tools and separates pre-worker refusal from completed simulation', async () => {
  const report = await runNativeBenchmark({repeats: 1});
  assert.equal(report.valid, true);
  assert.equal(report.modelUsed, false);
  assert.equal(report.battlesStarted, 0);
  assert.equal(report.samples.length, 4);
  assert.equal(report.samples.find(sample => sample.request === 'simulation-refusal').outcome, 'refused');
  assert.equal(report.analysis.metrics['span:simulation.worker_startup'].n, 1);
  assert.equal(report.analysis.perTool.simulate_turn.engine.n, 1);
  assert.equal(report.analysis.perTool.unknown, undefined);
  assert.equal(report.analysis.perTool.calculate_damage.operatorElapsed.n, 1);
  assert.equal(report.analysis.perTool.calculate_damage.serverElapsed.n, 1);
  assert.equal(report.analysis.diagnostics.invalidEvents, 0);
  assert.equal(report.analysis.diagnostics.unfinishedSpans, 0);
  assert.equal(report.byRequest.damage.subsequentCalls.n, 0);
});

test('unexpected tool failure remains visible and invalidates a native timing sample', async () => {
  let closed = false;
  const report = await runNativeBenchmark({repeats: 1, client: {
    callTool: async () => ({isError: true}), close: async () => { closed = true; },
  }});
  assert.equal(report.valid, false);
  assert.equal(report.outcomeMismatches.length, 3);
  assert.equal(closed, true);
});
