import {createRequire} from 'node:module';
import {cantActionAttribution,ordinaryMoveExecution} from '../showdown/protocol-action.mjs';
const {Dex} = createRequire(import.meta.url)('pokemon-showdown');
const dex = Dex.forFormat('gen9championsvgc2026regmc');
const key = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g,'');
const CHANGES = new Set(['switch','drag','replace','detailschange','-formechange','-mega','-boost','-unboost','-setboost','-clearboost','-clearallboost','-clearpositiveboost','-clearnegativeboost','-copyboost','-swapboost','-invertboost','-status','-curestatus','-item','-enditem','-ability','-endability','-weather','-fieldstart','-fieldend','-sidestart','-sideend','-start','-end']);
const ORDER_ABILITIES = new Set(['prankster','galewings','triage','stall','myceliummight','quickdraw']);
const ORDER_ITEMS = new Set(['quickclaw','custapberry','laggingtail','fullincense']);
const ORDER_MOVES = new Set(['afteryou','quash','instruct','round','pursuit']);
const refOf = value => {
  const match = /^(p[1-4])(?:[a-f])?:\s*(.*)$/u.exec(value || '');
  return match ? {side:match[1],nickname:match[2].trim().toLowerCase()} : null;
};

/** Bounded qualitative observations, never numerical Speed or investment inference. */
export function buildOrderEvidence({board,actors = []} = {}) {
  const sourceLines = structuredClone(board?.recentEvents?.lines || []);
  const events = sourceLines.map((line,index) => {const [,type,...parts] = String(line).split('|');return {line,index,type,parts};});
  const omitted = board?.recentEvents?.omitted ?? 0, truncated = !!board?.recentEvents?.truncated;
  const baseline = !omitted && !truncated ? events.findIndex(event => event.type === 'start') : -1;
  let turn = null, trickRoom = baseline >= 0 ? 'inactive' : 'unknown';
  const attempts = [];
  for (const event of events) {
    if (event.type === 'turn') turn = Number(event.parts[0]) || null;
    if (event.type === '-fieldstart' && key(event.parts[0]) === 'movetrickroom') trickRoom = 'active';
    if (event.type === '-fieldend' && key(event.parts[0]) === 'movetrickroom') trickRoom = 'inactive';
    if (!['move','cant'].includes(event.type)) continue;
    const attribution=event.type==='cant'?cantActionAttribution(event.parts):null;
    const actorText=attribution?attribution.actor:event.parts[0];
    const ref = refOf(actorText);
    const matches = ref ? actors.filter(actor => actor.side === ref.side && actor.raw?.nickname?.trim().toLowerCase() === ref.nickname && !String(actor.raw.identityConfidence || '').includes('ambiguous')) : [];
    const actor = matches.length === 1 ? matches[0] : null;
    const name = event.type === 'move' ? event.parts[1] : event.parts[2];
    const move = dex.moves.get(name || '');
    attempts.push({...event,turn,trickRoom,ref,actor,actorText,moveName:name,move,executed:event.type === 'move' && ordinaryMoveExecution(event.parts)});
  }
  const observations = [];const observationLimit=24;let omittedObservations=0;
  const groups = new Map();
  for (const attempt of attempts) {if (!groups.has(attempt.turn)) groups.set(attempt.turn,[]);groups.get(attempt.turn).push(attempt);}
  for (const group of [...groups.values()].reverse()) {
    const pairs = [];
    let possiblePairs=0;
    for (let i = 0;i < group.length;i++) for (let j = i + 1;j < group.length;j++) {
      if (group[i].ref?.side === group[j].ref?.side && group[i].ref?.nickname === group[j].ref?.nickname) continue;
      possiblePairs++;
      if(pairs.length<observationLimit-observations.length)pairs.push([group[i],group[j]]);else omittedObservations++;
    }
    if (!possiblePairs){if(observations.length<observationLimit)pairs.push([group[0],null]);else omittedObservations++;}
    for (const [first,second] of pairs) {
      const members = [first,second], known = members.every(attempt => attempt?.actor);
      const priorities = members.map(attempt => attempt?.move.exists ? attempt.move.priority : null);
      const samePriority = priorities.every(priority => priority !== null) ? priorities[0] === priorities[1] : null;
      const bothExecuted = members.every(attempt => attempt?.executed === true);
      const changesBetween = second ? events.filter(event => event.index > first.index && event.index < second.index && CHANGES.has(event.type)) : [];
      const turnEvents = events.filter(event => event.index >= (events.findLast(event => event.type === 'turn' && event.index <= first.index)?.index ?? 0) && event.index <= group.at(-1).index);
      const explicitOrder = group.some(attempt => ORDER_MOVES.has(attempt.move.id) || !attempt.executed) || turnEvents.some(event => event.type === '-activate' && /quick claw|custap berry|quick draw|quash|after you/iu.test(event.line));
      const unknownOrderingState = !known || members.some(attempt => !attempt?.actor?.ability || !attempt?.actor?.itemKnown);
      const possibleOrderEffect = members.some(attempt => ORDER_ABILITIES.has(key(attempt?.actor?.ability)) || ORDER_ITEMS.has(key(attempt?.actor?.item)));
      // Current items/abilities cannot reconstruct their values before a reveal,
      // consumption, form change or switch. Preserve the observation instead.
      const identityChanges = events.filter(event => event.index > first.index && ['replace','detailschange','-formechange','-mega','-item','-enditem','-ability','-endability'].includes(event.type));
      const originalKnown = baseline >= 0 && baseline < first.index && !identityChanges.length;
      const forcedOrder = explicitOrder || possibleOrderEffect ? true : unknownOrderingState || changesBetween.length || !originalKnown ? null : false;
      const informative = samePriority === true && forcedOrder === false && bothExecuted && known;
      const reasons = [];
      if (!originalKnown) reasons.push('Original conditions are incomplete; the available stream cannot reconstruct historical ability/item/form state.');
      if (!known) reasons.push('Side and nickname do not identify both actors uniquely; slot-only identity was not used.');
      if (samePriority !== true) reasons.push('Native move priorities differ or are unknown.');
      if (!bothExecuted) reasons.push('Both ordinary move executions were not observed; interruption or called moves do not establish this comparison.');
      if (forcedOrder !== false) reasons.push('Forced order, priority-changing effects or intervening state changes are present or unresolved.');
      const later = events.filter(event => event.index > first.index && CHANGES.has(event.type));
      const currentReuseReasons = [...reasons];
      if (later.length) currentReuseReasons.push('Weather, terrain, form, boosts, status, items, abilities, control or switches changed after this observation.');
      if (members.some(attempt => attempt?.actor && !attempt.actor.slot)) currentReuseReasons.push('An observed actor is now a reserve; its original active-board conditions cannot be reused directly.');
      const currentRoom = !!board?.field?.conditions?.trickroom;
      if (first.trickRoom !== 'unknown' && currentRoom !== (first.trickRoom === 'active')) currentReuseReasons.push('Current Trick Room differs from the observed condition.');
      observations.push({turn:first.turn,first:first.actor?.id ?? null,second:second?.actor?.id ?? null,
        attemptedActors:members.map(attempt => attempt?.actorText ?? null),moves:members.map(attempt => attempt?.move.exists ? attempt.move.name : attempt?.moveName ?? null),priorities,
        samePriority,forcedOrder,bothExecuted,identityVerified:known,informative,tiesPossible:true,
        direction:informative ? first.trickRoom === 'active' ? 'at-most-as-fast' : first.trickRoom === 'inactive' ? 'at-least-as-fast' : 'unknown' : 'unknown',
        originalConditions:{baseline:originalKnown ? 'battle-start-observed' : 'unknown',trickRoom:first.trickRoom,source:'orderEvidence.sourceLines',throughSourceLine:first.index},
        currentReuse:informative && currentReuseReasons.length === 0,currentReuseReasons,reasons,
        events:members.filter(Boolean).map(attempt => attempt.line),scope:'available-bounded-observations',numericalInference:'unverified'});
    }
  }
  return {observations,observationLimit,omittedObservations,sourceLines,omitted,truncated,scope:board?.recentEvents?.scope ?? 'available-bounded-observations',
    warning:'Observed order is conditional on its original state; ties remain possible. No numerical Speed or investment was inferred.'};
}
