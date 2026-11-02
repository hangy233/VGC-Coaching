// Subscription-backed CLI discovery, opaque preflight and schema validation. Credentials remain
// inside the official CLI; this module never reads its authentication cache.
import {spawn as nodeSpawn} from 'node:child_process';
import {lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';

export const CODEX_CLI_LIMITS = Object.freeze({requestBytes: MAX_CONTEXT_BYTES, schemaBytes: MAX_CONTEXT_BYTES,
  streamBytes: 1024 * 1024, lineBytes: 128 * 1024, outputBytes: 64 * 1024,
  events: 2048, preflightMs: 10_000, terminationMs: 2000});
export const CODEX_PROMPT_SOURCE_DELIMITER = '\n\nComplete current source (JSON):\n';
const SKILL_CONTEXT_TOKEN_BUDGET = 1;
const EXPECTED_SKILL_OMISSION = /^Exceeded skills context budget\. All skill descriptions were removed and (\d+) additional skills were not included in the model-visible skills list\.$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => {const tail = relative(root, path); return tail !== '' && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);};
const bytes = text => Buffer.byteLength(text, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
const STDERR_LINE_BYTES=8192;
const REPORTED_HTTP_STATUSES=new Set([400,401,403,404,408,409,413,422,425,429,500,502,503,504]);
function stderrDiagnostic(line){
  // Classification only: raw stderr, paths, URLs and tokens are never retained.
  const text=line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu,'').trim();
  const retry=/^(?:Reconnecting\.{0,3}\s*(?:\d+\s*\/\s*\d+)?|Retrying (?:request|stream|connection)\b|Retry attempt\s+\d+)/iu.test(text)||
    /\b(?:WARN|ERROR|INFO|DEBUG)\b[^\n]{0,200}\b(?:Reconnecting\.{0,3}\s*\d+\s*\/\s*\d+|Retrying (?:request|stream|connection)\b|retry attempt\s+\d+)/iu.test(text);
  const status=Number(/\b(?:HTTP(?:\/[123](?:\.\d)?)?\s+(?:status\s*)?|status(?:\s+code)?\s*[:=]?\s*)([45]\d\d)\b/iu.exec(text)?.[1]);
  const transport=retry?'network_retry':/\bECONNRESET\b|connection reset/iu.test(text)?'connection_reset':
    /\bECONNREFUSED\b|connection refused/iu.test(text)?'connection_refused':/\bETIMEDOUT\b|connection timed out/iu.test(text)?'connection_timeout':
    /\b(?:EAI_AGAIN|ENOTFOUND)\b|dns (?:error|failure)/iu.test(text)?'dns_failure':
    /stream disconnected before completion/iu.test(text)?'stream_disconnected':/\b(?:TLS|SSL)\b.{0,40}(?:error|failed|failure)|certificate (?:error|verify failed)/iu.test(text)?'tls_failure':null;
  return {retry,transport,httpStatus:REPORTED_HTTP_STATUSES.has(status)?status:null};
}
export function discoverCodexCliExecutable(workspace, {platform = process.platform, architecture = process.arch,environment = process.env} = {}) {
  const distributions = {
    'win32-x64': ['codex-win32-x64','x86_64-pc-windows-msvc','codex.exe'],
    'win32-arm64': ['codex-win32-arm64','aarch64-pc-windows-msvc','codex.exe'],
    'linux-x64': ['codex-linux-x64','x86_64-unknown-linux-musl','codex'],
    'linux-arm64': ['codex-linux-arm64','aarch64-unknown-linux-musl','codex'],
    'darwin-x64': ['codex-darwin-x64','x86_64-apple-darwin','codex'],
    'darwin-arm64': ['codex-darwin-arm64','aarch64-apple-darwin','codex'],
  };
  const distribution = distributions[`${platform}-${architecture}`];
  if (workspace && distribution) {
    const [packageName,target,binary] = distribution;
    const installed = join(resolve(workspace),'cache','tooling','codex-cli','node_modules','@openai',packageName,'vendor',target,'bin',binary);
    if (existsSync(installed)) return installed;
  }
  // Resolve the existing official CLI from PATH, including npm's native
  // package location. Discovery never installs, executes or authenticates.
  const search=String(environment.PATH??environment.Path??'').split(platform==='win32'?';':':').filter(Boolean);
  for(const directory of search){
    const candidates=[join(directory,platform==='win32'?'codex.exe':'codex')];
    if(distribution){const [packageName,target,binary]=distribution;
      for(const prefix of [join(directory,'node_modules','@openai'),join(directory,'..','lib','node_modules','@openai')]){
        candidates.push(join(prefix,packageName,'vendor',target,'bin',binary),join(prefix,'codex','node_modules','@openai',packageName,'vendor',target,'bin',binary),join(prefix,'codex','vendor',target,'bin',binary));
      }
    }
    for(const candidate of candidates)try{if(statSync(candidate).isFile())return realpathSync(candidate);}catch{}
  }
  return undefined;
}
async function withinTime(promise, milliseconds) {
  let timer;
  try {return await Promise.race([promise, new Promise(resolveLimit => {timer = setTimeout(() => resolveLimit(false), milliseconds);})]);}
  finally {clearTimeout(timer);}
}

