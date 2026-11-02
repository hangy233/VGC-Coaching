import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperator} from '../showdown/operator-client.mjs';
import {bindModelToolArguments,modelToolDefinition,MODEL_TOOL_NAMES} from '../showdown/model-owned-tools.mjs';
import {z} from 'zod';
import {simulationToolSchema} from '../simulation/schemas.mjs';
import {deliveryCheckSchema} from '../planning/delivery.mjs';
import {boardDigest,digest} from '../planning/identity.mjs';

const TEAM='a'.repeat(64),TOKEN='b'.repeat(64),LEASE='c'.repeat(64),SESSION='model-tool-fixture',ROOM='battle-gen9championsvgc2026regmcbo3-191';
const pair=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:2}];
const raw=result=>({structuredContent:{ok:true,result}});
const nativeSchema={type:'object',required:['request','evidenceContext'],properties:{
  request:{$ref:'#/$defs/Request'},evidenceContext:{type:'object'},budgetMs:{type:'integer'}},$defs:{
  Request:{allOf:[{$ref:'#/$defs/Observed'}]},Observed:{anyOf:[{type:'object',required:['kind','source','hypotheses','branches','seeds'],properties:{
    kind:{const:'observed'},source:{$ref:'#/$defs/PrivateSource'},hypotheses:{type:'object',properties:{spreads:{type:'array'}}},branches:{type:'array'},seeds:{type:'array'}}}]},
  PrivateSource:{type:'object',required:['token'],properties:{token:{type:'string'}}}}};
const nativeTools=()=>MODEL_TOOL_NAMES.map(name=>({name,description:'Actual native '+name,inputSchema:['simulate_turn','battle_check_plan'].includes(name)?structuredClone(nativeSchema):{type:'object',properties:{name:{type:'string'},gen:{type:'integer'},evidenceContext:{type:'object'}},required:['evidenceContext']},annotations:{readOnlyHint:true}}));
function fixture({toolResult,uncertain,toolDelay=0,toolHook,mutationHook,now=1000}={}){
  let time=now,claimed=false;
  const legal={active:[{moves:[{move:'Tackle',target:'normal',pp:10}]},{moves:[{move:'Tackle',target:'normal',pp:10}]}],pokemon:[{ident:'p1: One',details:'Rillaboom',condition:'100/100',active:true},{ident:'p1: Two',details:'Incineroar',condition:'100/100',active:true}]};
  const current={sessionId:SESSION,teamSha256:TEAM,username:'Fixture',connected:true,authenticated:true,stopped:false,
    controller:{required:true,owner:'ModelFixture',generation:1},revision:5,
    actions:[{room:ROOM,rqid:4,token:TOKEN,kind:'turn',actionable:true,legalActions:legal}],
    rooms:[{id:ROOM,ended:false}],search:{searching:[],games:{[ROOM]:true}},controlPolicy:{halted:false,pending:[{room:ROOM,rqid:4,token:TOKEN,cutoffAt:50000}]},
    boards:[{room:ROOM,turn:1,ownSide:'p1',request:{rqid:4,...legal},field:{},
      sides:[{id:'p1',pokemon:[{id:'own-one',hp:{current:100,max:100}}]},{id:'p2',pokemon:[{id:'foe-one',hp:{current:100,max:100}}]}]}]};
  // This pin represents what the model received. Never recompute it from a
  // possibly changed board when a later callback or zero-tool final arrives.
  const expectedSource=Object.freeze({boardHash:boardDigest(current.boards[0],legal),legalHash:digest(legal)});
  const calls=[],publications=[],catalog=nativeTools();let sequence=0;
  const client={async listTools(){calls.push({name:'listTools'});return {tools:[...catalog,{name:'battle_start',inputSchema:{}},{name:'arbitrary_shell',inputSchema:{}},{name:'team_metrics_report',inputSchema:{}}]};},
    async callTool({name,arguments:args},_schema,options){
      calls.push({name,args:structuredClone(args),options});
      if(name==='battle_status'||name==='battle_turn_status'||name==='battle_wait')return raw(structuredClone(current));
      if(name==='battle_control_claim'){claimed=true;return raw({controllerLease:LEASE,owner:'ModelFixture',generation:1});}
      if(name==='battle_control_release'){claimed=false;return raw({released:true});}
      if(mutationHook&&['battle_stage_fallback','battle_choose'].includes(name))return mutationHook({name,args,options,current});
      if(name==='battle_stage_fallback'){if(uncertain==='stage')throw Error('Fixture stage outcome unknown');return raw({pending:[{token:TOKEN,hasFallback:true,fallbackSource:'fallback',attempted:false}]});}
      if(name==='battle_choose'){if(uncertain==='choose')throw Error('Fixture choose outcome unknown');current.actions=[];return raw({status:'sent-not-acknowledged'});}
      if(MODEL_TOOL_NAMES.includes(name)){if(toolHook)return toolHook({name,args,options,current});if(toolDelay)await new Promise(resolve=>setTimeout(resolve,toolDelay));return toolResult===undefined?{structuredContent:{range:[20,40],details:{unknown:null,exact:'x'.repeat(3000)},source:{sessionId:SESSION,token:TOKEN}}}:toolResult;}
      throw Error('Unexpected fixture tool '+name);
    }};
  const operator=createOperator({client,responseFile:'unused-model-tools.json',now:()=>time,readTimeoutMs:100,mutationTimeoutMs:100,budgetMs:10,publish:async(_file,id,value)=>publications.push({id,value})});
  const dispatch=(q,metadata)=>operator.dispatch({id:'m'+(++sequence),
    ...(['model-tool','model-play'].includes(q.op)?{expectedSource:structuredClone(expectedSource)}:{}),...q},metadata);
  const arm=()=>dispatch({op:'arm',confirmed:true,expectedSessionId:SESSION,expectedTeamId:TEAM,expectedAccount:'Fixture'});
  const claim=()=>dispatch({op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:'model_fixture_claim',controllerId:'ModelFixture'}});
  const setup=async()=>{await arm();await claim();assert.equal((await dispatch({op:'model-tool-mode',enabled:true})).result.enabled,true);return dispatch({op:'model-tool-catalog'});};
  const source={room:ROOM,rqid:4,token:TOKEN,deadlineAt:40000};
  return {operator,dispatch,setup,arm,claim,current,calls,publications,catalog,source,expectedSource,setTime:value=>{time=value;},get claimed(){return claimed;}};
}

