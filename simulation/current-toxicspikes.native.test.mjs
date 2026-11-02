// Independent native histories establish exact hazard layers before capture.
// No battle client/model connection and no invented preexisting poison counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {buildObservedPosition} from './observed-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
import {positionSchema,observedSideConditionsSchema} from './schemas.mjs';
const require=createRequire(import.meta.url),{Battle}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4],copy=structuredClone;
const mon=(id,species,ability,item,moves,points={hp:32,def:16,spd:18})=>({id,species,ability,item,moves,nature:'Calm',statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...points}});
const incomingSets={
  grounded:mon('incoming','Politoed','Drizzle','Damp Rock',['Weather Ball','Muddy Water','Ice Beam','Protect']),
  poison:mon('incoming','Glimmora','Toxic Debris','Sitrus Berry',['Power Gem','Earth Power','Energy Ball','Protect']),
  steel:mon('incoming','Archaludon','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot']),
  flying:mon('incoming','Pelipper','Drizzle','Expert Belt',['Tailwind','Ice Beam','Protect','Roost']),
};
const nativeTeams=source=>Object.fromEntries(Object.entries(source).map(([id,party])=>[id,party.map(p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
const choose=(battle,ours,theirs)=>{assert.equal(battle.choose('p1',ours),true,battle.p1.choice.error);assert.equal(battle.choose('p2',theirs),true,battle.p2.choice.error);};
function reference({layers=1,incoming='grounded'}={}){
  const source={p1:[mon('star','Staraptor','Intimidate','Staraptite',['Quick Attack','Brave Bird','Roost','Protect']),
    mon('fari','Farigiraf','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect']),copy(incomingSets[incoming]),
    mon('rai','Raichu','Lightning Rod','Focus Sash',['Zap Cannon','Focus Blast','Fake Out','Protect'])],
    p2:[mon('glim','Glimmora','Toxic Debris','Focus Sash',['Power Gem','Earth Power','Energy Ball','Protect']),
      mon('sylv','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),
      mon('rilla','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect']),
      mon('toed','Politoed','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect'])]};
  const native=nativeTeams(source),battle=new Battle({formatid:FORMAT,seed,p1:{name:'Independent p1',team:native.p1},p2:{name:'Independent p2',team:native.p2}});
  choose(battle,'team 1234','team 1234');
  for(let n=0;n<layers;n++)choose(battle,'move 1 1, move 4','move 1 2, move 4');
  assert.equal(battle.p1.sideConditions.toxicspikes.layers,layers);return {battle,source};
}
function capture(battle,source){
  const field={};for(const name of ['weather','terrain'])if(battle.field[name])field[name]={id:battle.field[name],remainingTurns:battle.field[name+'State'].duration};
  return {mode:'current',turn:battle.turn,ownSide:'p1',field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:false,
    conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([id,v])=>[id,id==='toxicspikes'?{layers:v.layers}:{remainingTurns:v.duration}])),pokemon:side.pokemon.map(p=>{
      assert(Object.keys(p.volatiles).every(k=>['stall','choicelock'].includes(k)));
      return {...copy(source[side.id].find(q=>q.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),
        lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}};
    })}))};
}
const project=position=>({turn:position.turn,field:position.field,sides:position.sides.map(s=>({id:s.id,active:s.active,conditions:s.conditions,pokemon:s.pokemon.map(p=>Object.fromEntries(['id','species','ability','item','hp','status','boosts','pp','lifecycle'].map(k=>[k,p[k]])))}))});
function sampled(value){const field={};for(const name of ['weather','terrain'])if(value.field[name])field[name]={id:value.field[name],remainingTurns:value.field[name+'Remaining']};return project({...value,field});}
const normalize=(lines,names=new Map())=>extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>{
  if(/^\|t:\|\d+$/u.test(line))return '|t:|<native-epoch>';
  const parts=line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)).replace(/\|(p[12]): (?:Sim|Independent) p[12](?=\|)/gu,'|$1: <side>').split('|');if(['switch','drag'].includes(parts[1]))parts[3]=parts[3].replace(/, [MF](?=,|$)/gu,'');return parts.join('|');
});
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});
function parity(ref,{physical=false,special=false,switching=false,protect=false}={}){
  const position=capture(ref.battle,ref.source),authored={id:'exact-layer-continuation',ourActions:[switching?{type:'switch',pokemonId:'incoming'}:physical?move(1,1):move(4),special?move(1,1):move(4)],opposingActions:[protect?move(4):move(1,2),move(4)],gate:{kind:'delivery',requiredActionsBy:['star','fari']}};
  const sample=simulateNativeTurn({position,branches:[authored],seeds:[seed],hypotheses:['Exact native hazard layers and full selected state; no current/live freshness or tactical conclusion.']}).samples[0];
  assert.deepEqual(sampled(sample.start),project(position),'mount exact layers without entry replay');
  const native=nativeTeams(Object.fromEntries(position.sides.map(s=>[s.id,s.pokemon]))),seedBattle=new Battle({formatid:FORMAT,seed,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});ref.battle.prng.setSeed(seedBattle.prng.getSeed());seedBattle.destroy();
  const text=(side,actions)=>actions.map(a=>a.type==='switch'?`switch ${side.pokemon.findIndex(p=>p.name===a.pokemonId)+1}`:`move ${a.slot}${a.target===undefined?'':' '+a.target}`).join(', '),before=ref.battle.log.length;
  choose(ref.battle,text(ref.battle.p1,authored.ourActions),text(ref.battle.p2,authored.opposingActions));const names=new Map(sample.start.sides.flatMap(s=>s.pokemon.map((p,index)=>[`sim-${s.id}-${index}`,p.id])));
  assert.deepEqual(normalize(sample.events.map(e=>e.raw),names),normalize(ref.battle.log.slice(before)),'all native hazard/poison/absorption effects match independent history');
  assert.deepEqual(sampled(sample.final),project(capture(ref.battle,ref.source)),'exact final HP/status/layers/PP/field match');return sample;
}
const actor=(sample,id,phase='final')=>sample[phase].sides.flatMap(s=>s.pokemon).find(p=>p.id===id);