function providerErrorCode(value) {
  // Known categories only. Neither arbitrary provider text nor model reasoning
  // enters an exception, receipt or report.
  const text = typeof value?.message === 'string' ? value.message : typeof value?.error?.message === 'string' ? value.error.message : '';
  if (/reconnect(?:ing)?|retrying|retry attempt/i.test(text)) return 'network_retry';
  if (/model.{0,100}(?:not supported|unsupported|not found|does not exist)|unsupported.{0,40}model/i.test(text)) return 'unsupported_model';
  if (/usage limit|quota|insufficient_quota/i.test(text)) return 'quota';
  if (/rate.?limit|too many requests/i.test(text)) return 'rate_limit';
  if (/not logged in|authentication|token.{0,30}expired|unauthorized|sign in/i.test(text)) return 'auth_required';
  return 'provider_failed';
}

export class CodexCliTransportError extends Error {
  constructor(code, telemetry = {}) {
    super(`Subscription decision unavailable (${code}).`);
    this.name = 'CodexCliTransportError'; this.code = code; this.telemetry = {...telemetry, errorCode: code};
  }
}
const fail = code => {throw new CodexCliTransportError(code);};

// The official cached login is reused opaquely. Provider overrides, API tokens,
// proxy credentials and parent-agent identifiers never reach the child process.
export function codexCliEnvironment(source = process.env) {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'userprofile',
    'homedrive', 'homepath', 'appdata', 'localappdata', 'home', 'temp', 'tmp', 'tmpdir',
    'lang', 'lc_all', 'tz', 'number_of_processors', 'processor_architecture', 'codex_home']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'));
}

