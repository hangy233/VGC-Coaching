import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {buildTurnFacts} from './board.mjs';
import {planningFixture} from './fixtures.mjs';
import {boardDigest} from './identity.mjs';
import {createResearchCatalog,resolveResearchTickets} from './research-tickets.mjs';
import {createRequire} from 'node:module';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');

test('actual SDK prepared-check resolution exposes the registered read-only endpoint without running numerical handlers',async()=>{
  const client=new Client({name:'offline-readonly-research-resolution-test',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:fileURLToPath(new URL('../',import.meta.url))}));
    const decode=reply=>{assert(!reply.isError,reply.content?.map(item=>item.text??'').join('\n'));return reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);};
    const tools=await client.listTools(),registered=tools.tools.find(tool=>tool.name==='battle_resolve_checks');assert(registered);assert.equal(registered.annotations.readOnlyHint,true);
    const data=planningFixture();data.ownTeam[2].item='Miracle Seed';data.ownTeam[3].item='Grassy Seed';data.opponentSheet[2].item='Grassy Seed';
    const request={kind:'explicit',label:'Offline read-only resolution; no numerical execution or live state equivalence',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet};
    const zero={hp:0,atk:0,def:0,spa:0,spd:0,spe:0},menu=decode(await client.callTool({name:'battle_prepare_checks',arguments:{request,hypotheses:[{id:'named',label:'Explicit opposing assumptions remain hypothetical',pokemon:{'p2-chomp':{nature:'Jolly',statPoints:{...zero,hp:2,atk:32,spe:32}},'p2-wash':{nature:'Modest',statPoints:{...zero,hp:32,spa:32,spd:2}}}}],focus:[{kind:'move-order',scenarioId:'named'}]}}));
    assert.equal(menu.coverage.calculationsRun,0);assert.equal(menu.selectedIds.length,1);
    const selection={catalogId:menu.catalogId,ids:menu.selectedIds,actions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}]};
    const resolved=decode(await client.callTool({name:'battle_resolve_checks',arguments:selection}));
    assert.equal(resolved.status,'resolved');assert.equal(resolved.coverage.calculationsRun,0);assert.equal(resolved.coverage.completed,0);assert.deepEqual(resolved.ids,selection.ids);assert.match(resolved.inputBinding.sha256,/^[a-f0-9]{64}$/u);assert.equal(resolved.inputBinding.source.kind,'explicit-hypothetical-snapshot');
    const unknown=decode(await client.callTool({name:'battle_resolve_checks',arguments:{...selection,ids:['research-'+'0'.repeat(24)]}}));assert.equal(unknown.status,'refused');assert.equal(unknown.coverage.calculationsRun,0);assert.equal(unknown.inputBinding,undefined);
  }finally{await client.close();}
});

