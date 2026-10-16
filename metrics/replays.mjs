import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {importBattleFiles, loadMetricsTeam, readWorkspaceFile} from './import.mjs';
import {attachVerifiedReplay, fetchVerifiedReplay, fetchRegisteredReplay} from './replay-evidence.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {listBattles} from './store.mjs';
import {acquireMetricsBattleLock,assertMetricsTeamWritable} from './catalog.mjs';

const ORIGIN = 'https://replay.pokemonshowdown.com';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_KIND = 'official-showdown-replay';
const cacheLocks = new Map();
const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const MC_FORMAT = 'gen9championsvgc2026regmc';
const isMcFormat = value => [MC_FORMAT, `${MC_FORMAT}bo3`].includes(normalized(value));
const PROTOCOL = new Set(['player', 'poke', 'start', 'turn', 'upkeep', 'switch', 'drag', 'replace', 'detailschange', 'swap', 'move', 'cant', 'faint', 'win', 'tie', 'gen', 'gametype', 'tier', 'teamsize', 'teampreview', 'showteam']);
const replayIdentity = value => /^(gen\d+[a-z0-9]+)-([1-9]\d*)(?:-([a-z0-9]+pw))?$/.exec(value);
const genericFailure = () => new Error('Saved replay could not be fetched or validated.');

function replayUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Supply an official saved Showdown replay URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Supply an official saved Showdown replay URL.'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) {
    throw new Error('Replay URLs must use HTTPS on replay.pokemonshowdown.com without credentials, queries or fragments.');
  }
  const path = url.pathname.replace(/\/$/, '').replace(/\.(?:json|log)$/, '');
  const match = /^\/([^/]+)$/.exec(path), identity = match && replayIdentity(match[1]);
  if (!identity) throw new Error('Supply a supported saved Showdown replay URL.');
  if (!isMcFormat(identity[1])) throw new Error('Saved replay is not Champions Regulation M-C.');
  return {publicId: `${identity[1]}-${identity[2]}`, accessId: match[1], capability: identity[3] ? `-${identity[3]}` : null};
}

function withAbort(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(genericFailure()); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(genericFailure()); };
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJson(response, signal) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) throw genericFailure();
  if (typeof response.body?.getReader !== 'function') throw genericFailure();
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const {done, value} = await withAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw genericFailure();
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw genericFailure();
      chunks.push(value);
    }
    complete = true;
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    if (!complete) Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function cleanReplay(payload, identity, username) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.log !== 'string') throw genericFailure();
  const responseId = payload.id.replace(/^battle-/, '');
  if (![identity.publicId, identity.accessId].includes(responseId)) throw genericFailure();
  let formatConfirmed = false;
  for (const format of [payload.formatid, payload.format]) if (typeof format === 'string' && format.trim()) {
    if (!isMcFormat(format)) throw genericFailure();
    formatConfirmed = true;
  }
  const lines = [];
  let namedPlayer = false;
  for (let line of payload.log.split(/\r?\n/)) {
    // Capabilities may occur in protocol room headers or server messages. Strip
    // them before any persistence, and discard chat, HTML, requests and login data.
    if (identity.capability) line = line.replaceAll(identity.capability, '');
    line = line.replace(/((?:battle-)?gen\d+[a-z0-9]+-\d+)-[a-z0-9]+pw/g, '$1');
    if (line.startsWith('>')) {
      if (line.slice(1).trim().replace(/^battle-/, '') !== identity.publicId) throw genericFailure();
      lines.push(`>battle-${identity.publicId}`);
      continue;
    }
    if (!line.startsWith('|')) continue;
    const [, type, ...parts] = line.split('|');
    if (!PROTOCOL.has(type) && !type.startsWith('-')) continue;
    if (type === 'tier' && parts[0]?.trim()) {
      if (!isMcFormat(parts[0])) throw genericFailure();
      formatConfirmed = true;
    }
    if (type === 'player' && ['p1', 'p2'].includes(parts[0]) && normalized(parts[1]) === normalized(username)) namedPlayer = true;
    lines.push(line);
  }
  if (!namedPlayer || !lines.length) throw genericFailure();
  return {schemaVersion: 1, kind: CACHE_KIND, id: identity.publicId, log: lines.join('\n'), formatConfirmed};
}

