import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createCodexSessionTransport,disabledSessionConnectors} from './codex-session-transport.mjs';

const workspace=resolve('.'),scope={parentId:'game-bestof3-fixture-1',teamId:'team-fixture'};
const schema={type:'object',properties:{choice:{type:'string',enum:['protect','attack']}},required:['choice'],additionalProperties:false};
const line=value=>`${JSON.stringify(value)}\n`;
async function fixture(t,{onTurn,onThread,onResponse,onLaunch,readConfiguration=async()=>'',terminate=true,now=Date.now,serviceTier='fast'}={}){
  await mkdir(join(workspace,'cache'),{recursive:true});const directory=await mkdtemp(join(workspace,'cache','codex-session-test-'));
  const executable=join(directory,'codex.exe');await writeFile(executable,'synthetic');
  const calls=[],children=[];let processes=0;
  const spawn=(path,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=1000+calls.length;
    child.exitCode=null;child.signalCode=null;child.close=code=>{child.exitCode=code;child.emit('close',code);};
    const call={path,args,options,messages:[]};calls.push(call);children.push(child);
    if(args[0]!=='app-server'){
      child.stdin.on('finish',()=>queueMicrotask(()=>{if(args.includes('--version'))child.stdout.write('codex-cli 0.166.0\n');else child.stderr.write('Logged in using ChatGPT');child.close(0);}));
      return child;
    }
    const processId=++processes;let count=0,buffer='',currentTurn;
    const emit=value=>child.stdout.write(line(value));
    child.stdin.on('data',chunk=>{
      buffer+=chunk.toString();let index;
      while((index=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);call.messages.push(value);
        queueMicrotask(async()=>{
          if(value.method==='initialize'){
            emit({method:'remoteControl/status/changed',params:{status:'disabled'}});
            emit({id:value.id,result:{userAgent:'fixture'}});
          }
          else if(value.method==='thread/start'){
            if(onThread){await onThread({call,child,value,emit});return;}
            const thread={id:`thread-${processId}`,modelProvider:'openai',ephemeral:true,model:'gpt-6.1-sol'};
            emit({method:'thread/started',params:{thread}});emit({method:'account/updated',params:{authMode:'chatgpt'}});emit({id:value.id,result:{thread}});
          }else if(value.method==='turn/start'){
            const turnId=`turn-${++count}`,threadId=`thread-${processId}`;
            const finish=({decision={choice:'protect'},status='completed',notify=true}={})=>{
              if(notify)emit({method:'item/completed',params:{threadId,turnId,item:{id:`message-${count}`,type:'agentMessage',phase:'final_answer',text:JSON.stringify(decision)}}});
              emit({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{last:{inputTokens:count*100,outputTokens:8,cachedInputTokens:(count-1)*50,reasoningOutputTokens:3,totalTokens:count*100+8},total:{inputTokens:count*150,outputTokens:count*8,totalTokens:count*158},modelContextWindow:100000}}});
              emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status,items:[]}}});
            };
            emit({id:value.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});emit({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress',items:[]}}});
            currentTurn={call,child,value,count,processId,emit,finish,threadId,turnId};
            if(onTurn)await onTurn(currentTurn);else finish();
          }else if(!value.method&&onResponse)await onResponse({...currentTurn,value});
        });
      }
    });if(onLaunch)queueMicrotask(()=>onLaunch({call,child}));return child;
  };
  const transport=createCodexSessionTransport({workspace,artifactDirectory:join(directory,'artifacts'),executable,model:'gpt-6.1-sol',reasoningEffort:'low',
    serviceTier,spawn,now,readConfiguration,environment:{Path:'fixture',SystemRoot:'C:\\Windows',CODEX_HOME:'opaque',OPENAI_API_KEY:'DO_NOT_PASS',GH_TOKEN:'DO_NOT_PASS',CODEX_THREAD_ID:'DO_NOT_PASS'},
    terminateProcess:async child=>{if(terminate)child.close(0);return terminate;}});
  t.after(async()=>{try{await transport.close();}catch{}await rm(directory,{recursive:true,force:true});});
  return {transport,calls,children,request:extra=>({sessionScope:scope,instructions:'Use only the authoritative current source.',input:JSON.stringify({board:'fresh',legal:['protect','attack']}),schema,deadlineAt:now()+2000,...extra})};
}

test('connector config reads names only, handles quoted keys and rejects unsupported MCP forms',()=>{
  assert.deepEqual(disabledSessionConnectors('[mcp_servers.local]\ncommand="secret"\n[mcp_servers."other.name".env]\nKEY="secret"\n[plugins."plugin@name"]\nenabled=true'),{mcp:['local','other.name'],plugins:['plugin@name']});
  assert.throws(()=>disabledSessionConnectors('mcp_servers = { remote = { command="x" } }'),{code:'unsafe_session_configuration'});
  assert.throws(()=>disabledSessionConnectors('[mcp_servers]\nremote={}'),{code:'unsafe_session_configuration'});
  assert.throws(()=>disabledSessionConnectors('[profiles.other.mcp_servers.local]\ncommand="x"'),{code:'unsafe_session_configuration'});
  assert.deepEqual(disabledSessionConnectors('note = """\n[mcp_servers.fake]\n"""\n[mcp_servers.real]\ncommand="x"'),{mcp:['real'],plugins:[]});
});

