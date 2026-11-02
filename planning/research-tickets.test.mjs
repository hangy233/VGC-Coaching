import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchCatalog,resolveResearchTickets,projectResearchCatalog} from './research-tickets.mjs';
import {analyzeNumerics} from './numerics.mjs';
import {digest,requestDigest} from './identity.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';
import {simulationToolSchema} from '../simulation/mcp-tools.mjs';
import {planningFixture} from './fixtures.mjs';
import {buildTurnFacts} from './board.mjs';
import {boardDigest} from './identity.mjs';

const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
const teamId='a'.repeat(64),token='b'.repeat(64),sheet='c'.repeat(64);
function fixture(){
  const ctx={ownSide:'p1',foeSide:'p2',turn:2,field:{weather:null,terrain:null,conditions:{}},
    sides:[{id:'p1',conditions:{}},{id:'p2',conditions:{}}],legalActions:{active:[{moves:[{move:'Flamethrower',target:'normal',pp:10}]},{moves:[{move:'Protect',target:'self',pp:10}]}]},objective:null,resources:{},warnings:[],
    actors:[
      {id:'our-a',side:'p1',own:true,slot:1,selected:true,species:'Charizard',nature:'Modest',statPoints:{...points,spa:32},ability:'Blaze',item:'Charcoal',itemKnown:true,
        hp:{current:100,max:200,precision:'server-own-exact'},status:null,boosts:{},moves:['Flamethrower','Protect'],pp:null,lifecycle:null,volatiles:{},capabilities:[],raw:{fainted:false}},
      {id:'foe-a',side:'p2',own:false,slot:1,selected:true,species:'Mew',nature:null,statPoints:null,ability:'Synchronize',item:null,itemKnown:false,
        hp:{current:80,max:100,precision:'server-display'},status:null,boosts:{},moves:['Psychic','Protect'],pp:null,lifecycle:null,volatiles:{},capabilities:[],raw:{fainted:false}},
    ]};
  const original={kind:'observed',sessionId:'fixture-session',teamId,room:'battle-gen9championsvgc2026regmc-123456',rqid:9,token};
  const source={kind:'bound-observed-turn',sessionId:original.sessionId,teamId,room:original.room,rqid:original.rqid,boardHash:digest(ctx),opposingSheetSha256:sheet,observedAt:100,liveFreshness:'read-and-revalidated-only'};
  source.requestDigest=requestDigest({...original,boardHash:source.boardHash});
  const hypotheses=[{id:'fast-mew',label:'Explicit fast Mew, not observed',pokemon:{'foe-a':{nature:'Timid',statPoints:{...points,hp:2,spa:32,spe:32},item:''}}}];
  return {ctx,source,hypotheses,runtimeVersion:'fixture-runtime-v1',original};
}
const current=f=>({ctx:f.ctx,source:f.source,hypotheses:f.hypotheses,runtimeVersion:f.runtimeVersion});
const key=entry=>digest({name:entry.name??entry.tool,args:entry.args??entry.input});

test('catalog reuses the maintained exact native builders and never computes or dispatches a result',async()=>{
  const f=fixture(),catalog=await createResearchCatalog(f),native=await analyzeNumerics(f.ctx,{hypotheses:f.hypotheses,maxCalls:0,budgetMs:0});
  assert.equal(catalog.coverage.calculationsRun,0);assert.equal(catalog.tickets.length,4);
  assert.deepEqual(catalog.tickets.map(key).sort(),[...new Set(native.checks.map(key))].sort());
  const calls=resolveResearchTickets(catalog,{ids:catalog.tickets.map(ticket=>ticket.id),current:current(f)});
  assert.deepEqual(calls.map(key).sort(),catalog.tickets.map(key).sort());
  assert(calls.every(call=>call.args.gen===0));assert(calls.every(call=>!Object.hasOwn(call,'result')));
  assert(catalog.tickets.some(ticket=>ticket.questions.some(question=>question.kind==='damage-range'&&question.attackerId==='foe-a')));
  assert(Object.isFrozen(catalog));assert(Object.isFrozen(catalog.tickets[0].args));
  calls[0].args.gen=9;assert.equal(catalog.tickets[0].args.gen,0,'resolved inputs are detached');
});