test('prepared native inputs execute unchanged through actual registered MCP damage and Speed handlers',async()=>{
  const client=new Client({name:'offline-prepared-research-native-test',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:fileURLToPath(new URL('../',import.meta.url))});
  try{
    await client.connect(transport);
    const fixture=planningFixture(),ctx=buildTurnFacts(fixture),zero={hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
    const source={kind:'explicit-hypothetical-snapshot',label:'Offline actual SDK input validation; no live battle',boardHash:boardDigest(fixture.board,fixture.legalActions)};
    const hypotheses=[{id:'named-foe-spreads',label:'Named opposing point assumptions, not revealed facts',pokemon:{
      'p2-chomp':{nature:'Jolly',statPoints:{...zero,hp:2,atk:32,spe:32}},
      'p2-wash':{nature:'Modest',statPoints:{...zero,hp:32,spa:32,spd:2}},
    }}];
    const current={ctx,source,hypotheses,runtimeVersion:'actual-registered-handlers-this-test'},catalog=await createResearchCatalog(current);
    const selected=[catalog.tickets.find(ticket=>ticket.name==='calculate_speed'&&ticket.questions.some(question=>question.scenarioId==='named-foe-spreads')),
      catalog.tickets.find(ticket=>ticket.name==='calculate_damage'&&ticket.questions.some(question=>question.attackerId==='p1-cat')),
      catalog.tickets.find(ticket=>ticket.name==='calculate_damage'&&ticket.questions.some(question=>question.attackerId==='p2-chomp'))];
    assert(selected.every(Boolean),'both damage directions and full named Speed scenario are available');
    const calls=resolveResearchTickets(catalog,{ids:selected.map(ticket=>ticket.id),current});
    const replies=await Promise.all(calls.map(async call=>{
      assert.equal(call.args.gen,0);const reply=await client.callTool({name:call.name,arguments:call.args});
      assert(!reply.isError,reply.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n'));
      const result=reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text'&&item.text.startsWith('{')).text);
      assert.equal(result.gen,0);return result;
    }));
    assert(Array.isArray(replies[0].pokemon)&&Array.isArray(replies[0].order));
    assert(replies.slice(1).every(result=>Array.isArray(result.range)&&result.range.length===2));
    assert.equal(catalog.coverage.calculationsRun,0,'preparation and actual tool execution remain distinct');
  }finally{await client.close();}
});

test('public prepared-check tools execute focused real native IDs and retain only exact compact outputs',async()=>{
  const client=new Client({name:'offline-public-prepared-research-test',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:fileURLToPath(new URL('../',import.meta.url))}));
    const decode=reply=>{assert(!reply.isError,reply.content?.map(item=>item.text??'').join('\n'));return reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);};
    const data=planningFixture();data.ownTeam[2].item='Miracle Seed';data.ownTeam[3].item='Grassy Seed';
    const hp=decode(await client.callTool({name:'calculate_speed',arguments:{gen:0,pokemon:data.ownTeam.slice(0,3).map((set,index)=>({label:data.board.sides[0].pokemon[index].id,species:set.species,nature:set.nature,ability:set.ability,item:set.item,statPoints:set.evs}))}}));
    for(const actor of hp.pokemon){const index=data.board.sides[0].pokemon.findIndex(value=>value.id===actor.label);data.board.sides[0].pokemon[index].hp={current:actor.rawStats.hp,max:actor.rawStats.hp,precision:'server-own-exact'};data.legalActions.pokemon[index].condition=`${actor.rawStats.hp}/${actor.rawStats.hp}`;}
    const zero={hp:0,atk:0,def:0,spa:0,spd:0,spe:0},request={kind:'explicit',label:'Offline native preparation only',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet};
    const menu=decode(await client.callTool({name:'battle_prepare_checks',arguments:{request,hypotheses:[{id:'named',label:'Named opposing spreads, not facts',pokemon:{
      'p2-chomp':{nature:'Jolly',statPoints:{...zero,hp:2,atk:32,spe:32}},'p2-wash':{nature:'Modest',statPoints:{...zero,hp:32,spa:32,spd:2}},
    }}],focus:[{kind:'move-order',scenarioId:'named'},{kind:'damage-range',scenarioId:'named',attackerId:'p1-cat',defenderId:'p2-chomp',move:'Flare Blitz',route:'active'}]}}));
    assert.equal(menu.selectedIds.length,2);assert.equal(menu.coverage.calculationsRun,0);assert(Buffer.byteLength(JSON.stringify(menu))<=4096);
    const result=decode(await client.callTool({name:'battle_run_checks',arguments:{catalogId:menu.catalogId,ids:menu.selectedIds,budgetMs:5000}}));
    assert.equal(result.status,'complete');assert.equal(result.coverage.completed,2);assert(result.entries.every(value=>value.result.gen===0));
    assert.equal(result.entries[0].result.projection.kind,'native-speed-order');assert.equal(result.entries[1].result.projection.kind,'native-damage-range');
    assert.equal(result.entries[1].result.calculationRef,undefined,'explicit hypothetical calculations do not write retained evidence');
  }finally{await client.close();}
});

test('prepared Weather Ball uses actual native rain from an object ID and differs from the explicit clear countercase',async()=>{
  const client=new Client({name:'offline-native-weather-descriptor-test',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:fileURLToPath(new URL('../',import.meta.url))}));
    const data=planningFixture();Object.assign(data.ownTeam[0],{species:'Politoed',nature:'Modest',ability:'Drizzle',item:'Leftovers',moves:['Weather Ball','Muddy Water','Icy Wind','Protect'],evs:{hp:32,def:2,spa:32}});
    Object.assign(data.board.sides[0].pokemon[0],{species:'Politoed',nickname:'Politoed'});data.legalActions.active[0].moves=[{move:'Weather Ball',id:'weatherball',target:'normal',pp:10,maxpp:10,disabled:false}];
    const points={hp:0,atk:0,def:0,spa:0,spd:0,spe:0},hypotheses=[{id:'named',label:'Explicit opposing spread only',pokemon:{'p2-chomp':{nature:'Jolly',statPoints:{...points,hp:2,atk:32,spe:32}}}}];
    const results=[];
    for(const weather of [{id:'raindance',remainingTurns:4},null]){
      data.board.field.weather=weather;
      const current={ctx:buildTurnFacts(data),source:{kind:'explicit-hypothetical-snapshot',label:weather?'Native rain object case':'Native clear countercase',boardHash:boardDigest(data.board,data.legalActions)},hypotheses,runtimeVersion:'actual-native-weather-fixture'};
      const catalog=await createResearchCatalog({...current,focus:[{kind:'damage-range',scenarioId:'named',attackerId:'p1-cat',defenderId:'p2-chomp',move:'Weather Ball',route:'active'}]});
      assert.equal(catalog.selectedIds.length,1);const [call]=resolveResearchTickets(catalog,{ids:catalog.selectedIds,current});
      assert.equal(call.args.field.weather,weather?'Rain':undefined);
      const reply=await client.callTool({name:call.name,arguments:call.args});assert(!reply.isError,reply.content?.map(value=>value.text??'').join('\n'));
      assert.equal(reply.structuredContent.gen,0);results.push(reply.structuredContent);
    }
    assert.notDeepEqual(results[0].range,results[1].range,'actual registered native engine resolves a different Weather Ball range in rain');
  }finally{await client.close();}
});
