import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { acquireMetricsBattleLock } from './catalog.mjs';
import { listBattles, updateBattleMetadata } from './store.mjs';
import { previewTerminalProof, validPreviewCorroboration, ownedPreviewProof, ownedParentPreviewProof, historicalOwnedParentPreviewProof } from './preview-terminal.mjs';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_BYTES = 12 * 1024 * 1024, MAX_EVENTS = 20000;
const HASH = /^[a-f0-9]{64}$/u;
const ROOM = /^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const PARENT = /^(?:game-)?bestof3-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u;
const PROTOCOL = new Set(['player', 'poke', 'start', 'turn', 'upkeep', 'switch', 'drag', 'replace', 'detailschange', 'swap', 'move', 'cant', 'faint', 'win', 'tie', 'gen', 'gametype', 'tier', 'teamsize', 'teampreview']);
const MINOR = new Set(['-damage', '-heal', '-sethp', '-status', '-curestatus', '-cureteam', '-boost', '-unboost', '-setboost', '-swapboost', '-invertboost', '-clearboost', '-clearallboost', '-clearpositiveboost', '-clearnegativeboost', '-copyboost', '-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-swapsideconditions', '-start', '-end', '-singleturn', '-singlemove', '-activate', '-fail', '-miss', '-notarget', '-immune', '-crit', '-supereffective', '-resisted', '-ohko', '-hitcount', '-nothing', '-combine', '-waiting', '-prepare', '-mustrecharge', '-recharge', '-anim', '-item', '-enditem', '-ability', '-endability', '-transform', '-formechange', '-mega', '-primal', '-burst', '-zpower', '-zbroken', '-terastallize', '-block']);
const STATUSES = new Set(['selected', 'sent', 'accepted', 'rejected', 'executed', 'execution-observed', 'server-defaulted', 'defaulted', 'unsubmitted', 'unknown', 'stale', 'expired', 'inactivity']);
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
  if(value.phase==='preview')result.phase='preview';
  for (const field of ['at', 'rqid']) if (time(value[field]) !== undefined) result[field] = value[field];
  for (const field of ['selected', 'accepted', 'executed', 'submitted', 'serverDefaulted']) if (typeof value[field] === 'boolean') result[field] = value[field];
  for (const field of ['commandId', 'choice', 'reason']) if (typeof value[field] === 'string') result[field] = safeText(value[field], 1000);
  if (Array.isArray(value.actions)) result.actions = value.actions.slice(0, 2).map(action => {
    if (typeof action === 'string') return safeText(action, 300);
    const clean = {};
    for (const field of ['type', 'move', 'target', 'slot', 'pokemon']) if (typeof action?.[field] === 'string' || Number.isSafeInteger(action?.[field])) clean[field] = safeText(action[field], 200);
    if (typeof action?.mega === 'boolean') clean.mega = action.mega;
    if(action?.type==='team'&&Array.isArray(action.order)&&action.order.length>=1&&action.order.length<=6&&new Set(action.order).size===action.order.length&&action.order.every(slot=>Number.isInteger(slot)&&slot>=1&&slot<=6))clean.order=[...action.order];
    return clean;
  });
  if (value.evidence && typeof value.evidence === 'object') {
    result.evidence = {};
    for (const field of ['type', 'move', 'slot', 'turn', 'transition']) if (typeof value.evidence[field] === 'string' || Number.isSafeInteger(value.evidence[field])) result.evidence[field] = safeText(value.evidence[field], 200);
    if (typeof value.evidence.executed === 'boolean') result.evidence.executed = value.evidence.executed;
  }
  return result;
}
/** Bounded control telemetry only: never retain commands, errors, URLs or secrets. */
const CONTROL_TRACE_TIMES=['at','elapsedMs','latencyMs','planningDeadlineAt','cutoffAt','emergencyAt','hardDeadlineAt','turnDeadlineAt','bankDeadlineAt','unknownCutoffAt','clockObservedAt','recoveryStartedAt','timerDisabledAt'];
const CONTROL_TRACE_LABELS=['controllerId','source','status','kind','reasonCode','clockSource','observedClockSource','deadlineBasis'];
const CONTROL_TRACE_FLAGS=['clockFreshForRequest','emergencyEligible','controlFailure','recovering'];
export function sanitizeControlTrace(value, turn = 0) {
  if (value?.event !== 'control-trace' || typeof value.type !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(value.type)) return null;
  const room = canonicalRoom(value.room);
  if (!ROOM.test(room)) return null;
  const result = {event:'control-trace', type:value.type, room};
  const observedTurn = Number.isSafeInteger(value.turn) && value.turn >= 0 ? value.turn : turn;
  if (Number.isSafeInteger(observedTurn) && observedTurn >= 0) result.turn = observedTurn;
  for (const field of ['seq', 'rqid', 'revision', 'generation']) if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = value[field];
  for (const field of CONTROL_TRACE_TIMES) if (time(value[field]) !== undefined) result[field] = value[field];
  for (const field of CONTROL_TRACE_LABELS) if (typeof value[field] === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value[field])) result[field] = value[field];
  for (const field of CONTROL_TRACE_FLAGS) if (typeof value[field] === 'boolean') result[field] = value[field];
  return result;
}
function mergeControlTrace(previous = [], incoming = []) {
  // Unlike a replayed server history, control telemetry's timestamp is part of
  // the observation: identical retries at distinct times must remain distinct.
  const keys = new Set(previous.map(value => JSON.stringify(value))), merged = [...previous];
  for (const value of incoming) {const key = JSON.stringify(value); if (!keys.has(key)) {merged.push(value); keys.add(key);}}
  if (merged.length > MAX_EVENTS) throw safeError('compact control trace exceeds its event limit');
  return merged;
}
const completeProtocol = (events, game, previewObservation) => (events.some(event => event.type === 'start') && events.filter(event => ['win', 'tie'].includes(event.type)).length === 1) || Boolean(previewTerminalProof(events, game, previewObservation));
function verifyProtocolIdentity(events, game, previewObservation) {
  if (!completeProtocol(events, game, previewObservation)) return;
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

/** A recovered parent observation is usable only with its durable server replay. */
async function verifyOwnedParentReplay(workspace, game, observation) {
  const historical = observation?.kind === 'historical-owned-parent-preview-terminal';
  if (!(historical ? historicalOwnedParentPreviewProof(game, observation) : ownedParentPreviewProof(game, observation))) throw safeError('invalid owned parent preview observation');
  if (historical) {
    const {verifyHistoricalStatusArchive} = await import('./historical-status.mjs');
    await verifyHistoricalStatusArchive({workspace,game,observation});
  }
  const replay = game.metadata.replay;
  if (!HASH.test(observation.replayLogSha256 ?? '') || replay?.verified !== true || replay.logSha256 !== observation.replayLogSha256 || replay.evidencePath !== `cache/team-metrics/evidence/${game.roomId}--${game.teamId}.replay.log.gz`) throw safeError('owned parent preview needs its verified saved replay');
  const source = await checkedPath(workspace, replay.evidencePath), bytes = await decompress(await readFile(source.path), {maxOutputLength: MAX_BYTES});
  if (sha256(bytes) !== replay.logSha256) throw safeError('owned parent preview replay hash verification failed');
  const {collectBattleEvents, decodeInput} = await import('./import.mjs');
  const data = collectBattleEvents(decodeInput({path:'replay.json',text:JSON.stringify({id:game.roomId,log:bytes.toString('utf8')})})).get(game.roomId);
  if (!data || data.startedObserved || data.progressObserved || !previewTerminalProof(data.events.map(sanitizeEvent).filter(Boolean), game, observation)) throw safeError('owned parent preview conflicts with the saved server replay');
}

const sameObservedFact=(a,b)=>JSON.stringify({...a,at:undefined})===JSON.stringify({...b,at:undefined});
function factSubsequence(source,target){let index=0;for(const value of source){while(index<target.length&&!sameObservedFact(value,target[index]))index++;if(index===target.length)return false;index++;}return true;}
function preserveObservedFacts(previous,incoming){let index=0;return incoming.map(value=>index<previous.length&&sameObservedFact(previous[index],value)?previous[index++]:value);}
function mergeCompletedEvidence(previous,incoming){
  const split=events=>{const terminal=events.findIndex(event=>['win','tie'].includes(event.type));if(terminal<0)throw safeError('completed evidence differs; retain it for review');return {core:events.slice(0,terminal+1),tail:events.slice(terminal+1)};};
  const before=split(previous.events),after=split(incoming.events);
  if(before.core.length!==after.core.length||before.core.some((event,index)=>!sameObservedFact(event,after.core[index]))||[...before.tail,...after.tail].some(event=>event.type!=='player')||previous.parentId&&incoming.parentId&&previous.parentId!==incoming.parentId)throw safeError('completed evidence differs; retain it for review');
  const sheets={...previous.sheets};for(const [side,packed]of Object.entries(incoming.sheets)){if(sheets[side]&&sheets[side]!==packed)throw safeError('completed evidence differs; retain it for review');sheets[side]=packed;}
  const oldDecisions=previous.decisions||[],newDecisions=incoming.decisions||[];let decisions=oldDecisions;
  if(factSubsequence(oldDecisions,newDecisions))decisions=preserveObservedFacts(oldDecisions,newDecisions);
  else if(!factSubsequence(newDecisions,oldDecisions))throw safeError('completed evidence differs; retain it for review');
  // Rejoined history has new receive timestamps. Keep the first battle core;
  // append only player lifecycle observations after its immutable terminal event.
  let tail;
  if(factSubsequence(after.tail,before.tail))tail=before.tail;
  else if(factSubsequence(before.tail,after.tail))tail=preserveObservedFacts(before.tail,after.tail);
  else{
    let overlap=Math.min(before.tail.length,after.tail.length);
    while(overlap&&!before.tail.slice(-overlap).every((event,index)=>sameObservedFact(event,after.tail[index])))overlap--;
    tail=[...before.tail,...after.tail.slice(overlap)];
  }
  const events=[...before.core,...tail];
  if(events.length>MAX_EVENTS)throw safeError('compact game evidence exceeds its event limit');
  return {...incoming,parentId:previous.parentId||incoming.parentId,events,sheets,decisions,controlTrace:mergeControlTrace(previous.controlTrace, incoming.controlTrace),decisionEvidenceIncluded:decisions.length>0};
}

/** Compact one game's useful state and decision journal; drop chat and session secrets. */
export async function saveGameEvidence({ workspace, teamId, roomId, events, sheets = {}, previewCorroboration, previewObservation } = {}) {
  identity(teamId, roomId);
  if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) throw safeError('supply a bounded game event list');
  const release = await acquireMetricsBattleLock({ workspace, teamId, roomId: `${roomId}-evidence` });
  try {
    const game = await storedGame(workspace, teamId, roomId);
    if (previewCorroboration !== undefined && !validPreviewCorroboration(previewCorroboration, game)) throw safeError('invalid legacy preview corroboration');
    const parentPreview = ['owned-parent-preview-terminal','historical-owned-parent-preview-terminal'].includes(previewObservation?.kind);
    if (parentPreview) {
      if (previewCorroboration || game.metadata.evidence?.complete !== true && previewObservation.canonicalHistory?.sha256 !== game.metadata.evidence?.sha256) throw safeError('owned parent preview does not match the existing canonical history');
      await verifyOwnedParentReplay(workspace, game, previewObservation);
    } else if (previewObservation !== undefined && (!ownedPreviewProof(game, previewObservation) || !previewCorroboration)) throw safeError('invalid owned preview observation');
    const { collectBattleEvents } = await import('./import.mjs');
    const data = collectBattleEvents(events.filter(value => value?.event !== 'control-trace'), { defaultRoom: roomId }).get(roomId);
    if (!data?.events.length) throw safeError('no observations for this game');
    const clean = data.events.map(sanitizeEvent).filter(Boolean), decisions = [], controlTrace = [];
    if (previewTerminalProof(clean, game, previewObservation) && (data.startedObserved || data.progressObserved)) throw safeError('earlier observed battle progress prevents preview-terminal completeness');
    verifyProtocolIdentity(clean, game, previewObservation);
    let turn = 0;
    for (const value of events) {
      if (canonicalRoom(value?.room ?? roomId) !== roomId) continue;
      if (value.type === 'turn' && value.event !== 'control-trace') turn = Number(value.data?.[0]) || 0;
      const decision = sanitizeDecision(value, turn); if (decision) decisions.push(decision);
      const trace = sanitizeControlTrace(value, turn); if (trace) controlTrace.push(trace);
    }
    let document = { schemaVersion: 1, kind: 'sanitized-events', teamId, roomId, parentId: game.parentId, complete: completeProtocol(clean, game, previewObservation), observedHistory: {started: data.startedObserved === true, progress: data.progressObserved === true}, events: clean, sheets: sanitizeSheets({ ...data.sheets, ...sheets }), decisions, controlTrace, decisionEvidenceIncluded: decisions.length > 0, ...(previewObservation ? {previewObservation} : {}) };
    if (previewCorroboration) {
      if (!previewTerminalProof(clean, game, previewObservation)) throw safeError('legacy corroboration needs exact preview-terminal observations');
      document.observedHistory = {started:null,progress:null};
      document.previewCorroboration = previewCorroboration;
    }
    let bytes = Buffer.from(`${JSON.stringify(document)}\n`), hash = sha256(bytes);
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
      if (previous.complete && parentPreview && JSON.stringify(previous.previewObservation) !== JSON.stringify(previewObservation)) throw safeError('completed evidence differs; retain it for review');
      if (previous.controlTrace !== undefined && (!Array.isArray(previous.controlTrace) || previous.controlTrace.length > MAX_EVENTS)) throw safeError('control trace schema verification failed');
      previous.controlTrace = (previous.controlTrace ?? []).map(value => sanitizeControlTrace(value, value.turn ?? 0)).filter(value => value && value.room === roomId);
      document.controlTrace = mergeControlTrace(previous.controlTrace, document.controlTrace);
      document.observedHistory = {
        started: document.observedHistory.started || previous.observedHistory?.started === true || previous.events.some(event=>event.type==='start') || (previewCorroboration || previous.previewCorroboration ? null : false),
        progress: document.observedHistory.progress || previous.observedHistory?.progress === true || previous.events.some(event=>event.type==='start'||MINOR.has(event.type)||['turn','upkeep','switch','drag','replace','detailschange','swap','move','cant','faint'].includes(event.type)||event.type==='request'&&(Array.isArray(event.request?.active)||Array.isArray(event.request?.forceSwitch)||!event.request?.teamPreview&&event.request?.side?.pokemon?.some(pokemon=>pokemon.active))) || (previewCorroboration || previous.previewCorroboration ? null : false),
      };
      if (previous.previewCorroboration && !document.previewCorroboration) document.previewCorroboration = previous.previewCorroboration;
      if (previous.previewObservation && !document.previewObservation) document.previewObservation = previous.previewObservation;
      if (parentPreview && !previous.complete && (previous.observedHistory?.started !== false || previous.observedHistory?.progress !== false || !factSubsequence(previous.events, document.events))) throw safeError('owned parent preview requires intact canonical zero-progress observations');
      bytes=Buffer.from(`${JSON.stringify(document)}\n`);hash=sha256(bytes);
      if(bytes.length>MAX_BYTES)throw safeError('compact game evidence exceeds its size limit');
      if (previewTerminalProof(clean, game, document.previewObservation) && (document.observedHistory.started || document.observedHistory.progress)) throw safeError('earlier observed battle progress prevents preview-terminal completeness');
      if (previous.complete && !document.complete) {
        if (JSON.stringify(previous.controlTrace) === JSON.stringify(document.controlTrace)) return { roomId, teamId, evidence: game.metadata.evidence, complete: true, eventCount: previous.events.length, decisionEvidenceIncluded: previous.decisionEvidenceIncluded, status: 'preserved' };
        // A late watchdog observation must survive even when its recorder has
        // only partial protocol history. Keep the completed battle unchanged.
        document = {...previous, controlTrace:document.controlTrace};
        bytes = Buffer.from(`${JSON.stringify(document)}\n`); hash = sha256(bytes);
      }
      if (oldHash === hash && game.metadata.evidence?.sha256 === hash) return { roomId, teamId, evidence: game.metadata.evidence, complete: document.complete, eventCount: clean.length, decisionEvidenceIncluded: document.decisionEvidenceIncluded, status: 'unchanged' };
      if (previous.complete && document.complete && oldHash !== hash) {
        document=mergeCompletedEvidence(previous,document);
        bytes=Buffer.from(`${JSON.stringify(document)}\n`);hash=sha256(bytes);
        if(bytes.length>MAX_BYTES)throw safeError('compact game evidence exceeds its size limit');
        if(oldHash===hash&&game.metadata.evidence?.sha256===hash)return {roomId,teamId,evidence:game.metadata.evidence,complete:true,eventCount:document.events.length,decisionEvidenceIncluded:document.decisionEvidenceIncluded,status:'unchanged'};
      }
    }
    const pending = join(dirname(target.path), `.pending-${teamId}-${randomUUID()}.tmp`);
    try { await writeFile(pending, await compress(bytes, { level: 9 }), { flag: 'wx', mode: 0o600 }); await rename(pending, target.path); }
    finally { await rm(pending, { force: true }); }
    const evidence = { path: file, sha256: hash, kind: 'sanitized-events', complete: document.complete, version: 1 };
    const saved = await updateBattleMetadata({ workspace, teamId, roomId, metadata: { evidence } });
    return { roomId, teamId, evidence: saved.record.metadata.evidence, complete: document.complete, eventCount: document.events.length, decisionEvidenceIncluded: document.decisionEvidenceIncluded, status: previous ? 'updated' : 'created' };
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
      if (document.controlTrace !== undefined && (!Array.isArray(document.controlTrace) || document.controlTrace.length > MAX_EVENTS)) throw safeError('control trace schema verification failed');
      document = { ...document, events: document.events.map(sanitizeEvent).filter(Boolean), sheets: sanitizeSheets(document.sheets), decisions: (document.decisions ?? []).map(value => sanitizeDecision(value, value.turn ?? 0)).filter(Boolean), controlTrace:(document.controlTrace ?? []).map(value => sanitizeControlTrace(value, value.turn ?? 0)).filter(value => value && value.room === roomId) };
      // Older recorders honestly marked a pre-start concession partial. Keep
      // that read-only state until a normal checked save upgrades the metadata.
      if (['owned-parent-preview-terminal','historical-owned-parent-preview-terminal'].includes(document.previewObservation?.kind)) await verifyOwnedParentReplay(workspace, game, document.previewObservation);
      else if (document.previewObservation && !ownedPreviewProof(game, document.previewObservation)) throw safeError('invalid owned preview observation');
      if (document.complete !== completeProtocol(document.events, game, document.previewObservation) && !(document.complete === false && previewTerminalProof(document.events, game, document.previewObservation))) throw safeError('canonical protocol completeness does not match its metadata');
      if (document.complete && previewTerminalProof(document.events, game, document.previewObservation) && (document.observedHistory?.started === true || document.observedHistory?.progress === true)) throw safeError('preview-terminal evidence conflicts with earlier observed progress');
      if (document.complete && previewTerminalProof(document.events, game, document.previewObservation) && (document.observedHistory?.started !== false || document.observedHistory?.progress !== false) && !validPreviewCorroboration(document.previewCorroboration,game)) throw safeError('preview-terminal evidence lacks its observed-history attestation');
      verifyProtocolIdentity(document.events, game, document.previewObservation);
      sourceKind = 'sanitized-events';
    } else if (game.metadata.replay?.verified && game.metadata.replay.evidencePath) {
      reference = game.metadata.replay;
      const source = await checkedPath(workspace, reference.evidencePath), bytes = await decompress(await readFile(source.path), { maxOutputLength: MAX_BYTES });
      if (sha256(bytes) !== reference.logSha256) throw safeError('replay evidence hash verification failed');
      const events = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith('|')).map(line => { const [, type, ...data] = line.split('|'); return sanitizeEvent({ type, data }); }).filter(Boolean);
      document = { events, sheets: {}, decisions: [], controlTrace:[], complete: completeProtocol(events) }; sourceKind = 'verified-replay';
    } else throw safeError('no durable game evidence is registered');
    const decisions = document.decisions.filter(value => value.turn === 0 || ((fromTurn === undefined || value.turn >= fromTurn) && (toTurn === undefined || value.turn <= toTurn)));
    const controlTrace = document.controlTrace.filter(value => value.turn === 0 || ((fromTurn === undefined || value.turn >= fromTurn) && (toTurn === undefined || value.turn <= toTurn)));
    return { schemaVersion: 1, teamId, roomId, parentId: game.parentId, events: filteredTurns(document.events, fromTurn, toTurn), sheets: document.sheets, decisions, controlTrace, complete: document.complete === true, completionKind: previewTerminalProof(document.events, game, document.previewObservation) ? 'preview-terminal' : document.complete ? 'started-battle' : 'partial', observedHistory: document.observedHistory ?? null, previewCorroboration:document.previewCorroboration ?? null, previewObservation:document.previewObservation??null, completionLimitation: document.previewObservation?.kind === 'historical-owned-parent-preview-terminal' ? `${document.previewObservation.originLimitation} Original capture bytes, historical owned parent/child identities and zero-progress canonical history agree with the saved server replay. No request or selection was reconstructed; private choices, acceptance and full action history remain unavailable.` : document.previewObservation?.kind === 'owned-parent-preview-terminal' ? 'The private preview request was lost on reconnect. Hash-checked canonical zero-progress history, separately observed owned parent/child results and the saved server replay corroborate this pre-start ending. No request or selection was reconstructed; private selections, acceptance and full action history remain unavailable.' : document.previewObservation ? 'The recorder archive was unavailable. Actual saved replay protocol and separately retained owned preview status corroborate this pre-start ending; no protocol request was reconstructed, earlier-start observation and full private action history remain unavailable.' : document.previewCorroboration ? 'Legacy recording has no ever-start flags. Exact owned current preview state and the saved server terminal corroborated a pre-start ending; earlier-start observation remains unavailable.' : null, decisionEvidenceIncluded: document.decisions.length > 0, sourceKind, evidence: { path: reference.path ?? reference.evidencePath, sha256: reference.sha256 ?? reference.logSha256 }, turnWindow: { fromTurn: fromTurn ?? null, toTurn: toTurn ?? null, setupIncluded: true } };
}

