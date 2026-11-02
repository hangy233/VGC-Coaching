// Presentation only. The immutable native receipt is never rewritten, executed
// or interpreted as a policy. Unknown omitted shapes use the complete receipt.
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const ROOT = ['engine','hypotheses','samples','summary','limitations','source','submittedBranches','testedBranches','loadedManifest','calculationRef'];
const SAMPLE = ['branchId','seed','accepted','start','openingEvents','initializationEvents','stateCoverage','events','eventView','final','boundary','turnComplete','replacementRequest','replacementDecisions','unusedContinuations','pendingActions','pendingPhases','noPendingContinuation','stochastic','hpHypotheses','actionOutcomes','gate'];
const SNAPSHOT = ['turn','ended','winner','requestState','midTurn','sides','field'];
const SIDE = ['id','active','conditions','pokemon'];
const POKEMON = ['id','species','ability','item','hp','maxhp','status','boosts','fainted','active','canMegaEvo','pp','lifecycle','volatiles'];
const LIFECYCLE = ['activeTurns','activeMoveActions','protectCounter','choiceLock','lastMove','unburdenVolatile'];
const OUTCOME = ['id','authored','attemptedMove','denied','faintedBeforeAction','pendingAtBoundary','resolution'];
const RESOLUTION = ['id','kind','nativeMoveResult','entrantId','events','denials'];
const EVENT = ['index','type','actorId','targetId','sourceId','move','raw'];
const STAGES = ['atk','def','spa','spd','spe','accuracy','evasion'];
const COSMETIC = new Set(['','t:','debug','hint']);
// These native protocol kinds are recognized, not evaluated. Keep every other
// kind through a full fallback instead of assuming it is cosmetic or harmless.
const EVENT_TYPES = new Set([...COSMETIC,
  'gametype','player','gen','tier','rule','clearpoke','poke','teampreview','uhtml','uhtmlchange','teamsize','start',
  'move','cant','faint','switch','drag','detailschange','replace','swap','turn','upkeep','win','tie',
  '-mega','-primal','-burst','-terastallize','-formechange','-damage','-heal','-sethp','-supereffective','-resisted',
  '-fail','-miss','-immune','-block','-activate','-crit','-status','-curestatus','-cureteam','-start','-end',
  '-singleturn','-singlemove','-boost','-unboost','-setboost','-swapboost','-invertboost','-clearboost',
  '-clearallboost','-clearpositiveboost','-clearnegativeboost','-copyboost','-weather','-fieldstart','-fieldend',
  '-sidestart','-sideend','-item','-enditem','-ability','-endability','-prepare','-mustrecharge','-notarget',
  '-hitcount','-waiting','-combine','-center','-anim','-message','-ohko','-zpower','-zbroken','-nothing',
]);

export const isNativeSimulation = value => object(value) && value.engine?.gen === 0 &&
  value.engine?.format === 'gen9championsvgc2026regmc' && Array.isArray(value.samples);
export const isNativeSimulationBatch = value => object(value) && Array.isArray(value.cases) &&
  value.cases.length > 0 && value.cases.every(entry => object(entry) && isNativeSimulation(entry.result));
export const isSimulationDecisionView = value => object(value) &&
  value.decisionViewSimulation?.kind === 'native-simulation-outcome-cards-v1' &&
  value.decisionViewSimulation.fullResponseRetained === true && value.decisionViewSimulation.sampleOnly === true &&
  ['outcome-cards','full-fallback'].includes(value.decisionViewSimulation.mode) &&
  (/^[a-f0-9]{64}$/.test(value.decisionViewSimulation.nativeResultSha256 ?? '') ||
    value.decisionViewSimulation.mode === 'outcome-cards' && Array.isArray(value.cases) &&
    typeof value.decisionViewSimulation.commonFieldsApplyTo === 'string');

