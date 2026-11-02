import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCandidateResearch,projectCandidateResearchReferences,CANDIDATE_RESEARCH_MAX_BYTES} from './candidate-research.mjs';
import {requestDigest,digest} from './identity.mjs';

const clone=value=>structuredClone(value),jsonBytes=value=>Buffer.byteLength(JSON.stringify(value));
function fixture(){
  const request={kind:'observed',sessionId:'session-current',teamId:'a'.repeat(64),room:'battle-gen9championsvgc2026regmc-12345',rqid:7,token:'b'.repeat(64)};
  const source={kind:'bound-observed-turn',sessionId:request.sessionId,teamId:request.teamId,room:request.room,rqid:request.rqid,boardHash:'c'.repeat(64),opposingSheetSha256:'d'.repeat(64),observedAt:100,liveFreshness:'read-and-revalidated-only'};
  source.requestDigest=requestDigest({...request,boardHash:source.boardHash});
  const legalActions={active:[{canMegaEvo:true,moves:[{move:'Liquidation',target:'normal',pp:10},{move:'Leech Life',target:'normal',pp:10},{move:'Protect',target:'self',pp:10},{move:'Iron Head',target:'normal',pp:10}]},
    {moves:[{move:'Weather Ball',target:'normal',pp:10},{move:'Ice Beam',target:'normal',pp:10},{move:'Protect',target:'self',pp:10}]}]};
  const report={status:'advisory',source,objective:{preserve:['our-b'],targets:['foe-a'],requiredActors:[]},actors:[
    {id:'our-a',own:true,slot:1,moves:['Protect','Iron Head','Leech Life','Liquidation']},
    {id:'our-b',own:true,slot:2,moves:['Protect','Ice Beam','Weather Ball']},
    {id:'foe-a',own:false,slot:1,moves:['Protect']},{id:'foe-b',own:false,slot:2,moves:['Protect']}],
    candidates:[{id:'pressure',actions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:2}]},
      {id:'preserve-partner',actions:[{type:'move',slot:2,target:2},{type:'move',slot:3}]},
      {id:'preserve-lead',actions:[{type:'move',slot:3},{type:'move',slot:2,target:1}]}],
    numericChecks:{damage:[{scenarioId:'observed',attackerId:'foe-a',defenderId:'our-b',move:'Thunderbolt',route:'active',status:'unavailable',warnings:['opposing investment unknown']}],checks:[]},order:[],coverage:{sourceRevalidated:false}};
  return {request,report,legalActions,hypotheses:[{id:'declared-unknown',label:'Opposing investment remains unknown',pokemon:{'foe-a':{item:''}}}]};
}
function actualShapedMenu(input,source,actorIds=['our-a','our-b','foe-a','foe-b']){
  const tickets=input.focus.map((focus,index)=>({id:'research-'+String(index+1).padStart(24,'0'),name:focus.kind==='move-order'?'calculate_speed':'calculate_damage',questions:[{...clone(focus),...(focus.kind==='move-order'?{actorIds:clone(actorIds),missingActors:[]}:{}),scope:'Independent current snapshot only'}]}));
  return {kind:'champions-research-menu',catalogId:'catalog-'+'e'.repeat(24),source:{...clone(source),observedAt:999,liveFreshness:'fresh-reader-metadata-only'},tickets,
    focus:input.focus.map((question,index)=>({question:clone(question),status:'ready',ids:[tickets[index].id],unavailableQuestions:0})),focusReady:true,selectedIds:tickets.map(t=>t.id),coverage:{calculationsRun:0}};
}
const options=(f,prepareChecks,extra={})=>({request:f.request,legalActions:f.legalActions,hypotheses:f.hypotheses,budgetMs:250,prepareChecks,...extra});

