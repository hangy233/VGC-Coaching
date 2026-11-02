// Independent native histories/continuations. No socket, model or copied damage
// formula; an unprovided replacement remains an interrupted native turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {simulateNativeTurn,runTurnSimulation} from './turn-simulator.mjs';
import {bindObservedActions} from './observed-position.mjs';
const {Battle}=createRequire(import.meta.url)('pokemon-showdown'),{extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4],copy=structuredClone;
const mon=(id,species,ability,item,moves,nature='Modest',points={hp:32,spa:32,spd:2})=>({id,species,ability,item,moves,nature,statPoints:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...points}});
function sets({pivot='U-turn',ground=false,accuracy=false,ko=false,noBench=false,doublePivot=false}={}){
  const pivotSet={
    'U-turn':mon('pivot','Rillaboom','Grassy Surge','Choice Scarf',['U-turn','Knock Off','Protect','Wood Hammer'],'Jolly',{hp:32,def:2,spe:32}),
    'Volt Switch':mon('pivot','Raichu','Lightning Rod',ko||accuracy?'Magnet':'Choice Scarf',['Volt Switch','Thunderbolt','Protect','Fake Out'],'Timid',{hp:2,spa:32,spe:32}),
    'Flip Turn':mon('pivot','Basculegion','Adaptability','Choice Scarf',['Flip Turn','Wave Crash','Aqua Jet','Protect'],'Jolly',{hp:32,def:2,spe:32}),
    'Parting Shot':mon('pivot','Incineroar','Intimidate','Choice Scarf',['Parting Shot','Throat Chop','Protect','Fake Out'],'Jolly',{hp:32,def:2,spe:32}),
  }[pivot];
  const source={p1:[pivotSet,mon('arch','Archaludon','Stamina','Expert Belt',['Flash Cannon','Dragon Pulse','Aura Sphere','Protect']),mon('bench','Farigiraf','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Trick Room','Protect']),mon('last','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect'])],p2:[
    ground?mon('target','Garchomp','Rough Skin','Leftovers',['Dragon Claw','Earthquake','Protect','Rock Slide']):ko?mon('target','Pelipper','Drizzle','Focus Sash',['Ice Beam','Tailwind','Protect','Roost']):mon('target','Farigiraf','Armor Tail','Leftovers',['Psychic','Helping Hand','Protect','Trick Room']),
    accuracy?mon('foepartner','Politoed','Drizzle','',['Muddy Water','Weather Ball','Ice Beam','Protect']):mon('foepartner','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect']),
    mon('foebench','Kingambit','Defiant','Black Glasses',['Iron Head','Low Kick','Sucker Punch','Protect']),mon('foelast','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),
  ]};
  if(noBench){source.p1[0].item='Miracle Seed';source.p1[3].moves[2]='Helping Hand';source.p2=[mon('killer','Golisopod','Emergency Exit','Golisopite',['Iron Head','Leech Life','Sucker Punch','Protect'],'Adamant',{hp:32,atk:32,def:2}),mon('dragon','Garchomp','Rough Skin','Leftovers',['Dragon Claw','Earthquake','Protect','Rock Slide'],'Jolly',{hp:32,atk:32,spe:2}),...source.p2.slice(2)];}
  if(doublePivot)source.p1[1]=mon('arch','Basculegion','Adaptability','Expert Belt',['Flip Turn','Wave Crash','Protect','Aqua Jet'],'Bold',{hp:32,def:32,spd:2});
  return source;
}
const teams=source=>Object.fromEntries(Object.entries(source).map(([id,party])=>[id,party.map(p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
const choose=(b,a,c)=>{assert.equal(b.choose('p1',a),true,b.p1.choice.error);assert.equal(b.choose('p2',c),true,b.p2.choice.error);};
function reference(options={}){const source=sets(options),battle=new Battle({formatid:FORMAT,seed:options.historySeed??seed,p1:{name:'Independent p1',team:teams(source).p1},p2:{name:'Independent p2',team:teams(source).p2}});choose(battle,options.noBench?'team 3412':'team 1234','team 1234');return{source,battle};}
function capture(b,source){const field={};for(const key of ['weather','terrain'])if(b.field[key])field[key]={id:b.field[key],remainingTurns:b.field[key+'State'].duration};return{mode:'current',turn:b.turn,ownSide:'p1',field,sides:b.sides.map(s=>({id:s.id,active:s.active.map(p=>p.name),megaUsed:s.pokemon.some(p=>p.species.isMega),conditions:Object.fromEntries(Object.entries(s.sideConditions).map(([id,v])=>[id,{remainingTurns:v.duration}])),pokemon:s.pokemon.map(p=>{
  assert(Object.keys(p.volatiles).every(k=>['stall','choicelock',...(b.requestState==='switch'?['helpinghand','protect']:[])].includes(k)),Object.keys(p.volatiles).join(','));return{...copy(source[s.id].find(q=>q.id===p.name)),species:p.species.name,ability:p.getAbility().name,item:p.item,hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.lastMove?.name??false},volatiles:{}};
})}))};}
const project=p=>({turn:p.turn,field:p.field,sides:p.sides.map(s=>({id:s.id,active:s.active,conditions:s.conditions,pokemon:s.pokemon.map(p=>Object.fromEntries(['id','species','ability','item','hp','status','boosts','pp','lifecycle'].map(k=>[k,p[k]])))}))});
function sampled(p){const field={};for(const key of ['weather','terrain'])if(p.field[key])field[key]={id:p.field[key],remainingTurns:p.field[key+'Remaining']};return project({...p,field});}
const normalize=(lines,names=new Map())=>extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>{if(/^\|t:\|\d+$/u.test(line))return'|t:|<native-epoch>';const p=line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)).replace(/\|(p[12]): (?:Sim|Independent) p[12](?=\|)/gu,'|$1: <side>').split('|');if(['switch','drag'].includes(p[1]))p[3]=p[3].replace(/, [MF](?=,|$)/gu,'');return p.join('|');});
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})}),sw=pokemonId=>({type:'switch',pokemonId}),pass={type:'pass'};
const branch=(id,{ours=[move(1,1),move(1,1)],foes=[move(1,1),move(1,2)],continuations}={})=>({id,ourActions:ours,opposingActions:foes,...(continuations?{continuations}:{}),gate:{kind:'delivery',requiredActionsBy:['arch'],survive:['bench']}});
const actor=(s,id,phase='final')=>s[phase].sides.flatMap(side=>side.pokemon).find(p=>p.id===id);
const text=(side,actions)=>actions.map(a=>a.type==='pass'?'pass':a.type==='switch'?`switch ${a.slot??side.pokemon.findIndex(p=>p.name===a.pokemonId)+1}`:`move ${a.slot}${a.target===undefined?'':' '+a.target}`).join(', ');
function input(ref,authored,sampleSeed=seed){return{position:capture(ref.battle,ref.source),branches:[authored],seeds:[sampleSeed],hypotheses:['Independent native pivot continuation; authored replacements are hypotheses, not current battle commands.']};}
function parity(ref,authored,sampleSeed=seed){const initial=input(ref,authored,sampleSeed),sample=simulateNativeTurn(initial).samples[0];assert.deepEqual(sampled(sample.start),project(initial.position));const native=teams(Object.fromEntries(initial.position.sides.map(s=>[s.id,s.pokemon]))),constructor=new Battle({formatid:FORMAT,seed:sampleSeed,p1:{name:'Seed p1',team:native.p1},p2:{name:'Seed p2',team:native.p2}});ref.battle.prng.setSeed(constructor.prng.getSeed());constructor.destroy();const before=ref.battle.log.length;
  choose(ref.battle,text(ref.battle.p1,authored.ourActions),text(ref.battle.p2,authored.opposingActions));
  for(const step of authored.continuations??[]){if(ref.battle.ended||ref.battle.requestState!=='switch'||ref.battle.turn!==initial.position.turn)break;for(const [id,key]of [['p1','ourActions'],['p2','opposingActions']])if(ref.battle[id].activeRequest?.forceSwitch){assert(step[key]);assert.equal(ref.battle.choose(id,text(ref.battle[id],step[key])),true,ref.battle[id].choice.error);}}
  const names=new Map(sample.start.sides.flatMap(s=>s.pokemon.map((p,index)=>[`sim-${s.id}-${index}`,p.id])));assert.deepEqual(normalize(sample.events.map(e=>e.raw),names),normalize(ref.battle.log.slice(before)),'all ordered native events, including continued entries/attacks/residuals');assert.deepEqual(sampled(sample.final),project(capture(ref.battle,ref.source)),'native HP/PP/boosts/items/field/lifecycle');for(const side of sample.final.sides)for(const p of side.pokemon){const nativeActor=ref.battle[side.id].pokemon.find(actor=>actor.name===p.id);assert.deepEqual(Object.keys(p.volatiles).sort(),Object.keys(nativeActor.volatiles).sort(),'actual native temporary and persistent volatile identities');}assert.equal(sample.final.requestState,ref.battle.requestState);assert.equal(sample.final.midTurn,ref.battle.midTurn);return sample;}