test('two decisions retain one owned CLI process and exact thread with fresh schemas, timing and token usage',async t=>{
  const f=await fixture(t,{readConfiguration:async()=>'[mcp_servers."private-local"]\ncommand="hidden"'});
  await assert.rejects(f.transport.callDecision(f.request()),{code:'preflight_required'});
  const preflight=await f.transport.preflight();assert.equal(preflight.contextMode,'session');assert.equal(preflight.authMode,'chatgpt');
  const first=await f.transport.callDecision(f.request()),second=await f.transport.callDecision(f.request({input:JSON.stringify({board:'turn2',legal:['attack']})}));
  const calls=f.calls.filter(call=>call.args[0]==='app-server');assert.equal(calls.length,1);
  const starts=calls[0].messages.filter(message=>message.method==='thread/start'),turns=calls[0].messages.filter(message=>message.method==='turn/start');
  assert.equal(starts.length,1);assert.equal(turns.length,2);assert.equal(starts[0].params.ephemeral,true);
  assert.deepEqual(turns.map(turn=>turn.params.threadId),['thread-1','thread-1']);assert.deepEqual(turns[1].params.outputSchema,schema);
  assert.equal(turns[1].params.effort,'low');assert.equal(turns[1].params.serviceTierForTurn,'priority');
  assert.equal(starts[0].params.serviceTier,'priority');
  assert.ok(calls[0].args.includes('service_tier="fast"'));
  assert.equal(preflight.requestedWireServiceTier,'priority');
  assert.equal(first.telemetry.requestedServiceTier,'fast');assert.equal(first.telemetry.requestedWireServiceTier,'priority');
  assert.ok(turns[1].params.input[0].text.includes('turn2'));assert.ok(calls[0].args.includes('mcp_servers.private-local.enabled=false'));
  assert.ok(calls[0].args.includes('forced_login_method="chatgpt"'));assert.ok(calls[0].args.includes('features.shell_tool=false'));
  assert.ok(calls[0].args.includes('features.plugins=false'));assert.ok(calls[0].args.includes('features.remote_plugin=false'));
  assert.deepEqual(calls[0].options.env,{Path:'fixture',SystemRoot:'C:\\Windows',CODEX_HOME:'opaque'});
  assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.shell,false);
  assert.equal(first.telemetry.sessionTurnIndex,1);assert.equal(second.telemetry.sessionTurnIndex,2);
  assert.equal(second.telemetry.sessionThreadSha256,first.telemetry.sessionThreadSha256);
  assert.equal(second.telemetry.inputTokens,200);assert.equal(second.telemetry.cachedInputTokens,50);assert.equal(second.telemetry.sessionCumulativeInputTokens,300);
  assert.equal(second.telemetry.sessionTurnCompleted,true);assert.equal(second.telemetry.sessionReused,true);assert.equal(second.telemetry.providerRetryCountKnown,false);
  assert.equal(f.transport.status().tokenUsageKnown,true);assert.equal(f.transport.status().lastInputTokens,200);
  assert.equal(f.transport.status().lastOutputTokens,8);assert.equal(f.transport.status().modelContextWindowTokens,100000);
  assert.equal(second.telemetry.sessionPriorRequestBytes,first.telemetry.requestBytes);
  assert.deepEqual(second.decision,{choice:'protect'});assert.equal(f.transport.status().sessionTurnIndex,2);
  await f.transport.close();assert.equal(f.transport.status().active,false);
});

test('setup RPC refusal preserves safe type diagnostics without raw server text or starting a turn',async t=>{
  const f=await fixture(t,{onThread:({value,emit})=>emit({id:value.id,error:{code:-32600,
    message:'Invalid request: invalid type: map, expected a string; PRIVATE_SOURCE C:\\secret OPENAI_API_KEY=PRIVATE_KEY'}})});
  await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request()),error=>{
    assert.equal(error.code,'session_rpc_failed');
    assert.equal(error.telemetry.rejectedRpcMethod,'thread/start');
    assert.equal(error.telemetry.rejectedRpcCode,-32600);
    assert.equal(error.telemetry.rejectedRpcCategory,'invalid_type');
    assert.equal(error.telemetry.rejectedRpcActualType,'map');
    assert.equal(error.telemetry.rejectedRpcExpectedType,'a string');
    assert.match(error.telemetry.rejectedRpcMessageSha256,/^[a-f0-9]{64}$/u);
    assert(!JSON.stringify(error).includes('PRIVATE'));assert(!JSON.stringify(error).includes('secret'));
    return true;
  });
  assert.equal(f.calls.flatMap(call=>call.messages).filter(message=>message.method==='turn/start').length,0);
});

