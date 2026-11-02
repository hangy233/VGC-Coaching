// Independent native current continuations. These reconstructed mechanics
// fixtures are not a replay of a historical world or a battle/model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn} from './turn-simulator.mjs';
const require=createRequire(import.meta.url),{Battle,Dex}=require('pokemon-showdown');
const {extractChannelMessages}=require('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',copy=structuredClone,dex=Dex.forFormat(FORMAT);
const points={hp:32,atk:0,def:2,spa:32,spd:0,spe:0};
const mon=(id,species,ability,item,moves,extra={})=>({id,species,ability,item,moves,nature:'Modest',statPoints:copy(points),...extra});
const targetSets={
  normal:mon('target','Politoed','Drizzle','Damp Rock',['Weather Ball','Muddy Water','Ice Beam','Protect']),
  contrary:mon('target','Serperior','Contrary','Leftovers',['Leaf Storm','Dragon Pulse','Glare','Protect']),
  defiant:mon('target','Annihilape','Defiant','Black Belt',['Close Combat','Shadow Claw','Taunt','Protect']),
  dark:mon('target','Kingambit','Defiant','Black Glasses',['Iron Head','Sucker Punch','Low Kick','Protect']),
};
const nativeTeams=source=>Object.fromEntries(Object.entries(source).map(([id,party])=>[id,party.map(p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
const choose=(battle,ours,theirs)=>{assert.equal(battle.choose('p1',ours),true,battle.p1.choice.error);assert.equal(battle.choose('p2',theirs),true,battle.p2.choice.error);};
function reference({target='normal',denial,statusMove='Charm',attackMove='Moonblast'}={}){
  const source={p1:[
    mon('whim','Whimsicott','Prankster','Focus Sash',[statusMove,attackMove,'Tailwind','Protect'],{nature:'Timid',statPoints:{hp:32,atk:0,def:2,spa:0,spd:0,spe:32}}),
    mon('star','Staraptor','Intimidate','Staraptite',['Close Combat','Brave Bird','Roost','Protect'],{nature:'Adamant',statPoints:{hp:32,atk:32,def:2,spa:0,spd:0,spe:0}}),
    mon('peli','Pelipper','Drizzle','Expert Belt',['Tailwind','Ice Beam','Protect','Roost']),
    mon('sylv','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),
  ],p2:[copy(targetSets[target]),
    denial==='armor-tail'?mon('partner','Farigiraf','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect']):
    denial==='terrain'?mon('partner','Indeedee-F','Psychic Surge','Terrain Extender',['Psychic','Helping Hand','Trick Room','Protect']):
      mon('partner','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect']),
    mon('garde','Gardevoir','Synchronize','Gardevoirite',['Psychic','Helping Hand','Protect','Life Dew']),
    mon('rai','Raichu','Lightning Rod','Raichunite Y',['Zap Cannon','Focus Blast','Fake Out','Protect']),
  ]};
  const native=nativeTeams(source),battle=new Battle({formatid:FORMAT,seed:[1,2,3,4],p1:{name:'Independent p1',team:native.p1},p2:{name:'Independent p2',team:native.p2}});
  choose(battle,'team 1234','team 1234');choose(battle,'move 4, move 4',`move ${['contrary','defiant'].includes(target)?2:target==='normal'?3:1} 2, move 4`);return {source,battle,target};
}
function capture(battle,source){
  const field={};for(const name of ['weather','terrain'])if(battle.field[name])field[name]={id:battle.field[name],remainingTurns:battle.field[name+'State'].duration};
  return {mode:'current',turn:battle.turn,ownSide:'p1',field,sides:battle.sides.map(side=>({id:side.id,active:side.active.map(p=>p.name),megaUsed:false,
    conditions:Object.fromEntries(Object.entries(side.sideConditions).map(([id,v])=>[id,{remainingTurns:v.duration}])),pokemon:side.pokemon.map(p=>{
      assert(Object.keys(p.volatiles).every(k=>['stall','choicelock'].includes(k)),'reference contains no unsupported volatile');
      return {...copy(source[side.id].find(q=>q.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),
        lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}};
    })}))};
}
const project=position=>({turn:position.turn,field:position.field,sides:position.sides.map(s=>({id:s.id,active:s.active,conditions:s.conditions,pokemon:s.pokemon.map(p=>Object.fromEntries(['id','species','ability','item','hp','status','boosts','pp','lifecycle'].map(k=>[k,p[k]])))}))});
function sampled(value){const field={};for(const name of ['weather','terrain'])if(value.field[name])field[name]={id:value.field[name],remainingTurns:value.field[name+'Remaining']};return project({...value,field});}
const normalize=(lines,names=new Map())=>extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>{
  if(/^\|t:\|\d+$/u.test(line))return '|t:|<native-epoch>';
  const parts=line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)).split('|');
  if(['switch','drag'].includes(parts[1]))parts[3]=parts[3].replace(/, [MF](?=,|$)/gu,'');return parts.join('|');
});
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});
function parity(ref,{moonblast=false,protect=false,seed=[1,2,3,4]}={}){
  const position=capture(ref.battle,ref.source),authored={id:'native-current-effect',ourActions:[move(moonblast?2:1,1),move(4)],
    opposingActions:[protect?move(4):move(['contrary','defiant'].includes(ref.target)?2:ref.target==='normal'?3:1,2),move(4)],gate:{kind:'delivery',requiredActionsBy:['whim','star']}};
  const sample=simulateNativeTurn({position,branches:[authored],seeds:[seed],hypotheses:['Independent native continuation of exact modeled state; no secondary probability or live authority claimed.']}).samples[0];
  assert.deepEqual(sampled(sample.start),project(position),'exact current hydration without reapplying entry');
  const native=nativeTeams(Object.fromEntries(position.sides.map(s=>[s.id,s.pokemon]))),seedBattle=new Battle({formatid:FORMAT,seed,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});
  ref.battle.prng.setSeed(seedBattle.prng.getSeed());seedBattle.destroy();const before=ref.battle.log.length;
  const text=actions=>actions.map(a=>`move ${a.slot}${a.target===undefined?'':' '+a.target}`).join(', ');
  choose(ref.battle,text(authored.ourActions),text(authored.opposingActions));
  const names=new Map(sample.start.sides.flatMap(s=>s.pokemon.map((p,index)=>[`sim-${s.id}-${index}`,p.id])));
  assert.deepEqual(normalize(sample.events.map(e=>e.raw),names),normalize(ref.battle.log.slice(before)),'all ordered native effects match independent played history');
  assert.deepEqual(sampled(sample.final),project(capture(ref.battle,ref.source)),'exact native HP/PP/boosts/field/lifecycle match');return sample;
}
const actor=(sample,id,phase='final')=>sample[phase].sides.flatMap(s=>s.pokemon).find(p=>p.id===id);