test('native current U-turn, Volt Switch, Flip Turn and Parting Shot stop at the exact open switch request with pending attacks',()=>{for(const pivot of ['U-turn','Volt Switch','Flip Turn','Parting Shot']){const ref=reference({pivot});try{const s=parity(ref,branch('paused-'+pivot));assert.equal(s.boundary,'forced-replacement');assert.equal(s.turnComplete,false);assert.equal(s.noPendingContinuation,false);assert(s.replacementRequest.sides.some(side=>side.sideId==='p1'&&side.forceSwitch[0]===true));assert(s.pendingActions.some(a=>a.pokemonId==='arch'));assert.equal(s.actionOutcomes.find(a=>a.id==='arch').pendingAtBoundary,true);assert.equal(s.gate.passed,false);assert.equal(actor(s,'pivot').active,true,'no automatic entrant');assert.equal(s.events.some(e=>e.type==='switch'),false);}finally{ref.battle.destroy();}}});

test('explicit authored native pivot replacements resume the same queued turn for all four audited moves',()=>{for(const pivot of ['U-turn','Volt Switch','Flip Turn','Parting Shot']){const ref=reference({pivot});try{const s=parity(ref,branch('continued-'+pivot,{continuations:[{ourActions:[sw('bench'),pass]}]}));assert.equal(s.turnComplete,true);assert.equal(s.noPendingContinuation,true);assert.equal(s.replacementDecisions.length,1);assert.equal(s.unusedContinuations,0);assert.equal(actor(s,'pivot').active,false);assert.equal(actor(s,'bench').active,true);assert(s.events.some(e=>e.type==='switch'&&e.actorId==='bench'));assert(s.events.some(e=>e.type==='move'&&e.actorId==='arch'));}finally{ref.battle.destroy();}}});