test('IDs are deterministic, unknown assumptions stay unavailable, and no own set is assigned to opponents',async()=>{
  const f=fixture(),first=await createResearchCatalog(f),second=await createResearchCatalog(structuredClone(f));
  assert.equal(first.catalogId,second.catalogId);assert.deepEqual(first.tickets.map(ticket=>ticket.id),second.tickets.map(ticket=>ticket.id));
  const unknown=await createResearchCatalog({...f,hypotheses:[]}),menu=projectResearchCatalog(unknown);
  assert.equal(unknown.tickets.length,1);assert.equal(unknown.tickets[0].name,'calculate_speed');
  assert.deepEqual(unknown.tickets[0].args.pokemon.map(actor=>actor.label),['our-a']);
  assert(menu.tickets[0].questions[0].missingActors.some(actor=>actor.actorId==='foe-a'&&actor.reasons.some(index=>menu.notes[index]==='nature unknown')));
  assert(menu.unavailable.some(row=>row.kind==='damage-range'&&row.reasons.some(index=>menu.notes[index]==='stat-point allocation unknown')));
  assert(!JSON.stringify(menu).includes('attackerOptions'),'public menu does not resend full native inputs');
  assert.equal(f.ctx.actors[1].nature,null);assert.equal(f.ctx.actors[1].statPoints,null);
  const partial=await createResearchCatalog({...f,hypotheses:[{...f.hypotheses[0],pokemon:{'foe-a':{nature:'Timid',item:'',statPoints:{spe:32}}}}]});
  assert(partial.unavailable.some(row=>row.reasons.some(reason=>/all six stat points/.test(reason))));
  assert(partial.tickets.every(ticket=>ticket.name==='calculate_speed'));
});

test('routing separates named independent inputs from paired-turn proof and retains partial order coverage',async()=>{
  const f=fixture(),simulation=authoredObserved(f),catalog=await createResearchCatalog({...f,simulationRequests:[simulation]}),menu=projectResearchCatalog(catalog,{maxBytes:8192});
  const routing=menu.checkRouting;assert.equal(routing.inputOnly,true);
  assert.deepEqual(routing.independentOfTurnReconstruction,['damage-range','move-order']);
  assert.equal(routing.questions['damage-range'].displayed,2);assert.equal(routing.questions['move-order'].displayed,2);
  assert.equal(routing.questions['paired-simulation'].displayed,1);assert.match(routing.scope,/Neither proves paired delivery\/removal/);
  assert(menu.scenarios.some(row=>row.id==='fast-mew'&&row.label===f.hypotheses[0].label));
  const unknown=projectResearchCatalog(await createResearchCatalog({...f,hypotheses:[]}),{maxBytes:8192});
  const order=unknown.tickets.find(row=>row.name==='calculate_speed').questions[0];
  assert.deepEqual(order.actorIds,['our-a']);assert(order.missingActors.some(row=>row.actorId==='foe-a'));
  assert.equal(unknown.checkRouting.questions['damage-range'].displayed,0);
  assert(unknown.checkRouting.questions['damage-range'].unavailable>0);
  const bounded=projectResearchCatalog(catalog,{maxTickets:1,maxUnavailable:0,maxBytes:8192});
  assert.equal(bounded.checkRouting.questions['move-order'].displayed,1);assert.equal(bounded.checkRouting.questions['move-order'].hidden,1);
  assert.equal(bounded.checkRouting.questions['damage-range'].displayed,0);assert.equal(bounded.checkRouting.questions['damage-range'].hidden,2);
});

