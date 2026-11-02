/**
 * An observation reducer, not a simulator or strategy engine. Unknown information
 * stays null. HP on the opposing side is the server's displayed fraction, not an
 * inferred exact stat. Numerical stats are copied only from private requests.
 */
const id = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const blankBoosts = (value = null) => Object.fromEntries(STATS.map(stat => [stat, value]));
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = now => typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now();
const effectName = value => String(value || '').replace(/^(?:move|ability|item):\s*/, '');
const identity = value => {
  const m = /^(p[1-4])([a-f])?:\s*(.*)$/.exec(String(value || ''));
  return m ? {side: m[1], slot: m[2] || null, nickname: m[3]} : null;
};
const speciesOf = details => String(details || '').split(',')[0].trim() || null;

// PP continuity is deliberately narrower than battle-history reconstruction.
// Only an actual private active request can supply values; no initial/full PP
// or lifecycle counter is inferred. Any uncertain stream loses this evidence.
export function invalidateOwnPpObservation(state, reason) {
  if (!state?.sides) return;
  if (state.ownPpObservation) Object.assign(state.ownPpObservation, {continuous:false, reason});
  for (const side of Object.values(state.sides)) for (const p of side.pokemon) {
    p.ownPpSnapshot = null;
  }
}
function ppEpoch(state, epoch, connected) {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || connected !== true) {
    invalidateOwnPpObservation(state, 'No verified connection epoch'); return null;
  }
  if (state.ownPpObservation?.epoch !== epoch) {
    invalidateOwnPpObservation(state, 'Connection epoch changed');
    state.ownPpObservation = {version:1, epoch, connected:true, continuous:false, startObserved:false,
      sequence:0, lastRequestRqid:null, reason:'Battle start prefix not observed on this connection'};
  }
  const observation = state.ownPpObservation;
  observation.sequence++;
  return observation;
}
function invalidateActivePp(state) {
  for (const side of Object.values(state.sides)) for (const p of side.pokemon) if (p.activeSlot) p.ownPpSnapshot = null;
}
function sameMoves(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4 && Array.from(a).every((move,index) => typeof move === 'string' && typeof b[index] === 'string' && id(move) === id(b[index])); }

/** Shared pure consumer guard. An absent/unavailable observation remains an
 * explicit-hypothesis case; a claimed retained fact with conflicting bindings
 * is refused rather than silently replacing the authored/current identity. */
export function validateOwnReservePpSnapshot({pokemon, requestEntry, observation, rqid, authoredPp}) {
  const value = pokemon?.ownPpSnapshot;
  if (!value || value.status !== 'bench-retained') return null;
  const require = (ok, message) => { if (!ok) throw new Error('Observed reserve PP: '+message); };
  require(observation?.version === 1 && observation.connected === true && observation.continuous === true && observation.startObserved === true, 'connection continuity unavailable');
  require(value.version === 1 && Number.isSafeInteger(observation.epoch) && observation.epoch >= 0 && value.epoch === observation.epoch, 'connection epoch differs');
  require(value.actorId === pokemon.id && !pokemon.activeSlot && requestEntry?.active === false, 'actor/bench identity differs');
  require(value.ident === requestEntry.ident && value.details === requestEntry.details && speciesOf(value.details) === pokemon.species && identity(value.ident)?.nickname === pokemon.nickname, 'private request identity/details differ');
  require(sameMoves(value.moves, requestEntry.moves), 'private request move order differs');
  require(['item','ability','condition'].every(key => typeof value.requestState?.[key] === 'string' && value.requestState[key] === requestEntry[key]), 'private request item/ability/condition changed without usable PP evidence');
  require(Number.isSafeInteger(rqid) && observation.lastRequestRqid === rqid && Number.isSafeInteger(value.rqid) && value.rqid >= 0 && value.rqid < rqid && value.benchVerifiedRqid === rqid &&
    [value.requestSequence,value.exitSequence,value.benchVerifiedSequence,observation.sequence].every(n => Number.isSafeInteger(n) && n >= 1) && value.requestSequence < value.exitSequence && value.exitSequence < value.benchVerifiedSequence && value.benchVerifiedSequence <= observation.sequence,
  'request/exit/bench observation order differs');
  require(value.exitKind === 'observed-hard-switch' && value.continuous === true, 'mutation-free hard exit was not observed');
  require(Array.isArray(value.pp) && value.pp.length === 4 && Array.from(value.pp).every(pp => Number.isInteger(pp) && pp >= 0 && pp <= 64), 'invalid private PP values');
  if(authoredPp !== undefined) require(JSON.stringify(authoredPp) === JSON.stringify(value.pp), 'PP hypothesis conflicts with retained private request');
  return {pp:[...value.pp], provenance:clone(value)};
}