async function checkedDirectory(path, {create = false} = {}) {
  const absolute = resolve(path), parent = resolve(absolute, '..');
  if (parent !== absolute) await checkedDirectory(parent);
  let stat;
  try {stat = await lstat(absolute);} catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(absolute); stat = await lstat(absolute);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_artifact_path');
  if (resolve(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) fail('unsafe_artifact_path');
  return absolute;
}

async function createOwnedRoot(workspace, artifactDirectory) {
  const root = await checkedDirectory(workspace), cache = join(root, 'cache');
  const artifact = resolve(artifactDirectory);
  if (!inside(cache, artifact)) fail('unsafe_artifact_path');
  // Validate every ancestor before creating any nested directory.
  const parts = relative(root, artifact).split(sep); let current = root;
  for (const part of parts) {current = join(current, part); await checkedDirectory(current, {create: true});}
  return {workspace: root, artifact};
}

async function removeOwned(path, owner, prefix) {
  if (!inside(owner, path) || !relative(owner, path).startsWith(prefix)) fail('unsafe_artifact_path');
  await checkedDirectory(path);
  await rm(path, {recursive: true, force: false});
}

// Deliberately bounded JSON Schema subset matching the existing isolated output
// contract. Unknown keywords and external references fail before generation.
function checkJson(value, depth = 0, ancestors = new Set()) {
  if (depth > 64) fail('invalid_request');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail('invalid_request');
  if (Object.getOwnPropertySymbols(value).length) fail('invalid_request');
  ancestors.add(value);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail('invalid_request');
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_request');
    checkJson(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
const SCHEMA_KEYS = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'properties',
  'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern']);
function refNode(root, ref) {
  if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/'))) fail('invalid_schema');
  let node = root;
  for (const part of ref === '#' ? [] : ref.slice(2).split('/')) {
    if (/~(?:[^01]|$)/u.test(part)) fail('invalid_schema');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!object(node) || !Object.hasOwn(node, key)) fail('invalid_schema'); node = node[key];
  }
  return node;
}
export function validateCodexOutputSchema(root) {return checkSchema(root);}
/** Strict schema boundary for the retained CLI transport. */
export function validateCodexDecision(value, schema) {
  checkJson(value); checkSchema(schema);
  if (!matches(value, schema, schema)) fail('schema_mismatch');
  return value;
}
function checkSchema(root) {
  checkJson(root); const seen = new Set();
  if (!object(root) || root.type !== 'object') fail('invalid_schema');
  function visit(node) {
    if (seen.has(node)) return;
    if (!object(node) || Object.keys(node).some(key => !SCHEMA_KEYS.has(key)) || seen.size > 2000) fail('invalid_schema');
    seen.add(node);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!node.type && !node.$ref && !node.anyOf || node.type && types.some(type => !['null','object','array','string','number','integer','boolean'].includes(type))) fail('invalid_schema');
    if (node.$ref) visit(refNode(root, node.$ref));
    if (node.$defs) {if (!object(node.$defs)) fail('invalid_schema'); Object.values(node.$defs).forEach(visit);}
    if (node.anyOf) {if (!Array.isArray(node.anyOf) || !node.anyOf.length) fail('invalid_schema'); node.anyOf.forEach(visit);}
    if (types.includes('object')) {
      if (!object(node.properties) || node.additionalProperties !== false || !Array.isArray(node.required) || new Set(node.required).size !== Object.keys(node.properties).length || node.required.some(key => !Object.hasOwn(node.properties, key))) fail('invalid_schema');
      Object.values(node.properties).forEach(visit);
    } else if (['properties','required','additionalProperties'].some(key => Object.hasOwn(node, key))) fail('invalid_schema');
    if (types.includes('array')) {if (!node.items) fail('invalid_schema'); visit(node.items);}
    for (const key of ['minItems','maxItems','minLength','maxLength']) if (Object.hasOwn(node, key) && !safeInt(node[key])) fail('invalid_schema');
    for (const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']) if (Object.hasOwn(node, key) && !Number.isFinite(node[key])) fail('invalid_schema');
    if (node.multipleOf !== undefined && node.multipleOf <= 0) fail('invalid_schema');
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) fail('invalid_schema');
    if (node.pattern !== undefined) {if (typeof node.pattern !== 'string' || node.pattern.length > 512) fail('invalid_schema'); try {new RegExp(node.pattern, 'u');} catch {fail('invalid_schema');}}
  }
  visit(root);
}
function matches(value, node, root, depth = 0) {
  if (depth > 64) return false;
  if (node.$ref && !matches(value, refNode(root, node.$ref), root, depth + 1)) return false;
  if (node.anyOf && !node.anyOf.some(child => matches(value, child, root, depth + 1))) return false;
  const equalJson = (left, right) => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => equalJson(item, right[i]));
    if (!object(left) || !object(right)) return false;
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right,key) && equalJson(left[key],right[key]));
  };
  const equal = other => equalJson(other,value);
  if (node.enum && !node.enum.some(equal) || Object.hasOwn(node, 'const') && !equal(node.const)) return false;
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (node.type && !(Array.isArray(node.type) ? node.type : [node.type]).some(type => type === kind || type === 'integer' && Number.isInteger(value))) return false;
  if (object(value) && node.properties && (node.required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !Object.hasOwn(node.properties, key) || !matches(value[key], node.properties[key], root, depth + 1)))) return false;
  if (Array.isArray(value) && (node.minItems !== undefined && value.length < node.minItems || node.maxItems !== undefined && value.length > node.maxItems || node.items && !value.every(item => matches(item, node.items, root, depth + 1)))) return false;
  if (typeof value === 'string' && (node.minLength !== undefined && [...value].length < node.minLength || node.maxLength !== undefined && [...value].length > node.maxLength || node.pattern && !new RegExp(node.pattern, 'u').test(value))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || node.minimum !== undefined && value < node.minimum || node.maximum !== undefined && value > node.maximum || node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum || node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum || node.multipleOf !== undefined && Math.abs(value / node.multipleOf - Math.round(value / node.multipleOf)) > 1e-10)) return false;
  return true;
}

async function terminateTree(child, spawn, platform) {
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return true;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  if (platform === 'win32') {
    return await new Promise(resolveResult => {
      let killer; const timer = setTimeout(() => resolveResult(false), CODEX_CLI_LIMITS.terminationMs);
      try {
        killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          {shell: false, windowsHide: true, stdio: 'ignore', env: codexCliEnvironment()});
        killer.once('error', () => {clearTimeout(timer); resolveResult(false);});
        killer.once('close', code => {clearTimeout(timer); resolveResult(code === 0);});
      } catch {clearTimeout(timer); resolveResult(false);}
    });
  }
  try {process.kill(-child.pid, 'SIGKILL'); return true;} catch {return false;}
}

