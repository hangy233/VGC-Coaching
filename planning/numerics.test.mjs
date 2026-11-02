import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyzeNumerics} from './numerics.mjs';

const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
function context() {
  return {ownSide:'p1',foeSide:'p2',turn:2,field:{weather:null,terrain:null,conditions:{}},
    sides:[{id:'p1',conditions:{}},{id:'p2',conditions:{}}],legalActions:[],objective:null,resources:{},warnings:[],
    actors:[
      {id:'our-a',side:'p1',own:true,slot:1,selected:true,species:'Charizard',nature:'Modest',statPoints:{...points,spa:32},ability:'Blaze',item:'Charcoal',itemKnown:true,
        hp:{current:100,max:200,precision:'server-own-exact'},status:null,boosts:{},moves:['Flamethrower','Protect'],pp:null,lifecycle:null,volatiles:{},capabilities:[],raw:{fainted:false}},
      {id:'foe-a',side:'p2',own:false,slot:1,selected:true,species:'Mew',nature:null,statPoints:null,ability:'Synchronize',item:null,itemKnown:false,
        hp:{current:80,max:100,precision:'server-display'},status:null,boosts:{},moves:['Psychic','Protect'],pp:null,lifecycle:null,volatiles:{},capabilities:[],raw:{fainted:false}},
    ]};
}
const hypothesis={id:'fast-mew',label:'Explicit fast Mew',pokemon:{'foe-a':{nature:'Timid',statPoints:{...points,spa:32,spe:32,hp:2},item:''}}};
function toolStub() {
  const calls=[];
  const callTool=async(name,args,options)=>{
    calls.push({name,args,options});
    if(name==='calculate_speed') return {content:[{type:'text',text:JSON.stringify({gen:0,pokemon:args.pokemon.map(p=>({label:p.label,effectiveSpeed:100,rawSpeed:100})),
      order:[{rank:1,labels:args.pokemon.map(p=>p.label),effectiveSpeed:100,tie:args.pokemon.length>1}],limitations:['Same-priority Speed only'],calculationRef:{id:`speed-${calls.length}`}})}]};
    return {structuredContent:{gen:0,range:[110,130],damage:[110,130],attackerHP:{current:args.attackerOptions.curHP ?? 200,max:200,unit:'actual-hp'},
      defenderHP:{current:args.defenderOptions.curHP ?? 200,max:200,unit:'actual-hp'},percent:null,description:'Actual injected calculator result',calculationRef:{id:`damage-${calls.length}`}}};
  };
  callTool.runtimeVersion='fixture-runtime-v1';
  return {callTool,calls};
}

test('unknown opposing nature/points/item remain unknown and never inherit the own set',async()=>{
  const {callTool,calls}=toolStub();
  const result=await analyzeNumerics(context(),{callTool});
  assert.equal(result.damage.filter(row=>row.status==='complete').length,0);
  assert.ok(result.order[0].unavailable[0].reasons.some(reason=>/allocation unknown/.test(reason)));
  assert.ok(calls.every(call=>call.name!=='calculate_damage'));
  assert.equal(calls[0].args.pokemon.length,1);
  assert.equal(calls[0].args.gen,0);
});

test('named complete opposing scenario obtains actual MCP ranges and actual own HP threat flags',async()=>{
  const {callTool,calls}=toolStub();
  const result=await analyzeNumerics(context(),{callTool,hypotheses:[hypothesis]});
  const rows=result.damage.filter(row=>row.status==='complete');
  assert.equal(rows.length,2);
  assert.ok(rows.every(row=>row.scenarioId==='fast-mew' && row.range[0]===110 && row.percent===null));
  assert.ok(rows.every(row=>row.assumptions.some(value=>/neither revealed facts nor universal bounds/.test(value))));
  assert.equal(result.threats.length,1);
  assert.equal(result.threats[0].targetId,'our-a');
  assert.equal(result.threats[0].hp,100);
  assert.equal(result.threats[0].speedRelation,'tie');
  assert.equal(result.threats[0].delivery,'unverified');
  assert.ok(calls.every(call=>call.args.gen===0 && call.options.timeoutMs>0 && call.options.signal instanceof AbortSignal));
  assert.ok(rows[0].warnings.some(value=>/actual HP unknown/.test(value)));
});