test('model tool schema projection omits only private bound paths across references and unions',()=>{
  const actual={name:'simulate_turn',description:'actual native',inputSchema:structuredClone(nativeSchema)},before=structuredClone(actual);
  const projected=modelToolDefinition(actual);assert.deepEqual(actual,before);assert.match(projected.nativeSchemaSha256,/^[a-f0-9]{64}$/u);
  assert.deepEqual(projected.hostBoundFields,['request.source','evidenceContext','researchContext']);
  assert.equal(projected.inputSchema.properties.evidenceContext,undefined);assert.deepEqual(projected.inputSchema.required,['request']);
  const observed=projected.inputSchema.$defs.Observed.anyOf[0],original=actual.inputSchema.$defs.Observed.anyOf[0];
  assert.equal(observed.properties.source,undefined);assert.deepEqual(observed.required,original.required.filter(key=>key!=='source'));
  for(const key of ['kind','hypotheses','branches','seeds'])assert.deepEqual(observed.properties[key],original.properties[key]);
  assert.throws(()=>modelToolDefinition({name:'battle_check_plan',inputSchema:{},annotations:{readOnlyHint:false}}),/read-only/u);
});

test('numeric catalog keeps authored numerical inputs while hiding the private shared-budget binding',()=>{
  for(const name of ['calculate_damage','calculate_damage_range','calculate_speed']){
    const authored={type:'array',items:{type:'object',properties:{species:{type:'string'}}}};
    const native={name,inputSchema:{type:'object',properties:{pokemon:authored,evidenceContext:{type:'object'},researchContext:{type:'object'}},required:['pokemon','researchContext']}};
    const original=structuredClone(native),visible=modelToolDefinition(native);
    assert.deepEqual(native,original);
    assert.deepEqual(visible.inputSchema.properties.pokemon,authored);
    assert.deepEqual(visible.inputSchema.required,['pokemon']);
    assert.equal(visible.inputSchema.properties.researchContext,undefined);
    assert.equal(visible.inputSchema.properties.evidenceContext,undefined);
  }
});

