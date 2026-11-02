import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCodexCliDecisionProvider} from './codex-cli-provider.mjs';
import {digest} from '../planning/identity.mjs';

const strict=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const literal=value=>({type:typeof value,const:value});
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function sessionSetup({failAt=0,advanceResetMs=0}={}){
 const calls=[],resets=[];let attempts=0,active=false,currentTime=1000,usage={};
 const provider=createCodexCliDecisionProvider({workspace:process.cwd(),model:'gpt-6.1-sol',reasoningEffort:'low',contextMode:'session',now:()=>currentTime,
  transportFactory:()=>({preflight:async()=>({authMode:'chatgpt'}),status:()=>({active,...usage}),reset:async()=>{active=false;resets.push(true);if(resets.length>1)currentTime+=advanceResetMs;},close:async()=>{active=false;},callDecision:async request=>{
   calls.push(request);if(++attempts===failAt)throw Object.assign(new Error('synthetic interruption'),{code:'aborted'});
   active=true;
   return {decision:{choice:'hold'},telemetry:{sessionTurnIndex:attempts,sessionTurnCompleted:true}};
  }})});
 const request=turn=>({instructions:'Author only the current legal choice. '.repeat(50),
  input:JSON.stringify({ownTeam:{text:'static team '.repeat(150)},opponentSheet:{text:'static sheet '.repeat(150)},
   board:{turn,weather:turn===1?'rain':null},legalOptions:{refs:['hold']},observedOrderConstraints:[{before:'a',after:'b',qualified:true}],
   recentEvents:[{turn,event:'observed execution'}],strategicMemory:{claims:{plan:'a prior claim'}}}),
  schema:strict({choice:{type:'string',enum:['hold']}}),deadlineAt:40000,
  sessionScope:{sessionId:'synthetic',parentId:'game-bestof3-gen9championsvgc2026regmcbo3-123',teamId:'a'.repeat(64)}});
 return {...provider,calls,resets,request,loseThread:()=>{active=false;},setUsage:value=>{usage=value;}};
}

test('retained provider sends authoritative dynamic source with verified static references on later turns',async()=>{
 const p=sessionSetup();await p.preflight();const first=await p.decisionProvider.callDecision(p.request(1));
 const second=await p.decisionProvider.callDecision(p.request(2));
 assert.equal(first.telemetry.contextMode,'session');assert.equal(second.telemetry.sessionSourceRehydrated,true);
 assert.equal(second.telemetry.retainedStaticReferences,2);assert(second.telemetry.sessionSavedPacketBytes>0);
 assert.equal(second.telemetry.sessionContextSequence,2);
 const frame=JSON.parse(p.calls[1].input);assert.equal(frame.current.board.turn,2);assert.equal(frame.current.board.weather,null);
 assert.deepEqual(frame.current.legalOptions,{refs:['hold']});assert.deepEqual(frame.current.observedOrderConstraints,[{before:'a',after:'b',qualified:true}]);
 assert.deepEqual(frame.current.recentEvents,[{turn:2,event:'observed execution'}]);
 assert.equal(second.telemetry.nativeInputSha256,sha(p.request(2).input));
 assert.equal(second.telemetry.sessionSourceSha256,sha(p.request(2).input));
 assert.equal(sha(p.calls[1].input),second.telemetry.modelInputSha256);
 assert.equal(second.telemetry.inputPreserved,false);
 assert.deepEqual(p.calls[1].schema,p.request(2).schema);
 assert.equal(p.calls[0].requiresRetainedSession,false);assert.equal(p.calls[1].requiresRetainedSession,true);
 await p.close();
});

test('session scope is host-required and a new BO3 starts with a full frame',async()=>{
 const p=sessionSetup();await p.preflight();const noScope=p.request(1);delete noScope.sessionScope;
 await assert.rejects(p.decisionProvider.callDecision(noScope),{code:'session_scope_required'});assert.equal(p.calls.length,0);
 await p.decisionProvider.callDecision(p.request(1));const next=p.request(1);next.sessionScope.parentId+='4';
 const result=await p.decisionProvider.callDecision(next);
 assert.equal(result.telemetry.sessionContextSequence,1);assert.equal(result.telemetry.retainedStaticReferences,0);
 assert(p.resets.length>=2);await p.close();
});

