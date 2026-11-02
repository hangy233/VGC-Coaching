import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {qualifyModelTools,hasModelToolQualificationReceipt} from './model-tool-qualification.mjs';
import {buildModelToolContext} from './model-tool-cycle.mjs';
import {restoreContextPayload} from './context-compaction.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';
import {codexSessionScopeHash} from './codex-session-transport.mjs';
import {z} from 'zod';
import {simulationChoicesToolSchema} from '../simulation/choice-schemas.mjs';
import {damageRangeToolSchema} from '../simulation/spread-range.mjs';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {executeSimulation} from '../simulation/mcp-tools.mjs';
import {simulateNativeTurn} from '../simulation/turn-simulator.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const names=['Rillaboom','Incineroar','Farigiraf','Politoed','Hydreigon','Sylveon'];
const abilities=['Grassy Surge','Intimidate','Armor Tail','Drizzle','Levitate','Pixilate'];
const teamText=names.map((name,index)=>`${name}\nAbility: ${abilities[index]}\nLevel: 50\nAdamant Nature\n- Protect\n- Tackle`).join('\n\n');
const teamId=hash(Teams.pack(Teams.import(teamText))),sessionId='offline-model-tool-fixture',parentId='game-bestof3-gen9championsvgc2026regmcbo3-9800000';
const identity={sessionId,teamId,account:'OfflineModelToolFixture'};
const sheet=names.map((species,index)=>({species,ability:abilities[index],moves:['Protect','Tackle'],item:'',nature:'Adamant'}));
function request({preview=false,game=1,rqid=1,materialRequired=false}={}){
  const room=`battle-gen9championsvgc2026regmcbo3-${9800000+game}`,token=hash(`${room}:${rqid}`);
  const legalActions={pokemon:names.slice(0,preview?6:4).map((name,index)=>({ident:`p1: ${name}`,details:`${name}, L50`,condition:'100/100',active:index<2})),
    ...(preview?{teamPreview:true,maxChosenTeamSize:4}:{active:[1,2].map(()=>({moves:[{move:'Protect',target:'self',pp:10},{move:'Tackle',target:'normal',pp:20}]}))})};
  const action={kind:preview?'preview':'turn',room,parentId,rqid,revision:rqid,token,receivedAt:1000,actionable:true,legalActions};
  const side=sideId=>({id:sideId,active:[{slot:1,pokemon:`${sideId}-0`},{slot:2,pokemon:`${sideId}-1`}],reserves:[`${sideId}-2`,`${sideId}-3`],conditions:{},
    pokemon:names.slice(0,preview?6:4).map((species,index)=>({id:`${sideId}-${index}`,species,requestIndex:sideId==='p1'?index+1:null,activeSlot:index<2?index+1:null,
      hp:{current:100,max:100,precision:sideId==='p1'?'server-own-exact':'server-display'},fainted:false,boosts:{},status:null,ability:abilities[index],item:'',itemKnown:true,moves:['Protect','Tackle'],volatiles:{},selection:'selected'}))});
  const state={sessionId,teamSha256:teamId,username:identity.account,connected:true,authenticated:true,stopped:false,actions:[action],rooms:[{id:room,parentId,ended:false}],
    boards:[{room,parentId,turn:preview?0:rqid,ownSide:'p1',request:{rqid},field:{weather:null,terrain:null,conditions:{}},sides:[side('p1'),side('p2')],opponentSheets:{p2:sheet},recentEvents:{lines:[]}}]};
  const context=buildModelToolContext({state,ownTeamText:teamText,opponentSheet:sheet,...ISOLATED_POLICY_SOURCE});
  return {context,state,action,identity:structuredClone(identity),parentId,materialRequired,caseId:`fixture-${game}-${rqid}`,provenance:{kind:'synthetic-test-only',savedPosition:false}};
}
function sequence(){return [request({preview:true}),request({rqid:2,materialRequired:true}),request({preview:true,game:2})];}
function fakeProvider({research=true,late=false,wrongChoice=false}={}){
  const calls=[],resets=[];let game=null,index=0,time=10000;
  const decisionProvider={kind:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'medium',callDecision:async input=>{
    calls.push(input);if(game!==input.sessionScope.gameId){game=input.sessionScope.gameId;index=0;}index++;
    const payload=restoreContextPayload(JSON.parse(input.input));
    if(payload.kind==='turn'&&research){
      await input.modelTools.call({name:'calculate_speed',arguments:{gen:0,fixture:'test-only-no-numerical-claim'},callId:'fixture-speed-call',signal:input.signal,deadlineAt:input.deadlineAt});
      await input.modelTools.call({name:'simulate_turn',arguments:{request:{kind:'explicit',position:{format:'test-only-no-numerical-claim'},branches:[],seeds:[]}},callId:'fixture-simulation-call',signal:input.signal,deadlineAt:input.deadlineAt});
    }
    if(late)time=input.deadlineAt;
    const actions=payload.kind==='preview'?[{type:'team',order:[1,2,3,4]}]:[{type:'move',slot:1,mega:false},{type:'move',slot:wrongChoice?4:2,target:1,mega:false}];
    return {decision:{actions,planUpdate:{objective:'Synthetic fixture pressure.',preserveIds:[],nextCondition:'Observe the next synthetic request.'},reason:'Synthetic fixture only.'},telemetry:{
      telemetrySource:'codex-cli-session',authenticationMethod:'chatgpt',contextMode:'session',sessionTurnCompleted:true,sessionProcessOwned:true,sessionSourceRehydrated:true,
      completedAt:time,finalReceivedAt:time,sessionTurnIndex:index,sessionThreadSha256:hash(game),sessionScopeSha256:codexSessionScopeHash(input.sessionScope),
      nativeInputSha256:hash(input.input),nativeSchemaSha256:hash(input.schema),nativeInstructionsSha256:hash(input.instructions),modelToolsEnabled:true,
      sessionContextMetadata:index===1?{staticSent:['matchupSkill'],staticRefs:[]}:{staticSent:[],staticRefs:['matchupSkill']}}};
  }};
  return {contextMode:'session',decisionProvider,calls,resets,now:()=>time,preflight:async()=>({authMode:'chatgpt',contextMode:'session'}),reset:async()=>{resets.push(true);game=null;index=0;}};
}
function fakeNative(){
  const calls=[];
  const tools=['get_pokemon','calculate_speed','simulate_turn'].map(name=>({name,description:'Synthetic native schema fixture; no actual MCP evidence.',inputSchema:{type:'object',properties:name==='simulate_turn'?{request:{anyOf:[{type:'object',properties:{kind:{const:'observed'},source:{type:'object'}}},{type:'object',properties:{kind:{const:'explicit'},position:{type:'object'}}}]}}:{gen:{type:'integer'},fixture:{type:'string'}},additionalProperties:false}}));
  return {calls,listTools:async()=>({tools}),callTool:async({name,arguments:args})=>{calls.push({name,args:structuredClone(args)});
    return name==='simulate_turn'?{structuredContent:{engine:{gen:0},source:{kind:'explicit-offline-snapshot',liveFreshness:false},samples:[{fixtureOnly:true}]}}:{content:[{type:'text',text:'Synthetic tool response, not a numerical result.'}]};}};
}
const rangeArguments=()=>({gen:0,attacker:'Rillaboom',defender:'Farigiraf',move:'Tackle',
  attackerOptions:{ability:'Grassy Surge',item:'',status:'',boosts:{}},defenderOptions:{ability:'Armor Tail',item:'',status:'',boosts:{}},
  attackerDomain:{kind:'candidates',label:'Synthetic contract only; not a tactical hypothesis',candidates:[{nature:'Adamant',statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0}}]},
  defenderDomain:{kind:'candidates',label:'Synthetic contract only; no numerical evidence',candidates:[{nature:'Adamant',statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0}}]},
  attackerHP:{kind:'full'},defenderHP:{kind:'full'},moveOptions:{},field:{gameType:'Doubles',weather:'',terrain:''},
  work:{maxCalculations:1,concurrency:1,requireExhaustive:true}});
