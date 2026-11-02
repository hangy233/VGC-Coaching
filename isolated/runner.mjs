import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {ISOLATED_POLICY_SOURCE,verifyIsolatedPolicySource} from './decision-context.mjs';
import {prepareRecoveryHandoff} from './recovery-handoff.mjs';
import {prepareTeamGuidance} from './team-guidance.mjs';
import {prepareMatchupGuidance,verifyMatchupGuidance} from './matchup-guidance.mjs';
import {MAX_CONTEXT_BYTES,SESSION_REFRESH_TELEMETRY_FIELDS} from './context-limits.mjs';
import {hasModelToolQualificationReceipt} from './model-tool-qualification.mjs';
import {preparePonderAnalysis,prepareUnvalidatedPonderDiagnostic} from './ponder-evidence.mjs';
import {verifyPonderQualificationReceipt} from './ponder-qualification.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_MODEL_TRACE_BYTES=64*1024*1024;
const HASH = /^[a-f0-9]{64}$/u;
const PARENT = /^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
// Every explicitly selected CLI model still needs its own saved-position/MCP
// qualification and battle scope. Model eligibility grants no battle allowance.
const CODEX_LIVE_MODELS = new Set(['gpt-6.1-sol','gpt-5.6-sol','gpt-6-luna']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const canonical = value => String(value ?? '').replace(/-[a-z0-9]+pw$/u, '');
const within = (root, path) => {const part = relative(root, path); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);};
function body(value) {
  let current = value;
  for (let depth = 0; depth < 5 && object(current); depth++) {
    if (current.error || current.ok === false || current.isError === true || current.sessionId !== undefined || current.status !== undefined || current.reason !== undefined) return current;
    if (current.result !== undefined) current = current.result;
    else if (current.data !== undefined) current = current.data;
    else break;
  }
  return current;
}
const MESSAGES = Object.freeze({
  arguments: 'Use one of --check, --offline or --run; live use requires --session and --scope.',
  configuration: 'The explicit session or one-set scope configuration is invalid.',

  provider_configuration: 'An explicit supported decision provider and its own qualification strategy are required.',
  generation_unavailable: 'A fresh bounded model-generation check did not complete successfully. No battle search was sent; inspect the selected CLI access, quota or model status.',
  generation_failed: 'The model decision request failed or did not finish before its original deadline. Retain the same owner and inspect the saved CLI failure evidence; do not retry automatically.',
  identity: 'The connected session, approved team or account differs from the explicit configuration.',
  idle: 'A server-confirmed idle session is required; the client was retained.',
  allowance: 'The existing session does not show a remaining authorized set.',
  skill: 'Complete synchronized current matchup guidance is required before search.',
  review: 'The previous native BO3 review is incomplete; no new search was sent.',
  policy: 'The configured deadline protection was not verified, or an existing halt needs review.',
  readiness: 'The manual readiness mode or current server readiness token was not verified. Retain the same owner; do not advance the next preview until prepared.',
  preflight: 'Native preflight has blockers; no new search was sent.',
  operator: 'A native operation failed or has an uncertain outcome. Inspect native status and retained traces; do not retry the mutation.',
  controller_preparation: 'Decision preparation stopped before another choice could be submitted. Inspect the recorded controller stage, error code and private diagnostic; retain the same operator for recovery.',
  trace: 'Bounded private model evidence could not be preserved; no further model decisions are allowed.',
  offline: 'The offline qualification suite failed; no live action was performed.',
});

export class RunnerError extends Error {
  constructor(code) {super(MESSAGES[code] ?? MESSAGES.operator); this.name = 'RunnerError'; this.code = code;}
}
const requireThat = (condition, code = 'configuration') => {if (!condition) throw new RunnerError(code);};
const exactKeys = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));

export function parseRunnerArgs(args = []) {
  const result = {}; const modes = new Set(['--check', '--offline', '--run']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (modes.has(flag)) {requireThat(!result.mode, 'arguments'); result.mode = flag.slice(2);}
    else if (['--session', '--scope','--provider','--model','--reasoning-effort','--codex-context-mode','--codex-service-tier','--model-tool-qualification','--codex-executable'].includes(flag)) {
      const key = ({'--reasoning-effort':'reasoningEffort','--codex-context-mode':'contextMode','--codex-service-tier':'serviceTier','--model-tool-qualification':'modelToolQualificationFile','--codex-executable':'executable'})[flag]??flag.slice(2), value = args[++index];
      requireThat(!result[key] && typeof value === 'string' && value && !value.startsWith('--'), 'arguments');
      result[key] = value;
    } else throw new RunnerError('arguments');
  }
  requireThat(result.mode && (result.mode !== 'run' || result.session && result.scope), 'arguments');
  requireThat(result.mode !== 'offline' || !result.session && !result.scope, 'arguments');
  requireThat(Boolean(result.session) === Boolean(result.scope), 'arguments');
  requireThat(result.mode==='offline'||result.provider==='codex-cli','arguments');
  requireThat(result.provider==='codex-cli'?typeof result.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(result.model)&&['low','medium','high'].includes(result.reasoningEffort):result.model===undefined&&result.reasoningEffort===undefined,'arguments');
  requireThat(result.provider==='codex-cli'?(result.contextMode===undefined||result.contextMode==='session')&&(result.serviceTier===undefined||['standard','fast'].includes(result.serviceTier)):result.contextMode===undefined&&result.serviceTier===undefined,'arguments');
  if(result.provider==='codex-cli')result.contextMode??='session';
  requireThat(result.mode!=='run'||result.provider!=='codex-cli'||result.contextMode==='session','arguments');
  requireThat(result.modelToolQualificationFile===undefined||result.provider==='codex-cli','arguments');
  return result;
}

export function validateSessionConfiguration(value) {
  requireThat(exactKeys(value, ['version', 'sessionId', 'teamId', 'account', 'teamFile']) && value.version === 1);
  requireThat(typeof value.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value.sessionId));
  requireThat(HASH.test(value.teamId ?? '') && typeof value.account === 'string' && /^[A-Za-z0-9 _.-]{1,30}$/u.test(value.account));
  requireThat(typeof value.teamFile === 'string' && value.teamFile && value.teamFile.length <= 2048);
  return structuredClone(value);
}

export function validateScopeConfiguration(value, identity) {
  requireThat(exactKeys(value, ['version', 'authorization', 'sessionId', 'teamId', 'account', 'maxSets', 'allowSearch', 'allowGenerationProbe', 'allowManualForfeit', 'manualReady', 'saveReplays', 'controlPolicy','allowPonder']) && value.version === 1);
  requireThat(typeof value.authorization === 'string' && value.authorization.trim().length >= 10 && value.authorization.length <= 2000);
  requireThat(value.sessionId === identity.sessionId && value.teamId === identity.teamId && value.account === identity.account);
  requireThat(value.maxSets === 1 && value.allowSearch === true && value.allowGenerationProbe === true && typeof value.saveReplays === 'boolean');
  requireThat(value.allowManualForfeit === undefined || typeof value.allowManualForfeit === 'boolean');
  requireThat(value.manualReady===undefined||typeof value.manualReady==='boolean');
  requireThat(value.allowPonder===undefined||typeof value.allowPonder==='boolean');
  const policy = value.controlPolicy;
  requireThat(exactKeys(policy, ['enabled', 'forfeitIfStuck', 'emergencyDefaultChoice', 'planningMs', 'previewPlanningMs', 'unknownClockMs', 'safetyMarginMs']));
  requireThat(policy.enabled === true && typeof policy.forfeitIfStuck === 'boolean' && typeof policy.emergencyDefaultChoice === 'boolean');
  for (const key of ['planningMs', 'previewPlanningMs']) requireThat(Number.isInteger(policy[key]) && policy[key] >= 100 && policy[key] <= 60000);
  requireThat(Number.isInteger(policy.unknownClockMs) && policy.unknownClockMs >= 100 && policy.unknownClockMs <= 20000);
  requireThat(Number.isInteger(policy.safetyMarginMs) && policy.safetyMarginMs >= 1000 && policy.safetyMarginMs <= 15000);
  requireThat(policy.planningMs > policy.safetyMarginMs && policy.previewPlanningMs > policy.safetyMarginMs && policy.unknownClockMs > policy.safetyMarginMs);
  requireThat(policy.previewPlanningMs!==60000||policy.unknownClockMs===20000);
  return {...structuredClone(value),allowPonder:value.allowPonder??false};
}

const ponderShutdowns=new WeakMap();
function stopPonderBounded(runtime,onEvent=()=>{}){
  if(!runtime)return Promise.resolve();
  if(ponderShutdowns.has(runtime))return ponderShutdowns.get(runtime);
  // Abort synchronously; cleanup is separately bounded after the main loop.
  let stopError;try{runtime.stop('main-loop-ended');}catch(error){stopError=error;}
  const pending=(async()=>{let timer,result;
    try{result=await Promise.race([Promise.resolve().then(()=>runtime.drain({timeoutMs:250})),new Promise(resolve=>{timer=setTimeout(()=>resolve({cleanupConfirmed:false,timeout:true}),250);})]);}
    catch(error){result={cleanupConfirmed:false,code:error?.code??'PONDER_CLEANUP_FAILED'};}finally{clearTimeout(timer);}
    try{onEvent({name:'ponder.shutdown',at:Date.now(),...result,...(stopError?{cleanupConfirmed:false,code:stopError.code??'PONDER_STOP_FAILED'}:{})});}catch{}
  })();ponderShutdowns.set(runtime,pending);return pending;
}

async function regularWorkspaceFile(workspace, supplied, limit) {
  requireThat(typeof supplied === 'string' && supplied && !/[\x00-\x1f]/u.test(supplied));
  const root = await realpath(workspace), path = resolve(root, supplied);
  requireThat(within(root, path) && path !== root);
  const parts = relative(root, path).split(sep);
  requireThat(!parts.some(part => /^\.env(?:\.|$)|credential|api-key-setup|showdown-session/iu.test(part)));
  let current = root;
  for (const part of parts) {current = join(current, part); requireThat(!(await lstat(current)).isSymbolicLink());}
  const stat = await lstat(path);
  requireThat(stat.isFile() && stat.size <= limit);
  return readFile(path, 'utf8');
}