// Explicit synthetic receipt records only. These values exercise provenance
// validation; no competitive damage/Speed values are calculated or asserted.
function boundNumericalFixture(){
  const f=fixture(),points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};f.hypotheses=[];
  f.report.objective.preserve=[];f.report.candidates=f.report.candidates.slice(0,1);f.report.coverage.sourceRevalidated=true;
  f.report.field={weather:null,terrain:null,conditions:{}};f.report.numericContext={sides:[{id:'p1',conditions:{}},{id:'p2',conditions:{}}],hypotheses:[]};
  for(const [i,a]of f.report.actors.entries())Object.assign(a,{species:i%2?'Mewtwo':'Mew',side:a.own?'p1':'p2',selected:'selected',nature:'Serious',statPoints:clone(points),ability:'Pressure',item:'',itemKnown:true,status:'',boosts:{},hp:{current:100,max:100,precision:'exact'},raw:{fainted:false}});
  const bind=check=>{check.source=clone(f.report.source);check.inputContext={kind:'planning-numeric-context-v1',scenarioId:'observed',inputSha256:digest({tool:check.tool,input:check.input}),fieldSha256:digest(f.report.field),sidesSha256:digest(f.report.numericContext.sides),hypothesesSha256:digest(f.report.numericContext.hypotheses)};return check;};
  const stats=a=>({nature:a.nature,ability:a.ability,item:a.item,evs:clone(a.statPoints),boosts:clone(a.boosts),status:a.status,curHP:a.hp.current});
  f.report.numericChecks={damage:[],checks:[]};
  for(const [i,[attackerId,defenderId,move]]of [['our-a','foe-a','Liquidation'],['our-b','foe-b','Weather Ball']].entries()){
    const attacker=f.report.actors.find(a=>a.id===attackerId),defender=f.report.actors.find(a=>a.id===defenderId),id='bound-damage-'+i;
    const receipt={checkId:id,calculationRef:{id:'synthetic-damage-'+i},reused:false},hp={current:100,max:100,unit:'actual-hp'};
    const input={gen:0,attacker:attacker.species,defender:defender.species,move,attackerOptions:stats(attacker),defenderOptions:stats(defender),field:{}};
    const result={gen:0,range:[20,30],attackerHP:clone(hp),defenderHP:clone(hp),calculationRef:clone(receipt.calculationRef),source:clone(f.report.source)};
    f.report.numericChecks.checks.push(bind({id,tool:'calculate_damage',status:'complete',input,result,receipt:clone(receipt)}));
    f.report.numericChecks.damage.push({scenarioId:'observed',attackerId,defenderId,move,route:'active',status:'complete',checkId:id,range:clone(result.range),attackerHP:clone(hp),defenderHP:clone(hp),assumptions:[],warnings:[],receipt:clone(receipt),source:clone(f.report.source)});
  }
  const id='bound-speed',field={weather:'',terrain:'',trickRoom:false,magicRoom:false,weatherSuppressed:false},receipt={checkId:id,calculationRef:{id:'synthetic-speed'},reused:false};
  const input={gen:0,pokemon:f.report.actors.map(a=>({label:a.id,species:a.species,nature:a.nature,ability:a.ability,item:a.item,statPoints:clone(a.statPoints),boosts:{},status:'',tailwind:false})),field};
  const result={gen:0,pokemon:input.pokemon.map(a=>({label:a.label,effectiveSpeed:1,rawSpeed:1})),order:[{rank:1,labels:input.pokemon.map(a=>a.label),tie:true}],calculationRef:clone(receipt.calculationRef),source:clone(f.report.source)};
  f.report.numericChecks.checks.push(bind({id,tool:'calculate_speed',status:'complete',input,result,receipt:clone(receipt)}));
  f.report.order=[{scenarioId:'observed',status:'complete',checkId:id,pokemon:clone(result.pokemon),groups:clone(result.order),field:clone(field),assumptions:[],warnings:[],unavailable:[],receipt:clone(receipt),source:clone(f.report.source)}];
  return {...f,rebindInput:bind};
}

