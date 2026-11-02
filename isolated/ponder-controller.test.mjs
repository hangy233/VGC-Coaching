import test from 'node:test';
import assert from 'node:assert/strict';
import {createPonderController,PONDER_PROFILE,PONDER_OUTPUT_SCHEMA} from './ponder-controller.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';

const guidance=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE);
const clone=value=>structuredClone(value),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('range catalog and frozen return remain speculative rather than a fresh paired gate',async()=>{
  const returned={structuredContent:{kind:'champions-damage-range-v1',gen:0,status:'partial-candidate-envelope',coverage:{exhaustive:false},damageRange:{min:10,max:20,scope:'evaluated-legal-witnesses-only'}}};
  const f=fixture({executeReadOnly:async request=>{assert.equal(request.name,'calculate_damage_range');assert.deepEqual(request.arguments,{value:1});return returned;},callDecision:async input=>{
    assert(input.modelTools.definitions.some(t=>t.name==='calculate_damage_range'));
    assert.deepEqual(await input.modelTools.call({name:'calculate_damage_range',callId:'range',arguments:{value:1}}),returned);return{decision:output()};}});
  const source=snapshot();assert.equal((await f.controller.startIdle(source).completion).status,'completed');
  const candidate=f.controller.getCandidate({source:source.source,facts:source.facts});assert.equal(candidate.goalPassed,false);assert.equal(candidate.freshEvidence,false);assert.equal(candidate.requiresFreshMaterialChecks,true);assert.equal(candidate.toolAudit[0].name,'calculate_damage_range');
  f.controller.stop();await f.controller.drain();
});
const output=()=>({summary:'Consider the next observed position before using any proposal.',proposals:[{label:'Conditional next branch',idea:'Consider an authored move or switch only if the fresh board supports it.',assumptions:['The frozen field and HP remain relevant.'],questions:['Does the newly observed opposing pair change the line?'],factPaths:['/weather','/actors']}],limitations:['Frozen speculative work establishes no fresh tactical goal.']});
const snapshot=()=>({phase:'opponent-wait',choiceCommitted:true,uncertainSend:false,mainBusy:false,actions:[],ended:false,
  source:{sessionId:'ponder-session',teamId:'a'.repeat(64),parentId:'game-bestof3-gen9championsvgc2026regmcbo3-1',gameId:'battle-gen9championsvgc2026regmcbo3-2',sourceSha256:'b'.repeat(64)},facts:{weather:'rain',actors:[{id:'p1-1',hp:100}],unrelated:'old'}});
const catalog=()=>['get_pokemon','calculate_damage','calculate_damage_range','simulate_turn'].map(name=>({name,description:'Read-only fixture '+name,inputSchema:{type:'object',properties:{name:{type:'string'},value:{type:'integer'}},additionalProperties:false},annotations:{readOnlyHint:true}}));
function fixture({callDecision=async()=>({decision:output()}),executeReadOnly=async()=>({actualFixtureResult:true}),prepareHook,providerHook,closeHook,limits={},mainDecisionProvider,setTimer,clearTimer}={}){
  let time=1000;const events=[],prepared=[],created=[],providerCalls=[],nativeCalls=[],closed=[];
  const provider={contextMode:'session',preflightResult:{authMode:'chatgpt',model:'gpt-6.1-sol',reasoningEffort:'low',requestedServiceTier:'fast'},
    decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:async input=>{providerCalls.push(input);return callDecision(input);}},
    close:async()=>{closed.push(time);await closeHook?.();}};
  const controller=createPonderController({now:()=>time,onEvent:event=>events.push(event),mainDecisionProvider,limits,...(setTimer?{setTimer,clearTimer}:{}),
    prepareContext:async request=>{prepared.push(request);const context={instructions:'The source contains no fresh decision request.',input:JSON.stringify({matchupSkill:guidance,ponderFacts:request.snapshot.facts}),catalog:catalog()};return await prepareHook?.(request,context)??context;},
    createProvider:async request=>{created.push(request);const owned={...provider,preflightResult:{...provider.preflightResult},decisionProvider:{...provider.decisionProvider}};return await providerHook?.(request,owned)??owned;},
    executeReadOnly:async request=>{nativeCalls.push(request);return executeReadOnly(request);}});
  return {controller,events,prepared,created,providerCalls,nativeCalls,closed,provider,setTime:value=>{time=value;}};
}

