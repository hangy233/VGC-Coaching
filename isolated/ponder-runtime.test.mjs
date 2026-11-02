// Fakes only: no CLI, login, model, network or actual MCP process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBattlePonderRuntime} from './ponder-runtime.mjs';
import {PONDER_PROFILE} from './ponder-controller.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {digest} from '../planning/identity.mjs';
import {z} from 'zod';
import {simulationChoicesToolSchema} from '../simulation/choice-schemas.mjs';
import {preparePonderAnalysis} from './ponder-evidence.mjs';
import {createModelTraceStore} from './runner.mjs';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const skill=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE),clone=value=>structuredClone(value),tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const SESSION='ponder-runtime-fixture',TEAM='a'.repeat(64),ROOM='battle-gen9championsvgc2026regmcbo3-102',PARENT='game-bestof3-gen9championsvgc2026regmcbo3-101',TOKEN='b'.repeat(64),FREEZE='11111111-1111-4111-8111-111111111111';
const actions=[{type:'move',slot:1,target:1},{type:'move',slot:2}];
const result=()=>({summary:'Wait-time hypotheses only.',proposals:[{label:'Potential branch',idea:'Reconsider this branch under the fresh board.',assumptions:['Same rain condition.'],questions:['What did the opponent reveal?'],factPaths:['/board']}],limitations:['No fresh material check is established.']});
function nativeTools(){return ['get_pokemon','calculate_damage','calculate_damage_range','calculate_speed','simulate_choices','simulate_turn','battle_check_plan','battle_forfeit'].map(name=>({name,description:'Native fixture '+name,annotations:{readOnlyHint:name!=='calculate_speed'},inputSchema:{type:'object',properties:{gen:{type:'integer'},name:{type:'string'},ourActions:{type:'array'},opposingActions:{type:'array'},source:{type:'object'},analysis:{type:'string'},freezeId:{type:'string'},evidenceContext:{type:'object'}},additionalProperties:false}}));}
function projected(tool){const inputSchema=clone(tool.inputSchema);for(const field of ['source','analysis','freezeId','evidenceContext'])delete inputSchema.properties[field];return {name:tool.name,description:tool.description,inputSchema};}
function sourceView({rqid=4,token=TOKEN,room=ROOM}={}){
  const pokemon=['A','B','C','D'].map((name,index)=>({ident:'p1: '+name,details:name+', L50',condition:'100/100',active:index<2}));
  const legal={pokemon,active:[0,1].map(()=>({moves:[{move:'Attack',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]}))};
  const binding={sessionId:SESSION,teamId:TEAM,room,parentId:PARENT,rqid,revision:6,kind:'turn',token,boardHash:'c'.repeat(64),legalHash:'d'.repeat(64)};binding.requestDigest=digest(binding);
  const payload={kind:'turn',board:{turn:1,field:{weather:'rain'}},actors:[{id:'p1-1',hp:100}],ownTeam:[],opponentSheet:[],matchupSkill:skill};
  const context={binding,input:JSON.stringify(payload),sourcePayload:payload,instructions:'Main model protocol.',schema:{type:'object'}};
  const state={sessionId:SESSION,teamSha256:TEAM,connected:true,authenticated:true,stopped:false,actions:[{kind:'turn',room,parentId:PARENT,rqid,revision:6,token,legalActions:legal}],rooms:[{id:room,parentId:PARENT,ended:false},{id:PARENT,ended:false}]};
  return{context,state,decision:{actions:clone(actions),planUpdate:{objective:'Model-authored pair.'},reason:'Fixture'}};
}
function waiting(view,patch={}){
  const b=view.context.binding,source={sessionId:b.sessionId,teamId:b.teamId,room:b.room,rqid:b.rqid,token:b.token};
  return {...clone(view.state),actions:[],choices:[{room:b.room,rqid:b.rqid,actions:clone(actions),status:'sent',evidence:[],boundary:null,frozenSimulation:{freezeId:FREEZE,source,frozenAt:900,choiceAuthority:false}}],...patch};
}
function fixture({callDecision=async()=>({decision:result()}),callNative=async()=>({structuredContent:{gen:0,range:[1,2]}}),list=nativeTools(),preflight,close,providerOverride,toolDefinition=projected}={}){
  const events=[],calls=[],models=[],preflights=[],closes=[],factories=[];let time=1000,lists=0;
  const main={kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision(){assert.fail('Main provider cannot be called by pondering');}};
  const provider={contextMode:'session',decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:async input=>{models.push(input);return callDecision(input);}},preflight:async()=>{preflights.push(time);await preflight?.();return{authMode:'chatgpt',model:'gpt-6.1-sol',reasoningEffort:'low',requestedServiceTier:'fast'};},close:async()=>{closes.push(time);return close?.();}};
  const runtime=createBattlePonderRuntime({workspace:'E:/projects/VGC-Coaching',profile:PONDER_PROFILE,mainDecisionProvider:main,now:()=>time,...(toolDefinition?{toolDefinition}:{}),onEvent:event=>events.push(event),
    nativeClient:{listTools:async()=>{lists++;return{tools:clone(list)};},callTool:async(request,_schema,options)=>{calls.push({request:clone(request),options});return callNative(request,options);}},
    providerFactory:options=>{factories.push(options);return providerOverride?.(provider,main)??provider;}});
  const until=async name=>{for(let i=0;i<40&&!events.some(event=>event.name===name);i++)await tick();assert(events.some(event=>event.name===name),'Missing event '+name);};
  return{runtime,events,calls,models,preflights,closes,factories,provider,main,get lists(){return lists;},until,setTime:value=>{time=value;}};
}

