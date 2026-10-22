import {createHash} from 'node:crypto';
import fileSystem, {lstat, mkdir, open, readFile, readdir, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {projectDecisionView} from './operator-view.mjs';

const FORMAT = 'vgc-operator-response-v1';
const MAX_WAIT_MS = 60000;
const DEFAULT_WAIT_MS = 22000;
const MAX_RETAINED_RESPONSES = 16;
const RENAME_RETRY_MS = [10, 20, 40, 80, 160];
const transientFileErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);
const publicationErrorCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'EISDIR', 'ENOTDIR', 'ENOENT', 'EEXIST', 'EINVAL', 'EXDEV', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EROFS']);
const CALLER_TIMING_FIELDS = ['inputReceivedAt', 'mcpDispatchedAt', 'mcpSettledAt', 'boardCapturedAt'];
const PERSISTED_TIMING_FIELDS = [...CALLER_TIMING_FIELDS, 'preparedAt'];
const sensitiveKey = /^(?:password|passwd|passphrase|controllerlease|lease|readreceipt|assertion|challstr|credential|credentials|secret|clientsecret|accesstoken|refreshtoken|authorization|cookie|setcookie|capability)$/;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

// Timing is deliberately numeric and shallow. Unknown fields (including nested
// credentials or arbitrary envelope data) never enter the retained response.
function callerTiming(value) {
  if (!plainObject(value) || Object.keys(value).length > 16) throw new TypeError('timing must be a plain object with at most 16 fields');
  const result = {};
  for (const key of CALLER_TIMING_FIELDS) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
    if (!timestamp(value[key])) throw new TypeError('timing timestamps must be nonnegative safe integer epoch milliseconds');
    result[key] = value[key];
  }
  return result;
}

// Unknown metadata is discarded, but discover any labelled credentials before
// sanitizing payload errors that may echo them. Bound this optional input rather
// than accepting an arbitrary JSON envelope through the timing option.
function boundedTimingMetadata(value) {
  let entries = 0, characters = 0;
  const active = new WeakSet();
  const invalid = () => { throw new TypeError('timing metadata exceeds bounded plain JSON limits'); };
  function visit(item, depth = 0) {
    if (depth > 8 || ++entries > 128) invalid();
    if (typeof item === 'string') { characters += item.length; if (item.length > 4096 || characters > 16384) invalid(); return; }
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || active.has(item) || !Array.isArray(item) && !plainObject(item)) invalid();
    active.add(item);
    for (const [key, child] of Object.entries(item)) { if (key.length > 128) invalid(); visit(child, depth + 1); }
    active.delete(item);
  }
  visit(value);
  return value;
}

function storedTiming(value) {
  if (!plainObject(value)) return null;
  return Object.fromEntries(PERSISTED_TIMING_FIELDS.filter(key => Object.hasOwn(value, key) && timestamp(value[key])).map(key => [key, value[key]]));
}

function sameRetainedResponse(text, candidate) {
  let existing;
  try { existing = JSON.parse(text); } catch { return false; }
  if (!plainObject(existing) || Object.keys(existing).some(key => !['format', 'id', 'payload', 'timing'].includes(key))) return false;
  if (Object.hasOwn(existing, 'timing') && (!timestamp(existing.timing?.preparedAt) || !plainObject(existing.timing) ||
      Object.keys(existing.timing).some(key => !PERSISTED_TIMING_FIELDS.includes(key) || !timestamp(existing.timing[key])))) return false;
  // A retry observes the original receipt. It cannot replace its first timing
  // measurements merely because the caller obtained newer timestamps.
  const withoutTiming = ({timing, ...value}) => JSON.stringify(value);
  return withoutTiming(existing) === withoutTiming(candidate);
}

function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,60}$/.test(id)) {
    throw new TypeError('A unique response ID of 1-60 letters, numbers, dots, colons, underscores or hyphens is required');
  }
  return id;
}

function outputPath(file) {
  if (file instanceof URL) return fileURLToPath(file);
  if (typeof file !== 'string' || !file.length) throw new TypeError('A response file path is required');
  return resolve(file);
}

function retainedPath(target, id) {
  return join(`${target}.responses`, `${createHash('sha256').update(id).digest('hex')}.json`);
}

async function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fileSystem.rename(source, target); return; }
    catch (error) {
      if (!transientFileErrors.has(error.code) || attempt === RENAME_RETRY_MS.length) throw error;
      await new Promise(done => setTimeout(done, RENAME_RETRY_MS[attempt]));
    }
  }
}

