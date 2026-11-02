import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApproximateObservedPosition} from './approximate-position.mjs';
import {buildObservedPosition,bindObservedActions} from './observed-position.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
import {positionSchema} from './schemas.mjs';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {createBattleState,reduceBattleLine,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {choiceFixtureTeams,choiceFixtureSet} from './choice-fixture.mjs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const {Battle,Teams}=createRequire(import.meta.url)('pokemon-showdown');
const copy=structuredClone,actor=(out,id)=>out.position.sides.flatMap(s=>s.pokemon).find(p=>p.id===id);
const build=f=>buildApproximateObservedPosition(f,{reason:'Offline explicit incomplete-state regression.'});

// Only the private menu/party/own HP projection is materialized into a separate
// synthetic source fixture. This is not an archived native packet or replay.
function nativeSingleton(moveName,{partySlot=1}={}){const f=currentFixture(),team=Teams.import(f.teamText),arch=team.find(p=>p.species==='Archaludon');for(const set of team)set.level=50;arch.moves=['Dragon Pulse','Flash Cannon','Protect'];arch.moves.splice(partySlot-1,0,moveName);f.teamText=Teams.export(team);f.expected.teamId=createHash('sha256').update(Teams.pack(Teams.import(f.teamText))).digest('hex');f.observed.teamSha256=f.expected.teamId;
  const foes=f.opposingSheet.map(s=>({...s,name:s.species,evs:{hp:32,atk:0,def:2,spa:32,spd:0,spe:0},level:50})),battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Native menu owner',team:Teams.import(f.teamText)},p2:{name:'Native menu foe',team:foes}});
  const choose=(side,text)=>assert.equal(battle.choose(side,text),true,battle[side].choice.error);choose('p1','team 6435');choose('p2','team 5132');choose('p1',`move ${partySlot}${moveName==='Outrage'?'':' 2'}, move 4`);choose('p2','move 1 2, move 4 2');
  if(battle.requestState==='switch'){const request=battle.p2.activeRequest;if(request?.forceSwitch)choose('p2',request.forceSwitch.map(required=>required?'switch 3':'pass').join(', '));}
  const request=battle.p1.activeRequest;assert(request?.active?.[0].moves.length===1,'native engine genuinely exposes a singleton current menu');const legal=f.observed.actions[0].legalActions;legal.active=copy(request.active);legal.pokemon=copy(request.side.pokemon);
  for(const p of f.observed.boards[0].sides[0].pokemon){const native=battle.p1.pokemon[p.requestIndex-1],entry=request.side.pokemon[p.requestIndex-1];p.hp={current:native.hp,max:native.maxhp,precision:'server-own-exact'};p.status=native.status||null;p.fainted=native.fainted;p.ability=entry.ability;p.item=entry.item;p.itemKnown=true;p.boosts={...native.boosts};p.volatiles={};const h=f.hypotheses.own[p.id];h.pp=native.moveSlots.map(m=>m.pp);h.boosts={...native.boosts};h.lifecycle={activeTurns:native.activeTurns,activeMoveActions:native.activeMoveActions,protectCounter:native.volatiles.stall?.counter??0,choiceLock:native.volatiles.choicelock?.move??false,lastMove:native.lastMove?.name??false};}
  battle.destroy();return f;
}

test('approximate builder preserves exact fresh current facts, registered investments and switch identities without mutating input',()=>{
  const f=currentFixture(),before=copy(f),strict=buildObservedPosition(f),out=build(f);assert.deepEqual(f,before);assert.equal(out.provenance.approximate,true);assert.equal(out.provenance.completeStateReconstruction,false);assert.equal(out.position.mode,'current');
  for(const p of strict.position.sides[0].pokemon)for(const key of ['id','species','nature','ability','item','moves','statPoints','hp','status','boosts','pp','lifecycle','observedHp'])assert.deepEqual(actor(out,p.id)[key],p[key],p.id+'.'+key);
  assert.deepEqual(bindObservedActions([{type:'switch',slot:3},{type:'move',slot:1,target:1}],out)[0],{type:'switch',pokemonId:actor(out,'own2').controlPokemonId});assert(out.position.stateAssumptions.every(row=>typeof row.path==='string'&&typeof row.reason==='string'));assert(out.assumptions.length<=40);assert(positionSchema.safeParse(out.position).success);
});

test('all native current abilities/statuses and observed generic effects pass through rather than capability lists',()=>{
  const f=currentFixture(),own=f.observed.boards[0].sides[0].pokemon[0],entry=f.observed.actions[0].legalActions.pokemon[0],foe=f.observed.boards[0].sides[1].pokemon[0];
  own.ability='Protean';entry.ability='Protean';own.status='slp';entry.condition+=' slp';own.abilitySuppressed=true;own.volatiles={taunt:{name:'Taunt',startedTurn:1,remainingTurns:{min:1,max:3}}};
  foe.status='tox';foe.volatiles={substitute:{name:'Substitute',startedTurn:1}};f.hypotheses.opposing.foe0.status='tox';f.observed.boards[0].sides[1].conditions={stealthrock:{name:'Stealth Rock',startedTurn:1,layers:1}};f.observed.boards[0].field.conditions.magicroom={name:'Magic Room',startedTurn:1,remainingTurns:{min:2,max:4}};
  const out=build(f),p=actor(out,'own0');assert.equal(p.ability,'Protean');assert.equal(p.nativeState.baseAbility,'Stamina');assert.equal(p.status,'slp');assert.equal(p.nativeState.volatiles.taunt.state.duration,1);assert(p.nativeState.volatiles.gastroacid);assert.equal(actor(out,'foe0').status,'tox');assert(actor(out,'foe0').nativeState.volatiles.substitute);assert.equal(out.position.sides[1].nativeConditions.stealthrock.state.layers,1);assert.equal(out.position.nativeField.conditions.magicroom.state.duration,2);assert(out.position.stateAssumptions.some(a=>a.path.endsWith('.statusState')));assert(positionSchema.safeParse(out.position).success);
});

test('unknown lifecycle, boosts and PP use explicit field hypotheses while fresh active HP/PP stay exact',()=>{
  const f=currentFixture();delete f.hypotheses.own.own0.lifecycle;delete f.hypotheses.own.own2.pp;delete f.hypotheses.opposing.foe0.pp;delete f.hypotheses.opposing.foe0.lifecycle;delete f.hypotheses.own.own2.boosts;const out=build(f);
  assert.equal(actor(out,'own0').hp,165);assert.deepEqual(actor(out,'own0').pp,f.observed.actions[0].legalActions.active[0].moves.map(m=>m.pp));assert.equal(actor(out,'own0').lifecycle.activeTurns,0);assert(out.position.stateAssumptions.some(a=>a.path==='p1.own0.lifecycle.activeTurns'&&a.selected===0));assert(out.position.stateAssumptions.some(a=>a.path==='p1.own2.pp'&&Array.isArray(a.selected)));assert(out.position.stateAssumptions.some(a=>a.path==='p2.foe0.pp'&&a.origin==='native-initial-PP-hypothesis'));assert(out.position.stateAssumptions.some(a=>a.path==='p1.own2.boosts.atk'));
});

test('shortened native menus map PP and source slots by exact move IDs without inventing action or menu capability',()=>{
  const f=currentFixture(),slot=f.observed.actions[0].legalActions.active[0];slot.moves=[copy(slot.moves[2])];const out=build(f),menu=out.provenance.ownMoveMenus.find(m=>m.pokemonId==='own0');assert.deepEqual(menu.slots,[{sourceSlot:1,nativeSlot:3,move:slot.moves[0].id??slot.moves[0].move}]);assert.equal(actor(out,'own0').pp[2],slot.moves[0].pp);assert(out.position.stateAssumptions.some(a=>a.path==='p1.own0.pp.0'));assert.equal(out.actions,undefined);
  const struggle=currentFixture();struggle.observed.actions[0].legalActions.active[0].moves=[{id:'struggle',move:'Struggle',pp:0,target:'randomNormal'}];delete struggle.hypotheses.own.own0.pp;const s=build(struggle);assert.equal(s.provenance.ownMoveMenus[0].slots[0].nativeSlot,null);assert.deepEqual(actor(s,'own0').pp,[0,0,0,0]);assert.equal(s.position.stateAssumptions.filter(a=>a.path.startsWith('p1.own0.pp.')).length,4,'zero PP is explicitly hypothetical without exhaustive source proof');
});

test('genuine native singleton Recharge, locked and charge menus reconstruct their native forced-action effects from metadata',()=>{
  for(const [name,key]of [['Giga Impact','mustrecharge'],['Outrage','lockedmove'],['Solar Beam','twoturnmove']]){const f=nativeSingleton(name),out=build(f),p=actor(out,'own0'),effect=p.nativeState.volatiles[key];assert(effect,name);assert.equal(effect.state.duration,1);if(name!=='Giga Impact')assert.equal(effect.sourceMove,name.toLowerCase().replace(/ /gu,''));assert.equal(out.provenance.ownMoveMenus[0].sourceMoveCount,1);assert(out.position.stateAssumptions.some(a=>a.path===`p1.own0.nativeState.volatiles.${key}`&&a.origin==='fresh-private-menu-state'));assert(positionSchema.safeParse(out.position).success);}
});

test('menu-derived effects let the native current engine accept the actual singleton button',()=>{for(const name of ['Giga Impact','Outrage','Solar Beam']){const f=nativeSingleton(name);for(const h of [...Object.values(f.hypotheses.opposing),...f.hypotheses.reserves])h.pp=[1,1,1,1];const out=build(f),sample=simulateNativeTurn({position:out.position,branches:[{id:'actual-singleton-button',ourActions:[{type:'move',slot:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:1,target:2}],gate:{kind:'delivery',requiredActionsBy:['own0','own1']}}],seeds:[[1,2,3,4]],hypotheses:out.assumptions}).samples[0];assert(sample.accepted.p1.canonical.startsWith('move 1'),name);if(name==='Giga Impact')assert(sample.events.some(e=>e.type==='cant'&&e.actorId==='own0'&&e.raw.includes('recharge')));}});

test('binding a genuine forced singleton keeps native menu slot one when the registered move is in party slot three',()=>{for(const name of ['Giga Impact','Outrage','Solar Beam']){const f=nativeSingleton(name,{partySlot:3});for(const h of [...Object.values(f.hypotheses.opposing),...f.hypotheses.reserves])h.pp=[1,1,1,1];const out=build(f),bound=bindObservedActions([{type:'move',slot:1},{type:'move',slot:4}],out);assert.equal(bound[0].slot,1);assert.equal(out.provenance.ownMoveMenus[0].slots[0].nativeSlot,1);assert.equal(out.provenance.ownMoveMenus[0].slots[0].partySlot,name==='Giga Impact'?null:3);const sample=simulateNativeTurn({position:out.position,branches:[{id:'bound-singleton',ourActions:bound,opposingActions:[{type:'move',slot:4},{type:'move',slot:1,target:2}],gate:{kind:'delivery',requiredActionsBy:['own0','own1']}}],seeds:[[1,2,3,4]],hypotheses:out.assumptions}).samples[0];assert.equal(sample.accepted.p1.canonical,'move 1, move 4');}});

test('current Mega form alone never overrides supplied unspent resource history',()=>{const f=currentFixture(),p=f.observed.boards[0].sides[1].pokemon[0];p.species='Raichu-Mega-Y';p.ability='No Guard';f.hypotheses.opposing.foe0.ability='No Guard';p.mega=null;f.hypotheses.sideMegaUsed.p2=false;const out=build(f);assert.equal(out.position.sides[1].megaUsed,false);assert(out.position.stateAssumptions.some(a=>a.path==='p2.megaUsed'&&a.origin==='current-form-not-Mega-use-proof'));p.mega=true;assert.throws(()=>build(f),/spent Mega resource conflicts/u);});

test('real native Imposter copies a Mega form without a Mega-use event on the copying side',()=>{
  const source=choiceFixtureTeams(),set=choiceFixtureSet;
  source.p1[0]=set('dragon','Garchomp','Rough Skin','Garchompite',['Dragon Claw','Earthquake','Protect','Swords Dance'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0});
  source.p2[0]=set('copier','Ditto','Imposter','Choice Scarf',['Transform'],{hp:32,atk:0,def:32,spa:0,spd:2,spe:0});
  const battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Mega owner',team:source.p1},p2:{name:'Copy owner',team:source.p2}}),choose=(side,text)=>assert.equal(battle.choose(side,text),true,battle[side].choice.error);
  try{
    // In doubles Imposter copies the opposite facing slot (p2a -> p1b).
    choose('p1','team 2134');choose('p2','team 1234');choose('p1','move 2 -2, move 3 mega');choose('p2','switch 3, move 4');choose('p1','move 2 -2, move 3');choose('p2','switch 3, move 4');
    const copier=battle.p2.active[0];assert.equal(copier.transformed,true);assert.equal(copier.species.isMega,true);assert.equal(battle.log.some(line=>line.startsWith('|-mega|p2')),false);assert(battle.log.some(line=>line.startsWith('|-transform|p2a: copier|')));
    const state=createBattleState();for(const line of battle.log)reduceBattleLine(state,line);const observed=battleStateSnapshot(state).sides.find(s=>s.id==='p2').pokemon.find(p=>p.nickname==='copier');assert.notEqual(observed.mega,true,'only a real -mega event establishes this flag');
  }finally{battle.destroy();}
});

test('a full copied active menu supersedes stale base-party move identities and PP while disclosing unknown copied stats',()=>{
  const f=currentFixture(),names=['Protect','Swords Dance','Outrage','Earthquake'];f.observed.actions[0].legalActions.active[0].moves=names.map((name,index)=>({move:name,id:name.toLowerCase().replace(/ /gu,''),pp:index+1,target:name==='Protect'?'self':name==='Swords Dance'?'self':name==='Outrage'?'randomNormal':'allAdjacent'}));const out=build(f),p=actor(out,'own0');assert.deepEqual(p.moves,names);assert.deepEqual(p.pp,[1,2,3,4]);assert.deepEqual(out.provenance.ownMoveMenus[0].slots.map(row=>row.nativeSlot),[1,2,3,4]);assert(out.position.stateAssumptions.some(a=>a.path==='p1.own0.statPoints'&&a.origin==='copied-current-stats-unknown'));assert(out.position.stateAssumptions.some(a=>a.path==='p1.own0.moves'&&a.origin==='fresh-private-active-copied-moves'));
});

test('an ordinary singleton does not invent a specific lock cause absent native locking metadata',()=>{const f=currentFixture();f.observed.actions[0].legalActions.active[0].moves=[copy(f.observed.actions[0].legalActions.active[0].moves[0])];const out=build(f);assert.equal(actor(out,'own0').nativeState.volatiles.lockedmove,undefined);assert.equal(actor(out,'own0').nativeState.volatiles.twoturnmove,undefined);assert.equal(actor(out,'own0').nativeState.volatiles.mustrecharge,undefined);});

test('known state conflicts remain errors rather than being repaired with approximate values',()=>{
  for(const mutate of [f=>{f.hypotheses.own.own0.boosts.def=1;},f=>{f.hypotheses.own.own0.pp[0]--;},f=>{f.observed.boards[0].sides[1].pokemon[0].ability='Lightning Rod';f.hypotheses.opposing.foe0.ability='Intimidate';},f=>{const p=f.observed.boards[0].sides[1].pokemon[0];p.itemKnown=true;p.item='Leftovers';},f=>{f.observed.boards[0].sides[1].pokemon[0].status='par';f.hypotheses.opposing.foe0.status='brn';},f=>{f.hypotheses.opposing.foe0.nature='Adamant';},f=>{f.hypotheses.opposing.foe0.volatiles={taunt:{remainingTurns:1}};}]){const f=currentFixture();mutate(f);assert.throws(()=>build(f),/conflicts|unobserved/u);}
  const f=currentFixture();f.observed.boards[0].sides[1].pokemon[0].volatiles.confusion={name:'Confusion',remainingActions:{min:1,max:2}};f.hypotheses.opposing.foe0.volatiles={confusion:{remainingActions:3}};assert.throws(()=>build(f),/range conflicts/u);
});

test('unknown native effects are explicitly omitted and cannot appear as exact reconstruction',()=>{
  const f=currentFixture();f.observed.boards[0].sides[1].pokemon[0].volatiles.notarealeffect={name:'unknown effect'};const out=build(f);assert.equal(actor(out,'foe0').nativeState.volatiles.notarealeffect,undefined);assert(out.position.stateAssumptions.some(a=>a.path.endsWith('notarealeffect')&&a.origin==='omitted-known-mechanic'));assert.equal(out.provenance.completeStateReconstruction,false);
});

test('approximation does not relax team, source, freshness, reserved-send or exact own HP identity checks',()=>{
  for(const mutate of [f=>{f.expected.teamId='b'.repeat(64);},f=>{f.expected.token='b'.repeat(64);},f=>{f.observed.actions[0].submissionStatus='uncertain';},f=>{f.observed.controlPolicy={pending:[{token:f.expected.token,attempted:true}]};},f=>{f.observed.actions[0].legalActions.forceSwitch=[true,false];},f=>{f.observed.actions[0].legalActions.pokemon[0].condition='164/165';},f=>{f.observed.actions[0].legalActions.pokemon[0].details='Politoed, L50';},f=>{f.observed.boards[0].sides[0].pokemon[1].requestIndex=1;},f=>{f.opposingSheet[0].item='Leftovers';}]){const f=currentFixture();mutate(f);assert.throws(()=>build(f));}
});

test('native JSON fields never invoke source getters or accept cyclic/nonfinite metadata',()=>{
  const f=currentFixture();let called=0;Object.defineProperty(f.observed,'trap',{enumerable:true,get(){called++;return {};}});assert.throws(()=>build(f),/data-only/u);assert.equal(called,0);const c=currentFixture();c.observed.boards[0].self=c;assert.throws(()=>build(c),/cyclic/u);const n=currentFixture();n.observed.boards[0].sides[1].pokemon[0].volatiles.taunt={counter:NaN};assert.throws(()=>build(n),/data-only/u);
});