function fakeRangeReply({partial=false}={}){
  const witness={id:'synthetic-not-numerical-evidence',status:'complete',inputSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),range:[1,2]};
  return {structuredContent:{kind:'champions-damage-range-v1',gen:0,status:partial?'partial-candidate-envelope':'complete-finite-domain',
    damageRange:{min:1,max:2,unit:'actual-hp',scope:partial?'evaluated-legal-witnesses-only':'all-declared-finite-assignments',minimumWitness:structuredClone(witness),maximumWitness:structuredClone(witness)},
    coverage:{completed:1,exhaustive:!partial,cancelled:false,evaluationSha256:'c'.repeat(64)},records:[witness],limitations:['Synthetic response contract only; not a native calculation.']}};
}
function withRange(native,{reply=fakeRangeReply(),advertise=true}={}){
  const list=native.listTools,call=native.callTool;
  native.listTools=async()=>({tools:[...(await list()).tools,...(advertise?[{name:'calculate_damage_range',description:'Synthetic contract fixture; no actual numerical evidence.',inputSchema:z.toJSONSchema(damageRangeToolSchema,{target:'draft-7'})}]:[])]});
  native.callTool=async request=>{if(request.name!=='calculate_damage_range')return call(request);native.calls.push({name:request.name,args:structuredClone(request.arguments)});return structuredClone(reply);};
  return native;
}
function requestRange(provider,{args=rangeArguments(),call=true}={}){
  const original=provider.decisionProvider.callDecision;
  provider.decisionProvider.callDecision=async input=>{
    if(restoreContextPayload(JSON.parse(input.input)).kind==='turn'){
      assert.match(input.instructions,/HOST-REQUIRED TECHNICAL RANGE ENDPOINT COVERAGE/u);
      assert.match(input.instructions,/does not establish model-detected research or replace the paired simulation requirement/u);
      if(call)await input.modelTools.call({name:'calculate_damage_range',arguments:structuredClone(args),callId:'synthetic-range-call',signal:input.signal,deadlineAt:input.deadlineAt});
    }
    return original(input);
  };
  return provider;
}

