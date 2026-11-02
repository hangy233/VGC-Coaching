import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createOperator} from '../showdown/operator-client.mjs';
import {buildModelToolContext,modelToolDefinitions,runModelToolCycle} from './model-tool-cycle.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {MODEL_TOOL_NAMES,modelToolDefinition} from '../showdown/model-owned-tools.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const names=['Charizard','Incineroar','Farigiraf','Politoed','Hydreigon','Sylveon'],abilities=['Blaze','Intimidate','Armor Tail','Drizzle','Levitate','Pixilate'];
const ownTeamText=names.map((name,index)=>`${name}\nAbility: ${abilities[index]}\nLevel: 50\nAdamant Nature\n- Tackle\n- Protect`).join('\n\n');
const TEAM=createHash('sha256').update(Teams.pack(Teams.import(ownTeamText))).digest('hex'),TOKEN='b'.repeat(64),LEASE='c'.repeat(64);
const SESSION='model-cycle-fixture',ROOM='battle-gen9championsvgc2026regmcbo3-102',PARENT='game-bestof3-gen9championsvgc2026regmcbo3-101';
const identity={sessionId:SESSION,teamId:TEAM,account:'Fixture'},guidance=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE);
const pair=()=>[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:2,mega:false}];
const pick=(reason='Use the model-authored final pair.')=>({actions:pair(),planUpdate:{objective:'Retain the authored plan.',preserveIds:[],nextCondition:'Observe the next actual position.'},reason});
const tools=()=>['get_pokemon','calculate_damage'].map(name=>({name,description:'Actual native fixture '+name,inputSchema:{type:'object',properties:{gen:{type:'integer'},name:{type:'string'},attacker:{type:'string'},defender:{type:'string'},move:{type:'string'}},additionalProperties:true},annotations:{readOnlyHint:true}}));

