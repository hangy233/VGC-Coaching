import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {buildObservedPosition} from './observed-position.mjs';
import {currentFixture as observedFixture} from './observed-position.fixtures.mjs';

const {Battle,Dex}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4];
const points=value=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...value});
const mon=(id,species,nature,ability,item,moves,stats)=>({id,species,nature,ability,item,moves,statPoints:points(stats)});
function source(){return {
  p1:[
    mon('blaze','Blaziken','Adamant','Speed Boost','Blazikenite',['Rock Slide','Detect','Close Combat','Flare Blitz'],{hp:4,atk:32,spe:30}),
    mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect'],{hp:32,def:2,spa:32}),
    mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    mon('arch','Archaludon','Timid','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'],{spa:32,spd:2,spe:32}),
  ],p2:[
    mon('chomp','Garchomp','Timid','Rough Skin','Garchompite Z',['Protect','Power Gem','Draco Meteor','Flamethrower'],{hp:2,spa:32,spe:32}),
    mon('mal','Malamar','Relaxed','Contrary','Roseli Berry',['Knock Off','Topsy-Turvy','Trick Room','Skill Swap'],{hp:32,atk:32,spd:2}),
    mon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Fake Out','Grassy Glide','Wood Hammer','U-turn'],{hp:32,atk:32,spd:2}),
    mon('incin','Incineroar','Careful','Intimidate','Sitrus Berry',['Fake Out','Parting Shot','Darkest Lariat','Protect'],{hp:32,def:2,spd:32}),
  ],
};}
const teams=sets=>Object.fromEntries(Object.entries(sets).map(([side,party])=>[side,party.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}}))]));
function choose(battle,p1,p2){assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);}
function history(kind='active',wait=0){
  const sets=source(),native=teams(sets),battle=new Battle({formatid:FORMAT,seed,p1:{name:'Reference p1',team:native.p1},p2:{name:'Reference p2',team:native.p2}});
  const order=kind==='bench'?'4231':kind==='special'?'2314':'1324';
  choose(battle,`team ${order}`,'team 1234');
  const our=kind==='bench'?'move 3 1, move 4':kind==='special'?'move 4, move 4':'move 2, move 4';
  // Genuine history establishes a current Mega, exact PP, entry effects and
  // Speed Boost. No mounted fixture supplies its own expected residual result.
  choose(battle,our,'move 1 mega, move 3');
  for(let i=0;i<wait;i++)choose(battle,'move 2, move 4','move 1, move 3');
  assert.equal(battle.requestState,'move');assert.equal(battle.ended,false);
  return {battle,sets};
}
function capture(battle,sets){
  const field={};
  if(battle.field.weather)field.weather={id:battle.field.weather,remainingTurns:battle.field.weatherState.duration};
  if(battle.field.terrain)field.terrain={id:battle.field.terrain,remainingTurns:battle.field.terrainState.duration};
  if(battle.field.pseudoWeather.trickroom)field.trickRoom={remainingTurns:battle.field.pseudoWeather.trickroom.duration};
  return {mode:'current',turn:battle.turn,ownSide:'p1',field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:side.pokemon.some(p=>p.species.isMega),conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([key,value])=>[key,{remainingTurns:value.duration}])),pokemon:side.pokemon.map(p=>{
    const set=Object.values(sets).flat().find(value=>value.id===p.name);
    for(const key of Object.keys(p.volatiles))assert.ok(['stall','choicelock'].includes(key),`Unexpected current volatile ${key}`);
    return {...structuredClone(set),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}};
  })}))};
}
function projected(position){return {turn:position.turn,field:position.field,sides:position.sides.map(side=>({id:side.id,active:side.active,conditions:side.conditions,pokemon:side.pokemon.map(p=>({id:p.id,species:p.species,ability:p.ability,item:p.item,hp:p.hp,status:p.status,boosts:p.boosts,pp:p.pp,lifecycle:p.lifecycle,volatiles:p.volatiles}))}))};}
function sampled(state){
  const field={};if(state.field.weather)field.weather={id:state.field.weather,remainingTurns:state.field.weatherRemaining};if(state.field.terrain)field.terrain={id:state.field.terrain,remainingTurns:state.field.terrainRemaining};if(state.field.pseudoWeather.trickroom)field.trickRoom=state.field.pseudoWeather.trickroom;
  return {turn:state.turn,field,sides:state.sides.map(side=>({id:side.id,active:side.active,conditions:side.conditions,pokemon:side.pokemon.map(p=>({id:p.id,species:p.species,ability:p.ability,item:p.item,hp:p.hp,status:p.status,boosts:p.boosts,pp:p.pp,lifecycle:p.lifecycle,volatiles:Object.fromEntries(Object.entries(p.volatiles).filter(([key])=>!['stall','choicelock'].includes(key)))}))}))};
}
function normalized(lines,names){return extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>{
  if(/^\|t:\|\d+$/.test(line))return '|t:|<native-epoch>';
  const parts=line.replace(/(p[12][ab]?: )([^|]+)/g,(_all,prefix,name)=>prefix+(names.get(name)??name)).split('|');
  // Gender is outside the snapshot contract and irrelevant to these authored
  // moves/abilities. Preserve every switch, species, HP and ordered effect.
  if(['switch','drag'].includes(parts[1]))parts[3]=parts[3].replace(/, [MF](?=,|$)/g,'');
  return parts.join('|');
});}
function referenceSeed(position,supplied){
  const native=teams(Object.fromEntries(position.sides.map(side=>[side.id,side.pokemon])));
  const fresh=new Battle({formatid:FORMAT,seed:supplied,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});
  try{return fresh.prng.getSeed();}finally{fresh.destroy();}
}
const actionString=(side,actions)=>actions.map(action=>action.type==='switch'?`switch ${side.pokemon.findIndex(p=>p.name===action.pokemonId)+1}`:`move ${action.slot}${action.target===undefined?'':` ${action.target}`}${action.mega?' mega':''}`).join(', ');
const replyValue=reply=>reply.structuredContent??JSON.parse(reply.content.find(value=>value.type==='text').text);
const guardPair=[{type:'move',slot:2},{type:'move',slot:4}];
function branch(id,ourActions,opposingActions,required='fari'){return {id,ourActions,opposingActions,gate:{kind:'delivery',requiredActionsBy:[required]}};}
async function parity(client,ref,authored,suppliedSeed=seed){
  const position=capture(ref.battle,ref.sets);
  const args={request:{kind:'explicit',position,branches:[authored],seeds:[suppliedSeed],hypotheses:['Independent synthetic native-history parity with explicit candidate investments; no live battle or guaranteed tactical outcome.']}};
  const reply=await client.callTool({name:'simulate_turn',arguments:args});
  assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=replyValue(reply),sample=result.samples[0];
  assert.deepEqual(sampled(sample.start),projected(position),'mount retains actual current boosts, PP, locks and lifecycle without entry replay');
  ref.battle.prng.setSeed(referenceSeed(position,suppliedSeed));const before=ref.battle.log.length;
  choose(ref.battle,actionString(ref.battle.p1,authored.ourActions),actionString(ref.battle.p2,authored.opposingActions));
  const names=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id])));
  assert.deepEqual(normalized(sample.events.map(e=>e.raw),names),normalized(ref.battle.log.slice(before),new Map()),'all ordered native effects match independently played continuation');
  assert.deepEqual(sampled(sample.final),projected(capture(ref.battle,ref.sets)),'HP, item loss, status, stat changes, PP and field/lifecycle match');
  return sample;
}
const who=(sample,id,phase='final')=>sample[phase].sides.flatMap(side=>side.pokemon).find(p=>p.id===id);