test('missing saved requests fail closed before provider or SDK activity',async()=>{
  const provider=fakeProvider();let connected=false;
  const result=await qualifyModelTools({provider,connect:async()=>{connected=true;throw new Error('must not connect');}});
  assert.equal(result.qualified,false);assert.equal(result.reason,'saved-model-tool-requests-required');assert.equal(result.decisionMode,'model-tools');
  assert.equal(connected,false);assert.equal(provider.calls.length,0);assert.equal(provider.resets.length,0);
  assert.equal(hasModelToolQualificationReceipt(provider,result),false);assert.equal(hasModelToolQualificationReceipt(undefined,undefined),false);
});

test('injected complete control exercises never manufacture actual generation, SDK or paired qualification',async()=>{
  const provider=fakeProvider(),nativeClient=fakeNative();
  const result=await qualifyModelTools({provider,requests:sequence(),nativeClient,now:provider.now});
  assert.equal(result.rows.length,3);assert.equal(provider.calls.length,3);
  assert(result.rows.every(row=>row.result?.status==='submitted'&&row.localChoice?.serverAcceptance===false));
  assert.equal(nativeClient.calls.length,2);assert.deepEqual(nativeClient.calls.map(row=>row.name),['calculate_speed','simulate_turn']);
  assert.equal(nativeClient.calls[0].args.gen,0);assert.equal(nativeClient.calls[0].args.evidenceContext.teamId,teamId);
  assert.equal(nativeClient.calls[1].args.request.kind,'explicit');assert.equal(Object.hasOwn(nativeClient.calls[1].args.request,'source'),false);
  for(const field of ['qualified','generationObserved','modelToolWorkflowQualified','modelRequestedMcpQualified','technicalModelToolQualified','pairedSimulationQualified','sessionContinuityQualified'])assert.equal(result[field],false,field);
  assert.deepEqual(result.completedActualMcpCalls,[]);assert.equal(result.automaticNumericalCalls,0);assert.equal(result.battlesStarted,0);assert.equal(result.battleAuthenticationCalls,0);
  assert.equal(hasModelToolQualificationReceipt(provider,result),false);assert.equal(hasModelToolQualificationReceipt(provider,{...result,qualified:true}),false);
  assert(provider.calls.every(call=>call.deadlineAt===50000));
  assert.match(result.simulationQualification,/model-authored explicit hypothetical/u);
});

