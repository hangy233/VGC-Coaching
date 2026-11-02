import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createNativeController} from './native-controller.mjs';
import {createOperator} from '../showdown/operator-client.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
const MATCHUP_GUIDANCE=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE);
const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
const names = ['Rillaboom','Incineroar','Farigiraf','Politoed','Hydreigon','Sylveon'];
const abilities = ['Grassy Surge','Intimidate','Armor Tail','Drizzle','Levitate','Pixilate'];
const teamText = names.map((name,index) => `${name}\nAbility: ${abilities[index]}\nLevel: 50\nAdamant Nature\n- Tackle\n- Growl\n- Rest\n- Protect`).join('\n\n');
const TEAM = createHash('sha256').update(Teams.pack(Teams.import(teamText))).digest('hex');
const SESSION = 'isolated-fixture',ROOM = 'battle-gen9championsvgc2026regmcbo3-606',PARENT = 'game-bestof3-gen9championsvgc2026regmcbo3-605';
const TOKEN = 'b'.repeat(64),LEASE = 'c'.repeat(64),UNRELATED_SECRET = 'fixture-unrelated-nonsecret';
const desktopDescriptor=callDecision=>({kind:'chatgpt-desktop',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision});
const sheet = names.map((species,index) => ({species,ability:abilities[index],nature:'Adamant',item:'',moves:['Tackle','Growl','Rest','Protect']}));
const moves = () => [{move:'Tackle',target:'normal',pp:20},{move:'Growl',target:'allAdjacentFoes',pp:20},{move:'Rest',target:'self',pp:10},{move:'Protect',target:'self',pp:10}];
const fallback = [{type:'move',slot:4,mega:false},{type:'move',slot:1,target:1,mega:false}];
const positive = [{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}];
function state({preview = false,replacement = false,ots = true} = {}) {
  const actor = (side,name,index) => ({id:`${side}-${index}`,nickname:name,species:name,activeSlot:index < 2 ? index + 1 : null,
    requestIndex:side === 'p1' ? index + 1 : null,identityConfidence:'confirmed',selection:'selected',hp:{current:100,max:100,precision:side === 'p1' ? 'server-own-exact' : 'server-display'},
    fainted:replacement&&side==='p1'&&index===0,boosts:{},status:null,ability:abilities[index],item:'',itemKnown:true,moves:[],volatiles:{}});
  const side = id => ({id,selectedTeamSize:preview ? null : 4,selectionKnowledge:id === 'p1' ? 'current-own-request' : 'observed-opponents-only',unrevealedSelected:0,
    active:[{slot:1,pokemon:`${id}-0`},{slot:2,pokemon:`${id}-1`}],reserves:preview ? names.slice(2).map((_,i) => `${id}-${i+2}`) : ['p1-2','p1-3'].map(value => value.replace('p1',id)),
    pokemon:names.slice(0,preview ? 6 : 4).map((name,index) => actor(id,name,index)),conditions:{}});
  const legalActions = {pokemon:names.slice(0,preview ? 6 : 4).map((name,index) => ({ident:`p1: ${name}`,details:`${name}, L50`,condition:'100/100',active:index < 2})),
    ...(preview ? {teamPreview:true,maxChosenTeamSize:4} : replacement ? {forceSwitch:[true,false]} : {active:[{moves:moves()},{moves:moves()}]})};
  if(replacement)legalActions.pokemon[0].condition='0 fnt';
  const action = {kind:preview ? 'preview' : replacement ? 'switch' : 'turn',room:ROOM,parentId:PARENT,rqid:4,revision:6,token:TOKEN,receivedAt:1000,actionable:true,legalActions};
  return {sessionId:SESSION,teamId:TEAM,connected:true,authenticated:true,stopped:false,revision:6,observedAt:1000,actions:[action],
    rooms:[{id:ROOM,parentId:PARENT,teamId:TEAM,ended:false},{id:PARENT,teamId:TEAM,ended:false}],search:{searching:[],games:{[ROOM]:true}},
    controlPolicy:{pending:[{room:ROOM,rqid:4,token:TOKEN,cutoffAt:30000}]},
    boards:[{room:ROOM,parentId:PARENT,turn:1,ownSide:'p1',request:{rqid:4},field:{weather:null,terrain:null,conditions:{}},sides:[side('p1'),side('p2')],
      recentEvents:{lines:['|turn|1']},...(ots ? {opponentSheets:{p2:structuredClone(sheet)}} : {})}]};
}
const decision=()=>({actions:structuredClone(fallback),planUpdate:{objective:'Preserve a useful paired action.',preserveIds:[],nextCondition:'Observe the reply.'},reason:'The selected model owns its final choice.'});
async function fixture(options = {}) {
  let time = Date.now(),current = state(options); const calls = [],events = [],evidence = [],commands = [];
  const modelTools=true,ownedControl=true;
  if(ownedControl)current.controller={required:true,owner:'Fixture',generation:1};
  const fixtureCutoff=time+(options.cutoffDelta ?? 29000);
  current.actions[0].receivedAt=time; current.controlPolicy.pending[0].cutoffAt=fixtureCutoff;
  if(options.autoReady!==undefined)current.autoReady=options.autoReady;
  let readyReads=0,child=0;
  function readyState(index){
    const value=state();value.autoReady=options.autoReady??false;value.actions=[{kind:'ready',room:PARENT,token:String(index+7).repeat(64)}];
    value.boards=[];value.rooms=[{id:PARENT,teamId:TEAM,ended:false}];value.controlPolicy={halted:false,pending:[]};value.revision=20+index;
    if(options.previousFinalSummary&&index>0){
      const ending=structuredClone(current.boards[0]);ending.ended=true;ending.result={type:'win',winner:'Fixture'};ending.turn=7;
      value.rooms.push({id:ROOM,parentId:PARENT,teamId:TEAM,ended:true,result:ending.result,state:ending,recentEvents:['|faint|p2a: Opponent','|win|Fixture']});
    }
    value.controller={required:true,owner:'Fixture',generation:1};return value;
  }
  function childState(preview,index){
    const value=state({preview}),room=index===0?ROOM:ROOM+'1',action=value.actions[0];
    value.autoReady=false;action.room=room;action.rqid=preview?2:4;action.token=String(index+4).repeat(63)+(preview?'a':'b');action.receivedAt=time;
    value.boards[0].room=room;value.boards[0].request.rqid=action.rqid;value.rooms[0].id=room;value.search.games={[room]:true};
    value.controlPolicy.pending=[{room,rqid:action.rqid,token:action.token,cutoffAt:fixtureCutoff}];value.controller={required:true,owner:'Fixture',generation:1};return value;
  }
  if(options.initialReady||options.manualReadyCycle)current=readyState(0);
  const raw = result => ({structuredContent:{ok:true,result}});
  const client = {async listTools(){calls.push({name:'listTools'});return {tools:['get_pokemon','get_move','calculate_damage','calculate_speed'].map(name=>({name,description:'Actual offline native SDK fixture '+name,inputSchema:{type:'object',properties:{gen:{type:'integer'},name:{type:'string'},attacker:{type:'string'},defender:{type:'string'},move:{type:'string'}},additionalProperties:true},annotations:{readOnlyHint:true}}))};},async callTool({name,arguments:args}) {
    calls.push({name,args:structuredClone(args)});
    if (name === 'battle_status') return raw({...structuredClone(current),teamSha256:TEAM,username:'Fixture',rooms:current.rooms.map(room => room.id === ROOM ? {...room,sheets:{p2:Teams.pack(sheet)}} : room)});
    if (name === 'battle_control_claim') return raw({controllerLease:LEASE,...(ownedControl?{required:true,owner:'Fixture',generation:1}:{})});
    if (name === 'battle_turn_status' || name === 'battle_wait') {
      if(name==='battle_wait'&&options.waitResult)return options.waitResult;
      if(name==='battle_turn_status'&&options.turnResult){const value=options.turnResult(current);if(value!==undefined)return value;}
      if(name==='battle_wait')options.beforeWait?.(current,{now:()=>time,setTime:value=>{time=value;},calls});
      if(name==='battle_turn_status')options.beforeTurnRead?.(current);
      if(name==='battle_turn_status'&&current.actions[0]?.kind==='ready'&&++readyReads===2){if(options.staleReady)current.actions[0].token='e'.repeat(64);options.beforeReadyRefresh?.(current);}
      const projected=structuredClone(current);options.projectRead?.(name,projected,current);
      return raw(projected);
    }
    if(name==='battle_ready'){
      if(options.readyUncertain)throw Error('Fixture ready outcome unknown');
      if(options.terminalRaceCycle)child=1;
      if(options.manualReadyCycle||options.terminalRaceCycle)current=childState(true,child);
      else if(!options.holdReady)current.actions=[];
      return raw({status:'sent-not-acknowledged',room:PARENT});
    }
    if (name === 'battle_stage_fallback') {
      if(options.stageUncertain){options.beforeStageError?.(current);throw Error('Fixture stage outcome unknown');}
      options.afterStage?.(current,{calls,setTime:value=>{time=value;}});
      if(options.stageMissing)return raw({pending:[]});
      return raw({pending:[{token:args.token,hasFallback:true,fallbackSource:'fallback',attempted:options.stageAttempted??false,cutoffAt:fixtureCutoff}]});
    }
    if (name === 'battle_choose') {
      if(options.chooseUncertain)throw Error('Fixture choose outcome unknown');
      const completed=calls.filter(row=>row.name==='battle_choose').length;
      if(options.manualReadyCycle||options.terminalRaceCycle){
        if(current.actions[0].kind==='preview')current=childState(false,child);
        else if(child===0){child++;current=readyState(child);}
        else{current.actions=[];current.search={searching:[],games:null};current.rooms.forEach(room=>{room.ended=true;if(room.id===PARENT)room.result={type:'win',winner:'Fixture'};});}
      }else if(options.advanceRequests&&completed<options.advanceRequests){
        current=state();const next=current.actions[0];next.rqid=4+completed*2;next.revision=6+completed;next.token=String(completed+1).repeat(64);next.receivedAt=time;
        if(ownedControl)current.controller={required:true,owner:'Fixture',generation:1};
        current.boards[0].turn=completed+1;current.boards[0].request.rqid=next.rqid;current.controlPolicy.pending=[{room:ROOM,rqid:next.rqid,token:next.token,cutoffAt:fixtureCutoff}];
        if(options.overflowOnRequest===completed+1)current.boards[0].sides[0].pokemon[0].volatiles={fixtureOversizedCurrentFact:Array.from({length:24},(_,index)=>`${index}:${'x'.repeat(1800)}`)};
      }else{current.actions=[];if(options.advanceRequests){current.search={searching:[],games:null};current.rooms.forEach(room=>{room.ended=true;if(room.id===PARENT)room.result={type:'win',winner:'Fixture'};});}}
      return raw({status:'sent-not-acknowledged'});
    }
    if (name === 'simulate_turn') {
      const result=simulationResult(args);
      if(options.negativeGate)for(const sample of result.samples)Object.assign(sample.gate,{passed:false,targetKOBeforeRetaliation:false});
      return options.rejectNative ? {structuredContent:{ok:false,error:'Fixture native refusal'}} : {structuredContent:result};
    }
    if(['get_pokemon','get_move'].includes(name))return {structuredContent:{fixtureNativeLookup:true,name:args.name,gen:args.gen,complete:'x'.repeat(3000)}};
    if (name === 'battle_check_plan') return {structuredContent:{ok:false,error:'Fixture delivery unavailable'}};
    if (['calculate_damage','calculate_speed'].includes(name)) {
      options.onNumericRead?.(name,args,current,{setTime:value=>{time=value;},calls});
      if(options.numericFailure)throw new Error('Fixture numeric calculator unavailable');
      const result=name==='calculate_damage'?{range:options.numericFalse?[120,140]:[20,40]}:
        {gen:0,format:'gen9championsvgc2026regmc',pokemon:[{label:'ours',effectiveSpeed:options.numericFalse?90:150,actionSpeed:options.numericFalse?90:150,orderingWarnings:[]},{label:'theirs',effectiveSpeed:100,actionSpeed:100,orderingWarnings:[]}]};
      return {structuredContent:{...result,...(options.numericMissingReceipt?{}:{calculationRef:{id:'00000000-0000-4000-8000-000000000091',teamId:TEAM,roomId:ROOM,tool:name,sha256:'d'.repeat(64),path:`cache/team-metrics/calculations/${TEAM}--00000000-0000-4000-8000-000000000091.json`}})}};
    }
    assert.fail(`Unexpected fixture tool ${name}`);
  }};
  const actual = createOperator({client,responseFile:'unused-isolated-controller-test.json',publish:async()=>{},now:() => time,readTimeoutMs:1000,mutationTimeoutMs:1000,
    ...(options.conditionalExecutionAdapter?{conditionalExecutionAdapter:options.conditionalExecutionAdapter}:{})});
  const operator = {async dispatch(q,opts) {commands.push(structuredClone(q));
    if(q.op==='checks-play-next'&&options.atomicTransportFailure==='throw')throw Error('Fixture unknown conditional transport failure');
    if(q.op==='checks-play-next'&&options.atomicTransportFailure==='plain')return {error:'Fixture untyped conditional failure',retry:false};
    const result=await actual.dispatch(q,opts);if(q.op==='checks-play-next')await options.afterAtomicRefusal?.(result,current,{setTime:value=>{time=value;},
      replaceStage:actions=>actual.dispatch({id:'fixture_changed_stage',op:'stage-next',room:ROOM,rqid:4,token:TOKEN,kind:'turn',actions})});return result;
  }};
  await operator.dispatch({id:'arm',op:'arm',confirmed:true,expectedSessionId:SESSION,expectedTeamId:TEAM,expectedAccount:'Fixture'});
  await operator.dispatch({id:'claim',op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:'fixture_claim',controllerId:'Fixture'}});
  const invokeDecision=async input => {
    assert.equal(input.model,'gpt-6.1-sol');assert.equal(input.reasoningEffort,'low');assert.equal(Object.hasOwn(input,'apiKey'),false);
    assert.deepEqual(JSON.parse(input.input).matchupSkill,MATCHUP_GUIDANCE,'Every controller model route receives the exact full native bundle');
    assert(!input.input.includes(TOKEN)); assert(!input.input.includes(UNRELATED_SECRET));
    if (options.callDecision) return options.callDecision(input,{setTime:value => {time=value;},current,calls,commands,evidence});
    return {decision:options.pick ?? decision(options),telemetry:{startedAt:time,completedAt:time}};
  };
  const controller = createNativeController({operator,identity:{sessionId:SESSION,teamId:TEAM,account:'Fixture'},ownTeamText:teamText,
    decisionProvider:{kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',callDecision:invokeDecision},
    skillVersion:ISOLATED_POLICY_SOURCE.skillVersion,skillSha256:ISOLATED_POLICY_SOURCE.skillSha256,matchupGuidance:MATCHUP_GUIDANCE,now:() => time,
    ...(options.useProductionDefaults?{}:{fastFirst:options.fastFirst??false}),
    ...(options.maxModelMs ? {maxModelMs:options.maxModelMs} : {}),
    ...(options.maxContextBytes?{maxContextBytes:options.maxContextBytes}:{}),
    ...(options.maxRichContextBytes?{maxRichContextBytes:options.maxRichContextBytes}:{}),
    ...(options.singleCallResearch!==undefined?{singleCallResearch:options.singleCallResearch}:{}),
    ...(options.singleCallResearchMinRemainingMs!==undefined?{singleCallResearchMinRemainingMs:options.singleCallResearchMinRemainingMs}:{}),
    ...(options.compactHostAdoption!==undefined?{compactHostAdoption:options.compactHostAdoption}:{}),
    ...(options.researchProvider!==undefined?{researchProvider:options.researchProvider}:{}),
    ...(options.genericHypothesisProvider!==undefined?{genericHypothesisProvider:options.genericHypothesisProvider}:{}),
    ...(options.manualReady!==undefined?{manualReady:options.manualReady}:{}),
    ...(options.previewClockWaitMs!==undefined?{previewClockWaitMs:options.previewClockWaitMs}:{}),
    onEvent:event => {events.push(event);options.onEvent?.(event,current);},onEvidence:async value => {if(options.failEvidence||options.failRichEvidence&&value.context?.promptMetadata.decisionPhase==='rich'||options.failDiagnostic&&value.phase==='controller-failure'||options.failOutcomeEvidence&&value.phase==='native-conditional-result')throw Error('Fixture disk failed');await options.evidenceSink?.(value);evidence.push(value);options.afterEvidence?.(value,current);if(options.consumeEvidenceReserve)time=fixtureCutoff-5000;},
    ...options.controllerOverrides});
  if(!options.skipInitialize)await controller.initialize();
  return {controller,operator,calls,commands,events,evidence,get current(){return current;},setTime(value){time=value;}};
}
const modelModeFixture=options=>fixture({codex:true,fastFirst:false,singleCallResearch:false,...options,
  controllerOverrides:{decisionMode:'model-tools',codexContextMode:'session',automaticTacticalEvidence:false,...options?.controllerOverrides}});
