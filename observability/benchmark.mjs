import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {analyzeEvents, summarize} from './analyze.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_.:-]{1,100}$/;
const OUTCOMES = new Set(['completed', 'timeout', 'refusal', 'error', 'not-run']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => typeof value === 'string' && ID.test(value);
const epoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const allowed = (value, keys, label) => {
  assert(plain(value), `${label} must be an object`);
  assert(Object.keys(value).every(key => keys.includes(key)), `${label} contains unsupported fields (future outcomes and hindsight are not accepted)`);
};
function rng(seed) {
  let state = Number.parseInt(sha256(String(seed)).slice(0, 8), 16);
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function shuffle(values, random) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function stamped(value, cutoffAt, label) {
  allowed(value, ['observedAt', 'value'], label);
  assert(epoch(value.observedAt) && value.observedAt <= cutoffAt, `${label} is missing its timestamp or exceeds the fixed decision cutoff`);
  assert(Object.hasOwn(value, 'value'), `${label}.value is required`);
}

/** Dataset inputs are explicitly supplied private files. No live/latest evidence lookup. */
export function validateDataset(dataset) {
  allowed(dataset, ['schemaVersion', 'id', 'positions'], 'dataset');
  assert(dataset.schemaVersion === 1 && id(dataset.id), 'dataset schemaVersion/id is invalid');
  assert(Array.isArray(dataset.positions) && dataset.positions.length > 0, 'dataset.positions must not be empty');
  const seen = new Set();
  for (const position of dataset.positions) {
    allowed(position, ['id', 'cutoffAt', 'provenance', 'contexts'], 'position');
    assert(id(position.id) && !seen.has(position.id), 'position ids must be unique'); seen.add(position.id);
    assert(epoch(position.cutoffAt), 'position.cutoffAt must be a fixed epoch timestamp');
    allowed(position.provenance, ['sourceId', 'savedAt', 'cutoffAttested'], 'position.provenance');
    assert(id(position.provenance.sourceId) && epoch(position.provenance.savedAt) &&
      position.provenance.savedAt <= position.cutoffAt && position.provenance.cutoffAttested === true,
    'position provenance must attest the saved decision-time snapshot before the cutoff');
    allowed(position.contexts, ['fresh', 'long'], 'position.contexts');
    for (const mode of ['fresh', 'long']) {
      const context = position.contexts[mode];
      allowed(context, ['position', 'history', 'openSheets'], `context.${mode}`);
      stamped(context.position, position.cutoffAt, `${mode}.position`);
      stamped(context.openSheets, position.cutoffAt, `${mode}.openSheets`);
      assert(Array.isArray(context.history), `${mode}.history must be an array`);
      context.history.forEach((entry, i) => stamped(entry, position.cutoffAt, `${mode}.history[${i}]`));
    }
    assert(sha256(position.contexts.fresh.position) === sha256(position.contexts.long.position) &&
      sha256(position.contexts.fresh.openSheets) === sha256(position.contexts.long.openSheets),
    'fresh and long contexts must share the exact same position and open sheets');
    assert(position.contexts.long.history.length >= position.contexts.fresh.history.length,
      'long history must contain at least the fresh history');
    const suffix = position.contexts.long.history.slice(-position.contexts.fresh.history.length);
    assert(!position.contexts.fresh.history.length || sha256(suffix) === sha256(position.contexts.fresh.history),
      'fresh history must be a suffix of the fixed long history');
  }
  return dataset;
}

export function createPlan({dataset, guidance, conditions, seed = 'paired-v1', repeats = 2, trialTimeoutMs = 30000}) {
  validateDataset(dataset);
  allowed(guidance, ['id', 'sha256'], 'guidance');
  assert(id(guidance.id) && HASH.test(guidance.sha256), 'fixed guidance id and SHA-256 are required');
  assert(Array.isArray(conditions) && conditions.length === 2, 'exactly two conditions are required');
  assert(new Set(conditions.map(item => item.id)).size === 2, 'condition ids must differ');
  for (const condition of conditions) {
    allowed(condition, ['id', 'modelId', 'reasoningEffort', 'promptSha256', 'toolConfigSha256'], 'condition');
    assert(id(condition.id) && HASH.test(condition.promptSha256) && HASH.test(condition.toolConfigSha256),
      'condition id and fixed prompt/tool configuration hashes are required');
    assert(condition.modelId === null || typeof condition.modelId === 'string' && condition.modelId.length > 0, 'modelId must be supplied or explicitly null (unknown)');
    assert(condition.reasoningEffort === null || typeof condition.reasoningEffort === 'string', 'reasoningEffort must be supplied or explicitly null (unknown)');
  }
  assert(conditions[0].promptSha256 === conditions[1].promptSha256 && conditions[0].toolConfigSha256 === conditions[1].toolConfigSha256,
    'paired reasoning comparisons require identical prompt and tool configuration hashes');
  assert(conditions[0].modelId === null || conditions[1].modelId === null || conditions[0].modelId === conditions[1].modelId,
    'paired reasoning comparisons must keep the model fixed');
  assert(Number.isSafeInteger(repeats) && repeats >= 2 && repeats <= 1000 && repeats % 2 === 0,
    'repeats must be even (2..1000) for exact AB/BA counterbalance');
  assert(Number.isSafeInteger(trialTimeoutMs) && trialTimeoutMs > 0 && trialTimeoutMs <= 3600000, 'trialTimeoutMs must be 1..3600000');
  const random = rng(seed), pairs = [];
  for (const position of dataset.positions) for (const contextMode of ['fresh', 'long']) {
    const first = random() < .5 ? 0 : 1;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const pairId = sha256({seed, position: position.id, contextMode, repeat}).slice(0, 24);
      const order = (repeat + first) % 2 ? [...conditions].reverse() : conditions;
      pairs.push(order.map((condition, index) => ({trialId: sha256({pairId, condition: condition.id}).slice(0, 24),
        pairId, positionId: position.id, contextMode, repeat, conditionId: condition.id, orderInPair: index + 1,
        inputSha256: sha256(position.contexts[contextMode]), cutoffAt: position.cutoffAt})));
    }
  }
  const plan = {schemaVersion: 1, kind: 'paired-decision-benchmark-plan', seed: String(seed), repeats, trialTimeoutMs,
    dataset: {id: dataset.id, sha256: sha256(dataset)}, guidance: clone(guidance), conditions: clone(conditions),
    trials: shuffle(pairs, random).flat().map((trial, index) => ({...trial, sequence: index + 1})),
    protocol: {unit: 'same saved position, context, repeat and fixed cutoff paired across conditions',
      contextIsolation: 'Fresh independent adapter invocation per trial; no previous outputs or future evidence are passed.',
      order: 'Seeded randomized pair order; exactly counterbalanced AB/BA within every position/context.',
      quality: 'External condition-blind review with a fixed rubric; no winner or future turns supplied.',
      limitation: 'A plan is not evidence that any model comparison ran. Unknown model metadata stays unknown.'}};
  return {...plan, planSha256: sha256(plan)};
}

export function validatePlan(plan) {
  assert(plan?.schemaVersion === 1 && plan.kind === 'paired-decision-benchmark-plan' && HASH.test(plan.planSha256), 'invalid benchmark plan');
  const {planSha256, ...content} = plan;
  assert(sha256(content) === planSha256, 'plan hash mismatch');
  assert(Array.isArray(plan.trials) && plan.trials.length > 0 && Array.isArray(plan.conditions) && plan.conditions.length === 2, 'plan is incomplete');
  assert(new Set(plan.trials.map(item => item.trialId)).size === plan.trials.length, 'duplicate plan trials');
  assert(Number.isSafeInteger(plan.repeats) && plan.repeats >= 2 && plan.repeats % 2 === 0 &&
    Number.isSafeInteger(plan.trialTimeoutMs) && plan.trialTimeoutMs > 0 && plan.trialTimeoutMs <= 3600000, 'invalid plan repetitions/deadline');
  assert(id(plan.dataset?.id) && HASH.test(plan.dataset?.sha256) && id(plan.guidance?.id) && HASH.test(plan.guidance?.sha256), 'invalid fixed dataset/guidance identifiers');
  const ids = plan.conditions.map(item => item.id);
  assert(ids.every(id) && new Set(ids).size === 2, 'invalid condition identities');
  const pairs = new Map(), counterbalance = new Map();
  for (const [index, trial] of plan.trials.entries()) {
    assert(trial.sequence === index + 1 && ids.includes(trial.conditionId) && ['fresh', 'long'].includes(trial.contextMode) &&
      id(trial.positionId) && id(trial.pairId) && HASH.test(trial.inputSha256) && epoch(trial.cutoffAt) &&
      Number.isSafeInteger(trial.repeat) && trial.repeat >= 0 && trial.repeat < plan.repeats && [1, 2].includes(trial.orderInPair), 'invalid planned trial');
    if (!pairs.has(trial.pairId)) pairs.set(trial.pairId, []);
    pairs.get(trial.pairId).push(trial);
  }
  for (const pair of pairs.values()) {
    const [left, right] = pair;
    assert(pair.length === 2 && left.conditionId !== right.conditionId && left.orderInPair === 1 && right.orderInPair === 2 &&
      right.sequence === left.sequence + 1 && ['positionId', 'contextMode', 'repeat', 'inputSha256', 'cutoffAt'].every(key => left[key] === right[key]), 'paired trials must share frozen inputs and adjacent counterbalanced order');
    const key = `${left.positionId}:${left.contextMode}`;
    if (!counterbalance.has(key)) counterbalance.set(key, []);
    counterbalance.get(key).push(left);
  }
  for (const group of counterbalance.values()) assert(group.length === plan.repeats && new Set(group.map(item => item.repeat)).size === plan.repeats &&
    group.filter(item => item.conditionId === ids[0]).length === plan.repeats / 2, 'plan lacks exact repeated AB/BA counterbalance');
  return plan;
}

function inputFor(plan, dataset, trial) {
  validateDataset(dataset);
  assert(sha256(dataset) === plan.dataset.sha256, 'dataset hash does not match the frozen plan');
  const position = dataset.positions.find(item => item.id === trial.positionId);
  const input = position?.contexts[trial.contextMode];
  assert(input && sha256(input) === trial.inputSha256 && position.cutoffAt === trial.cutoffAt, 'trial input/cutoff mismatch');
  return clone(input);
}

/** Explicit dependency injection only. This module provides no model/API loader.
 * Adapters must create independent contexts and honor AbortSignal. An unresolved
 * timeout halts later trials so unknown carry-over cannot contaminate the pair.
 */
export async function runBenchmark({plan, dataset, adapter, settleGraceMs = 0, onLateSettlement}) {
  validatePlan(plan); validateDataset(dataset);
  assert(typeof adapter === 'function', 'an explicit adapter function is required');
  assert(Number.isSafeInteger(settleGraceMs) && settleGraceMs >= 0 && settleGraceMs <= 1000, 'settleGraceMs must be 0..1000');
  assert(onLateSettlement === undefined || typeof onLateSettlement === 'function', 'onLateSettlement must be a callback');
  const results = [], settlements = [];
  let halted = false;
  for (const trial of plan.trials) {
    if (halted) { results.push({trialId: trial.trialId, planSha256: plan.planSha256, outcome: 'not-run', model: null,
      provenance: {source: 'injected-adapter', timingBasis: 'not-observed', contextIsolation: 'not-run', inputSha256: trial.inputSha256,
        guidanceSha256: plan.guidance.sha256, cutoffAt: trial.cutoffAt,
        promptSha256: plan.conditions.find(item => item.id === trial.conditionId).promptSha256,
        toolConfigSha256: plan.conditions.find(item => item.id === trial.conditionId).toolConfigSha256}, timing: null, output: null}); continue; }
    const controller = new AbortController(), startedEpochMs = Date.now(), started = performance.now();
    let timer, timedOut = false, settled = false;
    const invocation = Promise.resolve().then(() => adapter({trial: clone(trial), condition: clone(plan.conditions.find(item => item.id === trial.conditionId)),
      guidance: clone(plan.guidance), input: inputFor(plan, dataset, trial), signal: controller.signal}));
    const recordLate = status => {
      const settlement = {trialId: trial.trialId, outcome: 'late-settle', status, elapsedMs: performance.now() - started};
      settlements.push(settlement);
      if (onLateSettlement) { try { onLateSettlement(clone(settlement)); } catch {} }
    };
    const observed = invocation.then(value => { settled = true;
      if (timedOut) recordLate(value?.outcome ?? 'completed'); return {value};
    }, error => { settled = true;
      if (timedOut) recordLate('error');
      return {error: String(error?.message ?? error)}; });
    const timeout = new Promise(resolveTimeout => { timer = setTimeout(() => {
      timedOut = true; controller.abort(); resolveTimeout({timeout: true});
    }, plan.trialTimeoutMs); });
    const answer = await Promise.race([observed, timeout]); clearTimeout(timer);
    const elapsedMs = performance.now() - started;
    const value = answer.value;
    const rejected = Object.hasOwn(answer, 'error');
    const outcome = answer.timeout ? 'timeout' : rejected ? 'error' : value?.outcome ?? 'completed';
    assert(OUTCOMES.has(outcome) && outcome !== 'not-run', 'adapter returned an invalid outcome');
    const model = plain(value?.model) ? clone(value.model) : null;
    results.push({trialId: trial.trialId, planSha256: plan.planSha256, outcome, model,
      provenance: {source: 'injected-adapter', timingBasis: 'local-monotonic-wrapper',
        contextIsolation: value?.contextIsolation === 'fresh-independent' ? 'adapter-attested' : 'unknown', startedEpochMs, finishedEpochMs: Date.now(),
        inputSha256: trial.inputSha256, guidanceSha256: plan.guidance.sha256, cutoffAt: trial.cutoffAt,
        promptSha256: plan.conditions.find(item => item.id === trial.conditionId).promptSha256,
        toolConfigSha256: plan.conditions.find(item => item.id === trial.conditionId).toolConfigSha256},
      timing: {elapsedMs, ...(finite(value?.timing?.firstAuthoredStageMs) ? {firstAuthoredStageMs: value.timing.firstAuthoredStageMs} : {}),
        ...(finite(value?.timing?.firstAuthoredSendMs) ? {firstAuthoredSendMs: value.timing.firstAuthoredSendMs} : {})},
      output: value?.output ?? null, ...(rejected ? {error: answer.error} : {}), ...(Array.isArray(value?.traceEvents) ? {traceEvents: value.traceEvents} : {})});
    if (answer.timeout) {
      if (settleGraceMs && !settled) {
        let grace;
        await Promise.race([observed, new Promise(done => { grace = setTimeout(done, settleGraceMs); })]); clearTimeout(grace);
      }
      halted = !settled;
    }
  }
  return {schemaVersion: 1, kind: 'paired-decision-benchmark-results', planSha256: plan.planSha256,
    results, settlements: clone(settlements), halted,
    lateSettlementObservation: halted ? 'unresolved-at-return; optional callback may persist later settlement' : 'settled-or-no-timeouts',
    limitation: 'Adapter claims are recorded provenance, not proof of a model provider call or independent context. Wrapper hashes identify supplied inputs/configuration; actual adapter use requires audit.'};
}

/** Validate imported actual runs. This does not manufacture missing metadata. */
export function validateResults(plan, resultFile) {
  validatePlan(plan);
  assert(resultFile?.schemaVersion === 1 && resultFile.kind === 'paired-decision-benchmark-results' &&
    resultFile.planSha256 === plan.planSha256 && Array.isArray(resultFile.results), 'results do not identify the frozen plan');
  const trials = new Map(plan.trials.map(item => [item.trialId, item])), seen = new Set();
  for (const result of resultFile.results) {
    assert(trials.has(result.trialId) && !seen.has(result.trialId), 'unknown or duplicate result trial'); seen.add(result.trialId);
    assert(result.planSha256 === plan.planSha256 && OUTCOMES.has(result.outcome), 'invalid result plan/outcome');
    assert(plain(result.provenance) && typeof result.provenance.source === 'string' &&
      typeof result.provenance.timingBasis === 'string', 'actual result provenance and timing basis are required');
    const trial = trials.get(result.trialId), condition = plan.conditions.find(item => item.id === trial.conditionId);
    assert(result.provenance.inputSha256 === trial.inputSha256 && result.provenance.guidanceSha256 === plan.guidance.sha256 &&
      result.provenance.cutoffAt === trial.cutoffAt && result.provenance.promptSha256 === condition.promptSha256 &&
      result.provenance.toolConfigSha256 === condition.toolConfigSha256, 'result input/guidance/prompt/tool/cutoff provenance does not match the frozen trial');
    assert(result.model === null || plain(result.model), 'missing model metadata must be explicit null');
    if (result.timing !== null) {
      assert(plain(result.timing) && finite(result.timing.elapsedMs) && result.timing.elapsedMs >= 0, 'elapsedMs must be actual nonnegative timing or timing must be null');
      for (const key of ['firstAuthoredStageMs', 'firstAuthoredSendMs']) if (Object.hasOwn(result.timing, key)) {
        assert(finite(result.timing[key]) && result.timing[key] >= 0 && result.timing[key] <= result.timing.elapsedMs,
          `${key} must be observed within the run, not inferred from completion`);
      }
    }
    if (result.outcome === 'not-run') assert(result.timing === null, 'not-run trials have no measured latency');
    if (result.traceEvents !== undefined) assert(Array.isArray(result.traceEvents), 'traceEvents must be an array');
  }
  for (const settlement of resultFile.settlements ?? []) {
    assert(seen.has(settlement.trialId) && settlement.outcome === 'late-settle' && finite(settlement.elapsedMs) && settlement.elapsedMs >= 0,
      'invalid late settlement');
    assert(resultFile.results.find(item => item.trialId === settlement.trialId).outcome === 'timeout', 'late settlement must retain its original timeout');
  }
  return resultFile;
}

/** Review packets omit condition/model/timing/order and preserve only cutoff inputs. */
export function buildBlindPackets(plan, dataset, resultFile) {
  validateResults(plan, resultFile);
  const packets = resultFile.results.filter(item => item.outcome === 'completed').map(result => {
    const trial = plan.trials.find(item => item.trialId === result.trialId);
    return {evaluationId: sha256({plan: plan.planSha256, trial: result.trialId, purpose: 'blind-review'}),
      cutoffAt: trial.cutoffAt, input: inputFor(plan, dataset, trial), output: result.output};
  });
  return {schemaVersion: 1, kind: 'blind-decision-review-packets', packets: shuffle(packets, rng(`${plan.seed}:blind`)),
    instruction: 'Judge only supplied decision-time evidence using one fixed rubric. Do not consult plan conditions, timing, future turns, results, or replays.'};
}

function validateEvaluations(plan, evaluations) {
  if (!evaluations) return new Map();
  assert(evaluations.schemaVersion === 1 && HASH.test(evaluations.rubricSha256) &&
    typeof evaluations.judgeId === 'string' && evaluations.blind === true && Array.isArray(evaluations.scores),
  'blind evaluation needs a fixed rubric hash, judge id, blind attestation and scores');
  const ids = new Map(plan.trials.map(trial => [sha256({plan: plan.planSha256, trial: trial.trialId, purpose: 'blind-review'}), trial.trialId]));
  const scores = new Map();
  for (const evaluation of evaluations.scores) {
    allowed(evaluation, ['evaluationId', 'score', 'flags'], 'blind score');
    const trialId = ids.get(evaluation.evaluationId);
    assert(trialId && !scores.has(trialId) && finite(evaluation.score) && evaluation.score >= 0 && evaluation.score <= 1,
      'blind scores must be unique known evaluation ids with score 0..1');
    assert(evaluation.flags === undefined || Array.isArray(evaluation.flags) && evaluation.flags.every(flag => typeof flag === 'string'), 'invalid evaluation flags');
    scores.set(trialId, evaluation.score);
  }
  return scores;
}

export function reportBenchmark(plan, resultFile, evaluations) {
  validateResults(plan, resultFile);
  const scores = validateEvaluations(plan, evaluations), resultMap = new Map(resultFile.results.map(item => [item.trialId, item]));
  for (const trialId of scores.keys()) assert(resultMap.get(trialId)?.outcome === 'completed', 'quality score refers to a missing or incomplete decision');
  const groups = [];
  for (const contextMode of ['fresh', 'long']) {
    const conditions = Object.create(null);
    for (const condition of plan.conditions) {
      const planned = plan.trials.filter(item => item.contextMode === contextMode && item.conditionId === condition.id);
      const results = planned.map(item => resultMap.get(item.trialId)).filter(Boolean);
      const counts = {missing: planned.length - results.length};
      for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      const modelUnknown = results.filter(item => !item.model?.modelId || !item.model?.reasoningEffort).length;
      const modelMismatches = results.filter(item => item.model?.modelId && condition.modelId && item.model.modelId !== condition.modelId ||
        item.model?.reasoningEffort && condition.reasoningEffort && item.model.reasoningEffort !== condition.reasoningEffort).length;
      const completed = results.filter(item => item.outcome === 'completed');
      conditions[condition.id] = {planned: planned.length, outcomes: counts, modelUnknown, modelMismatches,
        completedElapsed: summarize(completed.map(item => item.timing?.elapsedMs)),
        allObservedElapsed: summarize(results.map(item => item.timing?.elapsedMs)),
        firstAuthoredStage: summarize(completed.map(item => item.timing?.firstAuthoredStageMs)),
        firstAuthoredSend: summarize(completed.map(item => item.timing?.firstAuthoredSendMs)),
        quality: {n: completed.filter(item => scores.has(item.trialId)).length,
          meanScore: completed.some(item => scores.has(item.trialId)) ? completed.filter(item => scores.has(item.trialId)).reduce((sum, item) => sum + scores.get(item.trialId), 0) /
            completed.filter(item => scores.has(item.trialId)).length : null},
        lateSettlements: (resultFile.settlements ?? []).filter(item => planned.some(trial => trial.trialId === item.trialId)).length};
    }
    const pairIds = [...new Set(plan.trials.filter(item => item.contextMode === contextMode).map(item => item.pairId))];
    const elapsedDeltas = [], sendDeltas = [], qualityDeltas = [];
    let eligibleModelPairs = 0;
    for (const pairId of pairIds) {
      const [left, right] = plan.conditions.map(condition => resultMap.get(plan.trials.find(item => item.pairId === pairId && item.conditionId === condition.id)?.trialId));
      if (left?.outcome !== 'completed' || right?.outcome !== 'completed') continue;
      const modelKnown = [left, right].every((result, i) => result.model?.modelId && result.model?.reasoningEffort &&
        result.provenance.contextIsolation === 'adapter-attested' && result.model.modelId === plan.conditions[i].modelId &&
        result.model.reasoningEffort === plan.conditions[i].reasoningEffort);
      if (modelKnown) eligibleModelPairs++;
      // Descriptive observed pairs remain visible even when model identity is
      // unknown; they must not be described as a verified model comparison.
      if (finite(left.timing?.elapsedMs) && finite(right.timing?.elapsedMs)) elapsedDeltas.push(right.timing.elapsedMs - left.timing.elapsedMs);
      if (finite(left.timing?.firstAuthoredSendMs) && finite(right.timing?.firstAuthoredSendMs)) sendDeltas.push(right.timing.firstAuthoredSendMs - left.timing.firstAuthoredSendMs);
      if (scores.has(left.trialId) && scores.has(right.trialId)) qualityDeltas.push(scores.get(right.trialId) - scores.get(left.trialId));
    }
    groups.push({contextMode, conditions, paired: {plannedPairs: pairIds.length, eligibleModelPairs,
      deltaDirection: `${plan.conditions[1].id} minus ${plan.conditions[0].id}`,
      completedElapsedDelta: summarize(elapsedDeltas), firstAuthoredSendDelta: summarize(sendDeltas),
      qualityDelta: {n: qualityDeltas.length, meanScoreDelta: qualityDeltas.length ? qualityDeltas.reduce((a, b) => a + b, 0) / qualityDeltas.length : null}}});
  }
  return {schemaVersion: 1, kind: 'paired-decision-benchmark-report', planSha256: plan.planSha256,
    dataset: plan.dataset, guidance: plan.guidance, groups,
    traces: analyzeEvents(resultFile.results.flatMap(item => item.traceEvents ?? [])),
    limitations: ['Fresh and long contexts are reported separately. Repeats of a position are dependent observations; these are descriptive statistics, not significance tests.',
      'Timeouts, refusals, errors, missing runs and late settlements are retained separately; completion latency alone cannot establish tactical quality.',
      'Unknown provider/model/reasoning metadata is unknown. Provenance and blind/context isolation attestations are claims requiring external audit.',
      'No model run is implied by generating a plan or running the synthetic workflow fixture.']};
}

const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'plan' && args.length === 2) {
    const spec = readJSON(args[0]); const dataset = readJSON(resolve(args[0], '..', spec.datasetFile));
    const {datasetFile, ...options} = spec; writeFileSync(args[1], `${JSON.stringify(createPlan({...options, dataset}), null, 2)}\n`); return;
  }
  if (command === 'report' && [2, 3].includes(args.length)) {
    console.log(JSON.stringify(reportBenchmark(readJSON(args[0]), readJSON(args[1]), args[2] ? readJSON(args[2]) : undefined), null, 2)); return;
  }
  if (command === 'blind' && args.length === 4) {
    writeFileSync(args[3], `${JSON.stringify(buildBlindPackets(readJSON(args[0]), readJSON(args[1]), readJSON(args[2])), null, 2)}\n`); return;
  }
  if (command === 'fixture') {
    const {runWorkflowFixture} = await import('./fixtures/workflow.mjs');
    assert(args.length <= 1, 'fixture accepts at most one output trace path');
    const {traceEvents, ...summary} = await runWorkflowFixture();
    if (args[0]) writeFileSync(args[0], traceEvents.map(event => JSON.stringify(event)).join('\n') + '\n');
    console.log(JSON.stringify(summary, null, 2)); return;
  }
  fail('Usage: node observability/benchmark.mjs plan SPEC.json PLAN.json | report PLAN.json RESULTS.json [BLIND-SCORES.json] | blind PLAN.json DATASET.json RESULTS.json PACKETS.json | fixture [TRACE.jsonl]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 2;
});