test('partial opposing allocations and observed item/ability/form conflicts are rejected explicitly',async()=>{
  const ctx=context(),{callTool,calls}=toolStub();ctx.actors[1].itemKnown=true;ctx.actors[1].item='Sitrus Berry';
  const result=await analyzeNumerics(ctx,{callTool,hypotheses:[
    {...hypothesis,id:'conflict',pokemon:{'foe-a':{...hypothesis.pokemon['foe-a'],item:'Choice Scarf',ability:'Pressure'}}},
    {...hypothesis,id:'form',pokemon:{'foe-a':{species:'Mewtwo'}}},
    {...hypothesis,id:'partial',pokemon:{'foe-a':{nature:'Timid',statPoints:{spe:32}}}},
  ]});
  assert.ok(result.warnings.some(warning=>/conflicts with observed held item/.test(warning)));
  assert.ok(result.warnings.some(warning=>/form override/.test(warning)));
  assert.ok(result.order.find(row=>row.scenarioId==='partial').unavailable.some(row=>row.reasons.some(reason=>/all six/.test(reason))));
  assert.ok(calls.every(call=>call.name!=='calculate_damage'));
});

test('cache keys include exact inputs and runtime version, retain actual receipts, and stay bounded',async()=>{
  const ctx=context(),{callTool,calls}=toolStub(),cache=new Map();
  const first=await analyzeNumerics(ctx,{callTool,cache,hypotheses:[hypothesis]});
  const callCount=calls.length;
  const second=await analyzeNumerics(ctx,{callTool,cache,hypotheses:[hypothesis]});
  assert.equal(calls.length,callCount);assert.equal(second.coverage.cachedCalls,first.coverage.completedCalls);
  assert.ok(second.checks.filter(check=>check.status==='complete').every(check=>check.receipt.reused===true));
  const firstDamage=first.damage.find(row=>row.status==='complete'),secondDamage=second.damage.find(row=>row.status==='complete');
  assert.deepEqual(secondDamage.receipt.calculationRef,firstDamage.receipt.calculationRef);
  ctx.actors[0].boosts={spa:1};
  await analyzeNumerics(ctx,{callTool,cache,hypotheses:[hypothesis]});assert.ok(calls.length>callCount);
  const changedCount=calls.length;callTool.runtimeVersion='fixture-runtime-v2';
  await analyzeNumerics(ctx,{callTool,cache,hypotheses:[hypothesis]});assert.ok(calls.length>changedCount);
  for(let i=0;i<260;i++)cache.set(`junk-${i}`,{});
  await analyzeNumerics(ctx,{callTool,cache,hypotheses:[{...hypothesis,id:'new'}]});
  // Bounded when an actual result is inserted, even if a caller supplied excess entries.
  assert.ok(cache.size<=256);
});

test('unknown runtime disallows cross-analysis reuse and absent tools never fabricate calculations',async()=>{
  const {callTool,calls}=toolStub();delete callTool.runtimeVersion;const cache=new Map();
  await analyzeNumerics(context(),{callTool,cache});const count=calls.length;
  const result=await analyzeNumerics(context(),{callTool,cache});assert.ok(calls.length>count);
  assert.ok(result.warnings.some(warning=>/runtime\/build version is unknown/.test(warning)));
  const absent=await analyzeNumerics(context());assert.equal(absent.coverage.completedCalls,0);assert.equal(absent.threats.length,0);
});

test('deadline prevents new tool calls and late completions do not become evidence or cached results',async()=>{
  let calls=0,observedOptions;
  const callTool=async(name,args,options)=>{calls++;observedOptions=options;await new Promise(resolve=>setTimeout(resolve,30));return {structuredContent:{gen:0,pokemon:[],order:[]}};};
  callTool.runtimeVersion='slow-runtime';const cache=new Map();
  const result=await analyzeNumerics(context(),{callTool,cache,budgetMs:5,hypotheses:[hypothesis]});
  assert.equal(calls,4);assert.equal(result.checks[0].status,'timed-out');assert.equal(result.checks[0].mayCompleteLate,true);
  assert.equal(result.coverage.completedCalls,0);assert.equal(result.coverage.budgetExhausted,true);
  assert.equal(observedOptions.signal.aborted,true);
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(cache.size,0);assert.equal(result.checks[0].status,'timed-out');
  const zero=await analyzeNumerics(context(),{callTool,budgetMs:0,hypotheses:[hypothesis]});assert.equal(calls,4);assert.equal(zero.coverage.attemptedCalls,0);
});