async function fixture({nativeResult,evidenceHook,toolHook,mutationHook,stageUncertain=false,returnAfterModelSend=false}={}){
  let time=1000,sequence=0,attempts=0;const commands=[],calls=[],events=[],evidence=[],reserved=[],observed=[];
  const legal={pokemon:names.slice(0,4).map((name,index)=>({ident:`p1: ${name}`,details:`${name}, L50`,condition:'100/100',active:index<2})),active:[0,1].map((_,index)=>({canMegaEvo:index===0,moves:[{move:'Tackle',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]}))};
  const actor=(side,name,index)=>({id:`${side}-${index}`,nickname:name,species:name,activeSlot:index<2?index+1:null,requestIndex:side==='p1'?index+1:null,identityConfidence:'confirmed',selection:'selected',hp:{current:100,max:100,precision:side==='p1'?'server-own-exact':'server-display'},fainted:false,boosts:{},status:null,ability:abilities[index],item:'',itemKnown:true,moves:[],volatiles:{}});
  const side=id=>({id,selectedTeamSize:4,selectionKnowledge:id==='p1'?'current-own-request':'observed-opponents-only',unrevealedSelected:0,active:[{slot:1,pokemon:`${id}-0`},{slot:2,pokemon:`${id}-1`}],reserves:[`${id}-2`,`${id}-3`],pokemon:names.slice(0,4).map((name,index)=>actor(id,name,index)),conditions:{}});
  const opponentSheet=names.map((species,index)=>({species,ability:abilities[index],nature:'Adamant',item:'',moves:['Tackle','Protect']}));
  const action={kind:'turn',room:ROOM,parentId:PARENT,rqid:4,revision:6,token:TOKEN,receivedAt:1000,actionable:true,legalActions:legal};
  const state={sessionId:SESSION,teamId:TEAM,teamSha256:TEAM,username:'Fixture',connected:true,authenticated:true,stopped:false,revision:6,observedAt:1000,controller:{required:true,owner:'CycleFixture',generation:1},actions:[action],
    rooms:[{id:ROOM,parentId:PARENT,teamId:TEAM,ended:false},{id:PARENT,teamId:TEAM,ended:false}],search:{searching:[],games:{[ROOM]:true}},controlPolicy:{pending:[{room:ROOM,rqid:4,token:TOKEN,cutoffAt:50000}]},
    boards:[{room:ROOM,parentId:PARENT,turn:1,ownSide:'p1',request:{rqid:4},field:{weather:null,terrain:null,conditions:{}},sides:[side('p1'),side('p2')],recentEvents:{lines:['|turn|1']},opponentSheets:{p2:opponentSheet}}]};
  const raw=result=>({structuredContent:{ok:true,result}});
  const client={async listTools(){calls.push({name:'listTools'});return {tools:tools()};},async callTool({name,arguments:args},_schema,options){
    calls.push({name,args:structuredClone(args),options});
    if(['battle_status','battle_turn_status','battle_wait'].includes(name))return raw(structuredClone(state));
    if(name==='battle_control_claim')return raw({controllerLease:LEASE,owner:'CycleFixture',generation:1});
    if(mutationHook&&['battle_stage_fallback','battle_choose'].includes(name))return mutationHook({name,args,options,state});
    if(name==='battle_stage_fallback'){if(stageUncertain)throw Error('Fixture unknown stage');return raw({pending:[{token:TOKEN,hasFallback:true,fallbackSource:'fallback',attempted:false}]});}
    if(name==='battle_choose'){state.actions=[];return raw({status:'sent-not-acknowledged'});}
    if(['get_pokemon','calculate_damage'].includes(name)){if(toolHook)return toolHook({name,args,options,state});return {structuredContent:structuredClone(nativeResult??{gen:0,name:args.name??'native calculator',range:[20,40],unknown:null,complete:'x'.repeat(4000)})};}
    throw Error('Unexpected native fixture call '+name);
  }};
  const actual=createOperator({client,responseFile:'unused-model-cycle.json',now:()=>time,budgetMs:10,readTimeoutMs:100,mutationTimeoutMs:100,returnAfterModelSend,publish:async()=>{}});
  const operator={dispatch(q,meta){commands.push({query:structuredClone(q),signal:meta?.signal});return actual.dispatch(q,meta);}};
  const id=phase=>'cycle_'+phase+'_'+(++sequence),dispatch=q=>operator.dispatch({id:id('setup'),...q});
  await dispatch({op:'arm',confirmed:true,expectedSessionId:SESSION,expectedTeamId:TEAM,expectedAccount:'Fixture'});await dispatch({op:'call',name:'battle_control_claim',args:{confirmed:true,controllerId:'CycleFixture',commandId:'cycle_claim'}});
  await dispatch({op:'decision-policy',enabled:true,inlineBrief:false,requireAtomicResearch:true});await dispatch({op:'model-tool-mode',enabled:true});const catalog=(await dispatch({op:'model-tool-catalog'})).result;
  const context=buildModelToolContext({state,ownTeamText,opponentSheet,...ISOLATED_POLICY_SOURCE,matchupGuidance:guidance,now:()=>time});
  const run=(callDecision,{signal}={})=>runModelToolCycle({context,state,action,parentId:PARENT,identity,operator,catalog,callDecision,now:()=>time,deadlineAt:40000,signal,id,emit:(name,fields)=>events.push({name,...fields}),
    onEvidence:async value=>{await evidenceHook?.(value,{setTime:value=>{time=value;}});evidence.push(value);},onModelAttempt:()=>{attempts++;},reserve:token=>reserved.push(token),observeDecision:decision=>observed.push(decision)});
  return {state,action,context,catalog,run,calls,commands,events,evidence,reserved,observed,setTime:value=>{time=value;},get attempts(){return attempts;}};
}

test('model-owned opt-in returns the known committed position before waiting so the script can start its shadow author',async()=>{
  const f=await fixture({returnAfterModelSend:true,mutationHook:({name,args,state})=>{
    if(name==='battle_stage_fallback')return {structuredContent:{ok:true,result:{pending:[{token:TOKEN,hasFallback:true,fallbackSource:'fallback',attempted:false}]}}};
    state.actions=[];state.choices=[{room:ROOM,rqid:4,status:'sent',evidence:[],actions:args.actions}];
    return {structuredContent:{ok:true,result:{status:'sent-not-acknowledged'}}};
  }});
  const result=await f.run(async()=>({decision:pick(),telemetry:{}}));
  assert.equal(result.status,'submitted');assert.equal(result.nextReason,'committed-opponent-wait');
  assert.equal(f.calls.filter(row=>row.name==='battle_choose').length,1);assert.equal(f.calls.filter(row=>row.name==='battle_wait').length,0);
  assert.equal(f.observed.length,1,'The same final authored pair is attached before normal script waiting continues');
});

test('blank native calculator descriptions receive neutral protocol text without changing their schemas',()=>{
  const inputSchema={type:'object',properties:{gen:{type:'integer',enum:[0]},attacker:{type:'string'},defender:{type:'string'},move:{type:'string'}}},native={name:'calculate_damage',description:'',inputSchema},before=structuredClone(native);
  const [definition]=modelToolDefinitions([native]);assert(definition.description.trim().length>0);assert.match(definition.description,/MCP|native|tool/iu);assert.deepEqual(definition.inputSchema,inputSchema);assert.deepEqual(native,before);
  const [whitespace]=modelToolDefinitions([{...native,description:' \t\n'}]);assert.equal(whitespace.description,definition.description);
  assert.equal(modelToolDefinitions([{...native,description:'Actual native calculator description.'}])[0].description,'Actual native calculator description.');
});

test('actual native MCP catalog normalizes complete dynamic tool definitions without generation or authentication',{timeout:15000},async()=>{
  const connection=await connectOfflineNumericClient();
  try{
    const catalog=await connection.client.listTools(),allowed=catalog.tools.filter(tool=>MODEL_TOOL_NAMES.includes(tool.name)&&
      (tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true)).map(modelToolDefinition),before=structuredClone(allowed),definitions=modelToolDefinitions(allowed);
    assert(definitions.some(tool=>tool.name==='calculate_damage'));assert(definitions.some(tool=>tool.name==='simulate_choices'));
    assert(!definitions.some(tool=>['simulate_turn','battle_check_plan'].includes(tool.name)));
    const compact=definitions.find(tool=>tool.name==='simulate_choices');
    assert.deepEqual(compact.inputSchema.required,['ourActions','opposingActions']);
    assert(!Object.hasOwn(compact.inputSchema.properties,'source'));
    for(const definition of definitions){assert(definition.description.trim().length>0,definition.name);assert.deepEqual(definition.inputSchema,allowed.find(tool=>tool.name===definition.name).inputSchema);}
    assert.deepEqual(allowed,before);assert(Buffer.byteLength(JSON.stringify(definitions))<1024*1024);
  }finally{await connection.close();}
});

test('model-tools context carries full skill and only the three final author fields',async()=>{
  const f=await fixture(),payload=restoreContextPayload(JSON.parse(f.context.input));assert.deepEqual(f.context.schema.required,['actions','planUpdate','reason']);assert.deepEqual(Object.keys(f.context.schema.properties),['actions','planUpdate','reason']);assert.deepEqual(payload.matchupSkill,guidance);
  for(const key of ['hostRouteConstraints','firstChoiceScope','hostResearchCard','hostResearchRequirement','hypothesisPreset','atomicResearchContracts','atomicResearchContract','tacticalEvidence','automaticThreatScreen'])assert.equal(payload[key],undefined);
  assert.equal(f.context.promptMetadata.decisionMode,'model-tools');assert.equal(f.context.promptMetadata.automaticTacticalEvidence,false);
});

test('a model selecting no MCP causes zero research and preserves its final Mega pair without a prior stage',async()=>{
  const f=await fixture(),final=pick('Rain makes Electro Shot immediate despite Protect.');
  const out=await f.run(async input=>{assert.equal(input.deadlineAt,40000);assert.deepEqual(input.sessionScope,{sessionId:SESSION,teamId:TEAM,parentId:PARENT,gameId:ROOM});assert.equal(f.calls.some(call=>['calculate_damage','battle_stage_fallback','battle_choose'].includes(call.name)),false);return {decision:final,telemetry:{fixture:true}};});
  assert.equal(out.status,'submitted');assert.equal(out.operation,'model-play');assert.equal(out.modelRequestedTools,0);assert.equal(f.attempts,1);
  assert.equal(f.calls.filter(call=>['calculate_damage','calculate_speed','simulate_turn','get_pokemon'].includes(call.name)).length,0);
  for(const name of ['battle_stage_fallback','battle_choose'])assert.deepEqual(f.calls.find(call=>call.name===name).args.actions,[{type:'move',slot:1,target:1,mega:true},{type:'move',slot:2}]);
  assert.equal(f.evidence[0].decision.reason,final.reason);assert.deepEqual(f.reserved,[TOKEN]);assert.equal(f.commands.filter(row=>row.query.op==='model-play').length,1);
});

test('only a trusted pre-mutation source refusal carries known-not-sent metadata and cannot attach a committed pair',async()=>{
  const stale=await fixture();const result=await stale.run(async()=>{stale.state.actions=[];return{decision:pick(),telemetry:{}};});
  assert.equal(result.status,'reconciliation-required');assert.equal(result.modelChoiceSourceRefusal.stage,'fresh-source-validation');assert.equal(result.modelChoiceSourceRefusal.knownNotSent,true);assert.equal(result.modelChoiceSourceRefusal.nativeMutationAttempted,false);assert.equal(stale.observed.length,0);assert.equal(stale.calls.some(call=>['battle_choose','battle_stage_fallback'].includes(call.name)),false);assert.equal(stale.evidence[0].phase,'decision');
  const uncertain=await fixture({stageUncertain:true}),unknown=await uncertain.run(async()=>({decision:pick(),telemetry:{}}));assert.equal(unknown.status,'reconciliation-required');assert.equal(unknown.modelChoiceSourceRefusal,undefined);assert.equal(uncertain.observed.length,0);
});

test('model-selected native results are complete before its final choice and share the original deadline',async()=>{
  const native={gen:0,result:{range:[20,40]},metadata:{unknown:null,full:'x'.repeat(4000)}},f=await fixture({nativeResult:native});
  const out=await f.run(async input=>{
    const lookup=await input.modelTools.call({callId:'lookup1',name:'get_pokemon',arguments:{name:'Charizard'}});assert.deepEqual(lookup,native);
    assert.equal(f.calls.some(call=>call.name==='battle_stage_fallback'),false);f.setTime(9000);
    const damage=await input.modelTools.call({callId:'damage1',name:'calculate_damage',arguments:{gen:0,attacker:'Charizard',defender:'Incineroar',move:'Tackle'}});assert.deepEqual(damage,native);
    assert.equal(input.deadlineAt,40000);return {decision:pick(),telemetry:{fixture:true}};
  });
  assert.equal(out.status,'submitted');assert.equal(out.modelRequestedTools,2);
  const ops=f.commands.filter(row=>['model-tool','model-play'].includes(row.query.op));assert.deepEqual(ops.map(row=>row.query.deadlineAt),[40000,40000,40000]);
  assert.deepEqual(f.calls.find(call=>call.name==='calculate_damage').args.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});
  assert.deepEqual(f.evidence[0].decision.modelToolCalls.map(call=>call.origin),['model-requested','model-requested']);assert.equal(f.evidence[0].decision.modelToolCalls[0].result.result.receipt.nativeMcp,true);
  assert(f.calls.findIndex(call=>call.name==='calculate_damage')<f.calls.findIndex(call=>call.name==='battle_stage_fallback'));
});