test('changed HP, form, field, legality, source, assumptions or runtime cannot rebind an old ID',async()=>{
  const f=fixture(),catalog=await createResearchCatalog(f),ids=[catalog.tickets[0].id];
  const mutations=[
    value=>value.ctx.actors[0].hp.current--,
    value=>value.ctx.actors[0].species='Charizard-Mega-Y',
    value=>value.ctx.field.weather='raindance',
    value=>value.ctx.legalActions.active[0].moves[0].pp=0,
    value=>value.ctx.actors[0].boosts={spa:1},
    value=>value.ctx.actors[0].volatiles={protect:{}},
    value=>value.source.teamId='d'.repeat(64),
    value=>value.source.room='battle-gen9championsvgc2026regmc-123457',
    value=>value.source.rqid++,
    value=>value.source.requestDigest='d'.repeat(64),
    value=>value.source.opposingSheetSha256='d'.repeat(64),
    value=>value.runtimeVersion='fixture-runtime-v2',
    value=>value.hypotheses[0].pokemon['foe-a'].statPoints.spe=31,
  ];
  for(const mutate of mutations){const changed=structuredClone(current(f));mutate(changed);assert.throws(()=>resolveResearchTickets(catalog,{ids,current:changed}),/stale|different source/);}
  const clock=structuredClone(current(f));clock.source.observedAt=101;clock.source.liveFreshness='fresh-read-and-revalidated';
  assert.equal(resolveResearchTickets(catalog,{ids,current:clock}).length,1,'reader timestamp changes do not invalidate unchanged mechanics');
});

test('bounded IDs refuse unknown, duplicates, mutation and incomplete observed source instead of filling defaults',async()=>{
  const f=fixture(),catalog=await createResearchCatalog(f),ids=[catalog.tickets[0].id];
  for(const selected of [[],[...ids,...ids],['research-unknown'],Array(5).fill('x')])assert.throws(()=>resolveResearchTickets(catalog,{ids:selected,current:current(f)}));
  const changed=structuredClone(catalog);changed.tickets[0].args.gen=9;
  assert.throws(()=>resolveResearchTickets(changed,{ids,current:current(f)}),/modified/);
  await assert.rejects(createResearchCatalog({...f,runtimeVersion:null}),/runtime\/build/);
  for(const field of ['teamId','sessionId','rqid','requestDigest','opposingSheetSha256']){
    const source=structuredClone(f.source);delete source[field];await assert.rejects(createResearchCatalog({...f,source}),/required/);
  }
  const bounded=await createResearchCatalog({...f,maxTickets:1});assert.equal(bounded.tickets.length,1);assert.equal(bounded.coverage.omittedTickets,3);
  const menu=projectResearchCatalog(catalog,{maxTickets:1,maxUnavailable:0});assert.equal(menu.coverage.hiddenAvailableTickets,3);
  assert.equal(menu.coverage.calculationsRun,0);assert.equal(menu.coverage.hiddenUnavailableQuestions,catalog.unavailable.length);
});

function authoredObserved(f){
  const {kind,...source}=f.original;
  return {id:'double-threat',label:'Authored branch only; opponent intent unknown',args:{evidenceContext:{teamId,roomId:source.room,turn:f.ctx.turn},request:{kind:'observed',source:{...source,opposingSheetSha256:sheet},
    hypotheses:{mode:'opening',label:'Explicit opposing states',opposing:{},reserves:[]},
    branches:[{id:'protect-branch',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:2,target:1}],
      opposingActions:[{type:'move',slot:4},{type:'move',slot:4}],gate:{targetId:'foe-a',beforeActionsOf:['foe-a']}}],seeds:[[1,2,3,4]]}}};
}
test('simulation tickets keep the exact authored paired request and gates without inferring opponent actions',async()=>{
  const f=fixture(),simulation=authoredObserved(f),catalog=await createResearchCatalog({...f,simulationRequests:[simulation]});
  const ticket=catalog.tickets.find(ticket=>ticket.name==='simulate_turn');assert(ticket);
  const [call]=resolveResearchTickets(catalog,{ids:[ticket.id],current:current(f)});
  assert.deepEqual(call.args,simulationToolSchema.parse(simulation.args));
  assert.deepEqual(call.args.request.branches[0].opposingActions,simulation.args.request.branches[0].opposingActions);
  const wrong=structuredClone(simulation);wrong.args.request.source.token='e'.repeat(64);
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[wrong]}),/token\/binding changed/);
  const unpaired=structuredClone(simulation);unpaired.args.request.branches[0].opposingActions.pop();
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[unpaired]}));
  const omitted=structuredClone(simulation);delete omitted.args.request.branches[0].opposingActions;
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[omitted]}));
  const noEvidence=structuredClone(simulation);delete noEvidence.args.evidenceContext;
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[noEvidence]}),/matching canonical team-owned evidence/);
  const wrongEvidence=structuredClone(simulation);wrongEvidence.args.evidenceContext.teamId='e'.repeat(64);
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[wrongEvidence]}),/matching canonical team-owned evidence/);
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[simulation,simulation]}),/IDs must be unique/);
});