test('real trace writer archives runtime returned, native-error, numeric-code, DOM-abort, canceled and empty journals',async t=>{
  const base=fileURLToPath(new URL('../cache/isolated-test-fixtures/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'runtime-trace-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const kind of ['returned','returned-error','numeric','dom','canceled','empty']){
    const entered=deferred();let f;
    f=fixture({callNative:async(_request,options)=>{
      if(kind==='numeric')throw Object.assign(new Error('Native fixture failure'),{code:-32000});
      if(kind==='dom')throw new DOMException('Native fixture aborted','AbortError');
      if(kind==='canceled')return new Promise((_resolve,reject)=>{entered.resolve();options.signal.addEventListener('abort',()=>reject(new DOMException('Native fixture preempted','AbortError')),{once:true});});
      return {isError:kind==='returned-error',structuredContent:{fixtureOnly:true,gen:0,range:[1,2]}};
    },callDecision:async input=>{if(kind!=='empty')await input.modelTools.call({name:'calculate_damage',callId:'fixture-'+kind,arguments:{name:'Fixture'}});return{decision:result()};}});
    await f.runtime.prepare();const view=sourceView();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));
    if(kind==='canceled'){await entered.promise;f.runtime.observeState(view.state);await f.until('ponder.discarded');}else await f.until('ponder.completed');
    f.runtime.stop();await f.runtime.drain();const status=f.runtime.status(),journal=f.runtime.privateEvidence();
    const analysis={version:1,frozenOnly:true,noCurrentAuthority:true,actualSDKReceiptsNotMinted:true,capturedAt:1000,
      settlement:{runtimeStopped:status.closed,shadowModelPending:status.shadowModelPending,shadowClosePending:status.shadowClosePending,shadowPreflightPending:status.shadowPreflightPending,providerCleanupPending:status.core.cleanupPending>0,nativeCallsPending:status.nativeCallsPending},journal};
    const directory=join(root,kind);await mkdir(directory);const trace=createModelTraceStore({workspace:directory,teamId:TEAM});
    const receipt=await trace.append({phase:'ponder-analysis',binding:{teamId:TEAM,parentId:PARENT},analysis});
    const saved=JSON.parse(await readFile(join(directory,receipt.path),'utf8')).entries[0].analysis;
    assert.equal(trace.status().failed,false,kind);assert.equal(saved.actualSDKReceiptsNotMinted,true);assert.equal(saved.noCurrentAuthority,true);assert.equal(saved.journal.records.length,kind==='empty'?0:1);
    if(kind!=='empty'){
      const row=saved.journal.records[0];assert.equal(row.outcome,['numeric','dom','canceled'].includes(kind)?'unavailable':kind);
      if(kind==='numeric')assert.equal(row.code,-32000);
      if(['dom','canceled'].includes(kind))assert.equal(row.code,20);
      if(['numeric','dom','canceled'].includes(kind))assert.equal(Object.hasOwn(row,'nativeResult'),false);
    }
    const text=JSON.stringify(saved);for(const secret of [SESSION,TOKEN,FREEZE])assert(!text.includes(secret),kind+' '+secret);
  }
});