export async function readRunnerConfiguration({workspace = ROOT, sessionFile, scopeFile} = {}) {
  let identity, scope;
  try {
    identity = validateSessionConfiguration(JSON.parse(await regularWorkspaceFile(workspace, sessionFile, 16000)));
    scope = validateScopeConfiguration(JSON.parse(await regularWorkspaceFile(workspace, scopeFile, 16000)), identity);
    const ownTeamText = await regularWorkspaceFile(workspace, identity.teamFile, 16000);
    const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
    const team = Teams.import(ownTeamText);
    requireThat(team?.length === 6 && createHash('sha256').update(Teams.pack(team)).digest('hex') === identity.teamId);
    return {identity, scope, ownTeamText};
  } catch {throw new RunnerError('configuration');}
}

function verifiedIdentity(state, identity) {
  requireThat(state?.sessionId === identity.sessionId && state.teamSha256 === identity.teamId && state.username === identity.account && state.connected === true && state.authenticated === true && state.stopped !== true, 'identity');
}
function verifiedIdle(state) {
  const search = state?.search;
  requireThat(search && Object.hasOwn(search, 'games') && (search.games === null || object(search.games) && Object.keys(search.games).length === 0) && Array.isArray(search.searching) && search.searching.length === 0 &&
    !state.searchPending && !state.awaitingSet && !state.savingReplays && !state.switchingTeam && Array.isArray(state.actions) && state.actions.every(action => action.actionable === false) &&
    Array.isArray(state.rooms) && !state.rooms.some(room => room.id?.startsWith('game-bestof3-') && !room.ended), 'idle');
}
function postResultPending(state, identity, parentId, {compact = false} = {}) {
  if (compact) requireThat(state?.sessionId === identity.sessionId && [state.teamSha256, state.teamId].every(hash => hash === undefined || hash === identity.teamId) && state.connected === true && state.authenticated === true && state.stopped !== true, 'identity');
  else verifiedIdentity(state, identity);
  requireThat(Array.isArray(state.rooms) && Array.isArray(state.actions) && state.actions.length === 0 && !state.awaitingSet && !state.searchPending && !state.switchingTeam, 'operator');
  const parents = state.rooms.filter(room => PARENT.test(canonical(room.id)));
  const matches = parents.filter(room => canonical(room.id) === parentId);
  requireThat(matches.length === 1 && matches[0].ended === true && ['win', 'tie'].includes(matches[0].result?.type) &&
    (!matches[0].teamId || matches[0].teamId === identity.teamId) && !parents.some(room => canonical(room.id) !== parentId && room.ended !== true), 'operator');
  const search = state.search;
  requireThat(search && Array.isArray(search.searching) && search.searching.length === 0 && Object.hasOwn(search, 'games') &&
    (search.games === null || object(search.games)), 'operator');
  const children = state.rooms.filter(room => room.parentId && canonical(room.parentId) === parentId);
  const expected = matches[0].children;
  const missingChild = Array.isArray(expected) && expected.some(id => !state.rooms.some(room => canonical(room.id) === canonical(typeof id === 'string' ? id : id?.id)));
  let pending = state.savingReplays === true || children.some(room => room.ended !== true) || missingChild || search.games !== null && Object.keys(search.games).length > 0;
  if (compact) {
    const persistence = state.actionPlanPersistence;
    requireThat(object(persistence) && ['pending', 'failures', 'dropped'].every(key => Number.isSafeInteger(persistence[key]) && persistence[key] >= 0), 'operator');
    requireThat(persistence.failures === 0 && persistence.dropped === 0, 'operator');
    pending ||= persistence.pending > 0;
  }
  const replay = state.replayPolicy;
  if (object(replay)) {
    const forParent = values => (values ?? []).some(id => canonical(id) === parentId);
    requireThat(['pendingParents', 'attentionParents', 'sets'].every(key => replay[key] === undefined || Array.isArray(replay[key])), 'operator');
    const owned = (replay.sets ?? []).filter(row => canonical(row.parentId) === parentId && row.required);
    requireThat(!forParent(replay.attentionParents) && !owned.some(row => row.status === 'attention-required'), 'operator');
    pending ||= replay.active === true || forParent(replay.pendingParents) || owned.some(row => row.status !== 'complete');
  }
  return pending;
}

/** Post-result observation only. Preservation can start between the helper's
 * terminal reply and a full status read; retain this owner while both views
 * drain under one separate bounded deadline. No tactical deadline is changed. */
export async function waitForPostResultQuiescence({dispatch, identity, parentId, now = Date.now, onEvent = () => {}, timeoutMs = 30000} = {}) {
  requireThat(typeof dispatch === 'function' && PARENT.test(parentId) && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000, 'operator');
  const began = now(), deadlineAt = began + timeoutMs;
  let waits = 0;
  const read = async query => {
    requireThat(now() < deadlineAt, 'idle');
    const pending = Promise.resolve().then(() => dispatch(query));
    let timer;
    try {
      return await Promise.race([pending, new Promise((_resolve, reject) => {timer = setTimeout(() => {
        const failure = new RunnerError('idle');
        // A timed-out read still owns the operator serialization slot. Carry
        // its private promise into attention instead of dispatching around it.
        Object.defineProperty(failure, 'pendingPostResultRead', {value: pending});
        reject(failure);
      }, Math.max(1, deadlineAt - now()));})]);
    } finally {clearTimeout(timer);}
  };
  for (;;) {
    requireThat(now() < deadlineAt, 'idle');
    const full = await read({op: 'status', full: true});
    const fullPending = postResultPending(full, identity, parentId);
    requireThat(now() < deadlineAt, 'idle');
    const compact = await read({op: 'turn', full: true});
    const compactPending = postResultPending(compact, identity, parentId, {compact: true});
    requireThat(now() < deadlineAt, 'idle');
    if (!fullPending && !compactPending) {
      onEvent({type: 'post-result.quiescent', at: now(), parentId, waitedMs: now() - began, waits});
      return full;
    }
    requireThat(now() < deadlineAt && waits < 60 && Number.isSafeInteger(compact.revision) && compact.revision >= 0, 'idle');
    onEvent({type: 'post-result.waiting', at: now(), parentId, elapsedMs: now() - began, waits});
    const waited = await read({op: 'call', name: 'battle_wait', args: {afterRevision: compact.revision,
      timeoutMs: Math.max(1, Math.min(1000, deadlineAt - now())), format: 'compact'}, full: true});
    postResultPending(waited, identity, parentId, {compact: true});
    waits++;
  }
}
export function verifyGuidanceDelivery(operator,guidance,{commandId,skill,sourceSha256,now=Date.now}={}){
  requireThat(typeof commandId==='string'&&HASH.test(sourceSha256??'')&&object(skill)&&skill.synchronized===true&&skill.sourceSha256===sourceSha256&&skill.installedSha256===sourceSha256&&typeof now==='function','skill');
  requireThat(guidance?.skill==='champions-mc-matchups'&&guidance.synchronized===true&&guidance.sourceSha256===sourceSha256&&guidance.installedSha256===sourceSha256&&
    Number.isInteger(guidance.files)&&guidance.files>=1&&guidance.files<=512&&guidance.files===skill.files&&Array.isArray(guidance.filesRead)&&guidance.filesRead.length===guidance.files&&
    !Object.hasOwn(guidance,'readReceipt'),'skill');
  const paths=new Set(),rows=[];let total=0;
  for(const file of guidance.filesRead){
    requireThat(object(file)&&typeof file.path==='string'&&/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,1024}$/u.test(file.path)&&!paths.has(file.path)&&typeof file.content==='string'&&
      HASH.test(file.sha256??'')&&!file.content.includes('\0'),'skill');
    const contentBytes=Buffer.byteLength(file.content,'utf8');total+=contentBytes;
    requireThat(contentBytes<=1024*1024&&total<=8*1024*1024&&createHash('sha256').update(file.content,'utf8').digest('hex')===file.sha256,'skill');
    paths.add(file.path);rows.push([file.path,file.sha256,contentBytes]);
  }
  requireThat(paths.has('SKILL.md')&&paths.has('references/headless-battle-cycle.md'),'skill');
  rows.sort(([a],[b])=>a<b?-1:a>b?1:0);
  const deliverySha256=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const proof=typeof operator.getGuidanceReadProof==='function'?operator.getGuidanceReadProof({commandId}):null;
  requireThat(proof?.kind==='operator-retained-skill-read-proof'&&proof.version===1&&proof.commandId===commandId&&proof.skill===guidance.skill&&proof.receiptRetained===true&&
    proof.sourceSha256===sourceSha256&&proof.installedSha256===sourceSha256&&proof.files===guidance.files&&proof.deliverySha256===deliverySha256&&
    proof.receiptExpiresAt===guidance.receiptExpiresAt&&Number.isFinite(Date.parse(proof.receiptExpiresAt))&&Date.parse(proof.receiptExpiresAt)>now(),'skill');
  return {...proof,verified:true};
}