test('actual native simulation catalogs expose observed-only calls with full authored hypotheses, pairs and seeds',()=>{
  const variants=(node,root)=>{if(node.$ref){let target=root;for(const part of node.$ref.slice(2).split('/'))target=target[part.replace(/~1/gu,'/').replace(/~0/gu,'~')];return variants(target,root);}for(const key of ['anyOf','oneOf','allOf'])if(node[key])return node[key].flatMap(child=>variants(child,root));return [node];};
  for(const [name,schema] of [['simulate_turn',simulationToolSchema],['battle_check_plan',deliveryCheckSchema]]){
    const inputSchema=z.toJSONSchema(schema,{reused:'ref'}),before=structuredClone(inputSchema),projected=modelToolDefinition({name,inputSchema,annotations:{readOnlyHint:true}});
    const original=variants(inputSchema.properties.request,inputSchema),live=variants(projected.inputSchema.properties.request,projected.inputSchema);
    assert(original.some(row=>row.properties.kind.const==='explicit'));assert.equal(live.length,1);assert.equal(live[0].properties.kind.const,'observed');assert.equal(live[0].properties.source,undefined);
    const observed=original.find(row=>row.properties.kind.const==='observed');for(const field of ['hypotheses','branches','seeds'])assert.deepEqual(live[0].properties[field],observed.properties[field]);
    assert.deepEqual(inputSchema,before);assert.throws(()=>bindModelToolArguments(name,{request:{kind:'explicit'}},{source:{},turn:1}),/observed/u);
  }
});

test('model-owned tool mode requires armed current ownership and exposes only actual allowed schemas',async()=>{
  const f=fixture();assert.match((await f.dispatch({op:'model-tool-mode',enabled:true})).error,/arm/u);await f.arm();assert.match((await f.dispatch({op:'model-tool-mode',enabled:true})).error,/claim/u);
  await f.claim();f.current.controller.generation=2;assert.match((await f.dispatch({op:'model-tool-mode',enabled:true})).error,/exclusive/u);f.current.controller.generation=1;
  assert.equal((await f.dispatch({op:'model-tool-mode',enabled:true})).result.enabled,true);
  f.catalog.splice(f.catalog.findIndex(tool=>tool.name==='get_ability'),1);f.catalog.find(tool=>tool.name==='battle_check_plan').annotations.readOnlyHint=false;
  const catalog=await f.dispatch({op:'model-tool-catalog'});assert.equal(catalog.error,undefined);
  assert.deepEqual(catalog.result.tools.map(tool=>tool.name),MODEL_TOOL_NAMES.filter(name=>!['get_ability','battle_check_plan'].includes(name)).sort());
  assert.equal(catalog.result.source,'actual-native-mcp-listTools');assert.equal(f.calls.some(call=>MODEL_TOOL_NAMES.includes(call.name)),false);
  assert.match((await f.dispatch({op:'model-tool',...f.source,name:'battle_start',args:{}})).error,/allowlist/u);
});

test('model catalog reads every native page within one bound and refuses repeated cursors',async()=>{
  const f=fixture();await f.arm();await f.claim();await f.dispatch({op:'model-tool-mode',enabled:true});
  // Inject the SDK through its own returned catalog surface, never by inventing
  // an operator tool name or reconstructing a schema from the source tree.
  const tools=nativeTools();let page=0;const calls=[];
  const client={async callTool({name}){if(name==='battle_control_claim')return raw({controllerLease:LEASE,owner:'ModelFixture',generation:1});return raw(structuredClone(f.current));},
    async listTools(params){calls.push(params);return ++page===1?{tools:tools.slice(0,3),nextCursor:'native-next'}:{tools:tools.slice(3)};}};
  const operator=createOperator({client,responseFile:'unused-model-catalog.json',now:()=>1000,readTimeoutMs:100,publish:async()=>{}});
  await operator.dispatch({id:'page-arm',op:'arm',confirmed:true,expectedSessionId:SESSION,expectedTeamId:TEAM});await operator.dispatch({id:'page-claim',op:'call',name:'battle_control_claim',args:{confirmed:true,controllerId:'ModelFixture',commandId:'page_claim'}});await operator.dispatch({id:'page-mode',op:'model-tool-mode',enabled:true});
  const out=await operator.dispatch({id:'pages',op:'model-tool-catalog'});assert.equal(out.error,undefined);assert.equal(out.result.tools.length,MODEL_TOOL_NAMES.length);assert.deepEqual(calls,[undefined,{cursor:'native-next'}]);
  client.listTools=async()=>({tools:[],nextCursor:'loop'});assert.match((await operator.dispatch({id:'repeated-pages',op:'model-tool-catalog'})).error,/repeated/u);
});