const modelModePick=(actions,reason='Keep the battle model’s authored pair.')=>({actions,planUpdate:{objective:'Use the model-owned final action.',preserveIds:[],nextCondition:'Observe the actual reply.'},reason});

function endCurrentChild(current,{final=false,ready=false}={}){
  current.actions=ready?[{kind:'ready',room:PARENT,token:'9'.repeat(64)}]:[];
  current.rooms.find(row=>row.id===ROOM).ended=true;
  current.rooms.find(row=>row.id===ROOM).result={type:'win',winner:'Fixture'};
  current.controlPolicy={halted:false,pending:[]};
  if(final){current.rooms.find(row=>row.id===PARENT).ended=true;current.rooms.find(row=>row.id===PARENT).result={type:'win',winner:'Fixture'};current.search={searching:[],games:null};}
}
test('read-only background hooks preempt before current authoring and carry only speculative notes without changing the deadline or actions',async()=>{
  const hooks=[],notes={speculative:true,requiresFreshMaterialChecks:true,proposals:[{idea:'Check the new board before reusing this plan.'}]};
  const background={setMainBusy:value=>hooks.push(['busy',value]),setDecisionContext:value=>hooks.push(['context',!!value.decision]),notesFor:()=>notes};
  const f=await modelModeFixture({cutoffDelta:45000,controllerOverrides:{background},callDecision:async input=>{
    assert.deepEqual(hooks,[['busy',true],['context',false]]);
    const payload=JSON.parse(input.input);assert.deepEqual(payload.ponderNotes,notes);assert.equal(payload.decisionClock.modelDeadlineAt,input.deadlineAt);
    assert.deepEqual(input.schema.required,['actions','planUpdate','reason']);
    return {decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{telemetrySource:'codex-cli-session'}};
  }});
  const result=await f.controller.decideNext();assert.equal(result.status,'submitted',JSON.stringify(result));
  assert.deepEqual(hooks,[['busy',true],['context',false],['context',true],['busy',false]]);
  assert.deepEqual(f.calls.find(row=>row.name==='battle_choose').args.actions,[{type:'move',slot:4},{type:'move',slot:4}]);
});