export function createBattleState() {
  return {turn: 0, gen: null, gameType: null, tier: null, ownSide: null, ended: false, result: null,
    updatedAt: null, nextPokemon: 1, lastUpkeepTurn: null, sides: {}, field: {weather: null, terrain: null, conditions: {}},
    lastMove: null, request: null, warnings: []};
}

function sideFor(state, side) {
  return state.sides[side] ||= {id: side, name: null, teamSize: null, preview: [], active: {}, pokemon: [], conditions: {}};
}
function newPokemon(state, ref, details = null) {
  const pokemon = {id: `${ref.side}-${state.nextPokemon++}`, nickname: ref.nickname || null,
    species: speciesOf(details), details, activeSlot: null, identityConfidence: 'observed',
    hp: null, status: null, fainted: null, boosts: blankBoosts(), ability: null, abilitySuppressed: null,
    item: null, itemKnown: false, itemHistory: [], mega: null, moves: [], volatiles: {},
    requestStats: null, requestIndex: null, selection: 'unknown', previousAppearances: []};
  sideFor(state, ref.side).pokemon.push(pokemon);
  return pokemon;
}
function activePokemon(state, ref) {
  if (!ref) return null;
  const side = sideFor(state, ref.side);
  if (ref.slot) return side.pokemon.find(p => p.id === side.active[ref.slot]) || null;
  const matches = side.pokemon.filter(p => p.nickname === ref.nickname);
  return matches.length === 1 ? matches[0] : null;
}
function getPokemon(state, text, {create = false} = {}) {
  const ref = identity(text);
  if (!ref) return null;
  const found = activePokemon(state, ref);
  if (found || !create) return found;
  const p = newPokemon(state, ref);
  if (ref.slot) { p.activeSlot = ref.slot; sideFor(state, ref.side).active[ref.slot] = p.id; }
  return p;
}
function resetOnExit(p) {
  if (!p) return;
  p.activeSlot = null; p.boosts = blankBoosts(0); p.volatiles = {};
  p.requestStats = null; p.abilitySuppressed = null;
}
function health(state, p, condition, source = 'protocol') {
  if (!p || typeof condition !== 'string') return;
  const match = /^(\d+)(?:\/(\d+))?(?:\s+(\w+))?/.exec(condition.trim());
  if (!match) return;
  const fainted = match[3] === 'fnt' || match[1] === '0';
  const side = p.id.split('-')[0];
  p.hp = {current: Number(match[1]), max: match[2] ? Number(match[2]) : null,
    precision: source === 'request' || state.ownSide === side ? 'server-own-exact' : 'server-display',
    source, raw: condition};
  p.status = match[3] && match[3] !== 'fnt' ? match[3] : null;
  p.fainted = fainted;
}
function switchPokemon(state, text, details, condition, replace = false) {
  const ref = identity(text); if (!ref?.slot) return;
  const side = sideFor(state, ref.side), outgoing = activePokemon(state, ref);
  let p;
  if (replace && outgoing) {
    p = outgoing;
    p.previousAppearances.push({nickname: p.nickname, species: p.species});
    p.identityConfidence = 'corrected-by-replace';
    // A request attached to the apparent identity is no longer safe to reuse.
    p.requestStats = null; p.requestIndex = null;
  } else {
    resetOnExit(outgoing);
    const matches = side.pokemon.filter(candidate => !candidate.activeSlot && candidate !== outgoing &&
      candidate.nickname === ref.nickname && candidate.species === speciesOf(details));
    // The outgoing Pokémon can also be the target of an explicit same-slot switch.
    if (outgoing?.nickname === ref.nickname && outgoing.species === speciesOf(details)) matches.push(outgoing);
    p = matches.length === 1 ? matches[0] : newPokemon(state, ref, details);
    if (matches.length > 1) p.identityConfidence = 'ambiguous-duplicate';
    p.boosts = blankBoosts(0); p.volatiles = {}; p.requestStats = null;
  }
  p.nickname = ref.nickname; p.species = speciesOf(details); p.details = details;
  p.activeSlot = ref.slot; side.active[ref.slot] = p.id;
  health(state, p, condition);
  return p;
}
function revealSources(state, parts, target) {
  const from = parts.find(p => p.startsWith('[from] '));
  if (!from) return;
  const of = parts.find(p => p.startsWith('[of] '));
  const p = of ? getPokemon(state, of.slice(5)) : target;
  if (!p) return;
  if (from.startsWith('[from] ability: ')) { p.ability = from.slice(16); p.abilitySuppressed = false; }
  if (from.startsWith('[from] item: ')) {
    const item = from.slice(13);
    // Berry healing is logged after -enditem. It reveals the used item, not a
    // newly held copy; only -item/private requests can establish reacquisition.
    if (!(p.itemKnown && p.item === null && p.itemHistory.some(event => id(event.item) === id(item)))) p.item = item;
    p.itemKnown = true;
  }
}