test('native thread settings metadata needs no turnId and cannot silently change model or permissions',async t=>{
  for(const variant of ['normal','model','effort','sandbox','thread']){
    const f=await fixture(t,{onTurn:state=>{
      state.emit({method:'thread/settings/updated',params:{threadId:variant==='thread'?'foreign-thread':state.threadId,
        threadSettings:{model:variant==='model'?'another-model':'gpt-6.1-sol',modelProvider:'openai',effort:variant==='effort'?'high':'low',
          serviceTier:'fast',approvalPolicy:'never',sandboxPolicy:{type:variant==='sandbox'?'dangerFullAccess':'readOnly',networkAccess:false}}}});
      if(variant==='normal')state.finish();
    }});
    await f.transport.preflight();
    if(variant==='normal'){
      const result=await f.transport.callDecision(f.request());assert.equal(result.telemetry.sessionTurnCompleted,true);
      assert.deepEqual(result.telemetry.verifiedThreadSettings,{model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast'});
    }else await assert.rejects(f.transport.callDecision(f.request()),{code:variant==='thread'?'session_thread_mismatch':variant==='sandbox'?'session_settings_changed':'model_changed'});
  }
});

test('moderation metadata is informational only for the exact current native turn',async t=>{
  for(const variant of ['normal','thread','turn','absent']){
    const f=await fixture(t,{onTurn:state=>{
      state.emit({method:'turn/moderationMetadata',params:{threadId:variant==='thread'?'foreign-thread':state.threadId,
        ...(variant==='absent'?{}:{turnId:variant==='turn'?'foreign-turn':state.turnId}),metadata:{private:'PRIVATE_TEXT'}}});
      if(variant==='normal')state.finish();
    }});
    await f.transport.preflight();
    if(variant==='normal'){
      const result=await f.transport.callDecision(f.request());assert(result.telemetry.moderationMetadataReceivedAt>0);
      assert.equal(result.telemetry.sessionTurnCompleted,true);assert(!JSON.stringify(result.telemetry).includes('PRIVATE_TEXT'));
    }else await assert.rejects(f.transport.callDecision(f.request()),{code:variant==='thread'?'session_thread_mismatch':variant==='turn'?'session_turn_mismatch':'invalid_stream'});
  }
});

test('standard service retains default wire requests without a Fast configuration',async t=>{
  const f=await fixture(t,{serviceTier:'standard'}),auth=await f.transport.preflight();
  const result=await f.transport.callDecision(f.request()),call=f.calls.find(row=>row.args[0]==='app-server');
  assert.equal(auth.requestedServiceTier,'standard');assert.equal(auth.requestedWireServiceTier,'default');
  assert.equal(result.telemetry.requestedServiceTier,'standard');assert.equal(result.telemetry.requestedWireServiceTier,'default');
  assert.equal(call.messages.find(row=>row.method==='thread/start').params.serviceTier,'default');
  assert.equal(call.messages.find(row=>row.method==='turn/start').params.serviceTierForTurn,'default');
  assert.ok(!call.args.includes('service_tier="fast"'));
});

test('different BO3 closes the old child and starts a fresh thread before input',async t=>{
  const f=await fixture(t);await f.transport.preflight();
  const first=await f.transport.callDecision(f.request()),second=await f.transport.callDecision(f.request({sessionScope:{...scope,parentId:'game-bestof3-fixture-2'}}));
  assert.equal(first.telemetry.sessionTurnIndex,1);assert.equal(second.telemetry.sessionTurnIndex,1);
  assert.notEqual(first.telemetry.sessionThreadSha256,second.telemetry.sessionThreadSha256);
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,2);assert.equal(f.children[2].exitCode,0);
});

test('tool requests are refused, invalidate retained context and perform no automatic retry',async t=>{
  const f=await fixture(t,{onTurn:({emit,threadId,turnId})=>emit({method:'item/started',params:{threadId,turnId,item:{type:'commandExecution',id:'bad'}}})});
  await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),{code:'tools_forbidden'});
  assert.equal(f.transport.status().active,false);assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,1);
});

test('a server approval request is refused without answering it',async t=>{
  const f=await fixture(t,{onTurn:({emit})=>emit({id:99,method:'item/commandExecution/requestApproval',params:{command:'private'}})});
  await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),{code:'tools_forbidden'});
  assert.ok(!f.calls.at(-1).messages.some(message=>message.id===99));
});

test('foreign thread and stale turn events cannot satisfy the current turn',async t=>{
  for(const foreign of ['thread','turn']){
    const f=await fixture(t,{onTurn:({emit,threadId,turnId})=>emit({method:'turn/completed',params:{threadId:foreign==='thread'?'foreign':threadId,turn:{id:foreign==='turn'?'old-turn':turnId,status:'completed',items:[]}}})});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),{code:foreign==='thread'?'session_thread_mismatch':'session_turn_mismatch'});
  }
});

test('schema mismatch and failed completion invalidate the process',async t=>{
  for(const failure of ['schema','failed']){
    const f=await fixture(t,{onTurn:({finish})=>finish(failure==='schema'?{decision:{choice:'illegal'}}:{status:'failed'})});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),{code:failure==='schema'?'schema_mismatch':'generation_failed'});assert.equal(f.transport.status().active,false);
  }
});

test('context compaction is measured and refuses unverified retained static references',async t=>{
  const f=await fixture(t,{onTurn:({emit,threadId})=>emit({method:'thread/compacted',params:{threadId}})});await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request()),error=>error.code==='session_context_compacted'&&error.telemetry.compactionCount===1);
  assert.equal(f.transport.status().active,false);
});

test('original deadline and caller cancellation terminate the owned child without late result',async t=>{
  for(const mode of ['deadline','abort']){
    const controller=new AbortController();const f=await fixture(t,{onTurn:mode==='abort'?()=>controller.abort():()=>{}});await f.transport.preflight();
    await assert.rejects(f.transport.callDecision(f.request({deadlineAt:Date.now()+60,signal:controller.signal})),{code:mode==='abort'?'aborted':'deadline_exceeded'});
    assert.equal(f.transport.status().active,false);assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,1);
  }
});

test('overlapping session closes share one cleanup and leave a fresh session usable',async t=>{
  const f=await fixture(t);await f.transport.preflight();await f.transport.callDecision(f.request());
  const epoch=f.transport.status().sessionEpoch;
  const closed=await Promise.all([f.transport.close(),f.transport.close(),f.transport.close()]);
  assert.deepEqual(closed,[{closed:true},{closed:true},{closed:true}]);
  assert.equal(f.transport.status().sessionEpoch,epoch+1);
  assert.equal(f.transport.status().active,false);
  const next=await f.transport.callDecision(f.request());
  assert.equal(next.telemetry.sessionTurnIndex,1);
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,2);
});

test('caller abort and outer close preserve the transport failure without duplicate directory removal',async t=>{
  let started;const ready=new Promise(resolveReady=>{started=resolveReady;});
  const controller=new AbortController(),f=await fixture(t,{onTurn:()=>started()});await f.transport.preflight();
  const pending=f.transport.callDecision(f.request({signal:controller.signal}));
  const rejected=assert.rejects(pending,error=>error.code==='aborted'&&error.telemetry.errorCode==='aborted');
  await ready;controller.abort();
  assert.deepEqual(await f.transport.close(),{closed:true});await rejected;
  assert.equal(f.transport.status().active,false);
  assert.equal(f.transport.status().halted,false);
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,1);
});