test('model research forwards authored arguments to actual SDK and preserves complete results without planning or staging',async()=>{
  const f=fixture();await f.setup();
  const research={hypotheses:{spreads:[{label:'model unknown investment',points:[1,2,3]}]},branches:[{id:'model-pair',ourActions:pair,opposingActions:pair,gate:{kind:'delivery'}}],seeds:[[1,2,3,4]]};
  const compact={ourActions:pair,opposingActions:pair,alternatives:[{id:'model-alternative',ourActions:pair,opposingActions:pair}],continuations:[{ourActions:[{type:'switch',slot:3},{type:'pass'}]}]};
  const numerical=['calculate_damage','calculate_damage_range','calculate_speed'];
  const expectedSource={sessionId:SESSION,teamId:TEAM,room:ROOM,rqid:4,token:TOKEN},expectedEvidence={teamId:TEAM,roomId:ROOM,turn:1};
  for(const name of MODEL_TOOL_NAMES){
    const args=name==='simulate_choices'?structuredClone(compact):['simulate_turn','battle_check_plan'].includes(name)?{request:{kind:'observed',...structuredClone(research)}}:numerical.includes(name)?{gen:0,pokemon:[{label:'model authored'}],customUnknown:null}:{name:'model query'};
    const before=structuredClone(args),out=await f.dispatch({op:'model-tool',...f.source,name,args});assert.equal(out.error,undefined,JSON.stringify(out));assert.deepEqual(args,before);
    const sent=f.calls.findLast(call=>call.name===name).args;
    if(name==='simulate_choices'){
      const {source,analysis,evidenceContext,...rest}=sent;assert.deepEqual(rest,args);assert.deepEqual(source,expectedSource);assert.equal(analysis,'current');assert.deepEqual(evidenceContext,expectedEvidence);assert.equal(Object.hasOwn(sent,'freezeId'),false);
    }else if(['simulate_turn','battle_check_plan'].includes(name)){
      const {source,...rest}=sent.request;assert.deepEqual(rest,args.request);assert.deepEqual(source,expectedSource);
      if(name==='simulate_turn')assert.deepEqual(sent.evidenceContext,expectedEvidence);else assert.equal(Object.hasOwn(sent,'evidenceContext'),false);
      assert.deepEqual(sent.researchContext,{source:expectedSource,analysis:'current'});assert.deepEqual(Object.keys(sent).sort(),name==='simulate_turn'?['evidenceContext','request','researchContext']:['request','researchContext']);
    }else if(numerical.includes(name)){const {evidenceContext,researchContext,...rest}=sent;assert.deepEqual(rest,args);assert.deepEqual(evidenceContext,expectedEvidence);assert.deepEqual(researchContext,{source:expectedSource,analysis:'current'});}
    else assert.deepEqual(sent,{...args,gen:0});
    assert.equal(out.result.result.details.exact.length,3000);assert.equal(out.result.result.details.unknown,null);assert.deepEqual(out.result.result.range,[20,40]);
    assert.equal(out.result.result.source.token,'[redacted]');assert.equal(out.result.receipt.nativeMcp,true);assert.equal(out.result.receipt.modelRequested,true);assert.equal(out.result.receipt.hostPlanning,false);
    assert(!JSON.stringify(out).includes(LEASE));assert(!JSON.stringify(out).includes(TOKEN));
  }
  assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose','battle_turn_brief','battle_prepare_checks'].includes(call.name)),false);
});