test('an unchanged read-only waiting poll does not preempt useful opponent-wait pondering',async()=>{
  const busy=[];const background={setMainBusy:value=>busy.push(value),setDecisionContext(){},notesFor(){throw Error('No new model context expected');}};
  const f=await modelModeFixture({controllerOverrides:{background},callDecision:async()=>{throw Error('No model authoring while waiting');}});
  f.current.actions=[];
  assert.equal((await f.controller.decideNext()).status,'waiting');assert.deepEqual(busy,[false]);
});

test('a failed optional background observer cannot stop or retarget the model-owned current choice',async()=>{
  const background=Object.fromEntries(['setMainBusy','setDecisionContext','notesFor'].map(name=>[name,()=>{throw Error('Synthetic background unavailable');}]));
  const f=await modelModeFixture({controllerOverrides:{background},callDecision:async()=>({decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}})});
  const result=await f.controller.decideNext();assert.equal(result.status,'submitted',JSON.stringify(result));
  assert.equal(f.calls.filter(row=>row.name==='battle_choose').length,1);
});

test('oversized optional pondering notes cannot displace complete fresh facts or stop the current model call',async()=>{
  const background={setMainBusy(){},setDecisionContext(){},notesFor:()=>({speculative:true,large:'x'.repeat(MAX_CONTEXT_BYTES)})};
  let models=0;const f=await modelModeFixture({controllerOverrides:{background},callDecision:async input=>{
    models++;assert.equal(JSON.parse(input.input).ponderNotes,undefined);
    return {decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}};
  }});
  const result=await f.controller.decideNext();assert.equal(result.status,'submitted',JSON.stringify(result));assert.equal(models,1);
  assert.equal(f.events.filter(e=>e.name==='ponder.notes-skipped').length,1);
});

