// Retained CLI-session presentation only. Native source, legality and execution
// remain owned by the controller; a prepared frame acquires no send authority.
import {createHash} from 'node:crypto';
import {restoreContextPayload} from './context-compaction.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';

const KIND='codex-retained-context-frame';
const VERSION=2;
const SOURCE_BYTES=MAX_CONTEXT_BYTES;
const STATIC_FIELDS=Object.freeze(['ownTeam','opponentSheet','guidance','matchupSkill','teamGuidance']);
const STATIC_SET=new Set(STATIC_FIELDS);
const INSTRUCTION_DELIMITER='\n--- EXACT CURRENT DECISION INSTRUCTIONS ---\n';
const PROTOCOL='Retained-context protocol v2: reconstruct this complete current source from current plus static.values and static.references in the JSON frame. Only ownTeam, opponentSheet, guidance, matchupSkill and teamGuidance may be referenced, only from a successfully committed prior frame in this exact session scope with matching hashes. matchupSkill contains the complete maintained champions-mc-matchups skill; apply its exact retained files and resolve their references within that bundle. Every other current field is authoritative; absent fields stay absent. Never merge old board, actors, legality, resources, effects, order, events, plans, evidence or unreferenced contracts. Prior authored commands are claims, not observed execution. A missing base or reference is unavailable context; do not guess. The current output schema is supplied separately in full. Instructions marked replace supersede earlier decision instructions; references reuse only their exact committed content.';
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const need=(condition,message)=>{if(!condition)fail('CODEX_SESSION_CONTEXT_INVALID',message);};
const set=(value,key,data)=>Object.defineProperty(value,key,{value:data,enumerable:true,writable:true,configurable:true});

function clone(value,budget={nodes:0},depth=0,ancestors=new Set()) {
  need(++budget.nodes<=4*1024*1024+1024&&depth<=64,'Retained context traversal limit exceeded.');
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){need(Number.isFinite(value)&&!Object.is(value,-0),'Non-JSON context number.');return value;}
  need(object(value)||Array.isArray(value),'Context must contain only plain JSON data.');
  need(!ancestors.has(value),'Cyclic context.');ancestors.add(value);
  const array=Array.isArray(value),keys=Reflect.ownKeys(value),result=array?[]:{};
  need(keys.every(key=>typeof key==='string'),'Symbol context key.');
  if(array)need(keys.length===value.length+1&&keys.at(-1)==='length'&&keys.slice(0,-1).every((key,index)=>key===String(index)),'Sparse or extended context array.');
  for(const key of keys){
    if(array&&key==='length')continue;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    need(descriptor?.enumerable&&own(descriptor,'value'),'Context must contain only enumerable data properties.');
    set(result,key,clone(descriptor.value,budget,depth+1,ancestors));
  }
  ancestors.delete(value);return result;
}

function scopeFor(value) {
  need(object(value)&&Object.keys(value).every(key=>['parentId','teamId','sessionId','gameId'].includes(key))&&own(value,'parentId')&&own(value,'teamId'),'Explicit parentId/teamId session scope is required.');
  for(const key of ['parentId','teamId',...(own(value,'sessionId')?['sessionId']:[]),...(own(value,'gameId')?['gameId']:[])])need(typeof value[key]==='string'&&value[key].length>0&&value[key].length<=512,'Invalid session scope identity.');
  return {parentId:value.parentId,teamId:value.teamId,...(own(value,'sessionId')?{sessionId:value.sessionId}:{}),...(own(value,'gameId')?{gameId:value.gameId}:{})};
}
const sameScope=(left,right)=>left?.parentId===right?.parentId&&left?.teamId===right?.teamId&&left?.sessionId===right?.sessionId&&left?.gameId===right?.gameId;
function verifySourceScope(source,scope) {
  for(const record of [source,source.sessionScope])if(object(record))for(const key of ['parentId','teamId',...(own(scope,'sessionId')?['sessionId']:[]),...(own(scope,'gameId')?['gameId']:[])]){
    if(own(record,key))need(record[key]===scope[key],'Current source conflicts with explicit session scope.');
  }
}
function parsedInput(value) {
  let source;
  if(typeof value==='string'){
    need(bytes(value)<=SOURCE_BYTES,'Retained context source exceeds the explicit8MiB preparation bound.');
    try{source=JSON.parse(value);}catch{fail('CODEX_SESSION_CONTEXT_INVALID','Context input is not JSON.');}
  }else source=clone(value);
  need(object(source),'Context source must be an object.');
  return clone(restoreContextPayload(source));
}
function instructionText(mode,instructions,hash,sequence) {
  return mode==='replace'?`${PROTOCOL}\nDecision instructions replace; sha256=${hash}.${INSTRUCTION_DELIMITER}${instructions}`:
    `${PROTOCOL}\nDecision instructions reference; sha256=${hash}; committed sequence=${sequence}.`;
}
function replacedInstructions(text,expectedHash) {
  const prefix=`${PROTOCOL}\nDecision instructions replace; sha256=${expectedHash}.${INSTRUCTION_DELIMITER}`;
  need(typeof text==='string'&&text.startsWith(prefix),'Missing exact replacement instructions.');
  const result=text.slice(prefix.length);need(sha(result)===expectedHash,'Decision instruction hash mismatch.');return result;
}

