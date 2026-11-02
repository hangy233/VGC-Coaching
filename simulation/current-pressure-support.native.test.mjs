import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn,runTurnSimulation} from './turn-simulator.mjs';

// Explicit opt-in: default test discovery does not run this native parity audit.
// A genuine native history is the reference; it never calls mountCurrent.
const enabled=process.env.VGC_RUN_CURRENT_PRESSURE_NATIVE==='1';
const nativeTest=(name,fn)=>test(name,{skip:!enabled},fn);
const require=createRequire(import.meta.url);
const {Battle,Dex}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const dex=Dex.forFormat('gen9championsvgc2026regmc');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4];
const points=values=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...values});
const mon=(id,species,nature,ability,item,moves,values)=>({id,species,nature,ability,item,moves,statPoints:points(values)});
function sets(){return {
  p1:[
    mon('gol','Golisopod','Brave','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect'],{hp:32,atk:32,spd:2}),
    mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic Noise','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Icy Wind','Protect'],{hp:32,def:2,spa:32}),
    mon('sylv','Sylveon','Quiet','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect'],{hp:32,def:2,spa:32}),
  ],
  p2:[
    mon('stoise','Blastoise','Modest','Rain Dish','Blastoisinite',['Terrain Pulse','Water Spout','Aura Sphere','Protect'],{hp:32,spa:32,spd:2}),
    mon('grim','Grimmsnarl','Adamant','Prankster','Fairy Feather',['Misty Terrain','Reflect','Light Screen','Spirit Break'],{hp:32,atk:32,spd:2}),
    mon('peli','Pelipper','Calm','Drizzle','Sitrus Berry',['Protect','Hurricane','Tailwind','Wide Guard'],{hp:32,def:2,spd:32}),
    mon('rilla','Rillaboom','Adamant','Grassy Surge','Expert Belt',['High Horsepower','Grassy Glide','Fake Out','U-turn'],{hp:32,atk:32,spd:2}),
  ],
};}
const nativeTeams=source=>Object.fromEntries(Object.entries(source).map(([side,team])=>[side,team.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}}))]));
function choose(battle,p1,p2){
  assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);
  assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);
}
function history({rain=true,wait=0,noise=false,chip=true}={}){
  const source=sets();
  if(!rain)source.p2[2]=mon('peli','Sylveon','Quiet','Pixilate','Sitrus Berry',['Hyper Voice','Quick Attack','Mystical Fire','Protect'],{hp:32,spa:32,spd:2});
  const battle=new Battle({formatid:FORMAT,seed,p1:{name:'Reference p1',team:nativeTeams(source).p1},p2:{name:'Reference p2',team:nativeTeams(source).p2}});
  choose(battle,'team 1234','team 1324');
  // Turn 1 creates rain by a real entry, Mega history, damage and actual PP.
  // The setter's real switch introduces Grimmsnarl without synthetic entry state.
  choose(battle,`${chip?'move 2 1 mega':'move 4 mega'}, move 4`,'move 3 2, switch 3');
  for(let i=0;i<wait;i++)choose(battle,'move 4, move 2 -1','move 4, move 2');
  if(noise)choose(battle,'move 4, move 1 1','move 3 1, move 2');
  assert.equal(battle.requestState,'move');assert.equal(battle.ended,false);
  return {battle,source};
}
function capture(battle,source){
  const pokemon=p=>{
    const set=Object.values(source).flat().find(s=>s.id===p.name);
    const volatiles={};
    for(const [key,value]of Object.entries(p.volatiles)){
      if(key==='stall'||key==='choicelock')continue;
      assert.equal(key,'healblock',`Unexpected reference volatile ${key}`);
      volatiles.healblock={remainingTurns:value.duration,sourceId:value.source.name};
    }
    return {...structuredClone(set),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),
      lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles};
  };
  const field={};
  if(battle.field.weather)field.weather={id:battle.field.weather,remainingTurns:battle.field.weatherState.duration};
  if(battle.field.terrain)field.terrain={id:battle.field.terrain,remainingTurns:battle.field.terrainState.duration};
  if(battle.field.pseudoWeather.trickroom)field.trickRoom={remainingTurns:battle.field.pseudoWeather.trickroom.duration};
  return {mode:'current',turn:battle.turn,ownSide:'p1',field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),pokemon:side.pokemon.map(pokemon),megaUsed:side.pokemon.some(p=>p.species.isMega),conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([key,value])=>[key,{remainingTurns:value.duration}]))}))};
}
function visibleState(position){
  return {turn:position.turn,field:position.field,sides:position.sides.map(side=>({id:side.id,active:side.active,pokemon:side.pokemon.map(p=>({id:p.id,species:p.species,ability:p.ability,item:p.item,hp:p.hp,status:p.status,boosts:p.boosts,pp:p.pp,lifecycle:p.lifecycle,volatiles:Object.fromEntries(Object.entries(p.volatiles).map(([key,value])=>[key,{remainingTurns:value.remainingTurns}]))})),conditions:side.conditions}))};
}
function sampleState(sample){
  const field={};
  if(sample.field.weather)field.weather={id:sample.field.weather,remainingTurns:sample.field.weatherRemaining};
  if(sample.field.terrain)field.terrain={id:sample.field.terrain,remainingTurns:sample.field.terrainRemaining};
  if(sample.field.pseudoWeather.trickroom)field.trickRoom=sample.field.pseudoWeather.trickroom;
  return {turn:sample.turn,field,sides:sample.sides.map(side=>({id:side.id,active:side.active,pokemon:side.pokemon.map(p=>({id:p.id,species:p.species,ability:p.ability,item:p.item,hp:p.hp,status:p.status,boosts:p.boosts,pp:p.pp,lifecycle:p.lifecycle,volatiles:Object.fromEntries(Object.entries(p.volatiles).filter(([key])=>!['stall','choicelock'].includes(key)))})),conditions:side.conditions}))};
}
function normalizedEvents(lines,names){
  return extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>/^\|t:\|\d+$/.test(line)?'|t:|<native-epoch>':line.replace(/(p[12][ab]?: )([^|]+)/g,(all,prefix,name)=>prefix+(names.get(name)??name)));
}
// Separate processes can resolve identical native turns in different wall-clock
// seconds. Preserve event presence/index and all mechanics; ignore only that epoch.
const clockEvent=event=>event.type==='t:'&&/^\|t:\|\d+$/.test(event.raw)?{...event,raw:'|t:|<native-epoch>'}:event;
const withoutNativeEpoch=samples=>samples.map(sample=>({...sample,events:sample.events.map(clockEvent),openingEvents:sample.openingEvents.map(clockEvent)}));
function referenceSeed(position){
  // Match constructor-only gender draws, without mounting or resolving a turn.
  const teams=nativeTeams(Object.fromEntries(position.sides.map(s=>[s.id,s.pokemon])));
  const fresh=new Battle({formatid:FORMAT,seed,p1:{name:'Seed p1',team:teams.p1},p2:{name:'Seed p2',team:teams.p2}});
  try{return fresh.prng.getSeed();}finally{fresh.destroy();}
}
function parity(options={},branchOverride){
  const ref=history(options);
  try{
    const position=capture(ref.battle,ref.source);
    const branch=branchOverride??{id:'paired-pressure',ourActions:[{type:'move',slot:4},{type:'move',slot:3}],opposingActions:[{type:'move',slot:2},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['fari'],survive:['gol']}};
    const input={position,branches:[branch],seeds:[seed],hypotheses:['Independent synthetic native-history parity; explicit investments, not an observed replay or guaranteed outcome.']};
    const result=simulateNativeTurn(input),sample=result.samples[0];
    assert.deepEqual(sampleState(sample.start),visibleState(position),'mounted boundary must equal independently played history');
    ref.battle.prng.setSeed(referenceSeed(position));
    const before=ref.battle.log.length;
    const actionString=(side,actions)=>actions.map(action=>action.type==='switch'?`switch ${side.pokemon.findIndex(p=>p.name===action.pokemonId)+1}`:`move ${action.slot}${action.target!==undefined?` ${action.target}`:''}${action.mega?' mega':''}`).join(', ');
    choose(ref.battle,actionString(ref.battle.p1,branch.ourActions),actionString(ref.battle.p2,branch.opposingActions));
    const names=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id])));
    assert.deepEqual(normalizedEvents(sample.events.map(e=>e.raw),names),normalizedEvents(ref.battle.log.slice(before),new Map()),'ordered native effects must match history continuation');
    assert.deepEqual(sampleState(sample.final),visibleState(capture(ref.battle,ref.source)),'native HP, PP, boosts, lifecycle and durations must match');
    return {input,result,sample};
  }finally{ref.battle.destroy();}
}