test('main qualification explicitly requests an isolated child and registers each exact saved case without minting proof',async()=>{
  const provider=fakeProvider(),client=fakeNative(),requests=sequence(),registrations=[];let closed=false;
  const result=await qualifyModelTools({provider,requests,now:provider.now,connect:async options=>{
    assert.deepEqual(options,{qualificationOnly:true});return {client,qualificationAuthority:{mode:'child-local-saved-research',liveQuotaExercised:false,liveDescriptorAccessed:false},
      registerQualificationCase:async spec=>{registrations.push(structuredClone(spec));return {status:'registered',caseId:spec.caseId,sourceSha256:spec.sourceSha256,factsSha256:spec.factsSha256,liveQuotaExercised:false};},close:async()=>{closed=true;}};
  }});
  assert.equal(closed,true);assert.equal(registrations.length,3);assert.equal(new Set(registrations.map(r=>r.caseId)).size,3);
  for(const [i,spec]of registrations.entries()){
    const original=requests[i],binding=original.context.binding;
    assert.deepEqual(spec.contexts,[{source:Object.fromEntries(['sessionId','teamId','room','rqid','token'].map(key=>[key,binding[key]])),analysis:'current'}]);
    assert.equal(spec.turn,original.state.boards[0].turn);assert.equal(spec.kind,original.action.kind);assert.equal(spec.deadlineAt,result.rows[i].deadlineAt);
    assert.equal(spec.deadlineAt-result.rows[i].startedAt,40000);assert.equal(spec.sourceSha256,result.rows[i].sourceSha256);
  }
  assert.equal(result.qualified,false);assert.equal(result.liveQuotaExercised,false);assert.equal(hasModelToolQualificationReceipt(provider,result),false);
});

test('advertised compact interface requires its verified saved-source route and never falls through to a live descriptor',async()=>{
  const provider=fakeProvider({research:false}),native=fakeNative(),list=native.listTools,original=provider.decisionProvider.callDecision,answers=[];
  native.listTools=async()=>({tools:[...(await list()).tools,{name:'simulate_choices',description:'Actual compact argument contract; injected transport grants no SDK qualification.',annotations:{readOnlyHint:true},inputSchema:z.toJSONSchema(simulationChoicesToolSchema,{target:'draft-7'})}]});
  provider.decisionProvider.callDecision=async input=>{
    assert(!input.modelTools.definitions.some(t=>t.name==='simulate_turn'));
    if(restoreContextPayload(JSON.parse(input.input)).kind==='turn'){
      assert.match(input.instructions,/HOST-REQUIRED TECHNICAL ENDPOINT COVERAGE/u);
      answers.push(await input.modelTools.call({name:'simulate_choices',callId:'compact-private-source-absent',arguments:{ourActions:[{type:'move',slot:1},{type:'move',slot:1}],opposingActions:[{type:'move',slot:1},{type:'move',slot:1}]},signal:input.signal,deadlineAt:input.deadlineAt}));
    }
    return original(input);
  };
  const result=await qualifyModelTools({provider,requests:sequence(),nativeClient:native,now:provider.now});
  assert.equal(result.compactCatalogAdvertised,true);assert.equal(result.compactChoiceSimulationQualified,false);assert.equal(result.modelDetectedResearchQualified,false);
  assert.equal(result.qualified,false);assert.equal(result.joinedCompactQualificationReceipts.length,0);assert.equal(native.calls.length,0);assert.equal(answers.length,1);
  assert.match(JSON.stringify(answers[0]),/verified genuine start prefix/u);assert.equal(hasModelToolQualificationReceipt(provider,result),false);
});