test('numeric replacement slots follow the native menu after an earlier switch reordered the party',()=>{
  const ref=reference({doublePivot:true});try{
    const built={position:capture(ref.battle,ref.source),provenance:{ownRequestOrder:ref.source.p1.map((p,index)=>({requestIndex:index+1,snapshotId:p.id,controlPokemonId:p.id}))}};
    const ours=bindObservedActions([{type:'switch',slot:3},move(1,1)],built);
    const requested=[pass,{type:'switch',slot:3}],continuation=bindObservedActions(requested,built,{replacement:true});
    assert.equal(ours[0].pokemonId,'bench','the initial slot still refers to the frozen source menu');
    assert.deepEqual(continuation,requested,'the later numeric slot belongs to its actual replacement menu');
    const authored=branch('reordered-native-replacement',{ours,foes:[move(2,-2),move(4)],continuations:[{ourActions:continuation}]});
    const wrong=copy(authored);wrong.continuations[0].ourActions=bindObservedActions(requested,built);
    assert.equal(wrong.continuations[0].ourActions[1].pokemonId,'bench');
    assert.throws(()=>simulateNativeTurn(input(ref,wrong)),/Invalid switch/u,'binding to the old party would select the already-active entrant');
    const sample=parity(ref,authored);
    assert.equal(sample.turnComplete,true);assert.equal(sample.replacementDecisions.length,1);
    assert.equal(actor(sample,'bench').active,true);assert.equal(actor(sample,'pivot').active,true);assert.equal(actor(sample,'arch').active,false);
  }finally{ref.battle.destroy();}
});