test('concurrent decision is refused and does not change the active thread',async t=>{
  let finishCurrent;const f=await fixture(t,{onTurn:({finish})=>{finishCurrent=finish;}});await f.transport.preflight();
  const pending=f.transport.callDecision(f.request());while(!finishCurrent)await new Promise(resolveWait=>setTimeout(resolveWait,1));
  await assert.rejects(f.transport.callDecision(f.request()),{code:'transport_busy'});finishCurrent();await pending;
  assert.equal(f.transport.status().sessionTurnIndex,1);
});

test('unsafe user connector configuration fails before app-server launch',async t=>{
  const f=await fixture(t,{readConfiguration:async()=> 'mcp_servers = {remote={}}'});await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request()),{code:'unsafe_session_configuration'});assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,0);
});

test('ambiguous connector names fail before launch rather than creating a quoted incomplete server',async t=>{
  const f=await fixture(t,{readConfiguration:async()=>'[mcp_servers."private.local"]\ncommand="hidden"'});await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request()),{code:'unsupported_session_connector_name'});
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,0);
});

test('retained-reference packets cannot open a new or lost session',async t=>{
  const f=await fixture(t);await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request({requiresRetainedSession:true})),{code:'session_reference_unavailable'});
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,0);
  await f.transport.callDecision(f.request());await f.transport.close();
  await assert.rejects(f.transport.callDecision(f.request({requiresRetainedSession:true})),{code:'session_reference_unavailable'});
  assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,1);
});

test('CLI startup failure exposes only a bounded diagnostic category',async t=>{
  const f=await fixture(t,{onLaunch:({child})=>{child.stderr.write('Error: invalid transport\nin mcp_servers.SECRET_SERVER sk-SECRET_TOKEN\n');child.close(1);}});
  await f.transport.preflight();
  await assert.rejects(f.transport.callDecision(f.request()),error=>{
    assert.equal(error.code,'session_process_exited');assert.equal(error.telemetry.cliDiagnosticCategory,'cli_config_invalid_transport');
    assert.ok(!JSON.stringify(error).includes('SECRET'));return true;
  });
  assert.equal(f.transport.status().active,false);
});

test('notifications without required current thread/turn bindings cannot finish a choice',async t=>{
  const f=await fixture(t,{onTurn:({emit,turnId})=>emit({method:'turn/completed',params:{turn:{id:turnId,status:'completed',items:[]}}})});
  await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),{code:'invalid_stream'});
});

test('unexpected MCP startup and unknown idle notifications are refused with method-only diagnostics',async t=>{
  for(const method of ['mcpServer/startupStatus/updated','unknown/idle']){
    const f=await fixture(t,{onLaunch:({child})=>child.stdout.write(line({method,params:{name:'PRIVATE_CONNECTOR',message:'PRIVATE_TEXT'}}))});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),error=>{
      assert.equal(error.code,method==='unknown/idle'?'unsolicited_turn_event':'session_connectors_started');
      assert.equal(error.telemetry.rejectedNotificationMethod,method);assert.ok(!JSON.stringify(error).includes('PRIVATE'));return true;
    });
  }
});

test('uncertain owned-process termination halts all future generation',async t=>{
  const f=await fixture(t,{terminate:false,onTurn:()=>{}});await f.transport.preflight();
  try{
    await assert.rejects(f.transport.callDecision(f.request({deadlineAt:Date.now()+50})),{code:'termination_uncertain'});
    assert.equal(f.transport.status().halted,true);
    await assert.rejects(f.transport.callDecision(f.request()),{code:'termination_uncertain'});
    assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,1);
  }finally{
    // Synthetic child only: release the deliberately unconfirmed fixture.
    f.children.at(-1).close(1);
  }
});

test('large allowed input echoes do not raise the bounded authored-output limit',async t=>{
  const f=await fixture(t,{onTurn:({emit,threadId,turnId,value,finish})=>{
    emit({method:'item/completed',params:{threadId,turnId,item:{id:'input-echo',type:'userMessage',content:value.params.input}}});finish();
  }});await f.transport.preflight();
  const result=await f.transport.callDecision(f.request({input:JSON.stringify({metadata:'x'.repeat(350000),legal:['protect','attack']})}));
  assert.deepEqual(result.decision,{choice:'protect'});assert(result.telemetry.inputBytes>256000);
  const bad=await fixture(t,{onTurn:({emit,threadId,turnId})=>emit({method:'item/completed',params:{threadId,turnId,item:{id:'too-big',type:'agentMessage',text:'x'.repeat(70000)}}})});
  await bad.transport.preflight();await assert.rejects(bad.transport.callDecision(bad.request()),{code:'invalid_output'});
});

test('new child game identity closes the old model thread while keeping the same BO3 scope and deadline',async t=>{
 const f=await fixture(t);await f.transport.preflight();
 const first=await f.transport.callDecision(f.request({sessionScope:{...scope,gameId:'battle-one'}}));
 const request=f.request({sessionScope:{...scope,gameId:'battle-two'}}),second=await f.transport.callDecision(request);
 assert.equal(second.telemetry.sessionTurnIndex,1);assert.notEqual(first.telemetry.sessionThreadSha256,second.telemetry.sessionThreadSha256);
 assert.notEqual(first.telemetry.sessionScopeSha256,second.telemetry.sessionScopeSha256);assert.equal(second.telemetry.deadlineAt,request.deadlineAt);
 assert.equal(f.calls.filter(call=>call.args[0]==='app-server').length,2);
});