test('missing, altered or stale full guidance, native request and scope are rejected before generation',async()=>{
  for(const mutate of [
    row=>{const payload=JSON.parse(row.context.input);delete payload.matchupSkill;row.context.input=JSON.stringify(payload);},
    row=>{const payload=JSON.parse(row.context.input);payload.matchupSkill.files[0].content+='damaged';row.context.input=JSON.stringify(payload);},
    row=>{const payload=JSON.parse(row.context.input);payload.automaticThreatScreen={source:'injected-host-screen'};row.context.input=JSON.stringify(payload);},
    row=>{const payload=JSON.parse(row.context.input);payload.tacticalEvidence={criticalIncoming:[]};row.context.input=JSON.stringify(payload);},
    row=>{delete row.state.actions[0].legalActions;},row=>{row.action.token='f'.repeat(64);},row=>{row.context.binding.boardHash='f'.repeat(64);},
    row=>{row.identity.teamId='f'.repeat(64);},row=>{row.context.promptMetadata.decisionMode='atomic';},
  ]){
    const requests=sequence(),provider=fakeProvider();mutate(requests[1]);
    await assert.rejects(qualifyModelTools({provider,requests,nativeClient:fakeNative(),now:provider.now}));
    assert.equal(provider.calls.length,0);assert.equal(provider.resets.length,0);
  }
});

test('a cached JSON result, altered report or different provider cannot create an admission receipt',async()=>{
  const provider=fakeProvider(),result=await qualifyModelTools({provider});
  assert.equal(Object.isFrozen(result),true);
  for(const candidate of [result,structuredClone(result),{...result,qualified:true,modelToolWorkflowQualified:true,savedPositionQualified:true,pairedSimulationQualified:true,liveObservedSimulationQualified:true}]){
    assert.equal(hasModelToolQualificationReceipt(provider,candidate),false);
    assert.equal(hasModelToolQualificationReceipt(provider.decisionProvider,candidate),false);
    assert.equal(hasModelToolQualificationReceipt(fakeProvider(),candidate),false);
  }
});

test('late or invalid final choices cannot earn technical or live admission',async()=>{
  for(const options of [{late:true},{wrongChoice:true}]){
    const provider=fakeProvider(options),result=await qualifyModelTools({provider,requests:sequence(),nativeClient:fakeNative(),now:provider.now});
    assert.equal(result.qualified,false);assert.equal(result.technicalModelToolQualified,false);assert.equal(result.modelToolWorkflowQualified,false);
    assert(result.rows.some(row=>row.error||!row.localChoice));
    assert.equal(hasModelToolQualificationReceipt(provider,result),false);
  }
});

test('the qualifier never guesses an observed simulation reconstruction or reads a current descriptor',async()=>{
  const provider=fakeProvider({research:false}),original=provider.decisionProvider.callDecision,nativeClient=fakeNative();
  provider.decisionProvider.callDecision=async input=>{
    const payload=restoreContextPayload(JSON.parse(input.input));
    if(payload.kind==='turn'){
      const result=await input.modelTools.call({name:'simulate_turn',arguments:{request:{kind:'observed',hypotheses:{mode:'current',label:'fixture only'}}},callId:'fixture-unsupported-observed',signal:input.signal,deadlineAt:input.deadlineAt});
      assert.equal(result.isError,true);assert.match(result.content[0].text,/audited offline reconstruction/u);
    }
    return original(input);
  };
  const result=await qualifyModelTools({provider,requests:sequence(),nativeClient,now:provider.now});
  assert.equal(nativeClient.calls.length,0);assert.equal(result.pairedSimulationQualified,false);assert.equal(result.qualified,false);
});