test('one bounded actual preparation joins existing IDs to exact pairs and uses request move-slot order',async()=>{
  const f=fixture(),before=clone(f);let calls=0,captured;
  const out=await prepareCandidateResearch(f.report,options(f,(input,extra)=>{calls++;captured=clone(input);assert.ok(extra.signal instanceof AbortSignal);return actualShapedMenu(input,f.report.source);}));
  assert.equal(calls,1);assert.ok(captured.budgetMs>=100&&captured.budgetMs<=250);assert.equal(captured.focus.length,4);
  assert.deepEqual(captured.focus[0],{kind:'damage-range',scenarioId:'observed',attackerId:'foe-a',defenderId:'our-b',move:'Thunderbolt',route:'active'});
  assert(captured.focus.some(q=>q.move==='Liquidation'));assert(!captured.focus.some(q=>q.move==='Iron Head'));
  assert.equal(captured.focus.filter(q=>q.kind==='move-order').length,1);assert(!Object.hasOwn(captured,'simulationRequests'));
  assert.deepEqual(captured.request,f.request);assert.deepEqual(captured.hypotheses,f.hypotheses);
  assert.equal(out.kind,'candidate-research-references');assert.equal(out.catalogId,'catalog-'+'e'.repeat(24));assert.equal(out.candidates.length,3);
  for(const row of out.candidates)assert.deepEqual(row.actions,f.report.candidates.find(c=>c.id===row.candidateId).actions);
  assert.equal(out.source.observedAt,undefined);assert.equal(out.source.liveFreshness,undefined);assert.equal(out.source.requestDigest,f.report.source.requestDigest);
  assert.match(out.limits,/no calculations.*usefulness.*execution credit/);assert(jsonBytes(out)<=CANDIDATE_RESEARCH_MAX_BYTES);
  assert.deepEqual(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors}),out);assert.deepEqual(f,before);
  const order=out.questions.find(q=>q.focus.kind==='move-order');assert.deepEqual(order.actorIds,['our-a','our-b','foe-a','foe-b']);
  assert.deepEqual(order.orderCoverage,{requestedActorIds:['our-a','our-b','foe-a','foe-b'],status:'complete'});
});

test('unavailable preparation and insufficient original time expose honest focus stubs without callbacks or fake IDs',async()=>{
  for(const extra of [{budgetMs:99},{budgetMs:0},{prepareChecks:undefined}]){
    const f=fixture();let calls=0;const out=await prepareCandidateResearch(f.report,options(f,()=>{calls++;throw Error('must not execute');},extra));
    assert.equal(calls,0);assert.equal(out.status,'unprepared');assert.equal(out.catalogId,undefined);assert(out.questions.every(q=>q.status==='unprepared'&&!q.id));
    assert(out.questions.every(q=>q.focus.scenarioId==='observed'));assert(out.candidates.every(c=>!c.ids));
  }
});

test('source-less, stale semantic hashes, mixed current identity and unknown semantic fields refuse every ID',async()=>{
  for(const mutate of [m=>delete m.source,m=>m.source.boardHash='f'.repeat(64),m=>m.source.requestDigest='f'.repeat(64),
    m=>m.source.opposingSheetSha256='f'.repeat(64),m=>m.source.rqid++,m=>m.source.teamId='f'.repeat(64),m=>m.source.extraSemanticFact=true]){
    const f=fixture();const out=await prepareCandidateResearch(f.report,options(f,input=>{const m=actualShapedMenu(input,f.report.source);mutate(m);return m;}));
    assert.equal(out.status,'unprepared');assert.equal(out.catalogId,undefined);assert.equal(out.source,undefined);assert(out.questions.every(q=>!q.id));
  }
});

test('unknowns and ambiguous focus stay explicit while independently ready questions retain real IDs',async()=>{
  const f=fixture();const out=await prepareCandidateResearch(f.report,options(f,input=>{
    const m=actualShapedMenu(input,f.report.source);m.focus[0]={question:clone(input.focus[0]),status:'unavailable',ids:[],unavailableQuestions:1,reasons:['opposing allocation unknown']};
    m.focus[1]={question:clone(input.focus[1]),status:'ambiguous',ids:[m.tickets[1].id,m.tickets[2].id],unavailableQuestions:0};m.focusReady=false;delete m.selectedIds;return m;
  }));
  assert.equal(out.status,'partial');assert.equal(out.questions[0].status,'unavailable');assert.equal(out.questions[0].unavailableQuestions,1);
  assert.equal(out.questions[0].id,undefined);assert.equal(out.questions[1].status,'ambiguous');assert.equal(out.questions[1].id,undefined);
  assert(out.questions.slice(2).every(q=>q.status==='ready'&&q.id));
  assert(out.candidates.some(c=>c.status==='partial'));assert.deepEqual(f.hypotheses[0].pokemon['foe-a'],{item:''});
});