function eventIssue(event) {
  if (!keysOnly(event, EVENT)) return 'unknown or malformed event fields';
  if (!Number.isSafeInteger(event.index) || typeof event.type !== 'string' || typeof event.raw !== 'string') return 'malformed event';
  const parts = event.raw.split('|');
  if (parts[0] !== '' || (parts[1] ?? '') !== event.type ||
      Object.hasOwn(event, 'move') && (event.type !== 'move' || event.move !== parts[3])) return 'contradictory native event fields';
  return EVENT_TYPES.has(event.type) ? null : `unknown event type ${JSON.stringify(event.type)}`;
}
function eventsIssue(events) {
  if (!Array.isArray(events)) return 'malformed events';
  return events.map(eventIssue).find(Boolean) ?? null;
}
function snapshotIssue(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  if (!keysOnly(snapshot, SNAPSHOT) || !Array.isArray(snapshot.sides)) return 'unknown or malformed snapshot fields';
  const actorIds = new Set(), sideIds = new Set();
  for (const side of snapshot.sides) {
    if (!keysOnly(side, SIDE) || !Array.isArray(side.pokemon) || typeof side.id !== 'string' || sideIds.has(side.id)) return 'unknown, malformed or duplicate side fields';
    sideIds.add(side.id);
    for (const pokemon of side.pokemon) {
      if (!keysOnly(pokemon, POKEMON) || typeof pokemon.id !== 'string' || actorIds.has(pokemon.id)) return 'unknown, malformed or duplicate Pokemon fields';
      actorIds.add(pokemon.id);
      if (pokemon.boosts !== undefined && !object(pokemon.boosts)) return 'malformed boost state';
      if (pokemon.lifecycle !== undefined && !keysOnly(pokemon.lifecycle, LIFECYCLE)) return 'unknown lifecycle fields';
      if (pokemon.pp !== undefined && (!Array.isArray(pokemon.pp) || !pokemon.pp.every(value => Number.isSafeInteger(value)))) return 'malformed PP fields';
    }
  }
  return null;
}
function simulationIssue(value) {
  if (!keysOnly(value, ROOT)) return 'unknown simulation fields';
  for (const sample of value.samples) {
    if (!keysOnly(sample, SAMPLE) || !Array.isArray(sample.actionOutcomes)) return 'unknown or malformed sample fields';
    const issue = snapshotIssue(sample.start) ?? snapshotIssue(sample.final) ??
      eventsIssue(sample.events) ?? eventsIssue(sample.openingEvents ?? []);
    if (issue) return issue;
    // Index references must be unambiguous. Their order is native order; neither
    // numeric sorting nor local action indices may manufacture a global order.
    if (new Set(sample.events.map(event => event.index)).size !== sample.events.length) return 'duplicate native event indices';
    for (const action of sample.actionOutcomes) {
      if (!keysOnly(action, OUTCOME)) return 'unknown action outcome fields';
      const deniedIssue = eventsIssue(action.denied ?? []);
      if (deniedIssue) return deniedIssue;
      if (action.resolution !== undefined) {
        if (!keysOnly(action.resolution, RESOLUTION)) return 'unknown action resolution fields';
        const resolutionIssue = eventsIssue(action.resolution.events) ?? eventsIssue(action.resolution.denials);
        if (resolutionIssue) return resolutionIssue;
      }
    }
  }
  return null;
}

// Native raw lines retain every protocol argument/tag. Stable actor identities
// remain explicit; type/move duplicate the same native line and are not repeated.
function timelineEvent(event) {
  return {index: event.index, ...(event.actorId != null ? {actorId: event.actorId} : {}),
    ...(event.targetId != null ? {targetId: event.targetId} : {}),
    ...(event.sourceId != null ? {sourceId: event.sourceId} : {}), native: event.raw};
}
function matchingTimeline(local, events) {
  if (!local.length) return [];
  const equal = (a, b) => isDeepStrictEqual(without(a, ['index']), without(b, ['index']));
  const matches = [];
  for (let index = 0; index <= events.length - local.length; index++) {
    const candidate = events.slice(index, index + local.length);
    if (candidate.every((event, offset) => !COSMETIC.has(event.type) && equal(event, local[offset]))) matches.push(candidate);
  }
  // Repeated native lines can occur in different actions. Ambiguous or partial
  // correspondence retains local events, including their original local index.
  return matches.length === 1 ? matches[0].map(event => event.index) : null;
}
function actionCard(action, events) {
  if (!action.resolution) return action;
  const {resolution, ...card} = action;
  const indices = matchingTimeline(resolution.events, events);
  return {...card, resolutionKind: resolution.kind, nativeMoveResult: resolution.nativeMoveResult,
    ...(resolution.id !== action.id ? {resolutionId: resolution.id} : {}),
    ...(Object.hasOwn(resolution, 'entrantId') ? {entrantId: resolution.entrantId} : {}),
    ...(!isDeepStrictEqual(resolution.denials, action.denied) ? {resolutionDenials: resolution.denials} : {}),
    ...(indices === null ? {resolutionEvents: resolution.events} : {eventsInTimeline: indices})};
}
function finalCard(final) {
  if (final == null) return final;
  return {...final, sides: final.sides.map(side => ({...side, pokemon: side.pokemon.map(pokemon => {
    const card = without(pokemon, ['pp','lifecycle']);
    if (keysOnly(pokemon.boosts, STAGES) && Object.keys(pokemon.boosts).length === STAGES.length &&
        STAGES.every(stage => pokemon.boosts[stage] === 0)) card.boosts = 'all-neutral';
    return card;
  })}))};
}
function marker(value, extra = {}) {
  return {kind: 'native-simulation-outcome-cards-v1', fullResponseRetained: true,
    nativeResultSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    sampleOnly: true, ...extra};
}
function cards(value) {
  if (isSimulationDecisionView(value)) return value;
  const issue = simulationIssue(value);
  if (issue) return {...value, decisionViewSimulation: marker(value, {mode: 'full-fallback', reason: issue})};
  const {samples, submittedBranches, ...header} = value;
  return {...header, ...(submittedBranches !== undefined && !isDeepStrictEqual(submittedBranches, value.testedBranches) ? {submittedBranches} : {}),
    samples: samples.map(sample => ({branchId: sample.branchId, seed: sample.seed, accepted: sample.accepted, gate: sample.gate,
      actionOutcomes: sample.actionOutcomes.map(action => actionCard(action, sample.events)),
      orderedEvents: sample.events.filter(event => !COSMETIC.has(event.type)).map(timelineEvent),
      final: finalCard(sample.final),
      ...without(sample, ['branchId','seed','accepted','gate','start','openingEvents','events','actionOutcomes','final'])})),
    decisionViewSimulation: marker(value, {mode: 'outcome-cards',
      reading: 'Every branch and seed is shown. orderedEvents are native protocol lines in global index order; eventsInTimeline links only verified unique complete action logs. denied also contains identical native resolution denials; differing resolutionDenials stay explicit. all-neutral means atk/def/spa/spd/spe/accuracy/evasion are each exactly 0.',
      omitted: 'Repeated start/entry logs, cosmetic log lines, final PP/lifecycle, and an exactly duplicated submittedBranches list remain in the full immutable native receipt. Unknown transformed shapes use full-fallback; no probabilities or later-turn survival are inferred.'})};
}