/** A new manager must be used/reset whenever the underlying CLI thread is lost.
 * prepare is pure with respect to committed state. Commit only after successful
 * validated generation; invalidate on failed/uncertain generation. */
export function createCodexSessionContext() {
  let committed=null,epoch=0;
  function reset(){committed=null;epoch++;}
  function prepare({instructions,input,schema,scope}={}) {
    need(typeof instructions==='string'&&instructions.trim(),'Decision instructions are required.');
    const selectedScope=scopeFor(scope),source=parsedInput(input),selectedSchema=clone(schema);
    need(object(selectedSchema),'Complete current schema is required.');verifySourceScope(source,selectedScope);
    if(committed&&!sameScope(committed.scope,selectedScope))fail('CODEX_SESSION_SCOPE_CHANGED','Reset the retained session before changing scope.');
    const base=committed,preparedEpoch=epoch,sequence=(base?.sequence??0)+1;
    const instructionHash=sha(instructions),instructionRef=base?.instructionsHash===instructionHash;
    const current={},values={},references={},staticValues={};
    for(const [key,value]of Object.entries(source)){
      if(!STATIC_SET.has(key)){set(current,key,clone(value));continue;}
      const valueHash=sha(value),prior=base?.staticValues[key];
      if(prior?.sha256===valueHash)references[key]={sha256:valueHash,sourceSequence:prior.sourceSequence};
      else values[key]={sha256:valueHash,value:clone(value)};
      staticValues[key]={sha256:valueHash,value:clone(value),sourceSequence:prior?.sha256===valueHash?prior.sourceSequence:sequence};
    }
    const removed=STATIC_FIELDS.filter(key=>own(base?.staticValues??{},key)&&!own(source,key));
    const originalInput=typeof input==='string'?input:JSON.stringify(input),sourceHash=sha(source),schemaHash=sha(selectedSchema);
    const frame={kind:KIND,version:VERSION,scope:selectedScope,sequence,
      base:base?{sequence:base.sequence,sourceSha256:base.sourceHash}:null,
      source:{inputSha256:sha(originalInput),decodedSha256:sourceHash,schemaSha256:schemaHash,keys:Object.keys(source)},
      instructions:{mode:instructionRef?'reference':'replace',sha256:instructionHash,sourceSequence:instructionRef?base.instructionsSequence:sequence},
      current,static:{values,references,removed}};
    const deliveredInstructions=instructionText(frame.instructions.mode,instructions,instructionHash,frame.instructions.sourceSequence),deliveredInput=JSON.stringify(frame);
    const fullBytes=bytes(instructions)+bytes(originalInput)+bytes(selectedSchema),deliveredBytes=bytes(deliveredInstructions)+bytes(deliveredInput)+bytes(selectedSchema);
    const metadata={version:VERSION,kind:KIND,scope:{...selectedScope},sequence,baseSequence:base?.sequence??null,
      sourceInputSha256:frame.source.inputSha256,decodedSourceSha256:sourceHash,instructionsSha256:instructionHash,schemaSha256:schemaHash,
      fullBytes,deliveredBytes,savedBytes:fullBytes-deliveredBytes,fullInputBytes:bytes(originalInput),deliveredInputBytes:bytes(deliveredInput),
      savedInputBytes:bytes(originalInput)-bytes(deliveredInput),staticRefs:Object.keys(references),staticSent:Object.keys(values),removedStaticFields:[...removed],
      instructionReference:instructionRef,resumeRequired:base!==null,currentDynamicFieldsPreserved:true};
    let completed=false;
    const candidate={scope:selectedScope,sequence,sourceHash,staticValues,instructions,instructionsHash:instructionHash,
      instructionsSequence:frame.instructions.sourceSequence};
    function commit(){
      if(completed||epoch!==preparedEpoch||committed!==base)fail('CODEX_SESSION_CONTEXT_STALE','Prepared session frame is no longer current.');
      committed=candidate;completed=true;return {...metadata,committed:true};
    }
    function invalidate(){reset();completed=true;}
    return {instructions:deliveredInstructions,input:deliveredInput,schema:selectedSchema,metadata,commit,invalidate};
  }
  return {prepare,reset};
}