test('private overrides and nonnative generation are refused instead of filling tactical research inputs',()=>{
  const source={sessionId:SESSION,teamId:TEAM,room:ROOM,rqid:4,token:TOKEN};
  for(const name of ['calculate_damage','calculate_damage_range','calculate_speed']){
    assert.equal(bindModelToolArguments(name,{}, {source,turn:1}).gen,0);
    for(const args of [{gen:9},{gen:0,evidenceContext:{}},{researchContext:{}},{controllerLease:LEASE}])assert.throws(()=>bindModelToolArguments(name,args,{source,turn:1}));
  }
  for(const name of ['get_pokemon','get_move','get_ability','get_movepool']){assert.equal(bindModelToolArguments(name,{name:'model query'},{source,turn:1}).gen,0);assert.throws(()=>bindModelToolArguments(name,{gen:9,name:'model query'},{source,turn:1}));}
  for(const args of [{request:{kind:'explicit'}},{request:{kind:'observed',source:{}}},{request:{kind:'observed'},evidenceContext:{}}])assert.throws(()=>bindModelToolArguments('simulate_turn',args,{source,turn:1}));
  const authored={request:{kind:'observed',hypotheses:{},branches:[],seeds:[]}},out=bindModelToolArguments('simulate_turn',authored,{source,turn:1});
  assert.deepEqual(out.request.branches,[]);assert.deepEqual(out.request.seeds,[]);assert.deepEqual(out.request.hypotheses,{});
  const compact={ourActions:structuredClone(pair),opposingActions:structuredClone(pair)};
  for(const key of ['source','analysis','freezeId','evidenceContext'])assert.throws(()=>bindModelToolArguments('simulate_choices',{...compact,[key]:{}},{source,turn:1}));
  const bound=bindModelToolArguments('simulate_choices',compact,{source,turn:1});assert.deepEqual(bound.ourActions,compact.ourActions);assert.deepEqual(bound.opposingActions,compact.opposingActions);assert.deepEqual(bound.source,source);assert.equal(bound.analysis,'current');assert.deepEqual(bound.evidenceContext,{teamId:TEAM,roomId:ROOM,turn:1});
});

test('the first model callback refuses same-token HP or field changes against the original context pin',async()=>{
  for(const change of [f=>{f.current.boards[0].sides[0].pokemon[0].hp.current=99;},
    f=>{f.current.boards[0].field.weather={id:'rain'};}]){
    const f=fixture(),initialPin=structuredClone(f.expectedSource);await f.setup();change(f);
    assert.equal(f.current.actions[0].token,TOKEN);assert.equal(f.current.actions[0].rqid,4);
    assert.deepEqual(f.expectedSource,initialPin,'The fixture must retain the model-delivered source, not repin a callback.');
    const out=await f.dispatch({op:'model-tool',...f.source,name:'calculate_damage',args:{gen:0}});
    assert.match(out.error,/context source changed/u);
    assert.equal(f.calls.some(call=>MODEL_TOOL_NAMES.includes(call.name)),false,'No actual research may precede the initial-source refusal.');
    assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose'].includes(call.name)),false);
  }
  const normal=fixture();await normal.setup();normal.current.boards[0].observedAt=2000;
  normal.current.boards[0].recentEvents={lines:['Nonmechanical presentation changed.']};
  assert.equal((await normal.dispatch({op:'model-tool',...normal.source,name:'get_move',args:{name:'Protect'}})).error,undefined,
    'A changed observation timestamp or log presentation alone is not a changed mechanical source.');
});

test('a zero-tool final choice refuses a same-token changed board before staging or choosing',async()=>{
  for(const change of [f=>{f.current.boards[0].sides[0].pokemon[0].hp.current=99;},
    f=>{f.current.boards[0].field.weather={id:'rain'};}]){
    const f=fixture();await f.setup();change(f);
    assert.equal(f.current.actions[0].token,TOKEN);assert.equal(f.current.actions[0].rqid,4);
    const out=await f.dispatch({op:'model-play',...f.source,kind:'turn',actions:pair});
    assert.match(out.error,/context source changed/u);
    assert.equal(f.calls.some(call=>MODEL_TOOL_NAMES.includes(call.name)),false);
    assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose'].includes(call.name)),false,
      'A final decision with no earlier callback still needs the original model context pin.');
  }
});