// Verified against the installed, pinned pokemon-showdown source:
// data/moves.ts: tailwind/trickroom/terrain condition durations and callbacks;
// data/conditions.ts: weather duration callbacks. The Champions mod inherits
// these conditions. Persistent is explicitly tagged in the protocol. Item-based
// extensions remain a range: even revealed items can be suppressed by effects.
// No duration model is applied to other generations or unrecognized effects.
function durationFor(state, name, parts) {
  if (![0, 9].includes(state.gen)) return null;
  const key = id(effectName(name)), persistent = parts.includes('[persistent]');
  if (key === 'trickroom') return {min: persistent ? 7 : 5, max: persistent ? 7 : 5, source: 'pinned-showdown:data/moves.ts#trickroom'};
  if (key === 'tailwind') return {min: persistent ? 6 : 4, max: persistent ? 6 : 4, source: 'pinned-showdown:data/moves.ts#tailwind'};
  if (['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain'].includes(key))
    return {min: 5, max: 8, source: 'pinned-showdown:data/moves.ts#terrain-duration', uncertainty: 'Terrain Extender effectiveness is not established'};
  if (['raindance', 'sunnyday', 'sandstorm', 'snowscape', 'hail'].includes(key))
    return {min: 5, max: 8, source: 'pinned-showdown:data/conditions.ts#weather-duration', uncertainty: 'weather-extending item effectiveness is not established'};
  return null;
}
function condition(state, name, parts) {
  return {name: effectName(name), startedTurn: state.turn || null, elapsedUpkeeps: 0,
    duration: durationFor(state, name, parts)};
}
function eachCondition(state, callback) {
  for (const c of [state.field.weather, state.field.terrain, ...Object.values(state.field.conditions),
    ...Object.values(state.sides).flatMap(side => Object.values(side.conditions))]) if (c) callback(c);
}