test('failed or uncertain generation invalidates retained references before a later request',async()=>{
 const p=sessionSetup({failAt:2});await p.preflight();await p.decisionProvider.callDecision(p.request(1));
 await assert.rejects(p.decisionProvider.callDecision(p.request(2)),{code:'aborted'});
 const result=await p.decisionProvider.callDecision(p.request(3));
 assert.equal(result.telemetry.sessionContextSequence,1);assert.equal(result.telemetry.retainedStaticReferences,0);
 assert.equal(p.calls.length,3);await p.close();
});

test('between-turn thread loss sends a complete new frame instead of unresolved retained references',async()=>{
 const p=sessionSetup();await p.preflight();await p.decisionProvider.callDecision(p.request(1));p.loseThread();
 const next=await p.decisionProvider.callDecision(p.request(2));
 assert.equal(next.telemetry.sessionContextSequence,1);assert.equal(next.telemetry.retainedStaticReferences,0);
 assert.equal(p.calls[1].requiresRetainedSession,false);await p.close();
});

test('explicit8MiB capacity does not impose the former32KB cold-size heuristic',async()=>{
 const p=sessionSetup();await p.preflight();const large=p.request(2);
 const payload=JSON.parse(large.input);payload.extraCurrentFact='q'.repeat(33000);large.input=JSON.stringify(payload);large.deadlineAt=31000;
 await p.decisionProvider.callDecision(large);assert.equal(p.calls.length,1);assert.equal(p.calls[0].requiresRetainedSession,false);
 await p.decisionProvider.callDecision(large);assert.equal(p.calls.at(-1).requiresRetainedSession,true);
 p.loseThread();await p.decisionProvider.callDecision(large);
 assert.equal(p.calls.length,3);assert.equal(p.calls.at(-1).requiresRetainedSession,false);
 const long={...large,deadlineAt:40000};await p.decisionProvider.callDecision(long);
 assert.equal(p.calls.at(-1).requiresRetainedSession,true);await p.close();
});

test('framing overhead beyond32KB remains within the explicit larger capacity',async()=>{
 const p=sessionSetup();await p.preflight();const request=p.request(2),payload=JSON.parse(request.input);
 payload.extraCurrentFact='';request.input=JSON.stringify(payload);
 const overhead=Buffer.byteLength(request.instructions)+Buffer.byteLength(request.input)+Buffer.byteLength(JSON.stringify(request.schema));
 payload.extraCurrentFact='q'.repeat(31900-overhead);request.input=JSON.stringify(payload);request.deadlineAt=31000;
 assert.equal(Buffer.byteLength(request.instructions)+Buffer.byteLength(request.input)+Buffer.byteLength(JSON.stringify(request.schema)),31900);
 const result=await p.decisionProvider.callDecision(request);assert(result.telemetry.sessionNewPacketBytes>32000);
 assert.equal(p.calls.length,1);await p.close();
});

test('reported473748/475000 context failure refreshes the full current snapshot at safe new admission',async()=>{
 const p=sessionSetup();await p.preflight();await p.decisionProvider.callDecision(p.request(1));
 p.setUsage({tokenUsageKnown:true,lastInputTokens:473748,lastOutputTokens:1106,modelContextWindowTokens:475000});
 const request={...p.request(2),contextRefreshAllowed:true};const beforeResets=p.resets.length;
 const result=await p.decisionProvider.callDecision(request),sent=p.calls.at(-1),frame=JSON.parse(sent.input);
 assert.equal(p.resets.length,beforeResets+1);assert.equal(sent.deadlineAt,request.deadlineAt);
 assert.equal(sent.requiresRetainedSession,false);assert.equal(frame.base,null);assert.equal(frame.sequence,1);
 assert.equal(frame.current.board.turn,2);assert.deepEqual(frame.current.legalOptions,{refs:['hold']});
 assert.deepEqual(frame.current.observedOrderConstraints,JSON.parse(request.input).observedOrderConstraints);
 assert.deepEqual(frame.current.strategicMemory,JSON.parse(request.input).strategicMemory);assert(frame.static.values.ownTeam);
 assert.equal(result.telemetry.sessionContextRefreshed,true);assert.equal(result.telemetry.sessionRefreshPreviousInputTokens,473748);
 assert.equal(result.telemetry.sessionRefreshReportedWindowTokens,475000);assert(result.telemetry.sessionRefreshProjectedTokenUpperBound>=475000);
 assert.equal(result.telemetry.sessionRefreshOriginalDeadlineAt,request.deadlineAt);assert.equal(result.telemetry.modelAttempted,true);
 await p.close();
});