test('prepare caches the compact native catalog and preflights only the separate shadow without generating',async()=>{
  const f=fixture(),first=await f.runtime.prepare(),second=await f.runtime.prepare();assert.deepEqual(first,second);assert.equal(f.lists,1);assert.equal(f.preflights.length,1);assert.equal(f.models.length,0);assert.equal(f.calls.length,0);
  assert(first.tools.includes('simulate_choices'));assert(!first.tools.includes('simulate_turn'));assert(!first.tools.includes('battle_check_plan'));assert(!first.tools.includes('battle_forfeit'));
  assert.deepEqual(Object.fromEntries(['model','reasoningEffort','contextMode','serviceTier'].map(key=>[key,f.factories[0][key]])),{model:'gpt-6.1-sol',reasoningEffort:'low',contextMode:'session',serviceTier:'fast'});
  f.runtime.stop();await f.runtime.drain();
});

test('frozen range callback binds gen0, rejects spoofed generation and discards late numerical returns',async()=>{
  for(const late of [false,true]){
    let f;f=fixture({callNative:async request=>{assert.equal(request.name,'calculate_damage_range');assert.equal(request.arguments.gen,0);assert.equal(request.arguments.evidenceContext,undefined);if(late)f.setTime(6000);return{structuredContent:{kind:'champions-damage-range-v1',gen:0,status:'partial-candidate-envelope',coverage:{exhaustive:false},damageRange:{min:10,max:20}}};},callDecision:async input=>{
      assert(input.modelTools.definitions.some(t=>t.name==='calculate_damage_range'));
      const spoof=await input.modelTools.call({name:'calculate_damage_range',callId:'spoof',arguments:{gen:9,name:'Fixture'}});assert.equal(spoof.isError,true);
      const answer=await input.modelTools.call({name:'calculate_damage_range',callId:'range',arguments:{name:'Fixture'}});assert.equal(answer.isError===true,late);return{decision:result()};}});
    await f.runtime.prepare();const view=sourceView();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');
    assert.equal(f.calls.length,1);f.runtime.stop();await f.runtime.drain();const rows=f.runtime.privateEvidence().records;assert.equal(rows.length,1);assert.equal(rows[0].outcome,late?'unavailable':'returned');assert.equal(rows[0].liveFreshness,false);assert.equal(rows[0].choiceAuthority,false);assert.equal(Object.hasOwn(rows[0],'modelResult'),!late);
  }
});

test('the maintained default catalog projector hides frozen-source fields from the model',async()=>{
  const f=fixture({toolDefinition:null,callDecision:async input=>{
    const schema=input.modelTools.definitions.find(tool=>tool.name==='simulate_choices').inputSchema;
    for(const name of ['source','analysis','freezeId','evidenceContext'])assert.equal(schema.properties[name],undefined);
    assert(schema.properties.ourActions);assert(schema.properties.opposingActions);return{decision:result()};}});
  await f.runtime.prepare();const view=sourceView();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');assert.equal(f.models.length,1);f.runtime.stop();await f.runtime.drain();
});