test('stable replacement identities still bind explicitly after party order changes',()=>{
  const ref=reference({doublePivot:true});try{
    const built={position:capture(ref.battle,ref.source),provenance:{ownRequestOrder:ref.source.p1.map((p,index)=>({requestIndex:index+1,snapshotId:p.id,controlPokemonId:p.id}))}};
    const ours=bindObservedActions([{type:'switch',slot:3},move(1,1)],built),replacement=bindObservedActions([pass,sw('last')],built,{replacement:true});
    const sample=parity(ref,branch('named-replacement',{ours,foes:[move(2,-2),move(4)],continuations:[{ourActions:replacement}]}));
    assert.equal(actor(sample,'bench').active,true);assert.equal(actor(sample,'last').active,true);assert.equal(actor(sample,'arch').active,false);
  }finally{ref.battle.destroy();}
});

test('Protect and Volt Switch Ground immunity do not create or execute a supplied pivot continuation',()=>{for(const ground of [false,true]){const ref=reference({pivot:'Volt Switch',ground});try{const s=parity(ref,branch('blocked',{foes:[ground?move(1,1):move(3),move(4)],continuations:[{ourActions:[sw('bench'),pass]}]}));assert.equal(s.turnComplete,true);assert.equal(s.replacementDecisions.length,0);assert.equal(s.unusedContinuations,1);assert.equal(s.replacementRequest,null);assert.equal(actor(s,'pivot').active,true);assert.equal(s.events.some(e=>e.type==='switch'),false);assert(s.events.some(e=>e.type==='-immune'||e.raw.includes('Protect')));}finally{ref.battle.destroy();}}});

test('pivot replacement continuations reject wrong sides, missing required switches, active entrants and move actions',()=>{const ref=reference();try{for(const continuation of [{opposingActions:[sw('foebench'),pass]},{ourActions:[pass,pass]},{ourActions:[sw('arch'),pass]},{ourActions:[move(1),pass]}])assert.throws(()=>simulateNativeTurn(input(ref,branch('bad-continuation',{continuations:[continuation]}))));}finally{ref.battle.destroy();}});

test('pre-aborted pivot continuation work creates no native worker and adds no retry',async()=>{const ref=reference(),controller=new AbortController();controller.abort();let workers=0;try{await assert.rejects(runTurnSimulation(input(ref,branch('canceled',{continuations:[{ourActions:[sw('bench'),pass]}]})),{signal:controller.signal,workerFactory:()=>{workers++;throw Error('must not create worker');}}));assert.equal(workers,0);}finally{ref.battle.destroy();}});

test('a second queued pivot needs its own authored step even when no move remains in the queue',()=>{for(const finish of [false,true]){const ref=reference({doublePivot:true});try{const steps=[{ourActions:[sw('bench'),pass]},...(finish?[{ourActions:[pass,sw('last')]}]:[])],s=parity(ref,branch('two-pivots',{ours:[move(1,1),move(1,1)],foes:[move(2,-2),move(4)],continuations:steps}));assert.equal(s.replacementDecisions.length,finish?2:1);assert.equal(s.turnComplete,finish);assert.equal(s.noPendingContinuation,finish);if(!finish){assert.equal(s.pendingActions.length,0,'this last queued pivot still leaves an open native choice');assert(s.replacementRequest.sides.some(side=>side.sideId==='p1'&&side.forceSwitch[1]));assert.equal(actor(s,'arch').active,true);assert.equal(actor(s,'last').active,false);}else{assert.equal(actor(s,'arch').active,false);assert.equal(actor(s,'last').active,true);}}finally{ref.battle.destroy();}}});

test('a genuinely damaged Focus Sash target faints to Volt Switch without silently choosing either replacement',()=>{const ref=reference({pivot:'Volt Switch',ko:true});try{choose(ref.battle,'move 2 1, move 4','move 1 2, move 4');assert.equal(ref.battle.p2.active[0].hp,1,'actual native Thunderbolt consumes Sash and leaves the target at one HP');const s=parity(ref,branch('pivot-ko'));assert(s.events.some(e=>e.type==='faint'&&e.actorId==='target'));assert.equal(s.turnComplete,false);assert.equal(s.noPendingContinuation,false);assert(s.replacementRequest.sides.some(side=>side.sideId==='p1'&&side.forceSwitch[0]));assert.equal(s.events.some(e=>e.type==='switch'),false);assert.equal(actor(s,'bench').active,false);}finally{ref.battle.destroy();}});