test('partial native order retains explicitly missing actors without whole-turn credit',async()=>{
  const f=fixture();const out=await prepareCandidateResearch(f.report,options(f,input=>{
    const m=actualShapedMenu(input,f.report.source),order=m.tickets.find(t=>t.name==='calculate_speed');order.questions[0].actorIds=['our-a','our-b','foe-b'];order.questions[0].missingActors=[{actorId:'foe-a',reasons:[0]}];return m;
  }));
  const order=out.questions.find(q=>q.focus.kind==='move-order');assert.deepEqual(order.missingActors,['foe-a']);assert.match(out.limits,/Unknown inputs remain unknown/);
  assert.equal(order.status,'ready');assert.equal(order.orderCoverage.status,'partial');assert(out.candidates.every(c=>c.status==='partial'));
});

test('own-active-only order stays ready input but exposes a partial requested comparison',async()=>{
  const f=fixture();f.report.actors.push({id:'our-reserve-a',own:true,slot:null},{id:'our-reserve-b',own:true,slot:null});
  const out=await prepareCandidateResearch(f.report,options(f,input=>{
    const m=actualShapedMenu(input,f.report.source),order=m.tickets.find(t=>t.name==='calculate_speed');
    order.questions[0].actorIds=['our-a','our-b'];order.questions[0].missingActors=['foe-a','foe-b','our-reserve-a','our-reserve-b'].map(actorId=>({actorId,reasons:[0]}));return m;
  }));
  const order=out.questions.find(q=>q.focus.kind==='move-order');assert.equal(order.status,'ready');assert.deepEqual(order.actorIds,['our-a','our-b']);
  assert.deepEqual(order.orderCoverage,{requestedActorIds:['our-a','our-b','foe-a','foe-b'],status:'partial'});
  assert.deepEqual(order.missingActors,['foe-a','foe-b','our-reserve-a','our-reserve-b']);assert(out.candidates.every(c=>c.status==='partial'));
  assert(out.candidates.some(c=>c.ids?.includes(order.id)));assert.equal(out.coverage.preparedQuestions,out.coverage.usableQuestions);
  assert(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors}));
});

test('reserve-only or single-active native order is irrelevant to requested active pair comparisons',async()=>{
  for(const actorIds of [['our-reserve-a','our-reserve-b'],['our-a','our-reserve-a']]){
    const f=fixture();f.report.actors.push({id:'our-reserve-a',own:true,slot:null},{id:'our-reserve-b',own:true,slot:null});
    const out=await prepareCandidateResearch(f.report,options(f,input=>{
      const m=actualShapedMenu(input,f.report.source);
      for(const [i,q]of m.focus.entries())if(q.question.kind==='move-order')m.tickets[i].questions[0].actorIds=clone(actorIds);
      else Object.assign(q,{status:'unavailable',ids:[],unavailableQuestions:1});return m;
    }));
    const order=out.questions.find(q=>q.focus.kind==='move-order');assert.equal(order.status,'ready');assert.equal(order.orderCoverage.status,'irrelevant');
    assert.match(out.catalogId,/^catalog-/);assert.equal(out.coverage.preparedQuestions,1);assert.equal(out.coverage.usableQuestions,0);
    assert(out.candidates.every(c=>!c.ids&&c.status==='unprepared'));assert.equal(out.status,'unprepared');
    assert(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors}));
  }
});

test('malformed or invented native eligible actors never become prepared semantic coverage',async()=>{
  for(const mutate of [q=>delete q.actorIds,q=>q.actorIds=[],q=>q.actorIds=['our-a','our-a'],q=>q.actorIds=['invented-actor'],q=>q.actorIds=['our-a','foe-a','our-b','foe-b','our-a','our-b','foe-a'],q=>q.missingActors=[{actorId:'our-a'}],q=>q.missingActors=[{actorId:'invented-actor'}]]){
    const f=fixture(),out=await prepareCandidateResearch(f.report,options(f,input=>{
      const m=actualShapedMenu(input,f.report.source);mutate(m.tickets.find(t=>t.name==='calculate_speed').questions[0]);return m;
    }));
    assert.equal(out.status,'unprepared');assert.equal(out.catalogId,undefined);assert(out.questions.every(q=>!q.id&&!q.actorIds&&!q.orderCoverage));
  }
});