const nativeDefinitions=[{name:'get_pokemon',description:'Read exact native species and form mechanics.',inputSchema:{type:'object',properties:{name:{type:'string'},gen:{type:'integer',const:0}},required:['name','gen'],additionalProperties:false}}];
const toolArguments={name:'Golisopod-Mega',gen:0};
function requestTool({emit,threadId,turnId},{rpcId=900,callId='call-native-1',name='get_pokemon',arguments:args=toolArguments,namespace,started=true}={}){
  const common={threadId,turnId,callId,tool:name,arguments:args,...(namespace===undefined?{}:{namespace})};
  if(started)emit({method:'item/started',params:{threadId,turnId,item:{type:'dynamicToolCall',id:callId,tool:name,arguments:args,status:'inProgress',...(namespace===undefined?{}:{namespace})}}});
  emit({id:rpcId,method:'item/tool/call',params:common});return common;
}
function completeTool({emit,threadId,turnId},response,{callId='call-native-1',name='get_pokemon',arguments:args=toolArguments}={}){
  emit({method:'item/completed',params:{threadId,turnId,item:{type:'dynamicToolCall',id:callId,tool:name,arguments:args,status:response.success?'completed':'failed',success:response.success,contentItems:response.contentItems}}});
}

test('declared model MCP calls return exact results inside the same CLI turn before final JSON',async t=>{
  const calls=[],actual={content:[{type:'text',text:'Exact native static mechanics.'}],structuredContent:{known:true,unknown:null,ability:'native-fixture'}};
  const f=await fixture(t,{onTurn:state=>requestTool(state),onResponse:state=>{completeTool(state,state.value.result);state.finish({decision:{choice:'attack'}});}});
  await f.transport.preflight();const request=f.request({modelTools:{definitions:nativeDefinitions,call:async call=>{calls.push(call);return actual;}}});
  const result=await f.transport.callDecision(request),app=f.calls.find(row=>row.args[0]==='app-server');
  assert.equal(app.messages.find(row=>row.method==='initialize').params.capabilities.experimentalApi,true);
  assert.deepEqual(app.messages.find(row=>row.method==='thread/start').params.dynamicTools,nativeDefinitions.map(definition=>({type:'function',...definition})));
  assert.match(app.messages.find(row=>row.method==='thread/start').params.developerInstructions,/declared dynamic native MCP tools/u);
  assert.equal(calls.length,1);assert.equal(calls[0].name,'get_pokemon');assert.deepEqual(calls[0].arguments,toolArguments);
  assert.equal(calls[0].callId,'call-native-1');assert.equal(calls[0].deadlineAt,request.deadlineAt);assert.equal(calls[0].signal.aborted,false);
  const response=app.messages.find(row=>row.id===900&&!row.method);assert.equal(response.result.success,true);
  assert.deepEqual(response.result.contentItems,[{type:'inputText',text:JSON.stringify(actual)}]);
  assert.deepEqual(result.decision,{choice:'attack'});assert.equal(result.telemetry.modelToolCalls.length,1);
  assert.equal(result.telemetry.modelToolCalls[0].origin,'model-requested');assert.equal(result.telemetry.modelToolCalls[0].outcome,'completed');
  assert.equal(result.telemetry.modelToolCalls[0].returnedToModel,true);
  assert.equal(result.telemetry.modelToolCalls[0].name,'get_pokemon');assert.equal(Object.hasOwn(result.telemetry.modelToolCalls[0],'arguments'),false);
});

test('a small retained input accepts the complete larger native tool echo in whole and fragmented frames',async t=>{
  for(const fragmented of [false,true]){
    const actual={kind:'simulation-choices',worlds:Array.from({length:3},(_,index)=>({index,events:'"native event"\\line\n'.repeat(7000)}))};
    let echoBytes=0,callbackCount=0;const f=await fixture(t,{onTurn:state=>{if(state.count===1)state.finish();else requestTool(state);},onResponse:state=>{
      assert.deepEqual(state.value.result.contentItems,[{type:'inputText',text:JSON.stringify(actual)}],'the complete actual result reaches the CLI unchanged');
      const event={method:'item/completed',params:{threadId:state.threadId,turnId:state.turnId,item:{type:'dynamicToolCall',id:'call-native-1',tool:'get_pokemon',arguments:toolArguments,status:'completed',success:true,contentItems:state.value.result.contentItems}}},encoded=line(event);echoBytes=Buffer.byteLength(encoded)-1;
      if(fragmented)for(let at=0;at<encoded.length;at+=8192)state.child.stdout.write(encoded.slice(at,at+8192));else state.child.stdout.write(encoded);
      state.finish();
    }});await f.transport.preflight();const tools={definitions:nativeDefinitions,call:async()=>{callbackCount++;return actual;}};
    await f.transport.callDecision(f.request({modelTools:tools,input:JSON.stringify({firstFullSource:'x'.repeat(300000)})}));
    const request=f.request({modelTools:tools}),result=await f.transport.callDecision(request);
    assert(echoBytes>Math.max(128*1024,result.telemetry.requestBytes*6+65536),'this valid tool echo exceeded the old compact-input-derived line cap');
    assert.equal(callbackCount,1);assert.equal(result.telemetry.sessionReused,true);assert.equal(result.telemetry.sessionTurnIndex,2);assert.equal(result.telemetry.deadlineAt,request.deadlineAt);
    assert.equal(result.telemetry.modelToolCalls[0].resultBytes,Buffer.byteLength(JSON.stringify(actual)));assert.equal(result.telemetry.modelToolCalls[0].returnedToModel,true);
    assert(result.telemetry.streamLineLimitBytes>=echoBytes);assert.equal(result.telemetry.streamMaxLineBytes,echoBytes);assert(result.telemetry.streamBytes>result.telemetry.streamTurnBytes);
    assert.equal(result.telemetry.streamLimitKind,undefined);assert.deepEqual(result.decision,{choice:'protect'});
  }
});