test('default projection and the real native compact schema accept frozen evidence binding from a model-only pair',async()=>{
  const native={name:'simulate_choices',description:'Native compact facade.',annotations:{readOnlyHint:true},inputSchema:z.toJSONSchema(simulationChoicesToolSchema,{target:'draft-7'})};
  const authored={ourActions:clone(actions),opposingActions:clone(actions)};let parsed;
  const f=fixture({list:[native],toolDefinition:null,callNative:async request=>{parsed=simulationChoicesToolSchema.parse(request.arguments);assert.equal(parsed.analysis,'frozen');assert.deepEqual(parsed.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});return{structuredContent:{kind:'native-choice-simulation-v1',source:{liveFreshness:false,choiceAuthority:false},coverage:{tacticalGoalEvaluated:false}}};},
    callDecision:async input=>{const schema=input.modelTools.definitions[0].inputSchema;assert(!schema.required.includes('source'));assert(!schema.properties.evidenceContext);const answer=await input.modelTools.call({name:'simulate_choices',callId:'real-schema',arguments:authored});assert.equal(answer.structuredContent.source.liveFreshness,false);return{decision:result()};}});
  await f.runtime.prepare();const view=sourceView();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');assert(parsed);assert.deepEqual(parsed.ourActions,authored.ourActions);assert.deepEqual(parsed.opposingActions,authored.opposingActions);assert.equal(f.calls.length,1);f.runtime.stop();await f.runtime.drain();
  const status=f.runtime.status(),saved=preparePonderAnalysis({version:1,frozenOnly:true,noCurrentAuthority:true,actualSDKReceiptsNotMinted:true,capturedAt:1000,settlement:{runtimeStopped:status.closed,shadowModelPending:status.shadowModelPending,shadowClosePending:status.shadowClosePending,shadowPreflightPending:status.shadowPreflightPending,providerCleanupPending:status.core.cleanupPending>0,nativeCallsPending:status.nativeCallsPending},journal:f.runtime.privateEvidence()},{teamId:TEAM,parentId:PARENT});
  assert.equal(saved.completeAtCapture,true);assert.deepEqual(saved.journal.records[0].input.ourActions,authored.ourActions);assert.equal(saved.actualSDKReceiptsNotMinted,true);assert.equal(JSON.stringify(status).includes(TOKEN),false);assert.equal(JSON.stringify(status).includes(SESSION),false);
});

test('missing compact simulation, mismatched profile, and main-provider reuse fail before any model call',async()=>{
  const missing=fixture({list:nativeTools().filter(tool=>tool.name!=='simulate_choices')});await assert.rejects(missing.runtime.prepare(),{code:'PONDER_COMPACT_TOOL_REQUIRED'});assert.equal(missing.preflights.length,0);assert.equal(missing.models.length,0);missing.runtime.stop();
  const same=fixture({providerOverride:(provider,main)=>({...provider,decisionProvider:main})});await assert.rejects(same.runtime.prepare(),{code:'PONDER_PROVIDER'});assert.equal(same.closes.length,0);assert.equal(same.models.length,0);same.runtime.stop();
  assert.throws(()=>createBattlePonderRuntime({workspace:'E:/projects/VGC-Coaching',profile:{...PONDER_PROFILE,reasoningEffort:'high'},nativeClient:{listTools(){},callTool(){}}}),{code:'PONDER_PROFILE'});
});

test('only native committed wait schedules work; observers perform no immediate model or MCP operations',async()=>{
  const f=fixture(),view=sourceView();await f.runtime.prepare();assert.equal(f.runtime.setDecisionContext(view).decisionAttached,true);
  assert.equal(f.runtime.observeState(view.state).reason,'fresh-own-request');assert.equal(f.models.length,0);
  const state=waiting(view),admitted=f.runtime.observeState(state);assert.equal(admitted.scheduled,true);assert.equal(f.models.length,0);assert.equal(f.calls.length,0);
  await f.until('ponder.completed');assert.equal(f.models.length,1);const input=JSON.parse(f.models[0].input);assert.deepEqual(input.matchupSkill,skill);assert.deepEqual(input.alreadyCommittedActions,actions);assert.equal(input.commitObservation.serverAcceptance,false);
  f.runtime.observeState(state);await tick();assert.equal(f.models.length,1);f.runtime.stop();await f.runtime.drain();
});