const SAFE_TELEMETRY = new Set(['startedAt', 'dispatchAt', 'fetchStartedAt', 'fetchResolvedAt', 'headersReceivedAt', 'responseCreatedAt', 'firstEventAt', 'firstTextAt', 'completedAt', 'parseStartedAt', 'parseCompletedAt', 'finishedAt', 'deadlineAt', 'attempts', 'requestBytes', 'inputBytes', 'outputBytes', 'streamBytes', 'eventCount', 'httpStatus', 'serverRequestId', 'responseId', 'responseModel', 'serviceTier', 'providerCreatedAtSeconds', 'processingMs', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens', 'headersLatencyMs', 'firstEventLatencyMs', 'firstTextLatencyMs', 'completionLatencyMs', 'parseDurationMs', 'requestWallTimeMs', 'errorCode', 'providerErrorCode', 'providerErrorType', 'incompleteReason', 'errorMetadataStatus', 'errorBodyBytes', 'timingInterpretation',"networkRetryCount","networkRetryScheduledAt","networkRetrySuppression","fetchAttempt1StartedAt","fetchAttempt1FinishedAt","fetchAttempt1ErrorCode","fetchAttempt1CauseCodes","fetchAttempt1HttpStatus","fetchAttempt1ServerRequestId","fetchAttempt2StartedAt","fetchAttempt2FinishedAt","fetchAttempt2ErrorCode","fetchAttempt2CauseCodes","fetchAttempt2HttpStatus","fetchAttempt2ServerRequestId","telemetrySource","controllerModelStartedAt","controllerModelDeadlineAt","controllerModelFailedAt","controllerAbortSettledAt","controllerAbortGraceMs","controllerErrorCode","transportErrorCode"]);
const PRIVATE_KEYS = /^(?:apiKey|api_key|authorization|password|credential|credentials|token|controllerLease|controlLease|readReceipt|sessionId|watchUrl|accessUrl|assertion)$/iu;
const DESKTOP_TRACE_TELEMETRY = new Set(['startedAt','dispatchAt','packetPublishedAt','packetReadAt','submittedAt','completedAt','parseStartedAt','parseCompletedAt','finishedAt','deadlineAt','requestBytes','inputBytes','outputBytes','parseDurationMs','requestWallTimeMs','errorCode','telemetrySource','controllerModelStartedAt','controllerModelDeadlineAt','controllerModelFailedAt','controllerAbortSettledAt','controllerAbortGraceMs','controllerErrorCode','transportErrorCode']);
const CODEX_TRACE_TELEMETRY = new Set([...DESKTOP_TRACE_TELEMETRY,'spawnStartedAt','spawnedAt','stdinStartedAt','stdinCompletedAt','firstEventAt','firstTextAt','finalReceivedAt','exitAt','exitCode','eventCount','streamBytes','inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens','startupMs','stdinDurationMs','firstEventLatencyMs','completionLatencyMs','authenticationMethod','preflightCompletedAt','cliVersion','attempts','networkRetryCount','providerErrorCode','initialFailureCode']);
for(const key of ['modelAttempted','coldContextBytes','remainingModelMs','minimumColdLargeModelMs'])CODEX_TRACE_TELEMETRY.add(key);
for(const key of SESSION_REFRESH_TELEMETRY_FIELDS)CODEX_TRACE_TELEMETRY.add(key);
for(const key of ['contextMode','sessionTurnIndex','sessionScopeSha256','sessionThreadSha256','sessionTurnCompleted','sessionProcessOwned','sessionSourceRehydrated','sessionSourceSha256','retainedStaticReferences','sessionNewInputBytes','sessionFullInputBytes','sessionSavedInputBytes','sessionNewPacketBytes','sessionFullPacketBytes','sessionSavedPacketBytes','sessionContextSequence','sessionPriorRequestBytes','sessionReused','compactionCount','modelContextWindowTokens','sessionCumulativeInputTokens','sessionCumulativeCachedInputTokens','sessionCumulativeOutputTokens','sessionCumulativeReasoningTokens'])CODEX_TRACE_TELEMETRY.add(key);
for(const key of ['providerStartedAt','presentationPreparedAt','providerFinishedAt','presentationMode','nativeInputSha256','nativeInstructionsSha256','nativeSchemaSha256','modelInputSha256','modelInstructionsSha256','modelSchemaSha256','inputPreserved','wireDecoded','presentationReason','sourceInputBytes','sourceInstructionsBytes','outputSchemaBytes','preparedInstructionsBytes','commandBytes'])CODEX_TRACE_TELEMETRY.add(key);
for(const key of ['sourceSha256','instructionsSha256','requestDurationMs','applicationRetryCount','providerRetryCountKnown','skillCatalogOmitted','omittedSkillCount','requestedServiceTier','requestedWireServiceTier','cliStderrFirstDiagnosticAt','cliReportedTransportError','cliReportedHttpStatus'])CODEX_TRACE_TELEMETRY.add(key);
for(const key of ['modelToolsEnabled','modelToolManifestSha256','modelToolWireManifestSha256','modelToolFixedTupleProjections','modelToolSchemaDescriptions','modelToolCalls',
  'streamCountersScope','streamTurnBytes','streamTurnEvents','streamLineLimitBytes','streamMaxLineBytes','streamLastChunkBytes','streamMaxChunkBytes',
  'streamLimitKind','streamLimitObserved','streamLimitValue',
  'rejectedRpcMethod','rejectedRpcCode','rejectedRpcCategory','rejectedRpcMessageSha256','rejectedRpcMissingField','rejectedRpcActualType','rejectedRpcExpectedType',
  'verifiedThreadSettings','moderationMetadataReceivedAt','rejectedNotificationField','rejectedNotificationValueType'])CODEX_TRACE_TELEMETRY.add(key);
function sanitizeEvidence(value, secrets = [], depth = 0) {
  if (depth > 32) throw new RunnerError('trace');
  if (typeof value === 'string') {
    let clean = value;
    for (const secret of secrets) if (typeof secret === 'string' && secret) clean = clean.split(secret).join('[redacted-secret]');
    return clean.replace(/https?:\/\/[^\s<>"']+/giu, '[redacted-url]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu, '[redacted-secret]').replace(/((?:battle|game-bestof3)-[a-z0-9-]+-\d+)-[a-z0-9]+pw\b/gu, '$1');
  }
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item, secrets, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key, item]) => !PRIVATE_KEYS.test(key) && item !== undefined).map(([key, item]) => [key, sanitizeEvidence(item, secrets, depth + 1)]));
  requireThat(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value), 'trace');
  return value;
}

async function safeTraceDirectory(workspace, parentId) {
  const root = await realpath(workspace); let directory = root;
  for (const part of ['cache', 'bo3-runs', parentId]) {
    directory = join(directory, part);
    try {await mkdir(directory);} catch (error) {if (error.code !== 'EEXIST') throw error;}
    const stat = await lstat(directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && within(root, await realpath(directory)), 'trace');
  }
  return directory;
}

