import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import {acquireMetricsBattleLock,assertMetricsTeamWritable} from './catalog.mjs';
import { previewTerminalProof, corroboratesPreviewState, validPreviewCorroboration, ownedPreviewObservation, ownedPreviewProof } from './preview-terminal.mjs';

const compress = promisify(gzip), decompress = promisify(gunzip);
const ORIGIN = 'https://replay.pokemonshowdown.com';
const MAX_BYTES = 8 * 1024 * 1024;
const FORMAT = /^gen9championsvgc2026regmc(?:bo3)?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
const bad = () => new Error('Saved replay could not be verified for this game.');
const PROTOCOL = new Set(['player', 'poke', 'start', 'turn', 'upkeep', 'switch', 'drag', 'replace', 'detailschange', 'swap', 'move', 'cant', 'faint', 'win', 'tie', 'gen', 'gametype', 'tier', 'teamsize', 'teampreview', 'showteam']);
const MINOR = new Set(['-damage', '-heal', '-sethp', '-status', '-curestatus', '-cureteam', '-boost', '-unboost', '-setboost', '-swapboost', '-invertboost', '-clearboost', '-clearallboost', '-clearpositiveboost', '-clearnegativeboost', '-copyboost', '-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-swapsideconditions', '-start', '-end', '-singleturn', '-singlemove', '-activate', '-fail', '-miss', '-notarget', '-immune', '-crit', '-supereffective', '-resisted', '-ohko', '-hitcount', '-nothing', '-combine', '-waiting', '-prepare', '-mustrecharge', '-recharge', '-anim', '-item', '-enditem', '-ability', '-endability', '-transform', '-formechange', '-mega', '-primal', '-burst', '-zpower', '-zbroken', '-terastallize', '-block']);

/** The only field allowed to retain a private replay capability is replay.url. */
export function canonicalReplayUrl(value, { roomId } = {}) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw bad();
  let url;
  try { url = new URL(value); } catch { throw bad(); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || url.port) throw bad();
  const path = url.pathname.replace(/\/$/u, '').replace(/\.(?:json|log)$/u, '');
  const match = /^\/(gen9championsvgc2026regmc(?:bo3)?)-([1-9]\d*)(?:-([a-z0-9]+pw))?$/u.exec(path);
  if (!match) throw bad();
  const id = `${match[1]}-${match[2]}`;
  if (roomId !== undefined && roomId !== `battle-${id}`) throw bad();
  return { url: `${ORIGIN}/${path.slice(1)}`, id, roomId: `battle-${id}`, accessId: path.slice(1) };
}

export function normalizeReplayReference(value, { roomId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.verified !== true || !HASH.test(value.logSha256)) throw bad();
  const canonical = canonicalReplayUrl(value.url, { roomId });
  if ((typeof value.verifiedAt !== 'string' && typeof value.verifiedAt !== 'number') || !Number.isFinite(new Date(value.verifiedAt).getTime())) throw bad();
  const result = { url: canonical.url, verified: true, verifiedAt: new Date(value.verifiedAt).toISOString(), logSha256: value.logSha256 };
  if (value.evidencePath !== undefined) {
    if (typeof value.evidencePath !== 'string' || value.evidencePath.length > 1000 || !/^cache\/team-metrics\/evidence\/battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*--[a-f0-9]{64}\.replay\.log\.gz$/u.test(value.evidencePath)) throw bad();
    const expectedRoom = canonical.roomId;
    if (!value.evidencePath.split('/').at(-1).startsWith(`${expectedRoom}--`)) throw bad();
    result.evidencePath = value.evidencePath;
  }
  return result;
}

async function withAbort(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); throw bad(); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(bad()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES || typeof response.body?.getReader !== 'function') throw bad();
  const reader = response.body.getReader(), chunks = [];
  let total = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || (total += value.byteLength) > MAX_BYTES) throw bad();
      chunks.push(value);
    }
    complete = true;
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    if (!complete) Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