/** Fold a single trusted battle-protocol line. Opponent chat is ignored. */
export function reduceBattleLine(state, line, {now, epoch, connected} = {}) {
  if (typeof line !== 'string' || !line.startsWith('|')) return state;
  const [, type, ...parts] = line.split('|');
  // Deliberately do not parse request/login/chat data from a raw string here.
  if (!['player', 'teamsize', 'poke', 'gen', 'gametype', 'tier', 'start', 'turn', 'upkeep', 'switch', 'drag',
    'replace', 'detailschange', 'swap', 'faint', 'move', 'cant', 'win', 'tie'].includes(type) && !type.startsWith('-')) return state;
  state.updatedAt = stamp(now);
  const ppObservation = ppEpoch(state, epoch, connected);
  if (ppObservation && type === 'start') {
    if (ppObservation.startObserved || state.turn !== 0) invalidateOwnPpObservation(state, 'Repeated or late battle start');
    else Object.assign(ppObservation, {startObserved:true, continuous:true, reason:null});
  }
  if (ppObservation && type === 'turn') {
    const turn = Number(parts[0]);
    if (turn !== state.turn + 1 || state.turn > 0 && state.lastUpkeepTurn !== state.turn) invalidateOwnPpObservation(state, 'Missing/replayed turn or upkeep');
  }
  if (ppObservation && type === 'upkeep' && state.lastUpkeepTurn === state.turn) invalidateOwnPpObservation(state, 'Repeated upkeep');
  // A public move is not a PP delta: Pressure, callers, denials and PP effects
  // require the next private request. Conservatively discard all active caches.
  if (type === 'move' || type === 'cant' || type.startsWith('-')) invalidateActivePp(state);
  if (type.startsWith('-') || ['replace','detailschange','drag'].includes(type)) {
    for (const text of parts) { const affected = getPokemon(state, text); if (affected) affected.ownPpSnapshot = null; }
  }
  const p = getPokemon(state, parts[0]);
  if (type === 'player' && /^p[1-4]$/.test(parts[0])) sideFor(state, parts[0]).name = parts[1] || null;
  else if (type === 'teamsize' && /^p[1-4]$/.test(parts[0])) sideFor(state, parts[0]).teamSize = Number(parts[1]);
  else if (type === 'poke' && /^p[1-4]$/.test(parts[0])) sideFor(state, parts[0]).preview.push({details: parts[1], species: speciesOf(parts[1])});
  else if (type === 'gen') state.gen = Number(parts[0]);
  else if (type === 'gametype') state.gameType = parts[0];
  else if (type === 'tier') state.tier = parts[0];
  else if (type === 'turn') {
    const turn = Number(parts[0]);
    if (Number.isSafeInteger(turn) && turn >= 1) {
      if (state.turn > 0 && turn > state.turn && (state.lastUpkeepTurn !== state.turn || turn !== state.turn + 1)) {
        // Joining late or consuming a filtered event log must not produce a
        // confident but stale timer. Do not reconstruct missing residuals.
        eachCondition(state, c => { c.elapsedUpkeeps = null; c.durationWarning = 'Turn advanced without complete upkeep observations; remaining duration unknown'; });
      }
      state.turn = turn;
    }
  } else if (type === 'upkeep') {
    eachCondition(state, c => { if (Number.isInteger(c.elapsedUpkeeps)) c.elapsedUpkeeps++; });
    state.lastUpkeepTurn = state.turn;
  }
  else if (['switch', 'drag', 'replace'].includes(type)) {
    const outgoing = getPokemon(state, parts[0]), cached = outgoing?.ownPpSnapshot;
    const clean = type === 'switch' && parts.length === 3 && ppObservation?.continuous === true && cached?.status === 'active-request' && cached.continuous === true && cached.epoch === ppObservation.epoch;
    const incoming = switchPokemon(state, parts[0], parts[1], parts[2], type === 'replace');
    if (outgoing) outgoing.ownPpSnapshot = clean && incoming !== outgoing ? {...cached, status:'bench-retained', exitKind:'observed-hard-switch', exitSequence:ppObservation.sequence, exitTurn:state.turn} : null;
    if (incoming) incoming.ownPpSnapshot = null;
  }
  else if (['detailschange', '-formechange'].includes(type) && p) {
    const species = speciesOf(parts[1]);
    // A base-form reveal cannot establish the evolved form's current ability.
    // Later explicit ability/suppression events or own requests remain authoritative.
    if (species !== p.species) { p.ability = null; p.abilitySuppressed = null; }
    p.species = species; p.details = parts[1];
    if (parts[2] && /^\d/.test(parts[2])) health(state, p, parts[2]);
  }
  else if (type === 'swap' && p) {
    const ref = identity(parts[0]), side = sideFor(state, ref.side);
    const newSlot = /^[0-5]$/.test(parts[1]) ? String.fromCharCode(97 + Number(parts[1])) : identity(parts[1])?.slot;
    if (newSlot) {
      const other = side.pokemon.find(candidate => candidate.id === side.active[newSlot]);
      side.active[newSlot] = p.id; p.activeSlot = newSlot;
      if (other) { side.active[ref.slot] = other.id; other.activeSlot = ref.slot; } else delete side.active[ref.slot];
    }
  } else if (['-damage', '-heal', '-sethp'].includes(type)) {
    health(state, p, parts[1]);
    if (type === '-sethp' && parts[2] && !parts[2].startsWith('[')) health(state, getPokemon(state, parts[2]), parts[3]);
  } else if (type === 'faint' && p) { p.fainted = true; p.status = null; p.volatiles = {}; p.hp = {...(p.hp || {max: null, precision: 'server-display', source: 'protocol'}), current: 0, raw: '0 fnt'}; }
  else if (type === '-status' && p) p.status = parts[1];
  else if (type === '-curestatus' && p) p.status = null;
  else if (type === '-cureteam') { const ref = identity(parts[0]); if (ref) for (const mon of sideFor(state, ref.side).pokemon) mon.status = null; }
  else if (['-boost', '-unboost', '-setboost'].includes(type) && p && STATS.includes(parts[1]) && Number.isFinite(Number(parts[2]))) {
    const stat = parts[1], amount = Number(parts[2]);
    p.boosts[stat] = type === '-setboost' ? amount : p.boosts[stat] === null ? null : Math.max(-6, Math.min(6, p.boosts[stat] + (type === '-unboost' ? -amount : amount)));
  } else if (type === '-clearboost' && p) p.boosts = blankBoosts(0);
  else if (type === '-clearallboost') { for (const side of Object.values(state.sides)) for (const mon of side.pokemon) if (mon.activeSlot) mon.boosts = blankBoosts(0); }
  else if (['-clearpositiveboost', '-clearnegativeboost', '-invertboost'].includes(type) && p) {
    for (const stat of STATS) if (p.boosts[stat] !== null) {
      if (type === '-invertboost') p.boosts[stat] *= -1;
      else if (type === '-clearpositiveboost' ? p.boosts[stat] > 0 : p.boosts[stat] < 0) p.boosts[stat] = 0;
    }
  } else if (['-copyboost', '-swapboost'].includes(type) && p) {
    const other = getPokemon(state, parts[1]);
    if (other) for (const stat of (parts[2] && !parts[2].startsWith('[') ? parts[2].split(',').map(s => s.trim()) : STATS)) if (STATS.includes(stat)) {
      if (type === '-swapboost') [p.boosts[stat], other.boosts[stat]] = [other.boosts[stat], p.boosts[stat]];
      // In actual simulator output (Psych Up/Costar), the first Pokémon is
      // the recipient and the second supplies the copied boosts.
      else p.boosts[stat] = other.boosts[stat];
    }
  } else if (type === '-ability' && p) { p.ability = parts[1] || null; p.abilitySuppressed = false; }
  else if (type === '-endability' && p) p.abilitySuppressed = true;
  else if (type === '-activate' && p && parts[1]?.startsWith('ability: ')) { p.ability = effectName(parts[1]); p.abilitySuppressed = false; }
  else if (type === '-item' && p) { p.item = parts[1] || null; p.itemKnown = true; }
  else if (type === '-enditem' && p) {
    p.itemHistory.push({item: parts[1], event: parts.includes('[eat]') ? 'consumed' : parts.some(s => s.startsWith('[from]')) ? 'removed' : 'ended', turn: state.turn});
    p.item = null; p.itemKnown = true;
  } else if (type === '-mega' && p) { p.mega = true; p.ability = null; p.abilitySuppressed = null; const stone = parts.at(-1); if (stone && !stone.startsWith('[')) { p.item = stone; p.itemKnown = true; } }
  else if (type === 'move' && p) {
    if (!p.moves.includes(parts[1])) p.moves.push(parts[1]);
    state.lastMove = {pokemon: p.id, move: parts[1], target: parts[2] || null, turn: state.turn, source: 'executed-server-event'};
  } else if (type === '-start' && p) p.volatiles[id(effectName(parts[1]))] = {name: effectName(parts[1]), startedTurn: state.turn};
  else if (type === '-end' && p) delete p.volatiles[id(effectName(parts[1]))];
  else if (type === '-weather') {
    if (parts[0] === 'none') state.field.weather = null;
    else if (!parts.includes('[upkeep]')) state.field.weather = condition(state, parts[0], parts);
    else if (!state.field.weather) state.field.weather = {name: parts[0], startedTurn: null, elapsedUpkeeps: null, duration: null};
  } else if (['-fieldstart', '-fieldend'].includes(type)) {
    const key = id(effectName(parts[0]));
    if (key.endsWith('terrain')) state.field.terrain = type === '-fieldstart' ? condition(state, parts[0], parts) : null;
    else if (type === '-fieldstart') state.field.conditions[key] = condition(state, parts[0], parts);
    else delete state.field.conditions[key];
  } else if (['-sidestart', '-sideend'].includes(type)) {
    const sideID = /^(p[1-4])/.exec(parts[0])?.[1];
    if (sideID) {
      const side = sideFor(state, sideID), key = id(effectName(parts[1]));
      if (type === '-sidestart') {
        const previous=side.conditions[key], next=condition(state,parts[1],parts);
        if(key==='toxicspikes'){
          const completePrefix=state.ownPpObservation?.startObserved===true&&state.ownPpObservation.continuous===true;
          next.layers=Number.isInteger(previous?.layers)?Math.min(2,previous.layers+1):!previous&&(completePrefix||side.toxicSpikesCleared===true)?1:null;
        }
        side.conditions[key]=next;
      }else {
        delete side.conditions[key];
        if(key==='toxicspikes')side.toxicSpikesCleared=true;
      }
    }
  } else if (type === '-swapsideconditions') {
    if (state.sides.p1 && state.sides.p2) [state.sides.p1.conditions, state.sides.p2.conditions] = [state.sides.p2.conditions, state.sides.p1.conditions];
  } else if (['win', 'tie'].includes(type)) { state.ended = true; state.result = {type, winner: type === 'win' ? parts[0] : null}; }
  revealSources(state, parts, p);
  return state;
}

