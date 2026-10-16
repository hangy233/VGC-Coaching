import { mkdir, readFile, realpath, lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_ACTIVE_TEAMS, acquireMetricsBattleLock, listMetricsCatalog, recordMetricsBattle, registerMetricsTeam } from './catalog.mjs';
import { normalizeReplayReference } from './replay-evidence.mjs';

export { MAX_ACTIVE_TEAMS, isMetricsTeamActive, registerMetricsTeam, restoreMetricsTeam } from './catalog.mjs';

const SCHEMA_VERSION = 1;
const OUTCOMES = new Set(['win', 'loss', 'tie', 'unknown']);
const COUNTERS = ['switchIns', 'faints', 'knockouts', 'indirectKnockouts', 'itemRemovals', 'couldNotAct'];
const MOVE_COUNTERS = ['uses', 'calledUses', 'failed', 'missed', 'blocked', 'knockouts', 'itemRemovals'];
const locks = new Map();
const MAX_FILE_BYTES = 2_000_000;

function fail(message) { throw new TypeError(`Invalid team metrics: ${message}`); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}
function string(value, field, { max = 200, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${field} must be a bounded text value without control characters`);
  }
  return value.trim();
}
function boolean(value, field) {
  if (typeof value !== 'boolean') fail(`${field} must be boolean`);
  return value;
}
function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) fail(`${field} must be a nonnegative integer`);
  return value;
}
function id(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || /-[a-z0-9]+pw$/u.test(value) || value.length > 180) {
    fail(`${field} must be a normalized room ID without a private password suffix`);
  }
  return value;
}
function teamId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('teamId must be a lowercase SHA-256 hash');
  return value;
}
const speciesKey = value => value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
function texts(value, field, max = 100) {
  if (!Array.isArray(value) || value.length > max) fail(`${field} must be a bounded array`);
  const seen = new Set();
  return value.map((entry, index) => string(entry, `${field}[${index}]`)).filter(entry => {
    const key = speciesKey(entry);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function timestamp(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') fail(`${field} must be an ISO timestamp or epoch milliseconds`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail(`${field} is not a valid timestamp`);
  return parsed.toISOString();
}
function source(value) {
  const entry = string(value, 'metadata.sources[]', { max: 1000 });
  // Provenance is a workspace-relative filename, never a live session descriptor or URL token.
  if (isAbsolute(entry) || /^[a-z]+:/iu.test(entry) || entry.split(/[\\/]/u).some(part => part === '..') || /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|showdown-(?:standby-)?session(?:-[^\\/]*)?\.json)$/iu.test(entry)) {
    fail('metadata.sources must contain safe workspace-relative input paths');
  }
  return entry.replaceAll('\\', '/');
}
function metadata(value = {}, identity = {}) {
  object(value, 'metadata');
  const result = {};
  for (const key of ['startedAt', 'endedAt']) {
    const date = timestamp(value[key], `metadata.${key}`);
    if (date !== undefined) result[key] = date;
  }
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > 100) fail('metadata.sources must be a bounded array');
    result.sources = [...new Set(value.sources.map(source))];
  }
  if (value.ledgerIndex !== undefined) result.ledgerIndex = count(value.ledgerIndex, 'metadata.ledgerIndex');
  if (value.annotations !== undefined) {
    if (!Array.isArray(value.annotations) || value.annotations.length > 500) fail('annotations must contain at most 500 audit entries');
    const seen=new Set();
    result.annotations=value.annotations.map(entry=>{
      object(entry,'annotation');
      if(typeof entry.id!=='string'||! /^[a-f0-9-]{36}$/u.test(entry.id)||seen.has(entry.id)) fail('annotation ID must be a distinct UUID');
      seen.add(entry.id);
      if(!['note','exclude','include'].includes(entry.action))fail('annotation action is not recognized');
      const at=timestamp(entry.at,'annotation.at');if(!at)fail('annotation timestamp is required');
      return {id:entry.id,at,action:entry.action,reason:string(entry.reason,'annotation.reason',{max:4000}),author:string(entry.author??'agent','annotation.author',{max:100})};
    });
  }
  if (value.attribution !== undefined) result.attribution = string(value.attribution, 'metadata.attribution', { max: 500 });
  if (value.setResult !== undefined && value.setResult !== null) {
    object(value.setResult, 'metadata.setResult');
    if (!OUTCOMES.has(value.setResult.outcome)) fail('metadata.setResult.outcome is not recognized');
    result.setResult = { outcome: value.setResult.outcome, completed: boolean(value.setResult.completed, 'metadata.setResult.completed') };
    if(value.setResult.expectedChildIds!==undefined){
      const children=value.setResult.expectedChildIds;
      if(!Array.isArray(children)||children.length<1||children.length>3||new Set(children).size!==children.length||children.some(child=>typeof child!=='string'||!/^battle-[a-z0-9]+-\d+$/u.test(child)))fail('metadata.setResult.expectedChildIds must contain one to three distinct canonical child room IDs');
      result.setResult.expectedChildIds=[...children].sort();
    }
  }
  if (value.replay !== undefined && value.replay !== null) {
    result.replay = normalizeReplayReference(value.replay, { roomId: identity.roomId });
    if (result.replay.evidencePath && result.replay.evidencePath !== `cache/team-metrics/evidence/${identity.roomId}--${identity.teamId}.replay.log.gz`) fail('replay evidence must match the exact game and team');
  }
  if (value.evidence !== undefined && value.evidence !== null) {
    object(value.evidence, 'metadata.evidence');
    const expected = `cache/team-metrics/evidence/${identity.roomId}--${identity.teamId}.events.json.gz`;
    if (value.evidence.path !== expected || !/^[a-f0-9]{64}$/u.test(value.evidence.sha256) || value.evidence.kind !== 'sanitized-events' || value.evidence.version !== 1) fail('metadata.evidence must describe generated game evidence');
    result.evidence = { path: expected, sha256: value.evidence.sha256, kind: 'sanitized-events', complete: boolean(value.evidence.complete, 'metadata.evidence.complete'), version: 1 };
  }
  return result;
}

/** Validate and whitelist statistics. Raw protocols and arbitrary metadata are never persisted. */
function normalizeRecord(input) {
  const value = object(input, 'record');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion must be 1');
  const players = object(value.players, 'players');
  const quality = object(value.quality, 'quality');
  const team = object(value.team ?? { roster: [] }, 'team');
  if (!OUTCOMES.has(value.outcome)) fail('outcome is not recognized');
  if (!['p1', 'p2'].includes(value.ownSide)) fail('ownSide must be p1 or p2');
  if (!Array.isArray(value.pokemon) || value.pokemon.length > 24) fail('pokemon must be a bounded array');
  const seenPokemon = new Set();
  const pokemon = value.pokemon.map((entry, index) => {
    object(entry, `pokemon[${index}]`);
    const result = {
      key: string(entry.key, `pokemon[${index}].key`),
      species: string(entry.species, `pokemon[${index}].species`),
      forms: texts(entry.forms ?? [], `pokemon[${index}].forms`),
      selected: boolean(entry.selected, `pokemon[${index}].selected`),
      lead: boolean(entry.lead, `pokemon[${index}].lead`),
      megaEvolved: boolean(entry.megaEvolved ?? false, `pokemon[${index}].megaEvolved`),
    };
    if (seenPokemon.has(result.key)) fail('duplicate pokemon key');
    seenPokemon.add(result.key);
    if (entry.identityConfidence !== undefined) {
      if (!['observed', 'registered', 'ambiguous'].includes(entry.identityConfidence)) fail('pokemon identity confidence is not recognized');
      result.identityConfidence = entry.identityConfidence;
    }
    for (const field of COUNTERS) result[field] = count(entry[field] ?? 0, `pokemon[${index}].${field}`);
    if (!Array.isArray(entry.moves) || entry.moves.length > 128) fail(`pokemon[${index}].moves must be a bounded array`);
    const seenMoves = new Set();
    result.moves = entry.moves.map((move, moveIndex) => {
      object(move, `pokemon[${index}].moves[${moveIndex}]`);
      const next = { move: string(move.move, `pokemon[${index}].moves[${moveIndex}].move`) };
      const key = speciesKey(next.move);
      if (!key || seenMoves.has(key)) fail('duplicate or invalid move name');
      seenMoves.add(key);
      for (const field of MOVE_COUNTERS) next[field] = count(move[field] ?? 0, `pokemon[${index}].moves[${moveIndex}].${field}`);
      return next;
    });
    return result;
  });
  const result = {
    schemaVersion: SCHEMA_VERSION,
    roomId: id(value.roomId, 'roomId'),
    parentId: value.parentId == null ? null : id(value.parentId, 'parentId'),
    teamId: teamId(value.teamId),
    username: string(value.username, 'username'),
    ownSide: value.ownSide,
    outcome: value.outcome,
    completed: boolean(value.completed, 'completed'),
    turns: count(value.turns, 'turns'),
    players: { p1: string(players.p1 ?? '', 'players.p1', { empty: true }), p2: string(players.p2 ?? '', 'players.p2', { empty: true }) },
    opponentRoster: texts(value.opponentRoster ?? [], 'opponentRoster'),
    opponentSelected: texts(value.opponentSelected ?? [], 'opponentSelected', 24),
    opponentLeads: texts(value.opponentLeads ?? [], 'opponentLeads', 2),
    opponentSelectionKnown: boolean(value.opponentSelectionKnown ?? false, 'opponentSelectionKnown'),
    opponentMega: texts(value.opponentMega ?? [], 'opponentMega', 24),
    selected: texts(value.selected ?? [], 'selected'),
    selectionKnown: boolean(value.selectionKnown, 'selectionKnown'),
    leads: texts(value.leads ?? [], 'leads'),
    pokemon,
    quality: {
      complete: boolean(quality.complete, 'quality.complete'),
      operational: boolean(quality.operational, 'quality.operational'),
      warnings: texts(quality.warnings ?? [], 'quality.warnings', 100),
    },
    team: { roster: texts(team.roster ?? [], 'team.roster', 24) },
    metadata: metadata(value.metadata, { roomId: value.roomId, teamId: value.teamId }),
  };
  if (result.opponentSelectionKnown && result.opponentSelected.length !== 4) fail('a known opposing selection must contain exactly four distinct observed Pokémon');
  for (const field of ['name', 'format']) if (team[field] !== undefined) result.team[field] = string(team[field], `team.${field}`);
  for (const field of ['importedAt', 'updatedAt']) {
    const date = timestamp(value[field], field);
    if (date !== undefined) result[field] = date;
  }
  return result;
}

function contained(root, target) {
  const path = relative(root, target);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}
async function directory(workspace, create = false) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('workspace must be an absolute directory');
  const root = await realpath(workspace);
  let current = root;
  for (const name of ['cache', 'team-metrics']) {
    current = join(current, name);
    if (!contained(root, current)) fail('storage escapes the workspace');
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      try { await mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('storage directories must be real directories, not links');
    const actual = await realpath(current);
    if (!contained(root, actual)) fail('storage resolves outside the workspace');
  }
  return current;
}
const filename = record => `${record.roomId}--${record.teamId}.json`;

async function readRecord(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) fail('stored battle is not a bounded regular file');
  return normalizeRecord(JSON.parse(await readFile(path, 'utf8')));
}

function mergeMetadata(existing, incoming) {
  const result = { ...existing, ...incoming };
  if (existing.sources || incoming.sources) result.sources = [...new Set([...(existing.sources ?? []), ...(incoming.sources ?? [])])];
  if (existing.setResult?.completed && !incoming.setResult?.completed) result.setResult = existing.setResult;
  if(existing.setResult?.expectedChildIds&&result.setResult){
    // A replay or older importer cannot erase independent observed membership.
    // Preserve the union if later parent observation adds another known child.
    const expected=[...new Set([...existing.setResult.expectedChildIds,...(result.setResult.expectedChildIds||[])])].sort();
    if(expected.length>3)fail('conflicting parent child manifests exceed one BO3; retain source evidence for reconciliation');
    result.setResult={...result.setResult,expectedChildIds:expected};
  }
  if (existing.replay && !incoming.replay) result.replay = existing.replay;
  if (existing.evidence && !incoming.evidence) result.evidence = existing.evidence;
  if (existing.evidence?.complete && incoming.evidence && !incoming.evidence.complete) result.evidence = existing.evidence;
  if(existing.annotations||incoming.annotations){
    const entries=new Map((existing.annotations||[]).map(entry=>[entry.id,entry]));
    for(const entry of incoming.annotations||[]){if(entries.has(entry.id)&&JSON.stringify(entries.get(entry.id))!==JSON.stringify(entry))fail('an annotation ID cannot be rewritten');entries.set(entry.id,entry);}
    if(entries.size>500)fail('annotation audit history is full');
    // The serialized writer's append order decides inclusion; equal wall-clock
    // timestamps or a stale reimport must not reorder an earlier review action.
    result.annotations=[...entries.values()];
  }
  return result;
}

/** Preserve positively known private facts when a complete public replay omits them. */
function mergeKnownFacts(previous, next) {
  if (!previous) return next;
  const selection = !next.selectionKnown && previous.selectionKnown ? previous : next;
  const opposingSelection = !next.opponentSelectionKnown && previous.opponentSelectionKnown ? previous : next;
  const previousActors = new Map(previous.pokemon.map(pokemon => [pokemon.key, pokemon]));
  const opposingRoster = new Map([...next.opponentRoster, ...previous.opponentRoster].map(species => [speciesKey(species), species]));
  if (opposingRoster.size > 100) fail('merged opposing roster is too large');
  return {
    ...next,
    parentId: next.parentId ?? previous.parentId,
    players: { p1: next.players.p1 || previous.players.p1, p2: next.players.p2 || previous.players.p2 },
    selected: selection.selected, selectionKnown: selection.selectionKnown,
    leads: next.leads.length ? next.leads : previous.leads,
    opponentRoster: [...opposingRoster.values()],
    opponentSelected: opposingSelection.opponentSelected, opponentSelectionKnown: opposingSelection.opponentSelectionKnown,
    opponentLeads: next.opponentLeads.length ? next.opponentLeads : previous.opponentLeads,
    pokemon: next.pokemon.map(pokemon => ({ ...pokemon, selected: pokemon.selected || (selection === previous && (previousActors.get(pokemon.key)?.selected || selection.selected.some(species => speciesKey(species) === speciesKey(pokemon.species)))) })),
  };
}

/** Save one private per-game summary. Reimporting a room/team identity never adds a second row. */
export async function saveBattle({ workspace, record, metadataOnly = false }) {
  boolean(metadataOnly, 'metadataOnly');
  const incoming = normalizeRecord(record);
  const dir = await directory(workspace, true);
  const path = join(dir, filename(incoming));
  const previous = locks.get(path) ?? Promise.resolve();
  let release;
  const ownLock = new Promise(resolveLock => { release = resolveLock; });
  const queued = previous.then(() => ownLock);
  locks.set(path, queued);
  await previous;
  let temporary;
  let releaseCrossProcessLock;
  try {
    releaseCrossProcessLock = await acquireMetricsBattleLock({ workspace, roomId: incoming.roomId, teamId: incoming.teamId });
    let existing;
    try { existing = await readRecord(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadataOnly && !existing) fail('metadata can only be attached to an existing game');
    if (existing && (existing.username.toLowerCase() !== incoming.username.toLowerCase() || existing.ownSide !== incoming.ownSide)) {
      fail('the same room/team is already attributed to another player or side');
    }
    const preserve = Boolean(existing?.completed && existing.quality.complete && (!incoming.completed || !incoming.quality.complete || incoming.turns < existing.turns));
    const selected = metadataOnly ? existing : preserve ? mergeKnownFacts(incoming, existing) : mergeKnownFacts(existing, incoming);
    const merged = {
      ...selected,
      team: metadataOnly ? existing.team : existing ? { ...existing.team, ...incoming.team, roster: incoming.team.roster.length ? incoming.team.roster : existing.team.roster } : incoming.team,
      metadata: mergeMetadata(existing?.metadata ?? {}, incoming.metadata),
      quality: {
        ...selected.quality,
        operational: metadataOnly ? existing.quality.operational : Boolean(existing?.quality.operational || incoming.quality.operational),
        warnings: metadataOnly ? existing.quality.warnings : [...new Set([...(existing?.quality.warnings ?? []), ...incoming.quality.warnings])],
      },
      importedAt: existing?.importedAt ?? new Date().toISOString(),
    };
    const comparable = value => JSON.stringify({ ...value, updatedAt: undefined });
    const changed = !existing || comparable(existing) !== comparable(merged);
    if (!changed) {
      const catalog = await recordMetricsBattle({ workspace, record: existing });
      return { roomId: merged.roomId, teamId: merged.teamId, status: preserve ? 'preserved' : 'unchanged', path: relative(resolve(workspace), path).replaceAll('\\', '/'), record: existing, catalog };
    }
    merged.updatedAt = new Date().toISOString();
    // Keep temporary names short: the workspace may already be near Windows MAX_PATH.
    temporary = join(dir, `.pending-${incoming.teamId}-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    temporary = undefined;
    const catalog = await recordMetricsBattle({ workspace, record: merged });
    return { roomId: merged.roomId, teamId: merged.teamId, status: existing ? (preserve ? 'preserved' : 'updated') : 'created', path: relative(resolve(workspace), path).replaceAll('\\', '/'), record: merged, catalog };
  } finally {
    try { if (temporary) await rm(temporary, { force: true }); }
    finally {
      try { if (releaseCrossProcessLock) await releaseCrossProcessLock(); }
      finally {
        release();
        // Only the last queued writer removes its own lock.
        if (locks.get(path) === queued) locks.delete(path);
      }
    }
  }
}