test('model-tools controller setup supplies actual tool schemas and no-request turns run zero automatic research',async()=>{
  for(const preview of [false,true]){
    let models=0;
    const f=await modelModeFixture({preview,cutoffDelta:45000,callDecision:async input=>{
      models++;assert.deepEqual(input.schema.required,['actions','planUpdate','reason']);assert.deepEqual(Object.keys(input.schema.properties),['actions','planUpdate','reason']);
      const clock=JSON.parse(input.input).decisionClock;assert.equal(clock.modelDeadlineAt,input.deadlineAt);assert(clock.remainingAtAssemblyMs>0);assert.equal(clock.commitReserveMs,5000);
      assert(input.modelTools.definitions.some(tool=>tool.name==='get_pokemon'));assert(input.modelTools.definitions.some(tool=>tool.name==='calculate_damage'));
      assert.equal(f.calls.some(row=>['calculate_damage','calculate_speed','simulate_turn','battle_stage_fallback'].includes(row.name)),false);
      return {decision:modelModePick(preview?[{type:'team',order:[2,4,3,1]}]:[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:4,mega:false}],
        'Rain unlocks the earlier Aura Scarf commitment.'),telemetry:{telemetrySource:'codex-cli-session'}};
    }});
    if(!preview)f.current.actions[0].legalActions.active[0].canMegaEvo=true;
    assert.equal(f.controller.status().decisionMode,'model-tools');assert.equal(f.controller.status().fastFirst,false);assert.equal(f.controller.status().singleCallResearch,false);
    const result=await f.controller.decideNext();assert.equal(result.status,'submitted',JSON.stringify(result));assert.equal(result.operation,'model-play');assert.equal(result.modelRequestedTools,0);assert.equal(models,1);
    assert.equal(f.calls.filter(row=>row.name==='listTools').length,1);assert.equal(f.calls.filter(row=>['calculate_damage','calculate_speed','simulate_turn','battle_check_plan','get_pokemon'].includes(row.name)).length,0);
    assert.equal(f.commands.some(row=>['threat-screen','stage-next','checks-play-next','calculate-play-next','delivery-play-next'].includes(row.op)),false);
    const chosen=f.calls.find(row=>row.name==='battle_choose').args.actions;assert.deepEqual(chosen,preview?[{type:'team',order:[2,4,3,1]}]:[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:4}]);
    assert.equal(f.evidence[0].phase,'decision');assert.match(f.evidence[0].decision.reason,/Rain unlocks/u);assert.equal(f.evidence[0].decision.modelToolCalls.length,0);
    assert.deepEqual(JSON.parse(f.evidence[0].context.input).matchupSkill,MATCHUP_GUIDANCE);
  }
});