test('actual model research uses its remaining-deadline budget independently of short status reads',async()=>{
  for(const [deadlineAt,expectedResearchTimeout]of [[40000,30000],[3000,2000]]){
    const f=fixture();await f.setup();
    const out=await f.dispatch({op:'model-tool',...f.source,deadlineAt,name:'get_move',args:{name:'Protect'}});
    assert.equal(out.error,undefined,JSON.stringify(out));
    const research=f.calls.findLast(call=>call.name==='get_move'),status=f.calls.findLast(call=>call.name==='battle_turn_status');
    assert.equal(research.options.timeout,expectedResearchTimeout,'The budget must reach the actual SDK options.');
    assert(research.options.timeout>1500);assert(research.options.timeout<=deadlineAt-1000);assert(research.options.timeout<=30000);
    assert(status.options.timeout<=100,'The fixture short-read guard remains independent of research.');
  }
});

test('model tool freshness, owner, source, native reserve and pinned original deadline fail closed',async()=>{
  for(const change of [f=>{f.current.actions[0].token='d'.repeat(64);},f=>{f.current.controller.owner='Other';},f=>{f.current.controlPolicy.pending[0].attempted=true;},f=>{f.current.connected=false;},f=>{f.current.controlPolicy.pending[0].cutoffAt=39000;},f=>{f.setTime(40000);}]){
    const f=fixture();await f.setup();change(f);const before=f.calls.filter(call=>call.name==='calculate_speed').length;
    const out=await f.dispatch({op:'model-tool',...f.source,name:'calculate_speed',args:{gen:0}});assert.equal(typeof out.error,'string');assert.equal(f.calls.filter(call=>call.name==='calculate_speed').length,before);
  }
  const f=fixture();await f.setup();assert.equal((await f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Tackle'}})).error,undefined);
  assert.match((await f.dispatch({op:'model-tool',...f.source,deadlineAt:41000,name:'get_move',args:{name:'Protect'}})).error,/extended/u);
  await f.dispatch({op:'model-tool-mode',enabled:false});await f.dispatch({op:'model-tool-mode',enabled:true});await f.dispatch({op:'model-tool-catalog'});
  assert.match((await f.dispatch({op:'model-tool',...f.source,deadlineAt:41000,name:'get_move',args:{name:'Protect'}})).error,/extended/u);
  f.current.boards[0].turn=2;assert.match((await f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Protect'}})).error,/source changed/u);
});

test('model final choice uses exactly authored pair with native legality and no host tactical audit',async()=>{
  const f=fixture();await f.setup();const out=await f.dispatch({op:'model-play',...f.source,kind:'turn',actions:pair});assert.equal(out.error,undefined,JSON.stringify(out));
  assert.deepEqual(f.calls.filter(call=>['battle_stage_fallback','battle_choose'].includes(call.name)).map(call=>call.args.actions),[pair,pair]);
  assert.equal(f.calls.filter(call=>MODEL_TOOL_NAMES.includes(call.name)).length,0);assert.equal(out.result.modelOwnedChoice.hostPlanning,false);
  const before=f.calls.length;assert.match((await f.dispatch({op:'model-play',...f.source,actions:pair})).error,/reservation/u);assert.match((await f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Tackle'}})).error,/reservation/u);assert.equal(f.calls.length,before);
});

test('illegal model choice refuses before stage or reservation and corrected legal pair remains authorable',async()=>{
  const f=fixture();await f.setup();const bad=await f.dispatch({op:'model-play',...f.source,actions:[{type:'move',slot:9,target:1},pair[1]]});assert.match(bad.error,/unavailable/u);
  assert.equal(f.calls.some(call=>['battle_stage_fallback','battle_choose'].includes(call.name)),false);assert.equal((await f.dispatch({op:'model-play',...f.source,actions:pair})).error,undefined);
});

test('uncertain model final sends remain reserved and cannot be retried by another operation',async()=>{
  for(const uncertain of ['stage','choose']){const f=fixture({uncertain});await f.setup();const out=await f.dispatch({op:'model-play',...f.source,actions:pair});assert.equal(out.error,undefined);const before=f.calls.length;
    assert.match((await f.dispatch({op:'model-play',...f.source,actions:pair})).error,/reservation/u);assert.equal(f.calls.length,before);
    assert.equal(f.calls.filter(call=>call.name==='battle_choose').length,uncertain==='choose'?1:0);}
});

test('actual negative native research and bounded timeouts remain honest evidence without choices',async()=>{
  const negative=fixture({toolResult:{isError:true,structuredContent:{reason:'native unavailable',range:null}}});await negative.setup();const out=await negative.dispatch({op:'model-tool',...negative.source,name:'calculate_damage',args:{gen:0}});assert.equal(out.result.result.isError,true);assert.equal(out.result.result.range,null);
  const slow=fixture({toolDelay:30});await slow.setup();const late=await slow.dispatch({op:'model-tool',...slow.source,deadlineAt:1010,name:'get_move',args:{name:'Tackle'}});assert.match(late.error,/budget elapsed/u);assert.equal(slow.calls.some(call=>call.name==='battle_choose'),false);
});

test('model research cancellation reaches the actual SDK and drains without crediting a late result',async()=>{
  let entered,resolveEntered;const ready=new Promise(resolve=>{resolveEntered=resolve;});let sdkAborted=false;
  const f=fixture({toolHook:({options})=>new Promise((_resolve,reject)=>{entered=true;resolveEntered();options.signal.addEventListener('abort',()=>{sdkAborted=true;reject(new Error('SDK aborted fixture'));},{once:true});})});
  await f.setup();const abort=new AbortController(),pending=f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Protect'}},{signal:abort.signal});await ready;abort.abort();
  const out=await pending;assert.equal(entered,true);assert.equal(sdkAborted,true);assert.equal(out.code,'MODEL_OPERATION_ABORTED');assert.equal(out.result,undefined);assert.equal(f.calls.filter(call=>call.name==='get_move').length,1);
  const stopped=new AbortController();stopped.abort();const before=f.calls.length;const pre=await f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Protect'}},{signal:stopped.signal});assert.equal(pre.code,'MODEL_OPERATION_ABORTED');assert.equal(f.calls.length,before);
});

test('an SDK that ignores cancellation is reported unsettled rather than treated as cancelled or retried',async()=>{
  let resolveEntered,settle;const ready=new Promise(resolve=>{resolveEntered=resolve;});
  const f=fixture({toolHook:()=>new Promise(resolve=>{settle=resolve;resolveEntered();})});await f.setup();
  const abort=new AbortController(),pending=f.dispatch({op:'model-tool',...f.source,name:'get_move',args:{name:'Protect'}},{signal:abort.signal});await ready;abort.abort();
  const out=await pending;assert.equal(out.code,'MODEL_OPERATION_ABORT_DRAIN_UNSETTLED');assert.equal(out.result,undefined);assert.equal(f.calls.filter(call=>call.name==='get_move').length,1);
  const frozen=structuredClone(out);settle({structuredContent:{nativeLateResult:'late'}});await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(out,frozen);assert.equal(f.calls.some(call=>call.name==='battle_choose'),false);
});

test('model final choice cancellation preserves a possibly dispatched mutation reservation',async()=>{
  let resolveStaged,sdkAborted=false;const ready=new Promise(resolve=>{resolveStaged=resolve;});
  const f=fixture({mutationHook:({options})=>new Promise((_resolve,reject)=>{resolveStaged();options.signal.addEventListener('abort',()=>{sdkAborted=true;reject(new Error('Stage wait aborted'));},{once:true});})});
  await f.setup();const abort=new AbortController(),pending=f.dispatch({op:'model-play',...f.source,actions:pair},{signal:abort.signal});await ready;abort.abort();
  const out=await pending;assert.equal(out.code,'MODEL_OPERATION_ABORTED');assert.equal(sdkAborted,true);assert.equal(f.calls.filter(call=>call.name==='battle_choose').length,0);
  const before=f.calls.length,again=await f.dispatch({op:'model-play',...f.source,actions:pair});assert.match(again.error,/reservation/u);assert.equal(f.calls.length,before);
});