/** Add durable provenance while retaining the latest counters under the game writer lock. */
export async function updateBattleMetadata({ workspace, teamId: requestedTeamId, roomId, metadata: patch }) {
  teamId(requestedTeamId); id(roomId, 'roomId');
  const path = join(await directory(workspace), `${roomId}--${requestedTeamId}.json`);
  const existing = await readRecord(path);
  return saveBattle({ workspace, record: { ...existing, metadata: patch }, metadataOnly: true });
}

/** Read all stored summaries. Invalid files fail closed instead of silently altering totals. */
async function readAllBattles({ workspace }) {
  const dir = await directory(workspace);
  if (!dir) return [];
  const names = (await readdir(dir)).filter(name => name.endsWith('.json'));
  const records = [];
  for (const name of names.sort()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*--[a-f0-9]{64}\.json$/u.test(name)) fail('unexpected JSON file in metrics storage');
    let record;
    try { record = await readRecord(join(dir, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (filename(record) !== name) fail('stored battle identity does not match its filename');
    records.push(record);
  }
  return records.sort((a, b) => playedAt(b).localeCompare(playedAt(a)) || a.roomId.localeCompare(b.roomId));
}

/** Archived histories remain recoverable; normal reads use the active working set. */
export async function listBattles({ workspace, includeArchived = false }) {
  boolean(includeArchived, 'includeArchived');
  const records = await readAllBattles({ workspace });
  if (includeArchived) return records;
  const activeIds = new Set((await listMetricsCatalog({ workspace })).map(team => team.teamId));
  return records.filter(record => activeIds.has(record.teamId));
}

export const gameAnnotationState = record => {
  const history=record.metadata?.annotations||[];
  const latest=history.filter(entry=>entry.action!=='note').at(-1);
  return {excluded:latest?.action==='exclude',reason:latest?.action==='exclude'?latest.reason:null,history};
};
const eligible = record => record.completed && record.quality.complete && !record.quality.operational && !gameAnnotationState(record).excluded;
const playedAt = record => record.metadata?.endedAt ?? record.metadata?.startedAt ?? record.importedAt ?? '';

export async function listTeams({ workspace, includeArchived = false }) {
  boolean(includeArchived, 'includeArchived');
  const records = await readAllBattles({ workspace });
  const catalog = await listMetricsCatalog({ workspace, includeArchived });
  return catalog.map(team => {
    const battles = records.filter(record => record.teamId === team.teamId);
    return { ...team, storedGames: battles.length, eligibleGames: battles.filter(eligible).length, lastPlayedAt: battles.length ? playedAt(battles[0]) || null : null };
  });
}

function outcomes() { return { games: 0, wins: 0, losses: 0, ties: 0, unknown: 0 }; }
function addOutcome(result, outcome) {
  result.games++;
  const field = { win: 'wins', loss: 'losses', tie: 'ties', unknown: 'unknown' }[outcome];
  result[field]++;
}
function rate(numerator, denominator) { return denominator ? numerator / denominator * 100 : null; }
function withRate(value) {
  const winRateDenominator = value.wins + value.losses;
  return { ...value, winRate: rate(value.wins, winRateDenominator), winRateDenominator };
}
function selectedPokemon(record, species) {
  const key = speciesKey(species);
  return record.selected.some(name => speciesKey(name) === key) || record.pokemon.some(pokemon => speciesKey(pokemon.species) === key && pokemon.selected);
}
function opposingSpecies(record) {
  const names = new Map();
  for (const species of [...record.opponentRoster, ...record.opponentSelected, ...record.opponentLeads, ...record.opponentMega]) {
    if (!names.has(speciesKey(species))) names.set(speciesKey(species), species);
  }
  return [...names.values()];
}
function setReport(records, { allTeamRecords = records, includedRecords = records, includeOperational = false, includeManuallyExcluded = false } = {}) {
  const groups = new Map();
  for (const record of records) if (record.parentId) {
    if (!groups.has(record.parentId)) groups.set(record.parentId, []);
    groups.get(record.parentId).push(record);
  }
  const siblings = new Map();
  for (const record of allTeamRecords) if (record.parentId) {
    if (!siblings.has(record.parentId)) siblings.set(record.parentId, []);
    siblings.get(record.parentId).push(record);
  }
  const includedRooms = new Set(includedRecords.map(record => record.roomId));
  const counts = { observed: groups.size, played: 0, wins: 0, losses: 0, ties: 0, unknown: 0, incomplete: 0, excludedOperational: 0, excludedIncomplete: 0, excludedManual:0 };
  const details = [];
  for (const [parentId, games] of groups) {
    const allSiblings = siblings.get(parentId) ?? games;
    const official = [...new Set(allSiblings.filter(game => game.metadata?.setResult?.completed).map(game => game.metadata.setResult.outcome))];
    const outcome = official.length === 1 ? official[0] : 'unknown';
    const completed = official.length === 1 && outcome !== 'unknown';
    const operational = allSiblings.some(game => game.quality.operational);
    const manuallyExcluded = allSiblings.some(game=>gameAnnotationState(game).excluded);
    const includedGames = games.filter(game => includedRooms.has(game.roomId)).length;
    const excludedOperational = operational && !includeOperational;
    const excludedManual=manuallyExcluded&&!includeManuallyExcluded;
    const included = !excludedOperational && !excludedManual && includedGames > 0;
    if (excludedOperational) counts.excludedOperational++;
    else if(excludedManual)counts.excludedManual++;
    else if (!included) counts.excludedIncomplete++;
    // Child results alone do not establish a BO3 result: later games or concessions may be absent.
    if (included) {
      counts.played++;
      counts[{ win: 'wins', loss: 'losses', tie: 'ties', unknown: 'unknown' }[outcome]]++;
    }
    if (!completed) counts.incomplete++;
    details.push({ parentId, games: games.length, storedGames: allSiblings.length, includedGames, outcome, completed, operational, manuallyExcluded, included, exclusionReason: excludedOperational ? 'operational' : excludedManual?'manual-exclusion':!included ? 'no-eligible-child' : null, source: completed ? 'official' : (official.length > 1 ? 'conflicting-parent-results' : 'unconfirmed') });
  }
  return { ...counts, winRate: rate(counts.wins, counts.wins + counts.losses), winRateDenominator: counts.wins + counts.losses, records: details };
}

/**
 * Rates are percentages (0..100), null when the explicit denominator is zero.
 * Win rates count wins and losses only. Opponent matchups mean roster presence,
 * not an inferred enemy selection. Incomplete and operational games are opt-in.
 */
export async function getTeamReport({ workspace, teamId: requestedTeamId, opponentSpecies, selectedSpecies, outcome, includeIncomplete = false, includeOperational = false, includeManuallyExcluded = false, from, to, touch = true } = {}) {
  if (requestedTeamId !== undefined) teamId(requestedTeamId);
  if (outcome !== undefined && !OUTCOMES.has(outcome)) fail('outcome filter is not recognized');
  boolean(includeIncomplete, 'includeIncomplete');
  boolean(includeOperational, 'includeOperational');
  boolean(includeManuallyExcluded,'includeManuallyExcluded');
  boolean(touch, 'touch');
  if (opponentSpecies !== undefined) string(opponentSpecies, 'opponentSpecies');
  if (selectedSpecies !== undefined) string(selectedSpecies, 'selectedSpecies');
  const fromDate = timestamp(from, 'from');
  const toDate = timestamp(to, 'to');
  if (fromDate && toDate && fromDate > toDate) fail('from must be before to');
  const all = await readAllBattles({ workspace });
  let catalog = await listMetricsCatalog({ workspace, includeArchived: true });
  const teamIds = catalog.filter(team => team.active).map(team => team.teamId);
  if (requestedTeamId === undefined && teamIds.length > 1) fail('choose a teamId when several exact team versions are stored');
  const chosen = requestedTeamId ?? teamIds[0] ?? null;
  const teamRecords = all.filter(record => record.teamId === chosen);
  const representative = teamRecords.find(record => record.team.roster.length) ?? teamRecords[0];
  let catalogTeam = catalog.find(team => team.teamId === chosen);
  if (chosen && !catalogTeam && !teamRecords.length) fail('teamId is unknown; register a validated team before requesting its report');
  if (chosen && touch) {
    const result = await registerMetricsTeam({ workspace, teamId: chosen, name: catalogTeam?.name ?? representative?.team.name, format: catalogTeam?.format ?? representative?.team.format, roster: catalogTeam?.roster.length ? catalogTeam.roster : representative?.team.roster });
    catalogTeam = result.team;
    catalog = await listMetricsCatalog({ workspace, includeArchived: true });
  }
  const team = { ...catalogTeam, teamId: chosen, name: catalogTeam?.name ?? representative?.team.name ?? chosen?.slice(0, 12) ?? 'No team', format: catalogTeam?.format ?? representative?.team.format ?? null, roster: catalogTeam?.roster ?? representative?.team.roster ?? [] };
  const matching = teamRecords.filter(record => {
    if (opponentSpecies && !opposingSpecies(record).some(species => speciesKey(species) === speciesKey(opponentSpecies))) return false;
    if (selectedSpecies && !selectedPokemon(record, selectedSpecies)) return false;
    if (outcome && record.outcome !== outcome) return false;
    const date = playedAt(record);
    if (fromDate && (!date || date < fromDate)) return false;
    if (toDate && (!date || date > toDate)) return false;
    return true;
  });
  const quality = {
    storedGames: teamRecords.length, matchingGames: matching.length, includedGames: 0,
    incompleteGames: matching.filter(record => !record.completed || !record.quality.complete).length,
    operationalGames: matching.filter(record => record.quality.operational).length,
    incompleteOperationalGames: matching.filter(record => (!record.completed || !record.quality.complete) && record.quality.operational).length,
    manuallyExcludedGames:matching.filter(record=>gameAnnotationState(record).excluded).length,
    excludedIncomplete: 0, excludedOperational: 0, excludedManual:0, excludedTotal: 0,
    warnings: [...new Set(matching.flatMap(record => record.quality.warnings))],
  };
  const games = matching.filter(record => {
    // These exclusion counts are disjoint: an overlapping row is charged to incompleteness first.
    if (!includeIncomplete && (!record.completed || !record.quality.complete)) { quality.excludedIncomplete++; return false; }
    if (!includeOperational && record.quality.operational) { quality.excludedOperational++; return false; }
    if(!includeManuallyExcluded&&gameAnnotationState(record).excluded){quality.excludedManual++;return false;}
    return true;
  });
  quality.includedGames = games.length;
  quality.excludedTotal = quality.excludedIncomplete + quality.excludedOperational + quality.excludedManual;
  const totalCounts = outcomes();
  const opponents = new Map();
  const pokemon = new Map();
  const leadPairs = new Map();
  const selection = {
    gamesWithSelection: games.filter(record => record.selectionKnown).length,
    gamesWithoutSelection: games.filter(record => !record.selectionKnown).length,
    gamesWithKnownLeads: games.filter(record => record.leads.length > 0).length,
    gamesWithKnownLeadPairs: games.filter(record => record.leads.length === 2).length,
    gamesWithKnownOpponentSelection: games.filter(record => record.opponentSelectionKnown).length,
    gamesWithoutKnownOpponentSelection: games.filter(record => !record.opponentSelectionKnown).length,
  };
  function ensurePokemon(species, key = species) {
    const normalized = speciesKey(species);
    if (!pokemon.has(normalized)) pokemon.set(normalized, {
      key, species, forms: new Set(), observedGames: 0, observedSelectedGames: 0,
      selectedGames: 0, selectionDenominator: selection.gamesWithSelection,
      leadGames: 0, leadDenominator: selection.gamesWithKnownLeads,
      megaGames: 0, megaWins: 0, megaLosses: 0, megaTies: 0, megaUnknown: 0,
      winsWhenSelected: 0, lossesWhenSelected: 0, tiesWhenSelected: 0, unknownWhenSelected: 0,
      ...Object.fromEntries(COUNTERS.map(field => [field, 0])), moves: new Map(),
    });
    return pokemon.get(normalized);
  }
  for (const species of team.roster) ensurePokemon(species);
  for (const record of games) {
    addOutcome(totalCounts, record.outcome);
    if (record.leads.length === 2) {
      const species = [...record.leads].sort((a, b) => speciesKey(a).localeCompare(speciesKey(b)));
      const key = species.map(speciesKey).join('|');
      if (!leadPairs.has(key)) leadPairs.set(key, { species, ...outcomes() });
      addOutcome(leadPairs.get(key), record.outcome);
    }
    for (const species of opposingSpecies(record)) {
      const key = speciesKey(species);
      if (!opponents.has(key)) opponents.set(key, { species, ...outcomes(), rosterGames: 0, observedOnlyGames: 0, observedSelectedGames: 0, observedLeadGames: 0, observedMegaGames: 0, knownUnselectedGames: 0, unavailableSelectionGames: 0 });
      const opponent = opponents.get(key);
      addOutcome(opponent, record.outcome);
      if (record.opponentRoster.some(name => speciesKey(name) === key)) opponent.rosterGames++;
      else opponent.observedOnlyGames++;
      const wasObserved = [...record.opponentSelected, ...record.opponentLeads, ...record.opponentMega].some(name => speciesKey(name) === key);
      if (wasObserved) opponent.observedSelectedGames++;
      else if (record.opponentSelectionKnown) opponent.knownUnselectedGames++;
      else opponent.unavailableSelectionGames++;
      if (record.opponentLeads.some(name => speciesKey(name) === key)) opponent.observedLeadGames++;
      if (record.opponentMega.some(name => speciesKey(name) === key)) opponent.observedMegaGames++;
    }
    const rows = new Map();
    for (const entry of record.pokemon) {
      const key = speciesKey(entry.species);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(entry);
    }
    for (const species of [...record.selected, ...record.leads]) ensurePokemon(species);
    for (const entry of record.pokemon) ensurePokemon(entry.species, entry.key);
    for (const result of pokemon.values()) {
      const entries = rows.get(speciesKey(result.species)) ?? [];
      if (entries.some(entry => entry.megaEvolved)) {
        result.megaGames++;
        result[{ win: 'megaWins', loss: 'megaLosses', tie: 'megaTies', unknown: 'megaUnknown' }[record.outcome]]++;
      }
      const isSelected = selectedPokemon(record, result.species);
      if (isSelected) result.observedSelectedGames++;
      if (record.selectionKnown && isSelected) {
        result.selectedGames++;
        result[{ win: 'winsWhenSelected', loss: 'lossesWhenSelected', tie: 'tiesWhenSelected', unknown: 'unknownWhenSelected' }[record.outcome]]++;
      }
      if (record.leads.some(species => speciesKey(species) === speciesKey(result.species)) || entries.some(entry => entry.lead)) result.leadGames++;
      if (entries.some(entry => entry.selected || entry.moves.some(move => move.uses > 0 || move.calledUses > 0) || COUNTERS.some(field => entry[field]))) result.observedGames++;
      for (const entry of entries) {
        for (const form of entry.forms) result.forms.add(form);
        for (const field of COUNTERS) result[field] += entry[field];
        for (const move of entry.moves) {
          const key = speciesKey(move.move);
          if (!result.moves.has(key)) result.moves.set(key, { move: move.move, ...Object.fromEntries(MOVE_COUNTERS.map(field => [field, 0])) });
          const aggregate = result.moves.get(key);
          for (const field of MOVE_COUNTERS) aggregate[field] += move[field];
        }
      }
    }
  }
  const pokemonReport = [...pokemon.values()].map(entry => {
    const usageDenominator = [...entry.moves.values()].reduce((sum, move) => sum + move.uses, 0);
    const selectionWinRateDenominator = entry.winsWhenSelected + entry.lossesWhenSelected;
    const megaWinRateDenominator = entry.megaWins + entry.megaLosses;
    return {
      ...entry, forms: [...entry.forms].sort(),
      selectionRate: rate(entry.selectedGames, entry.selectionDenominator),
      selectionWinRate: rate(entry.winsWhenSelected, selectionWinRateDenominator), selectionWinRateDenominator,
      megaWinRate: rate(entry.megaWins, megaWinRateDenominator), megaWinRateDenominator,
      moves: [...entry.moves.values()].map(move => ({ ...move, usagePercent: rate(move.uses, usageDenominator), usageDenominator })).sort((a, b) => b.uses - a.uses || a.move.localeCompare(b.move)),
    };
  });
  const setMetrics = setReport(matching, { allTeamRecords: teamRecords, includedRecords: games, includeOperational, includeManuallyExcluded });
  const parents = new Map(setMetrics.records.map(parent => [parent.parentId, parent]));
  return {
    schemaVersion: SCHEMA_VERSION, team,
    catalog: { maxActiveTeams: MAX_ACTIVE_TEAMS, activeTeams: catalog.filter(entry => entry.active).length, archivedTeams: catalog.filter(entry => !entry.active).length, archivePolicy: 'Least recently used versions are permanently cleaned with their reports and stored data; protected artifacts remain explicit pending cleanup.' },
    filters: { teamId: chosen, opponentSpecies: opponentSpecies ?? null, selectedSpecies: selectedSpecies ?? null, outcome: outcome ?? null, includeIncomplete, includeOperational, includeManuallyExcluded, from: fromDate ?? null, to: toDate ?? null },
    totals: { ...withRate(totalCounts), sets: setMetrics },
    quality, reviewAnnotations:matching.filter(record=>record.metadata.annotations?.length).map(record=>{const state=gameAnnotationState(record);return {roomId:record.roomId,parentId:record.parentId,originalOutcome:record.outcome,excluded:state.excluded,reason:state.reason,entries:state.history.length,latestAt:state.history.at(-1)?.at,retrievalTool:'team_metrics_game_annotations'};}), selection, pokemon: pokemonReport,
    leadPairs: [...leadPairs.values()].map(entry => ({ ...withRate(entry), usageDenominator: selection.gamesWithKnownLeadPairs, usagePercent: rate(entry.games, selection.gamesWithKnownLeadPairs) })).sort((a, b) => b.games - a.games || a.species.join('/').localeCompare(b.species.join('/'))),
    opponents: [...opponents.values()].map(withRate).sort((a, b) => b.games - a.games || a.species.localeCompare(b.species)),
    games: games.map(record => ({ annotation:gameAnnotationState(record), roomId: record.roomId, parentId: record.parentId, outcome: record.outcome, completed: record.completed, turns: record.turns, opponent: record.players[record.ownSide === 'p1' ? 'p2' : 'p1'], opponentRoster: record.opponentRoster, opponentSelected: record.opponentSelected, opponentLeads: record.opponentLeads, opponentSelectionKnown: record.opponentSelectionKnown, opponentMega: record.opponentMega, selected: record.selected, leads: record.leads, selectionKnown: record.selectionKnown, pokemon: record.pokemon, setResult: record.metadata.setResult ?? (parents.get(record.parentId)?.completed ? { outcome: parents.get(record.parentId).outcome, completed: true } : null), setOperational: parents.get(record.parentId)?.operational ?? false, quality: record.quality, playedAt: playedAt(record) || null, replay: record.metadata.replay ?? null, evidence: record.metadata.evidence ?? null })),
    definitions: { manualExclusions:'Review annotations are separate audited judgments. Original protocol outcomes and counters remain unchanged. Excluded children exclude their entire parent from set performance unless includeManuallyExcluded is true.', winRate: 'Wins / (wins + losses), expressed as a percentage; ties and unknown outcomes are excluded.', moveUsage: 'Observed uses of this move / all observed move uses by this Pokémon.', selections: 'Selection rates use only games whose entire own selection is known; observed appearances in other games remain separately counted.', opponentMatchups: 'Presence on the opposing roster or a positively observed appearance, not inferred selection. rosterGames and observedOnlyGames distinguish their evidence. Opposing attendance is observed only; an unobserved roster member remains unknown until all four opposing selections are identified.', megaUsage: 'Only an observed Mega Evolution event counts; a registered Mega form or held stone alone does not establish use. Mega win rates exclude ties and unknown outcomes.', leadPairs: 'Unordered pairs from games with exactly two distinct observed own leads; pair win rates exclude ties and unknown outcomes.', speciesMatching: 'Species and forms match by their exact normalized names; regional and other forms are not merged by an inferred family.', sets: 'Only explicit completed parent-set results establish a set outcome; a child game alone never does. Any operational stored sibling marks the whole parent operational, even when a filter hides that sibling. Default set performance excludes these parents; observed records retain their official scores and includeOperational opts them in.' },
  };
}