test('active owned-set reservation permits pondering while queued, unknown, foreign and ambiguous searches refuse',async()=>{
  for(const games of [{[PARENT]:'Owned parent',[ROOM]:'Owned child'},{[PARENT+'-privatepw']:'Owned parent',[ROOM+'-privatepw']:'Owned child'},{[PARENT]:'Owned parent'}]){
    const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);const state=waiting(view,{searchPending:true,search:{searching:[],games}});assert.equal(f.runtime.observeState(state).eligible,true);await f.until('ponder.completed');assert.equal(f.models.length,1);f.runtime.stop();await f.runtime.drain();
  }
  for(const patch of [{searchPending:true},{searchPending:true,search:{searching:[],games:{}}},{searchPending:true,search:{searching:['gen9championsvgc2026regmcbo3'],games:{[PARENT]:'Owned'}}},{searchPending:true,search:{searching:[],games:{[PARENT]:'Owned',[ROOM+'1']:'Foreign child'}}},{searchPending:true,search:{searching:[],games:{[PARENT]:'Owned',[PARENT+'-aliaspw']:'Duplicate alias'}}},{searchPending:true,search:{searching:[],games:{[PARENT]:'Owned'}},awaitingSet:true}]){
    const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);assert.equal(f.runtime.observeState(waiting(view,patch)).eligible,false);await tick();assert.equal(f.models.length,0);f.runtime.stop();await f.runtime.drain();
  }
});

test('frozen callbacks preserve authored pairs, bind exact native freeze, omit current numeric evidence and redact private values',async()=>{
  const pair={ourActions:clone(actions),opposingActions:clone(actions)};
  const f=fixture({callNative:async request=>({structuredContent:{gen:0,range:[1,2],source:request.arguments.source,freezeId:request.arguments.freezeId}}),callDecision:async input=>{
    const sim=await input.modelTools.call({name:'simulate_choices',callId:'paired',arguments:pair});assert(!JSON.stringify(sim).includes(TOKEN));assert(!JSON.stringify(sim).includes(SESSION));assert(!JSON.stringify(sim).includes(FREEZE));assert.deepEqual(sim.structuredContent.range,[1,2]);
    await input.modelTools.call({name:'calculate_damage',callId:'damage',arguments:{name:'Fixture'}});await input.modelTools.call({name:'calculate_speed',callId:'speed',arguments:{gen:0,name:'Fixture'}});return{decision:result()};}});
  await f.runtime.prepare();const view=sourceView();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');
  const args=f.calls[0].request.arguments;assert.deepEqual(args.ourActions,pair.ourActions);assert.deepEqual(args.opposingActions,pair.opposingActions);assert.equal(args.analysis,'frozen');assert.equal(args.freezeId,FREEZE);assert.deepEqual(args.source,waiting(view).choices[0].frozenSimulation.source);
  assert.deepEqual(args.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});assert(f.runtime.status().nativeJournal.every(row=>row.evidenceScope==='frozen-pre-submission-only'));
  for(const call of f.calls.slice(1)){assert.equal(call.request.arguments.gen,0);assert.equal(call.request.arguments.evidenceContext,undefined);assert.equal(call.request.arguments.source,undefined);assert(call.options.signal instanceof AbortSignal);}
  assert(f.runtime.status().nativeJournal.every(row=>row.analysis==='frozen'&&row.liveFreshness===false&&row.choiceAuthority===false&&row.timely));
  f.runtime.stop();await f.runtime.drain();
});