test('a nested native MCP refusal reaches the model unchanged and is audited as refused rather than a successful return',async()=>{
  const native={isError:true,text:'Observed position: reserve PP is unknown; explicit hypothesis required',unsupported:['reserve.pp']};
  const f=await fixture({nativeResult:native});let received;
  const out=await f.run(async input=>{
    received=await input.modelTools.call({callId:'native-refusal',name:'calculate_damage',arguments:{gen:0,attacker:'Charizard',defender:'Incineroar',move:'Tackle'}});
    assert.deepEqual(received,native);assert.equal(input.deadlineAt,40000);
    assert.equal(f.calls.some(call=>call.name==='battle_stage_fallback'),false);
    return {decision:pick('The native check refused; this choice makes no verified numerical claim.'),telemetry:{fixture:true}};
  });
  assert.equal(out.status,'submitted');assert.deepEqual(received,native);
  const audit=f.evidence[0].decision.modelToolCalls;assert.equal(audit.length,1);assert.equal(audit[0].status,'refused');
  assert.deepEqual(audit[0].result.result.result,native);assert.equal(audit[0].result.result.receipt.nativeMcp,true);
  assert.equal(f.calls.filter(call=>call.name==='calculate_damage').length,1);
});

test('failure evidence rejection remains diagnostic and cannot replace the original provider deadline cause',async()=>{
  const f=await fixture({evidenceHook:value=>{if(value.phase==='decision-failed')throw Object.assign(new Error('Fixture evidence disk failure'),{code:'DISK_FAILED'});}});
  const out=await f.run(async()=>{throw Object.assign(new Error('Fixture provider deadline'),{code:'deadline_exceeded',telemetry:{errorCode:'deadline_exceeded',deadlineAt:40000}});});
  assert.equal(out.status,'diagnostic-evidence-unavailable');assert.equal(out.providerFailureCode,'deadline_exceeded');
  assert.equal(out.diagnosticErrorCode,'DISK_FAILED');assert.equal(out.diagnosticPreserved,false);
  assert.equal(f.attempts,1);assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose'].includes(call.name)),false);
  assert.equal(f.reserved.length,0);
  assert(f.events.some(event=>event.name==='decision.provider-evidence-failed'));
});