test('pondering does not start without explicit committed opponent wait, source, or while the main model is busy',async()=>{
  const f=fixture();
  const cases=[null,{}, {...snapshot(),source:null}, {...snapshot(),phase:'preview'}, {...snapshot(),phase:'ready'}, {...snapshot(),phase:'own-turn'},
    {...snapshot(),choiceCommitted:false},{...snapshot(),uncertainSend:true},{...snapshot(),actions:[{kind:'turn'}]}, {...snapshot(),mainBusy:true}, {...snapshot(),ended:true},{...snapshot(),facts:null}];
  for(const source of cases)assert.equal(f.controller.startIdle(source).started,false);
  assert.equal(f.created.length,0);assert.equal(f.providerCalls.length,0);assert.equal(f.nativeCalls.length,0);f.controller.stop();
});

test('normal useful ponder work is model-selected and read-only, bounded to one generation per frozen wait source',async()=>{
  const native={isError:false,content:[{type:'text',text:'Complete actual fixture response'}],structuredContent:{sampled:true,unknown:null}},args={name:'Fixture'};
  const f=fixture({executeReadOnly:async request=>{assert.deepEqual(request.arguments,args);return native;},callDecision:async input=>{
    assert.equal(input.model,PONDER_PROFILE.model);assert.equal(input.reasoningEffort,'low');assert.equal(input.deadlineAt,46000);assert.deepEqual(input.schema,f.prepared[0].schema);
    const payload=JSON.parse(input.input);assert.deepEqual(input.schema.properties.proposals.items.properties.factPaths.items.enum,payload.factPathCatalog.paths);assert.deepEqual(payload.factPathCatalog.paths,['','/actors','/unrelated','/weather']);
    assert.deepEqual(JSON.parse(input.input).matchupSkill,guidance);assert.match(input.instructions,/speculative read-only/u);
    assert.deepEqual(await input.modelTools.call({name:'get_pokemon',callId:'lookup1',arguments:args}),native);
    return {decision:output(),telemetry:{fixture:true}};
  }});
  const source=snapshot(),start=f.controller.startIdle(source);assert.equal(start.started,true);assert.equal((await start.completion).status,'completed');
  assert.equal(f.providerCalls.length,1);assert.equal(f.nativeCalls.length,1);assert.deepEqual(f.nativeCalls[0].source,source.source);assert.equal(f.nativeCalls[0].deadlineAt,6000);
  assert.equal(f.nativeCalls[0].signal.aborted,false);assert.equal(f.controller.startIdle(source).reason,'source-already-pondered');
  const fresh={source:{...source.source,sourceSha256:'c'.repeat(64)},facts:{...clone(source.facts),unrelated:'new'}};
  const notes=f.controller.getCandidate(fresh);assert(notes);assert.equal(notes.speculative,true);assert.equal(notes.freshEvidence,false);assert.equal(notes.goalPassed,false);assert.equal(notes.serverAcceptance,false);assert.equal(notes.requiresFreshMaterialChecks,true);
  assert.equal(notes.revalidation.sourceUnchanged,false);assert.equal(notes.revalidation.tacticalValidation,false);assert.equal(notes.toolAudit[0].status,'returned');assert.deepEqual(notes.toolAudit[0].result,native);
  assert.equal(f.controller.getCandidate({...fresh,facts:{...fresh.facts,weather:'sun'}}),null);
  assert.equal(f.controller.getCandidate({...fresh,source:{...fresh.source,gameId:'battle-other'}}),null);
  assert(f.events.some(event=>event.name==='ponder.tool-started'));assert(f.events.some(event=>event.name==='ponder.tool-completed'));assert(f.events.some(event=>event.name==='ponder.completed'));
  f.controller.stop();await f.controller.drain();assert.equal(f.closed.length,1);
});