/** Read an already saved replay. This never uploads, publishes, or authenticates. */
export async function fetchVerifiedReplay({ url, roomId, username, ownSide, outcome, fetchImpl = globalThis.fetch } = {}) {
  return fetchReplay({ url, roomId, username, ownSide, outcome, fetchImpl });
}
async function fetchReplay({ url, roomId, username, ownSide, outcome, fetchImpl, previewProof }) {
  const identity = canonicalReplayUrl(url, { roomId });
  if (!normalize(username) || typeof fetchImpl !== 'function' || (ownSide !== undefined && !['p1', 'p2'].includes(ownSide))) throw bad();
  const endpoint = `${ORIGIN}/${identity.accessId}.json`, signal = AbortSignal.timeout(15000);
  try {
    const response = await withAbort(fetchImpl(endpoint, { method: 'GET', credentials: 'omit', redirect: 'error', signal, headers: { Accept: 'application/json' } }), signal);
    if (!response?.ok || response.redirected || (response.url && response.url !== endpoint)) throw bad();
    const payload = await boundedJson(response, signal);
    if (!payload || typeof payload.log !== 'string' || ![identity.id, identity.accessId, identity.roomId].includes(payload.id)) throw bad();
    let formatObserved = false;
    for (const format of [payload.formatid, payload.format]) if (typeof format === 'string' && format.trim()) { if (!FORMAT.test(normalize(format))) throw bad(); formatObserved = true; }
    const lines = [], players = {}, results = [];
    let started = false, preview = false, gameplay = false, doubles = false;
    for (let line of payload.log.split(/\r?\n/u)) {
      line = line.replace(/((?:battle-)?gen\d+[a-z0-9]+-\d+)-[a-z0-9]+pw/gu, '$1');
      if (line.startsWith('>')) {
        if (line.slice(1).replace(/^battle-/u, '') !== identity.id) throw bad();
        continue;
      }
      if (!line.startsWith('|')) continue;
      const [, type, ...parts] = line.split('|');
      if (!PROTOCOL.has(type) && !MINOR.has(type)) continue;
      if (type === 'tier') { if (!FORMAT.test(normalize(parts[0]))) throw bad(); formatObserved = true; }
      if (type === 'gametype') { if (parts[0] !== 'doubles') throw bad(); doubles = true; }
      if (type === 'player' && ['p1', 'p2'].includes(parts[0]) && normalize(parts[1])) players[parts[0]] = normalize(parts[1]);
      if (previewProof && type === 'player' && normalize(parts[1]) && normalize(parts[1]) !== previewProof.players[parts[0]]) throw bad();
      if (type === 'start') started = true;
      if (type === 'teampreview') preview = true;
      if (MINOR.has(type) || ['turn', 'upkeep', 'switch', 'drag', 'replace', 'detailschange', 'swap', 'move', 'cant', 'faint'].includes(type)) gameplay = true;
      if (type === 'win') results.push(normalize(parts.join('|')));
      if (type === 'tie') results.push(null);
      lines.push(line);
    }
    const side = ownSide ?? Object.keys(players).find(key => players[key] === normalize(username));
    if (!players.p1 || !players.p2 || !side || players[side] !== normalize(username) || results.length !== 1) throw bad();
    const winner = results[0];
    if (previewProof && started) throw bad();
    if (winner !== null && !Object.values(players).includes(winner)) throw bad();
    if (!started && (!previewProof || !preview || gameplay || !doubles || !formatObserved || winner === null || winner !== previewProof.winner || side !== previewProof.ownSide || players.p1 !== previewProof.players.p1 || players.p2 !== previewProof.players.p2 || roomId !== previewProof.roomId)) throw bad();
    const observedOutcome = winner === null ? 'tie' : winner === normalize(username) ? 'win' : 'loss';
    if (outcome && outcome !== 'unknown' && outcome !== observedOutcome) throw bad();
    const log = `${lines.join('\n')}\n`, logSha256 = createHash('sha256').update(log).digest('hex');
    return { metadata: { url: identity.url, verified: true, verifiedAt: new Date().toISOString(), logSha256 }, log, outcome: observedOutcome, completionKind: started ? 'started-battle' : 'preview-terminal' };
  } catch { throw bad(); }
}

