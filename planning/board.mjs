import {createRequire} from 'node:module';
import {buildOrderEvidence} from './order-evidence.mjs';

const {Dex} = createRequire(import.meta.url)('pokemon-showdown');
// Mechanics must come from the pinned Champions format, including its overrides.
export const championsDex = Dex.forFormat('gen9championsvgc2026regmc');
const clone = value => value == null ? null : structuredClone(value);
const key = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slotNumber = value => value === 1 || value === 'a' ? 1 : value === 2 || value === 'b' ? 2 : null;
const speciesKey = value => {
  const species = championsDex.species.get(value || '');
  return key(species.exists ? species.baseSpecies : value);
};
const names = moves => [...new Set((Array.isArray(moves) ? moves : []).map(move => {
  const value = typeof move === 'string' ? move : move?.move || move?.name || move?.id;
  if (!value) return null;
  const data = championsDex.moves.get(value);
  return data.exists ? data.name : String(value);
}).filter(Boolean))];

const PROTECTION = new Set(['protect','detect','kingsshield','spikyshield','banefulbunker','obstruct','silktrap','burningbulwark','wideguard','quickguard','matblock']);
const DENIAL = new Set(['fakeout','taunt','encore','disable','spore','sleeppowder','hypnosis','yawn','thunderwave','willowisp','throatchop','psychicnoise','haze','clearsmog','quash','roar','whirlwind','dragontail','circlethrow','topsyturvy','imprison']);
const SPEED = new Set(['tailwind','trickroom','icywind','electroweb','bulldoze','stringshot','scaryface','thunderwave','quash','afteryou']);
const WEATHER = new Set(['raindance','sunnyday','sandstorm','snowscape']);
const TERRAIN = new Set(['electricterrain','grassyterrain','mistyterrain','psychicterrain']);
const WEATHER_ABILITIES = new Set(['drizzle','drought','sandstream','snowwarning','desolateland','primordialsea','deltastream']);
const TERRAIN_ABILITIES = new Set(['electricsurge','grassysurge','mistysurge','psychicsurge']);

/** Qualitative provider tags only: a capability does not prove present eligibility or delivery. */
export function moveCapabilities(move) {
  const data = typeof move === 'string' ? championsDex.moves.get(move) : move;
  if (!data?.exists) return [];
  const result = [];
  if (data.category !== 'Status') result.push('damage', data.category === 'Physical' ? 'physical-damage' : 'special-damage');
  if (data.priority > 0) result.push('priority');
  if (PROTECTION.has(data.id)) result.push('protection');
  if (DENIAL.has(data.id) || data.status) result.push('denial');
  if (SPEED.has(data.id)) result.push('speed-control');
  if (WEATHER.has(data.id) || data.weather) result.push('weather');
  if (TERRAIN.has(data.id) || data.terrain) result.push('terrain');
  if (['followme','ragepowder','spotlight'].includes(data.id)) result.push('redirection');
  if (data.selfSwitch) result.push('pivot');
  if (data.heal || data.drain || ['lifedew','junglehealing','lunarblessing','pollenpuff','healpulse'].includes(data.id)) result.push('recovery');
  if (data.boosts && Object.values(data.boosts).some(amount => amount > 0) && ['self','adjacentAlly','adjacentAllyOrSelf','allies'].includes(data.target)) result.push('setup');
  if (data.volatileStatus === 'trapped' || ['meanlook','block','spiderweb','jawlock','anchorshot','spiritshackle'].includes(data.id)) result.push('trapping');
  return [...new Set(result)];
}

function capabilities(moves, ability, suppressed) {
  const result = moves.flatMap(moveCapabilities);
  if (suppressed !== true) {
    const id = key(ability);
    if (WEATHER_ABILITIES.has(id)) result.push('weather');
    if (TERRAIN_ABILITIES.has(id)) result.push('terrain');
    if (['armortail','queenlymajesty','dazzling'].includes(id)) result.push('priority-block');
    if (['shadowtag','arenatrap','magnetpull'].includes(id)) result.push('trapping');
    if (id === 'intimidate') result.push('entry-intimidate');
  }
  return [...new Set(result)];
}

