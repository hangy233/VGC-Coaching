import {createHash} from 'node:crypto';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const fainted = pokemon => / fnt$/.test(pokemon?.condition || '');
const reviving = (request, index) => !!request.forceSwitch?.[index] && !!request.side?.pokemon?.[index]?.reviving;

// Neither array position, HP nor active status is part of this identity. A
// repeated ident/details pair is deliberately ambiguous rather than guessed.
function pokemonId(pokemon) {
  if (typeof pokemon?.ident !== 'string' || !pokemon.ident || typeof pokemon.details !== 'string' || !pokemon.details) return null;
  return `pokemon-${createHash('sha256').update(JSON.stringify([pokemon.ident, pokemon.details])).digest('hex').slice(0, 24)}`;
}

function switchSlot(request, action, revival) {
  const hasSlot = action.slot !== undefined, hasIdentity = action.pokemonId !== undefined;
  check(!(hasSlot && hasIdentity), 'Choose a switch slot or pokemonId, not both');
  if (hasIdentity) {
    check(typeof action.pokemonId === 'string' && action.pokemonId.length > 0, 'Invalid switch pokemonId');
    const matches = (request.side?.pokemon || []).flatMap((pokemon, index) => pokemonId(pokemon) === action.pokemonId ? [index + 1] : []);
    check(matches.length === 1, 'Switch pokemonId is missing or ambiguous; inspect fresh replacements');
    return matches[0];
  }
  check(Number.isInteger(action.slot), revival ? 'Invalid revival target' : 'Invalid switch');
  return action.slot;
}

/** Compile a complete structured choice against a request, without I/O or state mutation. */
export function validateChoice(request, actions) {
  const q = request;
  check(q && !q.wait, 'No actionable request');
  check(Array.isArray(actions) && actions.length > 0 && actions.every(action => action && typeof action === 'object' && !Array.isArray(action)), 'Structured actions required');
  if (q.teamPreview) {
    check(actions.length === 1 && actions[0].type === 'team', 'Team-preview action required');
    const order = actions[0].order, count = q.maxChosenTeamSize || q.maxTeamSize || 4;
    check(Array.isArray(order) && order.length === count && new Set(order).size === order.length && order.every(index => Number.isInteger(index) && index >= 1 && index <= q.side?.pokemon?.length), 'Invalid team-preview order');
    return {choice:`team ${order.join('')}`, actions:[{type:'team', order:[...order]}]};
  }
  const slots = q.forceSwitch?.length || q.active?.length;
  check(slots === 2 && actions.length === slots, 'Both doubles slots required');
  const switches = new Set(); let megas = 0;
  const available = q.side?.pokemon?.filter(pokemon => !pokemon.active && !fainted(pokemon)).length || 0;
  const requiredSwitches = q.forceSwitch?.filter((required, index) => required && !reviving(q, index)).length || 0;
  const selectedSwitches = actions.filter((action, index) => action.type === 'switch' && !reviving(q, index)).length;
  if (q.forceSwitch) check(selectedSwitches === Math.min(available, requiredSwitches), 'All available forced replacements required');
  const canonical = [];
  const choice = actions.map((action, index) => {
    if (action.type === 'pass') {
      check(q.forceSwitch ? (q.forceSwitch[index] === false || !reviving(q, index) && requiredSwitches > available) : fainted(q.side?.pokemon?.[index]), 'Slot requires a decision');
      canonical.push({type:'pass'}); return 'pass';
    }
    if (action.type === 'switch') {
      const revival = reviving(q, index), slot = switchSlot(q, action, revival), pokemon = q.side?.pokemon?.[slot - 1];
      check(pokemon && (revival ? fainted(pokemon) : !pokemon.active && !fainted(pokemon)) && !switches.has(slot), revival ? 'Invalid revival target' : 'Invalid switch');
      check(!q.forceSwitch || q.forceSwitch[index], 'Slot does not need a forced switch');
      if (!revival) {check(!q.active?.[index]?.trapped, 'Active slot is trapped'); switches.add(slot);}
      canonical.push({type:'switch', slot}); return `switch ${slot}`;
    }
    check(action.type === 'move' && !q.forceSwitch, 'Move unavailable');
    const active = q.active[index], move = active?.moves?.[action.slot - 1];
    check(Number.isInteger(action.slot) && move && !move.disabled && move.pp !== 0, 'Move unavailable');
    check(action.target === undefined || [-2, -1, 1, 2].includes(action.target), 'Invalid target');
    const targeted = ['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe'].includes(move.target);
    if (targeted) {
      check(action.target !== undefined, 'Explicit target required');
      const self = -(index + 1);
      if (move.target === 'adjacentAlly') check(action.target < 0 && action.target !== self, 'Target must be the ally');
      if (move.target === 'adjacentAllyOrSelf') check(action.target < 0, 'Target must be ally or self');
      if (move.target === 'adjacentFoe') check(action.target > 0, 'Target must be a foe');
      if (['normal', 'any'].includes(move.target)) check(action.target !== self, 'Move cannot target self');
    } else check(action.target === undefined, 'Move does not accept a chosen target');
    if (action.mega) check(active.canMegaEvo && ++megas === 1, 'Mega unavailable');
    canonical.push({type:'move', slot:action.slot, ...(action.target === undefined ? {} : {target:action.target}), ...(action.mega ? {mega:true} : {})});
    return `move ${action.slot}${action.target === undefined ? '' : ` ${action.target}`}${action.mega ? ' mega' : ''}`;
  }).join(', ');
  return {choice, actions:canonical};
}

/** Named switch targets with the active positions that can currently select them. */
export function replacementOptions(request) {
  if (!request || request.wait || request.teamPreview) return [];
  const q = request, slots = q.forceSwitch?.length || q.active?.length;
  if (slots !== 2) return [];
  return (q.side?.pokemon || []).flatMap((pokemon, index) => {
    const forSlots = [0, 1].filter(activeIndex => {
      if (q.forceSwitch && !q.forceSwitch[activeIndex]) return false;
      return reviving(q, activeIndex) ? fainted(pokemon) : !pokemon.active && !fainted(pokemon) && !q.active?.[activeIndex]?.trapped;
    }).map(activeIndex => activeIndex + 1);
    if (!forSlots.length) return [];
    const id = pokemonId(pokemon), uniqueId = id && q.side.pokemon.filter(other => pokemonId(other) === id).length === 1 ? id : null;
    return [{slot:index + 1, pokemonId:uniqueId, name:typeof pokemon.ident === 'string' ? pokemon.ident.replace(/^p[1-4](?:[a-z])?:\s*/, '') : pokemon.details?.split(',')[0] || `Pokemon ${index + 1}`, ident:pokemon.ident ?? null, details:pokemon.details ?? null, condition:pokemon.condition ?? null, active:!!pokemon.active, revival:fainted(pokemon), forSlots}];
  });
}

/** Enumerate complete legal forced-switch pairs, including pass and revival. */
export function legalReplacementPairs(request) {
  if (!request?.forceSwitch || request.forceSwitch.length !== 2 || request.wait || request.teamPreview) return [];
  const options = replacementOptions(request);
  const candidates = [1, 2].map(activeSlot => [{type:'pass'}, ...options.filter(option => option.forSlots.includes(activeSlot)).map(option => ({type:'switch', slot:option.slot}))]);
  const pairs = [];
  for (const first of candidates[0]) for (const second of candidates[1]) {
    try {pairs.push(validateChoice(request, [first, second]).actions);} catch { /* Invalid combinations are not legal replacement choices. */ }
  }
  return pairs;
}