test('a fresh own request immediately aborts pondering without waiting for provider cleanup and discards a late completion',async()=>{
  const entered=deferred(),decision=deferred(),close=deferred();
  const f=fixture({callDecision:input=>{entered.resolve(input);return decision.promise;},closeHook:()=>close.promise}),source=snapshot(),start=f.controller.startIdle(source),request=await entered.promise;
  f.setTime(1050);const observed=f.controller.observe({...source,phase:'own-turn',actions:[{kind:'turn'}],mainBusy:true});
  assert.equal(observed.eligible,false);assert.equal(request.signal.aborted,true);assert.equal(f.controller.status().active,false);assert.equal(f.controller.status().preempted,1);
  await tick();assert.equal(f.closed.length,1);assert.equal((await f.controller.drain({timeoutMs:5})).cleanupConfirmed,false);
  decision.resolve({decision:output()});assert.equal((await start.completion).status,'discarded');assert.equal(f.controller.getCandidate({source:source.source,facts:source.facts}),null);
  const preemption=f.events.find(event=>event.name==='ponder.preempted');assert.equal(preemption.preemptedAt,1050);assert(f.events.some(event=>event.name==='ponder.discarded'));
  close.resolve();await f.controller.drain();f.controller.stop();
});

test('preemption during preparation or provider creation cannot start a late model and closes only its own provider',async()=>{
  for(const phase of ['prepare','factory']){
    const barrier=deferred(),entered=deferred();
    const f=fixture({...(phase==='prepare'?{prepareHook:async(_r,context)=>{entered.resolve();await barrier.promise;return context;}}:{providerHook:async(_r,provider)=>{entered.resolve();await barrier.promise;return provider;}})});
    const source=snapshot(),start=f.controller.startIdle(source);await entered.promise;f.controller.observe({...source,phase:'ready',actions:[{kind:'ready'}]});barrier.resolve();
    assert.equal((await start.completion).status,'discarded');assert.equal(f.providerCalls.length,0);await tick();assert.equal(f.closed.length,phase==='factory'?1:0);f.controller.stop();await f.controller.drain();
  }
});

test('a new request cancels a pending native callback immediately and never adopts its late result',async()=>{
  const entered=deferred(),native=deferred();let modelResult;
  const f=fixture({executeReadOnly:request=>{entered.resolve(request);return native.promise;},callDecision:async input=>{modelResult=await input.modelTools.call({callId:'numeric',name:'calculate_damage',arguments:{value:1}});return {decision:output()};}});
  const source=snapshot(),start=f.controller.startIdle(source),request=await entered.promise;f.controller.observe({...source,phase:'own-turn',actions:[{kind:'turn'}]});
  assert.equal(request.signal.aborted,true);assert.equal((await start.completion).status,'discarded');assert.equal(modelResult.isError,true);
  native.resolve({sampled:true});await tick();assert.equal(f.controller.getCandidate({source:source.source,facts:source.facts}),null);assert.equal(f.nativeCalls.length,1);f.controller.stop();await f.controller.drain();
  assert(f.events.some(event=>event.name==='ponder.tool-result-discarded'));assert(f.events.some(event=>event.name==='ponder.tool-backend-settled'));
});

