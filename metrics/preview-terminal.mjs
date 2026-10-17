const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
const FORMAT = /^gen9championsvgc2026regmc(?:bo3)?$/u;
const PREVIEW_TYPES = new Set(['gametype', 'gen', 'tier', 'player', 'poke', 'teamsize', 'teampreview', 'request', 'win']);
const COUNTERS = ['switchIns', 'faints', 'knockouts', 'indirectKnockouts', 'itemRemovals', 'couldNotAct'];
const MOVE_COUNTERS = ['uses', 'calledUses', 'failed', 'missed', 'blocked', 'knockouts', 'itemRemovals'];
const HASH = /^[a-f0-9]{64}$/u;
const CHILD = /^battle-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const PARENT = /^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const canonicalRoom = value => String(value ?? '').replace(/-[a-z0-9]+pw$/u, '');

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
  return terminalProtocolProof(events, game, Boolean(ownedPreviewProof(game, previewObservation) || ownedParentPreviewProof(game, previewObservation) || historicalOwnedParentPreviewProof(game, previewObservation)));
}

function terminalProtocolProof(events, game, independentlyOwnedPreview = false) {
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
  return preview && (request || independentlyOwnedPreview) && format && doubles && terminal && observed.size === 2
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

/** Rejoins cannot recover a lost private request. Retain ownership separately. */
export function ownedParentPreviewObservation(snapshot, game, evidence) {
  if (!canonicalParentPreviewSource(evidence, game)) return null;
  const status = ownedParentStatusProjection(snapshot, game);
  if (!status) return null;
  return {
    kind: 'owned-parent-preview-terminal', source: 'battle_status', observedAt: new Date().toISOString(),
    canonicalHistory: { sha256: evidence.evidence.sha256, started: false, progress: false },
    ...status,
  };
}

function canonicalParentPreviewSource(evidence, game) {
  return evidence?.sourceKind === 'sanitized-events' && evidence.complete === false && evidence.observedHistory?.started === false && evidence.observedHistory?.progress === false && HASH.test(evidence.evidence?.sha256 ?? '') && evidence.evidence.sha256 === game?.metadata?.evidence?.sha256 && Boolean(terminalProtocolProof(evidence.events, game, true));
}

/** The same bounded status projection is checked for live and attested captures. */
export function ownedParentStatusProjection(snapshot, game) {
  if (!corroboratesOwnedParent(snapshot, game)) return null;
  const ids = new Set([game.parentId, ...game.metadata.setResult.expectedChildIds]);
  return {
    sessionId: snapshot.sessionId, username: snapshot.username, connected: snapshot.connected, authenticated: snapshot.authenticated,
    stopped: snapshot.stopped, teamSha256: snapshot.teamSha256,
    ...(Number.isSafeInteger(snapshot.revision) ? {revision: snapshot.revision} : {}),
    rooms: snapshot.rooms.filter(room => ids.has(canonicalRoom(room.id))).map(room => ({
      id: canonicalRoom(room.id), teamId: room.teamId, ended: room.ended, result: room.result,
      ...(canonicalRoom(room.id) === game.parentId ? {children: room.children.map(canonicalRoom)} : {}),
      state: canonicalRoom(room.id) === game.roomId ? {
        ended: room.state.ended, result: room.state.result, turn: room.state.turn, lastMove: room.state.lastMove,
        gameType: room.state.gameType, tier: room.state.tier, ownSide: room.state.ownSide, request: room.state.request,
        sides: room.state.sides.map(side => ({id: side.id, name: side.name, active: side.active, reserves: side.reserves, pokemon: side.pokemon, preview: side.preview.map(pokemon => ({species: pokemon.species}))})),
      } : {ended: room.state.ended, result: room.state.result},
    })),
  };
}

export const CAPTURE_ATTESTATION = 'I personally observed this status capture being returned by the owned MCP battle client.';
export const HISTORICAL_ORIGIN_LIMITATION = 'Historical capture origin is explicitly attested by the operator, not independently or cryptographically verified. The hash proves retained-byte integrity; this capture is not current IPC ownership.';
const captureText = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\u0000-\u001f\u007f]|https?:\/\//u.test(value);
export function validCaptureAttestation(value) {
  return value?.statement === CAPTURE_ATTESTATION && captureText(value.operator, 1, 100) && captureText(value.provenance, 10, 2000) && captureText(value.reason, 10, 2000) && typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt)) && Object.keys(value).every(key => ['statement','operator','provenance','reason','capturedAt'].includes(key));
}

