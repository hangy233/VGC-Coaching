import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { acquireMetricsBattleLock } from './catalog.mjs';
import { listBattles, updateBattleMetadata } from './store.mjs';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_BYTES = 12 * 1024 * 1024, MAX_EVENTS = 20000;
const HASH = /^[a-f0-9]{64}$/u;
const ROOM = /^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const PARENT = /^(?:game-)?bestof3-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const PROTOCOL = new Set(['player', 'poke', 'start', 'turn', 'upkeep', 'switch', 'drag', 'replace', 'detailschange', 'swap', 'move', 'cant', 'faint', 'win', 'tie', 'gen', 'gametype', 'tier', 'teamsize', 'teampreview']);
const MINOR = new Set(['-damage', '-heal', '-sethp', '-status', '-curestatus', '-cureteam', '-boost', '-unboost', '-setboost', '-swapboost', '-invertboost', '-clearboost', '-clearallboost', '-clearpositiveboost', '-clearnegativeboost', '-copyboost', '-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-swapsideconditions', '-start', '-end', '-singleturn', '-singlemove', '-activate', '-fail', '-miss', '-notarget', '-immune', '-crit', '-supereffective', '-resisted', '-ohko', '-hitcount', '-nothing', '-combine', '-waiting', '-prepare', '-mustrecharge', '-recharge', '-anim', '-item', '-enditem', '-ability', '-endability', '-transform', '-formechange', '-mega', '-primal', '-burst', '-zpower', '-zbroken', '-terastallize', '-block']);
const STATUSES = new Set(['selected', 'sent', 'accepted', 'rejected', 'executed', 'execution-observed', 'server-defaulted', 'defaulted', 'unsubmitted', 'stale', 'expired', 'inactivity']);
const safeError = message => new Error(`Game evidence: ${message}`);
const sha256 = content => createHash('sha256').update(content).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const canonicalRoom = value => String(value ?? '').replace(/-[a-z0-9]+pw$/u, '');
const safeText = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').replace(/https?:\/\/[^\s|]+/giu, '[URL removed]').replace(/((?:battle-|game-bestof\d+-)?gen\d+[a-z0-9]+-\d+)-[a-z0-9]+pw/gu, '$1').slice(0, max);
const time = value => Number.isFinite(value) && value >= 0 && value < 1e16 ? value : undefined;
function identity(teamId, roomId) { if (typeof teamId !== 'string' || !HASH.test(teamId) || typeof roomId !== 'string' || !ROOM.test(roomId)) throw safeError('use an exact team hash and canonical child room ID'); }
function contained(root, target) { const part = relative(root, target); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); }

async function checkedPath(workspace, file, { createParents = false, allowMissing = false, maxBytes = MAX_BYTES } = {}) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw safeError('invalid workspace file');
  const root = await realpath(workspace), path = resolve(root, file);
  if (!contained(root, path)) throw safeError('file must remain inside the workspace');
  const parts = relative(root, path).split(sep); let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (index < parts.length - 1 && createParents) { try { await mkdir(current); } catch (created) { if (created.code !== 'EEXIST') throw created; } info = await lstat(current); }
      else if (index === parts.length - 1 && allowMissing) return { root, path, relative: slash(relative(root, path)), info: null };
      else throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw safeError('file and ancestors must be real workspace files and directories');
    if (!contained(root, await realpath(current))) throw safeError('file resolves outside the workspace');
    if (index === parts.length - 1 && info.size > maxBytes) throw safeError('file exceeds its size limit');
    if (index === parts.length - 1) return { root, path, relative: slash(relative(root, path)), info };
  }
}
async function storedGame(workspace, teamId, roomId) {
  identity(teamId, roomId);
  const game = (await listBattles({ workspace, includeArchived: true })).find(record => record.teamId === teamId && record.roomId === roomId);
  if (!game) throw safeError('the game is not registered in this team');
  return game;
}

function sanitizeRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const result = { teamPreview: request.teamPreview === true, wait: request.wait === true };
  if (Number.isSafeInteger(request.rqid) && request.rqid >= 0) result.rqid = request.rqid;
  if (Array.isArray(request.forceSwitch)) result.forceSwitch = request.forceSwitch.slice(0, 2).map(Boolean);
  if (Array.isArray(request.active)) result.active = [];
  if (request.side && ['p1', 'p2'].includes(request.side.id)) result.side = {
    id: request.side.id, name: safeText(request.side.name, 100),
    pokemon: (Array.isArray(request.side.pokemon) ? request.side.pokemon : []).slice(0, 6).map(pokemon => ({ ident: safeText(pokemon.ident, 200), details: safeText(pokemon.details, 300), active: pokemon.active === true, condition: safeText(pokemon.condition, 100) })),
  };
  return result;
}
function sanitizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const at = time(event.at);
  if (event.type === 'request') { const request = sanitizeRequest(event.request); return request ? { type: 'request', request, ...(at !== undefined ? { at } : {}) } : null; }
  if (!PROTOCOL.has(event.type) && !MINOR.has(event.type)) return null;
  if (!Array.isArray(event.data) || event.data.length > 30) return null;
  return { type: event.type, data: event.data.map(value => safeText(value, 2000)), ...(at !== undefined ? { at } : {}) };
}
function sanitizeSheets(sheets) {
  const result = {}, { Teams } = createRequire(import.meta.url)('pokemon-showdown');
  for (const side of ['p1', 'p2']) {
    const packed = sheets?.[side]; if (packed === undefined) continue;
    if (typeof packed !== 'string' || packed.length > 50000 || /[<>\r\n\u0000]/u.test(packed) || /https?:/iu.test(packed)) throw safeError('invalid open team sheet');
    let team; try { team = Teams.unpack(packed); } catch { throw safeError('invalid open team sheet'); }
    if (!team || !team.length || team.length > 6) throw safeError('invalid open team sheet');
    result[side] = Teams.pack(team);
  }
  return result;
}
function sanitizeDecision(value, turn) {
  if (!['action-status', 'choice-status', 'decision', 'choice'].includes(value?.event) || !STATUSES.has(value.status)) return null;
  const result = { status: value.status, event: value.event, turn: Number.isSafeInteger(value.turn) && value.turn >= 0 ? value.turn : turn };
  for (const field of ['at', 'rqid']) if (time(value[field]) !== undefined) result[field] = value[field];
  for (const field of ['selected', 'accepted', 'executed', 'submitted', 'serverDefaulted']) if (typeof value[field] === 'boolean') result[field] = value[field];
  for (const field of ['commandId', 'choice', 'reason']) if (typeof value[field] === 'string') result[field] = safeText(value[field], 1000);
  if (Array.isArray(value.actions)) result.actions = value.actions.slice(0, 2).map(action => {
    if (typeof action === 'string') return safeText(action, 300);
    const clean = {};
    for (const field of ['type', 'move', 'target', 'slot', 'pokemon']) if (typeof action?.[field] === 'string' || Number.isSafeInteger(action?.[field])) clean[field] = safeText(action[field], 200);
    if (typeof action?.mega === 'boolean') clean.mega = action.mega;
    return clean;
  });
  if (value.evidence && typeof value.evidence === 'object') {
    result.evidence = {};
    for (const field of ['type', 'move', 'slot', 'turn']) if (typeof value.evidence[field] === 'string' || Number.isSafeInteger(value.evidence[field])) result.evidence[field] = safeText(value.evidence[field], 200);
    if (typeof value.evidence.executed === 'boolean') result.evidence.executed = value.evidence.executed;
  }
  return result;
}
const completeProtocol = events => events.some(event => event.type === 'start') && events.filter(event => ['win', 'tie'].includes(event.type)).length === 1;
function verifyProtocolIdentity(events, game) {
  if (!completeProtocol(events)) return;
  const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
  const players = {};
  for (const event of events) if (event.type === 'player' && ['p1', 'p2'].includes(event.data?.[0]) && normalized(event.data[1])) players[event.data[0]] = normalized(event.data[1]);
  if (!players.p1 || !players.p2 || players[game.ownSide] !== normalized(game.username)) throw safeError('completed protocol player identity does not match the registered game');
  const terminal = events.find(event => ['win', 'tie'].includes(event.type));
  const winner = terminal.type === 'tie' ? null : normalized(terminal.data?.[0]);
  if (winner !== null && !Object.values(players).includes(winner)) throw safeError('completed protocol winner is not a registered player');
  const result = winner === null ? 'tie' : winner === normalized(game.username) ? 'win' : 'loss';
  if (game.outcome !== 'unknown' && game.outcome !== result) throw safeError('completed protocol result differs from the registered game');
}