/** Private audit/test decoder; retained contains literal prior context and must
 * never be emitted as public telemetry. Reconstructs only this frame's source. */
export function rehydrateCodexSessionContext({instructions,input,schema}={},retained=null) {
  let frame;try{frame=typeof input==='string'?JSON.parse(input):clone(input);}catch{fail('CODEX_SESSION_CONTEXT_INVALID','Invalid retained frame JSON.');}
  need(object(frame)&&frame.kind===KIND&&frame.version===VERSION,'Unsupported retained frame.');
  const scope=scopeFor(frame.scope),selectedSchema=clone(schema);
  need(Number.isSafeInteger(frame.sequence)&&frame.sequence>=1&&object(frame.source)&&object(frame.instructions)&&object(frame.current)&&object(frame.static),'Incomplete retained frame.');
  if(frame.base===null)need(frame.sequence===1&&retained===null,'Initial retained frame must start without an inherited base.');
  else need(retained&&sameScope(scope,retained.scope)&&frame.base.sequence===retained.sequence&&frame.sequence===retained.sequence+1&&frame.base.sourceSha256===retained.sourceHash,'Missing or mismatched retained base.');
  need(sha(selectedSchema)===frame.source.schemaSha256,'Current schema hash mismatch.');
  const staticValues={},restored=clone(frame.current);
  need(!Object.keys(restored).some(key=>STATIC_SET.has(key)),'Static fields must use explicit current values/references.');
  need(object(frame.static.values)&&object(frame.static.references)&&Array.isArray(frame.static.removed),'Incomplete static field manifest.');
  for(const [key,entry]of Object.entries(frame.static.values)){
    need(STATIC_SET.has(key)&&object(entry)&&!own(frame.static.references,key)&&sha(entry.value)===entry.sha256,'Invalid current static value.');
    staticValues[key]={sha256:entry.sha256,value:clone(entry.value),sourceSequence:frame.sequence};set(restored,key,clone(entry.value));
  }
  for(const [key,entry]of Object.entries(frame.static.references)){
    const prior=retained?.staticValues?.[key];
    need(STATIC_SET.has(key)&&object(entry)&&prior&&entry.sha256===prior.sha256&&entry.sourceSequence===prior.sourceSequence&&sha(prior.value)===entry.sha256,'Missing or mismatched committed static reference.');
    staticValues[key]=clone(prior);set(restored,key,clone(prior.value));
  }
  need(frame.static.removed.every(key=>STATIC_SET.has(key)&&!own(staticValues,key)),'Invalid deleted static fields.');
  const expectedRemoved=STATIC_FIELDS.filter(key=>own(retained?.staticValues??{},key)&&!own(staticValues,key));
  need(JSON.stringify(frame.static.removed)===JSON.stringify(expectedRemoved),'Incomplete deleted static fields.');
  need(Array.isArray(frame.source.keys)&&new Set(frame.source.keys).size===frame.source.keys.length&&frame.source.keys.length===Object.keys(restored).length&&frame.source.keys.every(key=>typeof key==='string'&&own(restored,key)),'Current source key manifest mismatch.');
  const ordered={};for(const key of frame.source.keys)set(ordered,key,restored[key]);
  need(sha(ordered)===frame.source.decodedSha256,'Reconstructed current source hash mismatch.');verifySourceScope(ordered,scope);
  let originalInstructions;
  if(frame.instructions.mode==='replace'){
    need(frame.instructions.sourceSequence===frame.sequence,'Invalid replacement instruction sequence.');
    originalInstructions=replacedInstructions(instructions,frame.instructions.sha256);
  }else{
    need(frame.instructions.mode==='reference'&&retained&&frame.instructions.sha256===retained.instructionsHash&&frame.instructions.sourceSequence===retained.instructionsSequence&&instructions===instructionText('reference','',frame.instructions.sha256,frame.instructions.sourceSequence),'Missing or mismatched committed decision instructions.');
    originalInstructions=retained.instructions;
  }
  return {instructions:originalInstructions,input:JSON.stringify(ordered),schema:selectedSchema,
    retained:{scope,sequence:frame.sequence,sourceHash:frame.source.decodedSha256,staticValues,instructions:originalInstructions,
      instructionsHash:frame.instructions.sha256,instructionsSequence:frame.instructions.sourceSequence}};
}