test('malformed ready focus, duplicate tickets, unsupported tool and numerical execution are never preparation credit',async()=>{
  for(const mutate of [m=>m.focus[0].ids=['research-'+'9'.repeat(24)],m=>m.focus[0].question.move='Tackle',m=>m.tickets.push(clone(m.tickets[0])),
    m=>m.tickets[0].name='simulate_turn',m=>m.focus[0].unavailableQuestions=1,m=>m.coverage.calculationsRun=1,m=>m.status='blocked',m=>m.status='invented-ready']){
    const f=fixture();const out=await prepareCandidateResearch(f.report,options(f,input=>{const m=actualShapedMenu(input,f.report.source);mutate(m);return m;}));
    assert.equal(out.status,'unprepared');assert.equal(out.catalogId,undefined);assert(out.questions.every(q=>!q.id));
  }
});

test('late callback is aborted within the original budget, not retried or adopted',async()=>{
  const f=fixture();let calls=0,aborted=false;const start=performance.now();
  const out=await prepareCandidateResearch(f.report,options(f,async(input,{signal})=>{calls++;signal.addEventListener('abort',()=>{aborted=true;},{once:true});await new Promise(resolve=>setTimeout(resolve,145));return actualShapedMenu(input,f.report.source);},{budgetMs:110}));
  assert.equal(calls,1);assert.equal(aborted,true);assert.equal(out.reason,'preparation-late');assert.equal(out.catalogId,undefined);assert(performance.now()-start<250);
});

test('external cancellation before and during preparation refuses without outcome retry',async()=>{
  const f=fixture(),before=new AbortController();before.abort();let calls=0;
  const a=await prepareCandidateResearch(f.report,options(f,()=>{calls++;},{signal:before.signal}));assert.equal(calls,0);assert.equal(a.reason,'cancelled');
  const during=new AbortController();const b=await prepareCandidateResearch(f.report,options(f,async(input,{signal})=>{
    calls++;queueMicrotask(()=>during.abort());await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return actualShapedMenu(input,f.report.source);
  },{signal:during.signal}));assert.equal(calls,1);assert.equal(b.reason,'cancelled');assert.equal(b.catalogId,undefined);
});

test('callback mutation cannot alter caller snapshots, hypotheses or returned focus authority',async()=>{
  const f=fixture(),before=clone(f);const out=await prepareCandidateResearch(f.report,options(f,input=>{
    const m=actualShapedMenu(input,f.report.source);input.request.rqid++;input.hypotheses[0].pokemon['foe-a'].nature='Timid';input.focus[0].move='Tackle';return m;
  }));assert.deepEqual(f,before);assert.notEqual(out.questions[0].focus.move,'Tackle');
  out.candidates[0].actions[0].slot=4;assert.deepEqual(f,before);
});

test('known complete current authoritative rows are not prepared again',async()=>{
  const f=boundNumericalFixture(),before=clone(f.report);let calls=0;
  const out=await prepareCandidateResearch(f.report,options(f,()=>{calls++;}));assert.equal(calls,0);assert.equal(out.status,'not-needed');assert.deepEqual(out.questions,[]);
  assert.deepEqual(f.report,before);
});

test('a supported own-only parent order cannot suppress the requested active comparison',async()=>{
  const f=boundNumericalFixture(),check=f.report.numericChecks.checks.find(c=>c.tool==='calculate_speed'),row=f.report.order[0];
  check.input.pokemon=check.input.pokemon.filter(a=>a.label.startsWith('our-'));check.result.pokemon=check.result.pokemon.filter(a=>a.label.startsWith('our-'));
  check.result.order[0].labels=check.input.pokemon.map(a=>a.label);f.rebindInput(check);
  row.pokemon=clone(check.result.pokemon);row.groups=clone(check.result.order);row.unavailable=[];let captured;
  const out=await prepareCandidateResearch(f.report,options(f,input=>{captured=clone(input);return actualShapedMenu(input,f.report.source);}));
  assert.deepEqual(captured.focus,[{kind:'move-order',scenarioId:'observed'}]);assert.equal(out.questions[0].status,'ready');
});