test('aggregate tool echoes can complete without reducing per-result or authored-output bounds',async t=>{
  const actual={text:'"\\\n'.repeat(170000)},responses=[];let returned=0;
  const f=await fixture(t,{onTurn:state=>{for(let i=0;i<4;i++)requestTool(state,{rpcId:900+i,callId:'call-native-'+i});},onResponse:state=>{
    const index=state.value.id-900,response=state.value.result;responses[index]=response;
    assert.equal(response.contentItems[0].text,JSON.stringify(actual));completeTool(state,response,{callId:'call-native-'+index});
    if(++returned===4){state.emit({method:'turn/completed',params:{threadId:state.threadId,turn:{id:state.turnId,status:'completed',items:[...responses.map((r,i)=>({type:'dynamicToolCall',id:'call-native-'+i,tool:'get_pokemon',arguments:toolArguments,status:'completed',success:true,contentItems:r.contentItems})),{type:'agentMessage',id:'final',text:JSON.stringify({choice:'protect'})}]}}});}
  }});await f.transport.preflight();const result=await f.transport.callDecision(f.request({deadlineAt:Date.now()+10000,modelTools:{definitions:nativeDefinitions,call:async()=>actual}}));
  assert.equal(result.telemetry.modelToolCalls.length,4);assert(result.telemetry.modelToolCalls.every(c=>c.returnedToModel));assert(result.telemetry.streamMaxLineBytes>6*1024*1024,'the combined completion exceeds a single argument framing allowance');
  assert.equal(result.telemetry.sessionTurnCompleted,true);assert.deepEqual(result.decision,{choice:'protect'});
  const over=await fixture(t,{onTurn:state=>requestTool(state)});await over.transport.preflight();await assert.rejects(over.transport.callDecision(over.request({modelTools:{definitions:nativeDefinitions,call:async()=>({text:'x'.repeat(2*1024*1024)})}})),{code:'session_tool_result_limit'});
});

test('stream limits retain exact safe framing and lifetime diagnostics before closing',async t=>{
  for(const variant of ['line-complete','line-incomplete','session-bytes','session-events']){
    const f=await fixture(t,{onTurn:state=>{
      if(variant==='line-complete')state.emit({method:'warning',params:{text:'x'.repeat(128*1024)}});
      else if(variant==='line-incomplete')state.child.stdout.write('x'.repeat(128*1024+1));
      else if(variant==='session-bytes')for(let i=0;i<520;i++)state.emit({method:'warning',params:{text:'x'.repeat(65500)}});
      else for(let i=0;i<66000;i++)state.emit({method:'warning',params:{}});
    }});await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request({deadlineAt:Date.now()+10000})),error=>{
      assert.equal(error.code,'stream_limit');const t=error.telemetry;assert.equal(t.streamLimitKind,variant);assert(t.streamLimitObserved>t.streamLimitValue);assert(t.streamBytes>0);assert(t.eventCount>0);assert(t.streamTurnBytes>0);assert(t.streamTurnEvents>0);assert(t.streamLastChunkBytes>0);assert(t.streamMaxChunkBytes>=t.streamLastChunkBytes);assert.equal(t.streamCountersScope,'session-lifetime-with-current-turn-deltas');
      if(variant.startsWith('line-'))assert.equal(t.streamLimitValue,128*1024);else assert.equal(t.streamLimitValue,variant==='session-bytes'?32*1024*1024:65536);
      assert.equal(t.applicationRetryCount,0);return true;
    });assert.equal(f.transport.status().active,false);assert.equal(f.calls.filter(c=>c.args[0]==='app-server').length,1);
  }
});

test('fixed seed tuple projection changes only CLI schema presentation and records both manifests',async t=>{
  const integer={type:'integer',minimum:0,maximum:65535},tuple={type:'array',items:Array.from({length:4},()=>structuredClone(integer)),minItems:4,maxItems:4,additionalItems:false};
  const definitions=[{name:'simulate_turn',description:'Simulate authored pairs.',inputSchema:{type:'object',properties:{seed:tuple},required:['seed'],additionalProperties:false}}];
  const original=structuredClone(definitions),args={seed:[1,2,3,4]},seen=[];
  const f=await fixture(t,{onTurn:state=>requestTool(state,{name:'simulate_turn',arguments:args}),onResponse:state=>{completeTool(state,state.value.result,{name:'simulate_turn',arguments:args});state.finish();}});
  await f.transport.preflight();
  const result=await f.transport.callDecision(f.request({modelTools:{definitions,call:async call=>{seen.push(call);return {content:[{type:'text',text:'Exact MCP result.'}]};}}}));
  const wire=f.calls.flatMap(call=>call.messages).find(message=>message.method==='thread/start').params.dynamicTools[0].inputSchema;
  assert.deepEqual(definitions,original);assert.deepEqual(seen[0].arguments,args);
  assert.deepEqual(wire.properties.seed,{type:'array',items:integer,minItems:4,maxItems:4});
  assert.equal(result.telemetry.modelToolFixedTupleProjections,1);
  assert.match(result.telemetry.modelToolManifestSha256,/^[a-f0-9]{64}$/u);
  assert.notEqual(result.telemetry.modelToolWireManifestSha256,result.telemetry.modelToolManifestSha256);
  assert.equal(result.telemetry.modelToolCalls[0].returnedToModel,true);
});

test('explicit false keeps the old no-tools thread and permission behavior',async t=>{
  const f=await fixture(t);await f.transport.preflight();await f.transport.callDecision(f.request({modelTools:false}));
  const app=f.calls.find(row=>row.args[0]==='app-server');
  assert.equal(app.messages.find(row=>row.method==='initialize').params.capabilities.experimentalApi,false);
  assert.equal(Object.hasOwn(app.messages.find(row=>row.method==='thread/start').params,'dynamicTools'),false);
});

test('unknown tools, namespaces, foreign thread and stale turn execute no callback',async t=>{
  for(const problem of ['tool','namespace','thread','turn']){
    let calls=0;
    const f=await fixture(t,{onTurn:state=>{
      const params={threadId:problem==='thread'?'foreign-thread':state.threadId,turnId:problem==='turn'?'stale-turn':state.turnId,callId:'call-native-1',tool:problem==='tool'?'shell':'get_pokemon',arguments:toolArguments,...(problem==='namespace'?{namespace:'arbitrary'}:{})};
      state.emit({id:900,method:'item/tool/call',params});
    }});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>{calls++;return {};}}})),{code:problem==='thread'?'session_thread_mismatch':problem==='turn'?'session_turn_mismatch':'tools_forbidden'});
    assert.equal(calls,0,problem);
  }
});

