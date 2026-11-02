import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn,runTurnSimulation} from './turn-simulator.mjs';

// The reference plays actual native histories and never calls mountCurrent.
// These are synthetic engine fixtures, not investment or live-outcome evidence.
const require=createRequire(import.meta.url);
const {Battle}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4];
const points=value=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...value});
const mon=(id,species,nature,ability,item,moves,stats)=>({id,species,nature,ability,item,moves,statPoints:points(stats)});
function source(){return {
  p1:[
    mon('gol','Golisopod','Brave','Emergency Exit','Golisopite',['Substitute','Iron Head','Leech Life','Protect'],{hp:30,atk:32,spd:4}),
    mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect'],{hp:32,def:2,spa:32}),
    mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    mon('sylv','Sylveon','Quiet','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect'],{hp:32,def:2,spa:32}),
  ],p2:[
    mon('rai','Raichu','Timid','Lightning Rod','Raichunite Y',['Zap Cannon','Focus Blast','Quick Attack','Protect'],{hp:2,spa:32,spe:32}),
    mon('foe-fari','Farigiraf','Timid','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Trick Room','Protect'],{hp:2,spa:32,spe:32}),
    mon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect'],{hp:32,atk:32,def:2}),
    mon('volc','Volcarona','Modest','Flame Body','Expert Belt',['Heat Wave','Quiver Dance','Giga Drain','Protect'],{hp:32,spa:32,spd:2}),
  ],
};}
const teams=sets=>Object.fromEntries(Object.entries(sets).map(([side,party])=>[side,party.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}}))]));
function choose(battle,p1,p2){
  assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);
  assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);
}
function fresh({bench=false,noReserves=false}={}){
  const sets=source();if(noReserves)sets.p1[1].moves[0]='Perish Song';
  const native=teams(sets),battle=new Battle({formatid:FORMAT,seed,p1:{name:'Reference p1',team:native.p1},p2:{name:'Reference p2',team:native.p2}});
  choose(battle,noReserves?'team 2413':bench?'team 2314':'team 1234','team 1234');
  return {battle,sets};
}
function history({bench=false,substitutes=0,noReserves=false}={}){
  const ref=fresh({bench,noReserves}),{battle}=ref;
  if(noReserves){
    // A genuine Perish Song history removes both original actives; the future
    // Emergency Exit holder and its partner are never manually fainted.
    choose(battle,'move 1, move 4','move 4, move 4');
    choose(battle,'move 4, move 4','switch 3, switch 4');
    choose(battle,'move 4, move 4','switch 3, switch 4');
    for(let i=0;i<4&&battle.requestState==='move';i++)choose(battle,'move 4, move 4','move 4, move 4');
    assert.equal(battle.requestState,'switch');
    assert.equal(battle.choose('p1','switch 3, switch 4'),true,battle.p1.choice.error);
    assert.equal(battle.p1.pokemon.filter(p=>p.hp>0).length,2);
  }else if(substitutes){
    // Real Substitute costs establish exact-half/below-half HP. Each decoy is
    // broken by a native hit before capture; no arbitrary HP hydration occurs.
    choose(battle,'move 1, move 4','move 4, move 4');
    for(let i=1;i<substitutes;i++)choose(battle,'move 1, move 4',`move 1 1${i===1?' mega':''}, move 4`);
    choose(battle,'move 2 2, move 4',`move 1 1${substitutes===1?' mega':''}, move 4`);
    const gol=battle.p1.pokemon.find(p=>p.name==='gol');
    assert.equal(gol.volatiles.substitute,undefined);
    assert.equal(battle.log.some(line=>line.includes('ability: Emergency Exit')),false);
  }else choose(battle,'move 4, move 4','move 4, move 4');
  assert.equal(battle.requestState,'move');assert.equal(battle.ended,false);
  return ref;
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
  // Gender is outside the snapshot contract and these effects; keep the actual
  // switch, form, HP and ordered effect, changing only that presentation field.
  if(['switch','drag'].includes(parts[1]))parts[3]=parts[3].replace(/, [MF](?=,|$)/g,'');
  return parts.join('|');
});}
function referenceSeed(position,supplied){
  const native=teams(Object.fromEntries(position.sides.map(side=>[side.id,side.pokemon])));
  const fresh=new Battle({formatid:FORMAT,seed:supplied,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});
  try{return fresh.prng.getSeed();}finally{fresh.destroy();}
}
const actionString=(side,actions)=>actions.map(action=>action.type==='switch'?`switch ${side.pokemon.findIndex(p=>p.name===action.pokemonId)+1}`:`move ${action.slot}${action.target===undefined?'':` ${action.target}`}${action.mega?' mega':''}`).join(', ');
const move=(slot,target,mega)=>({type:'move',slot,...(target===undefined?{}:{target}),...(mega?{mega:true}:{})});
const attacking=(mega=true)=>[move(2,1,mega),move(1,1)];
const ownAttack=[move(2,2),move(3,1)];
const branch=(id,ourActions,opposingActions,required=['gol','toed'])=>({id,ourActions,opposingActions,gate:{kind:'delivery',requiredActionsBy:required}});
const who=(sample,id,phase='final')=>sample[phase].sides.flatMap(side=>side.pokemon).find(p=>p.id===id);
const exits=sample=>sample.events.filter(e=>e.type==='-activate'&&e.raw.includes('ability: Emergency Exit'));
function parity(ref,authored,suppliedSeed=seed){
  const position=capture(ref.battle,ref.sets),input={position,branches:[authored],seeds:[suppliedSeed],hypotheses:['Independent synthetic CURRENT native-history parity; not live investment, acceptance or guaranteed tactical evidence.']};
  const result=simulateNativeTurn(input),sample=result.samples[0];
  assert.deepEqual(sampled(sample.start),projected(position),'mount preserves the independently played current state without entry replay');
  ref.battle.prng.setSeed(referenceSeed(position,suppliedSeed));const before=ref.battle.log.length;
  choose(ref.battle,actionString(ref.battle.p1,authored.ourActions),actionString(ref.battle.p2,authored.opposingActions));
  const names=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id])));
  assert.deepEqual(normalized(sample.events.map(e=>e.raw),names),normalized(ref.battle.log.slice(before),new Map()),'ordered native effects match the independently played continuation');
  assert.deepEqual(sampled(sample.final),projected(capture(ref.battle,ref.sets)),'HP, PP, items, forms and lifecycle match the native continuation');
  return {sample,input,result};
}