function matchSet(raw, sets, warnings, label) {
  if (!Array.isArray(sets)) return null;
  if (String(raw.identityConfidence || '').includes('ambiguous')) {
    warnings.push({code:'AMBIGUOUS_IDENTITY',actorId:raw.id,message:`${label} identity is ambiguous; registered set data was not attached.`});
    return null;
  }
  const matches = sets.flatMap((set,index) => speciesKey(set?.species) && speciesKey(set.species) === speciesKey(raw.species) ? [{set,index}] : []);
  if (matches.length === 1) return matches[0];
  warnings.push({code:matches.length ? 'AMBIGUOUS_SET' : 'MISSING_SET',actorId:raw.id,message:`${label} has ${matches.length ? 'multiple matching registered sets' : 'no matching registered set'}; missing values remain unknown.`});
  return null;
}

function selection(raw, side, legalActions, own, slot, warnings) {
  if (legalActions?.teamPreview) return 'unknown';
  if (!own && (slot !== null || side.selectionKnowledge === 'observed-opponents-only' || raw.hp != null)) return 'selected';
  if (own && Array.isArray(legalActions?.pokemon)) {
    if (raw.selection === 'not-in-current-request') return 'not-in-current-request';
    // The compact board's current-request identity mapping is authoritative.
    if (side.selectionKnowledge === 'current-own-request' && raw.selection === 'selected' && Number.isInteger(raw.requestIndex) && raw.requestIndex > 0 && raw.requestIndex <= legalActions.pokemon.length) return 'selected';
    if (raw.selection === 'selected' && Number.isInteger(raw.requestIndex)) {
      const requestPokemon = legalActions.pokemon[raw.requestIndex - 1];
      if (requestPokemon && speciesKey(String(requestPokemon.details || '').split(',')[0]) === speciesKey(raw.species)) return 'selected';
    }
    warnings.push({code:'SELECTION_UNCONFIRMED',actorId:raw.id,message:'Own actor is not mapped to the current selected party; do not credit it as an available reserve.'});
    return 'unknown';
  }
  return ['selected','not-in-current-request'].includes(raw.selection) ? raw.selection : 'unknown';
}

/**
 * Normalize observations and published/locked sets without calculating stats or
 * reconstructing unseen state. Returned values are detached from all inputs.
 */