test('maxCalls bounds actual calls without labeling missing matrix rows complete',async()=>{
  const {callTool,calls}=toolStub();const result=await analyzeNumerics(context(),{callTool,maxCalls:1,hypotheses:[hypothesis]});
  assert.equal(calls.length,1);assert.equal(result.coverage.callLimitReached,true);assert.equal(result.coverage.completedDamage,0);
  assert.ok(result.damage.every(row=>row.range===null));
});

test('a synchronous handler finishing beyond budget is late even before the timer can run',async()=>{
  let calls=0;
  const callTool=()=>{calls++;const until=performance.now()+12;while(performance.now()<until){}return {structuredContent:{gen:0,pokemon:[],order:[],calculationRef:{id:'late-real-receipt'}}};};
  callTool.runtimeVersion='synchronous-runtime';const cache=new Map();
  const result=await analyzeNumerics(context(),{callTool,cache,budgetMs:4,hypotheses:[hypothesis],concurrency:1});
  assert.equal(calls,1);assert.equal(result.checks[0].status,'late');assert.equal(result.checks[0].mayCompleteLate,false);
  assert.equal(result.checks[0].receipt.calculationRef.id,'late-real-receipt');assert.equal(cache.size,0);
  assert.equal(result.coverage.completedCalls,0);assert.equal(result.order[0].status,'unavailable');
});

test('HP-dependent moves, activation uncertainty, unsupported volatiles and exact HP mismatches stay unverified',async()=>{
  const {callTool}=toolStub(),ctx=context();ctx.actors[1].moves=['Eruption'];
  const unknownHP=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.ok(unknownHP.damage.find(row=>row.attackerId==='foe-a').warnings.some(warning=>/HP-dependent attacker/.test(warning)));
  ctx.actors[0].ability='Unburden';
  const activation=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.ok(activation.order[0].unavailable.some(row=>row.reasons.includes('unburdenActive unknown')));
  ctx.actors[0].ability='Blaze';ctx.actors[0].volatiles={substitute:{name:'Substitute'}};
  const volatile=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.ok(volatile.damage.every(row=>row.status==='unavailable'));
  ctx.actors[0].volatiles={};ctx.actors[0].hp.max=201;
  const mismatch=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.ok(mismatch.damage.some(row=>row.warnings.some(warning=>/does not match/.test(warning))));
});

test('priority brackets and original-condition observations never infer Speed from forced/different-priority actions',async()=>{
  const ctx=context(),{callTool}=toolStub();ctx.observedOrderConstraints=[{samePriority:false,forcedOrder:false,bothExecuted:true,identityVerified:true,first:'foe-a',second:'our-a'}];
  const result=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.deepEqual(result.order[1].priorityBrackets.map(group=>group.priority),[4,0]);
  assert.equal(result.order[1].observedConstraints[0].reusableForSpeed,false);
  assert.equal(result.order[1].observedConstraints[0].numericalInference,'unverified');
});

test('screen, Helping Hand and known partner modifiers pass to the same actual damage tool',async()=>{
  const ctx=context(),{callTool,calls}=toolStub();ctx.sides[1].conditions={lightscreen:{name:'Light Screen'}};
  ctx.actors[0].volatiles={helpinghand:{name:'Helping Hand'}};
  ctx.actors.push({...structuredClone(ctx.actors[0]),id:'our-b',slot:2,species:'Clefairy',ability:'Friend Guard',moves:['Protect'],volatiles:{}});
  await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  const outward=calls.find(call=>call.name==='calculate_damage' && call.args.attacker==='Charizard');
  const inward=calls.find(call=>call.name==='calculate_damage' && call.args.attacker==='Mew' && call.args.defender==='Charizard');
  assert.equal(outward.args.field.defenderSide.isLightScreen,true);assert.equal(outward.args.field.attackerSide.isHelpingHand,true);
  assert.equal(inward.args.field.defenderSide.isFriendGuard,true);
});