test('CURRENT Emergency Exit crosses half HP and stops before pending partner actions without a replacement',()=>{
  const ref=history();try{
    const {sample}=parity(ref,branch('cross-half',ownAttack,attacking()));
    assert.equal(exits(sample).length,1);assert.equal(sample.boundary,'forced-replacement');
    assert.ok(who(sample,'gol','start').hp>who(sample,'gol','start').maxhp/2);
    assert.ok(who(sample,'gol').hp>0&&who(sample,'gol').hp<=who(sample,'gol').maxhp/2);
    assert.equal(sample.noPendingContinuation,false);assert.deepEqual(sample.pendingActions.map(a=>a.pokemonId).sort(),['gol','toed']);
    assert.equal(sample.events.some(e=>e.type==='switch'),false);
    assert.equal(sample.events.some(e=>e.type==='move'&&['gol','toed'].includes(e.actorId)),false);
    assert.equal(sample.gate.passed,false);
  }finally{ref.battle.destroy();}
});

test('CURRENT Emergency Exit exact-half, already-below-half and Protect countercases match native histories',()=>{
  for(const substitutes of [2,3]){
    const ref=history({substitutes});try{
      const gol=ref.battle.p1.pokemon.find(p=>p.name==='gol');
      if(substitutes===2)assert.equal(gol.hp,gol.maxhp/2);else assert.ok(gol.hp<gol.maxhp/2);
      const {sample}=parity(ref,branch(`already-low-${substitutes}`,ownAttack,[move(3,1),move(4)]));
      assert.equal(exits(sample).length,0);assert.ok(who(sample,'gol').hp<who(sample,'gol','start').hp);
      assert.equal(sample.boundary,'next-turn');
    }finally{ref.battle.destroy();}
  }
  const ref=history();try{
    const {sample}=parity(ref,branch('protect-prevents-crossing',[move(4),move(3,1)],attacking()));
    assert.equal(exits(sample).length,0);assert.equal(who(sample,'gol').hp,who(sample,'gol','start').hp);
    assert.equal(sample.boundary,'next-turn');
  }finally{ref.battle.destroy();}
});