test('parallel tool requests, excessive calls, mutation names and duplicate calls do not reach the read-only adapter',async()=>{
  const native=deferred(),entered=deferred();
  const f=fixture({executeReadOnly:()=>{entered.resolve();return native.promise;},callDecision:async input=>{
    const first=input.modelTools.call({name:'get_pokemon',callId:'first',arguments:{name:'Fixture'}});await entered.promise;
    const busy=await input.modelTools.call({name:'get_pokemon',callId:'second',arguments:{name:'Fixture'}});assert.equal(busy.structuredContent.code,'PONDER_TOOL_BUSY');
    native.resolve({complete:true});await first;
    assert.equal((await input.modelTools.call({name:'battle_choose',callId:'mutation',arguments:{}})).isError,true);
    assert.equal((await input.modelTools.call({name:'get_pokemon',callId:'first',arguments:{name:'Fixture'}})).isError,true);
    for(let i=0;i<5;i++)await input.modelTools.call({name:'get_pokemon',callId:'read'+i,arguments:{name:'Fixture'}});
    assert.equal((await input.modelTools.call({name:'get_pokemon',callId:'limit',arguments:{name:'Fixture'}})).structuredContent.code,'PONDER_TOOL_LIMIT');
    return {decision:output()};
  }});
  const start=f.controller.startIdle(snapshot());assert.equal((await start.completion).status,'completed');assert.equal(f.nativeCalls.length,6);assert.equal(f.controller.status().toolCalls,8);f.controller.stop();await f.controller.drain();
});

test('facts changing during pondering or completion after its original background cutoff discards the result',async()=>{
  for(const cause of ['facts','late']){
    const entered=deferred(),decision=deferred(),f=fixture({callDecision:input=>{entered.resolve(input);return decision.promise;}}),source=snapshot(),start=f.controller.startIdle(source);await entered.promise;
    if(cause==='facts')f.controller.observe({...source,source:{...source.source,sourceSha256:'d'.repeat(64)},facts:{...source.facts,weather:'sun'}});
    else f.setTime(46000);
    decision.resolve({decision:output()});assert.equal((await start.completion).status,'discarded');assert.equal(f.controller.getCandidate({source:source.source,facts:source.facts}),null);f.controller.stop();await f.controller.drain();
  }
});

test('invalid guidance, changed facts, unsafe catalog and wrong provider profile fail before generation',async()=>{
  for(const mutate of [
    context=>{const p=JSON.parse(context.input);p.matchupSkill.files[0].content+='changed';context.input=JSON.stringify(p);},
    context=>{const p=JSON.parse(context.input);p.ponderFacts.weather='sun';context.input=JSON.stringify(p);},
    context=>{context.catalog.push({name:'battle_forfeit',description:'Unsafe',inputSchema:{type:'object'}});},
  ]){const f=fixture({prepareHook:(_r,c)=>{mutate(c);return c;}}),start=f.controller.startIdle(snapshot());assert.equal((await start.completion).status,'unavailable');assert.equal(f.providerCalls.length,0);f.controller.stop();await f.controller.drain();}
  const wrong=fixture({providerHook:(_r,p)=>{p.preflightResult.reasoningEffort='medium';return p;}}),start=wrong.controller.startIdle(snapshot());assert.equal((await start.completion).code,'PONDER_PROVIDER');assert.equal(wrong.providerCalls.length,0);wrong.controller.stop();await wrong.controller.drain();assert.equal(wrong.closed.length,1);
});

test('provider reuse is confined to one game, preserves full logical guidance and never touches the main provider',async()=>{
  const main={callDecision(){assert.fail('Main provider must not be called');},close(){assert.fail('Main provider must not be closed');}};
  const f=fixture({mainDecisionProvider:main}),first=snapshot();await f.controller.startIdle(first).completion;
  const second={...first,source:{...first.source,sourceSha256:'e'.repeat(64)}};await f.controller.startIdle(second).completion;
  assert.equal(f.created.length,1);assert.equal(f.providerCalls.length,2);for(const call of f.providerCalls)assert.deepEqual(JSON.parse(call.input).matchupSkill,guidance);
  const third={...first,source:{...first.source,gameId:'battle-next',sourceSha256:'f'.repeat(64)}};await f.controller.startIdle(third).completion;
  assert.equal(f.created.length,2);assert.equal(f.providerCalls[2].sessionScope.gameId,'battle-next');f.controller.stop();await f.controller.drain();
  const reused=fixture({mainDecisionProvider:main,providerHook:(_r,p)=>({...p,decisionProvider:main})});const start=reused.controller.startIdle(snapshot());assert.equal((await start.completion).code,'PONDER_PROVIDER');assert.equal(reused.providerCalls.length,0);reused.controller.stop();await reused.controller.drain();
});