/** Compact one game's useful state and decision journal; drop chat and session secrets. */
export async function saveGameEvidence({ workspace, teamId, roomId, events, sheets = {} } = {}) {
  identity(teamId, roomId);
  if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) throw safeError('supply a bounded game event list');
  const release = await acquireMetricsBattleLock({ workspace, teamId, roomId: `${roomId}-evidence` });
  try {
    const game = await storedGame(workspace, teamId, roomId);
    const { collectBattleEvents } = await import('./import.mjs');
    const data = collectBattleEvents(events, { defaultRoom: roomId }).get(roomId);
    if (!data?.events.length) throw safeError('no observations for this game');
    const clean = data.events.map(sanitizeEvent).filter(Boolean), decisions = [];
    verifyProtocolIdentity(clean, game);
    let turn = 0;
    for (const value of events) {
      if (canonicalRoom(value?.room ?? roomId) !== roomId) continue;
      if (value.type === 'turn') turn = Number(value.data?.[0]) || 0;
      const decision = sanitizeDecision(value, turn); if (decision) decisions.push(decision);
    }
    const document = { schemaVersion: 1, kind: 'sanitized-events', teamId, roomId, parentId: game.parentId, complete: completeProtocol(clean), events: clean, sheets: sanitizeSheets({ ...data.sheets, ...sheets }), decisions, decisionEvidenceIncluded: decisions.length > 0 };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`), hash = sha256(bytes);
    if (bytes.length > MAX_BYTES) throw safeError('compact game evidence exceeds its size limit');
    const file = `cache/team-metrics/evidence/${roomId}--${teamId}.events.json.gz`;
    const target = await checkedPath(workspace, file, { createParents: true, allowMissing: true });
    let previous;
    if (target.info) {
      const old = await decompress(await readFile(target.path), { maxOutputLength: MAX_BYTES });
      const oldHash = sha256(old);
      // A prior metadata-write failure is repairable only by the identical
      // proposed document; arbitrary file contents never become trusted.
      if (oldHash !== game.metadata.evidence?.sha256 && oldHash !== hash) throw safeError('existing evidence hash does not match its registered identity');
      previous = JSON.parse(old);
      if (previous.roomId !== roomId || previous.teamId !== teamId || previous.kind !== document.kind) throw safeError('existing evidence belongs to another game');
      if (previous.complete && (!document.complete || clean.length < previous.events.length)) return { roomId, teamId, evidence: game.metadata.evidence, complete: true, eventCount: previous.events.length, decisionEvidenceIncluded: previous.decisionEvidenceIncluded, status: 'preserved' };
      if (oldHash === hash && game.metadata.evidence?.sha256 === hash) return { roomId, teamId, evidence: game.metadata.evidence, complete: document.complete, eventCount: clean.length, decisionEvidenceIncluded: document.decisionEvidenceIncluded, status: 'unchanged' };
      if (previous.complete && document.complete && oldHash !== hash) {
        // A canonical completed history is immutable. Missing decision evidence
        // may be added only when the protocol and sheets are identical.
        if (JSON.stringify(previous.events) !== JSON.stringify(document.events) || JSON.stringify(previous.sheets) !== JSON.stringify(document.sheets) || previous.decisions.length) throw safeError('completed evidence differs; retain it for review');
      }
    }
    const pending = join(dirname(target.path), `.pending-${teamId}-${randomUUID()}.tmp`);
    try { await writeFile(pending, await compress(bytes, { level: 9 }), { flag: 'wx', mode: 0o600 }); await rename(pending, target.path); }
    finally { await rm(pending, { force: true }); }
    const evidence = { path: file, sha256: hash, kind: 'sanitized-events', complete: document.complete, version: 1 };
    const saved = await updateBattleMetadata({ workspace, teamId, roomId, metadata: { evidence } });
    return { roomId, teamId, evidence: saved.record.metadata.evidence, complete: document.complete, eventCount: clean.length, decisionEvidenceIncluded: document.decisionEvidenceIncluded, status: previous ? 'updated' : 'created' };
  } finally { await release(); }
}

function filteredTurns(events, fromTurn, toTurn) {
  let turn = 0;
  return events.filter(event => { if (event.type === 'turn') turn = Number(event.data?.[0]) || 0; return turn === 0 || ((fromTurn === undefined || turn >= fromTurn) && (toTurn === undefined || turn <= toTurn)); });
}

/** Turn-scoped private evidence for agents; gzip bounds and identity hashes are checked on every read. */
export async function readGameEvidence({ workspace, teamId, roomId, fromTurn, toTurn } = {}) {
  identity(teamId, roomId);
  for (const value of [fromTurn, toTurn]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 10000)) throw safeError('turn bounds must be nonnegative integers');
  if (fromTurn !== undefined && toTurn !== undefined && fromTurn > toTurn) throw safeError('turn range is reversed');
  // Reads do not create lock rows or rewrite files. An in-flight replacement
  // can only fail its hash check, in which case cleanup keeps the sources.
  const game = await storedGame(workspace, teamId, roomId); let document, reference, sourceKind;
    if (game.metadata.evidence) {
      reference = game.metadata.evidence;
      const source = await checkedPath(workspace, reference.path), bytes = await decompress(await readFile(source.path), { maxOutputLength: MAX_BYTES });
      if (sha256(bytes) !== reference.sha256) throw safeError('evidence hash verification failed');
      document = JSON.parse(bytes);
      if (document.schemaVersion !== 1 || document.kind !== 'sanitized-events' || document.roomId !== roomId || document.teamId !== teamId || !Array.isArray(document.events) || document.events.length > MAX_EVENTS || document.complete !== reference.complete) throw safeError('evidence identity or schema verification failed');
      document = { ...document, events: document.events.map(sanitizeEvent).filter(Boolean), sheets: sanitizeSheets(document.sheets), decisions: (document.decisions ?? []).map(value => sanitizeDecision(value, value.turn ?? 0)).filter(Boolean) };
      if (document.complete !== completeProtocol(document.events)) throw safeError('canonical protocol completeness does not match its metadata');
      verifyProtocolIdentity(document.events, game);
      sourceKind = 'sanitized-events';
    } else if (game.metadata.replay?.verified && game.metadata.replay.evidencePath) {
      reference = game.metadata.replay;
      const source = await checkedPath(workspace, reference.evidencePath), bytes = await decompress(await readFile(source.path), { maxOutputLength: MAX_BYTES });
      if (sha256(bytes) !== reference.logSha256) throw safeError('replay evidence hash verification failed');
      const events = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith('|')).map(line => { const [, type, ...data] = line.split('|'); return sanitizeEvent({ type, data }); }).filter(Boolean);
      document = { events, sheets: {}, decisions: [], complete: completeProtocol(events) }; sourceKind = 'verified-replay';
    } else throw safeError('no durable game evidence is registered');
    const decisions = document.decisions.filter(value => value.turn === 0 || ((fromTurn === undefined || value.turn >= fromTurn) && (toTurn === undefined || value.turn <= toTurn)));
    return { schemaVersion: 1, teamId, roomId, parentId: game.parentId, events: filteredTurns(document.events, fromTurn, toTurn), sheets: document.sheets, decisions, complete: document.complete === true, decisionEvidenceIncluded: document.decisions.length > 0, sourceKind, evidence: { path: reference.path ?? reference.evidencePath, sha256: reference.sha256 ?? reference.logSha256 }, turnWindow: { fromTurn: fromTurn ?? null, toTurn: toTurn ?? null, setupIncluded: true } };
}

export function reviewedCheckpoint(checkpoint, { teamId, parentId }) {
  if (!checkpoint || checkpoint.parentId !== parentId || (checkpoint.teamId ?? checkpoint.teamSha256) !== teamId || !/^review-complete(?:$|-)/u.test(checkpoint.status ?? '') || !['string', 'number'].includes(typeof checkpoint.reviewedAt) || !Number.isFinite(new Date(checkpoint.reviewedAt).getTime())) return false;
  const adoption = checkpoint.adoption;
  return Boolean(checkpoint.decisionReview && Object.keys(checkpoint.decisionReview).length && checkpoint.reusableOutcome && Object.keys(checkpoint.reusableOutcome).length && adoption && (adoption.syncVerified === true || adoption.synchronized === true) && HASH.test(adoption.sourceSha256) && adoption.sourceSha256 === adoption.installedSha256);
}
async function jsonFile(workspace, file) { const source = await checkedPath(workspace, file, { maxBytes: 2 * 1024 * 1024 }); return JSON.parse(await readFile(source.path, 'utf8')); }
async function sourceProtection(workspace) {
  const registered = new Set(), activePaths = new Set(); let activeClient = false;
  try {
    const registry = await jsonFile(workspace, 'cache/team-metrics/sources/registry.json');
    if (!Array.isArray(registry)) throw safeError('invalid source registry');
    for (const source of registry) for (const file of [...(source.files ?? []), source.ledgerFile, source.teamFile].filter(Boolean)) registered.add(slash(relative(resolve(workspace), resolve(workspace, file))).toLowerCase());
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of ['cache/showdown-session.json', 'cache/showdown-standby-session.json']) {
    try {
      const descriptor = await jsonFile(workspace, file);
      const pid = descriptor.pid;
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); activeClient = true; } catch (error) { if (error.code === 'EPERM') activeClient = true; } }
      else activeClient = true;
      for (const key of ['logFile', 'logPath', 'eventLogFile', 'decisionLogFile']) if (typeof descriptor[key] === 'string') activePaths.add(slash(relative(resolve(workspace), resolve(workspace, descriptor[key]))).toLowerCase());
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { registered, activePaths, activeClient };
}
function candidateReason(path, parentId, protections, checkpointFile, closedFiles) {
  const normalized = path.toLowerCase(), parentDirectory = `cache/bo3-runs/${parentId.toLowerCase()}/`;
  if (!normalized.startsWith('cache/')) return 'Only explicit generated cache files can be removed.';
  if (normalized === checkpointFile.toLowerCase() || /(?:^|\/)(?:team-metrics|teams|champions-mc-reviews|reviews?|skills?|node_modules|exports?|backups?|calcs?|calculations?|credentials?)(?:\/|$)/u.test(normalized) || /(?:credential|password|secret|session|ledger|result|review|checkpoint|team|export|backup|calc|skill)/u.test(normalized)) return 'Useful data, reviews, credentials and session files are protected.';
  if (protections.registered.has(normalized)) return protections.activeClient ? 'Registered shared source is protected while the client is open.' : 'Registered shared source requires a separate all-set coverage audit.';
  if (protections.activePaths.has(normalized)) return 'An active session owns this source file.';
  if (protections.activeClient && !closedFiles.has(normalized)) return 'An open client may still write this source; an observed closed-writer attestation is required.';
  if (normalized.startsWith(parentDirectory) && ['.jsonl', '.log', '.tmp'].includes(extname(normalized))) return null;
  return 'Only this set’s generated protocol logs or temporary files are eligible; unknown JSON and other cache files are retained.';
}

function fileRoomCoverage(content, extension, childIds, parentId) {
  const allowed = new Set([...childIds, parentId]);
  const roomPattern = /(?:battle-|game-bestof\d+-|bestof3-)gen\d+[a-z0-9]+-\d+(?:-[a-z0-9]+pw)?/gu;
  const lines = content.split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) return null;
  if (lines.length > 100000) return 'Source exceeds the bounded per-set coverage audit.';
  let currentRoom;
  for (const line of lines) {
    const mentioned = [...line.matchAll(roomPattern)].map(match => canonicalRoom(match[0]));
    if (mentioned.some(room => !allowed.has(room))) return 'Source contains another or unknown room; a separate all-set archive audit is required.';
    if (extension === '.jsonl' || line.trimStart().startsWith('{')) {
      let value; try { value = JSON.parse(line); } catch { return 'Unrecognized source content must be retained for review.'; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !mentioned.length) return 'A source row has no verified room identity; retain the source.';
      // A structured audit row can place its known room in a nested field.
      // Every room reference, including object keys, was checked above.
    } else {
      if (line.startsWith('>')) { currentRoom = canonicalRoom(line.slice(1).trim()); if (!allowed.has(currentRoom)) return 'Protocol source belongs to an unverified room.'; }
      else if (!line.startsWith('|') || !currentRoom) return 'Protocol source lacks an explicit verified room header.';
    }
  }
  return null;
}

function isSubsequence(source, retained) {
  let index = 0;
  for (const expected of source) {
    const target = JSON.stringify(expected);
    while (index < retained.length && JSON.stringify(retained[index]) !== target) index++;
    if (index === retained.length) return false;
    index++;
  }
  return true;
}
async function canonicalSourceCoverage(workspace, content, extension, records, parentId) {
  const values = []; let room;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (extension === '.jsonl' || line.trimStart().startsWith('{')) {
      const value = JSON.parse(line);
      const ownRoom = canonicalRoom(value.room ?? value.roomId ?? '');
      if (ownRoom === parentId) {
        const fields = value.event === 'result' ? ['room', 'event', 'type', 'winner', 'at'] : ['room', 'event', 'type', 'data', 'at'];
        if (!['result', 'battle-event'].includes(value.event) || !['win', 'tie'].includes(value.type) || Object.keys(value).some(key => !fields.includes(key))) return 'Parent source contains facts outside the retained official-result whitelist.';
        if (value.at !== undefined && time(value.at) === undefined) return 'Parent source has an unsupported result timestamp.';
        const normalized = entry => String(entry ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
        const winner = value.type === 'tie' ? null : normalized(value.event === 'result' ? value.winner : value.data?.[0]);
        if (value.event === 'battle-event' && (!Array.isArray(value.data) || value.data.length !== (value.type === 'tie' ? 0 : 1))) return 'Parent source has unsupported official-result data.';
        if (winner !== null && !records.every(record => Object.values(record.players).map(normalized).includes(winner))) return 'Parent source winner does not match the retained set players.';
        if (!records.every(record => record.metadata.setResult?.completed && record.metadata.setResult.outcome === (winner === null ? 'tie' : winner === normalized(record.username) ? 'win' : 'loss'))) return 'Parent source result conflicts with the retained official set outcome.';
        continue;
      }
      if (!ROOM.test(ownRoom)) return 'A structured source row cannot be independently matched to retained game facts.';
      if (!['battle-event', 'request', 'result', 'sheet', 'action-status', 'choice-status', 'decision', 'choice', undefined].includes(value.event)) return 'An unarchived structured observation or calculation remains in the source.';
      if (value.event === 'battle-event' || value.event === undefined) {
        if (!PROTOCOL.has(value.type) && !MINOR.has(value.type) && !['request', 'c', 'c:', 'chat', '-message', 'html', 'raw', 'uhtml', 'uhtmlchange'].includes(value.type)) return 'An unsupported protocol observation remains in the source.';
      }
      if (['action-status', 'choice-status', 'decision', 'choice'].includes(value.event) && !sanitizeDecision(value, 0)) return 'An unsupported action journal entry remains in the source.';
      values.push({ ...value, room: ownRoom });
    } else if (line.startsWith('>')) room = canonicalRoom(line.slice(1).trim());
    else {
      if (room === parentId) return 'Parent protocol source needs a separate retained-evidence audit.';
      const [, type, ...data] = line.split('|');
      if (!PROTOCOL.has(type) && !MINOR.has(type) && !['request', 'showteam', 'c', 'c:', 'chat', '-message', 'html', 'raw', 'uhtml', 'uhtmlchange'].includes(type)) return 'An unsupported protocol observation remains in the source.';
      if (type === 'request') { let request; try { request = JSON.parse(data.join('|')); } catch { return 'Source request JSON is not recognized.'; } values.push({ room, event: 'request', request }); }
      else if (type === 'showteam') values.push({ room, event: 'sheet', side: data[0], packed: data.slice(1).join('|') });
      else values.push({ room, type, data });
    }
  }
  const { collectBattleEvents } = await import('./import.mjs');
  const collected = collectBattleEvents(values);
  for (const [roomId, data] of collected) {
    if (!records.some(record => record.roomId === roomId)) return 'Source game is not part of this retained set.';
    const retained = await readGameEvidence({ workspace, teamId: records[0].teamId, roomId });
    const projected = data.events.map(sanitizeEvent).filter(Boolean);
    if (!isSubsequence(projected, retained.events)) return `${roomId}: source contains state or turns absent from retained canonical evidence.`;
    const sheets = sanitizeSheets(data.sheets);
    if (Object.entries(sheets).some(([side, packed]) => retained.sheets[side] !== packed)) return `${roomId}: source contains an open sheet absent from retained evidence.`;
    let turn = 0; const decisions = [];
    for (const value of values) {
      if (value.room !== roomId) continue;
      if (value.type === 'turn') turn = Number(value.data?.[0]) || 0;
      const decision = sanitizeDecision(value, turn); if (decision) decisions.push(decision);
    }
    if (!isSubsequence(decisions, retained.decisions)) return `${roomId}: source contains selected, accepted or executed decisions absent from retained evidence.`;
  }
  return null;
}

/** A read-only, exact-file deletion plan. Missing replay/review/evidence keeps logs intact. */
export async function buildCleanupPlan({ workspace, teamId, parentId, checkpointFile, files = [], closedFiles = [] } = {}) {
  if (typeof teamId !== 'string' || !HASH.test(teamId) || typeof parentId !== 'string' || !PARENT.test(parentId) || typeof checkpointFile !== 'string' || !Array.isArray(files) || files.length > 200 || !Array.isArray(closedFiles) || closedFiles.length > 200) throw safeError('invalid BO3 cleanup request');
  const globalBlocks = [], candidates = [], blocked = [], decisionEvidence = [];
  let checkpoint, checkpointPath;
  try { const source = await checkedPath(workspace, checkpointFile, { maxBytes: 2 * 1024 * 1024 }); checkpointPath = source.relative; checkpoint = JSON.parse(await readFile(source.path, 'utf8')); if (!reviewedCheckpoint(checkpoint, { teamId, parentId })) globalBlocks.push('The exact set needs a completed decision review and verified skill adoption checkpoint.'); }
  catch { globalBlocks.push('The private decision review checkpoint is missing, invalid or unsafe.'); checkpointPath = slash(checkpointFile); }
  const records = (await listBattles({ workspace, includeArchived: true })).filter(record => record.teamId === teamId && record.parentId === parentId);
  if (!records.length) globalBlocks.push('No child games are registered for this exact set and team.');
  if (new Set(records.filter(record => record.metadata.setResult?.completed).map(record => record.metadata.setResult.outcome)).size > 1) globalBlocks.push('Stored official parent results conflict; retain source evidence for reconciliation.');
  for (const record of records) {
    if (!record.completed || !record.metadata.setResult?.completed) globalBlocks.push(`${record.roomId}: official completed game and parent results are required.`);
    if (!record.metadata.replay?.verified || !record.metadata.replay.evidencePath) globalBlocks.push(`${record.roomId}: a verified saved replay and retained replay evidence are required.`);
    if (!record.metadata.evidence?.complete) globalBlocks.push(`${record.roomId}: complete durable game state evidence is required.`);
    else try { const evidence = await readGameEvidence({ workspace, teamId, roomId: record.roomId }); decisionEvidence.push({ roomId: record.roomId, included: evidence.decisionEvidenceIncluded, limitation: evidence.decisionEvidenceIncluded ? null : 'No action journal is available; executed protocol does not establish selected or accepted choices. Keep this limitation in the private review checkpoint.' }); if (!evidence.complete || evidence.sourceKind !== 'sanitized-events') globalBlocks.push(`${record.roomId}: complete canonical game evidence could not be verified.`); }
    catch { globalBlocks.push(`${record.roomId}: canonical evidence failed verification.`); }
    if (record.metadata.replay?.evidencePath) {
      try { const replay = await checkedPath(workspace, record.metadata.replay.evidencePath); if (sha256(await decompress(await readFile(replay.path), { maxOutputLength: MAX_BYTES })) !== record.metadata.replay.logSha256) globalBlocks.push(`${record.roomId}: saved replay evidence failed its hash check.`); }
      catch { globalBlocks.push(`${record.roomId}: saved replay evidence is missing or unsafe.`); }
    }
  }
  const expected = checkpoint?.expectedChildIds ?? checkpoint?.children?.map(child => typeof child === 'string' ? child : child.roomId ?? child.id);
  if (!Array.isArray(expected) || !expected.length) globalBlocks.push('The checkpoint must explicitly enumerate all expected child game IDs.');
  else {
    for (const child of expected) if (typeof child !== 'string' || !records.some(record => record.roomId === canonicalRoom(child))) globalBlocks.push('A child named by the checkpoint is missing from this exact team’s retained history.');
    if (records.some(record => !expected.some(child => canonicalRoom(child) === record.roomId))) globalBlocks.push('The checkpoint omits a registered child of this set.');
  }
  let protections;
  try { protections = await sourceProtection(workspace); } catch { globalBlocks.push('Source ownership protection could not be verified.'); protections = { registered: new Set(), activePaths: new Set(), activeClient: true }; }
  const closed = new Set(closedFiles.filter(file => typeof file === 'string').map(file => slash(relative(resolve(workspace), resolve(workspace, file))).toLowerCase()));
  for (const file of [...new Set(files)]) {
    let entry;
    try {
      const source = await checkedPath(workspace, file, { maxBytes: 64 * 1024 * 1024 });
      const bytes = await readFile(source.path);
      const extension = extname(source.relative).toLowerCase();
      let reason = candidateReason(source.relative, parentId, protections, checkpointPath, closed) ?? globalBlocks[0] ?? null;
      if (reason === null && ['.jsonl', '.log'].includes(extension)) {
        reason = fileRoomCoverage(bytes.toString('utf8'), extension, records.map(record => record.roomId), parentId);
        if (reason === null) reason = await canonicalSourceCoverage(workspace, bytes.toString('utf8'), extension, records, parentId);
      }
      entry = { path: source.relative, sha256: sha256(bytes), size: source.info.size, eligible: reason === null, reason };
    } catch { entry = { path: typeof file === 'string' ? safeText(file, 1000) : '[invalid path]', sha256: null, size: null, eligible: false, reason: 'File is missing, outside the workspace, linked or otherwise unsafe.' }; }
    candidates.push(entry); if (!entry.eligible) blocked.push(entry);
  }
  return { schemaVersion: 1, teamId, parentId, checkpointFile: checkpointPath, ready: globalBlocks.length === 0, childIds: records.map(record => record.roomId), decisionEvidence, files: candidates, blocked, blockers: [...new Set(globalBlocks)], activeClient: protections.activeClient, eligibleCount: candidates.filter(file => file.eligible).length, keptCount: blocked.length, policy: 'Exact generated files only; protected data and registered shared logs remain intact.' };
}

/** Execute only a freshly checked explicit plan; no recursive removal or client changes. */
export async function cleanupBo3Files({ confirmed = false, ...args } = {}) {
  if (confirmed !== true) throw safeError('inspect the dry-run plan before confirming exact-file cleanup');
  const plan = await buildCleanupPlan(args), removed = [], kept = [];
  for (const entry of plan.files) {
    if (!plan.ready || !entry.eligible) { kept.push(entry); continue; }
    try {
      const source = await checkedPath(args.workspace, entry.path, { maxBytes: 64 * 1024 * 1024 });
      if (source.info.size !== entry.size || sha256(await readFile(source.path)) !== entry.sha256) { kept.push({ ...entry, eligible: false, reason: 'File changed after the cleanup plan; retained for review.' }); continue; }
      await unlink(source.path); removed.push(entry);
    } catch { kept.push({ ...entry, eligible: false, reason: 'Exact-file recheck or removal failed; retained for review.' }); }
  }
  return { ...plan, removed, kept, removedCount: removed.length, keptCount: kept.length };
}