test('execution proof, uncertainty, fresh requests and ready immediately invalidate an active or scheduled ponder',async()=>{
  for(const mutate of [s=>{s.choices[0].evidence=[{executed:true}];},s=>{s.choices[0].status='execution-observed';},s=>{s.choices[0].boundary='next-request';},s=>{s.choices[0].status='uncertain';},s=>{s.actions=[{kind:'ready'}];}]){
    const entered=deferred(),done=deferred(),f=fixture({callDecision:input=>{entered.resolve(input);return done.promise;}}),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);const state=waiting(view);f.runtime.observeState(state);const input=await entered.promise;const fresh=clone(state);mutate(fresh);assert.equal(f.runtime.observeState(fresh).eligible,false);assert.equal(input.signal.aborted,true);assert.equal(f.runtime.status().core.active,false);done.resolve({decision:result()});await f.until('ponder.discarded');f.runtime.stop();await f.runtime.drain();
  }
  const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));f.runtime.setMainBusy(true);await tick();assert.equal(f.models.length,0);f.runtime.stop();await f.runtime.drain();
});

test('freeze/source/pair mismatches and absent model decision cannot trigger background generation',async()=>{
  for(const mutate of [s=>{s.choices[0].frozenSimulation.source.token='e'.repeat(64);},s=>{s.choices[0].frozenSimulation.source.room=ROOM+'1';},s=>{s.choices[0].actions[0].target=2;},s=>{s.choices[0].frozenSimulation=null;},s=>{s.choices[0].evidence=undefined;}]){
    const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);const state=waiting(view);mutate(state);assert.equal(f.runtime.observeState(state).eligible,false);await tick();assert.equal(f.models.length,0);f.runtime.stop();await f.runtime.drain();
  }
  const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext({context:view.context,state:view.state});assert.equal(f.runtime.observeState(waiting(view)).eligible,false);assert.equal(f.models.length,0);f.runtime.stop();await f.runtime.drain();
});

test('completed notes require fresh same-game facts and remain speculative instead of current numerical evidence',async()=>{
  const f=fixture(),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');
  const fresh=sourceView({rqid:6,token:'f'.repeat(64)}),notes=f.runtime.notesFor(fresh);assert(notes);assert.equal(notes.speculative,true);assert.equal(notes.requiresFreshMaterialChecks,true);assert.equal(notes.goalPassed,false);assert.equal(notes.serverAcceptance,false);assert.equal(notes.source.sessionId,undefined);assert(!JSON.stringify(notes).includes(TOKEN));
  const changed=clone(fresh);changed.context.sourcePayload.board.field.weather='sun';changed.context.input=JSON.stringify(changed.context.sourcePayload);assert.equal(f.runtime.notesFor(changed),null);
  const nextGame=sourceView({room:ROOM+'1'});assert.equal(f.runtime.notesFor(nextGame),null);f.runtime.stop();await f.runtime.drain();
});

test('preflight happens once across cancellation and new leases; fresh main never waits for shadow cleanup',async()=>{
  const first=deferred(),firstEntered=deferred(),closing=deferred();let count=0;
  const f=fixture({close:()=>closing.promise,callDecision:input=>{if(++count===1){firstEntered.resolve(input);return first.promise;}return {decision:result()};}}),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));const input=await firstEntered.promise;
  f.runtime.setMainBusy(true);assert.equal(input.signal.aborted,true);assert.equal(f.runtime.status().core.active,false);await tick();assert.equal(f.closes.length,1);
  const next=sourceView({rqid:6,token:'f'.repeat(64)}),nextWait=waiting(next);nextWait.choices[0].frozenSimulation.freezeId='22222222-2222-4222-8222-222222222222';
  f.runtime.setDecisionContext(next);f.runtime.observeState(nextWait);f.runtime.setMainBusy(false);await tick();assert.equal(f.models.length,1);
  closing.resolve();first.resolve({decision:result()});await f.until('ponder.completed');assert.equal(f.models.length,2);assert.equal(f.preflights.length,1);assert.equal(f.factories.length,1);f.runtime.stop();await f.runtime.drain();
});