/** Copy private server-owned stats; do not calculate or infer Speed here. */
export function reduceBattleRequest(state, request, {now, epoch, connected} = {}) {
  state.updatedAt = stamp(now);
  const ppObservation = ppEpoch(state, epoch, connected);
  if (!request || typeof request !== 'object') { invalidateOwnPpObservation(state, 'Missing private request'); state.request = null; return state; }
  if (ppObservation) {
    if (!Number.isSafeInteger(request.rqid) || ppObservation.lastRequestRqid !== null && request.rqid !== ppObservation.lastRequestRqid + 1) invalidateOwnPpObservation(state, 'Missing/replayed private request');
    ppObservation.lastRequestRqid = request.rqid;
  }
  state.request = {rqid: request.rqid ?? null, wait: !!request.wait, teamPreview: !!request.teamPreview,
    forceSwitch: request.forceSwitch || null, source: 'server-request'};
  const sideID = request.side?.id;
  if (!/^p[1-4]$/.test(sideID || '') || !Array.isArray(request.side.pokemon)) { invalidateOwnPpObservation(state, 'Incomplete private party request'); return state; }
  if (state.ownSide && state.ownSide !== sideID) invalidateOwnPpObservation(state, 'Private request own-side identity changed');
  state.ownSide = sideID;
  const side = sideFor(state, sideID), used = new Set(), nextActive = {}, priorActive = {...side.active}, priorSelected = side.pokemon.filter(p => p.selection === 'selected').map(p => p.id);
  let activeIndex = 0;
  for (const [index, entry] of request.side.pokemon.entries()) {
    const ref = identity(entry.ident) || {side: sideID, slot: null, nickname: null};
    // Preview requests mark the default first members active before selection.
    // Those flags are not observed battle positions and must not strand a lead
    // in the wrong slot when the chosen party is reordered.
    const slot = !request.teamPreview && entry.active ? String.fromCharCode(97 + activeIndex++) : null;
    const species = speciesOf(entry.details);
    let p = slot ? side.pokemon.find(mon => mon.id === side.active[slot] && (!ref.nickname || mon.nickname === ref.nickname) && (!species || mon.species === species)) : null;
    if (!p) {
      const candidates = side.pokemon.filter(mon => !used.has(mon.id) && mon.nickname === ref.nickname && mon.species === species && (slot || !mon.activeSlot));
      if (candidates.length === 1) p = candidates[0];
      else { p = newPokemon(state, ref, entry.details); if (candidates.length > 1) p.identityConfidence = 'ambiguous-duplicate'; }
    }
    used.add(p.id);
    p.nickname = ref.nickname; p.species = species; p.details = entry.details || null; p.requestIndex = index + 1;
    p.selection = request.teamPreview ? 'unknown' : 'selected';
    p.activeSlot = slot;
    if (slot) nextActive[slot] = p.id;
    health(state, p, entry.condition, 'request');
    if (entry.stats && typeof entry.stats === 'object') p.requestStats = {values: clone(entry.stats), source: 'server-request', meaning: 'server-reported stats; not calculated effective Speed', atTurn: state.turn};
    if (typeof entry.ability === 'string') { p.ability = entry.ability || null; p.abilitySuppressed = false; }
    if (typeof entry.item === 'string') { p.item = entry.item || null; p.itemKnown = true; }
    if (Array.isArray(entry.moves)) for (const move of entry.moves) if (!p.moves.includes(move)) p.moves.push(move);
  }
  // An absent preview member may simply be unselected; do not mark it fainted.
  for (const p of side.pokemon) if (!used.has(p.id)) { p.activeSlot = null; p.requestIndex = null; p.ownPpSnapshot = null; p.selection = request.teamPreview ? 'unknown' : 'not-in-current-request'; }
  side.active = nextActive;
  if (!request.teamPreview) {
    if (priorSelected.length && (priorSelected.length !== used.size || priorSelected.some(value => !used.has(value)))) invalidateOwnPpObservation(state, 'Unexplained private selected-party identity change');
    if (JSON.stringify(priorActive) !== JSON.stringify(nextActive) || side.pokemon.some(p => p.identityConfidence === 'ambiguous-duplicate')) invalidateOwnPpObservation(state, 'Unexplained request-only or ambiguous active identity');
    let slot = 0;
    for (const [index,entry] of request.side.pokemon.entries()) {
      const p = side.pokemon.find(mon => mon.requestIndex === index + 1);
      if (!p) continue;
      if (entry.active) {
        const moves = request.active?.[slot++]?.moves;
        p.ownPpSnapshot = ppObservation && sameMoves(moves?.map(move => move.id ?? move.move),entry.moves) && moves.every(move => Number.isInteger(move.pp) && move.pp >= 0 && move.pp <= 64) ?
          {version:1,status:'active-request',actorId:p.id,ident:entry.ident,details:entry.details,moves:entry.moves.map(id),pp:moves.map(move => move.pp),requestState:{item:entry.item,ability:entry.ability,condition:entry.condition},
            rqid:request.rqid,epoch:ppObservation.epoch,requestSequence:ppObservation.sequence,observedAt:stamp(now),continuous:ppObservation.continuous === true} : null;
      } else if (p.ownPpSnapshot?.status === 'bench-retained') {
        const value = {...p.ownPpSnapshot,benchVerifiedRqid:request.rqid,benchVerifiedSequence:ppObservation?.sequence};
        p.ownPpSnapshot = value;
        try { validateOwnReservePpSnapshot({pokemon:p,requestEntry:entry,observation:ppObservation,rqid:request.rqid}); }
        catch { p.ownPpSnapshot = null; }
      }
    }
  }
  return state;
}