function contained(root, path) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function evidenceDirectory(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw bad();
  const root = await realpath(workspace);
  let path = root;
  for (const part of ['cache', 'team-metrics', 'evidence']) {
    path = join(path, part);
    try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !contained(root, await realpath(path))) throw bad();
  }
  return { root, path };
}

async function registeredReplay({ workspace, teamId, roomId, url, fetchImpl = globalThis.fetch, sessionReader } = {}) {
  if (!HASH.test(teamId)) throw bad();
  canonicalReplayUrl(url, { roomId });
  const { listBattles } = await import('./store.mjs');
  const existing = (await listBattles({ workspace, includeArchived: true })).find(record => record.teamId === teamId && record.roomId === roomId);
  if (!existing) throw new Error('The game must already exist in the team metrics database.');
  let localEvidence, previewProof, previewCorroboration, previewObservation;
  if (existing.completed && existing.turns === 0 && existing.metadata.evidence) {
    const { readGameEvidence } = await import('./retention.mjs');
    localEvidence = await readGameEvidence({ workspace, teamId, roomId });
    previewObservation = localEvidence.previewObservation ?? undefined;
    if (localEvidence.sourceKind === 'sanitized-events') previewProof = previewTerminalProof(localEvidence.events, existing, previewObservation);
    if (previewProof && (localEvidence.observedHistory?.started === true || localEvidence.observedHistory?.progress === true)) throw bad();
    if (previewProof && (localEvidence.observedHistory?.started !== false || localEvidence.observedHistory?.progress !== false)) {
      if (localEvidence.complete && existing.metadata.replay?.verified && validPreviewCorroboration(localEvidence.previewCorroboration,existing)) previewCorroboration=localEvidence.previewCorroboration;
      else {
        if (typeof sessionReader !== 'function') throw bad();
        const snapshot=await sessionReader();
        if (!corroboratesPreviewState(snapshot, previewProof)) throw bad();
        previewCorroboration={kind:'legacy-owned-session-preview',teamId,roomId,sessionId:snapshot.sessionId,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),observedAt:new Date().toISOString(),earlierStartObservation:'unavailable'};
      }
    }
  } else if (existing.completed && existing.turns === 0 && !existing.metadata.evidence && typeof sessionReader === 'function') {
    // A failed recorder can leave a registered terminal row with no archive.
    // Observe the existing owned client, never manufacture its missing request.
    // This fallback cannot be enabled through any caller-supplied import flag.
    const snapshot = await sessionReader();
    previewObservation = ownedPreviewObservation(snapshot, existing);
    previewProof = ownedPreviewProof(existing, previewObservation);
    if (!previewProof) throw bad();
    previewCorroboration = {kind:'legacy-owned-session-preview',teamId,roomId,sessionId:snapshot.sessionId,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),observedAt:previewObservation.observedAt,earlierStartObservation:'unavailable'};
    const room = snapshot.rooms.find(value => String(value.id ?? '').replace(/-[a-z0-9]+pw$/u, '') === roomId);
    const choice = room.choice;
    const decisions = [];
    if (choice && choice.rqid === room.state.request.rqid && choice.actions?.length === 1 && choice.actions[0]?.type === 'team') {
      decisions.push({event:'choice',phase:'preview',turn:0,rqid:choice.rqid,status:choice.status,actions:choice.actions,
        ...(Number.isFinite(choice.sentAt)?{at:choice.sentAt,submitted:true}:{}),...(Number.isFinite(choice.acceptedAt)?{accepted:true}:{}),
        reason:'Recovered last observed preview choice from battle_status. Full recorder action history was unavailable; this status does not establish battle execution.',evidence:{type:'owned-session-status'}});
    }
    localEvidence = {sourceKind:'sanitized-events',complete:false,events:[],decisions,sheets:room.sheets??{},previewObservation};
  }
  const replay = await fetchReplay({ url, roomId, username: existing.username, ownSide: existing.ownSide, outcome: existing.outcome, fetchImpl, previewProof });
  if (previewObservation && localEvidence.events.length === 0) {
    // Preserve actual replay protocol as protocol and the status projection as
    // a separate observation. A synthesized |request| would misstate provenance.
    const {collectBattleEvents,decodeInput} = await import('./import.mjs');
    const data = collectBattleEvents(decodeInput({path:'replay.json',text:JSON.stringify({id:roomId,log:replay.log})})).get(roomId);
    if (!data || data.startedObserved || data.progressObserved || !previewTerminalProof(data.events,existing,previewObservation)) throw bad();
    localEvidence.events=data.events;localEvidence.sheets={...data.sheets,...localEvidence.sheets};
  }
  return { existing, replay, localEvidence, previewProof, previewCorroboration, previewObservation };
}