export function buildTurnFacts({board,legalActions,ownTeam,opponentSheet,objective} = {}) {
  const warnings = [], actors = [];
  const ownSide = board?.ownSide ?? null;
  const sides = Array.isArray(board?.sides) ? board.sides : [];
  const foes = sides.filter(side => side.id !== ownSide);
  const foeSide = foes.length === 1 ? foes[0].id : null;
  if (!board || !ownSide) warnings.push({code:'MISSING_BOARD',message:'A current compact board with an own side is required; missing state remains unknown.'});
  if (foes.length !== 1) warnings.push({code:'UNKNOWN_FOE_SIDE',message:'One opposing side could not be identified.'});
  if (!Array.isArray(ownTeam)) warnings.push({code:'MISSING_OWN_TEAM',message:'Locked own sets are absent; nature and stat points remain unknown.'});
  if (!Array.isArray(opponentSheet)) warnings.push({code:'MISSING_OPPONENT_SHEET',message:'Published opposing sets are absent; observed facts are retained.'});
  const matchedOpponent = new Set();
  const observedBaseCounts = new Map();
  for (const side of foes) for (const raw of side.pokemon || []) {
    const identity = speciesKey(raw.species);
    observedBaseCounts.set(identity,(observedBaseCounts.get(identity) || 0) + 1);
  }
  for (const side of sides) for (const raw of side.pokemon || []) {
    const own = side.id === ownSide;
    const active = (side.active || []).filter(entry => entry.pokemon === raw.id);
    const slot = active.length === 1 ? slotNumber(active[0].slot) : slotNumber(raw.activeSlot);
    const localWarnings = [];
    // A duplicate observed species cannot be assigned to one registered identity.
    const identityAmbiguous = !own && observedBaseCounts.get(speciesKey(raw.species)) > 1;
    const match = identityAmbiguous ? null : matchSet(raw,own ? ownTeam : opponentSheet,localWarnings,own ? 'Own actor' : 'Opposing actor');
    if (identityAmbiguous) localWarnings.push({code:'AMBIGUOUS_IDENTITY',actorId:raw.id,message:'Multiple observed actors share this registered species; no sheet identity was guessed.'});
    if (!own && match) matchedOpponent.add(match.index);
    const set = match?.set;
    const sameForm = !!set && key(championsDex.species.get(set.species).name) === key(championsDex.species.get(raw.species).name);
    const ability = raw.ability ?? (sameForm ? set?.ability : null) ?? null;
    const itemKnown = raw.itemKnown === true || (raw.itemKnown !== true && !!set && Object.hasOwn(set,'item'));
    const item = raw.itemKnown === true ? raw.item ?? null : raw.item ?? set?.item ?? null;
    const requestMoves = own && slot && !legalActions?.teamPreview ? legalActions?.active?.[slot - 1]?.moves : null;
    const moves = names([...(set?.moves || []),...(raw.moves || []),...(requestMoves || [])]);
    const actor = {id:raw.id,side:side.id,own,slot,selected:selection(raw,side,legalActions,own,slot,localWarnings),
      species:raw.species ?? null,nature:set?.nature || null,statPoints:clone(set?.statPoints ?? set?.evs),
      ability,item,itemKnown,hp:clone(raw.hp),status:raw.status ?? null,boosts:clone(raw.boosts),moves,
      pp:Array.isArray(requestMoves) ? clone(requestMoves) : clone(raw.pp),lifecycle:clone(raw.lifecycle),volatiles:clone(raw.volatiles),
      capabilities:capabilities(moves,ability,raw.abilitySuppressed),raw:clone(raw)};
    if (!actor.nature || !actor.statPoints) localWarnings.push({code:'UNKNOWN_STATS',actorId:actor.id,message:`${own ? 'Own locked' : 'Opposing'} nature or stat points are unknown; no zero or neutral defaults were inserted.`});
    if (!sameForm && set && !raw.ability) localWarnings.push({code:'CURRENT_FORM_ABILITY_UNKNOWN',actorId:actor.id,message:'Current form differs from its registered set; the registered ability was not transplanted.'});
    for (const move of moves) if (!championsDex.moves.get(move).exists) localWarnings.push({code:'UNKNOWN_MOVE',actorId:actor.id,message:`Move ${move} is absent from the native Champions Dex.`});
    actors.push(actor); warnings.push(...localWarnings);
  }
  if (Array.isArray(opponentSheet) && foeSide) for (const [index,set] of opponentSheet.entries()) {
    if (matchedOpponent.has(index)) continue;
    const id = `registered:${foeSide}:${index + 1}`;
    const moves = names(set?.moves);
    const ability = set?.ability || null;
    actors.push({id,side:foeSide,own:false,slot:null,selected:'unknown',species:set?.species ?? null,nature:set?.nature || null,
      statPoints:clone(set?.statPoints ?? set?.evs),ability,item:set?.item ?? null,itemKnown:Object.hasOwn(set || {},'item'),
      hp:null,status:null,boosts:null,moves,pp:null,lifecycle:null,volatiles:null,capabilities:capabilities(moves,ability,false),raw:null});
  }
  const resources = [];
  for (const scope of ['selected-own-team','observed-selected-opponents','registered-opponents']) {
    const eligible = actors.filter(actor => scope === 'selected-own-team' ? actor.own && actor.selected === 'selected' && actor.raw?.fainted !== true :
      scope === 'observed-selected-opponents' ? !actor.own && actor.selected === 'selected' && actor.raw?.fainted !== true : !actor.own && actor.selected === 'unknown');
    for (const kind of new Set(eligible.flatMap(actor => actor.capabilities))) {
      const providers = eligible.filter(actor => actor.capabilities.includes(kind)).map(actor => actor.id);
      resources.push({kind,actors:providers,unique:providers.length === 1,scope});
    }
  }
  for (const warning of board?.warnings || []) warnings.push(typeof warning === 'string' ? {code:'BOARD_WARNING',message:warning} : clone(warning));
  const orderEvidence = buildOrderEvidence({board,actors});
  return {ownSide,foeSide,turn:board?.turn ?? null,field:clone(board?.field),sides:clone(sides),legalActions:clone(legalActions),
    objective:clone(objective),actors,warnings,resources,observedOrderConstraints:orderEvidence.observations,orderEvidence};
}