/** Explicit historical adoption; never pass this capture as a current reader. */
export function historicalOwnedParentPreviewObservation(snapshot, game, evidence, capture) {
  if (!canonicalParentPreviewSource(evidence, game) || !validCaptureAttestation(capture?.attestation) || !HASH.test(capture.snapshot?.sha256 ?? '') || !Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 0 || !Number.isFinite(Date.parse(capture.adoptedAt)) || Date.parse(capture.attestation.capturedAt) > Date.parse(capture.adoptedAt)) return null;
  const capturedStatus = ownedParentStatusProjection(snapshot, game);
  return capturedStatus ? {
    kind:'historical-owned-parent-preview-terminal', source:'historical_mcp_battle_status', adoptedAt:capture.adoptedAt,
    captureAttestation:capture.attestation, originLimitation:HISTORICAL_ORIGIN_LIMITATION, snapshot:capture.snapshot,
    canonicalHistory:{sha256:evidence.evidence.sha256,started:false,progress:false}, capturedStatus,
  } : null;
}

export function historicalOwnedParentPreviewProof(game, observation) {
  const history = observation?.canonicalHistory, status = observation?.capturedStatus;
  return observation?.kind === 'historical-owned-parent-preview-terminal' && observation.source === 'historical_mcp_battle_status' && observation.originLimitation === HISTORICAL_ORIGIN_LIMITATION && validCaptureAttestation(observation.captureAttestation) && Number.isFinite(Date.parse(observation.adoptedAt)) && Date.parse(observation.captureAttestation.capturedAt) <= Date.parse(observation.adoptedAt) && HASH.test(observation.snapshot?.sha256 ?? '') && HASH.test(history?.sha256 ?? '') && history.started === false && history.progress === false && Number.isSafeInteger(status?.revision) && status.revision >= 0 && corroboratesOwnedParent(status, game) ? previewIdentity(game) : null;
}

export function ownedParentPreviewProof(game, observation) {
  const proof = previewIdentity(game), history = observation?.canonicalHistory;
  return proof && observation?.kind === 'owned-parent-preview-terminal' && observation.source === 'battle_status' && Number.isFinite(Date.parse(observation.observedAt)) && HASH.test(history?.sha256 ?? '') && history.started === false && history.progress === false && corroboratesOwnedParent(observation, game) ? proof : null;
}

function corroboratesOwnedParent(snapshot, game) {
  const proof = previewIdentity(game), expected = game?.metadata?.setResult?.expectedChildIds;
  if (!proof || !PARENT.test(game.parentId ?? '') || !CHILD.test(game.roomId ?? '') || game.metadata?.setResult?.completed !== true || game.metadata.setResult.outcome !== game.outcome || !Array.isArray(expected) || expected.length < 1 || expected.length > 3 || new Set(expected).size !== expected.length || expected.some(id => !CHILD.test(id)) || !expected.includes(game.roomId)) return false;
  if (snapshot?.connected !== true || snapshot.authenticated !== true || snapshot.stopped !== false || typeof snapshot.sessionId !== 'string' || !snapshot.sessionId || snapshot.sessionId.length > 100 || snapshot.teamSha256 !== game.teamId || normalize(snapshot.username) !== proof.players[proof.ownSide] || !Array.isArray(snapshot.rooms)) return false;
  const rooms = new Map();
  for (const room of snapshot.rooms) { const id = canonicalRoom(room.id); if (rooms.has(id)) return false; rooms.set(id, room); }
  const parent = rooms.get(game.parentId), child = rooms.get(game.roomId);
  const ended = room => room?.teamId === game.teamId && room.ended === true && room.state?.ended === true && room.result?.type === 'win' && room.state.result?.type === 'win' && normalize(room.result.winner) === normalize(room.state.result.winner) && Object.values(proof.players).includes(normalize(room.result.winner));
  if (!ended(parent) || !ended(child) || normalize(parent.result.winner) !== proof.winner || normalize(child.result.winner) !== proof.winner || !Array.isArray(parent.children) || parent.children.length !== expected.length || new Set(parent.children.map(canonicalRoom)).size !== expected.length || parent.children.some(id => !expected.includes(canonicalRoom(id))) || expected.some(id => !ended(rooms.get(id)))) return false;
  const state = child.state;
  if (state.turn !== 0 || state.lastMove !== null || state.gameType !== 'doubles' || !FORMAT.test(normalize(state.tier)) || state.ownSide !== null || state.request !== null || !Array.isArray(state.sides) || state.sides.length !== 2 || new Set(state.sides.map(side => side.id)).size !== 2) return false;
  return state.sides.every(side => ['p1', 'p2'].includes(side.id) && (!normalize(side.name) || normalize(side.name) === proof.players[side.id]) && Array.isArray(side.active) && side.active.length === 0 && Array.isArray(side.reserves) && side.reserves.length === 0 && Array.isArray(side.pokemon) && side.pokemon.length === 0 && Array.isArray(side.preview) && side.preview.length === 6);
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