export function reviewedCheckpoint(checkpoint, { teamId, parentId }) {
  if (!checkpoint || checkpoint.parentId !== parentId || (checkpoint.teamId ?? checkpoint.teamSha256) !== teamId || !/^review-complete(?:$|-)/u.test(checkpoint.status ?? '') || !['string', 'number'].includes(typeof checkpoint.reviewedAt) || !Number.isFinite(new Date(checkpoint.reviewedAt).getTime())) return false;
  const adoption = checkpoint.adoption;
  return Boolean(checkpoint.decisionReview && Object.keys(checkpoint.decisionReview).length && checkpoint.reusableOutcome && Object.keys(checkpoint.reusableOutcome).length && adoption && (adoption.syncVerified === true || adoption.synchronized === true) && HASH.test(adoption.sourceSha256) && adoption.sourceSha256 === adoption.installedSha256);
}
/** Structured service checkpoints must remain current, not merely look completed. */
export async function validateCleanupReview({workspace,teamId,parentId,checkpointFile,checkpoint,skillOptions={}}={}){
  if(!reviewedCheckpoint(checkpoint,{teamId,parentId}))return {complete:false,mode:'invalid',blockers:['The exact set needs a completed decision review and verified skill adoption checkpoint.']};
  if((checkpoint.schemaVersion===undefined||checkpoint.schemaVersion===1)&&!checkpoint.evidenceRevision)return {complete:true,mode:'legacy-static-checkpoint',blockers:[],limitation:'Legacy review identity, child coverage and recorded adoption hashes are checked, but current service evidence revisions and installed guidance are not attested by this older format.'};
  if(checkpoint.schemaVersion!==2)return {complete:false,mode:'unsupported-structured-checkpoint',blockers:['The structured review checkpoint schema is unsupported; retrieve and save it through the current review service.']};
  const expected=`cache/champions-mc-reviews/${parentId}.json`;
  if(checkpointFile!==expected)return {complete:false,mode:'structured-current-review',blockers:['A structured review must use its canonical current service checkpoint path.']};
  try{
    // Loaded only at operation time: the review service itself imports the pure
    // reviewedCheckpoint predicate above, so static imports would form a cycle.
    const {reviewStatus}=await import('../workflow/reviews.mjs');
    const status=await reviewStatus({workspace,teamId,parentId,skillOptions});
    const sameRevision=status.revision===checkpoint.revision&&status.evidenceRevision===checkpoint.evidenceRevision&&status.reviewedAt===checkpoint.reviewedAt;
    const complete=status.complete===true&&sameRevision,blockers=[...(status.blockers||[]),...(sameRevision?[]:['The provided checkpoint is not the current reviewed evidence revision.'])];
    if(!complete&&!blockers.length)blockers.push('The current structured review has not confirmed completion.');
    return {complete,mode:'structured-current-review',revision:status.revision,blockers};
  }catch{return {complete:false,mode:'structured-current-review',blockers:['The current structured review, retained evidence or adopted skill could not be verified.']};}
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
      if (!['battle-event', 'request', 'result', 'sheet', 'action-status', 'choice-status', 'decision', 'choice', 'control-trace', undefined].includes(value.event)) return 'An unarchived structured observation or calculation remains in the source.';
      if (value.event === 'battle-event' || value.event === undefined) {
        if (!PROTOCOL.has(value.type) && !MINOR.has(value.type) && !['request', 'c', 'c:', 'chat', '-message', 'html', 'raw', 'uhtml', 'uhtmlchange'].includes(value.type)) return 'An unsupported protocol observation remains in the source.';
      }
      if (['action-status', 'choice-status', 'decision', 'choice'].includes(value.event) && !sanitizeDecision(value, 0)) return 'An unsupported action journal entry remains in the source.';
      if (value.event === 'control-trace') {
        const allowed = new Set(['event','type','room','turn','seq','rqid','revision','generation',...CONTROL_TRACE_TIMES,...CONTROL_TRACE_LABELS,...CONTROL_TRACE_FLAGS]);
        const trace = sanitizeControlTrace(value, 0);
        if (!trace || Object.keys(value).some(key => !allowed.has(key) || !(key in trace))) return 'An unsupported or unarchived control observation remains in the source.';
      }
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
  const collected = collectBattleEvents(values.filter(value => value?.event !== 'control-trace'));
  // A source can consist entirely of control observations after the last
  // protocol write. It still needs an independent canonical coverage check.
  for (const value of values) if (value.event === 'control-trace' && !collected.has(value.room)) collected.set(value.room, {events:[], sheets:{}});
  for (const [roomId, data] of collected) {
    if (!records.some(record => record.roomId === roomId)) return 'Source game is not part of this retained set.';
    const retained = await readGameEvidence({ workspace, teamId: records[0].teamId, roomId });
    const projected = data.events.map(sanitizeEvent).filter(Boolean);
    if (!isSubsequence(projected, retained.events)) return `${roomId}: source contains state or turns absent from retained canonical evidence.`;
    const sheets = sanitizeSheets(data.sheets);
    if (Object.entries(sheets).some(([side, packed]) => retained.sheets[side] !== packed)) return `${roomId}: source contains an open sheet absent from retained evidence.`;
    let turn = 0; const decisions = [], controlTrace = [];
    for (const value of values) {
      if (value.room !== roomId) continue;
      if (value.type === 'turn' && value.event !== 'control-trace') turn = Number(value.data?.[0]) || 0;
      const decision = sanitizeDecision(value, turn); if (decision) decisions.push(decision);
      const trace = sanitizeControlTrace(value, turn); if (trace) controlTrace.push(trace);
    }
    if (!isSubsequence(decisions, retained.decisions)) return `${roomId}: source contains selected, accepted or executed decisions absent from retained evidence.`;
    if (!isSubsequence(controlTrace, retained.controlTrace)) return `${roomId}: source contains control observations absent from retained evidence.`;
  }
  return null;
}