/** One native-parent-owned bounded trace; failures block the next model decision. */
export function createModelTraceStore({workspace = ROOT, teamId, runId = randomUUID(), secrets = [], maxEntries = 100, maxBytes = MAX_MODEL_TRACE_BYTES} = {}) {
  requireThat(HASH.test(teamId ?? '') && /^[a-f0-9-]{36}$/u.test(runId) && Number.isInteger(maxEntries) && maxEntries >= 1 && maxEntries <= 100 && Number.isInteger(maxBytes) && maxBytes >= 1000 && maxBytes <= MAX_MODEL_TRACE_BYTES, 'trace');
  let pending = Promise.resolve(), failed = false, count = 0, lastPath, lastFailureCode = null, stage = 'validation',lastFailureStage,failureDiagnostic;
  return {
    append(event) {
      const operation = pending.then(async () => {
        if(!failed)stage='validation';
        requireThat(!failed && ['decision','decision-rejected','decision-superseded','decision-failed','controller-failure','ponder-analysis'].includes(event?.phase) && event.binding?.teamId === teamId, 'trace');
        const parentId = canonical(event.binding.parentId);
        requireThat(PARENT.test(parentId), 'trace');
        const binding={teamId,parentId,room:canonical(event.binding.room),rqid:event.binding.rqid,requestDigest:event.binding.requestDigest,requestKey:event.binding.requestKey};
        const externalProvider=event.provider!==undefined,codex=event.provider?.kind==='codex-cli';
        if(externalProvider)requireThat(exactKeys(event.provider,['kind','model','reasoningEffort','selectionEvidence'])&&codex&&
          (typeof event.provider.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(event.provider.model))&&
          (codex?['low','medium','high']:['low','medium']).includes(event.provider.reasoningEffort)&&event.provider.selectionEvidence==='host-declared-request','trace');
        let entry;
        if(event.phase==='ponder-analysis'){
          requireThat(exactKeys(event,['phase','binding','analysis'])&&exactKeys(event.binding,['teamId','parentId']),'trace');
          entry={runId,phase:event.phase,binding:{teamId,parentId},analysis:preparePonderAnalysis(event.analysis,{teamId,parentId,secrets})};
        }else if(event.phase==='controller-failure'){
          const diagnostic=event.diagnostic,source=diagnostic?.source,action=source?.state?.actions?.[0],board=source?.state?.boards?.[0];
          requireThat(!Object.hasOwn(event,'decision')&&!Object.hasOwn(event,'context')&&object(diagnostic)&&diagnostic.version===1&&diagnostic.engineeringOnly===true&&typeof diagnostic.apiAttempted==='boolean'&&
            typeof diagnostic.stage==='string'&&/^[a-z][a-z0-9-]{0,79}$/u.test(diagnostic.stage)&&typeof diagnostic.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(diagnostic.code)&&
            Number.isFinite(diagnostic.capturedAt)&&object(diagnostic.source)&&diagnostic.source.kind==='controller-preparation-source-v1'&&diagnostic.source.engineeringOnly===true,'trace');
          requireThat(source.state?.teamId===teamId&&Array.isArray(source.state.actions)&&source.state.actions.length===1&&object(action)&&object(action.legalActions)&&
            canonical(action.room)===binding.room&&canonical(action.parentId)===parentId&&Number.isSafeInteger(binding.rqid)&&action.rqid===binding.rqid&&
            Array.isArray(source.state.boards)&&source.state.boards.length===1&&object(board)&&canonical(board.room)===binding.room&&
            typeof source.ownTeamText==='string'&&bytes(source.ownTeamText)<=16000&&(source.opponentSheet===null||Array.isArray(source.opponentSheet)&&source.opponentSheet.length<=6)&&object(source.strategicMemory)&&
            HASH.test(binding.requestDigest??'')&&HASH.test(binding.requestKey??''),'trace');
          entry=sanitizeEvidence({runId,phase:'controller-failure',binding,diagnostic},secrets);
          requireThat(bytes(entry.diagnostic)<=256000,'trace');
        }else{
          const completedOnly=['decision-rejected','decision-superseded'].includes(event.phase),failedOnly=event.phase==='decision-failed';
          requireThat(object(event.context)&&typeof event.context.instructions==='string'&&typeof event.context.input==='string'&&object(event.context.schema)&&object(event.telemetry),'trace');
          if(completedOnly){
            const validation=event.validation;
            requireThat(!Object.hasOwn(event,'decision')&&Object.hasOwn(event,'modelOutput')&&object(validation)&&validation.version===1&&validation.engineeringOnly===true&&validation.choiceAuthority===false&&
              typeof validation.stage==='string'&&/^[a-z][a-z0-9-]{0,79}$/u.test(validation.stage)&&typeof validation.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(validation.code)&&
              Number.isFinite(validation.capturedAt)&&typeof validation.message==='string'&&validation.message.length<=512&&bytes(event.modelOutput)<=256000&&
              (event.phase!=='decision-superseded'||validation.stage==='request-freshness'&&validation.code==='REQUEST_CHILD_ENDED'),'trace');
          }else if(failedOnly){
            const validation=event.validation;
            requireThat(!Object.hasOwn(event,'decision')&&!Object.hasOwn(event,'modelOutput')&&object(validation)&&validation.version===1&&validation.engineeringOnly===true&&
              validation.choiceAuthority===false&&(externalProvider?validation.apiAttempted===false&&validation.providerAttempted===true&&['first-provider','rich-provider','single-provider'].includes(validation.stage):
                validation.apiAttempted===true&&['first-api','rich-api','single-api'].includes(validation.stage))&&
              typeof validation.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(validation.code)&&Number.isFinite(validation.capturedAt)&&
              typeof validation.message==='string'&&validation.message.length<=512,'trace');
          }else requireThat(object(event.decision)&&!Object.hasOwn(event,'modelOutput')&&!Object.hasOwn(event,'validation'),'trace');
          const actualInput=JSON.parse(event.context.input);
          let matchupSkill;
          if(Object.hasOwn(actualInput,'matchupSkill')){
            try{matchupSkill=verifyMatchupGuidance(actualInput.matchupSkill,{skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256});}
            catch{throw new RunnerError('trace');}
          }
          const sanitizedInput=sanitizeEvidence(actualInput,secrets);
          const safeHeaders=Object.fromEntries(Object.entries(event.telemetry.allowlistedHeaders??{}).filter(([key,value])=>/^(?:openai-processing-ms|retry-after|x-ratelimit-(?:limit|remaining|reset)-(?:requests|tokens|project-tokens))$/u.test(key)&&typeof value==='string'&&value.length<=512));
          entry=sanitizeEvidence({runId,phase:event.phase,context:{instructions:event.context.instructions,input:JSON.stringify(sanitizedInput),schema:event.context.schema,promptMetadata:event.context.promptMetadata??{}},
            ...(completedOnly?{modelOutput:event.modelOutput,validation:event.validation}:failedOnly?{validation:event.validation}:{decision:event.decision}),
            telemetry:externalProvider?Object.fromEntries(Object.entries(event.telemetry).filter(([key])=>CODEX_TRACE_TELEMETRY.has(key))):
              {...Object.fromEntries(Object.entries(event.telemetry).filter(([key])=>SAFE_TELEMETRY.has(key))),allowlistedHeaders:safeHeaders},binding},secrets);
          // The complete current-pinned skill is trusted source, not private
          // battle text. Restore only this verified canonical bundle after all
          // generic redaction so Markdown URLs and per-file hashes stay exact.
          if(matchupSkill){const savedInput=JSON.parse(entry.context.input);savedInput.matchupSkill=matchupSkill;entry.context.input=JSON.stringify(savedInput);}
        }
        if(externalProvider)entry.provider=structuredClone(event.provider);
        stage = 'directory';
        const directory = await safeTraceDirectory(workspace, parentId), path = join(directory, 'isolated-model-trace.json');
        stage = 'read';
        let document = {schemaVersion: 1, kind: 'isolated-model-trace', teamId, parentId, entries: []};
        try {
          const stat = await lstat(path);
          requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, 'trace');
          document = JSON.parse(await readFile(path, 'utf8'));
          requireThat(document.schemaVersion === 1 && document.kind === 'isolated-model-trace' && document.teamId === teamId && document.parentId === parentId && Array.isArray(document.entries), 'trace');
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
        stage='capacity';
        requireThat(document.entries.length < maxEntries, 'trace');
        document.entries.push(entry);
        const text = JSON.stringify(document);
        requireThat(bytes(text) <= maxBytes, 'trace');
        stage = 'write';
        const temporary = join(directory, `.isolated-${runId}-${randomUUID()}.tmp`);
        try {await writeFile(temporary, text, {flag: 'wx', mode: 0o600}); await rename(temporary, path);}
        finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
        count++; lastPath = relative(resolve(workspace), path).replaceAll('\\', '/');
        return {path: lastPath, sha256: createHash('sha256').update(text).digest('hex'), entries: document.entries.length};
      });
      const settled=operation.catch(async error=>{
        if(!failed){
          failed=true;lastFailureCode=['ENOENT','EACCES','EPERM','ENOSPC','EEXIST'].includes(error?.code)?error.code:'TRACE_VALIDATION';lastFailureStage=stage;
          // Post-loop pondering evidence must never disappear silently after a
          // shape rejection. This separate file is explicitly UNVALIDATED and
          // cannot substitute for the failed trace append or any native receipt.
          const parentId=canonical(event?.binding?.parentId);
          if(event?.phase==='ponder-analysis'&&event.binding?.teamId===teamId&&PARENT.test(parentId??'')){
            try{
              const diagnostic=prepareUnvalidatedPonderDiagnostic(event.analysis,{teamId,parentId,runId,stage:lastFailureStage,code:error?.code,secrets});
              const directory=await safeTraceDirectory(workspace,parentId),tracePath=join(directory,'isolated-model-trace.json');
              try{const info=await lstat(tracePath);requireThat(info.isFile()&&!info.isSymbolicLink()&&info.size<=maxBytes,'trace');const existing=JSON.parse(await readFile(tracePath,'utf8'));requireThat(existing.teamId===teamId&&existing.parentId===parentId,'trace');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
              const path=join(directory,`isolated-ponder-unvalidated-${runId}.json`),text=JSON.stringify(diagnostic);
              await writeFile(path,text,{flag:'wx',mode:0o600});
              failureDiagnostic={preserved:true,validated:false,materialEvidenceVerified:false,choiceAuthority:false,path:relative(resolve(workspace),path).replaceAll('\\','/'),sha256:createHash('sha256').update(text).digest('hex')};
            }catch{failureDiagnostic={preserved:false,validated:false,code:'PONDER_UNVALIDATED_DIAGNOSTIC_FAILED'};}
          }
        }
        throw error;
      });
      pending=settled.catch(()=>{});
      return settled.catch(() => {throw new RunnerError('trace');});
    },
    status: () => ({runId, teamId, appended: count, failed, path: lastPath ?? null, maxEntries, maxBytes, ...(failed ? {lastFailureCode,lastFailureStage,...(failureDiagnostic?{failureDiagnostic:structuredClone(failureDiagnostic)}:{})} : {})}),
  };
}

/** A successful key-presence or models-list check is insufficient for a battle. */
export async function runBattleWorkflow({operator, createController, identity, scope, ownTeamText, apiConfig, decisionProvider, contextMode='session',serviceTier='standard',ponderRuntime,qualifyPonder,verifyPonderQualification=verifyPonderQualificationReceipt,savedModelToolRequests,requireModelToolReceipt=false, resetDecisionContext, onEvidence, onEvent = () => {}, onGuidance = () => {}, now = Date.now, runId = randomUUID(), verifyPolicy = verifyIsolatedPolicySource, qualifyGeneration, qualifyDesktop, qualifyCodex, postResultTimeoutMs = 30000} = {}) {
  validateSessionConfiguration(identity); validateScopeConfiguration(scope, identity);
  requireThat(contextMode==='session'&&(!resetDecisionContext||typeof resetDecisionContext==='function'),'provider_configuration');
  const externalProvider=true,codex=true,decisionMode='model-tools';
  requireThat(apiConfig===undefined&&qualifyGeneration===undefined&&qualifyDesktop===undefined&&exactKeys(decisionProvider,['kind','model','reasoningEffort','callDecision'])&&decisionProvider.kind==='codex-cli'&&CODEX_LIVE_MODELS.has(decisionProvider.model)&&['low','medium','high'].includes(decisionProvider.reasoningEffort)&&typeof decisionProvider.callDecision==='function'&&typeof qualifyCodex==='function','provider_configuration');
  requireThat(scope.allowPonder===true?decisionProvider.model==='gpt-6.1-sol'&&decisionProvider.reasoningEffort==='low'&&serviceTier==='fast'&&typeof ponderRuntime?.prepare==='function'&&typeof ponderRuntime.stop==='function'&&typeof ponderRuntime.drain==='function'&&typeof qualifyPonder==='function'&&typeof verifyPonderQualification==='function':ponderRuntime===undefined,'provider_configuration');
  requireThat(operator && typeof operator.dispatch === 'function' && typeof createController === 'function' && typeof onEvidence === 'function');
  const policySource = verifyPolicy();
  requireThat(policySource?.verified === true && HASH.test(policySource.skillSha256 ?? '') && typeof policySource.skillVersion === 'string', 'skill');
  const qualification=await qualifyCodex({decisionProvider,now,onEvent,teamId:identity.teamId,decisionMode,requests:savedModelToolRequests});
  const qualified=qualification?.qualified===true&&qualification.requestedModel===decisionProvider.model&&qualification.providerKind==='codex-cli'&&qualification.reasoningEffort===decisionProvider.reasoningEffort&&qualification.authenticationMethod==='chatgpt'&&qualification.generationObserved===true&&qualification.savedPositionQualified===true&&qualification.decisionMode==='model-tools'&&qualification.modelToolWorkflowQualified===true&&qualification.modelRequestedMcpQualified===true&&qualification.pairedSimulationQualified===true&&qualification.liveObservedSimulationQualified===true&&qualification.rangeWorkflowQualified===true&&qualification.teamId===identity.teamId&&qualification.contextMode==='session'&&qualification.sessionContinuityQualified===true&&(!requireModelToolReceipt||hasModelToolQualificationReceipt(decisionProvider,qualification));
  requireThat(qualified,'generation_unavailable');
  if(ponderRuntime){
    const proof=await qualifyPonder({decisionProvider,mainQualification:qualification,requests:savedModelToolRequests,onEvent});
    requireThat(proof?.qualified===true&&proof.teamId===identity.teamId&&await verifyPonderQualification(decisionProvider,proof),'generation_unavailable');
  }
  // Offline qualification history must never become a live battle's memory.
  await resetDecisionContext?.();
  let sequence = 0, claimed = false, searched = false, reviewBoundary = false, controller, affectedParentId;
  const preSearchParentIds = new Set();
  // A kept native session retains command-id results across runner processes.
  // Reserve a fresh namespace once per invocation; each individual command's
  // id stays stable if its outcome later needs reconciliation.
  const commandPrefix = `iso-${randomUUID().replaceAll('-', '')}`;
  const id = label => `${commandPrefix}-${label}-${String(++sequence).padStart(3, '0')}`;
  const dispatch = async query => {
    const value = await operator.dispatch({id: id(query.op), ...query});
    const data = body(value);
    requireThat(!value?.error && value?.ok !== false && value?.isError !== true && data?.ok !== false && data?.isError !== true, 'operator');
    return data;
  };
  const call = (name, args = {}, full = false) => dispatch({op: 'call', name, args, ...(full ? {full: true} : {})});
  try {
    let state = await dispatch({op: 'status', full: true});
    verifiedIdentity(state, identity); verifiedIdle(state);
    requireThat(scope.manualReady!==true||state.autoReady===false,'readiness');
    requireThat(Number.isInteger(state.authorizedSets) && Number.isInteger(state.searchesSent) && state.authorizedSets > state.searchesSent, 'allowance');
    requireThat(state.controlPolicy?.halted !== true, 'policy');
    const skill = await call('battle_skill_status');
    requireThat(skill.synchronized === true && skill.sourceSha256 === policySource.skillSha256 && skill.installedSha256===skill.sourceSha256&&Number.isInteger(skill.files)&&skill.files>=1, 'skill');
    const guidanceCommandId=id('skill-read');
    const guidance = await dispatch({id:guidanceCommandId,op:'call',name:'battle_skill_read',args:{},full:true});
    verifyGuidanceDelivery(operator,guidance,{commandId:guidanceCommandId,skill,sourceSha256:policySource.skillSha256,now});
    let matchupGuidance;
    try{matchupGuidance=prepareMatchupGuidance(guidance,{skillVersion:policySource.skillVersion,skillSha256:skill.sourceSha256});}
    catch{throw new RunnerError('skill');}
    await onGuidance(guidance);
    const prior = await call('battle_review_status', {teamId: identity.teamId});
    requireThat(prior.complete === true && Array.isArray(prior.blockers) && prior.blockers.length === 0, 'review');
    let teamGuidance;
    if(codex){
      const reviewGet = prior.required===false ? undefined : await call('battle_review_get', {teamId:identity.teamId,parentId:prior.parentId}, true);
      teamGuidance = prepareTeamGuidance({teamId:identity.teamId,skillSha256:skill.sourceSha256,reviewStatus:prior,reviewGet});
    }
    if(ponderRuntime){const ready=await ponderRuntime.prepare();requireThat(ready?.prepared===true,'provider_configuration');}
    await dispatch({op: 'arm', confirmed: true, expectedSessionId: identity.sessionId, expectedTeamId: identity.teamId, expectedAccount: identity.account});
    await call('battle_control_claim', {confirmed: true, commandId: id('claim'), controllerId: 'isolated-native-runner'}); claimed = true;
    await call('battle_set_control_policy', {...scope.controlPolicy, confirmed: true, commandId: id('policy')});
    state = await dispatch({op: 'status', full: true}); verifiedIdentity(state, identity); verifiedIdle(state);
    requireThat(scope.manualReady!==true||state.autoReady===false,'readiness');
    requireThat(state.controlPolicy?.enabled === true && state.controlPolicy.halted === false, 'policy');
    for (const [key, value] of Object.entries(scope.controlPolicy)) requireThat(state.controlPolicy[key] === value, 'policy');
    const extendedPreview=scope.controlPolicy.previewPlanningMs===60000;
    controller = createController({operator, identity, ownTeamText, decisionProvider, skillVersion: policySource.skillVersion, skillSha256: skill.sourceSha256, matchupGuidance, manualReady:scope.manualReady===true,
      ...(codex?{decisionMode,codexContextMode:contextMode,maxContextBytes:MAX_CONTEXT_BYTES,fastFirst:false,singleCallResearch:false,maxRichContextBytes:MAX_CONTEXT_BYTES,automaticTacticalEvidence:false,teamGuidance,...(ponderRuntime?{background:ponderRuntime}:{})}:{}),
      ...(extendedPreview?{previewClockWaitMs:2000,maxModelMs:60000}:{}),now, onEvidence, onEvent});
    await controller.initialize();
    const preflight = await call('battle_preflight', {teamId: identity.teamId}, true);
    requireThat(preflight.ready === true && Array.isArray(preflight.blockers) && preflight.blockers.length === 0, 'preflight');
    const beforeSearch = await dispatch({op: 'status', full: true});
    verifiedIdentity(beforeSearch, identity); verifiedIdle(beforeSearch);
    requireThat(scope.manualReady!==true||beforeSearch.autoReady===false,'readiness');
    for (const room of beforeSearch.rooms) if (PARENT.test(canonical(room.id))) preSearchParentIds.add(canonical(room.id));
    // Reserving before dispatch prevents any retry from granting another search.
    searched = true;
    await dispatch({op: 'start-next', confirmed: true});
    let result;try{result=await controller.runSet();}finally{await stopPonderBounded(ponderRuntime,onEvent);}
    const observedParentId = canonical(result?.parentId ?? result?.parent?.id);
    if (PARENT.test(observedParentId) && !preSearchParentIds.has(observedParentId)) affectedParentId = observedParentId;
    if (!['review-required', 'post-result-pending'].includes(result?.status) && result?.state !== 'review-required') {
      const failure = new RunnerError(result?.status==='diagnostic-evidence-unavailable'?'trace':result?.status==='controller-unavailable'?'controller_preparation':result?.status==='decision-unavailable'?'generation_failed':['readiness-unavailable','stale-readiness'].includes(result?.status)?'readiness':'operator');
      if(externalProvider){failure.providerKind=decisionProvider.kind;if(failure.code==='generation_failed')failure.message=`The Codex CLI decision handoff failed or missed its original deadline. Retain the same owner and inspect the saved provider failure evidence.`;}
      for (const key of ['providerErrorCode', 'providerErrorType']) if (typeof result?.[key] === 'string' && /^[A-Za-z0-9_.-]{1,100}$/u.test(result[key])) failure[key] = result[key];
      if(typeof result?.stage==='string'&&/^[a-z][a-z0-9-]{0,79}$/u.test(result.stage))failure.controllerStage=result.stage;
      if(typeof result?.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(result.code))failure.controllerErrorCode=result.code;
      if(typeof result?.apiFailureCode==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(result.apiFailureCode))failure.apiFailureCode=result.apiFailureCode;
      if(externalProvider&&typeof result?.providerFailureCode==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(result.providerFailureCode))failure.providerFailureCode=result.providerFailureCode;
      if(typeof result?.diagnosticPreserved==='boolean')failure.diagnosticPreserved=result.diagnosticPreserved;
      if(Number.isFinite(result?.detectedAt))failure.detectedAt=result.detectedAt;
      throw failure;
    }
    const parentId = canonical(result.parentId ?? result.parent?.id);
    requireThat(PARENT.test(parentId), 'operator');
    state = await waitForPostResultQuiescence({dispatch, identity, parentId, now, onEvent, timeoutMs: postResultTimeoutMs});
    verifiedIdle(state);
    const parent = state.rooms.find(room => canonical(room.id) === parentId);
    requireThat(parent?.ended === true && ['win', 'tie'].includes(parent.result?.type), 'operator');
    reviewBoundary = true;
    const preservation = {};
    if (scope.saveReplays) preservation.replays = await call('battle_save_replays', {confirmed: true, commandId: id('replays'), room: parent.id});
    preservation.metrics = await call('team_metrics_sync_battles', {teamId: identity.teamId}, true);
    requireThat(preservation.metrics.teamId === identity.teamId && preservation.metrics.recording?.state === 'ready' && !preservation.metrics.recording?.lastError, 'operator');
    const report = await call('team_metrics_agent_report', {teamId: identity.teamId, includeGames: true, maxEvidence: 5}, true);
    const review = await call('battle_review_status', {teamId: identity.teamId, parentId}, true);
    const timing = await call('battle_timing_report', {teamId: identity.teamId, includeEvents: false}, true);
    await call('battle_control_release', {confirmed: true, commandId: id('release')}); claimed = false;
    return {state: 'review-required', runId, teamId: identity.teamId, parentId, searchesAttempted: 1,
      officialResult: result.officialResult ?? parent.result ?? null,
      replayRequested: scope.saveReplays, nativeReviewComplete: review.complete === true,
      metricsReady: true, reportRead: Boolean(report), timingRead: Boolean(timing),
      clientRetained: true,
      reason: 'The model loop ended after one official BO3. Private decision, batch-pattern, shared-guidance and control-repair checkpoints and bounded retention must finish through native MCP before battle_stop.',
      shutdownDeferred: 'The runner does not manufacture a review or close an unreviewed client.',
    };
  } catch (error) {
    // An idle pre-search failure or official review pause can safely release its
    // lease. A live/uncertain request retains ownership and authored protection.
    if (claimed && (!searched || reviewBoundary)) {
      try {await call('battle_control_release', {confirmed: true, commandId: id('release')});} catch { /* uncertainty remains native evidence */ }
    }
    const failure = error instanceof RunnerError ? error : new RunnerError('operator');
    failure.liveOwnershipRetained = claimed && searched && !reviewBoundary;
    if (!affectedParentId) {
      try {
        const observedParentId = canonical(controller?.status?.()?.parentId);
        if (PARENT.test(observedParentId) && !preSearchParentIds.has(observedParentId)) affectedParentId = observedParentId;
      } catch { /* An unavailable controller supplies no parent binding. */ }
    }
    failure.preSearchParentIds = [...preSearchParentIds];
    if (affectedParentId) failure.affectedParentId = affectedParentId;
    // Keep the original controller's memory and request/reservation ledgers.
    // This handle never crosses stdout or the model boundary.
    if (failure.liveOwnershipRetained && controller) Object.defineProperty(failure, 'recoveryController', {value: controller});
    const pendingRead=controller?.pendingRead?.();
    if(failure.liveOwnershipRetained&&pendingRead instanceof Promise)Object.defineProperty(failure,'pendingOperatorRead',{value:pendingRead});
    throw failure;
  }finally{await stopPonderBounded(ponderRuntime,onEvent);}
}

function attentionParent(state, failure, teamId) {
  const parents = state.rooms.filter(room => PARENT.test(canonical(room.id)));
  const knownBeforeSearch = Array.isArray(failure.preSearchParentIds) && failure.preSearchParentIds.every(id => PARENT.test(id))
    ? new Set(failure.preSearchParentIds) : null;
  const explicit = canonical(failure.affectedParentId);
  let parentId;
  if (PARENT.test(explicit)) {
    requireThat(!knownBeforeSearch?.has(explicit), 'review'); parentId = explicit;
  } else {
    requireThat(knownBeforeSearch !== null, 'review');
    const newlyObserved = [...new Set(parents.map(room => canonical(room.id)).filter(id => !knownBeforeSearch.has(id)))];
    requireThat(newlyObserved.length === 1, 'review'); parentId = newlyObserved[0];
  }
  const matches = parents.filter(room => canonical(room.id) === parentId);
  requireThat(matches.length === 1 && (!matches[0].teamId || matches[0].teamId === teamId), 'review');
  return matches[0];
}

function appliedFinalizationReady(result, teamId, parentId) {
  const cleanup = result?.cleanup, report = result?.stableReport;
  return result?.teamId === teamId && canonical(result.parentId) === parentId && result.dryRun === false &&
    Array.isArray(result.archiveFailures) && result.archiveFailures.length === 0 && Array.isArray(result.replayFailures) && result.replayFailures.length === 0 &&
    cleanup?.teamId === teamId && canonical(cleanup.parentId) === parentId && cleanup.ready === true &&
    Array.isArray(cleanup.blockers) && cleanup.blockers.length === 0 && cleanup.reviewValidation?.complete === true &&
    Array.isArray(cleanup.reviewValidation.blockers) && cleanup.reviewValidation.blockers.length === 0 &&
    Array.isArray(cleanup.removed) && Array.isArray(cleanup.kept) && cleanup.kept.every(entry => typeof entry.path === 'string' && typeof entry.reason === 'string' && entry.reason.trim()) &&
    report?.teamId === teamId && report.archived !== true && typeof report.path === 'string' && report.path && HASH.test(report.revision ?? '');
}

/** Keep the SAME operator and its private lease available after live uncertainty.
 * Input is explicit host-authored maintained-operator JSONL, never model output. */
export function manualContainmentTemplate({identity,scope,parentId,runId}={}) {
  if(scope?.allowManualForfeit!==true || scope.maxSets!==1 || typeof identity?.sessionId!=='string' || !identity.sessionId ||
    !HASH.test(identity.teamId??'') || typeof identity.account!=='string' || !identity.account.trim() ||
    scope.sessionId!==identity.sessionId || scope.teamId!==identity.teamId || scope.account!==identity.account ||
    typeof parentId!=='string' || !PARENT.test(canonical(parentId)) ||
    !/^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*(?:-[a-z0-9]+pw)?$/u.test(parentId) ||
    typeof runId!=='string' || !runId || runId.length>100) return null;
  const id='contain-'+createHash('sha256').update(JSON.stringify([identity.sessionId,identity.teamId,parentId,runId])).digest('hex').slice(0,24);
  return {
    manualOnly:true,
    when:'Only when useful recovery is not viable and the host explicitly chooses the already-authorized whole-parent forfeit. Reconcile uncertain writes; never retry a choice from this template.',
    limits:'No automatic send, readiness, search, changed timer or new permission. The retained operator still checks exact owned-parent authority.',
    command:{id,op:'call',name:'battle_forfeit',args:{confirmed:true,commandId:id,room:parentId}},
  };
}

export async function serveAttentionMode({operator, identity, scope, runId, input = process.stdin, write, failure,
  controller = failure?.recoveryController, now = Date.now, prepareHandoff = prepareRecoveryHandoff, onEvent = () => {}} = {}) {
  const attentionStartedAt = now(), detectedAt = Number.isFinite(failure.detectedAt) && failure.detectedAt >= 0 && failure.detectedAt <= attentionStartedAt ? failure.detectedAt : attentionStartedAt;
  const manualContainment=manualContainmentTemplate({identity,scope,parentId:failure.affectedParentId,runId});
  const event = (type, fields = {}) => {try {onEvent({type, at: now(), ...fields});} catch { /* Timing cannot change control. */ }};
  write({state: 'attention-required', code: failure.code, reason: failure.message, runId, detectedAt, attentionStartedAt, operatorRetained: true,
    ...(manualContainment?{manualContainment}:{}),
    ...(failure.providerErrorCode ? {providerErrorCode: failure.providerErrorCode} : {}), ...(failure.providerErrorType ? {providerErrorType: failure.providerErrorType} : {}),
    ...(failure.controllerStage?{controllerStage:failure.controllerStage}:{}),...(failure.controllerErrorCode?{controllerErrorCode:failure.controllerErrorCode}:{}),
    ...(failure.apiFailureCode?{apiFailureCode:failure.apiFailureCode}:{}),
    ...(failure.providerFailureCode?{providerFailureCode:failure.providerFailureCode}:{}),
    ...(typeof failure.diagnosticPreserved==='boolean'?{diagnosticPreserved:failure.diagnosticPreserved}:{}),
    recovery: 'Keep this same owner. Read the recovery-context on this stream and protect a fresh complete useful pair before reports or forensics; actual model-requested MCP checks remain active. An explicit recover-current command can ask the original isolated controller to decide an untouched fresh request, with continueSet:true to resume this same BO3. Refused, attempted, staged or uncertain requests require reconciliation. With manual readiness, prepare the next plan before confirming its fresh server ready token. No further model decisions, readiness acknowledgements or searches run automatically.'});
  const reader = createInterface({input, terminal: false});
  const arrivalTimes = []; let arrivalOverflow = false;
  reader.on('line', () => {if (arrivalTimes.length < 256) arrivalTimes.push(now()); else arrivalOverflow = true;});
  // Subscribe before awaiting a native read so early host input is not lost.
  const lines = reader[Symbol.asyncIterator]();
  const retainedParents = new Set(); let sequence = 0;
  const recoveryCommands = new Map();
  let pendingHandoffRead = failure.pendingOperatorRead ?? failure.pendingPostResultRead ?? null;
  if (pendingHandoffRead) {
    const retained = pendingHandoffRead;
    void retained.finally(() => {if (pendingHandoffRead === retained) pendingHandoffRead = null;}).catch(() => {});
  }
  const commandPrefix = `iso-attention-${randomUUID().replaceAll('-', '')}`;
  const handoff = async () => {
    // A read timing out at the outer layer is not cancellation of the operator's
    // inner dispatch. Keep its serialization slot until that promise settles.
    const readingOperator = {dispatch(...args) {
      const pending = Promise.resolve().then(() => operator.dispatch(...args));
      pendingHandoffRead = pending;
      void pending.finally(() => {if (pendingHandoffRead === pending) pendingHandoffRead = null;}).catch(() => {});
      return pending;
    }};
    const packet = await prepareHandoff({operator: readingOperator, identity, parentId: failure.affectedParentId, now,
      commandId: `${commandPrefix}-${++sequence}`});
    const handoffDelayMs = Math.max(0, now() - detectedAt);
    write({...packet, runId, detectedAt, handoffDelayMs,
      isolatedRecoveryAvailable: typeof controller?.recoverCurrent === 'function'});
    event('recovery.context-emitted', {binding: packet.binding, detectedAt, handoffDelayMs,
      ...(Number.isFinite(packet.checkedAt) ? {contextCapturedAt: packet.checkedAt} : {})});
  };
  async function drainHandoffRead() {
    if (!pendingHandoffRead) return true;
    let timer;
    try {
      return await Promise.race([pendingHandoffRead.then(() => true, () => true),
        new Promise(resolve => {timer = setTimeout(() => resolve(false), 250);})]);
    } finally {clearTimeout(timer);}
  }
  const call = async (name, args = {}) => {
    const reply = await operator.dispatch({id: `${commandPrefix}-${++sequence}`, op: 'call', name, args, full: true});
    requireThat(!reply?.error && reply?.ok !== false && reply?.isError !== true, 'operator');
    const result = body(reply); requireThat(result?.ok !== false && result?.isError !== true, 'operator'); return result;
  };
  try {
    if (await drainHandoffRead()) await handoff();
    else write({state: 'recovery-context-unavailable', code: 'operator-busy', runId, operatorRetained: true,
      reason: 'A bounded operator read is still in flight. Retain this owner; request recovery-context after its native read settles.'});
    for await (const line of lines) {
      let query;
      const inputProcessedAt = now(), arrivedAt = arrivalTimes.shift();
      const inputTiming = {inputProcessedAt, ...(arrivalOverflow || !Number.isFinite(arrivedAt) ? {inputArrivalUnknown: true} :
        {inputReceivedAt: arrivedAt, inputQueuedMs: Math.max(0, inputProcessedAt - arrivedAt)})};
      try {
        requireThat(bytes(line) <= 100000, 'arguments'); query = JSON.parse(line);
        requireThat(object(query) && /^[A-Za-z0-9_.:-]{1,60}$/u.test(query.id ?? ''), 'arguments');
        // Do not burn a recovery token or dispatch any mutation behind an
        // uncancelled prefetch. A busy refusal does not reserve the command ID.
        if (!await drainHandoffRead()) {
          write({state: 'manual-command-blocked', id: query.id, code: 'operator-busy', reason: 'Recovery context read is still in flight; retain the same owner and command until it settles.', ...inputTiming});
          continue;
        }
        if (query.op === 'recovery-context') {
          requireThat(Object.keys(query).every(key => ['id', 'op'].includes(key)), 'arguments');
          await handoff(); continue;
        }
        if (query.op === 'recover-current') {
          requireThat(Object.keys(query).every(key => ['id', 'op', 'expectedRequest', 'continueSet'].includes(key)) &&
            (query.continueSet === undefined || typeof query.continueSet === 'boolean') && object(query.expectedRequest), 'arguments');
          requireThat(typeof controller?.recoverCurrent === 'function', 'operator');
          if (recoveryCommands.has(query.id)) {
            requireThat(recoveryCommands.get(query.id).query === JSON.stringify(query), 'arguments');
            write({...recoveryCommands.get(query.id).result, cached: true}); continue;
          }
          requireThat(recoveryCommands.size < 1000, 'operator');
          // Reserve before any await. A duplicate command cannot make another call.
          const reservation = {query: JSON.stringify(query), result: {state: 'recovery-result', id: query.id, status: 'uncertain', retry: false}};
          recoveryCommands.set(query.id, reservation);
          write({state: 'recovery-input-received', id: query.id, ...inputTiming, attentionAgeMs: (inputTiming.inputReceivedAt ?? inputProcessedAt) - detectedAt});
          event('recovery.host-input', inputTiming);
          const result = await controller.recoverCurrent({expectedRequest: query.expectedRequest});
          reservation.result = {state: 'recovery-result', id: query.id, ...inputTiming, completedAt: now(), result};
          write(reservation.result);
          if (result?.status === 'submitted' && query.continueSet === true) {
            requireThat(typeof controller.runSet === 'function', 'operator');
            write({state: 'isolated-resumed', id: query.id, parentId: failure.affectedParentId, at: now(), searchesAttempted: 0});
            const resumed = await controller.runSet();
            write({state: 'isolated-resume-result', id: query.id, at: now(), result: resumed,
              reviewRequired: resumed?.status === 'review-required', operatorRetained: true});
          }
          await handoff();
          continue;
        }
        requireThat(!['start-next', 'close', 'arm'].includes(query.op), 'operator');
        if (query.op === 'call') {
          requireThat(query.name !== 'battle_control_release' && query.name !== 'battle_control_claim', 'operator');
          if (query.name === 'battle_forfeit') requireThat(scope.allowManualForfeit === true, 'configuration');
          if (query.name === 'battle_save_replays') requireThat(scope.saveReplays === true, 'configuration');
          if (query.name === 'battle_set_control_policy') for (const [key, value] of Object.entries(scope.controlPolicy)) requireThat(query.args?.[key] === value, 'configuration');
          if (query.name === 'team_metrics_finalize_bo3') {
            const state = await call('battle_status'); verifiedIdentity(state, identity); verifiedIdle(state);
            const parent = attentionParent(state, failure, identity.teamId), parentId = canonical(parent.id);
            requireThat(query.args?.teamId === identity.teamId && canonical(query.args?.parentId) === parentId, 'review');
            if (query.args?.saveReplays === true) requireThat(scope.saveReplays === true, 'configuration');
            retainedParents.delete(parentId);
          }
          if (query.name === 'battle_stop') {
            const state = await call('battle_status'); verifiedIdentity(state, identity); verifiedIdle(state);
            const parent = attentionParent(state, failure, identity.teamId);
            requireThat(parent?.ended === true && ['win', 'tie'].includes(parent.result?.type), 'review');
            const review = await call('battle_review_status', {teamId: identity.teamId, parentId: canonical(parent.id)});
            requireThat(review.complete === true && Array.isArray(review.blockers) && review.blockers.length === 0 && retainedParents.has(canonical(parent.id)), 'review');
            const metrics = await call('team_metrics_sync_battles', {teamId: identity.teamId});
            requireThat(metrics.teamId === identity.teamId && metrics.recording?.state === 'ready' && !metrics.recording.lastError && !state.replayPolicy?.active && !(state.replayPolicy?.pendingParents?.length), 'operator');
          }
        }
        const response = await operator.dispatch(query), result = body(response);
        write({state: 'manual-result', id: query.id, ...inputTiming, completedAt: now(), response});
        if (query.op === 'call' && query.name === 'team_metrics_finalize_bo3' && query.args?.dryRun === false && query.args?.confirmed === true && !response?.error && response?.ok !== false && response?.isError !== true && !result?.error && result?.ok !== false && result?.isError !== true && appliedFinalizationReady(result, identity.teamId, canonical(query.args.parentId))) retainedParents.add(canonical(query.args.parentId));
        if (query.op === 'call' && query.name === 'battle_stop' && result?.stopped === true) return {resolved: true, clientStopped: true};
      } catch (error) {
        write({state: 'manual-command-blocked', id: /^[A-Za-z0-9_.:-]{1,60}$/u.test(query?.id ?? '') ? query.id : null,
          code: error instanceof RunnerError ? error.code : 'operator', reason: error instanceof RunnerError ? error.message : MESSAGES.operator});
      }
    }
  } finally {reader.close();}
  // EOF is not a reviewed resolution. Keep the native SDK/lease in this host.
  write({state: 'attention-input-closed', runId, operatorRetained: true, clientStopped: false,
    reason: 'The host input closed before a verified native stop. Keep this process and use an explicit coordinated native handoff; do not authenticate or start another set.'});
  return {resolved: false};
}

export function recordControllerTiming(recorder, event = {}, teamId, runId) {
  if (!recorder) return;
  const safeName = String(event.type ?? event.name ?? event.phase ?? 'observation').toLowerCase().replace(/[^a-z0-9_.-]/gu, '_').slice(0, 70);
  const binding = event.binding ?? event, telemetry = event.telemetry ?? {};
  recorder.run({teamId, traceId: runId, ...(HASH.test(binding.requestKey ?? '') ? {requestKey: binding.requestKey} : {}), ...(Number.isInteger(binding.rqid) ? {rqid: binding.rqid} : {}), ...(binding.room ? {roomId: canonical(binding.room)} : {})}, () => {
    const recoveryTimes = Object.fromEntries(['inputReceivedAt','inputProcessedAt','inputQueuedMs','detectedAt','contextCapturedAt','handoffDelayMs','readStartedAt','readCompletedAt']
      .filter(key => Number.isFinite(event[key])).map(key => [key, event[key]]));
    recorder.event(`isolated.${safeName}`, {...telemetry, ...(telemetry.providerErrorCode ? {outcome: telemetry.providerErrorCode} : {}), ...(telemetry.providerErrorType ? {phase: telemetry.providerErrorType} : {}), ...(event.stage?{stage:event.stage}:{}),...(event.code?{outcome:event.code}:{}), ...(Number.isFinite(event.at) ? {eventAt: event.at} : {}), ...recoveryTimes, ...(Number.isFinite(event.cutoffAt) ? {cutoffAt: event.cutoffAt} : {}), ...(Number.isInteger(event.promptMetadata?.totalBytes) ? {promptBytes: event.promptMetadata.totalBytes} : {}), ...(event.operation ? {operation: event.operation} : {}), ...(Number.isInteger(event.bytes) ? {bytes: event.bytes} : {}), source: 'isolated_runner'});
  });
}

/** Emit the fault at detection, before workflow unwinding or native handoff reads.
 * Private tokens, source, provider text and controller handles never enter this cue. */
export function controllerAttentionNotice(event = {}, runId) {
  const name=event.type??event.name,firstProviderFailure=name==='decision.provider-failed'&&event.decisionPhase==='first'&&event.providerKind==='codex-cli';
  if (!firstProviderFailure&&!['controller.preparation-failed', 'controller.unavailable', 'controller.diagnostic-failed'].includes(name)) return null;
  return {state: 'controller-attention', runId, detectedAt: event.at,
    ...(typeof event.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(event.code) ? {code: event.code} : {}),
    ...(firstProviderFailure?{stage:'first-provider',providerKind:event.providerKind}:typeof event.stage === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(event.stage) ? {stage: event.stage} : {}),
    ...(typeof event.apiAttempted === 'boolean' ? {apiAttempted: event.apiAttempted} : {}),
    ...(typeof event.providerAttempted === 'boolean' ? {providerAttempted: event.providerAttempted} : {}),
    requires: 'Continue reading this same stream for the fresh recovery-context. Do not detour through reports or health checks.'};
}

const TEST_FILES = ["codex-cli-provider.test.mjs","codex-cli-transport.test.mjs","codex-session-context.test.mjs","codex-session-transport.test.mjs","codex-tool-schema.test.mjs","codex-wire.test.mjs","compact-model-tool-qualification.test.mjs","context-compaction-integration.test.mjs","context-compaction.test.mjs","decision-context.test.mjs","game-summary.test.mjs","launch.test.mjs","matchup-guidance.test.mjs","model-owned-tools.test.mjs","model-tool-cycle.test.mjs","model-tool-observed-qualification.test.mjs","model-tool-qualification.test.mjs","model-tool-validation.test.mjs","native-controller.test.mjs","ponder-controller.test.mjs","ponder-evidence.test.mjs","ponder-qualification.test.mjs","ponder-runner.test.mjs","ponder-runtime.test.mjs","recovery-handoff.test.mjs","recovery-stream.test.mjs","runner.test.mjs","saved-choice-capture.test.mjs","saved-compact-replay.test.mjs","team-guidance.test.mjs"];
export async function runOfflineQualification({workspace = ROOT, spawnImpl = spawn} = {}) {
  const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', ...TEST_FILES.map(name => join(workspace, 'isolated', name))];
  // Do not pass provider credentials to the offline test subprocess.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPENAI_/u.test(key)));
  return new Promise((done, reject) => {
    const child = spawnImpl(process.execPath, args, {cwd: workspace, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', overflow = false;
    const collect = chunk => {if (bytes(output) + chunk.length <= 256000) output += chunk.toString(); else overflow = true;};
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.once('error', () => reject(new RunnerError('offline')));
    child.once('close', code => {
      if (code !== 0 || overflow) {reject(new RunnerError('offline')); return;}
      const tests = Number(output.match(/# tests (\d+)/u)?.[1] ?? 0);
      if (!tests) {reject(new RunnerError('offline')); return;}
      done({state: 'offline-qualified', tests, networkUsed: false, authenticationUsed: false, searchesAttempted: 0});
    });
  });
}

export async function runRunner(args, {workspace = ROOT, write = value => process.stdout.write(JSON.stringify(value) + '\n'), codexProviderFactory,ponderRuntimeFactory,qualifyPonder,verifyPonderQualification=verifyPonderQualificationReceipt, configurationReader = readRunnerConfiguration, offline = runOfflineQualification, connect, timingFactory, controllerFactory, operatorFactory, attentionHandler = serveAttentionMode, qualifyGeneration, qualifyCodex, verifyPolicy} = {}) {
  const options = parseRunnerArgs(args);
  if (options.mode === 'offline') {const result = await offline({workspace}); write(result); return result;}
  const codex=options.provider==='codex-cli';
  let provider;
  if(codex){
    const factory=codexProviderFactory??(await import('./codex-cli-provider.mjs')).createCodexCliDecisionProvider;
    provider=await factory({workspace,model:options.model,reasoningEffort:options.reasoningEffort,contextMode:options.contextMode??'session',...(options.executable?{executable:options.executable}:{}),...(options.serviceTier?{serviceTier:options.serviceTier}:{})});
    requireThat(provider?.decisionProvider?.kind==='codex-cli'&&provider.decisionProvider.model===options.model&&provider.decisionProvider.reasoningEffort===options.reasoningEffort&&typeof provider.preflight==='function','provider_configuration');
    requireThat((provider.contextMode??'session')===(options.contextMode??'session'),'provider_configuration');
  }
  const configured = options.session ? await configurationReader({workspace, sessionFile: options.session, scopeFile: options.scope}) : undefined;
  if(configured?.scope?.allowPonder===true)requireThat(codex&&options.model==='gpt-6.1-sol'&&options.reasoningEffort==='low'&&options.serviceTier==='fast'&&options.contextMode==='session','provider_configuration');
  if(options.mode==='run'&&configured?.scope?.allowPonder===true)requireThat(typeof qualifyPonder==='function'&&typeof verifyPonderQualification==='function','provider_configuration');
  if (options.mode === 'check') {
    const checked=await provider.preflight();
    if(codex)requireThat((checked.contextMode??'session')===(options.contextMode??'session'),'provider_configuration');
    const result = {state: 'configuration-checked', providerKind:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,provider:checked, explicitSessionConfigured: Boolean(configured), oneSetScopeConfigured: configured?.scope.maxSets === 1, networkUsed: false, authenticationUsed: false, searchesAttempted: 0};
    write(result); await provider?.close?.(); return result;
  }
  if(codex){
    requireThat(CODEX_LIVE_MODELS.has(options.model)&&typeof (qualifyCodex??provider.qualifyCodex)==='function'&&qualifyGeneration===undefined,'provider_configuration');
    // Qualification may be injected from a freshly completed offline process.
    // Its report does not initialize this selected provider's opaque login
    // state. Always prepare the actual provider before native SDK/search work.
    let checked;
    try{checked=await provider.preflight();}
    catch(error){
      const failure=new RunnerError('provider_configuration');
      if(typeof error?.code==='string'&&/^[A-Za-z0-9_.-]{1,100}$/u.test(error.code))failure.providerErrorCode=error.code;
      throw failure;
    }
    requireThat((checked.contextMode??'session')===(options.contextMode??'session'),'provider_configuration');
    requireThat(checked?.authMode==='chatgpt','provider_configuration');
  }
  const {identity, scope, ownTeamText} = configured;
  let savedModelToolRequests;
  if(codex&&options.modelToolQualificationFile){
    const document=JSON.parse(await regularWorkspaceFile(workspace,options.modelToolQualificationFile,32*1024*1024));
    requireThat(document?.kind==='saved-model-tool-qualification-requests'&&document.teamId===identity.teamId&&document.skillSha256===ISOLATED_POLICY_SOURCE.skillSha256&&Array.isArray(document.requests),'configuration');
    savedModelToolRequests=document.requests;
  }
  const runId = randomUUID();
  const trace = createModelTraceStore({workspace, teamId: identity.teamId, runId, secrets: []});
  let sdk, timing, operator,ponderRuntime, retainConnection = false;
  const onEvent=event=>{const notice=controllerAttentionNotice(event,runId);if(notice)write(notice);recordControllerTiming(timing?.recorder,event,identity.teamId,runId);};
  try {
    const connection = connect ? await connect({workspace, teamId: identity.teamId}) : await connectNativeSdk({workspace, teamId: identity.teamId});
    sdk = connection.client;
    const [{createOperator}, {createNativeController}, {createTeamTiming}] = await Promise.all([import('../showdown/operator-client.mjs'), import('./native-controller.mjs'), import('../observability/store.mjs')]);
    timing = await (timingFactory ?? createTeamTiming)({workspace, teamId: identity.teamId, component: 'isolated_runner'});
    if(scope.allowPonder===true){const factory=ponderRuntimeFactory??(await import('./ponder-runtime.mjs')).createBattlePonderRuntime;
      ponderRuntime=await factory({workspace,profile:{provider:'codex-cli',model:options.model,reasoningEffort:options.reasoningEffort,contextMode:options.contextMode,serviceTier:options.serviceTier},mainDecisionProvider:provider.decisionProvider,nativeClient:sdk,onEvent});
      requireThat(object(ponderRuntime)&&['prepare','observeState','setMainBusy','setDecisionContext','notesFor','stop','drain','privateEvidence','status'].every(name=>typeof ponderRuntime[name]==='function'),'provider_configuration');}
    operator = (operatorFactory ?? createOperator)({client: sdk, responseFile: 'in-memory-only', maxSearches: 1, readTimeoutMs: 1500, mutationTimeoutMs: 1500,returnAfterModelSend:scope.allowPonder===true,
      publish: async () => ({}), timingRecorder: timing.recorder, onTimingFlush: () => timing.flush(),...(ponderRuntime?{onState:state=>ponderRuntime.observeState(state)}:{})});
    const result = await timing.recorder.run({traceId: runId, teamId: identity.teamId}, () => runBattleWorkflow({operator, createController: controllerFactory ?? createNativeController, identity, scope, ownTeamText, decisionProvider:provider.decisionProvider,contextMode:'session',serviceTier:options.serviceTier??'fast',...(ponderRuntime?{ponderRuntime,qualifyPonder,verifyPonderQualification}:{}),savedModelToolRequests,requireModelToolReceipt:qualifyCodex===undefined,resetDecisionContext:provider.reset,qualifyCodex:qualifyCodex??provider.qualifyCodex, runId,
      ...(qualifyGeneration ? {qualifyGeneration} : {}), ...(verifyPolicy ? {verifyPolicy} : {}),
      onEvidence: event => trace.append(event), onEvent}));
    // The workflow returns only after official completion and verified idle.
    // Error/attention recovery deliberately never waits for optional archival.
    let ponderEvidence;
    if(ponderRuntime){
      try{const status=ponderRuntime.status();
        const receipt=await trace.append({phase:'ponder-analysis',binding:{teamId:identity.teamId,parentId:result.parentId},analysis:{version:1,frozenOnly:true,noCurrentAuthority:true,actualSDKReceiptsNotMinted:true,capturedAt:Date.now(),
          settlement:{runtimeStopped:status.closed===true,shadowModelPending:status.shadowModelPending===true,shadowClosePending:status.shadowClosePending===true,shadowPreflightPending:status.shadowPreflightPending===true,providerCleanupPending:status.core?.cleanupPending>0,nativeCallsPending:status.nativeCallsPending},journal:ponderRuntime.privateEvidence()}});
        ponderEvidence={preserved:true,...receipt};
      }catch{const diagnostic=trace.status().failureDiagnostic;ponderEvidence={preserved:false,code:'PONDER_ARCHIVAL_FAILED',...(diagnostic?{failureDiagnostic:diagnostic}:{})};}
    }
    await timing.flush();
    const summary = {...result,...(ponderEvidence?{ponderEvidence}:{}), modelEvidence: trace.status(), timing: timing.status()};
    write(summary); return summary;
  } catch (error) {
    await stopPonderBounded(ponderRuntime,onEvent);
    if (!error?.liveOwnershipRetained) throw error;
    retainConnection = true;
    const resolution = await timing.recorder.run({traceId: runId, teamId: identity.teamId}, () => attentionHandler({operator, sdk, timing, identity, scope, runId, write, failure: error,
      onEvent: event => recordControllerTiming(timing.recorder, event, identity.teamId, runId)}));
    if (resolution?.resolved === true) retainConnection = false;
    const result = {state: retainConnection ? 'attention-retained' : 'attention-resolved', runId, teamId: identity.teamId, clientStopped: resolution?.clientStopped === true, operatorRetained: retainConnection};
    write(result); return result;
  } finally {
    await stopPonderBounded(ponderRuntime,onEvent);
    if (!retainConnection) {
      try{await provider?.close?.();}
      finally{try{await timing?.close();}finally{await sdk?.close();}}
    }
  }
}

export async function connectNativeSdk({workspace = ROOT, teamId} = {}) {
  const [{Client}, {StdioClientTransport}] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js')]);
  const client = new Client({name: 'vgc-isolated-native-runner', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [join(workspace, 'dist', 'index.js')], cwd: workspace, stderr: 'pipe', env: {VGC_TIMING_TEAM: teamId}});
  transport.stderr?.resume();
  try {await client.connect(transport); return {client};}
  catch {await client.close().catch(() => {}); throw new RunnerError('operator');}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRunner(process.argv.slice(2)).catch(error => {
    const safe = error instanceof RunnerError ? error : new RunnerError('operator');
    process.stderr.write(JSON.stringify({state: 'attention-required', code: safe.code, reason: safe.message, ...(safe.providerErrorCode ? {providerErrorCode: safe.providerErrorCode} : {}), ...(safe.providerErrorType ? {providerErrorType: safe.providerErrorType} : {}), clientStopped: false}) + '\n');
    process.exitCode = 1;
  });
}