test('catalog identity includes authored checks, labels and preparation caps instead of aliasing one board',async()=>{
  const f=fixture(),simulation=authoredObserved(f),first=await createResearchCatalog({...f,simulationRequests:[simulation]});
  const changed=structuredClone(simulation);changed.args.request.branches[0].opposingActions[0].slot=3;
  const other=await createResearchCatalog({...f,simulationRequests:[changed]});
  assert.notEqual(first.catalogId,other.catalogId);assert.deepEqual(first.binding,other.binding);
  assert.equal(first.tickets[0].id,other.tickets[0].id,'an unchanged exact numerical check retains its ID');
  const renamed=structuredClone(simulation);renamed.label='A different authored conditional question';
  assert.notEqual(first.catalogId,(await createResearchCatalog({...f,simulationRequests:[renamed]})).catalogId);
  const capped=await createResearchCatalog({...f,maxTickets:1,simulationRequests:[simulation]}),cappedOther=await createResearchCatalog({...f,maxTickets:1,simulationRequests:[changed]});
  assert.deepEqual(capped.tickets,cappedOther.tickets);assert.notEqual(capped.catalogId,cappedOther.catalogId,'omitted prepared checks remain part of catalog identity');
  assert.notEqual(capped.catalogId,(await createResearchCatalog({...f,maxTickets:2,simulationRequests:[simulation]})).catalogId);
  assert.equal(first.catalogId,(await createResearchCatalog({...f,simulationRequests:[simulation]})).catalogId);
});

test('explicit native scenarios stay hypothetical and cannot claim an actual observed board',async()=>{
  const f=fixture(),native=openingFixture(),simulation={id:'hypothetical',label:'Explicit native hypothetical position',args:{request:{kind:'explicit',...native}}};
  await assert.rejects(createResearchCatalog({...f,simulationRequests:[simulation]}),/cannot claim an observed/);
  const source={kind:'explicit-hypothetical-snapshot',label:'Offline hypothetical only',boardHash:f.source.boardHash,liveFreshness:false},ctx=structuredClone(f.ctx);ctx.turn=native.position.turn;
  const catalog=await createResearchCatalog({...f,ctx,source,simulationRequests:[simulation]});
  const ticket=catalog.tickets.find(ticket=>ticket.name==='simulate_turn');assert.match(ticket.questions[0].scope,/hypothetical/);
  const changed=structuredClone(simulation);changed.args.request.position.turn++;
  await assert.rejects(createResearchCatalog({...f,ctx,source,simulationRequests:[changed]}),/turn\/own side changed/);
});

test('larger menus stay within byte bounds and count every hidden available and unavailable question',async()=>{
  const f=planningFixture(),ctx=buildTurnFacts(f),source={kind:'explicit-hypothetical-snapshot',label:'Bounded offline fixture',boardHash:boardDigest(f.board,f.legalActions)};
  const catalog=await createResearchCatalog({ctx,source,runtimeVersion:'fixture-native-build'});
  assert(catalog.unavailable.length>8);
  for(const maxBytes of [1024,2048,4096]){
    const menu=projectResearchCatalog(catalog,{maxBytes});assert(Buffer.byteLength(JSON.stringify(menu))<=maxBytes);
    assert.equal(menu.coverage.displayedTickets+menu.coverage.hiddenAvailableTickets,catalog.tickets.length);
    assert.equal((menu.unavailable?.length??0)+menu.coverage.hiddenUnavailableQuestions,catalog.unavailable.length);
    if(menu.status==='full-menu-required')assert.equal(menu.tickets,undefined);
  }
});