test('game/set close cancels background work and leaves no executable candidate or automatic restart',async()=>{
  const entered=deferred(),decision=deferred(),f=fixture({callDecision:input=>{entered.resolve(input);return decision.promise;}}),source=snapshot(),start=f.controller.startIdle(source),request=await entered.promise;
  f.controller.stop('set-closed');assert.equal(request.signal.aborted,true);assert.equal(f.controller.startIdle(source).reason,'closed');decision.resolve({decision:output()});assert.equal((await start.completion).status,'discarded');assert.equal(f.controller.getCandidate({source:source.source,facts:source.facts}),null);await f.controller.drain();
});

test('the original background ceiling cancels an uncooperative provider without touching main work',async()=>{
  const timers=[],entered=deferred(),decision=deferred();
  const f=fixture({setTimer:(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{if(timer)timer.cleared=true;},
    callDecision:input=>{entered.resolve(input);return decision.promise;}}),source=snapshot(),start=f.controller.startIdle(source),request=await entered.promise;
  const expiry=timers.find(timer=>timer.delay===45000);assert(expiry);f.setTime(46000);expiry.callback();
  assert.equal(request.signal.aborted,true);assert.equal(f.controller.status().active,false);assert.equal(f.controller.status().preempted,1);
  decision.resolve({decision:output()});assert.equal((await start.completion).status,'discarded');assert.equal(f.controller.startIdle(source).reason,'source-already-pondered');
  f.controller.stop();await f.controller.drain();
});

test('an aborted provider cannot be reused while its earlier cleanup is unresolved',async()=>{
  const entered=deferred(),decision=deferred(),closing=deferred();let firstProvider;
  const f=fixture({providerHook:(_r,provider)=>firstProvider??=provider,closeHook:()=>closing.promise,callDecision:input=>{entered.resolve(input);return decision.promise;}}),source=snapshot(),first=f.controller.startIdle(source);await entered.promise;
  f.controller.observe({...source,mainBusy:true});await tick();const next={...source,source:{...source.source,sourceSha256:'1'.repeat(64)}};
  const second=f.controller.startIdle(next);assert.equal((await second.completion).code,'PONDER_PROVIDER');assert.equal(f.providerCalls.length,1);
  decision.resolve({decision:output()});assert.equal((await first.completion).status,'discarded');closing.resolve();f.controller.stop();await f.controller.drain();assert.equal(f.closed.length,1);
});

test('native refusals and argument refusals remain distinct from sampled results and do not rewrite model inputs',async()=>{
  const actual={isError:true,content:[{type:'text',text:'Frozen simulation state is unsupported'}]},f=fixture({executeReadOnly:async()=>actual,callDecision:async input=>{
    const authored={name:'Fixture'},before=clone(authored);assert.deepEqual(await input.modelTools.call({name:'simulate_turn',callId:'unsupported',arguments:authored}),actual);assert.deepEqual(authored,before);
    const invalid=await input.modelTools.call({name:'simulate_turn',callId:'invalid',arguments:{value:'bad'}});assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.backendCalled,false);
    return {decision:output()};
  }}),source=snapshot();assert.equal((await f.controller.startIdle(source).completion).status,'completed');
  const notes=f.controller.getCandidate({source:source.source,facts:source.facts});assert.deepEqual(notes.toolAudit.map(call=>call.status),['refused','invalid-arguments']);assert.equal(f.nativeCalls.length,1);
  assert.equal(f.events.filter(event=>event.name==='ponder.tool-started').length,2);assert.equal(f.events.filter(event=>event.name==='ponder.tool-completed').length,2);f.controller.stop();await f.controller.drain();
});

