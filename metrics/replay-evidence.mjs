import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import {acquireMetricsBattleLock,assertMetricsTeamWritable} from './catalog.mjs';

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
  const identity = canonicalReplayUrl(url, { roomId });
  if (!normalize(username) || typeof fetchImpl !== 'function' || (ownSide !== undefined && !['p1', 'p2'].includes(ownSide))) throw bad();
  const endpoint = `${ORIGIN}/${identity.accessId}.json`, signal = AbortSignal.timeout(15000);
  try {
    const response = await withAbort(fetchImpl(endpoint, { method: 'GET', credentials: 'omit', redirect: 'error', signal, headers: { Accept: 'application/json' } }), signal);
    if (!response?.ok || response.redirected || (response.url && response.url !== endpoint)) throw bad();
    const payload = await boundedJson(response, signal);
    if (!payload || typeof payload.log !== 'string' || ![identity.id, identity.accessId, identity.roomId].includes(payload.id)) throw bad();
    for (const format of [payload.formatid, payload.format]) if (typeof format === 'string' && format.trim() && !FORMAT.test(normalize(format))) throw bad();
    const lines = [], players = {}, results = [];
    let started = false;
    for (let line of payload.log.split(/\r?\n/u)) {
      line = line.replace(/((?:battle-)?gen\d+[a-z0-9]+-\d+)-[a-z0-9]+pw/gu, '$1');
      if (line.startsWith('>')) {
        if (line.slice(1).replace(/^battle-/u, '') !== identity.id) throw bad();
        continue;
      }
      if (!line.startsWith('|')) continue;
      const [, type, ...parts] = line.split('|');
      if (!PROTOCOL.has(type) && !MINOR.has(type)) continue;
      if (type === 'tier' && !FORMAT.test(normalize(parts[0]))) throw bad();
      if (type === 'player' && ['p1', 'p2'].includes(parts[0]) && normalize(parts[1])) players[parts[0]] = normalize(parts[1]);
      if (type === 'start') started = true;
      if (type === 'win') results.push(normalize(parts.join('|')));
      if (type === 'tie') results.push(null);
      lines.push(line);
    }
    const side = ownSide ?? Object.keys(players).find(key => players[key] === normalize(username));
    if (!started || !players.p1 || !players.p2 || !side || players[side] !== normalize(username) || results.length !== 1) throw bad();
    const winner = results[0];
    if (winner !== null && !Object.values(players).includes(winner)) throw bad();
    const observedOutcome = winner === null ? 'tie' : winner === normalize(username) ? 'win' : 'loss';
    if (outcome && outcome !== 'unknown' && outcome !== observedOutcome) throw bad();
    const log = `${lines.join('\n')}\n`, logSha256 = createHash('sha256').update(log).digest('hex');
    return { metadata: { url: identity.url, verified: true, verifiedAt: new Date().toISOString(), logSha256 }, log, outcome: observedOutcome };
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

/** Attach a verified saved replay to an existing identity without changing its private facts. */
export async function attachVerifiedReplay({ workspace, teamId, roomId, url, fetchImpl = globalThis.fetch } = {}) {
  if (!HASH.test(teamId)) throw bad();
  canonicalReplayUrl(url, { roomId });
  await assertMetricsTeamWritable({workspace,teamId});
  const { listBattles, updateBattleMetadata } = await import('./store.mjs');
  const existing = (await listBattles({ workspace, includeArchived: true })).find(record => record.teamId === teamId && record.roomId === roomId);
  if (!existing) throw new Error('The game must already exist in the team metrics database.');
  const replay = await fetchVerifiedReplay({ url, roomId, username: existing.username, ownSide: existing.ownSide, outcome: existing.outcome, fetchImpl });
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
