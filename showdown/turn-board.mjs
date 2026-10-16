// A bounded projection of observations, never a simulator or a choice generator.
// Keep the private request's legal action structure in AgentSession unchanged.
const clone = value => value === undefined ? null : structuredClone(value);
const CRITICAL = new Set(['start','turn','switch','drag','replace','detailschange','-formechange','-mega',
  'move','cant','faint','-damage','-heal','-status','-curestatus','-boost','-unboost','-setboost',
  '-clearboost','-clearallboost','-clearpositiveboost','-clearnegativeboost','-copyboost','-swapboost','-invertboost','-ability','-endability',
  '-item','-enditem','-weather','-fieldstart','-fieldend','-sidestart','-sideend','-start','-end',
  '-singleturn','-singlemove','-activate','-immune','-fail','-miss','-crit','-supereffective',
  '-resisted','-notarget','win','tie','error']);

function recentEvents(lines) {
  const turns = [];
  for (let index = 0; index < lines.length; index++) if (lines[index].startsWith('|turn|')) turns.push(index);
  // The newest turn marker often precedes a fresh request. Include the prior
  // turn's reveals too, rather than dropping its weather/Mega/item changes.
  const start = turns.length > 1 ? turns.at(-2) : turns[0] ?? 0;
  const relevant = lines.slice(start).filter(line => CRITICAL.has(line.split('|', 3)[1]));
  return {lines: relevant.slice(-40), available: relevant.length, omitted: Math.max(0,relevant.length-40), truncated: relevant.length > 40,
    ...(relevant.length>40?{warning:'Critical-event window truncated; current state and observed move reveals are retained. Full observations remain available in battle_status.'}:{}),scope: 'latest-two-observed-turns'};
}

function pokemonView(pokemon) {
  return {id: pokemon.id, nickname: pokemon.nickname, species: pokemon.species,
    activeSlot: pokemon.activeSlot, requestIndex: pokemon.requestIndex,
    identityConfidence: pokemon.identityConfidence, hp: clone(pokemon.hp),
    status: pokemon.status, fainted: pokemon.fainted, boosts: clone(pokemon.boosts),
    ability: pokemon.ability, abilitySuppressed: pokemon.abilitySuppressed,
    item: pokemon.item, itemKnown: pokemon.itemKnown, itemHistory: clone(pokemon.itemHistory),
    mega: clone(pokemon.mega), moves: clone(pokemon.moves), volatiles: clone(pokemon.volatiles), selection: pokemon.selection};
}

export function compactTurnBoard(snapshot, {request, events = []} = {}) {
  if (!snapshot) return null;
  const currentParty = !request?.teamPreview && Array.isArray(request?.side?.pokemon);
  return {turn: snapshot.turn, ownSide: snapshot.ownSide, observedAt: snapshot.observedAt,
    updatedAt: snapshot.updatedAt, field: clone(snapshot.field), request: clone(snapshot.request),
    sides: (snapshot.sides || []).map(side => {
      const own = side.id === snapshot.ownSide;
      const pokemon = side.pokemon.filter(p => !own || !currentParty ||
        p.selection === 'selected' && Number.isInteger(p.requestIndex) &&
        p.requestIndex >= 1 && p.requestIndex <= request.side.pokemon.length);
      const present = new Set(pokemon.map(p => p.id));
      const selectedTeamSize = request?.teamPreview ? null : own && currentParty ? request.side.pokemon.length : side.teamSize ?? null;
      return {id: side.id, selectedTeamSize,
        selectionKnowledge: own ? currentParty ? 'current-own-request' : 'preview-only' : 'observed-opponents-only',
        // An empty list of observed reserves does not establish that there are
        // no unrevealed opposing selections. Null means the count is unknown.
        unrevealedSelected: request?.teamPreview ? null : own && currentParty ? 0 : !own && Number.isInteger(selectedTeamSize) ?
          Math.max(0, selectedTeamSize - pokemon.length) : null,
        active: side.active.filter(active => present.has(active.pokemon)),
        reserves: pokemon.filter(p => !p.activeSlot && p.fainted !== true).map(p => p.id),
        pokemon: pokemon.map(pokemonView), conditions: clone(side.conditions)};
    }), recentEvents: recentEvents(events), lastMove: clone(snapshot.lastMove), warnings: clone(snapshot.warnings),
    uncertainty: 'Opposing HP is the server display; unseen selections and unknown stats remain unknown. Registered open sheets do not reveal the opposing selected four or investments.'};
}
