/**
 * An observation-only Showdown protocol reducer. Counts are derived from executed
 * server events, never from selected choices, calculated damage, or assumed sets.
 * Supply each protocol event once, in server order. Private requests are used only
 * for own identity/selection; they, chat and authentication data are not retained.
 */
const id = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (value, max = 160) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max);
const speciesOf = value => text(value).split(',')[0].trim();
const family = value => id(speciesOf(value).replace(/-(?:Mega(?:-[XYZ])?|Primal|Gmax|Blade|Hero|School|Busted|Noice|Hangry|Zen|Zen-Galar|Complete)$/i, ''));
const refOf = value => {
  const match = /^(p[1-4])([a-f])?:\s*(.*)$/.exec(String(value ?? ''));
  return match ? {side: match[1], slot: match[2] || null, nickname: text(match[3])} : null;
};
const timeOf = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const counter = () => ({switchIns: 0, faints: 0, knockouts: 0, indirectKnockouts: 0, itemRemovals: 0, couldNotAct: 0});
const moveCounter = move => ({move, uses: 0, calledUses: 0, failed: 0, missed: 0, blocked: 0, knockouts: 0, itemRemovals: 0});
const PROTECTION = new Set(['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'wideguard', 'quickguard', 'matblock', 'craftyshield', 'maxguard']);

/** Remove the password capability suffix from a battle room before persistence. */
export function normalizeRoomId(value) {
  const room = String(value ?? '').trim().replace(/^https?:\/\/(?:play\.|replay\.)?pokemonshowdown\.com\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
  if (!/^(?:battle-|game-bestof\d+-)[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(room)) return null;
  return room.toLowerCase().replace(/-[a-z0-9]+pw$/, '');
}

export function analyzeBattle({roomId, username, teamId, team = [], events = [], parentId = null, metadata = {}} = {}) {
  const warnings = new Set();
  const warn = message => warnings.add(message);
  const players = {p1: null, p2: null};
  let ownSide = null;
  for (const event of events) {
    if (event?.type === 'player' && ['p1', 'p2'].includes(event.data?.[0])) players[event.data[0]] = text(event.data[1]);
  }
  for (const [side, name] of Object.entries(players)) if (name && id(name) === id(username)) ownSide = side;
  for (const event of events) {
    const side = event?.type === 'request' ? event.request?.side : null;
    if (!side || !['p1', 'p2'].includes(side.id)) continue;
    if (ownSide && ownSide !== side.id) warn('Private request side conflicts with the named player; request selection was ignored.');
    else if (!ownSide && (!side.name || id(side.name) === id(username))) ownSide = side.id;
  }
  if (!ownSide) warn('Own player side is unknown; personal metrics cannot be attributed.');

  const actors = [], appearances = [], active = new Map(), lastAppearance = new Map(), leadSlots = new Set();
  const preview = {p1: [], p2: []};
  let nextUnknown = 1;
  const createActor = ({species, nickname, side, index = null, uncertain = false}) => {
    const actor = {key: index === null ? `observed-${side}-${nextUnknown++}` : `${id(species)}:${index + 1}`,
      species: species || 'Unknown', nickname: nickname || species || '', side, registered: index !== null,
      selected: false, requestSelected: false, identityConfidence: uncertain ? 'ambiguous' : 'observed'};
    actors.push(actor); return actor;
  };
  for (const [index, set] of team.entries()) {
    const species = speciesOf(set?.species || set?.name);
    if (species) createActor({species, nickname: text(set?.name || species), side: ownSide, index});
  }
  const findActor = (ref, species = '') => {
    const candidates = actors.filter(actor => actor.side === ref.side);
    const exact = species && candidates.filter(actor => id(actor.species) === id(species));
    const related = species && candidates.filter(actor => family(actor.species) === family(species));
    const named = candidates.filter(actor => id(actor.nickname) === id(ref.nickname));
    const namedRelated = named.filter(actor => !species || family(actor.species) === family(species));
    if (namedRelated.length === 1) return namedRelated[0];
    if (exact?.length === 1) return exact[0];
    if (related?.length === 1) return related[0];
    if (!species && named.length === 1) return named[0];
    if (ref.side === ownSide && (exact?.length > 1 || related?.length > 1 || namedRelated.length > 1)) {
      warn('Duplicate or ambiguous own identities were kept separate rather than merged.');
      return createActor({species, nickname: ref.nickname, side: ref.side, uncertain: true});
    }
    if (ref.side === ownSide && team.length) warn(`Observed own Pokémon ${species || ref.nickname} could not be matched to a registered set.`);
    const previewMatches = species && ref.side !== ownSide ? (preview[ref.side] || []).filter(entry => family(entry) === family(species)) : [];
    // Use the uniquely matching registered preview identity for battle formes,
    // while keeping regional and Rotom formes distinct. Never infer a Mega use.
    const observedSpecies = previewMatches.length === 1 ? previewMatches[0] : species || ref.nickname;
    return createActor({species: observedSpecies, nickname: ref.nickname, side: ref.side});
  };
  const newAppearance = (actor, ref, species = '', {entered = false, lead = false} = {}) => {
    const appearance = {actor, nickname: ref.nickname, side: ref.side, slot: ref.slot, forms: new Set(species ? [species] : []),
      lead, counts: counter(), moves: new Map(), fainted: false, lethal: null, megaEvolved: false};
    if (entered) appearance.counts.switchIns++;
    appearances.push(appearance); lastAppearance.set(actor, appearance);
    if (ref.slot) active.set(`${ref.side}${ref.slot}`, appearance);
    actor.selected = true;
    return appearance;
  };
  const getAppearance = (value, {create = false} = {}) => {
    const ref = refOf(value); if (!ref) return null;
    if (ref.slot && active.has(`${ref.side}${ref.slot}`)) return active.get(`${ref.side}${ref.slot}`);
    const matches = appearances.filter(appearance => appearance.side === ref.side && id(appearance.nickname) === id(ref.nickname));
    const unique = [...new Set(matches.map(appearance => appearance.actor))];
    if (unique.length === 1) return lastAppearance.get(unique[0]);
    if (!create) return null;
    return newAppearance(findActor(ref), ref);
  };
  const moveRow = (appearance, move) => {
    const key = id(move);
    if (!appearance.moves.has(key)) appearance.moves.set(key, moveCounter(text(move)));
    return appearance.moves.get(key);
  };
  let turn = 0, started = false, completed = false, outcome = 'unknown', selectionKnown = false;
  let startedAt = timeOf(metadata.startedAt), endedAt = timeOf(metadata.endedAt), firstAt = null;
  let context = null;
  const flagAttempt = flag => {
    if (!context || context.flags.has(flag)) return;
    context.flags.add(flag); context.row[flag]++;
  };
  const sourceOf = parts => {
    const of = parts.find(part => typeof part === 'string' && part.startsWith('[of] '));
    return of ? getAppearance(of.slice(5)) : null;
  };
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const {type} = event, parts = Array.isArray(event.data) ? event.data.map(value => typeof value === 'string' ? value : '') : [];
    const at = timeOf(event.at); firstAt ||= at;
    if (type === 'request') {
      const request = event.request, side = request?.side;
      if (!side || side.id !== ownSide || !Array.isArray(side.pokemon)) continue;
      // A waiting preview request may still expose all six registered sets. In
      // Champions, a four-Pokémon waiting side can establish the selected four;
      // an active/forced-switch request also establishes selection directly.
      const actualSelection = request.teamPreview !== true && (Array.isArray(request.active) || Array.isArray(request.forceSwitch) || (request.wait === true && side.pokemon.length === 4));
      if (actualSelection) {
        selectionKnown = true;
        // A post-preview private side is the selected team, including unseen reserves.
        for (const actor of actors.filter(actor => actor.side === ownSide)) actor.requestSelected = false;
      }
      for (const pokemon of side.pokemon) {
        const ref = refOf(pokemon?.ident); if (!ref || ref.side !== ownSide) continue;
        const actor = findActor(ref, speciesOf(pokemon.details));
        if (actualSelection) { actor.requestSelected = true; actor.selected = true; }
      }
      continue;
    }
    if (type === 'poke' && preview[parts[0]] && speciesOf(parts[1])) preview[parts[0]].push(speciesOf(parts[1]));
    if (type === 'start') { started = true; startedAt ||= at; context = null; }
    else if (type === 'turn') {
      const next = Number(parts[0]);
      if (Number.isSafeInteger(next) && next > 0) {
        if (turn > 0 && next <= turn) warn('Repeated or backward turn markers make overlapping history ambiguous; totals may contain repeated observations.');
        if ((turn === 0 && next > 1) || next > turn + 1) warn('Turn observations contain a gap; metrics describe only observed events.');
        turn = Math.max(turn, next);
      }
      context = null;
    } else if (['switch', 'drag'].includes(type)) {
      const ref = refOf(parts[0]); if (!ref?.slot) continue;
      const actor = findActor(ref, speciesOf(parts[1]));
      const leadSlot = `${ref.side}${ref.slot}`;
      const lead = started && turn === 0 && ['a', 'b'].includes(ref.slot) && !leadSlots.has(leadSlot);
      if (started && turn === 0) leadSlots.add(leadSlot);
      newAppearance(actor, ref, speciesOf(parts[1]), {entered: true, lead});
      context = null;
    } else if (type === 'replace') {
      const ref = refOf(parts[0]), appearance = getAppearance(parts[0]);
      if (!ref || !appearance) { warn('An identity replacement was observed without its original switch.'); continue; }
      const actor = findActor(ref, speciesOf(parts[1]));
      appearance.actor = actor; appearance.nickname = ref.nickname; appearance.identityUncertain = false;
      appearance.forms = new Set([speciesOf(parts[1])]); actor.selected = true; lastAppearance.set(actor, appearance);
      warn('Illusion identity was corrected from the server replacement; that appearance’s actions use the revealed actor.');
    } else if (['detailschange', '-formechange'].includes(type)) {
      const appearance = getAppearance(parts[0]);
      if (appearance && speciesOf(parts[1])) appearance.forms.add(speciesOf(parts[1]));
    } else if (type === '-mega') {
      const appearance = getAppearance(parts[0]);
      if (appearance) appearance.megaEvolved = true;
      else warn('A Mega event had no observed actor; no Mega use was inferred from registration.');
    } else if (type === 'swap') {
      const ref = refOf(parts[0]), appearance = getAppearance(parts[0]);
      const slot = /^[0-5]$/.test(parts[1]) ? String.fromCharCode(97 + Number(parts[1])) : refOf(parts[1])?.slot;
      if (ref?.slot && slot && appearance) {
        const other = active.get(`${ref.side}${slot}`);
        active.set(`${ref.side}${slot}`, appearance); appearance.slot = slot;
        if (other) { active.set(`${ref.side}${ref.slot}`, other); other.slot = ref.slot; }
        else active.delete(`${ref.side}${ref.slot}`);
      }
    } else if (type === 'move') {
      const appearance = getAppearance(parts[0], {create: true});
      if (!appearance || !parts[1]) { warn('A move lacked an attributable actor.'); context = null; continue; }
      const row = moveRow(appearance, parts[1]); row.uses++;
      const called = parts.some(part => part.startsWith('[from] '));
      if (called) row.calledUses++;
      context = {appearance, row, move: parts[1], flags: new Set()};
    } else if (type === 'cant') {
      const appearance = getAppearance(parts[0]); if (appearance) appearance.counts.couldNotAct++;
      context = null;
    } else if (['-fail', '-notarget'].includes(type)) flagAttempt('failed');
    else if (type === '-miss') flagAttempt('missed');
    else if (['-immune', '-block'].includes(type)) flagAttempt('blocked');
    else if (type === '-activate' && PROTECTION.has(id(parts[1]?.replace(/^move:\s*/, ''))) && context) {
      const target = getAppearance(parts[0]);
      if (target && target.side !== context.appearance.side) flagAttempt('blocked');
    } else if (type === '-damage') {
      const target = getAppearance(parts[0]); if (!target) continue;
      target.lethal = null;
      if (!/^0(?:\s|\/|$)/.test(parts[1])) continue;
      const from = parts.find(part => part.startsWith('[from] '));
      const explicitSource = sourceOf(parts);
      if (from) {
        // Recoil, weather, statuses, contact abilities and all other labelled
        // secondary damage never become direct attack KOs.
        if (explicitSource && explicitSource !== target && explicitSource.side !== target.side) {
          target.lethal = {source: explicitSource, indirect: true};
        }
      } else if (context && context.appearance !== target && context.appearance.side !== target.side) {
        target.lethal = {source: context.appearance, row: context.row, indirect: false};
      }
    } else if (type === '-heal') {
      const appearance = getAppearance(parts[0]);
      if (appearance) { appearance.lethal = null; if (!/^0(?:\s|\/|$)/.test(parts[1])) appearance.fainted = false; }
    } else if (type === 'faint') {
      const appearance = getAppearance(parts[0]); if (!appearance || appearance.fainted) continue;
      appearance.fainted = true; appearance.counts.faints++;
      const cause = appearance.lethal;
      if (cause) {
        if (cause.indirect) cause.source.counts.indirectKnockouts++;
        else { cause.source.counts.knockouts++; cause.row.knockouts++; }
      } else if (appearance.side !== ownSide) warn('An opposing faint had no confirmed attacking source; no direct KO was assigned.');
      appearance.lethal = null;
    } else if (type === '-enditem') {
      const from = parts.find(part => part.startsWith('[from] move: '));
      if (!from || parts.includes('[eat]')) continue;
      const move = from.slice('[from] move: '.length), target = getAppearance(parts[0]);
      const source = sourceOf(parts) || (context && id(context.move) === id(move) ? context.appearance : null);
      if (!source || !target || source.side === target.side) continue;
      source.counts.itemRemovals++; moveRow(source, move).itemRemovals++;
    } else if (type === '-ability' && id(parts[1]) === 'illusion') {
      const appearance = getAppearance(parts[0]);
      if (appearance) appearance.identityUncertain = true;
      warn('Illusion was observed; identities without a subsequent replacement may be incomplete.');
    } else if (type === 'upkeep') context = null;
    else if (type === 'win') {
      completed = true; endedAt ||= at;
      outcome = !ownSide ? 'unknown' : id(parts[0]) === id(username) ? 'win' : 'loss'; context = null;
    } else if (type === 'tie') { completed = true; outcome = 'tie'; endedAt ||= at; context = null; }
  }
  if (!started) warn('The battle start marker is missing; the recording may be partial.');
  if (!completed) warn('No official result was observed; this battle is incomplete.');
  if (!selectionKnown) warn('Full selected team is unknown; only observed Pokémon are counted as selected.');
  for (const appearance of appearances.filter(appearance => appearance.identityUncertain)) {
    // Keep observed actions available without assigning them to the apparent
    // teammate. A later replace event above would have resolved this identity.
    appearance.actor = createActor({species: 'Unknown (Illusion)', nickname: '', side: appearance.side, uncertain: true});
    appearance.forms.clear();
    warn('An unresolved Illusion identity was kept ambiguous rather than attributed to the apparent teammate.');
  }
  const ownActors = actors.filter(actor => actor.side === ownSide);
  const pokemon = ownActors.map(actor => {
    const mine = appearances.filter(appearance => appearance.actor === actor), counts = counter(), moves = new Map(), forms = new Set();
    // Keep known but unused moves visible in team reviews. This is registration
    // data only; zero does not assert that an unseen reserve entered the field.
    if(actor.registered){
      const set=team.find(set=>id(set.species||set.name)===id(actor.species));
      for(const move of set?.moves||[])moves.set(id(move),moveCounter(text(move)));
    }
    for (const appearance of mine) {
      for (const field of Object.keys(counts)) counts[field] += appearance.counts[field];
      for (const form of appearance.forms) if (form) forms.add(form);
      for (const [key, observed] of appearance.moves) {
        if (!moves.has(key)) moves.set(key, moveCounter(observed.move));
        const merged = moves.get(key);
        for (const field of Object.keys(merged)) if (field !== 'move') merged[field] += observed[field];
      }
    }
    const selected = selectionKnown ? actor.requestSelected || mine.length > 0 : mine.length > 0;
    return {key: actor.key, species: actor.species, forms: [...forms], selected, lead: mine.some(appearance => appearance.lead),
      megaEvolved: mine.some(appearance => appearance.megaEvolved),
      ...counts, moves: [...moves.values()], identityConfidence: actor.identityConfidence};
  });
  const opponent = ownSide === 'p1' ? 'p2' : ownSide === 'p2' ? 'p1' : null;
  const opponentActors = opponent ? [...new Set(appearances.filter(appearance => appearance.side === opponent).map(appearance => appearance.actor))] : [];
  const opponentRoster = opponent ? (preview[opponent].length ? preview[opponent] : opponentActors.map(actor => actor.species)) : [];
  const opponentSelected = opponentActors.map(actor => actor.species);
  const opponentLeads = opponentActors.filter(actor => appearances.some(appearance => appearance.actor === actor && appearance.lead)).map(actor => actor.species);
  const opponentSelectionKnown = opponentActors.length === 4 && new Set(opponentSelected.map(id)).size === 4 && opponentActors.every(actor => actor.identityConfidence !== 'ambiguous');
  const opponentMega = opponentActors.filter(actor => appearances.some(appearance => appearance.actor === actor && appearance.megaEvolved)).map(actor => actor.species);
  return {schemaVersion: 1, roomId: normalizeRoomId(roomId), parentId: normalizeRoomId(parentId), teamId: text(teamId, 128),
    username: text(username), ownSide, outcome, completed, turns: turn, players, opponentRoster,
    opponentSelected, opponentLeads, opponentSelectionKnown, opponentMega,
    selected: pokemon.filter(actor => actor.selected).map(actor => actor.species), selectionKnown,
    leads: pokemon.filter(actor => actor.lead).map(actor => actor.species), pokemon,
    quality: {complete: started && completed && !!ownSide && ![...warnings].some(message => /gap|ambiguous|could not be matched/i.test(message)),
      operational: metadata.operational !== false, warnings: [...warnings]},
    metadata: {startedAt: startedAt || firstAt, endedAt}};
}