test('advertised range coverage is neutral, original-clock and joined to exact authored input/source/native return without forging SDK proof',async()=>{
  const provider=requestRange(fakeProvider({research:false})),native=withRange(fakeNative());
  const result=await qualifyModelTools({provider,requests:sequence(),nativeClient:native,now:provider.now});
  assert.equal(result.rangeCatalogAdvertised,true);assert.equal(result.rangeWorkflowQualified,false);assert.equal(result.modelDetectedResearchQualified,false);
  assert.equal(result.rangeQualificationChecks.length,1);const check=result.rangeQualificationChecks[0];
  assert.equal(check.mechanicalChecksPassed,true,JSON.stringify({check,call:result.rows[1].authoredDecision?.modelToolCalls}));assert.equal(check.checks.actualSdkReceipt,false);assert.equal(check.joined,false);
  assert.deepEqual(result.joinedRangeQualificationReceipts,[]);assert.equal(check.requestDigest,sequence()[1].context.binding.requestDigest);
  assert.equal(check.deadlineAt,50000);assert(provider.calls.every(call=>call.deadlineAt===50000));
  assert.equal(native.calls.length,1);assert.equal(native.calls[0].name,'calculate_damage_range');assert.equal(native.calls[0].args.gen,0);
  assert.deepEqual(native.calls[0].args.evidenceContext,{teamId,roomId:sequence()[1].action.room,turn:2});
  const {evidenceContext,researchContext,...authored}=native.calls[0].args;
  assert.deepEqual(authored,rangeArguments());
  const action=sequence()[1].action;
  assert.deepEqual(researchContext,{source:{sessionId,teamId,room:action.room,rqid:action.rqid,token:action.token},analysis:'current'});
  assert.equal(result.pairedSimulationQualified,false,'range-only work cannot replace paired simulation');
  assert.equal(result.qualified,false);assert.equal(hasModelToolQualificationReceipt(provider,{...result,qualified:true,rangeWorkflowQualified:true}),false);
});

test('range declaration alone, invalid gen, unavailable or altered native range results never satisfy endpoint evidence',async()=>{
  for(const variant of ['not-called','gen9','unavailable','wrong-gen','missing-witness','redacted-native']){
    const reply=fakeRangeReply();
    if(variant==='unavailable'){reply.isError=true;reply.structuredContent.status='unavailable';reply.structuredContent.damageRange=null;}
    if(variant==='wrong-gen')reply.structuredContent.gen=9;
    if(variant==='missing-witness')reply.structuredContent.records=[];
    if(variant==='redacted-native')reply.structuredContent.cookie='synthetic-sensitive-field';
    const args=rangeArguments();if(variant==='gen9')args.gen=9;
    const provider=requestRange(fakeProvider({research:false}),{args,call:variant!=='not-called'});
    const result=await qualifyModelTools({provider,requests:sequence(),nativeClient:withRange(fakeNative(),{reply}),now:provider.now});
    assert.equal(result.rangeCatalogAdvertised,true,variant);assert.equal(result.rangeWorkflowQualified,false,variant);
    assert.equal(result.qualified,false,variant);assert.equal(result.joinedRangeQualificationReceipts.length,0,variant);
    if(variant==='not-called')assert.equal(result.rangeQualificationChecks.length,0);
    else assert.equal(result.rangeQualificationChecks[0].mechanicalChecksPassed,false,variant);
  }
});