test('invalid tool arguments return precise schema diagnostics without backend work or rewriting and allow a model-authored correction',async()=>{
  const f=await fixture(),bad={name:['Charizard']},before=structuredClone(bad);
  const out=await f.run(async input=>{
    const refused=await input.modelTools.call({callId:'bad-shape',name:'get_pokemon',arguments:bad});
    assert.equal(refused.isError,true);assert.equal(refused.structuredContent.backendCalled,false);
    assert.match(refused.content[0].text,/name|must be string/u);assert.deepEqual(bad,before);
    assert.equal(f.calls.filter(call=>call.name==='get_pokemon').length,0);
    assert.equal(f.calls.some(call=>call.name==='battle_stage_fallback'),false);
    await input.modelTools.call({callId:'model-corrected-shape',name:'get_pokemon',arguments:{name:'Charizard'}});
    assert.equal(input.deadlineAt,40000);return {decision:pick(),telemetry:{fixture:true}};
  });
  assert.equal(out.status,'submitted');assert.equal(f.calls.filter(call=>call.name==='get_pokemon').length,1);
  const audit=f.evidence[0].decision.modelToolCalls;assert.equal(audit[0].status,'invalid-arguments');assert.equal(audit[0].backendCalled,false);assert.equal(audit[1].status,'returned');
});

