import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {buildObservedPosition} from './observed-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
const {Battle}=createRequire(import.meta.url)('pokemon-showdown'),{extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',copy=structuredClone;
const mon=(id,species,nature,ability,item,moves,patch)=>({id,species,nature,ability,item,moves,statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...patch}});
const nativeTeams=sets=>Object.fromEntries(Object.entries(sets).map(([side,party])=>[side,party.map(p=>({name:p.id,species:p.species,nature:p.nature,ability:p.ability,item:p.item,moves:p.moves,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
const choose=(battle,a,b)=>{assert.equal(battle.choose('p1',a),true,battle.p1.choice.error);assert.equal(battle.choose('p2',b),true,battle.p2.choice.error);};
function fixture({immune=false,priorStatus=false}={}){
  const sets={p1:[
    mon('garde','Gardevoir','Modest','Synchronize','Gardevoirite',['Psychic','Hyper Voice','Calm Mind','Protect'],{hp:32,spa:32,spd:2}),
    mon('toed','Politoed','Modest','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect'],{hp:32,spa:32,def:2}),
    mon('fari','Farigiraf','Sassy','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect'],{hp:32,def:16,spd:18}),
    mon('gol','Golisopod','Brave','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect'],{hp:32,atk:32,spd:2}),
  ],p2:[
    mon('sala','Salamence','Modest','Intimidate','Focus Sash',['Heat Wave','Draco Meteor','Protect','Roost'],{hp:32,spa:32,spd:2}),
    mon('rai','Raichu','Timid','Lightning Rod','Raichunite Y',['Zap Cannon','Focus Blast','Fake Out','Protect'],{hp:2,spa:32,spe:32}),
    mon('volc','Volcarona','Modest','Flame Body','Expert Belt',['Will-O-Wisp','Heat Wave','Giga Drain','Protect'],{hp:32,spa:32,spd:2}),
    mon('rilla','Rillaboom','Adamant','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect'],{hp:32,atk:32,def:2}),
  ]};
  const native=nativeTeams(sets),battle=new Battle({formatid:FORMAT,seed:[1,2,3,4],p1:{name:'Reference p1',team:native.p1},p2:{name:'Reference p2',team:native.p2}});
  choose(battle,'team 1234',immune||priorStatus?'team 3214':'team 1234');
  choose(battle,'move 3, move 4',priorStatus?'move 1 1, move 4':immune?'move 4, move 4':'move 3, move 4');
  if(priorStatus)assert.equal(battle.p1.active[0].status,'brn');
  return {battle,sets};
}
function capture(battle,sets){
  const field={};if(battle.field.weather)field.weather={id:battle.field.weather,remainingTurns:battle.field.weatherState.duration};
  return {mode:'current',turn:battle.turn,ownSide:'p1',field,sides:battle.sides.map(s=>({id:s.id,active:s.active.map(p=>p.name),megaUsed:false,conditions:{},pokemon:s.pokemon.map(p=>({...copy(sets[s.id].find(q=>q.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}}))}))};
}
function projected(position){return {turn:position.turn,field:position.field,sides:position.sides.map(s=>({id:s.id,active:s.active,pokemon:s.pokemon.map(p=>Object.fromEntries(['id','species','ability','item','hp','status','boosts','pp','lifecycle'].map(k=>[k,p[k]])))}))};}
function sampled(state){const field={};if(state.field.weather)field.weather={id:state.field.weather,remainingTurns:state.field.weatherRemaining};return projected({...state,field});}
const normal=(lines,names=new Map())=>extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)));
const text=actions=>actions.map(a=>`move ${a.slot}${a.target===undefined?'':' '+a.target}${a.mega?' mega':''}`).join(', ');
function parity({immune=false,priorStatus=false,protect=false,mega=false,seed=[1,2,3,4]}={}){
  const f=fixture({immune,priorStatus});try{
    const position=capture(f.battle,f.sets),branch={id:'sync',ourActions:[{type:'move',slot:protect?4:1,...(protect?{}:{target:2}),...(mega?{mega:true}:{})},{type:'move',slot:4}],opposingActions:[{type:'move',slot:priorStatus?4:immune?2:1},{type:'move',slot:4}],gate:{kind:'delivery',requiredActionsBy:['garde','toed']}},sample=simulateNativeTurn({position,branches:[branch],seeds:[seed],hypotheses:['Independent native Synchronize continuation; no live battle or guaranteed secondary effect.']}).samples[0];
    assert.deepEqual(sampled(sample.start),projected(position));
    const native=nativeTeams(Object.fromEntries(position.sides.map(s=>[s.id,s.pokemon]))),seedSource=new Battle({formatid:FORMAT,seed,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});f.battle.prng.setSeed(seedSource.prng.getSeed());seedSource.destroy();const before=f.battle.log.length;
    choose(f.battle,text(branch.ourActions),text(branch.opposingActions));
    const names=new Map(sample.start.sides.flatMap(s=>s.pokemon.map((p,index)=>[`sim-${s.id}-${index}`,p.id])));
    assert.deepEqual(normal(sample.events.map(e=>e.raw),names),normal(f.battle.log.slice(before)),'all ordered native effects match independent history');
    assert.deepEqual(sampled(sample.final),projected(capture(f.battle,f.sets)),'HP/status/ability/PP/lifecycle/boost/field match independent history');return sample;
  }finally{f.battle.destroy();}
}
test('CURRENT Synchronize reflects a newly received native secondary status to a nonimmune source',()=>{
  const sample=parity({seed:[11,2,3,4]});assert(sample.events.some(e=>e.raw.includes('Synchronize')));assert.equal(sample.final.sides[0].pokemon.find(p=>p.id==='garde').status,'brn');assert.equal(sample.final.sides[1].pokemon.find(p=>p.id==='sala').status,'brn');
});
test('native source immunity can prevent the reflected status without erasing Synchronize activation',()=>{
  const sample=parity({immune:true,seed:[11,2,3,4]});assert(sample.events.some(e=>e.raw.includes('Synchronize')));assert.equal(sample.final.sides[0].pokemon.find(p=>p.id==='garde').status,'brn');assert.equal(sample.final.sides[1].pokemon.find(p=>p.id==='volc').status,'');
});
test('CURRENT Synchronize preserves preexisting status without replaying its historical reflection',()=>{
  const sample=parity({priorStatus:true});assert.equal(sample.start.sides[0].pokemon.find(p=>p.id==='garde').status,'brn');assert(!sample.events.some(e=>e.raw.includes('Synchronize')));
});
test('native Protect denies the incoming effect without a Synchronize activation',()=>{
  const sample=parity({protect:true});assert(!sample.events.some(e=>e.raw.includes('Synchronize')));assert.equal(sample.final.sides[0].pokemon.find(p=>p.id==='garde').status,'');
});
test('authored Mega changes Synchronize to native Pixilate before the opposing action',()=>{
  const sample=parity({mega:true});assert.equal(sample.final.sides[0].pokemon.find(p=>p.id==='garde').ability,'Pixilate');assert(!sample.events.some(e=>e.raw.includes('Synchronize')));
});
test('observed Synchronize support retains suppression and unknown lifecycle refusals',()=>{
  const f=currentFixture(),p=f.observed.boards[0].sides[1].pokemon[0],set={species:'Gardevoir',nature:'Modest',ability:'Synchronize',item:'Gardevoirite',moves:['Psychic','Hyper Voice','Calm Mind','Protect']};
  f.opposingSheet[f.opposingSheet.findIndex(s=>s.species===p.species)]=set;f.observed.opponentSheets.p2=copy(f.opposingSheet);Object.assign(p,{species:set.species,ability:set.ability});Object.assign(f.hypotheses.opposing[p.id],{ability:set.ability,item:set.item,pp:[16,16,32,16]});
  assert.equal(buildObservedPosition(f).position.sides[1].pokemon.find(q=>q.id===p.id).ability,'Synchronize');
  const suppressed=copy(f);suppressed.observed.boards[0].sides[1].pokemon[0].abilitySuppressed=true;assert.throws(()=>buildObservedPosition(suppressed),/suppression/u);
  delete f.hypotheses.opposing[p.id].lifecycle;assert.throws(()=>buildObservedPosition(f),/lifecycle/u);
});