test('uncertain shadow close disables further pondering without blocking or touching main',async()=>{
  const entered=deferred(),done=deferred(),f=fixture({close:()=>{throw Object.assign(new Error('Uncertain close'),{code:'termination_uncertain'});},callDecision:input=>{entered.resolve(input);return done.promise;}}),view=sourceView();await f.runtime.prepare();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await entered.promise;f.runtime.setMainBusy(true);await tick();assert.equal(f.runtime.status().blocked,'PONDER_SHADOW_CLOSE_UNCERTAIN');
  done.resolve({decision:result()});await f.until('ponder.discarded');f.runtime.setMainBusy(false);assert.equal(f.runtime.observeState(waiting(view)).eligible,false);assert.equal(f.models.length,1);f.runtime.stop();await f.runtime.drain();
});

test('main-busy and stop return immediately during before-search shadow setup and no late setup can generate',async()=>{
  const setup=deferred(),f=fixture({preflight:()=>setup.promise}),preparing=f.runtime.prepare();await tick();assert.equal(f.runtime.status().shadowPreflightPending,true);
  f.runtime.setMainBusy(true);assert.equal(f.runtime.status().mainBusy,true);f.runtime.stop();assert.equal(f.models.length,0);assert.equal(f.runtime.status().closed,true);
  setup.resolve();await assert.rejects(preparing,{code:'PONDER_PROVIDER'});assert.equal(f.runtime.status().shadowPreflightPending,false);assert.equal(f.models.length,0);await f.runtime.drain();
});

test('a private room alias is preserved in frozen native source while notes use the same canonical game identity',async()=>{
  const privateRoom=ROOM+'-privatealiaspw',view=sourceView({room:privateRoom});
  view.context.binding.parentId=PARENT+'-parentaliaspw';view.context.binding.requestDigest=digest(view.context.binding);view.state.actions[0].parentId=view.context.binding.parentId;
  const f=fixture({callDecision:async input=>{await input.modelTools.call({name:'simulate_choices',callId:'private-pair',arguments:{ourActions:actions,opposingActions:actions}});return{decision:result()};}});
  await f.runtime.prepare();f.runtime.setDecisionContext(view);const state=waiting(view);f.runtime.observeState(state);await f.until('ponder.completed');assert.equal(f.calls[0].request.arguments.source.room,privateRoom);
  assert.deepEqual(f.calls[0].request.arguments.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});
  const fresh=sourceView({rqid:6,token:'f'.repeat(64),room:privateRoom});assert(f.runtime.notesFor(fresh));f.runtime.stop();await f.runtime.drain();
});

test('a maximum-sized native result remains in private evidence and cannot inflate the fresh model notes',async()=>{
  const native={structuredContent:{gen:0,padding:''}};native.structuredContent.padding='x'.repeat(2*1024*1024-Buffer.byteLength(JSON.stringify(native)));assert.equal(Buffer.byteLength(JSON.stringify(native)),2*1024*1024);
  const f=fixture({callNative:async()=>native,callDecision:async input=>{const response=await input.modelTools.call({name:'get_pokemon',callId:'max-result',arguments:{name:'Fixture'}});assert.equal(response.structuredContent.padding.length,native.structuredContent.padding.length);return{decision:result()};}}),view=sourceView();
  await f.runtime.prepare();f.runtime.setDecisionContext(view);f.runtime.observeState(waiting(view));await f.until('ponder.completed');const notes=f.runtime.notesFor(sourceView({rqid:6,token:'f'.repeat(64)}));assert(notes);assert(Buffer.byteLength(JSON.stringify(notes))<10000);assert.equal(notes.toolAudit,undefined);assert.equal(notes.toolResearch.length,1);assert.equal(notes.toolResearch[0].status,'returned');
  assert(!JSON.stringify(f.runtime.status()).includes('padding'));const evidence=f.runtime.privateEvidence();assert.equal(evidence.records.length,1);assert.deepEqual(evidence.records[0].nativeResult,native);assert.equal(evidence.complete,true);assert.equal(evidence.records[0].analysis,'frozen');f.runtime.stop();await f.runtime.drain();
});