test('duplicate RPCs and repeated callId reuse one exact callback result',async t=>{
  let calls=0,responses=0,requestState;
  const f=await fixture(t,{onTurn:state=>{requestState=state;requestTool(state);requestTool(state,{started:false});},onResponse:state=>{
    responses++;
    if(responses===1){requestTool(requestState,{started:false});requestTool(requestState,{rpcId:901,started:false});}
    if(responses===3){completeTool(state,state.value.result);state.finish();}
  }});
  await f.transport.preflight();const result=await f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>{calls++;return {content:[{type:'text',text:'exact'}]};}}}));
  assert.equal(calls,1);assert.equal(responses,3);assert.equal(result.telemetry.modelToolCalls.length,1);
});

test('a duplicate callId with different arguments or RPC id reused for another call fails closed',async t=>{
  for(const problem of ['arguments','rpc']){
    let calls=0;
    const f=await fixture(t,{onTurn:state=>{requestTool(state);requestTool(state,{started:false,...(problem==='arguments'?{arguments:{name:'other',gen:0}}:{callId:'call-native-2'})});}});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>{calls++;return {};}}})),{code:'session_tool_call_mismatch'});
    assert(calls<=1);
  }
});

test('changed declared catalogs fail closed instead of silently replacing a retained thread',async t=>{
  const f=await fixture(t);await f.transport.preflight();
  await f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>({})}}));
  for(const definitions of [[{...nativeDefinitions[0],description:'Changed native interface.'}]]){
    await assert.rejects(f.transport.callDecision(f.request({modelTools:{definitions,call:async()=>({})},requiresRetainedSession:true})),{code:'session_toolset_changed'});
  }
  assert.equal(f.calls.filter(row=>row.args[0]==='app-server').length,1);assert.equal(f.transport.status().active,false);
});

test('MCP error results and callback exceptions remain bounded tool failures and allow a final decision',async t=>{
  for(const mode of ['mcp-error','exception']){
    const f=await fixture(t,{onTurn:state=>requestTool(state),onResponse:state=>{assert.equal(state.value.result.success,false);assert(!JSON.stringify(state.value).includes('PRIVATE_EXCEPTION'));completeTool(state,state.value.result);state.finish();}});
    await f.transport.preflight();const result=await f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>{if(mode==='exception')throw new Error('PRIVATE_EXCEPTION');return {isError:true,content:[{type:'text',text:'Native unsupported input.'}]};}}}));
    assert.deepEqual(result.decision,{choice:'protect'});assert.equal(result.telemetry.modelToolCalls[0].outcome,'returned-error');
    assert(!JSON.stringify(result.telemetry).includes('PRIVATE_EXCEPTION'));
  }
});

test('original deadline and cancellation abort and drain the callback without replying after closure',async t=>{
  for(const mode of ['deadline','abort','close']){
    const controller=new AbortController();let aborted=false,completed=false,entered;
    const started=new Promise(resolveStarted=>{entered=resolveStarted;});
    const f=await fixture(t,{onTurn:state=>requestTool(state)});await f.transport.preflight();
    const request=f.request({deadlineAt:Date.now()+120,signal:controller.signal,modelTools:{definitions:nativeDefinitions,call:async({signal,deadlineAt})=>{
      assert.equal(deadlineAt,request.deadlineAt);entered();await new Promise(resolveDone=>signal.addEventListener('abort',()=>{aborted=true;setTimeout(resolveDone,10);},{once:true}));
      completed=true;return {content:[{type:'text',text:'Late result must be suppressed.'}]};
    }}});
    const pending=f.transport.callDecision(request),rejected=assert.rejects(pending,{code:mode==='deadline'?'deadline_exceeded':mode==='abort'?'aborted':'session_closed'});
    await started;if(mode==='abort')controller.abort();else if(mode==='close')await f.transport.close();
    await rejected;assert.equal(aborted,true);assert.equal(completed,true);
    assert.equal(f.calls.at(-1).messages.some(message=>message.id===900&&!message.method),false);
    assert.equal(f.transport.status().active,false);
  }
});

test('tool completion must match its call and be observed before the turn can finish',async t=>{
  for(const mode of ['mismatch','missing']){
    const f=await fixture(t,{onTurn:state=>requestTool(state),onResponse:state=>{if(mode==='mismatch')completeTool(state,state.value.result,{arguments:{name:'wrong',gen:0}});state.finish();}});
    await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>({content:[]})}})),{code:mode==='mismatch'?'session_tool_call_mismatch':'session_tool_incomplete'});
  }
});