test('window refresh refuses absent controller admission, short remaining time and busy transport without generation',async()=>{
 for(const mode of ['unsafe','short','busy']){
  const p=sessionSetup();await p.preflight();await p.decisionProvider.callDecision(p.request(1));const resets=p.resets.length;
  p.setUsage({tokenUsageKnown:true,lastInputTokens:473748,lastOutputTokens:1200,modelContextWindowTokens:475000,...(mode==='busy'?{busy:true}:{})});
  const request={...p.request(2),contextRefreshAllowed:mode!=='unsafe',...(mode==='short'?{deadlineAt:31000}:{})};
  await assert.rejects(p.decisionProvider.callDecision(request),error=>error.code===(mode==='short'?'session_context_refresh_window':'session_context_refresh_unsafe')&&error.telemetry.modelAttempted===false);
  assert.equal(p.calls.length,1);assert.equal(p.resets.length,resets);await p.close();
 }
});

test('normal measured window keeps context and reset never extends the original deadline',async()=>{
 const p=sessionSetup();await p.preflight();await p.decisionProvider.callDecision(p.request(1));
 p.setUsage({tokenUsageKnown:true,lastInputTokens:12000,lastOutputTokens:600,modelContextWindowTokens:475000});
 const result=await p.decisionProvider.callDecision({...p.request(2),contextRefreshAllowed:true});
 assert.equal(result.telemetry.sessionContextRefreshed,undefined);assert.equal(p.calls.at(-1).requiresRetainedSession,true);await p.close();
 const slow=sessionSetup({advanceResetMs:6000});await slow.preflight();await slow.decisionProvider.callDecision(slow.request(1));
 slow.setUsage({tokenUsageKnown:true,lastInputTokens:473748,lastOutputTokens:1200,modelContextWindowTokens:475000});
 await assert.rejects(slow.decisionProvider.callDecision({...slow.request(2),contextRefreshAllowed:true}),error=>error.code==='session_context_refresh_window'&&error.telemetry.sessionRefreshOriginalDeadlineAt===40000);
 assert.equal(slow.calls.length,1);await slow.close();
});

test('a second decision or preflight cannot reset a generation already in flight',async()=>{
 let release,entered;const begun=new Promise(resolve=>{entered=resolve;}),paused=new Promise(resolve=>{release=resolve;});
 const calls=[];const p=createCodexCliDecisionProvider({workspace:process.cwd(),model:'gpt-6.1-sol',reasoningEffort:'low',now:()=>1000,transportFactory:()=>({preflight:async()=>({authMode:'chatgpt'}),callDecision:async request=>{calls.push(request);entered();await paused;return{decision:{choice:'hold'},telemetry:{}};}})});
 await p.preflight();const request={instructions:'Choose the current complete legal pair.',input:'{"board":{"turn":1}}',schema:strict({choice:{type:'string'}}),deadlineAt:40000,sessionScope:{parentId:'game-bestof3-gen9championsvgc2026regmcbo3-123',gameId:'battle-fixture',teamId:'a'.repeat(64)}};
 const current=p.decisionProvider.callDecision(request);await begun;
 await assert.rejects(p.decisionProvider.callDecision(request),{code:'provider_busy'});await assert.rejects(p.preflight(),{code:'provider_busy'});
 assert.equal(calls.length,1);release();await current;
});

test('each new child game in one BO3 starts a fresh thread frame with current facts and compact last-game context',async()=>{
 const p=sessionSetup();await p.preflight();const first={...p.request(1),sessionScope:{...p.request(1).sessionScope,gameId:'battle-one'}};
 await p.decisionProvider.callDecision(first);await p.decisionProvider.callDecision({...p.request(2),sessionScope:first.sessionScope});
 const next=p.request(3);next.sessionScope.gameId='battle-two';const input=JSON.parse(next.input);
 input.strategicMemory={facts:{lastGameObserved:['actual game-one result']},claims:{lastGameAdaptations:['retain last selected answer']}};next.input=JSON.stringify(input);
 const result=await p.decisionProvider.callDecision(next),sent=p.calls.at(-1),frame=JSON.parse(sent.input);
 assert.equal(result.telemetry.sessionContextSequence,1);assert.equal(sent.requiresRetainedSession,false);assert.equal(sent.deadlineAt,next.deadlineAt);
 assert.equal(frame.scope.parentId,first.sessionScope.parentId);assert.equal(frame.scope.gameId,'battle-two');assert.equal(frame.base,null);
 assert.deepEqual(frame.current.strategicMemory,input.strategicMemory);assert(frame.static.values.ownTeam);await p.close();
});