function commonFinalProperties(cases) {
  const finals = cases.flatMap(entry => entry.result.samples.map(sample => sample.final));
  if (finals.length < 2 || finals.some(final => !object(final))) return {};
  const entries = finals.map(final => final.sides.flatMap(side => side.pokemon.map(pokemon => [pokemon.id, {side: side.id, pokemon}])));
  const rows = entries.map(entries => new Map(entries));
  if (rows.some((row, index) => row.size !== entries[index].length)) return {};
  const identities = [...rows[0].keys()];
  if (!rows.every(row => row.size === identities.length && identities.every(id => row.has(id) && row.get(id).side === rows[0].get(id).side))) return {};
  const common = [];
  for (const id of identities) {
    const first = rows[0].get(id).pokemon, properties = {};
    for (const key of Object.keys(first)) {
      if (key !== 'id' && rows.every(row => Object.hasOwn(row.get(id).pokemon, key) && isDeepStrictEqual(row.get(id).pokemon[key], first[key]))) {
        properties[key] = first[key];
        rows.forEach(row => { delete row.get(id).pokemon[key]; });
      }
    }
    if (Object.keys(properties).length) common.push([id, {side: rows[0].get(id).side, properties}]);
  }
  return Object.fromEntries(common);
}

export function projectSimulationDecisionView(value) { return cards(value); }

export function projectSimulationBatchDecisionView(value) {
  if (isSimulationDecisionView(value)) return value;
  if (!keysOnly(value, ['cases','batch','source','calculationRef']) || value.cases.some(entry => !keysOnly(entry, ['id','result']))) {
    return {...value, decisionViewSimulation: marker(value, {mode: 'full-fallback', reason: 'unknown simulation batch fields'})};
  }
  const issue = value.cases.map(entry => simulationIssue(entry.result)).find(Boolean);
  if (issue) return {...value, decisionViewSimulation: marker(value, {mode: 'full-fallback', reason: issue})};
  const projected = value.cases.map(entry => ({...entry, result: cards(entry.result)}));
  const commonFinalPokemonProperties = commonFinalProperties(projected);
  // Readable common headers, rather than many long generic JSON-path refs. Only
  // exact equality can hoist a field, and every case inherits the listed fields.
  const common = {};
  for (const key of ['engine','loadedManifest','source','hypotheses','limitations']) {
    if (projected.length > 1 && Object.hasOwn(projected[0].result, key) &&
        projected.every(entry => isDeepStrictEqual(entry.result[key], projected[0].result[key]))) {
      common[key] = projected[0].result[key];
      projected.forEach(entry => { delete entry.result[key]; });
    }
  }
  // One rendering contract applies to all case cards. Per-case immutable result
  // hashes remain with their own case and never refer to a different result.
  const contract = without(projected[0].result.decisionViewSimulation, ['nativeResultSha256']);
  projected.forEach(entry => {
    entry.result.nativeResultSha256 = entry.result.decisionViewSimulation.nativeResultSha256;
    delete entry.result.decisionViewSimulation;
  });
  return {...value, ...(Object.keys(common).length ? {commonToEveryCase: common} : {}), cases: projected,
    ...(Object.keys(commonFinalPokemonProperties).length ? {commonFinalPokemonProperties} : {}),
    decisionViewSimulation: {...contract, commonFieldsApplyTo: 'commonToEveryCase applies to every cases[].result. Each final Pokemon inherits commonFinalPokemonProperties[id].properties for its exact side/id. Every property is exactly identical across all samples; differing HP/status/form/items/boosts stay in each final card.'}};
}