async function downloadReplay(identity, {fetchImpl, username, budget}) {
  // Official API: https://github.com/smogon/pokemon-showdown-client/blob/master/WEB-API.md
  // Only the documented /{replayID}.json endpoint is requested; this never saves
  // or publishes a replay and carries no browser/session credentials.
  const endpoint = `${ORIGIN}/${identity.accessId}.json`;
  const signal = AbortSignal.any([budget, AbortSignal.timeout(15000)]);
  try {
    const response = await withAbort(fetchImpl(endpoint, {method: 'GET', credentials: 'omit', redirect: 'error', signal, headers: {Accept: 'application/json'}}), signal);
    if (!response?.ok || response.redirected) throw genericFailure();
    if (response.url) {
      const observed = new URL(response.url);
      if (observed.origin !== ORIGIN || observed.href !== endpoint) throw genericFailure();
    }
    return cleanReplay(await boundedJson(response, signal), identity, username);
  } catch {
    // Transport errors can include the full private URL. Never return a cause or
    // an interpolated endpoint to the caller.
    throw genericFailure();
  }
}

// The official response was already fetched within the batch budget. Reuse only
// its sanitized protocol when verifying and retaining evidence; never download
// the same replay again merely to attach its saved URL to the report.
function cachedReplayFetcher(replay) {
  return async () => new Response(JSON.stringify({id: replay.id, log: replay.log}), {headers: {'Content-Type': 'application/json'}});
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function replayDirectory(workspace) {
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('Replay cache requires a workspace directory.');
  let path = root;
  for (const component of ['cache', 'team-metrics', 'replays']) {
    path = join(path, component);
    if (!contained(root, path)) throw new Error('Replay cache must stay within the workspace.');
    let info;
    try { info = await lstat(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(path); } catch (created) { if (created.code !== 'EEXIST') throw created; }
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !contained(root, await realpath(path))) {
      throw new Error('Replay cache must use real directories within the workspace.');
    }
  }
  return {root, path};
}

function completeness(replay) {
  let turns = 0;
  for (const match of replay.log.matchAll(/(?:^|\n)\|turn\|(\d+)(?=\n|$)/g)) {
    const turn = Number(match[1]); if (Number.isSafeInteger(turn)) turns = Math.max(turns, turn);
  }
  return {complete: /(?:^|\n)\|start(?:\||\n|$)/.test(replay.log) && /(?:^|\n)\|(?:win\|[^\n]+|tie)(?:\n|$)/.test(replay.log), turns};
}

async function cacheReplay(directory, replay) {
  const filename = `${createHash('sha256').update(replay.id).digest('hex')}.json`, path = join(directory.path, filename);
  const previous = cacheLocks.get(path) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; }), queued = previous.then(() => current);
  cacheLocks.set(path, queued);
  await previous;
  try { return await writeCachedReplay(directory, replay, path); }
  finally { release(); if (cacheLocks.get(path) === queued) cacheLocks.delete(path); }
}

