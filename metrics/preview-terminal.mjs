const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
const FORMAT = /^gen9championsvgc2026regmc(?:bo3)?$/u;
const PREVIEW_TYPES = new Set(['gametype', 'gen', 'tier', 'player', 'poke', 'teamsize', 'teampreview', 'request', 'win']);
const COUNTERS = ['switchIns', 'faints', 'knockouts', 'indirectKnockouts', 'itemRemovals', 'couldNotAct'];
const MOVE_COUNTERS = ['uses', 'calledUses', 'failed', 'missed', 'blocked', 'knockouts', 'itemRemovals'];

export function validPreviewCorroboration(value, game) {
  return value?.kind === 'legacy-owned-session-preview' && value.teamId === game?.teamId && value.roomId === game?.roomId && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 100 && /^[a-f0-9]{64}$/u.test(value.snapshotSha256 ?? '') && Number.isFinite(Date.parse(value.observedAt)) && value.earlierStartObservation === 'unavailable';
}

function previewIdentity(game) {
  if (!game?.completed || game.turns !== 0 || !['win', 'loss'].includes(game.outcome) || !['p1', 'p2'].includes(game.ownSide)) return null;
  if (game.leads?.length || game.opponentLeads?.length || game.pokemon?.some(pokemon => pokemon.lead || pokemon.megaEvolved || COUNTERS.some(key => pokemon[key] > 0) || pokemon.moves?.some(move => MOVE_COUNTERS.some(key => move[key] > 0)))) return null;
  const players = { p1: normalize(game.players?.p1), p2: normalize(game.players?.p2) };
  if (!players.p1 || !players.p2 || players.p1 === players.p2 || players[game.ownSide] !== normalize(game.username)) return null;
  return { teamId: game.teamId, roomId: game.roomId, players, ownSide: game.ownSide, winner: players[game.outcome === 'win' ? game.ownSide : game.ownSide === 'p1' ? 'p2' : 'p1'], outcome: game.outcome, kind: 'preview-terminal' };
}

/** A pre-start terminal is established by private local state, never a URL-only replay. */
export function previewTerminalProof(events, game, previewObservation) {
  const proof = previewIdentity(game);
  if (!Array.isArray(events) || !proof) return null;
  const { players } = proof;
  let preview = false, request = false, format = false, doubles = false, terminal = null;
  const observed = new Set();
  for (const event of events) {
    if (!PREVIEW_TYPES.has(event?.type)) return null;
    if (terminal && event.type !== 'player') return null;
    const data = event.data ?? [];
    if (event.type === 'player') {
      if (!['p1', 'p2'].includes(data[0])) return null;
      const name = normalize(data[1]);
      if (name && name !== players[data[0]]) return null;
      if (name) observed.add(data[0]);
    }
    if (event.type === 'tier') { if (!FORMAT.test(normalize(data[0]))) return null; format = true; }
    if (event.type === 'gametype') { if (data[0] !== 'doubles') return null; doubles = true; }
    if (event.type === 'teampreview') preview = true;
    if (event.type === 'request') {
      const value = event.request;
      if (!preview || value?.teamPreview !== true || Array.isArray(value.active) || Array.isArray(value.forceSwitch) || value.side?.id !== game.ownSide || normalize(value.side?.name) !== players[game.ownSide] || value.side?.pokemon?.length !== 6) return null;
      request = true;
    }
    if (event.type === 'win') {
      const winner = normalize(data[0]);
      if (!preview || !Object.values(players).includes(winner) || (winner === players[game.ownSide] ? 'win' : 'loss') !== game.outcome) return null;
      terminal = { winner };
    }
  }
  return preview && (request || ownedPreviewProof(game, previewObservation)) && format && doubles && terminal && observed.size === 2
    ? proof
    : null;
}

/** Retain actual bounded status fields, without manufacturing a protocol request. */
export function ownedPreviewObservation(snapshot, game) {
  const proof = previewIdentity(game);
  if (!proof || !corroboratesPreviewState(snapshot, proof)) return null;
  const room = snapshot.rooms.find(value => String(value.id ?? '').replace(/-[a-z0-9]+pw$/u, '') === game.roomId);
  const { state } = room;
  return {
    kind: 'owned-session-preview-state', source: 'battle_status', observedAt: new Date().toISOString(),
    sessionId: snapshot.sessionId, username: snapshot.username, connected: snapshot.connected, authenticated: snapshot.authenticated,
    rooms: [{ id: game.roomId, teamId: room.teamId, ended: room.ended, result: room.result,
      state: { ended: state.ended, result: state.result, turn: state.turn, lastMove: state.lastMove, gameType: state.gameType, tier: state.tier, ownSide: state.ownSide,
        request: { rqid: state.request.rqid, teamPreview: state.request.teamPreview, forceSwitch: state.request.forceSwitch },
        sides: state.sides.map(side => ({ id: side.id, name: side.name, active: side.active,
          pokemon: side.pokemon.map(pokemon => ({ selection: pokemon.selection, fainted: pokemon.fainted, previousAppearances: pokemon.previousAppearances })) })),
      },
    }],
  };
}

export function ownedPreviewProof(game, observation) {
  const proof = previewIdentity(game);
  return proof && observation?.kind === 'owned-session-preview-state' && observation.source === 'battle_status' && Number.isFinite(Date.parse(observation.observedAt)) && corroboratesPreviewState(observation, proof) ? proof : null;
}

/** Corroborate legacy evidence through the owned live reducer, which never resets progress on a rejoin. */
export function corroboratesPreviewState(snapshot, proof) {
  if (!proof || !snapshot?.connected || !snapshot.authenticated || typeof snapshot.sessionId !== 'string' || normalize(snapshot.username) !== proof.players[proof.ownSide]) return false;
  const room = snapshot.rooms?.find(value => String(value.id ?? '').replace(/-[a-z0-9]+pw$/u, '') === proof.roomId);
  const state = room?.state;
  if (room?.teamId !== proof.teamId || room.ended !== true || room.result?.type !== 'win' || normalize(room.result.winner) !== proof.winner || state?.ended !== true || state.result?.type !== 'win' || normalize(state.result.winner) !== proof.winner || state.turn !== 0 || state.lastMove !== null || state.gameType !== 'doubles' || !FORMAT.test(normalize(state.tier)) || state.ownSide !== proof.ownSide || state.request?.teamPreview !== true || state.request.forceSwitch) return false;
  const own = state.sides?.find(side => side.id === proof.ownSide), foe = state.sides?.find(side => side.id !== proof.ownSide);
  return Boolean(own && foe && state.sides.length === 2 && normalize(own.name) === proof.players[own.id] && normalize(foe.name) === proof.players[foe.id] && own.pokemon?.length === 6 && own.pokemon.every(pokemon => pokemon.selection === 'unknown' && !pokemon.fainted && !pokemon.previousAppearances?.length) && foe.active?.length === 0 && foe.pokemon?.length === 0);
}