/** Factory performs no login, model request or credential reads. */
export function createCodexCliPreflight({workspace, model, reasoningEffort, artifactDirectory,
  executable, spawn = nodeSpawn, now = Date.now, environment = process.env,
  platform = process.platform, architecture = process.arch, terminateProcess, serviceTier = 'standard'} = {}) {
  executable ??= discoverCodexCliExecutable(workspace,{platform,architecture,environment});
  if (!workspace || !artifactDirectory || typeof executable !== 'string' || !isAbsolute(executable) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model ?? '') || !['minimal','low','medium','high','xhigh'].includes(reasoningEffort) || !['standard','fast'].includes(serviceTier)) fail('invalid_configuration');
  let approved, roots, busy = false, halted = false;
  const env = codexCliEnvironment(environment);
  const stop = child => terminateProcess ? terminateProcess(child) : terminateTree(child, spawn, platform);

  async function command(args, {cwd, deadlineAt, signal, input, event, telemetry, capture = false} = {}) {
    if (now() >= deadlineAt) fail('deadline_exceeded');
    if (signal?.aborted) fail('aborted');
    let child, closed = false, out = '', buffer = '', streamBytes = 0, eventCount = 0, failure, terminatePromise;
    const decoder = new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
    let stderrBuffer='';
    let settleClose;
    const closure = new Promise(resolveClose => {settleClose = resolveClose;});
    function abort(code) {
      if (failure) return; failure = code;
      terminatePromise = Promise.resolve().then(() => stop(child)).catch(() => false);
    }
    const timer = setTimeout(() => abort('deadline_exceeded'), Math.max(1, deadlineAt - now()));
    const onAbort = () => abort('aborted'); signal?.addEventListener('abort', onAbort, {once: true});
    try {
      telemetry.dispatchAt = now(); telemetry.spawnStartedAt = now();
      child = spawn(executable, args, {cwd, env: {...env}, shell: false, windowsHide: true,
        detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
      telemetry.spawnedAt = now(); telemetry.startupMs = telemetry.spawnedAt - telemetry.spawnStartedAt;
      child.once('error', () => {failure ||= 'process_error'; closed = true; settleClose({code: null});});
      const classifyStderr=line=>{const diagnostic=stderrDiagnostic(line);if(diagnostic.transport||diagnostic.httpStatus){
        telemetry.cliStderrFirstDiagnosticAt??=now();if(diagnostic.transport)telemetry.cliReportedTransportError??=diagnostic.transport;
        if(diagnostic.httpStatus)telemetry.cliReportedHttpStatus??=diagnostic.httpStatus;
      }if(diagnostic.retry){telemetry.providerErrorCode='network_retry';abort('generation_failed');}};
      const stderrText=text=>{stderrBuffer+=text;let index;while((index=stderrBuffer.indexOf('\n'))!==-1){const line=stderrBuffer.slice(0,index);stderrBuffer=stderrBuffer.slice(index+1);classifyStderr(Buffer.byteLength(line)<=STDERR_LINE_BYTES?line:Buffer.from(line).subarray(-STDERR_LINE_BYTES).toString('utf8'));if(failure)return;}
        if(Buffer.byteLength(stderrBuffer)>STDERR_LINE_BYTES)stderrBuffer=Buffer.from(stderrBuffer).subarray(-STDERR_LINE_BYTES).toString('utf8');};
      child.once('close', (code, signalName) => {closed = true;telemetry.exitAt = now();if(safeInt(code))telemetry.exitCode=code;
        if(!capture&&!failure){stderrText(stderrDecoder.end());if(stderrBuffer.trim())classifyStderr(stderrBuffer);stderrBuffer='';}settleClose({code, signalName});});
      function consume(chunk, stderr = false) {
        if (failure) return;
        streamBytes += chunk.length;
        if (streamBytes > (capture ? 16 * 1024 : CODEX_CLI_LIMITS.streamBytes)) {abort('stream_limit'); return;}
        if (capture) {out += chunk.toString('utf8'); return;}
        if (stderr) {stderrText(stderrDecoder.write(chunk));return;}
        const text = decoder.write(chunk);
        buffer += text;
        if (bytes(buffer) > CODEX_CLI_LIMITS.lineBytes && !buffer.includes('\n')) {abort('stream_limit'); return;}
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line) continue;
          if (bytes(line) > CODEX_CLI_LIMITS.lineBytes || ++eventCount > CODEX_CLI_LIMITS.events) {abort('stream_limit'); return;}
          try {event(JSON.parse(line));} catch (error) {abort(error instanceof CodexCliTransportError ? error.code : 'invalid_stream'); return;}
        }
      }
      child.stdout.on('data', chunk => consume(chunk)); child.stderr.on('data', chunk => consume(chunk, true));
      child.stdin.on('error', () => abort('stdin_failed'));
      // Single stdin write supplies the complete immutable current source.
      telemetry.stdinStartedAt = now();
      child.stdin.once('finish', () => {telemetry.stdinCompletedAt = now(); telemetry.stdinDurationMs = telemetry.stdinCompletedAt - telemetry.stdinStartedAt;});
      child.stdin.end(input ?? '');
      const outcome = await Promise.race([closure, new Promise(resolveLimit => {
        const check = () => failure ? resolveLimit(null) : closed ? resolveLimit(null) : setTimeout(check, 10);
        check();
      })]);
      if (failure) {
        const killed = terminatePromise ? await terminatePromise : closed;
        const confirmed = closed || await withinTime(closure.then(() => true), CODEX_CLI_LIMITS.terminationMs);
        // A CLI that already exited can race taskkill's process lookup. Its
        // observed close remains authoritative; never turn that into a false
        // unknown-termination result or hide the original protocol failure.
        if (!confirmed) {halted = true; telemetry.initialFailureCode = failure; failure = 'termination_uncertain';}
        throw new CodexCliTransportError(failure, telemetry);
      }
      if (!capture) buffer += decoder.end();
      if (!capture && buffer.trim()) {try {event(JSON.parse(buffer));} catch (error) {throw error instanceof CodexCliTransportError ? error : new CodexCliTransportError('invalid_stream');}}
      if (now() >= deadlineAt) fail('deadline_exceeded');
      if (outcome?.code !== 0) fail('process_failed');
      telemetry.streamBytes = streamBytes; telemetry.eventCount = eventCount;
      return out;
    } catch (error) {
      if (child && !closed && !terminatePromise) {
        const killed = await stop(child).catch(() => false);
        const confirmed = closed || await withinTime(closure.then(() => true), CODEX_CLI_LIMITS.terminationMs);
        if (!confirmed) {halted = true; telemetry.initialFailureCode = error instanceof CodexCliTransportError ? error.code : 'process_error'; throw new CodexCliTransportError('termination_uncertain', telemetry);}
      }
      throw error instanceof CodexCliTransportError ? error : new CodexCliTransportError('process_error', telemetry);
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', onAbort);}
  }

  async function ownedCwd() {
    const parent = await checkedDirectory(await realpath(tmpdir()));
    const cwd = await mkdtemp(join(parent, 'vgc-codex-cwd-'));
    if (inside(roots.workspace, cwd) || roots.workspace === cwd) fail('unsafe_artifact_path');
    await checkedDirectory(cwd); return {cwd, parent};
  }

  async function preflight() {
    if (busy || halted) fail(halted ? 'termination_uncertain' : 'transport_busy');
    busy = true; approved = undefined; let temporary;
    try {
      roots = await createOwnedRoot(workspace, artifactDirectory);
      await checkedDirectory(dirname(executable));
      const binary = await lstat(executable);
      if (!binary.isFile() || binary.isSymbolicLink() || resolve(await realpath(executable)).toLowerCase() !== resolve(executable).toLowerCase()) fail('unsafe_executable_path');
      temporary = await ownedCwd();
      const deadlineAt = now() + CODEX_CLI_LIMITS.preflightMs;
      const versionText = await command(['--version'], {cwd: temporary.cwd, deadlineAt, capture: true, telemetry: {}});
      const cliVersion = /codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/i.exec(versionText)?.[1];
      if (!cliVersion) fail('unsupported_cli');
      // Inspect before forcing the method: a mismatch restriction can invalidate
      // the CLI's saved login. Never change an API login into a ChatGPT login.
      const status = await command(['login', 'status'], {cwd: temporary.cwd, deadlineAt, capture: true, telemetry: {}});
      if (!/logged in using chatgpt/i.test(status)) fail(/api\s*key|api authentication/i.test(status) ? 'api_auth_forbidden' : 'chatgpt_auth_required');
      approved = {kind: 'codex-cli', authMode: 'chatgpt', cliVersion, model, reasoningEffort, subscriptionBilling: true, generationQualified: false,
        requestedServiceTier: serviceTier, providerRetryCountKnown: false, preflightCompletedAt: now()};
      return {...approved};
    } finally {
      if (temporary && !halted) await removeOwned(temporary.cwd, temporary.parent, 'vgc-codex-cwd-');
      busy = false;
    }
  }

  return {preflight};
}