test('model-tools controller returns actual model-requested lookup and calculator results before one final pair under the same deadline',async()=>{
  let modelDeadline,models=0;
  const f=await modelModeFixture({cutoffDelta:45000,callDecision:async(input,{setTime,calls})=>{
    models++;modelDeadline=input.deadlineAt;
    const lookup=await input.modelTools.call({name:'get_pokemon',arguments:{name:'Rillaboom'},callId:'controller-lookup'});
    assert.equal(lookup.fixtureNativeLookup,true);assert.equal(lookup.complete.length,3000);assert.equal(lookup.gen,0);assert.equal(calls.some(row=>row.name==='battle_stage_fallback'),false);
    setTime(input.deadlineAt-12000);
    const damage=await input.modelTools.call({name:'calculate_damage',arguments:{gen:0,attacker:'Rillaboom',defender:'Incineroar',move:'Tackle'},callId:'controller-damage'});
    assert.deepEqual(damage.range,[20,40]);assert.equal(damage.calculationRef.tool,'calculate_damage');assert.equal(calls.some(row=>row.name==='battle_stage_fallback'),false);
    return {decision:modelModePick([{type:'move',slot:1,target:2,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{telemetrySource:'codex-cli-session'}};
  }});
  const result=await f.controller.decideNext();assert.equal(result.status,'submitted',JSON.stringify(result));assert.equal(result.modelRequestedTools,2);assert.equal(models,1);
  assert.deepEqual(f.commands.filter(row=>['model-tool','model-play'].includes(row.op)).map(row=>row.deadlineAt),[modelDeadline,modelDeadline,modelDeadline]);
  assert.equal(f.calls.filter(row=>row.name==='calculate_damage').length,1);assert.equal(f.calls.filter(row=>['simulate_turn','calculate_speed'].includes(row.name)).length,0);
  assert.deepEqual(f.calls.find(row=>row.name==='calculate_damage').args.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});
  const audit=f.evidence[0].decision.modelToolCalls;assert.deepEqual(audit.map(row=>row.origin),['model-requested','model-requested']);assert.equal(audit[1].result.result.receipt.nativeMcp,true);
  assert(f.calls.findIndex(row=>row.name==='calculate_damage')<f.calls.findIndex(row=>row.name==='battle_stage_fallback'));
});

test('model-tools outer deadline and abort races remain provider failures while late failure evidence settles',async()=>{
  for(const cause of ['deadline_exceeded','aborted']){
    let original,modelSignal,models=0,resolveEntered,resolveProvider,resolveEvidence;
    const entered=new Promise(resolve=>{resolveEntered=resolve;}),providerSettled=new Promise(resolve=>{resolveProvider=resolve;}),evidenceSettled=new Promise(resolve=>{resolveEvidence=resolve;});
    const parent=new AbortController();
    const f=await modelModeFixture({cutoffDelta:45000,maxModelMs:100,
      evidenceSink:async value=>{if(value.phase==='decision-failed'){await new Promise(resolve=>setTimeout(resolve,40));resolveEvidence();}},
      callDecision:input=>{
        models++;original=input.deadlineAt;modelSignal=input.signal;resolveEntered();
        return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>setTimeout(()=>{
          reject(Object.assign(new Error('Delayed fixture provider abort'),{code:'aborted',telemetry:{errorCode:'aborted',deadlineAt:original}}));resolveProvider();
        },60),{once:true}));
      }});
    const received=f.current.actions[0].receivedAt,cutoff=f.current.controlPolicy.pending[0].cutoffAt;
    const pending=f.controller.decideNext({signal:parent.signal});await entered;if(cause==='aborted')parent.abort();
    const result=await pending;
    assert.equal(result.status,'decision-unavailable',JSON.stringify(result));assert.equal(result.providerFailureCode,cause);
    assert.equal(original,received+100);assert.equal(f.current.controlPolicy.pending[0].cutoffAt,cutoff);assert.equal(modelSignal.aborted,true);assert.equal(models,1);
    const failure=f.events.find(event=>event.name==='decision.provider-failed');assert(failure);
    assert.equal(failure.decisionPhase,'first');assert.equal(failure.providerKind,'codex-cli');assert.equal(failure.code,cause);
    assert.equal(f.events.some(event=>event.name==='controller.preparation-failed'),false);
    assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose','calculate_damage','simulate_turn'].includes(call.name)),false);
    await providerSettled;await evidenceSettled;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose'].includes(call.name)),false);
    assert.equal(f.evidence.find(event=>event.phase==='decision-failed').validation.code,'aborted');
  }
});