test('complete status and gen0 alone never suppress unbound damage or order questions',async()=>{
  const f=fixture();f.report.objective.preserve=[];f.report.candidates=f.report.candidates.slice(0,1);f.report.coverage.sourceRevalidated=true;
  f.report.numericChecks.damage=[['our-a','foe-a','Liquidation'],['our-b','foe-b','Weather Ball']].map(([attackerId,defenderId,move],i)=>({scenarioId:'observed',attackerId,defenderId,move,route:'active',status:'complete',checkId:'d'+i}));
  f.report.numericChecks.checks=[...f.report.numericChecks.damage.map(r=>({id:r.checkId,tool:'calculate_damage',status:'complete',result:{gen:0}})),{id:'s',tool:'calculate_speed',status:'complete',result:{gen:0}}];
  f.report.order=[{scenarioId:'observed',status:'complete',unavailable:[],checkId:'s'}];let captured;
  await prepareCandidateResearch(f.report,options(f,input=>{captured=clone(input);return actualShapedMenu(input,f.report.source);}));
  assert.equal(captured.focus.length,3);assert(captured.focus.some(q=>q.kind==='move-order'));assert.equal(captured.focus.filter(q=>q.kind==='damage-range').length,2);
});

test('stale field, side, hypotheses, source and forged numerical receipts conservatively retain questions',async()=>{
  for(const mutate of [f=>f.report.field.weather='raindance',f=>f.report.numericContext.sides[0].conditions.reflect={},f=>f.report.numericContext.hypotheses.push({id:'new-hypothesis'}),
    f=>f.report.numericChecks.checks.forEach(c=>c.source.rqid++),f=>f.report.numericChecks.checks.forEach(c=>c.receipt.checkId='forged'),
    f=>f.report.numericChecks.checks.forEach(c=>c.receipt.calculationRef={id:'forged'}),f=>f.report.numericChecks.checks.forEach(c=>delete c.inputContext),
    f=>f.report.numericChecks.checks.forEach(c=>c.inputContext.inputSha256='f'.repeat(64)),f=>f.report.coverage.sourceRevalidated=false]){
    const f=boundNumericalFixture();mutate(f);let captured;
    await prepareCandidateResearch(f.report,options(f,input=>{captured=clone(input);return actualShapedMenu(input,f.report.source);}));
    assert.equal(captured.focus.length,3);assert(captured.focus.some(q=>q.kind==='move-order'));assert.equal(captured.focus.filter(q=>q.kind==='damage-range').length,2);
  }
});

test('damage suppression is candidate-specific and refuses a changed actual recipient or parent snapshot',async()=>{
  for(const mutate of [f=>f.report.candidates[0].actions[0].target=2,f=>f.report.numericChecks.checks.find(c=>c.tool==='calculate_damage').input.attackerOptions.curHP=99]){
    const f=boundNumericalFixture();mutate(f);let captured;
    await prepareCandidateResearch(f.report,options(f,input=>{captured=clone(input);return actualShapedMenu(input,f.report.source);}));
    assert(captured.focus.some(q=>q.kind==='damage-range'&&q.attackerId==='our-a'));assert(!captured.focus.some(q=>q.kind==='move-order'));
  }
});

test('future Mega or absent request move slots never fall back to actor.moves',async()=>{
  for(const change of [f=>f.report.candidates[0].actions[0].mega=true,f=>f.legalActions.active[0].moves=[]]){
    const f=fixture();f.report.candidates=f.report.candidates.slice(0,1);change(f);let calls=0;
    const out=await prepareCandidateResearch(f.report,options(f,input=>{calls++;return actualShapedMenu(input,f.report.source);}));
    assert.equal(out.status,'unprepared');assert(out.candidates[0].unknowns?.length);assert(!out.questions.some(q=>q.focus.move==='Iron Head'));
    if(f.report.candidates[0].actions[0].mega)assert.equal(calls,0);
  }
});

test('cache projector refuses stale source, changed pair, invented references, unknown fields and mutated derived IDs',async()=>{
  const f=fixture(),out=await prepareCandidateResearch(f.report,options(f,input=>actualShapedMenu(input,f.report.source)));
  const validate=v=>projectCandidateResearchReferences(v,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors});assert(validate(out));
  for(const mutate of [v=>v.source.boardHash='f'.repeat(64),v=>v.candidates[0].actions[0].target=2,v=>v.candidates[0].ids=['research-'+'0'.repeat(24)],
    v=>v.questions[0].id='invented',v=>v.candidates[0].questionRefs=['q4','q4'],v=>v.newExecutionCredit=true,
    v=>v.status='not-needed',v=>v.coverage.preparedQuestions=99,v=>v.coverage.usableQuestions=99,v=>v.questions[0].unavailableQuestions=1,
    v=>v.questions.find(q=>q.focus.kind==='move-order').orderCoverage.status='irrelevant',
    v=>v.questions.find(q=>q.focus.kind==='move-order').orderCoverage.requestedActorIds=['our-a','our-b'],
    v=>v.questions.find(q=>q.focus.kind==='move-order').actorIds=['invented-actor'],
    v=>v.questions.find(q=>q.focus.kind==='move-order').actorIds=['our-a','our-a'],
    v=>v.questions.find(q=>q.focus.kind==='move-order').missingActors=['our-a']]){
    const v=clone(out);mutate(v);assert.equal(validate(v),undefined);
  }
  const projected=validate(out);projected.candidates[0].actions[0].slot=4;assert.equal(out.candidates[0].actions[0].slot,1);
});