test('a model-authored dependency absent from the frozen facts cannot become a usable candidate',async()=>{
  for(const path of ['/missing','/ponderFacts/weather','/actors/0/hp','/a~2b']){
    const authored=output();authored.proposals[0].factPaths=[path];const before=clone(authored),f=fixture({callDecision:async()=>({decision:authored})}),source=snapshot();
    assert.equal((await f.controller.startIdle(source).completion).code,'PONDER_DEPENDENCY',path);assert.deepEqual(authored,before);assert.equal(f.controller.getCandidate({source:source.source,facts:source.facts}),null);f.controller.stop();await f.controller.drain();
  }
});

test('top-level dependencies bind every descendant while unrelated current facts grant no action authority',async()=>{
  const f=fixture({callDecision:async()=>{const answer=output();answer.proposals[0].factPaths=['/actors'];return {decision:answer};}}),source=snapshot();
  assert.equal((await f.controller.startIdle(source).completion).status,'completed');
  const fresh={source:{...source.source,sourceSha256:'c'.repeat(64)},facts:{...clone(source.facts),weather:'sun'}},notes=f.controller.getCandidate(fresh);
  assert(notes);assert.deepEqual(notes.dependencies.map(row=>row.path),['/actors']);assert.equal(notes.goalPassed,false);assert.equal(notes.serverAcceptance,false);assert.equal(notes.requiresFreshMaterialChecks,true);assert.equal(Object.hasOwn(notes,'actions'),false);
  const changed=clone(fresh);changed.facts.actors[0].ability='Changed';assert.equal(f.controller.getCandidate(changed),null,'A changed descendant invalidates its entire selected ancestor.');
  f.controller.stop();await f.controller.drain();
});

test('root dependency is explicitly advertised and conservatively invalidates notes on any changed frozen fact',async()=>{
  assert.deepEqual(PONDER_OUTPUT_SCHEMA.properties.proposals.items.properties.factPaths.items.enum,['']);
  const f=fixture({callDecision:async input=>{assert(JSON.parse(input.input).factPathCatalog.paths.includes(''));const answer=output();answer.proposals[0].factPaths=[''];return {decision:answer};}}),source=snapshot();
  assert.equal((await f.controller.startIdle(source).completion).status,'completed');assert(f.controller.getCandidate({source:source.source,facts:clone(source.facts)}));
  assert.equal(f.controller.getCandidate({source:source.source,facts:{...clone(source.facts),unrelated:'changed'}}),null);f.controller.stop();await f.controller.drain();
});

test('catalog JSON-pointer escaping is exact and preparation does not extend the original background deadline',async()=>{
  const source=snapshot();Object.assign(source.facts,{'a/b':{value:1},'~key':2,'':true});const before=clone(source);
  const f=fixture({prepareHook:(_request,context)=>{f.setTime(1100);return context;},callDecision:async input=>{
    assert.equal(input.deadlineAt,46000);assert.equal(input.deadlineAt,f.prepared[0].deadlineAt);
    const catalog=JSON.parse(input.input).factPathCatalog;assert.equal(catalog.pointerRoot,'ponderFacts');assert.deepEqual(catalog.paths,['','/','/a~1b','/actors','/unrelated','/weather','/~0key']);
    assert.deepEqual(catalog,f.prepared[0].factPathCatalog);assert.deepEqual(input.schema,f.prepared[0].schema);assert.deepEqual(input.schema.properties.proposals.items.properties.factPaths.items.enum,catalog.paths);
    const answer=output();answer.proposals[0].factPaths=['/a~1b','/~0key','/'];return {decision:answer};
  }});
  assert.equal((await f.controller.startIdle(source).completion).status,'completed');assert.deepEqual(source,before);
  assert(f.controller.getCandidate({source:source.source,facts:clone(source.facts)}));const changed=clone(source.facts);changed['a/b'].value=2;assert.equal(f.controller.getCandidate({source:source.source,facts:changed}),null);
  f.controller.stop();await f.controller.drain();
});