async function writeCachedReplay(directory, replay, path) {
  let previous;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES * 2) throw new Error('Replay cache destination is not a generated replay file.');
    previous = JSON.parse(await readFile(path, 'utf8'));
    if (previous?.kind !== CACHE_KIND || previous.schemaVersion !== 1 || previous.id !== replay.id || typeof previous.log !== 'string') {
      throw new Error('Replay cache destination is not a generated replay file.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Replay cache destination cannot be overwritten.'); }
  if (previous) {
    const old = completeness(previous), current = completeness(replay);
    if (old.complete && (!current.complete || current.turns < old.turns)) return relative(directory.root, path).replaceAll('\\', '/');
    if (JSON.stringify(previous) === JSON.stringify(replay)) return relative(directory.root, path).replaceAll('\\', '/');
  }
  const temporary = join(directory.path, `.pending-${directory.teamId}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(replay)}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally { await rm(temporary, {force: true}); }
  return relative(directory.root, path).replaceAll('\\', '/');
}

/** Import explicitly supplied saved replay URLs without publication or login.
 * Verified links live only in private game metadata; cached protocol is stripped
 * of replay capabilities and never becomes a background polling source. */
export async function importReplayUrls({workspace, urls, username, teamFile, teamId, name, ledgerFile, fetchImpl = globalThis.fetch, sessionReader} = {}) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 20) throw new Error('Supply 1–20 saved replay URLs.');
  if (typeof fetchImpl !== 'function') throw new Error('Replay fetching is unavailable.');
  if (typeof username !== 'string' || !normalized(username) || username.length > 30) throw new Error('Supply the battle username.');
  const identities = new Map();
  for (const url of urls) {
    const identity = replayUrl(url), previous = identities.get(identity.publicId);
    // A supplied private capability can access the same replay as its public ID;
    // prefer that explicit access URL while fetching each numeric replay once.
    if (!previous || (!previous.capability && identity.capability)) identities.set(identity.publicId, identity);
  }
  const registration = await loadMetricsTeam({workspace, teamFile, teamId, name});
  await assertMetricsTeamWritable({workspace,teamId:registration.teamId});
  if (ledgerFile) {
    const ledger = await readWorkspaceFile(workspace, ledgerFile, {extensions: ['.json']});
    try { JSON.parse(ledger.text); } catch { throw new Error('Invalid metrics ledger JSON.'); }
  }
  const existing = new Map((await listBattles({workspace, includeArchived: true}))
    .filter(record => record.teamId === registration.teamId).map(record => [record.roomId, record]));
  const budget = AbortSignal.timeout(30000), replays = [], previewTerminals = new Set();
  let sessionSnapshot;
  const readSession = typeof sessionReader === 'function' ? () => (sessionSnapshot ??= Promise.resolve().then(sessionReader)) : undefined;
  // Validate every download before writing any cache or metric record. One failed
  // fetch cannot leave an apparently successful partial batch behind.
  for (const identity of identities.values()) {
    if (budget.aborted) throw genericFailure();
    const replay = await downloadReplay(identity, {fetchImpl, username, budget});
    if (completeness(replay).complete || /(?:^|\n)\|win\|[^\n]+(?:\n|$)/u.test(replay.log)) {
      // Check a terminal replay before publishing any batch records. This also
      // rejects conflicting results and an unrelated winner, rather than adding
      // a report row before discovering that its evidence cannot be verified.
      try {
        const previous = existing.get(`battle-${replay.id}`);
        const verified = completeness(replay).complete
          ? await fetchVerifiedReplay({url: `${ORIGIN}/${identity.accessId}`, username, ownSide: previous?.ownSide, outcome: previous?.outcome, fetchImpl: cachedReplayFetcher(replay)})
          : await fetchRegisteredReplay({workspace,teamId:registration.teamId,roomId:`battle-${replay.id}`,url:`${ORIGIN}/${identity.accessId}`,fetchImpl:cachedReplayFetcher(replay),sessionReader:readSession});
        if (verified.completionKind === 'preview-terminal') {
          if (normalized(previous?.username) !== normalized(username)) throw genericFailure();
          previewTerminals.add(replay.id);
        }
        if (previous?.metadata.replay && previous.metadata.replay.logSha256 !== verified.metadata.logSha256) throw genericFailure();
      }
      catch { throw genericFailure(); }
    }
    replays.push(replay);
  }
  const release=await acquireMetricsBattleLock({workspace,teamId:registration.teamId,roomId:'team-replay-import'});
  try{
  const directory = {...await replayDirectory(workspace),teamId:registration.teamId}, files = [];
  for (const replay of replays) if (!previewTerminals.has(replay.id)) files.push(await cacheReplay(directory, replay));
  const teamReference = teamId === undefined ? {teamFile: registration.teamFile} : {teamId: registration.teamId};
  const imported = files.length ? await importBattleFiles({workspace, files, username, ...teamReference, name: name ?? registration.descriptor.name,
    ledgerFile, remember: false, expectedTeamId: registration.teamId}) : {teamId:registration.teamId,imported:0,skipped:[],battles:[],team:registration.descriptor,savedTeamFile:registration.teamFile,stableReport:null,provenance:'Existing registered private game facts are retained; a pre-start terminal replay adds verification only.'};
  const attached = [];
  for (const replay of replays) if (previewTerminals.has(replay.id)) {
    const identity = identities.get(replay.id), roomId = `battle-${replay.id}`;
    const saved = await attachVerifiedReplay({workspace,teamId:registration.teamId,roomId,url:`${ORIGIN}/${identity.accessId}`,fetchImpl:cachedReplayFetcher(replay),sessionReader:readSession});
    attached.push(saved);
    const record = (await listBattles({workspace,includeArchived:true})).find(value=>value.teamId===registration.teamId&&value.roomId===roomId);
    imported.battles.push({roomId,status:saved.status,record}); imported.imported++;
  }
  for (const battle of imported.battles) {
    const replay = replays.find(value => battle.roomId === `battle-${value.id}`);
    if (!replay || !completeness(replay).complete) continue;
    const identity = identities.get(replay.id);
    const saved = await attachVerifiedReplay({workspace, teamId: imported.teamId, roomId: battle.roomId,
      url: `${ORIGIN}/${identity.accessId}`, fetchImpl: cachedReplayFetcher(replay)});
    attached.push(saved);
    if (battle.record) battle.record = {...battle.record, metadata: {...battle.record.metadata, replay: saved.replay}};
  }
  if (attached.length) imported.stableReport = await updateTeamReport({workspace, teamId: imported.teamId});
  const replayWarnings = replays.filter(replay => !replay.formatConfirmed).map(replay => ({roomId: `battle-${replay.id}`,
    warning: 'Replay payload has no format metadata; its URL identifies M-C, but the payload did not independently confirm the format.'}));
  return {...imported, replayUrls: identities.size, replays: attached, replayWarnings};
  }finally{await release();}
}