test('model-tools failure evidence rejection preserves the provider failure and performs no choice or retry',async()=>{
  let original,models=0;
  const f=await modelModeFixture({cutoffDelta:45000,
    evidenceSink:async value=>{if(value.phase==='decision-failed')throw Object.assign(new Error('Fixture failure-evidence disk error'),{code:'DISK_FAILED'});},
    callDecision:input=>{models++;original=input.deadlineAt;throw Object.assign(new Error('Fixture provider deadline'),{code:'deadline_exceeded',telemetry:{errorCode:'deadline_exceeded',deadlineAt:original}});}});
  const received=f.current.actions[0].receivedAt,result=await f.controller.decideNext();
  assert.equal(result.status,'diagnostic-evidence-unavailable',JSON.stringify(result));assert.equal(result.providerFailureCode,'deadline_exceeded');assert.equal(original,received+40000);assert.equal(models,1);
  assert.equal(result.diagnosticErrorCode,'DISK_FAILED');assert.equal(result.diagnosticPreserved,false);
  const failure=f.events.find(event=>event.name==='decision.provider-failed');assert(failure);assert.equal(failure.code,'deadline_exceeded');assert.equal(failure.decisionPhase,'first');assert.equal(failure.providerKind,'codex-cli');
  assert.equal(f.events.some(event=>event.name==='controller.preparation-failed'),false);
  assert(f.events.some(event=>event.name==='decision.provider-evidence-failed'));
  assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose','calculate_damage','simulate_turn'].includes(call.name)),false);
  const before=f.calls.length;assert.equal((await f.controller.decideNext()).status,'diagnostic-evidence-unavailable');assert.equal(f.calls.length,before);assert.equal(models,1);
});