test('exact current Toxic Spikes layers persist without duration, entry replay or poison on already active actors',()=>{for(const layers of [1,2]){const ref=reference({layers});try{const sample=parity(ref);assert.deepEqual(sample.start.sides[0].conditions.toxicspikes,{layers});assert.deepEqual(sample.final.sides[0].conditions.toxicspikes,{layers});assert.equal(actor(sample,'fari').status,'');assert(!sample.events.some(e=>e.type==='-sidestart'));}finally{ref.battle.destroy();}}});
test('current Toxic Debris resolves another physical hit and caps at two exact layers',()=>{for(const layers of [1,2]){const ref=reference({layers});try{const sample=parity(ref,{physical:true});assert.equal(sample.final.sides[0].conditions.toxicspikes.layers,2);assert.equal(sample.events.some(e=>e.raw.includes('ability: Toxic Debris')),layers===1);}finally{ref.battle.destroy();}}});
test('native special damage and a protected physical attempt do not activate Toxic Debris',()=>{for(const options of [{special:true},{physical:true,protect:true}]){const ref=reference();try{const sample=parity(ref,options);assert.deepEqual(sample.final.sides[0].conditions.toxicspikes,{layers:1});assert(!sample.events.some(e=>e.raw.includes('Toxic Debris')));}finally{ref.battle.destroy();}}});
test('real grounded switches receive native poison or newly created toxic status by exact layer count',()=>{for(const layers of [1,2]){const ref=reference({layers});try{const sample=parity(ref,{switching:true});assert.equal(actor(sample,'incoming').status,layers===1?'psn':'tox');assert(sample.events.some(e=>e.type==='-status'));assert.equal(actor(sample,'star').status,'');}finally{ref.battle.destroy();}}});
test('real Poison switch absorbs exact current layers while Steel and Flying preserve them without poison',()=>{for(const incoming of ['poison','steel','flying']){const ref=reference({layers:2,incoming});try{const sample=parity(ref,{switching:true});assert.equal(actor(sample,'incoming').status,'');if(incoming==='poison'){assert.equal(sample.final.sides[0].conditions.toxicspikes,undefined);assert(sample.events.some(e=>e.type==='-sideend'));}else assert.deepEqual(sample.final.sides[0].conditions.toxicspikes,{layers:2});}finally{ref.battle.destroy();}}});
test('observed Toxic Spikes uses exact recorded layers and refuses missing, invented, conflicting or duration-shaped hypotheses',()=>{
  for(const layers of [1,2]){const f=currentFixture();f.observed.boards[0].sides[0].conditions.toxicspikes={name:'Toxic Spikes',layers,remainingTurns:null};
    assert.deepEqual(buildObservedPosition(f).position.sides[0].conditions.toxicspikes,{layers});
    f.hypotheses.sideConditions={p1:{toxicspikes:{layers}}};assert.deepEqual(buildObservedPosition(f).position.sides[0].conditions.toxicspikes,{layers});
    const conflict=copy(f);conflict.hypotheses.sideConditions.p1.toxicspikes.layers=layers===1?2:1;assert.throws(()=>buildObservedPosition(conflict),/layer hypothesis conflicts/u);
    for(const bad of [undefined,null,0,3]){const unknown=copy(f);unknown.observed.boards[0].sides[0].conditions.toxicspikes.layers=bad;assert.throws(()=>buildObservedPosition(unknown),/exact observed layers/u);}
    const absent=copy(f);delete absent.observed.boards[0].sides[0].conditions.toxicspikes;assert.throws(()=>buildObservedPosition(absent),/unobserved side condition/u);
  }
  for(const toxicspikes of [{remainingTurns:2},{layers:1,remainingTurns:2},{layers:0},{layers:3}])assert.equal(observedSideConditionsSchema.safeParse({toxicspikes}).success,false);
  const ref=reference();try{const p=capture(ref.battle,ref.source);assert.equal(positionSchema.safeParse(p).success,true);p.sides[0].conditions.toxicspikes.remainingTurns=2;assert.equal(positionSchema.safeParse(p).success,false);}finally{ref.battle.destroy();}
});
test('observed Toxic Debris permits consistent current copies and toxic status while retaining known conflicts',()=>{
  const f=currentFixture(),p=f.observed.boards[0].sides[1].pokemon[0],set={species:'Glimmora',nature:'Modest',ability:'Toxic Debris',item:'Focus Sash',moves:['Power Gem','Earth Power','Energy Ball','Protect']};
  f.opposingSheet[f.opposingSheet.findIndex(s=>s.species===p.species)]=set;f.observed.opponentSheets.p2=copy(f.opposingSheet);Object.assign(p,{species:set.species,ability:set.ability});Object.assign(f.hypotheses.opposing[p.id],{ability:set.ability,item:set.item});assert.equal(buildObservedPosition(f).position.sides[1].pokemon[0].ability,'Toxic Debris');
  const suppressed=copy(f);suppressed.observed.boards[0].sides[1].pokemon[0].abilitySuppressed=true;assert.throws(()=>buildObservedPosition(suppressed),/suppression/u);
  const copied=copy(f);copied.hypotheses.opposing[p.id].ability='Drizzle';assert.throws(()=>buildObservedPosition(copied),/ability hypothesis conflicts with observation/u);
  copied.observed.boards[0].sides[1].pokemon[0].ability='Drizzle';
  const currentCopy=buildObservedPosition(copied).position.sides[1].pokemon[0];
  assert.equal(currentCopy.ability,'Drizzle');assert.equal(currentCopy.nativeState.baseAbility,'Toxic Debris');assert.equal(currentCopy.species,'Glimmora');
  const poisoned=copy(f);poisoned.observed.boards[0].sides[1].pokemon[0].status='tox';
  assert.equal(buildObservedPosition(poisoned).position.sides[1].pokemon[0].status,'tox','native status is retained; this pure builder does not certify its hidden counter');
  poisoned.hypotheses.opposing[p.id].status='psn';assert.throws(()=>buildObservedPosition(poisoned),/status hypothesis conflicts with observation/u);
});