test('quiet and legacy traffic after fast tools cannot manufacture a final or hide its deadline',async t=>{
  for(const mode of ['timeout','complete','missing-echo']){
    let responses=0,backends=0;
    const f=await fixture(t,{onTurn:state=>{
      requestTool(state,{rpcId:900,callId:'call-native-1'});
      requestTool(state,{rpcId:901,callId:'call-native-2'});
    },onResponse:state=>{
      responses++;
      if(mode!=='missing-echo')completeTool(state,state.value.result,{callId:state.value.id===900?'call-native-1':'call-native-2'});
      if(responses!==2)return;
      for(let i=0;i<5860;i++)state.emit({method:i%2?'codex/event/private_debug':'remoteControl/status/changed',params:{private:'DO_NOT_RETAIN_PRIVATE_PAYLOAD'}});
      state.emit({method:'item/reasoning/textDelta',params:{threadId:state.threadId,turnId:state.turnId,delta:'DO_NOT_RETAIN_PRIVATE_REASONING'}});
      if(mode!=='timeout')state.finish();
    }});
    await f.transport.preflight();
    const request=f.request({deadlineAt:Date.now()+800,modelTools:{definitions:nativeDefinitions,call:async()=>{backends++;return {content:[]};}}});
    let telemetry;
    if(mode==='complete'){
      const result=await f.transport.callDecision(request);telemetry=result.telemetry;
      assert.deepEqual(result.decision,{choice:'protect'});assert.equal(telemetry.sessionTurnCompleted,true);
      assert(telemetry.modelToolCalls.every(row=>Number.isFinite(row.itemCompletedAt)));
      assert.equal(telemetry.tokenUsageTurnCompleteAtObservation,false,'the usage snapshot preceded authoritative completion');
    }else await assert.rejects(f.transport.callDecision(request),error=>{
      assert.equal(error.code,mode==='timeout'?'deadline_exceeded':'session_tool_incomplete');
      telemetry=error.telemetry;assert.equal(telemetry.sessionTurnCompleted,false);return true;
    });
    assert.equal(backends,2);assert.equal(responses,2);
    assert.equal(telemetry.cliActivity.counts.legacy,2930);assert.equal(telemetry.cliActivity.counts.quiet,2930);
    assert.equal(telemetry.cliActivity.counts.toolRequest,2);assert.equal(telemetry.cliActivity.counts.reasoning,1);
    assert.equal(telemetry.cliActivity.counts.turnCompleted??0,mode==='timeout'?0:1);
    assert.equal(telemetry.cliActivity.payloadsRetained,false);assert(telemetry.cliActivity.buckets.length<=64);
    assert(Buffer.byteLength(JSON.stringify(telemetry.cliActivity))<8192);
    assert(!JSON.stringify(telemetry).includes('DO_NOT_RETAIN'));
    assert.equal(f.transport.status().active,mode==='complete');
  }
});

test('provider error diagnostics retain only recognized category, HTTP status and explicit retry flag',async t=>{
  const f=await fixture(t,{onTurn:({emit,threadId,turnId})=>emit({method:'error',params:{threadId,turnId,
    willRetry:true,error:{message:'DO_NOT_RETAIN_PRIVATE_ERROR',additionalDetails:'DO_NOT_RETAIN_DETAILS',codexErrorInfo:{HttpConnectionFailed:{httpStatusCode:429,private:'DO_NOT_RETAIN_SECRET'}}}}})});
  await f.transport.preflight();await assert.rejects(f.transport.callDecision(f.request()),error=>{
    assert.equal(error.code,'generation_failed');
    assert.deepEqual(Object.keys(error.telemetry.cliActivity.providerError).sort(),['at','httpStatus','kind','reportedWillRetry']);
    assert.equal(error.telemetry.cliActivity.providerError.kind,'HttpConnectionFailed');
    assert.equal(error.telemetry.cliActivity.providerError.httpStatus,429);
    assert.equal(error.telemetry.cliActivity.providerError.reportedWillRetry,true);
    assert(!JSON.stringify(error.telemetry).includes('DO_NOT_RETAIN'));return true;
  });
});

test('only allowlisted bounded calculation receipt fields enter tool telemetry',async t=>{
  const ref={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',sha256:'a'.repeat(64),tool:'calculate_speed',path:'PRIVATE_PATH',private:'PRIVATE_SECRET'};
  const name='calculate_speed',definitions=[{...nativeDefinitions[0],name}];
  const f=await fixture(t,{onTurn:state=>requestTool(state,{name}),onResponse:state=>{completeTool(state,state.value.result,{name});state.finish();}});await f.transport.preflight();
  const result=await f.transport.callDecision(f.request({modelTools:{definitions,call:async()=>({content:[{type:'text',text:JSON.stringify({calculationRef:ref})}]})}}));
  assert.deepEqual(result.telemetry.modelToolCalls[0].calculationReceipt,{id:ref.id,sha256:ref.sha256,tool:ref.tool});
  assert(!JSON.stringify(result.telemetry).includes('PRIVATE'));
});

test('multiple model tool requests serialize native callbacks and retain both complete responses',async t=>{
  let active=0,calls=0,responses=0;
  const f=await fixture(t,{onTurn:state=>{requestTool(state);requestTool(state,{rpcId:901,callId:'call-native-2',arguments:{name:'Politoed',gen:0}});},onResponse:state=>{
    const second=state.value.id===901;completeTool(state,state.value.result,second?{callId:'call-native-2',arguments:{name:'Politoed',gen:0}}:{});
    if(++responses===2)state.finish();
  }});await f.transport.preflight();
  const result=await f.transport.callDecision(f.request({modelTools:{definitions:nativeDefinitions,call:async()=>{assert.equal(active++,0);calls++;await new Promise(resolveDone=>setTimeout(resolveDone,5));active--;return {content:[]};}}}));
  assert.equal(calls,2);assert.equal(responses,2);assert.equal(result.telemetry.modelToolCalls.length,2);
  assert(result.telemetry.modelToolCalls.every(row=>row.returnedToModel));
});

test('an unacknowledged callback abort halts future scope reuse until owned work ends',async t=>{
  let release;
  const f=await fixture(t,{onTurn:state=>requestTool(state)});await f.transport.preflight();
  try{
    await assert.rejects(f.transport.callDecision(f.request({deadlineAt:Date.now()+70,modelTools:{definitions:nativeDefinitions,call:()=>new Promise(resolveDone=>{release=resolveDone;})}})),{code:'tool_cancellation_uncertain'});
    assert.equal(f.transport.status().halted,true);assert.equal(f.transport.status().active,false);
    await assert.rejects(f.transport.callDecision(f.request()),{code:'termination_uncertain'});
    assert.equal(f.calls.filter(row=>row.args[0]==='app-server').length,1);
  }finally{release?.({content:[]});await new Promise(resolveDone=>setTimeout(resolveDone,0));}
});