test('known reserves are conditional routes and do not become immediate threat/delivery claims',async()=>{
  const ctx=context(),{callTool}=toolStub();ctx.actors.push({...structuredClone(ctx.actors[0]),id:'our-reserve',slot:null,species:'Arcanine',ability:'Intimidate'});
  const result=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  const route=result.damage.find(row=>row.attackerId==='our-reserve' && row.status==='complete');
  assert.equal(route.route,'conditional-reserve-entry');assert.ok(route.assumptions.some(value=>/entry survival/.test(value)));
  assert.ok(result.threats.every(threat=>threat.sourceId!=='our-reserve'));
});

test('variable hit count, entry boost reapplication, Metronome history and activation-speed power never become completed ranges',async()=>{
  const cases=[
    {move:'Rock Blast',ability:'Blaze',reason:/Variable hit count/},
    {move:'Flamethrower',ability:'Download',reason:/reapply an entry\/activation boost/},
    {move:'Flamethrower',ability:'Wind Rider',tailwind:true,reason:/reapply an entry\/activation boost/},
    {move:'Electro Ball',ability:'Unburden',lifecycle:{unburdenActive:true},reason:/Speed-dependent damage/},
    {move:'Flamethrower',ability:'Blaze',item:'Metronome',reason:/consecutive-use damage history/},
  ];
  for(const scenario of cases) {
    const ctx=context(),{callTool,calls}=toolStub();Object.assign(ctx.actors[0],{moves:[scenario.move],ability:scenario.ability,lifecycle:scenario.lifecycle || null,item:scenario.item || 'Charcoal'});
    if(scenario.tailwind)ctx.sides[0].conditions.tailwind={name:'Tailwind'};
    const result=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
    const row=result.damage.find(row=>row.scenarioId===hypothesis.id&&row.attackerId==='our-a');
    assert.equal(row.status,'unavailable',scenario.move);assert.ok(row.warnings.some(warning=>scenario.reason.test(warning)),row.warnings.join(';'));
    assert.ok(calls.every(call=>call.name!=='calculate_damage'||call.args.attacker!=='Charizard'));
  }
});

test('missing field/side state and malformed hypothetical HP do not silently become neutral/full snapshots',async()=>{
  const {callTool}=toolStub(),ctx=context();delete ctx.field.weather;delete ctx.sides[0].conditions;
  const missing=await analyzeNumerics(ctx,{callTool,hypotheses:[hypothesis]});
  assert.equal(missing.coverage.completedCalls,0);
  const malformed=await analyzeNumerics(context(),{callTool,hypotheses:[{...hypothesis,pokemon:{'foe-a':{...hypothesis.pokemon['foe-a'],hp:{current:0}}}}]});
  assert.ok(malformed.order.find(row=>row.scenarioId===hypothesis.id).unavailable.some(row=>row.reasons.some(reason=>/positive actual HP/.test(reason))));
});

test('canonical weather and terrain object IDs reach native Weather Ball inputs while unknown descriptors refuse checks',async()=>{
  const ctx=context();Object.assign(ctx.actors[0],{species:'Politoed',ability:'Drizzle',moves:['Weather Ball']});
  ctx.field.weather={id:'raindance',remainingTurns:4};ctx.field.terrain={id:'grassyterrain',remainingTurns:3};
  const rainy=toolStub();await analyzeNumerics(ctx,{callTool:rainy.callTool,hypotheses:[hypothesis]});
  const weatherBall=rainy.calls.find(call=>call.name==='calculate_damage'&&call.args.move==='Weather Ball');assert(weatherBall);
  assert.equal(weatherBall.args.field.weather,'Rain');assert.equal(weatherBall.args.field.terrain,'Grassy');
  assert(rainy.calls.filter(call=>call.name==='calculate_speed').every(call=>call.args.field.weather==='Rain'&&call.args.field.terrain==='Grassy'));
  const clear=toolStub();ctx.field.weather=null;ctx.field.terrain=null;await analyzeNumerics(ctx,{callTool:clear.callTool,hypotheses:[hypothesis]});
  const neutral=clear.calls.find(call=>call.name==='calculate_damage'&&call.args.move==='Weather Ball');assert.equal(neutral.args.field.weather,undefined);assert.equal(neutral.args.field.terrain,undefined);
  for(const field of ['weather','terrain']){
    const invalid=structuredClone(ctx),native=toolStub();invalid.field[field]={id:'unknown-native-condition',name:field==='weather'?'Rain':'Grassy'};
    const result=await analyzeNumerics(invalid,{callTool:native.callTool,hypotheses:[hypothesis]});assert.equal(native.calls.length,0);
    assert(result.order.every(row=>row.warnings.some(warning=>warning.includes(`Unsupported ${field}`))));
  }
});