test('model-tools controller refuses illegal final choices and host planner configuration without manufacturing a fallback',async()=>{
  let models=0;
  const f=await modelModeFixture({callDecision:async()=>{models++;return {decision:modelModePick([{type:'move',slot:9,target:1,mega:false},{type:'move',slot:4,mega:false}])};}});
  const out=await f.controller.decideNext();assert.equal(out.status,'controller-unavailable');assert.equal(models,1);assert.equal(f.calls.some(row=>['battle_stage_fallback','battle_choose','calculate_damage'].includes(row.name)),false);
  assert.equal(f.evidence[0].phase,'controller-failure');
  for(const options of [{researchProvider:()=>null},{fastFirst:true},{singleCallResearch:true},{controllerOverrides:{automaticTacticalEvidence:true}},{controllerOverrides:{codexContextMode:'stateless'}}])
    await assert.rejects(modelModeFixture(options),/model-owned|retained/u);
});

test('model-tools official end during generation preserves the authored unsent response and enters normal review instead of attention',async()=>{
  let models=0;const f=await modelModeFixture({cutoffDelta:45000,callDecision:async(_input,{current})=>{models++;endCurrentChild(current,{final:true});return{decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}};}});
  const result=await f.controller.runSet();assert.equal(result.status,'review-required',JSON.stringify(result));assert.equal(models,1);
  assert.deepEqual(f.evidence.map(row=>row.phase),['decision','decision-superseded']);assert.equal(f.evidence[1].validation.code,'REQUEST_CHILD_ENDED');assert.equal(f.evidence[1].validation.choiceAuthority,false);assert(f.evidence[1].modelOutput);assert.equal(f.evidence[1].decision,undefined);
  assert.equal(f.calls.some(row=>['battle_choose','battle_stage_fallback','battle_ready','battle_start'].includes(row.name)),false);assert.equal(f.commands.filter(row=>row.op==='model-play').length,1);assert(f.events.some(row=>row.name==='decision.superseded'));
});

test('model-tools child end with fresh same-parent readiness preserves the unsent response without sending readiness in reconciliation',async()=>{
  let models=0;const f=await modelModeFixture({manualReady:true,autoReady:false,cutoffDelta:45000,callDecision:async(_input,{current})=>{
    models++;endCurrentChild(current,{ready:true});return{decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{requestWallTimeMs:21810}};
  }});
  const result=await f.controller.decideNext();assert.equal(result.status,'waiting',JSON.stringify(result));assert.equal(result.reason,'official-child-ended-during-decision');assert.equal(result.retry,false);assert.equal(models,1);
  assert.deepEqual(f.evidence.map(row=>row.phase),['decision','decision-superseded']);const superseded=f.evidence[1];assert.equal(superseded.validation.code,'REQUEST_CHILD_ENDED');assert.equal(superseded.validation.choiceAuthority,false);assert(superseded.modelOutput);assert.equal(superseded.decision,undefined);
  assert.equal(f.commands.filter(row=>row.op==='model-play').length,1);assert.equal(f.commands.filter(row=>row.op==='turn').length,2,'only one typed pre-mutation refusal adds one bounded reconciliation read');assert.equal(f.calls.some(row=>['battle_choose','battle_stage_fallback','battle_ready','battle_start'].includes(row.name)),false);
  assert.equal((await f.controller.decideNext()).operation,'battle_ready','the next normal lifecycle iteration handles its exact fresh ready token');assert.equal(f.calls.filter(row=>row.name==='battle_ready').length,1);assert.equal(models,1);assert.equal(f.calls.some(row=>row.name==='battle_choose'),false);
});

