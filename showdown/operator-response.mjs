import {createHash} from 'node:crypto';
import fileSystem, {lstat, mkdir, open, readFile, readdir, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const FORMAT = 'vgc-operator-response-v1';
const MAX_WAIT_MS = 22000;
const MAX_RETAINED_RESPONSES = 16;
const RENAME_RETRY_MS = [10, 20, 40, 80, 160];
const transientFileErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sensitiveKey = /^(?:password|passwd|passphrase|controllerlease|lease|readreceipt|assertion|challstr|credential|credentials|secret|clientsecret|accesstoken|refreshtoken|authorization|cookie|setcookie|capability)$/;

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

async function prepareRetention(target, id, text) {
  const area = `${target}.responses`;
  await mkdir(area).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const areaInfo = await fileSystem.lstat(area);
  if (!areaInfo.isDirectory() || areaInfo.isSymbolicLink()) throw new Error('Response retention area must be a real directory');
  const exact = retainedPath(target, id);
  try {
    const info = await lstat(exact);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(exact, 'utf8') !== text) {
      throw new Error('Response ID already has a different or invalid retained result');
    }
    return {area, exact, existing: true};
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
 */
export async function publishResponse(file, id, payload, options = {}) {
  validId(id);
  const target = outputPath(file);
  const value = {format: FORMAT, id, payload: sanitizeResponse(payload, options)};
  const text = JSON.stringify(value);
  const retention = await prepareRetention(target, id, text);
  if (!retention.existing) await atomicWrite(retention.exact, text, join(retention.area, 'pending-response.tmp'));
  try {
    await atomicWrite(target, text, join(retention.area, 'latest-response.tmp'));
  } catch (error) {
    return {...value, publication: {idRetained: true, latestUpdated: false, warning: 'latest-response-not-updated', code: typeof error.code === 'string' ? error.code : 'PUBLISH_ERROR'}};
  }
  return value;
}

/** Read only a complete, matching output envelope. Missing, partial, stale or
 * incompatible files are pending observations, never permission to resend.
 */
export async function readResponse({file, id, redactValues = []}) {
  validId(id);
  const target = outputPath(file);
  const area = `${target}.responses`;
  let retained = false;
  try {
    const info = await fileSystem.lstat(area);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Response retention area must be a real directory');
    retained = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const path of retained ? [retainedPath(target, id), target] : [target]) {
    let value;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Response output must be a regular file');
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || transientFileErrors.has(error.code)) continue;
      throw error;
    }
    if (value?.format !== FORMAT || value.id !== id || !Object.hasOwn(value, 'payload')) continue;
    return {format: FORMAT, id, payload: sanitizeResponse(value.payload, {redactValues})};
  }
  return null;
}

export async function awaitResponse({file, id, timeoutMs = MAX_WAIT_MS, intervalMs = 50, redactValues = []}) {
  validId(id);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
    throw new TypeError(`timeoutMs must be an integer from 0 to ${MAX_WAIT_MS}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) {
    throw new TypeError('intervalMs must be an integer from 1 to 1000');
  }
  const started = performance.now();
  for (;;) {
    const value = await readResponse({file, id, redactValues});
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
  if (args.length !== 4 && args.length !== 6 || args[0] !== '--wait' || args[2] !== '--id' || args.length === 6 && args[4] !== '--timeout-ms') {
    throw new TypeError('Usage: node showdown/operator-response.mjs --wait FILE --id ID [--timeout-ms 0..22000]');
  }
  const result = await awaitResponse({file: args[1], id: args[3], timeoutMs: args.length === 6 ? Number(args[5]) : MAX_WAIT_MS});
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
  process.exitCode = result.complete ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`operator-response: ${error.message}\n`);
    process.exitCode = 1;
  });
}
