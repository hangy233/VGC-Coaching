// An owned official CLI app-server process retains one in-memory scoped thread.
// Native battle authority remains outside this process. No API keys or tools.
import {spawn as nodeSpawn} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
import {projectCodexToolDefinition} from './codex-tool-schema.mjs';
import {createCodexCliPreflight, codexCliEnvironment, discoverCodexCliExecutable,
  CODEX_CLI_LIMITS, CODEX_PROMPT_SOURCE_DELIMITER, CodexCliTransportError,
  validateCodexOutputSchema, validateCodexDecision} from './codex-cli-transport.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw new CodexCliTransportError(code);};
const safeInt=value=>Number.isSafeInteger(value)&&value>=0;
// Counts and timings only: never retain event payloads or model text. All
// parsed wire events are observed here, including ignored legacy duplicates;
// these measurements do not prove remote generation or a network round trip.
function recordCliActivity(active,message,at){
  if(!active)return;
  const a=active.telemetry.cliActivity??={schemaVersion:1,scope:'current-turn-parsed-wire',payloadsRetained:false,
    startedAt:active.telemetry.startedAt,events:0,counts:{},buckets:[],overflowEvents:0,maxGapMs:0};
  let category='other';const method=message?.method;
  if(typeof method==='string'){
    if(method==='item/tool/call')category='toolRequest';
    else if(method.startsWith('codex/event/'))category='legacy';
    else if(quietNotifications.has(method))category='quiet';
    else if(method.startsWith('item/reasoning/'))category='reasoning';
    else if(method==='item/agentMessage/delta')category='text';
    else if(method==='item/started')category='itemStarted';
    else if(method==='item/completed')category='itemCompleted';
    else if(method==='turn/completed')category='turnCompleted';
    else if(method==='thread/tokenUsage/updated')category='usage';
    else if(method==='error'||method.startsWith('modelProvider/'))category='providerError';
  }else if(object(message)&&Object.hasOwn(message,'id'))category='rpcResponse';
  a.events++;a.counts[category]=(a.counts[category]??0)+1;a.firstEventAt??=at;
  if(a.lastEventAt!==undefined)a.maxGapMs=Math.max(a.maxGapMs,Math.max(0,at-a.lastEventAt));a.lastEventAt=at;
  if(category!=='legacy'&&category!=='quiet')a.lastNonNoiseParsedAt=at;
  const second=Math.max(0,Math.floor((at-a.startedAt)/1000));
  if(second<64){let b=a.buckets.find(value=>value.second===second);if(!b){b={second,counts:{}};a.buckets.push(b);}b.counts[category]=(b.counts[category]??0)+1;}
  else a.overflowEvents++;
  if(category==='reasoning'||category==='text'){
    const k=category==='reasoning'?'reasoningDeltas':'textDeltas',d=a[k]??={events:0,bytes:0};
    d.events++;d.firstAt??=at;d.lastAt=at;if(typeof message.params?.delta==='string')d.bytes+=bytes(message.params.delta);
  }
  if(category==='providerError'){
    const e=message.params?.error,info=e?.codexErrorInfo;
    const kinds=['ContextWindowExceeded','UsageLimitExceeded','HttpConnectionFailed','ResponseStreamConnectionFailed','ResponseStreamDisconnected','ResponseTooManyFailedAttempts','BadRequest','Unauthorized','SandboxError','InternalServerError','Other'];
    const kind=kinds.find(k=>typeof info==='string'?info.toLowerCase()===k.toLowerCase():object(info)&&Object.keys(info).some(key=>key.toLowerCase()===k.toLowerCase()));
    const nested=kind&&object(info)?Object.entries(info).find(([key])=>key.toLowerCase()===kind.toLowerCase())?.[1]:null;
    const status=nested?.httpStatusCode??e?.httpStatusCode??message.params?.httpStatusCode;
    a.providerError={at,...(kind?{kind}:{}),...(Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{}),
      ...(typeof message.params?.willRetry==='boolean'?{reportedWillRetry:message.params.willRetry}:{})};
  }
}
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);
const toolName=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(value);
const TOOL_LIMITS=Object.freeze({definitions:32,calls:32,argumentsBytes:1024*1024,resultBytes:2*1024*1024,totalResultBytes:MAX_CONTEXT_BYTES,manifestBytes:1024*1024});
const FINALIZATION_RESERVE_MS=15000;
const SESSION_STREAM_BYTES=CODEX_CLI_LIMITS.streamBytes*32,SESSION_EVENTS=CODEX_CLI_LIMITS.events*32;
const exact=(value,keys,required=keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key))&&required.every(key=>Object.hasOwn(value,key));
function toolJson(value,limit){
  let nodes=0;const seen=new Set();
  const visit=(item,depth=0)=>{
    if(++nodes>100000||depth>64)fail('invalid_model_tools');
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'){if(!Number.isFinite(item)||Object.is(item,-0))fail('invalid_model_tools');return item;}
    if(!object(item)&&!Array.isArray(item)||seen.has(item))fail('invalid_model_tools');
    const array=Array.isArray(item),keys=Reflect.ownKeys(item),result=array?[]:{};
    if(!array&&Object.getPrototypeOf(item)!==Object.prototype||keys.some(key=>typeof key!=='string'))fail('invalid_model_tools');
    if(array&&(keys.length!==item.length+1||keys.at(-1)!=='length'||keys.slice(0,-1).some((key,index)=>key!==String(index))))fail('invalid_model_tools');
    seen.add(item);
    for(const key of array?keys.filter(key=>key!=='length'):keys){
      const descriptor=Object.getOwnPropertyDescriptor(item,key);
      if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||['__proto__','constructor','prototype'].includes(key))fail('invalid_model_tools');
      Object.defineProperty(result,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    seen.delete(item);return result;
  };
  const result=visit(value);if(bytes(result)>limit)fail('invalid_model_tools');return result;
}
function modelToolsFor(value){
  if(value===undefined||value===false)return null;
  if(!exact(value,['definitions','call'])||typeof value.call!=='function'||!Array.isArray(value.definitions)||!value.definitions.length||value.definitions.length>TOOL_LIMITS.definitions)fail('invalid_model_tools');
  const definitions=toolJson(value.definitions,TOOL_LIMITS.manifestBytes),names=new Set();
  for(const definition of definitions){
    if(!exact(definition,['name','description','inputSchema'])||!toolName(definition.name)||names.has(definition.name)||typeof definition.description!=='string'||!definition.description.trim()||definition.description.length>96*1024||!object(definition.inputSchema))fail('invalid_model_tools');
    names.add(definition.name);
  }
  definitions.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
  let fixedHomogeneousTuples=0;const schemaDescriptions=[];
  const wireDefinitions=definitions.map(definition=>{
    let projected;try{projected=projectCodexToolDefinition(definition);}catch{fail('invalid_model_tools');}
    fixedHomogeneousTuples+=projected.fixedHomogeneousTuples;
    if(projected.schemaDescriptionIncluded)schemaDescriptions.push(definition.name);
    if(projected.definition.description.length>96*1024)fail('invalid_model_tools');
    return projected.definition;
  });
  toolJson(wireDefinitions,TOOL_LIMITS.manifestBytes);
  return {definitions:wireDefinitions,names,call:value.call,sha256:sha(definitions),wireSha256:sha(wireDefinitions),fixedHomogeneousTuples,schemaDescriptions};
}
function receiptFor(result,requestedName){
  let reference=result.structuredContent?.calculationRef??result.calculationRef;
  if(!reference)for(const item of result.content??[]){
    if(item?.type!=='text'||typeof item.text!=='string'||bytes(item.text)>TOOL_LIMITS.resultBytes)continue;
    try{reference=JSON.parse(item.text)?.calculationRef;}catch{}
    if(reference)break;
  }
  return object(reference)&&reference.tool===requestedName&&/^[a-f0-9]{64}$/u.test(reference.sha256??'')&&/^[a-f0-9-]{36}$/u.test(reference.id??'')
    ? {id:reference.id,sha256:reference.sha256,...(toolName(reference.tool)?{tool:reference.tool}:{})}:null;
}
const allowedItems=new Set(['userMessage','agentMessage','reasoning']);
const quietNotifications=new Set(['thread/status/changed','thread/readState/changed','account/rateLimits/updated',
  'warning','configWarning','deprecationNotice','guardianWarning','windows/worldWritableWarning',
  'windowsSandbox/setupCompleted','skills/changed','app/list/updated','remoteControl/status/changed']);

export function codexSessionScopeHash(scope){
  if(!object(scope)||!id(scope.parentId)||!id(scope.teamId)||scope.sessionId!==undefined&&!id(scope.sessionId)||scope.gameId!==undefined&&!id(scope.gameId)||
    Object.keys(scope).some(key=>!['sessionId','parentId','teamId','gameId'].includes(key)))fail('invalid_request');
  return sha({...scope.sessionId===undefined?{}:{sessionId:scope.sessionId},parentId:scope.parentId,teamId:scope.teamId,...scope.gameId===undefined?{}:{gameId:scope.gameId}});
}

/** Extract connector names only. Unrecognized TOML MCP forms fail closed. */
export function disabledSessionConnectors(text='') {
  if(typeof text!=='string'||bytes(text)>1024*1024)fail('unsafe_session_configuration');
  const names=new Set(),plugins=new Set();let multiline=null;
  for(const raw of text.split(/\r?\n/u)){
    let line=raw.trim();
    if(multiline){if(line.includes(multiline))multiline=null;continue;}
    const triple=/('''|""")/u.exec(line);if(triple&&line.indexOf(triple[1],triple.index+3)<0){multiline=triple[1];line=line.slice(0,triple.index);}
    if(!line||line.startsWith('#'))continue;
    if(/^(?:mcp_servers|plugins|"mcp_servers"|'mcp_servers'|"plugins"|'plugins')\s*(?:=|\.)/u.test(line))fail('unsafe_session_configuration');
    if(!line.startsWith('['))continue;
    const match=/^\[([^\[\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if(!match){if(/mcp_servers|plugins/u.test(line))fail('unsafe_session_configuration');continue;}
    const parts=[];let at=0,body=match[1];
    while(at<body.length){
      const rest=body.slice(at),part=/^\s*([A-Za-z0-9_-]+|'[^']*'|"(?:[^"\\]|\\.)*")\s*(\.|$)/u.exec(rest);
      if(!part){if(/mcp_servers|plugins/u.test(body))fail('unsafe_session_configuration');break;}
      const token=part[1];let value;
      try{value=token[0]==='"'?JSON.parse(token):token[0]==="'"?token.slice(1,-1):token;}catch{fail('unsafe_session_configuration');}
      parts.push(value);at+=part[0].length;
    }
    for(const [table,set]of [['mcp_servers',names],['plugins',plugins]]){
      const position=parts.indexOf(table);if(position<0)continue;
      if(position!==0||!parts[position+1]||/[\r\n\u0000]/u.test(parts[position+1]))fail('unsafe_session_configuration');
      set.add(parts[position+1]);
    }
  }
  if(multiline)fail('unsafe_session_configuration');
  return {mcp:[...names].sort(),plugins:[...plugins].sort()};
}

async function defaultConfiguration(environment){
  const home=environment.CODEX_HOME||join(environment.USERPROFILE||environment.HOME||'', '.codex');
  if(!isAbsolute(home))fail('unsafe_session_configuration');
  try{return await readFile(join(home,'config.toml'),'utf8');}catch(error){if(error.code==='ENOENT')return '';fail('session_configuration_unavailable');}
}
async function terminateOwned(child,spawn,platform){
  if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)return true;
  if(!Number.isSafeInteger(child.pid)||child.pid<=0)return false;
  if(platform==='win32')return await new Promise(resolveDone=>{
    const timer=setTimeout(()=>resolveDone(false),CODEX_CLI_LIMITS.terminationMs);let killer;
    try{killer=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],
      {shell:false,windowsHide:true,stdio:'ignore',env:codexCliEnvironment()});
      killer.once('error',()=>{clearTimeout(timer);resolveDone(false);});killer.once('close',code=>{clearTimeout(timer);resolveDone(code===0);});
    }catch{clearTimeout(timer);resolveDone(false);}
  });
  try{process.kill(-child.pid,'SIGKILL');return true;}catch{return false;}
}

export function createCodexSessionTransport(options={}){
  const {workspace,model,reasoningEffort,artifactDirectory,spawn=nodeSpawn,now=Date.now,environment=process.env,
    platform=process.platform,architecture=process.arch,terminateProcess,serviceTier='standard',
    readConfiguration=defaultConfiguration}=options;
  const executable=options.executable??discoverCodexCliExecutable(workspace,{platform,architecture});
  // This validates configuration and reuses only opaque version/login preflight.
  const auth=createCodexCliPreflight({...options,executable});
  const env=codexCliEnvironment(environment),stop=child=>terminateProcess?terminateProcess(child):terminateOwned(child,spawn,platform);
  const wireServiceTier=serviceTier==='fast'?'priority':'default';
  let approved,busy=false,halted=false,session=null,epoch=0,closing=null;
  const configuration=()=>readConfiguration(environment);

  function invalidate(code,method){
    if(!session)return;
    if(typeof method==='string'&&/^[A-Za-z0-9_/-]{1,120}$/u.test(method)){
      const target=session.active?.telemetry??session.bootTelemetry;
      if(target)target.rejectedNotificationMethod??=method;
    }
    session.invalid=true;
    session.active?.toolAbort?.abort();
    for(const entry of session.pending.values())entry.reject(new CodexCliTransportError(code));session.pending.clear();
    session.active?.reject(new CodexCliTransportError(code));
  }
  async function close(){
    if(closing)return closing;
    const current=session;if(!current)return {closed:true};
    invalidate('session_closed');
    // Controller cancellation and provider failure cleanup can overlap. They
    // must share one owned termination/removal, preserving the original error.
    const pending=(async()=>{
      let terminated=false;
      try{terminated=await stop(current.child);}catch{}
      if(!current.closed){await Promise.race([current.closure,new Promise(resolveWait=>setTimeout(resolveWait,CODEX_CLI_LIMITS.terminationMs))]);}
      if(!current.closed){halted=true;fail('termination_uncertain');}
      if(!terminated&&!current.closed){halted=true;fail('termination_uncertain');}
      // The callback owns real native I/O. An abort request is not proof that
      // it stopped; do not permit another scope while that work is unresolved.
      if(current.toolTasks.size){
        let drained=false,timer;
        try{await Promise.race([Promise.allSettled([...current.toolTasks]).then(()=>{drained=true;}),new Promise(resolveWait=>{timer=setTimeout(resolveWait,CODEX_CLI_LIMITS.terminationMs);})]);}
        finally{clearTimeout(timer);}
        if(!drained){halted=true;fail('tool_cancellation_uncertain');}
      }
      if(current.cwd&&resolve(dirname(current.cwd))===resolve(tmpdir())&&/^vgc-codex-session-/u.test(current.cwd.slice(dirname(current.cwd).length+1))&&
        resolve(await realpath(current.cwd)).toLowerCase()===resolve(current.cwd).toLowerCase())await rm(current.cwd,{recursive:true,force:false});
      session=null;epoch++;return {closed:true};
    })();
    closing=pending;
    try{return await pending;}finally{if(closing===pending)closing=null;}
  }
  function send(method,params,notification=false){
    const current=session;if(!current||current.invalid||current.closed)fail('session_unavailable');
    if(notification){current.child.stdin.write(`${JSON.stringify({method,params})}\n`);return;}
    const requestId=++current.nextId;
    const result=new Promise((resolveReply,rejectReply)=>current.pending.set(requestId,{resolve:resolveReply,reject:rejectReply,method}));
    // Attach immediately: a synchronous mock or disconnect may reject before await.
    result.catch(()=>{});
    current.child.stdin.write(`${JSON.stringify({id:requestId,method,params})}\n`);
    return result;
  }
  function toolItem(current,active,item,completed){
    if(!active.modelTools||!object(item)||!id(item.id)||!active.modelTools.names.has(item.tool)||item.namespace!==undefined&&item.namespace!==null||!Object.hasOwn(item,'arguments')){invalidate('tools_forbidden');return false;}
    let args;try{args=toolJson(item.arguments,TOOL_LIMITS.argumentsBytes);}catch{invalidate('invalid_model_tools');return false;}
    const signature=sha([item.tool,args]),prior=active.toolItems.get(item.id),entry=active.toolCalls.get(item.id);
    if(prior&&prior.signature!==signature||entry&&entry.signature!==signature){invalidate('session_tool_call_mismatch');return false;}
    if(!prior){if(active.toolItems.size>=TOOL_LIMITS.calls){invalidate('session_tool_limit');return false;}active.toolItems.set(item.id,{signature,completed:false});}
    if(completed){
      if(!entry?.response||!['completed','failed'].includes(item.status)||item.success!==undefined&&item.success!==null&&item.success!==entry.response.success||
        item.contentItems!==undefined&&item.contentItems!==null&&sha(item.contentItems)!==sha(entry.response.contentItems)){
        invalidate('session_tool_call_mismatch');return false;
      }
      active.toolItems.get(item.id).completed=true;entry.itemCompleted=true;
      entry.row.itemCompletedAt??=now();
    }else if(item.status!==undefined&&item.status!=='inProgress'){invalidate('session_tool_call_mismatch');return false;}
    return true;
  }
  function toolRequest(current,message){
    const active=current.active,params=message.params;
    if(!active?.modelTools){invalidate('tools_forbidden');return;}
    if(!exact(params,['threadId','turnId','callId','tool','arguments','namespace'],['threadId','turnId','callId','tool','arguments'])||
      !id(params.threadId)||params.threadId!==current.threadId){invalidate('session_thread_mismatch');return;}
    if(!id(params.turnId)||active.turnId&&active.turnId!==params.turnId){invalidate('session_turn_mismatch');return;}
    if(!id(params.callId)||!toolName(params.tool)||!active.modelTools.names.has(params.tool)||params.namespace!==undefined&&params.namespace!==null){invalidate('tools_forbidden');return;}
    if(!(safeInt(message.id)||id(message.id))){invalidate('invalid_stream');return;}
    if(active.toolAbort.signal.aborted||now()>=active.deadlineAt){invalidate('deadline_exceeded');return;}
    active.turnId??=params.turnId;
    let args;try{args=toolJson(params.arguments,TOOL_LIMITS.argumentsBytes);}catch{invalidate('invalid_model_tools');return;}
    const signature=sha([params.tool,args]),rpcKey=`${typeof message.id}:${message.id}`,priorRpc=current.toolRpcIds.get(rpcKey),priorCall=current.toolCallIds.get(params.callId),prior=active.toolCalls.get(params.callId),item=active.toolItems.get(params.callId);
    if(priorRpc&&(priorRpc.callId!==params.callId||priorRpc.turnId!==params.turnId)||priorCall&&(priorCall.turnId!==params.turnId||priorCall.signature!==signature)||prior&&prior.signature!==signature||item&&item.signature!==signature){invalidate('session_tool_call_mismatch');return;}
    if(current.toolRpcIds.size>=4096&&!priorRpc||current.toolCallIds.size>=4096&&!priorCall){invalidate('session_tool_limit');return;}
    current.toolRpcIds.set(rpcKey,{callId:params.callId,turnId:params.turnId});current.toolCallIds.set(params.callId,{turnId:params.turnId,signature});
    const owns=()=>session===current&&!current.invalid&&!current.closed&&current.active===active&&!active.toolAbort.signal.aborted&&now()<active.deadlineAt;
    const reply=(requestId,result)=>{if(!owns())return false;current.child.stdin.write(`${JSON.stringify({id:requestId,result})}\n`);return true;};
    if(prior){
      if(active.telemetry.cliActivity)active.telemetry.cliActivity.duplicateToolRequests=(active.telemetry.cliActivity.duplicateToolRequests??0)+1;
      if(prior.response)reply(message.id,prior.response);
      else prior.waiters.set(rpcKey,message.id);
      return;
    }
    if(active.toolCalls.size>=TOOL_LIMITS.calls){invalidate('session_tool_limit');return;}
    const row={name:params.tool,callIdSha256:sha(params.callId),argumentsSha256:sha(args),origin:'model-requested',requestedAt:now(),outcome:'queued'};
    const entry={signature,waiters:new Map([[rpcKey,message.id]]),response:null,itemCompleted:false,row};
    active.toolCalls.set(params.callId,entry);active.telemetry.modelToolCalls.push(row);
    const task=active.toolTail.then(async()=>{
      if(!owns())return;
      row.dispatchedAt=now();row.outcome='running';
      let result;
      try{result=await active.modelTools.call({name:params.tool,arguments:args,callId:params.callId,signal:active.toolAbort.signal,deadlineAt:active.deadlineAt});}
      catch{result={isError:true,content:[{type:'text',text:'Model-requested native tool callback failed; no result or retry is established.'}]};}
      if(!owns()){row.outcome=active.toolAbort.signal.aborted?'aborted':'unavailable';row.completedAt=now();return;}
      let snapshot;
      try{snapshot=toolJson(result,TOOL_LIMITS.resultBytes);if(!object(snapshot))fail('invalid_model_tools');}
      catch{invalidate('session_tool_result_limit');return;}
      const text=JSON.stringify(snapshot),observedAt=now(),decisionClock={observedAt,modelDeadlineAt:active.deadlineAt,
        remainingMs:Math.max(0,active.deadlineAt-observedAt),finalizationReserveMs:FINALIZATION_RESERVE_MS,
        phase:active.deadlineAt-observedAt<=FINALIZATION_RESERVE_MS?'finalize-now':'research-available',kind:'local-original-model-deadline'},
        timingText=JSON.stringify({decisionClock});
      active.toolResultBytes+=bytes(text)+bytes(timingText);
      if(active.toolResultBytes>TOOL_LIMITS.totalResultBytes){invalidate('session_tool_result_limit');return;}
      // Native item/completed and turn/completed echo these full results as
      // JSON strings. A later compact input must not shrink their framing cap.
      current.framePayloadBytes=Math.max(current.framePayloadBytes,active.toolResultBytes);
      row.completedAt=now();row.durationMs=Math.max(0,row.completedAt-row.dispatchedAt);row.outcome=snapshot.isError===true?'returned-error':'completed';
      row.resultSha256=sha(text);row.resultBytes=bytes(text);row.success=snapshot.isError!==true;
      const receipt=receiptFor(snapshot,params.tool);if(receipt)row.calculationReceipt=receipt;
      // Preserve the native result exactly. The separate local timing snapshot
      // grants no new clock or authority and stays fixed on duplicate RPCs.
      entry.response={success:row.success,contentItems:[{type:'inputText',text},{type:'inputText',text:timingText}]};
      row.decisionClock=decisionClock;row.decisionClockSha256=sha(timingText);
      row.deliveredContentSha256=sha(entry.response.contentItems);row.deliveredContentBytes=bytes(entry.response.contentItems);
      row.returnedToModel=false;
      for(const requestId of entry.waiters.values())if(reply(requestId,entry.response)){row.returnedToModel=true;row.responseSentAt=now();}
      entry.waiters.clear();
    });
    active.toolTail=task.catch(()=>{});current.toolTasks.add(task);
    void task.catch(()=>invalidate('session_tool_failed')).finally(()=>current.toolTasks.delete(task));
  }
  function notify(message){
    const current=session;if(!current||current.invalid)return;
    recordCliActivity(current.active,message,now());
    if(object(message)&&Object.hasOwn(message,'id')){
      if(typeof message.method==='string'){if(message.method==='item/tool/call')toolRequest(current,message);else invalidate('tools_forbidden');return;}
      const entry=current.pending.get(message.id);if(!entry){invalidate('invalid_stream');return;}
      current.pending.delete(message.id);
      if(message.error){
        const target=current.active?.telemetry??current.bootTelemetry,error=message.error,text=typeof error.message==='string'?error.message:'';
        // Keep protocol diagnostics without retaining arbitrary server text,
        // echoed source, paths, configuration or credentials.
        if(target){
          target.rejectedRpcMethod=entry.method;
          if(Number.isSafeInteger(error.code))target.rejectedRpcCode=error.code;
          target.rejectedRpcMessageSha256=sha(text);
          const field=/missing field [`'"]([A-Za-z0-9_]{1,80})[`'"]/u.exec(text);
          if(field)target.rejectedRpcMissingField=field[1];
          const type=/invalid type:\s*(null|unit value|map|sequence|integer|boolean|floating point|unsigned integer|signed integer|string)(?:[^,]*), expected ([A-Za-z0-9_ <>`\[\]-]{1,160})/u.exec(text);
          if(type){target.rejectedRpcActualType=type[1];target.rejectedRpcExpectedType=type[2];}
          target.rejectedRpcCategory=/unknown variant/iu.test(text)?'unknown_variant':field?'missing_field':/unknown field/iu.test(text)?'unknown_field':/invalid type/iu.test(text)?'invalid_type':/schema/iu.test(text)?'schema':/experimental/iu.test(text)?'experimental':/permission|not allowed|forbidden/iu.test(text)?'permission':/invalid param/iu.test(text)?'invalid_params':'other';
        }
        entry.reject(new CodexCliTransportError('session_rpc_failed'));invalidate('session_rpc_failed');
      }
      else if(Object.hasOwn(message,'result'))entry.resolve(message.result);
      else{entry.reject(new CodexCliTransportError('invalid_stream'));invalidate('invalid_stream');}
      return;
    }
    if(!object(message)||typeof message.method!=='string'){invalidate('invalid_stream');return;}
    const {method,params={}}=message;let active=current.active;
    if(method.startsWith('codex/event/'))return; // Legacy duplicates; native events below remain authoritative.
    if(quietNotifications.has(method))return;
    if(method==='account/updated'){
      if(params.authMode!=='chatgpt'){invalidate('auth_required',method);return;}return;
    }
    if(method==='mcpServer/startupStatus/updated'){invalidate('session_connectors_started',method);return;}
    const incomingThread=params.threadId??params.thread?.id;
    if(incomingThread&&current.threadId&&incomingThread!==current.threadId){invalidate('session_thread_mismatch');return;}
    if(method==='thread/settings/updated'){
      const settings=params.threadSettings;
      if(!id(incomingThread)||incomingThread!==current.threadId||!object(settings)){invalidate('invalid_stream',method);return;}
      if(settings.model!==model||settings.modelProvider!=='openai'||settings.effort!==undefined&&settings.effort!==null&&settings.effort!==reasoningEffort){invalidate('model_changed',method);return;}
      if(settings.approvalPolicy!=='never'||settings.sandboxPolicy?.type!=='readOnly'||settings.sandboxPolicy.networkAccess===true){invalidate('session_settings_changed',method);return;}
      if(settings.serviceTier!==undefined&&settings.serviceTier!==null&&
        !(serviceTier==='fast'?['fast','priority']:['standard','default']).includes(settings.serviceTier)){invalidate('session_settings_changed',method);return;}
      const target=current.active?.telemetry??current.bootTelemetry;
      if(target)target.verifiedThreadSettings={model:settings.model,reasoningEffort:settings.effort??null,serviceTier:settings.serviceTier??null};
      return; // Thread metadata has no turnId and is never turn completion.
    }
    if(method==='thread/started'){
      if(!id(params.thread?.id)){invalidate('invalid_stream');return;}
      current.threadId??=params.thread.id;return;
    }
    if(method==='thread/compacted'){if(active)active.telemetry.compactionCount++;invalidate('session_context_compacted');return;}
    if(method==='error'||method==='model/rerouted'||method.startsWith('modelProvider/')){invalidate(method==='model/rerouted'?'model_changed':'generation_failed');return;}
    // Token accounting can arrive immediately after completion. It is never a
    // choice and may update only the exact just-completed turn's measurements.
    if(method==='thread/tokenUsage/updated'&&current.lastFinished&&params.turnId===current.lastFinished.turnId)active=current.lastFinished;
    if(!active){invalidate('unsolicited_turn_event',method);return;}
    if(!id(incomingThread)){invalidate('invalid_stream',method);return;}
    active.telemetry.firstEventAt??=now();
    const incomingTurn=params.turnId??params.turn?.id;
    if(!id(incomingTurn)){
      active.telemetry.rejectedNotificationField='turnId';active.telemetry.rejectedNotificationValueType=typeof incomingTurn;
      invalidate('invalid_stream',method);return;
    }
    if(incomingTurn){
      if(!id(incomingTurn)||active.turnId&&incomingTurn!==active.turnId){invalidate('session_turn_mismatch');return;}
      active.turnId??=incomingTurn;
    }
    if(method==='turn/started')return;
    if(method==='turn/moderationMetadata'){
      // Informational native metadata, already bound to this exact turn.
      // It grants no choice/tool authority; final native status stays required.
      active.telemetry.moderationMetadataReceivedAt??=now();return;
    }
    if(method==='thread/tokenUsage/updated'){
      const usage=params.tokenUsage;if(!object(usage?.last)||!object(usage?.total)){invalidate('invalid_stream');return;}
      active.telemetry.tokenUsageObservedAt=now();
      active.telemetry.tokenUsageTurnCompleteAtObservation=active.telemetry.sessionTurnCompleted===true;
      for(const [field,key]of [['inputTokens','inputTokens'],['outputTokens','outputTokens'],['cachedInputTokens','cachedInputTokens'],['reasoningOutputTokens','reasoningTokens'],['totalTokens','totalTokens']]){
        if(safeInt(usage.last[field]))active.telemetry[key]=usage.last[field];
        if(safeInt(usage.total[field]))active.telemetry[`sessionCumulative${key[0].toUpperCase()}${key.slice(1)}`]=usage.total[field];
      }
      if(safeInt(usage.modelContextWindow))active.telemetry.modelContextWindowTokens=usage.modelContextWindow;
      if(safeInt(usage.last.inputTokens)&&safeInt(usage.last.outputTokens)&&safeInt(usage.modelContextWindow)&&usage.modelContextWindow>0&&
        active.telemetry.sessionTurnIndex>=(current.latestTokenUsage?.turnIndex??0)){
        current.latestTokenUsage={turnIndex:active.telemetry.sessionTurnIndex,inputTokens:usage.last.inputTokens,
          outputTokens:usage.last.outputTokens,modelContextWindowTokens:usage.modelContextWindow,observedAt:now()};
      }
      return;
    }
    if(method==='item/started'||method==='item/completed'){
      const item=params.item;
      if(item?.type==='dynamicToolCall'){toolItem(current,active,item,method==='item/completed');return;}
      if(!object(item)||!allowedItems.has(item.type)){
        if(item?.type==='contextCompaction'){active.telemetry.compactionCount++;invalidate('session_context_compacted');}
        else invalidate('tools_forbidden');return;
      }
      if(method==='item/completed'&&item.type==='agentMessage'&&item.phase!=='commentary'){
        if(typeof item.text!=='string'||bytes(item.text)>CODEX_CLI_LIMITS.outputBytes){invalidate('invalid_output');return;}
        active.finalText=item.text;active.telemetry.firstTextAt??=now();
      }
      return;
    }
    if(method==='item/agentMessage/delta'||method.startsWith('item/reasoning/'))return;
    if(method==='turn/completed'){
      if(!params.turn||params.turn.status!=='completed'||params.turn.error){invalidate('generation_failed');return;}
      // Completion may include final items even when there were no item notifications.
      for(const item of params.turn.items??[]){
        if(item.type==='dynamicToolCall'){if(!toolItem(current,active,item,true))return;continue;}
        if(!allowedItems.has(item.type)){invalidate(item.type==='contextCompaction'?'session_context_compacted':'tools_forbidden');return;}
        if(item.type==='agentMessage'&&item.phase!=='commentary'&&active.finalText===undefined)active.finalText=item.text;
      }
      if(active.modelTools&&([...active.toolCalls.values()].some(entry=>!entry.response||!entry.itemCompleted)||[...active.toolItems.values()].some(item=>!item.completed))){invalidate('session_tool_incomplete');return;}
      active.telemetry.completedAt=now();active.telemetry.sessionTurnCompleted=true;
      active.resolve();return;
    }
    invalidate('unsupported_session_notification',method);
  }
  async function start(scopeHash,telemetry,modelTools){
    const disabled=disabledSessionConnectors(await configuration());
    // CLI -c splits a dotted key path literally; quoted segments are NOT
    // unquoted. A quoted server name would create a different incomplete
    // server and fail before initialize. Refuse ambiguous names, rather than
    // silently leaving an existing connector enabled.
    if([...disabled.mcp,...disabled.plugins].some(name=>!/^[-A-Za-z0-9_@/]+$/u.test(name)))fail('unsupported_session_connector_name');
    const cwd=await mkdtemp(join(tmpdir(),'vgc-codex-session-'));
    let resolveClosed;
    const current={scopeHash,cwd,bootTelemetry:telemetry,pending:new Map(),nextId:0,turnIndex:0,threadId:null,closed:false,invalid:false,
      streamBytes:0,eventCount:0,maxLineBytes:0,maxChunkBytes:0,lastChunkBytes:0,
      framePayloadBytes:Math.max(telemetry.requestBytes??0,telemetry.schemaBytes??0,modelTools?TOOL_LIMITS.argumentsBytes:0),
      historyRequestBytes:0,modelToolsSha256:modelTools?.sha256??null,toolTasks:new Set(),toolRpcIds:new Map(),toolCallIds:new Map(),closure:new Promise(resolveDone=>{resolveClosed=resolveDone;})};
    session=current;
    const settings=['model_provider="openai"','forced_login_method="chatgpt"',`model="${model}"`,`model_reasoning_effort="${reasoningEffort}"`,'model_verbosity="low"',
      'approval_policy="never"','sandbox_mode="read-only"','features.shell_tool=false','features.shell_snapshot=false',
      'apps._default.enabled=false','features.apps=false','features.plugins=false','features.remote_plugin=false',
      'features.plugin_discovery_prefetch=false','features.plugin_sharing=false','features.skill_mcp_dependency_install=false',
      'skills.max_context_tokens=1','project_doc_max_bytes=0','web_search="disabled"',
      'history.persistence="none"','hide_agent_reasoning=true',
      ...disabled.mcp.map(name=>`mcp_servers.${name}.enabled=false`),
      ...disabled.plugins.map(name=>`plugins.${name}.enabled=false`),
      ...(serviceTier==='fast'?['service_tier="fast"','features.fast_mode=true']:[])];
    telemetry.disabledMcpServers=disabled.mcp.length;telemetry.disabledPlugins=disabled.plugins.length;
    const args=['app-server','--listen','stdio://',...settings.flatMap(setting=>['-c',setting])];
    telemetry.spawnStartedAt=now();
    try{current.child=spawn(executable,args,{cwd,env:{...env},shell:false,windowsHide:true,detached:platform!=='win32',stdio:['pipe','pipe','pipe']});}
    catch{current.closed=true;resolveClosed();fail('process_error');}
    telemetry.spawnedAt=now();telemetry.startupMs=telemetry.spawnedAt-telemetry.spawnStartedAt;
    current.child.once('error',()=>{current.closed=true;resolveClosed();invalidate('process_error');});
    current.child.once('close',()=>{current.closed=true;resolveClosed();invalidate('session_process_exited');});
    current.child.stdin.on('error',()=>invalidate('stdin_failed'));
    const decoder=new StringDecoder('utf8');let buffer='';
    // Framing is independent of authored-output and logical-packet limits.
    // Six covers JSON string escaping; the ceiling is unchanged. Retained
    // input deltas never reduce an already admitted input/tool echo allowance.
    const lineLimit=()=>Math.max(CODEX_CLI_LIMITS.lineBytes,Math.min(MAX_CONTEXT_BYTES*6+65536,current.framePayloadBytes*6+65536));
    const streamTelemetry=()=>{
      const active=current.active,target=active?.telemetry??current.bootTelemetry??telemetry;
      Object.assign(target,{streamBytes:current.streamBytes,eventCount:current.eventCount,
        streamCountersScope:'session-lifetime-with-current-turn-deltas',
        streamTurnBytes:current.streamBytes-(active?.streamStartBytes??0),streamTurnEvents:current.eventCount-(active?.streamStartEvents??0),
        streamLineLimitBytes:lineLimit(),streamMaxLineBytes:current.maxLineBytes,
        streamLastChunkBytes:current.lastChunkBytes,streamMaxChunkBytes:current.maxChunkBytes});
      return target;
    };
    const rejectStream=(kind,observed,limit)=>{Object.assign(streamTelemetry(),{streamLimitKind:kind,streamLimitObserved:observed,streamLimitValue:limit});invalidate('stream_limit');};
    current.child.stdout.on('data',chunk=>{
      if(current.invalid)return;
      current.lastChunkBytes=chunk.length;current.maxChunkBytes=Math.max(current.maxChunkBytes,chunk.length);current.streamBytes+=chunk.length;
      streamTelemetry();
      if(current.streamBytes>SESSION_STREAM_BYTES){rejectStream('session-bytes',current.streamBytes,SESSION_STREAM_BYTES);return;}
      buffer+=decoder.write(chunk);
      let end;while((end=buffer.indexOf('\n'))>=0){const rawLine=buffer.slice(0,end),line=rawLine.trim();buffer=buffer.slice(end+1);
        const lineBytes=bytes(rawLine);current.maxLineBytes=Math.max(current.maxLineBytes,lineBytes);
        if(lineBytes>lineLimit()){rejectStream('line-complete',lineBytes,lineLimit());return;}
        if(!line)continue;
        if(++current.eventCount>SESSION_EVENTS){rejectStream('session-events',current.eventCount,SESSION_EVENTS);return;}
        streamTelemetry();
        try{notify(JSON.parse(line));}catch{invalidate('invalid_stream');}
        if(current.invalid)return;
      }
      const pendingBytes=bytes(buffer);current.maxLineBytes=Math.max(current.maxLineBytes,pendingBytes);streamTelemetry();
      if(pendingBytes>lineLimit())rejectStream('line-incomplete',pendingBytes,lineLimit());
    });
    // Retain categories only, never raw stderr, paths, configuration or tokens.
    const stderrDecoder=new StringDecoder('utf8');let stderrBuffer='';
    current.child.stderr.on('data',chunk=>{
      stderrBuffer+=stderrDecoder.write(chunk);
      if(bytes(stderrBuffer)>8192)stderrBuffer=stderrBuffer.slice(-4096);
      let end;while((end=stderrBuffer.indexOf('\n'))>=0){const diagnostic=stderrBuffer.slice(0,end);stderrBuffer=stderrBuffer.slice(end+1);
        const target=current.active?.telemetry??telemetry;
        const category=/invalid transport/iu.test(diagnostic)?'cli_config_invalid_transport':
          /sqlite state runtime|failed to initialize.*state/iu.test(diagnostic)?'cli_profile_state_unavailable':
          /unexpected argument|unrecognized (?:option|subcommand)/iu.test(diagnostic)?'cli_launch_argument':
          /rate.?limit|too many requests/iu.test(diagnostic)?'rate_limit':
          /not logged in|unauthorized|sign in/iu.test(diagnostic)?'auth_required':
          /\bError:/u.test(diagnostic)?'cli_startup_error':null;
        if(category){target.cliDiagnosticCategory??=category;target.cliDiagnosticAt??=now();}
      }
    });
    await send('initialize',{clientInfo:{name:'vgc_battle_session',title:'VGC battle session',version:'1.0.0'},capabilities:{experimentalApi:!!modelTools}});
    send('initialized',{},true);
    const response=await send('thread/start',{model,modelProvider:'openai',cwd,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,
      serviceTier:wireServiceTier,...(modelTools?{dynamicTools:modelTools.definitions.map(definition=>({type:'function',...definition}))}:{}),
      baseInstructions:modelTools?'Use only the supplied battle source and declared native MCP tools. Choose any research yourself and return the requested structured decision.':'Use only the supplied battle source. Return the requested structured decision. Do not use tools.',
      developerInstructions:'Current authoritative source replaces stale battle facts. Prior choices are proposals, not proof of server execution. '+(modelTools?'Only the explicitly declared dynamic native MCP tools are available; no files, web, shell, apps or other agents.':'Use no tools, files, web, shell or other agents.')+' Return only the current turn structured decision.',
      config:{'features.shell_tool':false,'apps._default.enabled':false,'project_doc_max_bytes':0}});
    if(!id(response?.thread?.id)||current.threadId&&response.thread.id!==current.threadId||response.thread.modelProvider&&response.thread.modelProvider!=='openai'||
      response.thread.ephemeral!==true||response.thread.model&&response.thread.model!==model)fail('session_thread_mismatch');
    current.threadId=response.thread.id;
    telemetry.sessionStartedAt=now();
  }
  async function preflight(){
    if(busy||halted)fail(halted?'termination_uncertain':'transport_busy');
    busy=true;approved=undefined;
    try{if(session)await close();
      approved=await auth.preflight();return {...approved,contextMode:'session',requestedWireServiceTier:wireServiceTier,sessionProtocol:'app-server-stdio',retainedSessionQualified:false};
    }finally{busy=false;}
  }
  async function callDecision(request={}){
    const startedAt=now(),telemetry={telemetrySource:'codex-cli-session',contextMode:'session',startedAt,deadlineAt:request.deadlineAt,
      attempts:1,applicationRetryCount:0,providerRetryCountKnown:false,authenticationMethod:'chatgpt',requestedServiceTier:serviceTier,requestedWireServiceTier:wireServiceTier,requestedModelVerbosity:'low',
      cliVersion:approved?.cliVersion,preflightCompletedAt:approved?.preflightCompletedAt,compactionCount:0,sessionTurnCompleted:false,sessionProcessOwned:true};
    if(busy||halted)throw new CodexCliTransportError(halted?'termination_uncertain':'transport_busy',telemetry);
    if(!approved)throw new CodexCliTransportError('preflight_required',telemetry);
    busy=true;let timer,onAbort;
    try{
      const {instructions,input,schema,deadlineAt,signal,sessionScope}=request;
      const modelTools=modelToolsFor(request.modelTools);
      if(request.apiKey||request.model!==undefined&&request.model!==model||request.reasoningEffort!==undefined&&request.reasoningEffort!==reasoningEffort||
        request.serviceTier!==undefined&&request.serviceTier!==serviceTier||typeof instructions!=='string'||!instructions.trim()||!Number.isFinite(deadlineAt)||
        !object(sessionScope))fail('invalid_request');
      validateCodexOutputSchema(schema);
      const source=typeof input==='string'?input:JSON.stringify(input);try{JSON.parse(source);}catch{fail('invalid_request');}
      const prompt=`${instructions}${CODEX_PROMPT_SOURCE_DELIMITER}${source}`;
      if(bytes(prompt)>CODEX_CLI_LIMITS.requestBytes||bytes(schema)>CODEX_CLI_LIMITS.schemaBytes)fail('request_too_large');
      telemetry.requestBytes=bytes(prompt);telemetry.inputBytes=bytes(source);telemetry.schemaBytes=bytes(schema);
      telemetry.sourceSha256=sha(source);telemetry.instructionsSha256=sha(instructions);
      const scopeHash=codexSessionScopeHash(sessionScope);telemetry.sessionScopeSha256=scopeHash;
      if(signal?.aborted)fail('aborted');if(now()>=deadlineAt)fail('deadline_exceeded');
      if(request.requiresRetainedSession!==undefined&&typeof request.requiresRetainedSession!=='boolean')fail('invalid_request');
      if(request.requiresRetainedSession===true&&(!session||session.invalid||session.closed||session.scopeHash!==scopeHash||!session.threadId))fail('session_reference_unavailable');
      if(session?.scopeHash!==scopeHash||session?.invalid)await close();
      if(session&&session.modelToolsSha256!==(modelTools?.sha256??null))fail('session_toolset_changed');
      if(modelTools){telemetry.modelToolsEnabled=true;telemetry.modelToolManifestSha256=modelTools.sha256;
        telemetry.modelToolWireManifestSha256=modelTools.wireSha256;telemetry.modelToolFixedTupleProjections=modelTools.fixedHomogeneousTuples;
        telemetry.modelToolSchemaDescriptions=[...modelTools.schemaDescriptions];telemetry.modelToolCalls=[];}
      let rejectDeadline;
      const expiry=new Promise((resolveUnused,reject)=>{rejectDeadline=reject;});expiry.catch(()=>{});
      const expire=code=>{invalidate(code);rejectDeadline(new CodexCliTransportError(code));};
      timer=setTimeout(()=>expire('deadline_exceeded'),Math.max(1,deadlineAt-now()));
      onAbort=()=>expire('aborted');signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      if(!session)await Promise.race([start(scopeHash,telemetry,modelTools),expiry]);
      if(signal?.aborted)fail('aborted');if(now()>=deadlineAt)fail('deadline_exceeded');
      const current=session;
      current.framePayloadBytes=Math.max(current.framePayloadBytes,telemetry.requestBytes,telemetry.schemaBytes??0,modelTools?TOOL_LIMITS.argumentsBytes:0);
      telemetry.sessionThreadSha256=sha(current.threadId);telemetry.sessionTurnIndex=current.turnIndex+1;
      telemetry.sessionEpoch=epoch;telemetry.sessionReused=current.turnIndex>0;
      telemetry.sessionPriorRequestBytes=current.historyRequestBytes;
      let resolveTurn,rejectTurn;
      const completion=new Promise((resolveDone,rejectDone)=>{resolveTurn=resolveDone;rejectTurn=rejectDone;});completion.catch(()=>{});
      current.active={resolve:resolveTurn,reject:rejectTurn,telemetry,turnId:null,finalText:undefined,deadlineAt,modelTools,
        toolAbort:new AbortController(),toolCalls:new Map(),toolItems:new Map(),toolTail:Promise.resolve(),toolResultBytes:0,
        streamStartBytes:current.streamBytes,streamStartEvents:current.eventCount};
      telemetry.dispatchAt=now();
      const turnResponse=await Promise.race([send('turn/start',{threadId:current.threadId,input:[{type:'text',text:prompt}],cwd:current.cwd,
        approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},model,effort:reasoningEffort,
        serviceTierForTurn:wireServiceTier,summary:'none',outputSchema:schema}),expiry]);
      if(!id(turnResponse?.turn?.id)||current.active.turnId&&current.active.turnId!==turnResponse.turn.id)fail('session_turn_mismatch');
      current.active.turnId=turnResponse.turn.id;
      await Promise.race([completion,expiry]);
      if(current.invalid||session!==current)fail('session_unavailable');
      if(signal?.aborted)fail('aborted');if(now()>=deadlineAt)fail('deadline_exceeded');
      const output=current.active.finalText;
      if(typeof output!=='string'||!output.trim()||bytes(output)>CODEX_CLI_LIMITS.outputBytes)fail('invalid_output');
      let decision;try{decision=JSON.parse(output);}catch{fail('invalid_json');}
      validateCodexDecision(decision,schema);
      if(signal?.aborted)fail('aborted');if(now()>=deadlineAt)fail('deadline_exceeded');
      telemetry.finalReceivedAt=now();telemetry.outputBytes=bytes(output);telemetry.parseCompletedAt=now();
      current.turnIndex++;current.historyRequestBytes+=telemetry.requestBytes;current.lastFinished=current.active;current.active=null;
      telemetry.finishedAt=now();telemetry.requestWallTimeMs=telemetry.finishedAt-startedAt;telemetry.requestDurationMs=telemetry.requestWallTimeMs;
      return {decision,telemetry};
    }catch(error){
      telemetry.finishedAt=now();telemetry.requestWallTimeMs=telemetry.finishedAt-startedAt;telemetry.requestDurationMs=telemetry.requestWallTimeMs;
      const code=error instanceof CodexCliTransportError?error.code:'session_unavailable';
      try{await close();}catch(termination){throw new CodexCliTransportError(termination.code,telemetry);}
      throw new CodexCliTransportError(code,telemetry);
    }finally{
      clearTimeout(timer);if(onAbort)request.signal?.removeEventListener('abort',onAbort);busy=false;
    }
  }
  return {preflight,callDecision,close,reset:close,status:()=>({contextMode:'session',active:!!session&&!session.invalid,
    busy,halted,sessionEpoch:epoch,sessionTurnIndex:session?.turnIndex??0,sessionScopeSha256:session?.scopeHash??null,
    sessionThreadSha256:session?.threadId?sha(session.threadId):null,
    tokenUsageKnown:Boolean(session?.latestTokenUsage),lastInputTokens:session?.latestTokenUsage?.inputTokens??null,
    lastOutputTokens:session?.latestTokenUsage?.outputTokens??null,modelContextWindowTokens:session?.latestTokenUsage?.modelContextWindowTokens??null,
    tokenUsageTurnIndex:session?.latestTokenUsage?.turnIndex??null,tokenUsageObservedAt:session?.latestTokenUsage?.observedAt??null})};
}