async function atomicWrite(target, text, temporary) {
  let handle, created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, target);
  } finally {
    if (handle) await handle.close();
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function prepareRetention(target, id, text, value) {
  const area = `${target}.responses`;
  await mkdir(area).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const areaInfo = await fileSystem.lstat(area);
  if (!areaInfo.isDirectory() || areaInfo.isSymbolicLink()) throw new Error('Response retention area must be a real directory');
  const exact = retainedPath(target, id);
  try {
    const info = await lstat(exact);
    const existingText = info.isFile() && !info.isSymbolicLink() ? await readFile(exact, 'utf8') : null;
    if (existingText === null || existingText !== text && !sameRetainedResponse(existingText, value)) {
      throw new Error('Response ID already has a different or invalid retained result');
    }
    return {area, exact, existing: true, text: existingText};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const retained = [];
  for (const entry of await readdir(area, {withFileTypes: true})) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(area, entry.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (value?.format !== FORMAT || typeof value.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,60}$/.test(value.id) ||
        !Object.hasOwn(value, 'payload') || retainedPath(target, value.id) !== path) continue;
    retained.push({path, modified: info.mtimeMs});
  }
  retained.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path));
  while (retained.length >= MAX_RETAINED_RESPONSES) {
    const {path} = retained.shift();
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Retained response changed during pruning');
    await unlink(path);
  }
  return {area, exact, existing: false};
}

/** Strip credential fields, including JSON encoded inside MCP text blocks.
 * Keep secrets in memory. Pass any secrets that can occur in free text through
 * redactValues; a key filter cannot identify an otherwise unlabelled secret.
 */
export function sanitizeResponse(payload, {redactValues = []} = {}) {
  if (!Array.isArray(redactValues) || redactValues.some(value => typeof value !== 'string')) {
    throw new TypeError('redactValues must contain only strings');
  }
  const redactions = new Set(redactValues.filter(Boolean));
  const active = new WeakSet();
  function collectSecretValues(value, seen = new WeakSet()) {
    if (typeof value === 'string' && value) redactions.add(value);
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const item of Object.values(value)) collectSecretValues(item, seen);
    }
  }
  function visit(value, redactWholeStrings = false) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      if (redactWholeStrings && redactions.has(value)) return '[redacted]';
      if (/^\s*[\[{]/.test(value)) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { return value; }
        return JSON.stringify(visit(parsed, redactWholeStrings));
      }
      return value;
    }
    if (!value || typeof value !== 'object' || active.has(value)) {
      throw new TypeError('Response payload must be finite, acyclic JSON data');
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Response payload must be plain JSON data');
    }
    active.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => visit(item, redactWholeStrings));
    else {
      const entries = [];
      for (const [key, item] of Object.entries(value)) {
        if (sensitiveKey.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
          collectSecretValues(item);
        } else if (item !== undefined) entries.push([key, visit(item, redactWholeStrings)]);
      }
      result = Object.fromEntries(entries);
    }
    active.delete(value);
    return result;
  }
  // Discover secrets throughout the original payload before parsing can normalize
  // an earlier echo's whitespace or remove its whole-string representation.
  visit(payload);
  const clean = visit(payload, true);
  const secrets = [...redactions].sort((a, b) => b.length - a.length);
  function redact(value) {
    if (typeof value === 'string') {
      if (/^\s*[\[{]/.test(value)) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { /* Keep non-JSON prose. */ }
        if (parsed !== undefined) return JSON.stringify(redact(parsed));
      }
      for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  }
  return redact(clean);
}

/** Publish only an already-obtained result. This module never sends MCP calls.
 * The caller can print a short marker after this resolves; readers use the file.
 * Use one in-flight result per path and a fresh ID for every dispatch. Keep at
 * most 16 immutable ID copies; latest replacement can fail without losing the ID.
 * Optional timing accepts only inputReceivedAt, mcpDispatchedAt, mcpSettledAt and
 * boardCapturedAt epoch milliseconds. Persisted preparedAt precedes file writes.
 * Returned idAvailableAt/publicationReturnedAt observe this invocation only and
 * are not written back into an immutable receipt. None measures model delivery.
 */
export async function publishResponse(file, id, payload, options = {}) {
  validId(id);
  const target = outputPath(file);
  const timing = options.timing === undefined ? undefined : {...callerTiming(options.timing), preparedAt: Date.now()};
  const cleanPayload = timing ? sanitizeResponse({payload, timing: boundedTimingMetadata(options.timing)}, options).payload : sanitizeResponse(payload, options);
  let value = {format: FORMAT, id, payload: cleanPayload, ...(timing ? {timing} : {})};
  let text = JSON.stringify(value);
  const retention = await prepareRetention(target, id, text, value);
  if (retention.existing) { text = retention.text; value = JSON.parse(text); }
  if (!retention.existing) await atomicWrite(retention.exact, text, join(retention.area, 'pending-response.tmp'));
  const idAvailableAt = Date.now();
  const returned = publication => ({...value, ...(value.timing ? {timing: {...value.timing, idAvailableAt, publicationReturnedAt: Date.now()}} : {}), ...(publication ? {publication} : {})});
  try {
    await atomicWrite(target, text, join(retention.area, 'latest-response.tmp'));
  } catch (error) {
    return returned({idRetained: true, latestUpdated: false, warning: 'latest-response-not-updated', code: publicationErrorCodes.has(error.code) ? error.code : 'PUBLISH_ERROR'});
  }
  return returned();
}

/** Read only a complete, matching output envelope. Missing, partial, stale or
 * incompatible files are pending observations, never permission to resend.
 */
export async function readResponse({file, id, redactValues = [], view = 'full'}) {
  validId(id);
  if (!['full', 'decision'].includes(view)) throw new TypeError('view must be full or decision');
  const target = outputPath(file);
  const area = `${target}.responses`;
  let retained = false;
  try {
    const info = await fileSystem.lstat(area);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Response retention area must be a real directory');
    retained = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const path of retained ? [retainedPath(target, id), target] : [target]) {
    let value, info;
    try {
      info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Response output must be a regular file');
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || transientFileErrors.has(error.code)) continue;
      throw error;
    }
    if (value?.format !== FORMAT || value.id !== id || !Object.hasOwn(value, 'payload')) continue;
    const timing = storedTiming(value.timing);
    const readerMatchedAt = Date.now();
    // These are observations by this file reader, not tool/model delivery. A
    // filesystem mtime is labelled separately from the publisher's preparation.
    const readerTiming = timing ? {...timing, readerMatchedAt,
      ...(timestamp(timing.preparedAt) ? {preparedAgeMs: readerMatchedAt >= timing.preparedAt ? readerMatchedAt - timing.preparedAt : null} : {}),
      ...(Number.isFinite(info.mtimeMs) && info.mtimeMs >= 0 ? {fileModifiedAt: Math.floor(info.mtimeMs), fileAgeMs: readerMatchedAt >= info.mtimeMs ? Math.floor(readerMatchedAt - info.mtimeMs) : null} : {})} : null;
    const payload = timing ? sanitizeResponse({payload: value.payload, timing: boundedTimingMetadata(value.timing)}, {redactValues}).payload : sanitizeResponse(value.payload, {redactValues});
    const envelope = {format: FORMAT, id, payload, ...(readerTiming ? {timing: readerTiming} : {})};
    return view === 'decision' ? projectDecisionView(envelope, {now: readerMatchedAt}) : envelope;
  }
  return null;
}