/** A read-only, exact-file deletion plan. Missing replay/review/evidence keeps logs intact. */
export async function buildCleanupPlan({ workspace, teamId, parentId, checkpointFile, files = [], closedFiles = [], skillOptions = {} } = {}) {
  if (typeof teamId !== 'string' || !HASH.test(teamId) || typeof parentId !== 'string' || !PARENT.test(parentId) || typeof checkpointFile !== 'string' || !Array.isArray(files) || files.length > 200 || !Array.isArray(closedFiles) || closedFiles.length > 200) throw safeError('invalid BO3 cleanup request');
  const globalBlocks = [], candidates = [], blocked = [], decisionEvidence = [];
  let checkpoint, checkpointPath,reviewValidation;
  try { const source = await checkedPath(workspace, checkpointFile, { maxBytes: 2 * 1024 * 1024 }); checkpointPath = source.relative; checkpoint = JSON.parse(await readFile(source.path, 'utf8')); reviewValidation=await validateCleanupReview({workspace,teamId,parentId,checkpointFile:checkpointPath,checkpoint,skillOptions});globalBlocks.push(...reviewValidation.blockers); }
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
  return { schemaVersion: 1, teamId, parentId, checkpointFile: checkpointPath, reviewValidation:reviewValidation||{complete:false,mode:'invalid',blockers:['The private checkpoint could not be inspected.']}, ready: globalBlocks.length === 0, childIds: records.map(record => record.roomId), decisionEvidence, files: candidates, blocked, blockers: [...new Set(globalBlocks)], activeClient: protections.activeClient, eligibleCount: candidates.filter(file => file.eligible).length, keptCount: blocked.length, policy: 'Exact generated files only; protected data and registered shared logs remain intact.' };
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