nativeTest('CURRENT Water Spout + Spirit Break equals independent native history through delivery and residuals',()=>{
  const {sample}=parity();
  assert.ok(sample.events.some(e=>e.move==='Water Spout'));
  assert.ok(sample.events.some(e=>e.move==='Spirit Break'));
  assert.ok(sample.events.some(e=>e.type==='-unboost'&&e.raw.includes('|spa|')));
  assert.equal(sample.gate.cleanSample,false,'conservative secondary classification is intentionally unchanged');
  assert.ok(sample.events.some(e=>e.type==='-heal'&&e.raw.includes('Rain Dish')));
});

nativeTest('Rain Dish residual parity includes no-rain, expiry, full HP, switching and Heal Block',()=>{
  const normal=parity().sample;assert.ok(normal.events.some(e=>e.type==='-heal'&&e.raw.includes('Rain Dish')));
  const full=parity({chip:false}).sample;assert.equal(full.events.some(e=>e.raw.includes('Rain Dish')),false);
  const dry=parity({rain:false}).sample;assert.equal(dry.events.some(e=>e.raw.includes('Rain Dish')),false);
  const expiring=parity({wait:3}).sample;assert.ok(expiring.events.some(e=>e.raw==='|-weather|none'));assert.equal(expiring.events.some(e=>e.raw.includes('Rain Dish')),false);
  const blocked=parity({noise:true}).sample;assert.equal(blocked.events.some(e=>e.raw.includes('Rain Dish')),false);
  const switching=parity({}, {id:'switch-out',ourActions:[{type:'move',slot:4},{type:'move',slot:4}],opposingActions:[{type:'switch',pokemonId:'rilla'},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['gol']}}).sample;
  assert.equal(switching.events.some(e=>e.type==='-heal'&&e.actorId==='stoise'),false);
});