export async function awaitResponse({file, id, timeoutMs = DEFAULT_WAIT_MS, intervalMs = 50, redactValues = [], view = 'full'}) {
  validId(id);
  if (!['full', 'decision'].includes(view)) throw new TypeError('view must be full or decision');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
    throw new TypeError(`timeoutMs must be an integer from 0 to ${MAX_WAIT_MS}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) {
    throw new TypeError('intervalMs must be an integer from 1 to 1000');
  }
  const started = performance.now();
  for (;;) {
    const value = await readResponse({file, id, redactValues, view});
    const elapsedMs = Math.round(performance.now() - started);
    if (value) return {complete: true, value, elapsedMs};
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) {
      return {complete: false, value: {id, pending: true, reason: 'response-file-timeout', resend: false}, elapsedMs};
    }
    await new Promise(done => setTimeout(done, Math.min(intervalMs, remaining)));
  }
}

async function main(args) {
  const usage = 'Usage: node showdown/operator-response.mjs --wait FILE --id ID [--timeout-ms 0..60000] [--view full|decision]';
  if (args.length < 4 || args.length > 8 || args.length % 2 || args[0] !== '--wait' || args[2] !== '--id') throw new TypeError(usage);
  let timeoutMs = DEFAULT_WAIT_MS, view = 'full';
  const seen = new Set();
  for (let index = 4; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--timeout-ms', '--view'].includes(flag) || seen.has(flag)) throw new TypeError(usage);
    seen.add(flag);
    if (flag === '--timeout-ms') timeoutMs = Number(value);
    else view = value;
  }
  const result = await awaitResponse({file: args[1], id: args[3], timeoutMs, view});
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
  process.exitCode = result.complete ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`operator-response: ${error.message}\n`);
    process.exitCode = 1;
  });
}