test('observed CURRENT Speed Boost preserves explicit boosts/lifecycle and retains source/suppression refusals',()=>{
  const input=observedFixture(),set={species:'Blaziken',nature:'Adamant',ability:'Speed Boost',item:'Blazikenite',moves:['Rock Slide','Detect','Close Combat','Flare Blitz']};
  input.opposingSheet[4]=set;input.observed.opponentSheets.p2=structuredClone(input.opposingSheet);
  Object.assign(input.observed.boards[0].sides[1].pokemon[0],{species:set.species,ability:set.ability,abilitySuppressed:false});
  Object.assign(input.hypotheses.opposing.foe0,{ability:set.ability,item:set.item});
  const built=buildObservedPosition(input),mon=built.position.sides[1].pokemon.find(p=>p.id==='foe0');
  assert.equal(mon.ability,'Speed Boost');assert.deepEqual(mon.lifecycle,input.hypotheses.opposing.foe0.lifecycle);assert.deepEqual(mon.boosts,input.observed.boards[0].sides[1].pokemon[0].boosts);
  for(const change of [x=>{x.expected.token='b'.repeat(64);},x=>{x.observed.boards[0].sides[1].pokemon[0].abilitySuppressed=true;},x=>{delete x.hypotheses.opposing.foe0.lifecycle;}]){
    const bad=structuredClone(input);change(bad);assert.throws(()=>buildObservedPosition(bad));
  }
});