test('independent Speed and both damage directions overlap with stable check IDs and a bounded call budget',async()=>{
  const {callTool:base}=toolStub(),calls=[],releases=[];let simultaneous=0,peak=0;
  const callTool=async(name,args,options)=>{calls.push({name,args});simultaneous++;peak=Math.max(peak,simultaneous);
    await new Promise(resolve=>releases.push(resolve));simultaneous--;return base(name,args,options);};
  callTool.runtimeVersion='parallel-fixture';
  const pending=analyzeNumerics(context(),{callTool,hypotheses:[hypothesis],maxCalls:4,budgetMs:2000});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,4);assert.equal(peak,4);
  assert.deepEqual(calls.map(row=>row.name),['calculate_speed','calculate_speed','calculate_damage','calculate_damage']);
  assert.deepEqual(calls.slice(2).map(row=>row.args.attacker),['Charizard','Mew']);
  for(const release of releases.reverse())release();
  const result=await pending;assert.equal(result.coverage.attemptedCalls,4);assert.equal(result.coverage.maxConcurrentCalls,4);
  assert.deepEqual(result.checks.map(check=>check.id),['numeric-1','numeric-2','numeric-3','numeric-4']);
  assert.deepEqual(result.damage.filter(row=>row.status==='complete').map(row=>row.checkId),['numeric-3','numeric-4']);
  assert.equal(result.threats[0].speedRelation,'tie','Threat adoption waits for the slower Speed result');
});

test('identical in-flight jobs share one real call and receipt, while changed complete inputs require a separate call',async()=>{
  const {callTool:base}=toolStub();let calls=0;
  const callTool=async(...args)=>{calls++;await new Promise(resolve=>setImmediate(resolve));return base(...args);};callTool.runtimeVersion='dedupe-fixture';
  const same=await analyzeNumerics(context(),{callTool,hypotheses:[{id:'same',label:'Same observed inputs',pokemon:{}}],maxCalls:1});
  assert.equal(calls,1);assert.equal(same.coverage.deduplicatedCalls,1);assert.equal(same.checks[1].reused,true);
  assert.deepEqual(same.checks[0].receipt.calculationRef,same.checks[1].receipt.calculationRef);assert.notEqual(same.checks[0].receipt.checkId,same.checks[1].receipt.checkId);
  calls=0;
  const changed=await analyzeNumerics(context(),{callTool,hypotheses:[{id:'rain',label:'Conditional rain',pokemon:{},field:{weather:'Rain'}}],maxCalls:2});
  assert.equal(calls,2);assert.equal(changed.coverage.deduplicatedCalls,0);
});

test('a synchronous overrun does not dispatch queued work after the shared deadline',async()=>{
  let calls=0;const callTool=()=>{calls++;const until=performance.now()+12;while(performance.now()<until){}return {structuredContent:{gen:0,pokemon:[],order:[]}};};
  callTool.runtimeVersion='dispatch-deadline';
  const result=await analyzeNumerics(context(),{callTool,hypotheses:[hypothesis],budgetMs:5});
  assert.equal(calls,1);assert.equal(result.coverage.attemptedCalls,1);assert.equal(result.coverage.completedCalls,0);assert(result.checks.every(check=>check.status!=='complete'));
});