test('unknown and repeated model calls fail without SDK replay or a manufactured fallback',async()=>{
  for(const mode of ['unknown','duplicate']){const f=await fixture(),out=await f.run(async input=>{const request={callId:'once',name:'get_pokemon',arguments:{name:'Charizard'}};if(mode==='duplicate')await input.modelTools.call(request);await input.modelTools.call({...request,...(mode==='unknown'?{name:'battle_start'}:{})});return {decision:pick()};});
    assert.equal(out.status,'decision-unavailable');assert.equal(f.calls.filter(call=>call.name==='get_pokemon').length,mode==='duplicate'?1:0);assert.equal(f.calls.some(call=>call.name==='battle_choose'),false);assert.equal(f.evidence[0].phase,'decision-failed');}
  assert.throws(()=>modelToolDefinitions([{name:'duplicate',inputSchema:{}},{name:'duplicate',inputSchema:{}}]),/Unique/u);
});

test('illegal or late final choices and evidence failure never stage an automatic alternative',async()=>{
  for(const mode of ['illegal','late','evidence']){const f=await fixture({evidenceHook:mode==='evidence'?()=>{throw Error('Fixture evidence failure');}:undefined});
    await assert.rejects(f.run(async()=>{const final=pick();if(mode==='illegal')final.actions[0].slot=9;if(mode==='late')f.setTime(40000);return {decision:final};}));
    assert.equal(f.calls.some(call=>['battle_choose','battle_stage_fallback','calculate_damage'].includes(call.name)),false);assert.equal(f.reserved.length,0);}
});

test('model child cancellation is forwarded to the native SDK and emits no final action',async()=>{
  const child=new AbortController();let resolveEntered,aborted=false;const entered=new Promise(resolve=>{resolveEntered=resolve;});
  const f=await fixture({toolHook:({options})=>new Promise((_resolve,reject)=>{resolveEntered();options.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Fixture native abort'));},{once:true});})});
  const running=f.run(async input=>{const pending=input.modelTools.call({callId:'cancel1',name:'get_pokemon',arguments:{name:'Charizard'},signal:child.signal});await entered;child.abort();const result=await pending;assert.equal(result.isError,true);throw Object.assign(new Error('Cancelled provider'),{code:'provider_cancelled'});});
  const out=await running;assert.equal(aborted,true);assert.equal(out.status,'decision-unavailable');assert.equal(f.commands.find(row=>row.query.op==='model-tool').signal,child.signal);assert.equal(f.calls.some(call=>call.name==='battle_choose'),false);
});

test('parent cancellation reaches a final native stage and preserves its uncertain request reservation',async()=>{
  let resolveStage,aborted=false;const stage=new Promise(resolve=>{resolveStage=resolve;});
  const f=await fixture({mutationHook:({options})=>new Promise((_resolve,reject)=>{resolveStage();options.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Final stage aborted'));},{once:true});})});
  const parent=new AbortController(),running=f.run(async()=>({decision:pick()}),{signal:parent.signal});await stage;parent.abort();
  const out=await running;assert.equal(aborted,true);assert.equal(out.status,'reconciliation-required');assert.equal(f.commands.find(row=>row.query.op==='model-play').signal,parent.signal);
  assert.equal(f.calls.filter(call=>call.name==='battle_choose').length,0);assert.deepEqual(f.reserved,[TOKEN]);
});
