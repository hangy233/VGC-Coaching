import {lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createTimingRecorder, normalizeTimingEvent} from './timing.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {acquireMetricsBattleLock} from '../metrics/catalog.mjs';

const compress = promisify(gzip), decompress = promisify(gunzip);
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^[a-f0-9]{64}--[a-f0-9-]{36}\.timing\.json\.gz$/;
const MAX_FILES = 64, MAX_BYTES = 8 * 1024 * 1024, MAX_EVENTS = 20000;
const MAX_MERGE_BYTES = 512 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
function validTeam(teamId) { if (!HASH.test(teamId ?? '')) throw new TypeError('Timing requires an exact registered team fingerprint.'); }
async function directory(workspace, create = false) {
  const root = await realpath(workspace);
  let path = root;
  for (const part of ['cache', 'team-metrics', 'timing']) {
    path = join(path, part);
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(path); } catch (created) { if (created.code !== 'EEXIST') throw created; }
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(path))) throw new Error('Timing storage must remain in real workspace cache directories.');
  }
  return {root, path};
}
async function files(path, teamId, onMissing = () => {}) {
  const result = [];
  for (const name of await readdir(path)) {
    if (!FILE.test(name) || !name.startsWith(teamId + '--')) continue;
    const full = join(path, name);
    let info;
    try { info = await lstat(full); }
    catch (error) { if (error.code !== 'ENOENT') throw error; onMissing(); continue; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Timing evidence must be a bounded regular file.');
    result.push({name, full, modified: info.mtimeMs});
  }
  return result.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
}

/** Explicit opt-in. Recording uses memory only; bounded background batches share
 * team deletion locks. Timing loss is reported, never a reason to resend a move.
 */
export async function createTeamTiming({workspace, teamId, component, intervalMs = 1000,
  maxFiles = MAX_FILES, maxEventsPerFile = MAX_EVENTS, recorderOptions = {}} = {}) {
  validTeam(teamId);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000 ||
      !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES ||
      !Number.isInteger(maxEventsPerFile) || maxEventsPerFile < 16 || maxEventsPerFile > MAX_EVENTS) throw new TypeError('Invalid timing retention limits.');
  await loadMetricsTeam({workspace, teamId});
  const recorder = createTimingRecorder({...recorderOptions, component});
  if (maxEventsPerFile < recorder.status().maxEvents) throw new TypeError('A timing chunk must fit one complete recorder batch.');
  let pending, activeChunk, closed = false, writtenFiles = 0, writtenBatches = 0, lostEvents = 0, persistenceErrors = 0, ownershipRejected = 0;
  let lastErrorCode = null;
  const sink = {
    recorder,
    flush() {
      if (pending) return pending;
      const drained = recorder.drain();
      if (!drained.length) return Promise.resolve();
      const events = drained.filter(event => !event.teamId || event.teamId === teamId).map(event => ({...event, teamId}));
      ownershipRejected += drained.length - events.length;
      pending = (async () => {
        let release;
        try {
          release = await acquireMetricsBattleLock({workspace, teamId, roomId: 'timing-evidence', timeoutMs: 1000});
          const target = await directory(workspace, true);
          // Frequent flushes must not evict a whole game's early spans merely
          // because later review/status commands each publish a tiny file.
          // Only extend this writer's last verified chunk. A removed chunk is
          // never restored from memory (including after team deletion/recreation).
          let previous;
          if (activeChunk?.uncompressedBytes > MAX_MERGE_BYTES) activeChunk = undefined;
          if (activeChunk) {
            try {
              const info = await lstat(activeChunk.path);
              if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Active timing chunk changed.');
              const bytes = await readFile(activeChunk.path);
              if (sha256(bytes) !== activeChunk.sha256) throw new Error('Active timing chunk changed.');
              previous = JSON.parse(await decompress(bytes, {maxOutputLength: MAX_BYTES}));
              if (previous.schemaVersion !== 1 || previous.kind !== 'team-timing-trace' || previous.id !== activeChunk.id ||
                  previous.teamId !== teamId || !Array.isArray(previous.events) || previous.events.length > MAX_EVENTS) throw new Error('Active timing chunk identity changed.');
            } catch (error) {
              activeChunk = undefined;
              if (error.code !== 'ENOENT') throw error;
            }
          }
          if (previous && previous.events.length + events.length > maxEventsPerFile) previous = undefined;
          const makeDocument = prior => ({schemaVersion: 1, kind: 'team-timing-trace', id: prior?.id ?? randomUUID(), teamId,
            createdAt: prior?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), recorderStatus: recorder.status(),
            sinkStatus: {lostEvents, persistenceErrors, ownershipRejected, lastErrorCode}, events: prior ? [...prior.events, ...events] : events});
          let document = makeDocument(previous), text = JSON.stringify(document);
          if (previous && Buffer.byteLength(text) > MAX_MERGE_BYTES) { previous = undefined; document = makeDocument(); text = JSON.stringify(document); }
          if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Timing chunk exceeds its limit.');
          const id = document.id;
          const bytes = await compress(text);
          const temporary = join(target.path, `.pending-${teamId}-${id}.timing.tmp`);
          try {
            await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
            await rename(temporary, join(target.path, `${teamId}--${id}.timing.json.gz`));
          } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          activeChunk = {id, path: join(target.path, `${teamId}--${id}.timing.json.gz`), sha256: sha256(bytes), uncompressedBytes: Buffer.byteLength(text)};
          if (!previous) writtenFiles++;
          writtenBatches++;
          const retained = await files(target.path, teamId);
          while (retained.length > maxFiles) {
            const old = retained.shift();
            const info = await lstat(old.full);
            if (info.isSymbolicLink() || !info.isFile()) throw new Error('Timing evidence changed during retention.');
            await unlink(old.full);
          }
        } catch (error) {
          lostEvents += events.length; persistenceErrors++;
          lastErrorCode = ['METRICS_TEAM_DELETED', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC'].includes(error?.code) ? error.code : 'TIMING_WRITE_FAILED';
        } finally {
          if (release) { try { await release(); } catch { persistenceErrors++; lastErrorCode = 'TIMING_LOCK_RELEASE_FAILED'; } }
        }
      })().finally(() => { pending = undefined; });
      return pending;
    },
    status: () => ({...recorder.status(), teamId, writtenFiles, writtenBatches, lostEvents, persistenceErrors, ownershipRejected, lastErrorCode, closed}),
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (pending) await pending;
      await sink.flush();
    },
  };
  const timer = intervalMs ? setInterval(() => { void sink.flush(); }, intervalMs) : null;
  timer?.unref();
  return sink;
}