test('labeled partial range evidence stays partial and a legacy catalog never mints the new range qualification',async()=>{
  const provider=requestRange(fakeProvider({research:false}));
  const result=await qualifyModelTools({provider,requests:sequence(),nativeClient:withRange(fakeNative(),{reply:fakeRangeReply({partial:true})}),now:provider.now});
  assert.equal(result.rangeQualificationChecks[0].mechanicalChecksPassed,true);assert.equal(result.rangeWorkflowQualified,false);
  assert.equal(result.nativeJournal[0].result.structuredContent.status,'partial-candidate-envelope');
  assert.equal(result.nativeJournal[0].result.structuredContent.coverage.exhaustive,false);
  const legacy=fakeProvider(),legacyResult=await qualifyModelTools({provider:legacy,requests:sequence(),nativeClient:fakeNative(),now:legacy.now});
  assert.equal(legacyResult.rangeCatalogAdvertised,false);assert.equal(legacyResult.rangeWorkflowQualified,false);
  assert.deepEqual(legacyResult.rangeQualificationChecks,[]);assert.deepEqual(legacyResult.joinedRangeQualificationReceipts,[]);
});

const genuineRequestsFile=(process.env.VGC_TEST_SAVED_REQUESTS??'');
test('main bridge delivers single-trajectory policy refusal to the author without a second native callback or positive refusal receipt',{skip:!existsSync(genuineRequestsFile)},async()=>{
  const workspace=fileURLToPath(new URL('../',import.meta.url)),document=JSON.parse(await readFile(genuineRequestsFile,'utf8'));
  const requests=document.requests.map(row=>({...row,context:buildModelToolContext({state:row.state,ownTeamText:row.ownTeamText,opponentSheet:row.opponentSheet,...ISOLATED_POLICY_SOURCE})}));
  const material=requests.find(row=>row.materialRequired),answers=[],nativeCalls=[],provider=fakeProvider({research:false}),original=provider.decisionProvider.callDecision;
  provider.decisionProvider.callDecision=async input=>{
    const payload=restoreContextPayload(JSON.parse(input.input));
    if(payload.kind==='turn'&&input.sessionScope.gameId===material.action.room.replace(/-[a-z0-9]+pw$/u,'')){
      const pair={ourActions:[{type:'move',slot:1,target:2},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3},{type:'move',slot:1}]};
      answers.push(await input.modelTools.call({name:'simulate_choices',callId:'original-single-question',arguments:pair,signal:input.signal}));
      answers.push(await input.modelTools.call({name:'simulate_choices',callId:'changed-question-after-single',arguments:{...pair,ourActions:[{type:'move',slot:4},{type:'move',slot:4}]},signal:input.signal}));
    }
    return original(input);
  };
  const nativeClient={listTools:async()=>({tools:[{name:'simulate_choices',description:'Current one-trajectory schema.',annotations:{readOnlyHint:true},inputSchema:z.toJSONSchema(simulationChoicesToolSchema,{target:'draft-7'})}]}),callTool:async request=>{
    nativeCalls.push(request);assert.equal(request.name,'simulate_turn');const {researchContext,...args}=request.arguments;
    const result=await executeSimulation(args,{workspace,run:simulateNativeTurn});return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
  }};
  const result=await qualifyModelTools({provider,requests,nativeClient,workspace});
  assert.equal(answers.length,2);assert.match(JSON.stringify(answers[0]),/native-choice-outcome-v1/u);assert.match(JSON.stringify(answers[1]),/research-budget-status/u);assert.match(JSON.stringify(answers[1]),/budget-used/u);assert.match(JSON.stringify(answers[1]),/offline-saved-source-policy-emulation/u);
  assert.equal(nativeCalls.length,1);assert.equal(result.compactQualificationReceipts.length,1);assert.equal(result.qualified,false);assert.equal(hasModelToolQualificationReceipt(provider,result),false,'an injected provider/client cannot mint genuine admission');
});