nativeTest('Water Spout and Spirit Break preserve native Protect, PP and action-order countercases',()=>{
  const protectedPair={id:'protect-both',ourActions:[{type:'move',slot:4},{type:'move',slot:4}],opposingActions:[{type:'move',slot:2},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['gol','fari']}};
  const {sample}=parity({},protectedPair);
  assert.ok(sample.events.some(e=>e.type==='-activate'&&e.raw.includes('Protect')));
  assert.equal(sample.events.some(e=>e.type==='-unboost'),false);
  for(const id of ['stoise','grim']){
    const start=sample.start.sides[1].pokemon.find(p=>p.id===id),end=sample.final.sides[1].pokemon.find(p=>p.id===id);
    assert.notDeepEqual(end.pp,start.pp,'native attempted actions consume actual PP');
  }
  for(const [slot,beforeSpout]of [[1,true],[2,false]]){
    const attack={id:`spout-order-${slot}`,ourActions:[{type:'move',slot,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:2},{type:'move',slot:4,target:2}],gate:{kind:'delivery',requiredActionsBy:['gol']}};
    const ordered=parity({chip:false},attack).sample;
    const own=ordered.events.findIndex(e=>e.type==='move'&&e.actorId==='gol'),spout=ordered.events.findIndex(e=>e.move==='Water Spout');
    assert.ok(own>=0&&spout>=0);assert.equal(own<spout,beforeSpout,'native current-HP power must see chip only when it arrives first');
  }
});

nativeTest('bounded worker preserves the same narrow CURRENT native result',async()=>{
  // Normalization countercases are part of this worker comparison, not a global
  // JSON rewrite: preserve wrong event types, other raws and arbitrary strings.
  const clock={index:7,position:3,type:'t:',actorId:null,raw:'|t:|123'},wrongType={...clock,type:'move'},nonclock={...clock,raw:'|t:|123suffix'};
  const countercase=[{events:[clock,wrongType,nonclock],openingEvents:[wrongType],note:'|t:|123',nested:{raw:'|t:|123'}}];
  assert.deepEqual(withoutNativeEpoch(countercase),[{...countercase[0],events:[{...clock,raw:'|t:|<native-epoch>'},wrongType,nonclock]}]);
  assert.deepEqual(countercase[0].events,[clock,wrongType,nonclock],'comparison does not mutate retained native evidence');
  const {input,result}=parity();const worker=await runTurnSimulation(input,{timeoutMs:3500});
  assert.deepEqual(withoutNativeEpoch(worker.samples),withoutNativeEpoch(result.samples));
});

nativeTest('native Prankster flag and Dark immunity are fresh per move; damaging Spirit Break stays ordinary',()=>{
  const ability=dex.abilities.get('prankster'),status=dex.getActiveMove('confide'),attack=dex.getActiveMove('spiritbreak');
  assert.equal(ability.onModifyPriority.call({},0,null,null,status),1);assert.equal(status.pranksterBoosted,true);
  assert.equal(ability.onModifyPriority.call({},0,null,null,attack),undefined);assert.equal(attack.pranksterBoosted,undefined);
  assert.equal(dex.getActiveMove('confide').pranksterBoosted,undefined,'native Dex creates a fresh marker');
  // Independent engine-only countercase, not an expansion of CURRENT selected moves.
  for(const species of ['Farigiraf','Grimmsnarl']){
    const partners=()=>[
      {species:'Politoed',ability:'Water Absorb',moves:['Protect']},
      {species:'Sylveon',ability:'Pixilate',moves:['Protect']},
      {species:'Rillaboom',ability:'Grassy Surge',moves:['Protect']},
    ];
    const battle=new Battle({formatid:FORMAT,seed,
      p1:{name:'Status source',team:[{species:'Grimmsnarl',ability:'Prankster',moves:['Confide']},...partners()]},
      p2:{name:'Status target',team:[{species,ability:species==='Farigiraf'?'Cud Chew':'Prankster',moves:[species==='Farigiraf'?'Trick Room':'Reflect']},...partners()]},
    });
    try{
      choose(battle,'team 1234','team 1234');choose(battle,'move 1 1, move 1','move 1, move 1');
      assert.equal(battle.log.some(line=>line.startsWith('|-immune|')),species==='Grimmsnarl');
      assert.equal(battle.log.some(line=>line.startsWith('|-unboost|')&&line.includes('|spa|')),species==='Farigiraf');
    }finally{battle.destroy();}
  }
});