test('current Charm lowers Attack through the actual native callback with exact state and PP',()=>{const ref=reference();try{const sample=parity(ref);assert(sample.events.some(e=>e.raw.includes('|-unboost|')&&e.raw.includes('|atk|2')));assert.equal(actor(sample,'whim').pp[0],actor(sample,'whim','start').pp[0]-1);assert.equal(actor(sample,'target').boosts.atk,-3);assert(sample.stochastic.potentialSecondaryEvents.length>0,'conservative boost warnings remain intact');}finally{ref.battle.destroy();}});
test('current Charm preserves Contrary reversal and opposing Defiant reaction without entry replay',()=>{for(const target of ['contrary','defiant']){const ref=reference({target});try{const sample=parity(ref);if(target==='contrary')assert.equal(actor(sample,'target').boosts.atk,3);else{assert.equal(actor(sample,'target').boosts.atk,1);assert(sample.events.some(e=>e.raw.includes('Defiant')));}}finally{ref.battle.destroy();}}});
test('ordinary native stat-stage class also admits Fake Tears with normal, Protect, Contrary and Defiant continuations',()=>{
  for(const options of [{},{protect:true},{target:'contrary'},{target:'defiant'}]){
    const ref=reference({...options,statusMove:'Fake Tears'});try{const sample=parity(ref,options);
      assert.equal(actor(sample,'target').boosts.spd,options.protect?0:options.target==='contrary'?2:-2);
      if(options.target==='defiant'){assert.equal(actor(sample,'target').boosts.atk,3);assert(sample.events.some(e=>e.raw.includes('Defiant')));}
    }finally{ref.battle.destroy();}
  }
});
test('ordinary damaging class admits native Energy Ball without another name whitelist and preserves Protect',()=>{
  for(const protect of [false,true]){const ref=reference({attackMove:'Energy Ball'});try{const sample=parity(ref,{moonblast:true,protect});assert.equal(actor(sample,'target').hp<actor(sample,'target','start').hp,!protect);}finally{ref.battle.destroy();}}
});
test('native Protect blocks both Charm and Moonblast without applying drops or reactions',()=>{for(const moonblast of [false,true]){const ref=reference({target:'defiant'});try{const sample=parity(ref,{moonblast,protect:true});assert.equal(actor(sample,'target').boosts.atk,actor(sample,'target','start').boosts.atk);assert.equal(actor(sample,'target').hp,actor(sample,'target','start').hp);assert(!sample.events.some(e=>e.raw.includes('Defiant')));assert(sample.events.some(e=>e.raw.includes('Protect')));}finally{ref.battle.destroy();}}});
test('Whimsicott Prankster Charm respects native Dark, Armor Tail and grounded Psychic Terrain denial',()=>{for(const options of [{target:'dark'},{denial:'armor-tail'},{denial:'terrain'}]){const ref=reference(options);try{const sample=parity(ref);assert.equal(actor(sample,'target').boosts.atk,actor(sample,'target','start').boosts.atk);assert(!sample.events.some(e=>e.raw.includes('Defiant')));assert(sample.events.some(e=>['-immune','-activate','cant','-fail'].includes(e.type)),JSON.stringify({options,events:sample.events}));}finally{ref.battle.destroy();}}});
test('Champions Moonblast uses its pinned10-percent secondary and native sampled effects, never the base30-percent callback',()=>{
  assert.equal(dex.moves.get('Moonblast').secondary.chance,10);const outcomes=new Set();
  for(let n=1;n<=80&&outcomes.size<2;n++){const ref=reference();try{const sample=parity(ref,{moonblast:true,seed:[n,2,3,4]}),drop=sample.events.some(e=>e.raw.includes('|-unboost|')&&e.raw.includes('|spa|1'));outcomes.add(drop);assert(actor(sample,'target').hp<actor(sample,'target','start').hp);assert.equal(actor(sample,'target').boosts.spa,drop?-1:0);}finally{ref.battle.destroy();}}
  assert.deepEqual([...outcomes].sort(),[false,true],'both deterministic seeded outcomes tested; no frequency estimate');
});
test('Moonblast native secondary activates Contrary/Defiant only when a seeded drop actually resolves',()=>{for(const target of ['contrary','defiant']){let reacted=false;for(let n=1;n<=80&&!reacted;n++){const ref=reference({target});try{const sample=parity(ref,{moonblast:true,seed:[n,2,3,4]});reacted=target==='contrary'?actor(sample,'target').boosts.spa===1:sample.events.some(e=>e.raw.includes('Defiant'));if(reacted)assert.equal(actor(sample,'target').boosts[target==='contrary'?'spa':'atk'],target==='contrary'?1:3);}finally{ref.battle.destroy();}}assert(reacted,`actual seeded ${target} reaction covered`);}});
test('Moonblast is an ordinary attacking move even with Prankster and a Dark target',()=>{const ref=reference({target:'dark'});try{const sample=parity(ref,{moonblast:true});assert(actor(sample,'target').hp<actor(sample,'target','start').hp);assert(!sample.events.some(e=>e.type==='-immune'));}finally{ref.battle.destroy();}});
test('native charge, recharge and historical callbacks execute while invalid current fields remain refused',()=>{
  for(const attackMove of ['Hyper Beam','Solar Beam']){const ref=reference({attackMove});try{const position=capture(ref.battle,ref.source),branch={id:'native-multiturn',ourActions:[move(2,1),move(4)],opposingActions:[move(3,2),move(4)],gate:{kind:'delivery',requiredActionsBy:['whim']}};const sample=simulateNativeTurn({position,branches:[branch],seeds:[[1,2,3,4]],hypotheses:['New charge/recharge effects resolve forward natively; no later turn is asserted.']}).samples[0];assert(sample.events.some(e=>e.type==='move'&&e.move===attackMove));assert(attackMove==='Hyper Beam'?actor(sample,'whim').volatiles.mustrecharge:actor(sample,'whim').volatiles.twoturnmove);assert.equal(sample.turnComplete,true);}finally{ref.battle.destroy();}}
  const ref=reference({target:'defiant'});try{const position=capture(ref.battle,ref.source);position.sides[1].pokemon.find(p=>p.id==='target').moves[0]='Rage Fist';const input={position,branches:[{id:'unmounted-history-counter',ourActions:[move(1,1),move(4)],opposingActions:[move(1,1),move(4)],gate:{kind:'delivery',requiredActionsBy:['whim']}}],seeds:[[1,2,3,4]],hypotheses:['Rage Fist received-hit history is not supplied; native initial counter is conditional.']};const sample=simulateNativeTurn(input).samples[0];assert(sample.events.some(e=>e.type==='move'&&e.move==='Rage Fist'));assert.equal(sample.stateCoverage.complete,false);assert(sample.stateCoverage.assumptions.some(row=>row.path.includes('timesAttacked')));assert.equal(sample.gate.passed,false);const bad=copy(input);bad.branches[0].opposingActions[0]=move(2,2);delete bad.position.sides[0].pokemon[0].lifecycle;assert.throws(()=>simulateNativeTurn(bad),/Current snapshots require/u);}finally{ref.battle.destroy();}
});
