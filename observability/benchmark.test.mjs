import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlan, validatePlan, validateDataset, runBenchmark, validateResults, buildBlindPackets, reportBenchmark, sha256} from './benchmark.mjs';
import {runWorkflowFixture} from './fixtures/workflow.mjs';

const copy = value => structuredClone(value);
function fixture() {
  const position = {observedAt: 100, value: {turn: 2, legalActions: ['fixture-pair-a', 'fixture-pair-b']}};
  const openSheets = {observedAt: 90, value: {p1: 'complete-synthetic-sheet', p2: 'complete-synthetic-sheet'}};
  const recent = {observedAt: 95, value: {turn: 1, observation: 'synthetic-public-history'}};
  const dataset = {schemaVersion: 1, id: 'synthetic-cutoff-positions', positions: [{id: 'position-a', cutoffAt: 100,
    provenance: {sourceId: 'synthetic-only', savedAt: 100, cutoffAttested: true}, contexts: {
      fresh: {position, openSheets, history: [recent]},
      long: {position, openSheets, history: [{observedAt: 80, value: 'earlier-known-synthetic-history'}, recent]},
    }}]};
  const conditions = ['original', 'low'].map((id, index) => ({id, modelId: null, reasoningEffort: index ? 'low' : null,
    promptSha256: sha256('fixed prompt'), toolConfigSha256: sha256('fixed read-only tools')}));
  const options = {dataset, conditions, guidance: {id: 'fixed-guidance', sha256: sha256('fixed guidance')}, seed: 'reproducible-seed', repeats: 4};
  return {dataset, conditions, options, plan: createPlan(options)};
}
const adapter = async ({trial}) => ({output: {choice: 'synthetic-pair', evidenceCutoff: trial.cutoffAt}, contextIsolation: 'fresh-independent'});

test('plans freeze hashes/cutoffs, randomize pairs reproducibly and exactly counterbalance both context modes', () => {
  const {plan, options} = fixture();
  assert.deepEqual(plan, createPlan(options));
  assert.equal(plan.trials.length, 16);
  for (const contextMode of ['fresh', 'long']) {
    const first = plan.trials.filter(item => item.contextMode === contextMode && item.orderInPair === 1);
    assert.equal(first.filter(item => item.conditionId === 'original').length, 2);
    assert.equal(first.filter(item => item.conditionId === 'low').length, 2);
    for (const left of first) {
      const right = plan.trials[left.sequence];
      assert.equal(left.pairId, right.pairId);
      assert.equal(left.inputSha256, right.inputSha256);
      assert.equal(left.cutoffAt, right.cutoffAt);
      assert.notEqual(left.conditionId, right.conditionId);
    }
  }
  assert.equal(validatePlan(plan), plan);
  const changed = copy(plan); changed.trials[0].cutoffAt++;
  assert.throws(() => validatePlan(changed), /hash mismatch/);
  assert.throws(() => createPlan({...options, repeats: 3}), /even/);
  assert.throws(() => createPlan({...options, conditions: [options.conditions[0], {...options.conditions[1], toolConfigSha256: sha256('changed tools')}]}), /identical prompt and tool/);
  assert.throws(() => createPlan({...options, conditions: [{...options.conditions[0], modelId: 'model-a'}, {...options.conditions[1], modelId: 'model-b'}]}), /model fixed/);
});

test('empty adapter errors remain failed trials and never enter blind completed-decision packets', async () => {
  const {plan, dataset} = fixture();
  const result = await runBenchmark({plan, dataset, adapter: async () => { throw new Error(''); }});
  assert(result.results.every(trial => trial.outcome === 'error' && Object.hasOwn(trial, 'error')));
  assert.equal(buildBlindPackets(plan, dataset, result).packets.length, 0);
});

test('datasets reject future evidence, hindsight fields, changed sheets and absent cutoff attestation', () => {
  const {dataset} = fixture();
  for (const mutate of [
    data => { data.positions[0].contexts.long.history[0].observedAt = 101; },
    data => { data.positions[0].winner = 'future result'; },
    data => { data.positions[0].provenance.cutoffAttested = false; },
    data => { data.positions[0].contexts.long.openSheets = {observedAt: 90, value: 'changed'}; },
    data => { delete data.positions[0].provenance.sourceId; },
  ]) {
    const changed = copy(dataset); mutate(changed); assert.throws(() => validateDataset(changed));
  }
});

test('injected no-model run records actual wrapper time and unknown model metadata without claiming a comparison', async () => {
  const {plan, dataset} = fixture();
  const seen = [];
  const results = await runBenchmark({plan, dataset, adapter: async request => {
    seen.push(request.trial.trialId);
    assert.equal(request.input.position.value.turn, 2);
    assert.equal(Object.hasOwn(request, 'previousOutputs'), false);
    return adapter(request);
  }});
  assert.deepEqual(seen, plan.trials.map(item => item.trialId));
  assert.equal(validateResults(plan, results), results);
  assert.ok(results.results.every(item => item.model === null && item.timing.elapsedMs >= 0));
  const report = reportBenchmark(plan, results);
  assert.equal(report.groups.length, 2);
  assert.ok(report.groups.every(group => group.paired.eligibleModelPairs === 0 && group.paired.completedElapsedDelta.n === 4));
  assert.equal(report.groups[0].conditions.low.modelUnknown, 4);
  assert.equal(report.groups[0].conditions.low.firstAuthoredSend.n, 0);
  assert.equal(report.groups[0].conditions.low.quality.meanScore, null);
});