/** Read-only verification bound to registered facts and hash-checked private local evidence. */
export async function fetchRegisteredReplay(args = {}) {
  const { replay } = await registeredReplay(args);
  return replay;
}

/** Attach a verified saved replay to an existing identity without changing its private facts. */
export async function attachVerifiedReplay({ workspace, teamId, roomId, url, fetchImpl = globalThis.fetch, sessionReader } = {}) {
  await assertMetricsTeamWritable({workspace,teamId});
  const { existing, replay, localEvidence, previewProof, previewCorroboration, previewObservation } = await registeredReplay({workspace,teamId,roomId,url,fetchImpl,sessionReader});
  const { updateBattleMetadata } = await import('./store.mjs');
  // Legacy recorders marked a genuine preview concession partial. Upgrade only
  // after both the immutable local observations and saved server replay agree.
  if (previewProof && !localEvidence.complete) {
    const { saveGameEvidence } = await import('./retention.mjs');
    await saveGameEvidence({ workspace, teamId, roomId, events: [...localEvidence.events, ...localEvidence.decisions], sheets: localEvidence.sheets, previewCorroboration, previewObservation });
  }
  const release=await acquireMetricsBattleLock({workspace,teamId,roomId:roomId+'-replay'});
  try{
  const directory = await evidenceDirectory(workspace), filename = `${roomId}--${teamId}.replay.log.gz`, path = join(directory.path, filename);
  async function matchesEvidence() {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw bad();
    const previous = await decompress(await readFile(path), { maxOutputLength: MAX_BYTES });
    if (createHash('sha256').update(previous).digest('hex') !== replay.metadata.logSha256) throw new Error('Existing replay evidence differs; keep it for review instead of overwriting it.');
  }
  let write = false;
  try { await matchesEvidence(); } catch (error) { if (error.code !== 'ENOENT') throw error; write = true; }
  if (write) {
    const pending = join(directory.path, `.pending-${teamId}-${randomUUID()}.tmp`);
    try {
      await writeFile(pending, await compress(replay.log, { level: 9 }), { flag: 'wx', mode: 0o600 });
      // Publish an immutable completed file without replacing another writer's
      // evidence. Reverification may change the URL, but cannot race its hash.
      try { await link(pending, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; await matchesEvidence(); }
    } finally { await rm(pending, { force: true }); }
  }
  const metadata = { ...replay.metadata, evidencePath: relative(directory.root, path).replaceAll('\\', '/') };
  // Do not churn the report timestamp on identical repeated verification.
  if (existing.metadata.replay?.logSha256 === metadata.logSha256 && existing.metadata.replay.url === metadata.url && existing.metadata.replay.evidencePath === metadata.evidencePath) metadata.verifiedAt = existing.metadata.replay.verifiedAt;
  const saved = await updateBattleMetadata({ workspace, teamId, roomId, metadata: { replay: metadata } });
  return { roomId, teamId, replay: saved.record.metadata.replay, status: saved.status };
  }finally{await release();}
}
