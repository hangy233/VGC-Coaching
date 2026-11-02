// Genuine public native histories for mechanical hit-counter inference. This
// file reads native counter state only as the independent test oracle; production
// observation must not acquire hidden native state or count all HP loss as hits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {Battle,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown'),{extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4];
const set=(name,species,ability,item,moves,nature='Bold',evs={hp:32,def:32,spd:2})=>({name,species,ability,item,moves,nature,evs,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50});
const attackers={
  water:()=>set('attacker','Politoed','Drizzle','Focus Sash',['Weather Ball','Muddy Water','Ice Beam','Protect']),
  multi:()=>set('attacker','Rhyperior','Lightning Rod','Focus Sash',['Rock Blast','Rock Slide','Ice Punch','Protect'],'Modest'),
  seed:()=>set('attacker','Rillaboom','Grassy Surge','Focus Sash',['Bullet Seed','Wood Hammer','High Horsepower','Protect'],'Modest'),
  normal:()=>set('attacker','Staraptor','Intimidate','Focus Sash',['Double-Edge','Brave Bird','Roost','Protect'],'Modest'),
  confusion:()=>set('attacker','Gengar','Cursed Body','Focus Sash',['Confuse Ray','Shadow Ball','Sludge Bomb','Protect'],'Timid',{hp:32,def:2,spe:32}),
  sand:()=>set('attacker','Tyranitar','Sand Stream','Focus Sash',['Rock Slide','Crunch','Thunder Wave','Protect']),
};
function fixture({attacker='water',target='ghost',sampleSeed=seed,ditto=false}={}){
  const targetSet=target==='water'?set('target','Politoed','Water Absorb','Sitrus Berry',['Rain Dance','Protect','Muddy Water','Ice Beam']):set('target','Annihilape','Defiant','Sitrus Berry',['Substitute','Protect','Rage Fist','Taunt']);
  const p1=[targetSet,set('ally','Farigiraf','Armor Tail','Expert Belt',['Helping Hand','Psychic','Trick Room','Protect']),set('bench','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','Grassy Glide','High Horsepower','Protect']),set('last','Golisopod','Emergency Exit','Golisopite',['Iron Head','Leech Life','Sucker Punch','Protect'])],p2=[attackers[attacker](),set('foeally','Sylveon','Pixilate','Fairy Feather',['Helping Hand','Hyper Voice','Mystical Fire','Protect']),set('foebench','Kingambit','Defiant','Black Glasses',['Iron Head','Low Kick','Sucker Punch','Protect']),set('foelast','Pelipper','Drizzle','Damp Rock',['Tailwind','Ice Beam','Protect','Roost'])];
  if(ditto)p2[2]=set('copy','Ditto','Imposter','Choice Scarf',['Transform']);
  for(const p of [...p1,...p2])assert.equal(new TeamValidator(FORMAT).validateSet(p),null,`${p.species} must be a native M-C legal fixture`);
  const battle=new Battle({formatid:FORMAT,seed:sampleSeed,p1:{name:'Public owner',team:p1},p2:{name:'Public foe',team:p2}});choose(battle,'team 1234','team 1234');return{battle,target:battle.p1.active[0],attacker:battle.p2.active[0],ally:battle.p1.active[1]};
}
const choose=(b,a,c)=>{assert.equal(b.choose('p1',a),true,b.p1.choice.error);assert.equal(b.choose('p2',c),true,b.p2.choice.error);};
function turn(f,ours,theirs){const at=f.battle.log.length;choose(f.battle,ours,theirs);return extractChannelMessages(f.battle.log.slice(at).join('\n'),[0])[0];}
const damage=(lines,name)=>lines.filter(line=>line.startsWith('|-damage|')&&line.split('|')[2].endsWith(': '+name));
const directDamage=(lines,name)=>damage(lines,name).filter(line=>!line.includes('[from]'));

test('one ordinary body hit increments once while Protect and type immunity do not',()=>{
  for(const [attacker,ours,expected,denial]of [['water','move 4 1, move 4',1,null],['water','move 2, move 4',0,'Protect'],['normal','move 4 1, move 4',0,'|-immune|']]){const f=fixture({attacker});try{const lines=turn(f,ours,'move 1 1, move 4');assert.equal(f.target.timesAttacked,expected);assert.equal(directDamage(lines,'target').length,expected);if(denial)assert(lines.some(line=>line.includes(denial)));}finally{f.battle.destroy();}}
});

test('spread hits count independently per actual recipient and a protected partner stays at zero',()=>{for(const protectAlly of [false,true]){let selected;for(let n=1;n<=32;n++){const f=fixture({sampleSeed:[n,2,3,4]}),lines=turn(f,`move 4 1, ${protectAlly?'move 4':'move 1 -1'}`,'move 2, move 4');if(f.target.hp>0&&directDamage(lines,'target').length===1&&(protectAlly||directDamage(lines,'ally').length===1)){selected={f,lines};break;}f.battle.destroy();}assert(selected,'bounded explicit seeds exercise the required hit branch');try{assert.equal(selected.f.target.timesAttacked,1);assert.equal(selected.f.ally.timesAttacked,protectAlly?0:1);}finally{selected.f.battle.destroy();}}});

test('a native multi-hit body move counts the observed hit count, not one move announcement',()=>{const f=fixture({attacker:'multi'});try{const lines=turn(f,'move 4 1, move 4','move 1 1, move 4'),count=Number(lines.find(line=>line.startsWith('|-hitcount|')).split('|')[3]);assert(f.target.hp>0);assert(count>=2);assert.equal(directDamage(lines,'target').length,count);assert.equal(f.target.timesAttacked,count);}finally{f.battle.destroy();}});