test('actual registered MCP CURRENT Speed Boost and narrow move scope match independent native histories',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-current-speedboost-'));
  const client=new Client({name:'current-speedboost-native-parity',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();const target=resolve(workspace),parent=resolve(tmpdir())+sep;assert.ok(target.startsWith(parent));await rm(target,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../tests/fixtures/simulation-mcp-server.mjs',import.meta.url)),workspace]}));
  const run=async(kind,authored,inspect,wait=0)=>{const ref=history(kind,wait);try{const sample=await parity(client,ref,authored);inspect(sample);return sample;}finally{ref.battle.destroy();}};
  await t.test('Detect uses carried stall and existing Speed boosts; residual runs once',async()=>{
    const sample=await run('active',branch('detect-current',guardPair,[{type:'move',slot:1},{type:'move',slot:3}]),s=>{
      assert.equal(who(s,'blaze','start').boosts.spe,1);assert.equal(who(s,'blaze').boosts.spe,2);
      assert.ok(s.events.some(e=>e.move==='Detect'));assert.ok(s.events.some(e=>e.type==='-boost'&&e.actorId==='blaze'&&e.raw.includes('|spe|')));
    });
    assert.equal(sample.gate.cleanSample,false,'conservative deterministic-boost classification is not relaxed');
    await run('active',branch('carried-boost',guardPair,[{type:'move',slot:1},{type:'move',slot:3}]),s=>{assert.equal(who(s,'blaze','start').boosts.spe,2);assert.equal(who(s,'blaze').boosts.spe,3);},1);
  });
  await t.test('inactive reserve, switch entry and switch-out match native Speed Boost eligibility',async()=>{
    const ref=history('bench');try{
      const idle=await parity(client,ref,branch('inactive',[{type:'move',slot:3,target:1},{type:'move',slot:4}],[{type:'move',slot:1},{type:'move',slot:3}],'toed'));
      assert.equal(who(idle,'blaze').boosts.spe,0);
      const entered=await parity(client,ref,branch('reserve-entry',[{type:'switch',pokemonId:'blaze'},{type:'move',slot:4}],[{type:'move',slot:1},{type:'move',slot:3}],'toed'));
      assert.equal(who(entered,'blaze').boosts.spe,0,'native activeTurns prevents a same-turn switch-in residual boost');
      const next=await parity(client,ref,branch('after-entry',guardPair,[{type:'move',slot:1},{type:'move',slot:3}],'toed'));
      assert.equal(who(next,'blaze').boosts.spe,1);
    }finally{ref.battle.destroy();}
    await run('active',branch('switch-out',[{type:'switch',pokemonId:'arch'},{type:'move',slot:4}],[{type:'move',slot:1},{type:'move',slot:3}]),s=>{
      assert.equal(who(s,'blaze').active,false);assert.equal(who(s,'blaze').boosts.spe,0);assert.equal(s.events.some(e=>e.type==='-boost'&&e.actorId==='blaze'),false);
    });
  });
  await t.test('Knock Off removes the current Choice item and lock without preserving former restrictions',async()=>{
    const ref=history('bench');try{
      const knocked=await parity(client,ref,branch('knock-scarf',[{type:'move',slot:3,target:1},{type:'move',slot:4}],[{type:'move',slot:1},{type:'move',slot:1,target:1}],'toed'));
      assert.equal(who(knocked,'arch','start').item,'choicescarf');assert.equal(who(knocked,'arch').item,'');
      assert.ok(knocked.events.some(e=>e.type==='-enditem'&&e.actorId==='arch'&&e.raw.includes('Knock Off')));
      const unlocked=await parity(client,ref,branch('unlocked-move',[{type:'move',slot:1,target:1},{type:'move',slot:4}],[{type:'move',slot:1},{type:'move',slot:3}],'toed'));
      assert.ok(unlocked.events.some(e=>e.actorId==='arch'&&e.move==='Dragon Pulse'));
    }finally{ref.battle.destroy();}
  });
  await t.test('Draco Meteor and Power Gem use current boosts and preserve actual self-drop effects',async()=>{
    const ref=history('special');try{
      const draco=await parity(client,ref,branch('draco-current',[{type:'move',slot:4},{type:'move',slot:2,target:-1}],[{type:'move',slot:3,target:2},{type:'move',slot:3}],'toed'));
      assert.ok(draco.events.some(e=>e.move==='Draco Meteor'));assert.equal(who(draco,'chomp').boosts.spa,-2);
      const gem=await parity(client,ref,branch('gem-after-drop',[{type:'move',slot:4},{type:'move',slot:2,target:-1}],[{type:'move',slot:2,target:2},{type:'move',slot:3}],'toed'));
      assert.equal(who(gem,'chomp','start').boosts.spa,-2);assert.ok(gem.events.some(e=>e.move==='Power Gem'));assert.equal(who(gem,'chomp').boosts.spa,-2);
    }finally{ref.battle.destroy();}
  });
  await t.test('Psychic and Ice Beam execute native current-turn effects and flags',async()=>{
    await run('special',branch('special-effects',[{type:'move',slot:3,target:1},{type:'move',slot:1,target:1}],[{type:'move',slot:2,target:1},{type:'move',slot:3}],'toed'),s=>{
      assert.ok(s.events.some(e=>e.move==='Ice Beam'));assert.ok(s.events.some(e=>e.move==='Psychic'));
    });
  });
  await t.test('Rock Slide preserves spread recipients, native accuracy/denial and residual history',async()=>{
    await run('active',branch('rock-slide',[{type:'move',slot:1},{type:'move',slot:2,target:-1}],[{type:'move',slot:2,target:2},{type:'move',slot:1,target:2}]),s=>{
      const move=s.events.find(e=>e.move==='Rock Slide');assert.ok(move);assert.ok(move.raw.includes('[spread]'));
    });
  });
});