test('a native accuracy-drop miss does not pivot or execute an inapplicable authored replacement',()=>{
  let ref;for(let n=1;n<=32;n++){const next=reference({pivot:'Volt Switch',accuracy:true,historySeed:[n,2,3,4]});choose(next.battle,'move 4 1, move 4','move 3, move 1');if(next.battle.p1.active[0].hp>0&&next.battle.p1.active[0].boosts.accuracy<0){ref=next;break;}next.battle.destroy();}assert(ref,'a bounded genuine Muddy Water history must establish reduced accuracy');
  try{const authored=branch('missed-pivot',{ours:[move(1,1),move(4)],foes:[move(2,-2),move(4)],continuations:[{ourActions:[sw('bench'),pass]}]});let missSeed;for(let n=1;n<=64;n++){const value=[n,2,3,4],s=simulateNativeTurn(input(ref,authored,value)).samples[0];if(s.events.some(e=>e.type==='-miss'&&e.actorId==='pivot')){missSeed=value;break;}}assert(missSeed,'bounded explicit native samples must include the intended miss countercase');const s=parity(ref,authored,missSeed);assert(s.events.some(e=>e.type==='-miss'&&e.actorId==='pivot'));assert.equal(s.turnComplete,true);assert.equal(s.replacementDecisions.length,0);assert.equal(s.unusedContinuations,1);assert.equal(actor(s,'pivot').active,true);assert.equal(s.events.some(e=>e.type==='switch'),false);}finally{ref.battle.destroy();}
});

test('a pivot with no healthy bench deals its native effect without a replacement request or guessed entrant',()=>{
  const ref=reference({noBench:true});try{let turns=0;while(ref.battle.p1.pokemon.filter(p=>['bench','last'].includes(p.name)).some(p=>!p.fainted)&&turns++<24){if(ref.battle.requestState==='switch'){const side=ref.battle.p1,available=['pivot','arch'].map(name=>side.pokemon.find(p=>p.name===name)).filter(p=>p&&!p.fainted&&!p.isActive),actions=side.activeRequest.forceSwitch.map(required=>required?sw(available.shift().name):pass);assert.equal(ref.battle.choose('p1',text(side,actions)),true,side.choice.error);continue;}const target=ref.battle.p1.active.findIndex(p=>['bench','last'].includes(p.name)&&!p.fainted)+1;assert(target);const ours=ref.battle.p1.active.map((p,index)=>p.name==='bench'?move(2,index===0?-2:-1):p.name==='last'?move(3,index===0?-2:-1):move(p.name==='pivot'?3:4));choose(ref.battle,text(ref.battle.p1,ours),`move 1 ${target}${ref.battle.p2.active[0].canMegaEvo?' mega':''}, move 1 ${target}`);}
    if(ref.battle.requestState==='switch'){const side=ref.battle.p1,available=['pivot','arch'].map(name=>side.pokemon.find(p=>p.name===name)).filter(p=>p&&!p.fainted&&!p.isActive);assert.equal(ref.battle.choose('p1',text(side,side.activeRequest.forceSwitch.map(required=>required?sw(available.shift().name):pass))),true,side.choice.error);}
    assert.equal(ref.battle.p1.pokemon.filter(p=>['bench','last'].includes(p.name)&&p.fainted).length,2);assert.deepEqual(ref.battle.p1.active.map(p=>p.name),['pivot','arch']);const s=parity(ref,branch('no-healthy-bench',{ours:[move(1,1),move(4)],foes:[move(3,2),move(3)]}));assert(s.events.some(e=>e.type==='move'&&e.actorId==='pivot'&&e.move==='U-turn'));assert.equal(s.turnComplete,true);assert.equal(s.replacementRequest,null);assert.equal(actor(s,'pivot').active,true);assert.equal(s.events.some(e=>e.type==='switch'),false);
  }finally{ref.battle.destroy();}
});