/** JSON-safe and detached from the mutable reducer state. */
export function battleStateSnapshot(state, {now} = {}) {
  const result = clone({turn: state.turn, gen: state.gen, gameType: state.gameType, tier: state.tier,
    ownSide: state.ownSide, ended: state.ended, result: state.result, updatedAt: state.updatedAt,
    field: state.field, ...(state.ownPpObservation ? {ownPpObservation:state.ownPpObservation} : {}), sides: Object.values(state.sides).map(side => ({id: side.id, name: side.name,
      teamSize: side.teamSize, preview: side.preview, active: Object.entries(side.active).map(([slot, pokemon]) => ({slot, pokemon})),
      reserves: side.pokemon.filter(p => !p.activeSlot && p.selection !== 'not-in-current-request').map(p => p.id), pokemon: side.pokemon, conditions: side.conditions})),
    lastMove: state.lastMove, request: state.request,
    unknowns: ['Opposing exact HP, unrevealed sets, selected reserves, and effective Speed are not inferred.'], warnings: state.warnings});
  const decorate = c => {
    if (!c) return;
    c.remainingTurns = c.duration && Number.isInteger(c.elapsedUpkeeps) ? {
      min: Math.max(0, c.duration.min - c.elapsedUpkeeps), max: Math.max(0, c.duration.max - c.elapsedUpkeeps),
      includesCurrentTurnBeforeUpkeep: true, source: c.duration.source,
    } : null;
    // Actual end events are authoritative. Never silently expire a condition.
    if (c.remainingTurns && c.remainingTurns.max === 0) { c.remainingTurns = null; c.durationWarning = 'Expected duration elapsed without an observed end event; remaining duration unknown'; }
  };
  for (const c of [result.field.weather, result.field.terrain, ...Object.values(result.field.conditions),
    ...result.sides.flatMap(side => Object.values(side.conditions))]) decorate(c);
  if (now !== undefined) result.observedAt = stamp(now);
  return result;
}