test('strict result ingest rejects duplicate trials, drifted provenance and invented authored-send timing', async () => {
  const {plan, dataset} = fixture();
  const results = await runBenchmark({plan, dataset, adapter});
  for (const mutate of [
    data => { data.results.push(copy(data.results[0])); },
    data => { data.results[0].provenance.inputSha256 = 'f'.repeat(64); },
    data => { data.results[0].timing.firstAuthoredSendMs = data.results[0].timing.elapsedMs + 1; },
    data => { delete data.results[0].model; },
    data => { data.settlements.push({trialId: data.results[0].trialId, outcome: 'late-settle', elapsedMs: 99}); },
  ]) { const changed = copy(results); mutate(changed); assert.throws(() => validateResults(plan, changed)); }
});

test('blind review omits identity/timing/order, accepts fixed-rubric scores and rejects unblinded scores', async () => {
  const {plan, dataset} = fixture();
  const results = await runBenchmark({plan, dataset, adapter});
  const blind = buildBlindPackets(plan, dataset, results);
  assert.equal(blind.packets.length, 16);
  for (const packet of blind.packets) {
    for (const key of ['conditionId', 'model', 'timing', 'orderInPair', 'trialId']) assert.equal(Object.hasOwn(packet, key), false);
    assert.equal(packet.cutoffAt, 100);
  }
  const evaluations = {schemaVersion: 1, rubricSha256: sha256('fixed blind rubric'), judgeId: 'independent-fixture-judge', blind: true,
    scores: blind.packets.map(item => ({evaluationId: item.evaluationId, score: .75, flags: []}))};
  const report = reportBenchmark(plan, results, evaluations);
  assert.equal(report.groups[0].paired.qualityDelta.n, 4);
  assert.equal(report.groups[0].paired.qualityDelta.meanScoreDelta, 0);
  assert.throws(() => reportBenchmark(plan, results, {...evaluations, blind: false}), /blind evaluation/);
});

test('timeouts retain late settlement separately, while unresolved work halts subsequent trials', async () => {
  const f = fixture();
  const plan = createPlan({...f.options, repeats: 2, trialTimeoutMs: 5});
  let calls = 0;
  const results = await runBenchmark({plan, dataset: f.dataset, adapter: async () => {
    calls++; await new Promise(done => setTimeout(done, 15)); return {output: 'late fixture'};
  }, settleGraceMs: 50});
  assert.equal(calls, plan.trials.length);
  assert.ok(results.results.every(item => item.outcome === 'timeout'));
  assert.equal(results.settlements.length, plan.trials.length);
  assert.ok(results.settlements.every(item => item.outcome === 'late-settle'));
  validateResults(plan, results);
  const halted = await runBenchmark({plan, dataset: f.dataset, adapter: () => new Promise(() => {})});
  assert.equal(halted.halted, true);
  assert.equal(halted.results[0].outcome, 'timeout');
  assert.ok(halted.results.slice(1).every(item => item.outcome === 'not-run' && item.timing === null));
  validateResults(plan, halted);
});

test('native offline workflow measures injected engine, queue, publication, stage/send and after-send wait independently', async () => {
  const run = await runWorkflowFixture();
  assert.equal(run.modelCalls, 0);
  assert.equal(run.networkConnections, 0);
  assert.deepEqual(run.errors, []);
  assert.equal(run.publicationCount, 6);
  assert.equal(run.analysis.metrics.queue.n, 6);
  assert.ok(run.analysis.metrics.queue.maxMs > 0);
  assert.equal(run.analysis.perTool.calculate_damage.engine.medianMs, 7);
  assert.equal(run.analysis.perTool.calculate_damage.operatorElapsed.medianMs, 12);
  assert.equal(run.analysis.perTool.calculate_damage.serverElapsed.medianMs, 7);
  assert.equal(run.analysis.metrics.responsePublication.medianMs, 11);
  assert.equal(run.analysis.metrics.afterSendWait.medianMs, 39);
  assert.equal(run.analysis.metrics.observedRequestToFirstAuthoredStage.n, 1);
  assert.equal(run.analysis.metrics.observedRequestToFirstAuthoredSend.n, 1);
  assert.equal(run.analysis.metrics.modelDelivery.n, 0);
  assert.equal(run.calls.filter(name => name === 'battle_choose').length, 1);
  const slowed = await runWorkflowFixture({engineMs: 47, publicationMs: 31});
  assert.equal(slowed.analysis.perTool.calculate_damage.engine.medianMs, 47);
  assert.equal(slowed.analysis.metrics.responsePublication.medianMs, 31);
  assert.equal(slowed.analysis.metrics.afterSendWait.medianMs, 39);
});