test('untagged Substitute HP cost and one absorbed hit do not count as received attacks',()=>{const f=fixture();try{const lines=turn(f,'move 1, move 4','move 1 1, move 4');assert(lines.some(line=>line.startsWith('|-start|')&&line.endsWith('|Substitute')));assert.equal(directDamage(lines,'target').length,1,'the only untagged HP loss is the earlier own Substitute cost');assert(lines.some(line=>line.startsWith('|-end|')&&line.endsWith('|Substitute')));assert.equal(f.target.timesAttacked,0);}finally{f.battle.destroy();}});

test('all multi-hits absorbed by Substitute leave the counter at zero despite a public hit count',()=>{const f=fixture({attacker:'multi'});try{const lines=turn(f,'move 1, move 4','move 1 1, move 4'),hit=lines.find(line=>line.startsWith('|-hitcount|'));assert(hit);const count=Number(hit.split('|')[3]);assert(count>=2);assert(f.target.volatiles.substitute);assert(lines.some(line=>line.includes('|move: Substitute|[damage]')));assert.equal(f.target.timesAttacked,0);}finally{f.battle.destroy();}});

test('multi-hits crossing from Substitute to the body use the full native executed hit count',()=>{const f=fixture({attacker:'seed'});try{const lines=turn(f,'move 1, move 4','move 1 1, move 4'),hit=lines.find(line=>line.startsWith('|-hitcount|'));assert(hit);const count=Number(hit.split('|')[3]);assert(f.target.hp>0);assert(lines.some(line=>line.startsWith('|-end|')&&line.endsWith('|Substitute')),JSON.stringify({lines,counter:f.target.timesAttacked}));assert(directDamage(lines,'target').length>1,'own Substitute cost and later body damage are separate public rows');assert.equal(f.target.timesAttacked,count,'the pinned mod counts all executed hits once the final per-target move damage is numeric');}finally{f.battle.destroy();}});

test('genuine confusion self-hit loses HP without incrementing timesAttacked',()=>{let selected;for(let n=1;n<=32;n++){const f=fixture({attacker:'confusion',sampleSeed:[n,2,3,4]}),lines=turn(f,'move 4 1, move 4','move 1 1, move 4');if(damage(lines,'target').some(line=>line.includes('[from] confusion'))){selected={f,lines};break;}f.battle.destroy();}assert(selected,'bounded native confusion samples must include self-hit');try{assert.equal(selected.f.target.timesAttacked,0);assert.equal(directDamage(selected.lines,'target').length,0);}finally{selected.f.battle.destroy();}});

test('native recoil and residual weather damage are not received move hits',()=>{
  const recoil=fixture({attacker:'normal',target:'water'});try{const lines=turn(recoil,'move 1, move 4','move 1 1, move 4');assert(damage(lines,'attacker').some(line=>line.toLowerCase().includes('[from] recoil')));assert.equal(recoil.attacker.timesAttacked,0);assert.equal(recoil.target.timesAttacked,1);}finally{recoil.battle.destroy();}
  const residual=fixture({attacker:'sand'});try{const lines=turn(residual,'move 2, move 4','move 4, move 4');assert(damage(lines,'target').some(line=>line.includes('[from] Sandstorm')));assert.equal(residual.target.timesAttacked,0);}finally{residual.battle.destroy();}
});

test('Champions switch reset clears the hit counter instead of retaining the base-gen9 lifetime value',()=>{const f=fixture();try{turn(f,'move 4 1, move 4','move 1 1, move 4');assert.equal(f.target.timesAttacked,1);turn(f,'switch 3, move 4','move 1 -2, move 4');assert.equal(f.target.isActive,false);assert.equal(f.target.timesAttacked,0);turn(f,'switch 3, move 4','move 1 -2, move 4');assert.equal(f.target.isActive,true);assert.equal(f.target.timesAttacked,0);}finally{f.battle.destroy();}});

test('a knockout clears old history before the lethal hit updates again, and dead replacement retains that remainder',()=>{const f=fixture();try{let count=0,prior=0,lethal;while(!f.target.fainted&&count++<8){prior=f.target.timesAttacked;lethal=turn(f,'move 4 1, move 4','move 1 1, move 4');}assert.equal(f.target.fainted,true);assert(prior>0,'the lethal frame must follow an already known received hit');assert(lethal.some(line=>line.startsWith('|faint|')&&line.endsWith(': target')));assert.equal(f.target.timesAttacked,1,'Champions faint clear occurs before this single-hit frame updates gotAttacked');assert.equal(f.battle.requestState,'switch');assert.equal(f.battle.choose('p1','switch 3, pass'),true,f.battle.p1.choice.error);assert.equal(f.target.isActive,false);assert.equal(f.target.timesAttacked,1,'native replacement skips living-exit cleanup for the already fainted outgoing actor');}finally{f.battle.destroy();}});

test('native Transform copies the target counter, so an observer cannot keep the transformer own hit history',()=>{const f=fixture({ditto:true});try{turn(f,'move 4 1, move 4','move 1 1, move 4');assert.equal(f.target.timesAttacked,1);const lines=turn(f,'move 2, move 4','move 1 1, switch 3'),copy=f.battle.p2.active[1];assert.equal(copy.name,'copy');assert.equal(copy.transformed,true);assert(lines.some(line=>line.startsWith('|-transform|')&&line.includes('p1a: target')));assert.equal(copy.timesAttacked,f.target.timesAttacked);assert.equal(copy.timesAttacked,1,'the newly entered Ditto had no own received hits');}finally{f.battle.destroy();}});