test('only the first three pairs are considered and source/request mismatch never reaches preparation',async()=>{
  const f=fixture();f.report.candidates.push({id:'fourth',actions:clone(f.report.candidates[0].actions)});let calls=0;
  const out=await prepareCandidateResearch(f.report,options(f,input=>{calls++;return actualShapedMenu(input,f.report.source);}));
  assert.equal(calls,1);assert.equal(out.candidates.length,3);assert.equal(out.coverage.omittedCandidates,1);assert.equal(out.coverage.candidateCount,3);
  f.request.token='9'.repeat(64);const stale=await prepareCandidateResearch(f.report,options(f,()=>{calls++;}));
  assert.equal(calls,1);assert.equal(stale.reason,'current-source-unavailable');assert.equal(stale.catalogId,undefined);
});

test('large valid IDs preserve retained exact pairs and disclose bounded omissions',async()=>{
  const f=fixture();for(const a of f.report.actors){const old=a.id;a.id=old+'x'.repeat(180);for(const row of f.report.numericChecks.damage)for(const k of ['attackerId','defenderId'])if(row[k]===old)row[k]=a.id;f.report.objective.preserve=f.report.objective.preserve.map(v=>v===old?a.id:v);}
  f.report.candidates.forEach((c,i)=>{c.id=String(i)+'x'.repeat(195);});
  const out=await prepareCandidateResearch(f.report,options(f,input=>actualShapedMenu(input,f.report.source,f.report.actors.map(a=>a.id))));
  assert(jsonBytes(out)<=CANDIDATE_RESEARCH_MAX_BYTES);assert(out.coverage.omittedQuestions>0);
  assert.notEqual(out.reason,'preparation-unverified');
  for(const row of out.candidates)assert.deepEqual(row.actions,f.report.candidates.find(c=>c.id===row.candidateId).actions);
  assert(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors}));
});

test('oversized order coverage is omitted as a whole question with no truncated actors or dangling usable IDs',async()=>{
  const f=fixture(),missing=['foe-a','foe-b'];
  for(let index=0;index<20;index++){const id=String(index)+'x'.repeat(190);missing.push(id);f.report.actors.push({id,own:true,slot:null});}
  let preparedOrderId;
  const out=await prepareCandidateResearch(f.report,options(f,input=>{
    const m=actualShapedMenu(input,f.report.source),order=m.tickets.find(t=>t.name==='calculate_speed');preparedOrderId=order.id;
    order.questions[0].actorIds=['our-a','our-b'];order.questions[0].missingActors=missing.map(actorId=>({actorId,reasons:[0]}));return m;
  }));
  assert.notEqual(out.reason,'preparation-unverified');assert(jsonBytes(out)<=CANDIDATE_RESEARCH_MAX_BYTES);assert(out.coverage.omittedQuestions>0);
  assert(!out.questions.some(q=>q.focus.kind==='move-order'));assert(out.candidates.every(c=>!c.ids?.includes(preparedOrderId)));
  assert(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors:f.report.actors}));
});

test('semantic order projection requires independent current actors and rejects changed current slots',async()=>{
  const f=fixture(),out=await prepareCandidateResearch(f.report,options(f,input=>actualShapedMenu(input,f.report.source)));
  assert.equal(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates}),undefined);
  const actors=clone(f.report.actors);actors.find(a=>a.id==='foe-b').slot=null;
  assert.equal(projectCandidateResearchReferences(out,{source:f.report.source,candidates:f.report.candidates,actors}),undefined);
});