test('CURRENT inactive Emergency Exit reserve stays inert and authored entry uses native crossing/replacement',()=>{
  const idleRef=history({bench:true});try{
    const {sample}=parity(idleRef,branch('bench-inert',[move(4),move(4)],[move(4),move(4)],['toed','fari']));
    assert.equal(who(sample,'gol').active,false);assert.equal(exits(sample).length,0);assert.equal(sample.boundary,'next-turn');
  }finally{idleRef.battle.destroy();}
  const enteredRef=history({bench:true});try{
    const {sample}=parity(enteredRef,branch('entry-crossing',[{type:'switch',pokemonId:'gol'},move(1,1)],attacking(),['fari']));
    assert.equal(who(sample,'gol','start').active,false);assert.equal(who(sample,'gol').active,true);
    assert.ok(sample.events.some(e=>e.type==='switch'&&e.actorId==='gol'));
    assert.equal(exits(sample).length,1);assert.equal(sample.boundary,'forced-replacement');
    assert.equal(sample.noPendingContinuation,false);assert.equal(sample.gate.passed,false);
    assert.equal(sample.events.filter(e=>e.type==='switch').length,1,'the harness supplies no replacement after the authored entry');
  }finally{enteredRef.battle.destroy();}
});

test('CURRENT Emergency Exit does not force a switch with no living reserve',()=>{
  const ref=history({noReserves:true});try{
    const {sample}=parity(ref,branch('no-reserves',[move(2,2),move(1,1)],attacking(),['gol','fari']));
    assert.equal(sample.start.sides[0].pokemon.filter(p=>p.hp>0&&!p.active).length,0);
    assert.ok(who(sample,'gol').hp>0&&who(sample,'gol').hp<=who(sample,'gol').maxhp/2);
    assert.equal(exits(sample).length,0);assert.equal(sample.boundary,'next-turn');
  }finally{ref.battle.destroy();}
});

test('CURRENT fainted Emergency Exit reserve is retained without reactivation',()=>{
  const ref=history();try{
    choose(ref.battle,'move 2 2, move 4','move 1 1 mega, move 4');
    const gol=ref.battle.p1.pokemon.find(p=>p.name==='gol');assert.equal(gol.fainted,true);
    assert.equal(ref.battle.requestState,'switch');
    assert.equal(ref.battle.choose('p1','switch 3, pass'),true,ref.battle.p1.choice.error);
    const {sample}=parity(ref,branch('fainted-holder',[move(4),move(4)],[move(4),move(4)],['fari','toed']));
    assert.equal(who(sample,'gol','start').fainted,true);assert.equal(who(sample,'gol').fainted,true);
    assert.equal(who(sample,'gol').active,false);assert.equal(exits(sample).length,0);
    assert.equal(sample.boundary,'next-turn');
  }finally{ref.battle.destroy();}
});

test('CURRENT authored Mega changes Emergency Exit to Tough Claws through the native transformation',async()=>{
  const ref=history();try{
    const authored=branch('native-mega',[move(2,1,true),move(3,2)],[move(3,1,true),move(1,1)]),{sample,input,result}=parity(ref,authored);
    assert.equal(who(sample,'gol','start').ability,'Emergency Exit');assert.equal(who(sample,'gol').ability,'Tough Claws');
    assert.equal(who(sample,'gol').species,'Golisopod-Mega');assert.equal(exits(sample).length,0);
    assert.ok(sample.events.some(e=>e.type==='-mega'&&e.actorId==='gol'));
    assert.equal(sample.boundary,'next-turn');
    const worker=await runTurnSimulation(input,{timeoutMs:3500});
    assert.deepEqual(worker.samples.map(s=>sampled(s.final)),result.samples.map(s=>sampled(s.final)),'bounded worker preserves the current native result');
  }finally{ref.battle.destroy();}
});