export async function getTeamTimingFromEnvironment({workspace, component} = {}) {
  const teamId = process.env.VGC_TIMING_TEAM;
  return teamId ? createTeamTiming({workspace, teamId, component}) : undefined;
}

export async function readTeamTiming({workspace, teamId, limitFiles = MAX_FILES, roomId, readChunk = readFile} = {}) {
  validTeam(teamId);
  if (!Number.isInteger(limitFiles) || limitFiles < 1 || limitFiles > MAX_FILES) throw new TypeError('Timing reads require a file limit from 1 to 64.');
  if (roomId !== undefined && !/^battle-[a-z0-9]+-\d+$/.test(roomId)) throw new TypeError('Use a canonical game room without a private suffix.');
  await loadMetricsTeam({workspace, teamId});
  let target;
  try { target = await directory(workspace); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let droppedEvents = 0, lostEvents = 0, persistenceErrors = 0, ownershipRejected = 0, vanishedFiles = 0, filesRead = 0;
  const available = target ? await files(target.path, teamId, () => { vanishedFiles++; }) : [];
  const retained = available.slice(-limitFiles), events = [], warnings = [];
  const counts = new Map();
  const sinkCounts = new Map();
  for (const file of retained) {
    let bytes;
    try { bytes = await readChunk(file.full); }
    catch (error) { if (error.code !== 'ENOENT') throw error; vanishedFiles++; continue; }
    const text = await decompress(bytes, {maxOutputLength: MAX_BYTES});
    const document = JSON.parse(text);
    if (document.schemaVersion !== 1 || document.kind !== 'team-timing-trace' || document.teamId !== teamId ||
        `${teamId}--${document.id}.timing.json.gz` !== file.name || !Array.isArray(document.events) || document.events.length > 20000) throw new Error('Invalid team timing identity or event bounds.');
    for (const item of document.events) {
      const event = normalizeTimingEvent(item);
      if (!event || event.teamId !== teamId) throw new Error('Invalid team timing event.');
      if (roomId === undefined || event.roomId === roomId) events.push(event);
    }
    const status = document.recorderStatus;
    if (status?.processInstanceId && Number.isSafeInteger(status.droppedEvents) && status.droppedEvents >= 0) {
      counts.set(status.processInstanceId, Math.max(counts.get(status.processInstanceId) ?? 0, status.droppedEvents));
      const previous = sinkCounts.get(status.processInstanceId) ?? {lostEvents: 0, persistenceErrors: 0, ownershipRejected: 0};
      const sink = document.sinkStatus;
      sinkCounts.set(status.processInstanceId, {
        lostEvents: Math.max(previous.lostEvents, Number.isSafeInteger(sink?.lostEvents) && sink.lostEvents >= 0 ? sink.lostEvents : 0),
        persistenceErrors: Math.max(previous.persistenceErrors, Number.isSafeInteger(sink?.persistenceErrors) && sink.persistenceErrors >= 0 ? sink.persistenceErrors : 0),
        ownershipRejected: Math.max(previous.ownershipRejected, Number.isSafeInteger(sink?.ownershipRejected) && sink.ownershipRejected >= 0 ? sink.ownershipRejected : 0),
      });
    }
    filesRead++;
  }
  for (const count of counts.values()) droppedEvents += count;
  for (const count of sinkCounts.values()) { lostEvents += count.lostEvents; persistenceErrors += count.persistenceErrors; ownershipRejected += count.ownershipRejected; }
  if (available.length > retained.length) warnings.push('Only the newest requested timing chunks are included.');
  if (available.length === MAX_FILES) warnings.push('The bounded retention limit may have removed older timing chunks.');
  if (droppedEvents) warnings.push('Capture reached a bound or encountered invalid events; timing coverage is incomplete.');
  if (lostEvents || persistenceErrors) warnings.push('Earlier timing persistence failed; the retained trace is incomplete.');
  if (ownershipRejected) warnings.push('Events carrying another team identity were rejected; they were not reassigned to this report.');
  if (vanishedFiles) warnings.push('Timing chunks disappeared during the read, possibly due to retention or team deletion; coverage is incomplete.');
  return {schemaVersion: 1, teamId, events, filesRead, availableFiles: available.length, vanishedFiles,
    boundedRetention: {maxFiles: MAX_FILES, maxBytesPerFile: MAX_BYTES}, droppedEvents, lostEvents, persistenceErrors, ownershipRejected, warnings,
    limitation: 'Local observations only. Missing model delivery, provider queueing and internal inference boundaries remain unknown.'};
}