test('large top-level catalogs stay bounded and the root still covers omitted facts',async()=>{
  const source=snapshot();source.facts=Object.fromEntries(Array.from({length:100},(_,i)=>['key'+String(i).padStart(3,'0'),{value:i}]));
  const f=fixture({callDecision:async input=>{const catalog=JSON.parse(input.input).factPathCatalog;assert.equal(catalog.paths.length,64);assert.equal(catalog.omittedTopLevelPaths,37);assert(Buffer.byteLength(JSON.stringify(catalog))<4096);assert.deepEqual(input.schema.properties.proposals.items.properties.factPaths.items.enum,catalog.paths);
    const answer=output();answer.proposals[0].factPaths=[''];return {decision:answer};}});
  assert.equal((await f.controller.startIdle(source).completion).status,'completed');const changed=clone(source.facts);changed.key099.value++;assert.equal(f.controller.getCandidate({source:source.source,facts:changed}),null);f.controller.stop();await f.controller.drain();
});

test('catalog/schema disagreement or added metadata exceeding the complete packet budget refuses before generation',async()=>{
  const bad=fixture({prepareHook:(_request,context)=>{const payload=JSON.parse(context.input);payload.factPathCatalog={paths:['/invented']};context.input=JSON.stringify(payload);return context;}});
  assert.equal((await bad.controller.startIdle(snapshot()).completion).code,'PONDER_CONTEXT');assert.equal(bad.providerCalls.length,0);bad.controller.stop();await bad.controller.drain();
  const baseline=fixture();await baseline.controller.startIdle(snapshot()).completion;const sent=baseline.providerCalls[0],size=Buffer.byteLength(sent.input)+Buffer.byteLength(sent.instructions)-2+Buffer.byteLength(JSON.stringify(sent.schema));baseline.controller.stop();await baseline.controller.drain();
  const bounded=fixture({limits:{maxInputBytes:size-1}});assert.equal((await bounded.controller.startIdle(snapshot()).completion).code,'PONDER_CONTEXT');assert.equal(bounded.providerCalls.length,0);bounded.controller.stop();await bounded.controller.drain();
});

test('the compact simulation facade receives only model-authored pairs and does not require legacy reconstruction fields',async()=>{
  const args={ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:2}],opposingActions:[{type:'move',slot:1,target:2},{type:'move',slot:2}]};
  const f=fixture({prepareHook:(_r,context)=>{context.catalog=[{name:'simulate_choices',description:'Read-only compact paired simulation.',inputSchema:{type:'object',properties:{ourActions:{type:'array'},opposingActions:{type:'array'}},required:['ourActions','opposingActions'],additionalProperties:false}}];return context;},
    executeReadOnly:async request=>{assert.deepEqual(request.arguments,args);return {sampled:true,assumptions:['Adapter-supplied labeled hypotheses.']};},
    callDecision:async input=>{assert.match(input.instructions,/prefer its compact interface/u);assert(!input.instructions.includes('author every question, hypothesis'));
      const result=await input.modelTools.call({name:'simulate_choices',callId:'compact-pair',arguments:args});assert.equal(result.sampled,true);return {decision:output()};}});
  assert.equal((await f.controller.startIdle(snapshot()).completion).status,'completed');assert.equal(f.nativeCalls.length,1);f.controller.stop();await f.controller.drain();
});

test('known numerical battle-readonly tools may retain evidence-writing metadata while mutation capabilities remain unavailable',async()=>{
  const f=fixture({prepareHook:(_r,context)=>{context.catalog=[{name:'calculate_speed',description:'Actual native Speed check.',inputSchema:{type:'object',properties:{name:{type:'string'}}},annotations:{readOnlyHint:false,idempotentHint:false}}];return context;},
    callDecision:async input=>{await input.modelTools.call({name:'calculate_speed',callId:'speed',arguments:{name:'Fixture'}});return {decision:output()};}});
  assert.equal((await f.controller.startIdle(snapshot()).completion).status,'completed');assert.equal(f.nativeCalls[0].name,'calculate_speed');f.controller.stop();await f.controller.drain();
});