test('model-tools same-parent ready reconciliation cannot hide foreign active uncertain or unowned boundaries',async()=>{
  const cases=[current=>{current.actions[0].room=PARENT+'9';},current=>{current.actions[0].actionable=false;},current=>{current.actions[0].submissionStatus='uncertain';},
    current=>{current.actions.push({kind:'turn',room:ROOM,parentId:PARENT,rqid:6,token:'a'.repeat(64),actionable:true});},
    current=>{current.controlPolicy.pending=[{token:TOKEN,attempted:true}];},current=>{current.rooms.find(row=>row.id===ROOM).teamId='d'.repeat(64);},
    current=>{current.rooms.find(row=>row.id===PARENT).teamId='d'.repeat(64);},current=>{current.controller.generation++;},current=>{current.controlPolicy.halted=true;}];
  for(const mutate of cases){const f=await modelModeFixture({manualReady:true,autoReady:false,cutoffDelta:45000,callDecision:async(_input,{current})=>{endCurrentChild(current,{ready:true});mutate(current);return{decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}};}});
    const result=await f.controller.decideNext();assert.equal(result.status,'reconciliation-required',JSON.stringify(result));assert.equal(f.evidence.some(row=>row.phase==='decision-superseded'),false);assert.equal(f.calls.some(row=>['battle_choose','battle_stage_fallback','battle_ready','battle_start'].includes(row.name)),false);
  }
});

test('ordinary model-tools submission adds no ended-request reconciliation read',async()=>{
  const f=await modelModeFixture({cutoffDelta:45000,callDecision:async()=>({decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}})});
  assert.equal((await f.controller.decideNext()).status,'submitted');assert.equal(f.commands.filter(row=>row.op==='turn').length,1);assert.equal(f.commands.filter(row=>row.op==='model-play').length,1);assert.equal(f.calls.filter(row=>row.name==='battle_choose').length,1);assert.equal(f.evidence.some(row=>row.phase==='decision-superseded'),false);
});

test('model-tools ended-request reconciliation cannot suppress reservations, wrong ownership, active requests or unknown mutation failures',async()=>{
  for(const mutate of [current=>{current.controlPolicy.halted=true;},current=>{current.controlPolicy.pending=[{token:TOKEN,attempted:true}];},current=>{current.rooms.find(row=>row.id===ROOM).parentId=PARENT+'9';},current=>{delete current.rooms.find(row=>row.id===ROOM).result;},current=>{current.connected=false;},current=>{current.actions=[{kind:'ready',room:PARENT,token:'9'.repeat(64)}];}]){
    const f=await modelModeFixture({cutoffDelta:45000,callDecision:async(_input,{current})=>{endCurrentChild(current,{final:true});mutate(current);return{decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}};}});
    const result=await f.controller.decideNext();assert.equal(result.status,'reconciliation-required',JSON.stringify(result));assert.equal(f.evidence.some(row=>row.phase==='decision-superseded'),false);assert.equal(f.calls.some(row=>row.name==='battle_choose'),false);
  }
  const uncertain=await modelModeFixture({cutoffDelta:45000,stageUncertain:true,beforeStageError:current=>endCurrentChild(current,{final:true}),callDecision:async()=>({decision:modelModePick([{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}})});
  assert.equal((await uncertain.controller.decideNext()).status,'reconciliation-required');assert.equal(uncertain.evidence.some(row=>row.phase==='decision-superseded'),false);assert(uncertain.calls.some(row=>row.name==='battle_stage_fallback'));assert.equal(uncertain.calls.some(row=>row.name==='battle_choose'),false);
});

test('manual readiness and two game threads use only server tokens, preserve prior observations and end at review',async()=>{
 let models=0;const f=await modelModeFixture({manualReadyCycle:true,manualReady:true,autoReady:false,cutoffDelta:45000,previousFinalSummary:true,callDecision:async input=>{models++;const payload=JSON.parse(input.input);return {decision:modelModePick(payload.legalOptions.kind==='preview'?[{type:'team',order:[1,2,3,4]}]:[{type:'move',slot:4,mega:false},{type:'move',slot:4,mega:false}]),telemetry:{}};}});
 const result=await f.controller.runSet({maxRequests:10});assert.equal(result.status,'review-required',JSON.stringify(result));assert.equal(models,4);assert.equal(f.calls.filter(row=>row.name==='battle_ready').length,2);assert.equal(f.calls.filter(row=>row.name==='battle_choose').length,4);assert.equal(f.calls.some(row=>row.name==='battle_start'),false);assert.equal(f.controller.status().readinessReservations,2);const before=f.calls.length;assert.equal((await f.controller.decideNext()).status,'review-required');assert.equal(f.calls.length,before);
});
