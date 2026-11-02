// Post-loop private evidence only. These records do not mint native SDK,
// current-turn material-check, acceptance or execution receipts.
import {digest} from '../planning/identity.mjs';
import {sanitizeResponse} from '../showdown/operator-response.mjs';

export const PONDER_EVIDENCE_LIMITS=Object.freeze({maxRecords:64,maxBytes:16*1024*1024,maxDepth:32});
export const isPonderErrorCode=value=>Number.isSafeInteger(value)||typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/u.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=0;
const canonical=value=>typeof value==='string'?value.replace(/-[a-z0-9]+pw$/u,''):value;
const parent=value=>/^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u.test(value??'');
const room=value=>/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/u.test(canonical(value)??'');
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const need=value=>{if(!value)throw Object.assign(new Error('Invalid bounded frozen pondering evidence'),{code:'PONDER_EVIDENCE_INVALID'});};
const privateKey=/^(?:apiKey|api_key|authorization|password|passwd|passphrase|credential|credentials|secret|clientSecret|token|accessToken|refreshToken|controllerLease|controlLease|readReceipt|sessionId|freezeId|watchUrl|accessUrl|assertion|cookie|set-cookie)$/iu;

function json(value,depth=0,active=new WeakSet()){
  need(depth<=PONDER_EVIDENCE_LIMITS.maxDepth);
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
  need((Array.isArray(value)||object(value))&&!active.has(value));active.add(value);
  for(const child of Object.values(value))json(child,depth+1,active);
  active.delete(value);
}
function sanitize(value,secrets,depth=0){
  need(depth<=PONDER_EVIDENCE_LIMITS.maxDepth);
  if(typeof value==='string'){
    if(/^\s*[\[{]/u.test(value)){let parsed;try{parsed=JSON.parse(value);}catch{}if(parsed!==undefined)return JSON.stringify(sanitize(parsed,secrets,depth+1));}
    for(const secret of secrets)if(secret)value=value.replaceAll(secret,'[redacted-secret]');
    return value.replace(/https?:\/\/[^\s<>"']+/giu,'[redacted-url]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted-secret]').replace(/((?:battle|game-bestof3)-[a-z0-9-]+-\d+)-[a-z0-9]+pw\b/gu,'$1');
  }
  if(Array.isArray(value))return value.map(item=>sanitize(item,secrets,depth+1));
  if(object(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKey.test(key)).map(([key,item])=>[key,sanitize(item,secrets,depth+1)]));
  return value;
}

/** Validate original digests/binding before redaction; mark stored digests apart. */
export function preparePonderAnalysis(analysis,{teamId,parentId,secrets=[]}={}){
  need(hash(teamId)&&parent(parentId)&&Array.isArray(secrets)&&secrets.every(value=>typeof value==='string'));
  json(analysis);
  need(keys(analysis,['version','frozenOnly','noCurrentAuthority','actualSDKReceiptsNotMinted','capturedAt','settlement','journal'])&&analysis.version===1&&analysis.frozenOnly===true&&analysis.noCurrentAuthority===true&&analysis.actualSDKReceiptsNotMinted===true&&stamp(analysis.capturedAt));
  const settlement=analysis.settlement;
  need(keys(settlement,['runtimeStopped','shadowModelPending','shadowClosePending','shadowPreflightPending','providerCleanupPending','nativeCallsPending'])&&settlement.runtimeStopped===true&&['shadowModelPending','shadowClosePending','shadowPreflightPending','providerCleanupPending'].every(key=>typeof settlement[key]==='boolean')&&stamp(settlement.nativeCallsPending));
  const journal=analysis.journal;
  need(keys(journal,['kind','records','bytes','maxBytes','droppedByBound','complete'])&&journal.kind==='private-frozen-ponder-journal'&&Array.isArray(journal.records)&&journal.records.length<=PONDER_EVIDENCE_LIMITS.maxRecords&&journal.maxBytes===PONDER_EVIDENCE_LIMITS.maxBytes&&stamp(journal.droppedByBound)&&journal.complete===(journal.droppedByBound===0));
  need(journal.bytes===journal.records.reduce((sum,record)=>sum+bytes(record),0)&&journal.bytes<=PONDER_EVIDENCE_LIMITS.maxBytes);
  const redactions=[...secrets];
  for(const record of journal.records){
    need(keys(record,['name','source','frozenSource','sourceSha256','factsSha256','turn','freezeId','analysis','evidenceScope','liveFreshness','choiceAuthority','startedAt','deadlineAt','settledAt','inputSha256','authoredArgumentsSha256','nativeResultSha256','modelResultSha256','timely','outcome','code','authoredArguments','input','nativeResult','modelResult']));
    need(['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_damage_range','calculate_speed','simulate_choices'].includes(record.name)&&record.analysis==='frozen'&&record.evidenceScope==='frozen-pre-submission-only'&&record.liveFreshness===false&&record.choiceAuthority===false);
    const source=record.source,frozen=record.frozenSource;
    need(keys(source,['sessionId','teamId','parentId','gameId','sourceSha256'])&&typeof source.sessionId==='string'&&source.sessionId.length>0&&source.teamId===teamId&&canonical(source.parentId)===parentId&&room(source.gameId)&&hash(source.sourceSha256)&&source.sourceSha256===record.sourceSha256);
    need(keys(frozen,['sessionId','teamId','room','rqid','token'])&&frozen.sessionId===source.sessionId&&frozen.teamId===teamId&&canonical(frozen.room)===canonical(source.gameId)&&Number.isSafeInteger(frozen.rqid)&&frozen.rqid>=0&&typeof frozen.token==='string'&&frozen.token.length>0);
    need(hash(record.factsSha256)&&Number.isInteger(record.turn)&&record.turn>=0&&record.turn<=10000&&typeof record.freezeId==='string'&&/^[a-f0-9-]{36}$/iu.test(record.freezeId));
    need(stamp(record.startedAt)&&stamp(record.deadlineAt)&&stamp(record.settledAt)&&record.startedAt<record.deadlineAt&&record.settledAt>=record.startedAt&&record.settledAt<=analysis.capturedAt&&['returned','returned-error','unavailable'].includes(record.outcome));
    need(object(record.authoredArguments)&&object(record.input)&&hash(record.inputSha256)&&digest(record.input)===record.inputSha256&&hash(record.authoredArgumentsSha256)&&digest(record.authoredArguments)===record.authoredArgumentsSha256);
    need(!['source','analysis','freezeId','evidenceContext','researchContext','token','sessionId','teamId'].some(key=>Object.hasOwn(record.authoredArguments,key)));
    const expected=structuredClone(record.authoredArguments);
    if(record.name==='simulate_choices')Object.assign(expected,{source:structuredClone(frozen),analysis:'frozen',freezeId:record.freezeId,evidenceContext:{teamId,roomId:canonical(frozen.room),turn:record.turn}});
    else {
      need(expected.gen===undefined||expected.gen===0);expected.gen=0;
      // Older archived journals predate the private live-research budget. They
      // remain read-only frozen evidence; new bindings must match exactly.
      if(['calculate_damage','calculate_damage_range','calculate_speed'].includes(record.name)&&Object.hasOwn(record.input,'researchContext'))
        expected.researchContext={source:structuredClone(frozen),analysis:'frozen',freezeId:record.freezeId};
    }
    need(digest(expected)===record.inputSha256);
    for(const [field,digestField] of [['nativeResult','nativeResultSha256'],['modelResult','modelResultSha256']])need(Object.hasOwn(record,field)?hash(record[digestField])&&digest(record[field])===record[digestField]:!Object.hasOwn(record,digestField));
    if(record.outcome!=='unavailable')need(record.timely===true&&record.settledAt<record.deadlineAt&&Object.hasOwn(record,'nativeResult')&&Object.hasOwn(record,'modelResult')&&!Object.hasOwn(record,'code'));
    else need(isPonderErrorCode(record.code));
    redactions.push(source.sessionId,frozen.token,record.freezeId);
  }
  // Parse JSON-encoded MCP text blocks as well as ordinary object fields. The
  // original hashes survive, but never pretend redacted stored bytes are exact.
  const cleaned=sanitize(sanitizeResponse(analysis,{redactValues:redactions}),redactions);
  cleaned.payloadRepresentation='secret-redacted';
  cleaned.hashInterpretation='original hashes bind pre-redaction payloads; stored hashes bind the retained representation';
  cleaned.snapshotMayHaveLaterSettlements=settlement.shadowModelPending||settlement.shadowClosePending||settlement.shadowPreflightPending||settlement.providerCleanupPending||settlement.nativeCallsPending>0;
  cleaned.completeAtCapture=journal.complete&&!cleaned.snapshotMayHaveLaterSettlements;
  for(const record of cleaned.journal.records){record.storedInputSha256=digest(record.input);record.storedAuthoredArgumentsSha256=digest(record.authoredArguments);if(Object.hasOwn(record,'nativeResult'))record.storedNativeResultSha256=digest(record.nativeResult);if(Object.hasOwn(record,'modelResult'))record.storedModelResultSha256=digest(record.modelResult);}
  cleaned.journal.storedBytes=cleaned.journal.records.reduce((sum,record)=>sum+bytes(record),0);
  need(bytes(cleaned)<=PONDER_EVIDENCE_LIMITS.maxBytes+65536);
  return cleaned;
}

/** A failed archive's bounded source is diagnostic only. It passes no journal,
 * source-binding, SDK-receipt or material-evidence validation. */
export function prepareUnvalidatedPonderDiagnostic(analysis,{teamId,parentId,runId,stage,code,secrets=[]}={}){
  need(hash(teamId)&&parent(parentId)&&typeof runId==='string'&&/^[a-f0-9-]{36}$/iu.test(runId)&&
    ['validation','directory','read','capacity','write'].includes(stage)&&Array.isArray(secrets)&&secrets.every(v=>typeof v==='string'));
  const result={version:1,kind:'unvalidated-ponder-archive-diagnostic',teamId,parentId,runId,frozenOnly:true,noCurrentAuthority:true,
    actualSDKReceiptsNotMinted:true,validationPassed:false,materialEvidenceVerified:false,choiceAuthority:false,
    failure:{stage,code:isPonderErrorCode(code)?code:'PONDER_ARCHIVE_FAILED'}};
  try{
    json(analysis);need(bytes(analysis)<=PONDER_EVIDENCE_LIMITS.maxBytes+65536);
    const redactions=[...secrets];
    function collect(value,depth=0){
      need(depth<=PONDER_EVIDENCE_LIMITS.maxDepth);
      if(typeof value==='string'&&/^\s*[\[{]/u.test(value)){let decoded;try{decoded=JSON.parse(value);}catch{}if(decoded!==undefined)collect(decoded,depth+1);}
      else if(Array.isArray(value))for(const item of value)collect(item,depth+1);
      else if(object(value))for(const [key,item]of Object.entries(value)){
        if(privateKey.test(key)){const strings=v=>{if(typeof v==='string'&&v)redactions.push(v);else if(v&&typeof v==='object')for(const child of Object.values(v))strings(child);};strings(item);}
        else collect(item,depth+1);
      }
    }
    collect(analysis);
    const source=sanitize(sanitizeResponse(analysis,{redactValues:redactions}),redactions);
    need(bytes(source)<=PONDER_EVIDENCE_LIMITS.maxBytes+65536);
    result.source=source;result.sourceRepresentation='secret-redacted-unvalidated';result.originalSourceSha256=digest(analysis);result.storedSourceSha256=digest(source);
    need(bytes(result)<=PONDER_EVIDENCE_LIMITS.maxBytes+65536);
  }catch{
    delete result.source;delete result.originalSourceSha256;delete result.storedSourceSha256;
    result.sourceRepresentation='omitted';result.sourceOmittedReason='source-not-bounded-safe-json';
  }
  return result;
}
