import {test} from 'node:test';
import {ShowdownClient} from '../showdown/client.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import assert from 'node:assert/strict';
import {buildObservedPosition,publishedSheetDigest,bindObservedActions} from './observed-position.mjs';
import {fixture,currentFixture,points} from './observed-position.fixtures.mjs';
test('opening reconstructs exact registered coverage and pre-entry Seed without carrying applied entry effects',()=>{
  const result=buildObservedPosition(fixture()),fari=result.position.sides[0].pokemon.find(p=>p.id==='own1');
  assert.equal(result.position.mode,'opening');assert.equal(fari.item,'Grassy Seed');assert.equal(fari.boosts,undefined);assert.equal(result.position.field,undefined);
  assert.deepEqual(result.position.sides[1].pokemon.find(p=>p.id==='foe2').moves,['Heat Wave','Quiver Dance','Giga Drain','Protect']);
  assert.ok(result.assumptions.some(value=>value.includes('hypothetical selected reserve')));
});
test('exact token/team/sheet binding rejects stale or invented inputs',()=>{
  for(const change of [input=>input.expected.token='b'.repeat(64),input=>input.expected.teamId='b'.repeat(64),input=>input.opposingSheet[2].moves[0]='Fiery Dance']){
    const input=fixture();change(input);assert.throws(()=>buildObservedPosition(input));
  }
  const input=fixture();delete input.observed.opponentSheets;assert.throws(()=>buildObservedPosition(input),/sheet binding/);
  input.expected.opposingSheetSha256=publishedSheetDigest(input.opposingSheet);assert.equal(buildObservedPosition(input).position.turn,1);
});
test('unrevealed selected reserves and opposing investments must be explicit',()=>{
  const input=fixture();input.hypotheses.reserves.pop();assert.throws(()=>buildObservedPosition(input),/reserve count/);
  const other=fixture();delete other.hypotheses.opposing.foe1;assert.throws(()=>buildObservedPosition(other),/investment\/HP/);
});
test('source cannot be an already sent, forced, partial or post-action opening request',()=>{
  for(const change of [input=>input.observed.actions[0].submissionStatus='sent',input=>input.observed.actions[0].legalActions.forceSwitch=[true,false],input=>input.observed.boards[0].recentEvents.lines.push('|move|p1a: Archaludon|Dragon Pulse|p2a: Raichu')]){
    const input=fixture();change(input);assert.throws(()=>buildObservedPosition(input));
  }
});
test('current mode keeps consumed Seed/current boosts and exact field duration, requires complete lifecycle',()=>{
  const input=currentFixture(),result=buildObservedPosition(input),fari=result.position.sides[0].pokemon.find(p=>p.id==='own1');
  assert.equal(fari.item,'');assert.equal(fari.boosts.def,1);assert.equal(result.position.field.terrain.remainingTurns,5);
  assert.deepEqual(fari.observedHp,{current:227,max:227,precision:'server-own-exact'});
  delete input.hypotheses.own.own0.lifecycle;assert.throws(()=>buildObservedPosition(input),/lifecycle/);
});
test('strict current reconstruction refuses missing counter evidence and contradictory source hypotheses',()=>{
  for(const change of [input=>delete input.hypotheses.field,input=>input.observed.boards[0].sides[0].pokemon[0].volatiles={encore:{startedTurn:1}},input=>delete input.hypotheses.own.own2.boosts,input=>input.hypotheses.own.own1.boosts.def=0,input=>input.observed.boards[0].sides[0].pokemon[0].status='tox']){
    const input=currentFixture();change(input);assert.throws(()=>buildObservedPosition(input));
  }
});

test('all seven native statuses are retained when board and fresh private conditions agree',()=>{
  for(const status of ['','brn','par','psn','tox','slp','frz']){
    const input=currentFixture(),actor=input.observed.boards[0].sides[0].pokemon[0],entry=input.observed.actions[0].legalActions.pokemon[0];actor.status=status||null;entry.condition='165/165'+(status?' '+status:'');
    const built=buildObservedPosition(input).position.sides[0].pokemon.find(p=>p.id==='own0');assert.equal(built.status,status);assert.equal(built.hp,165);
  }
  const mismatch=currentFixture();mismatch.observed.boards[0].sides[0].pokemon[0].status='slp';assert.throws(()=>buildObservedPosition(mismatch),/current status conflicts/);
});
test('confusion accepts only explicit native action-counter hypotheses within the bound observed range',()=>{
  const f=currentFixture(),p=f.observed.boards[0].sides[1].pokemon[0],h=f.hypotheses.opposing[p.id];p.volatiles.confusion={name:'confusion',startedTurn:1,remainingActions:{min:1,max:3}};h.volatiles={confusion:{remainingActions:2}};
  assert.deepEqual(buildObservedPosition(f).position.sides[1].pokemon.find(a=>a.id===p.id).volatiles.confusion,{remainingActions:2});
  for(const n of [1,3]){h.volatiles.confusion.remainingActions=n;assert.equal(buildObservedPosition(f).position.sides[1].pokemon.find(a=>a.id===p.id).volatiles.confusion.remainingActions,n);}
  for(const patch of [g=>{delete g.hypotheses.opposing[p.id].volatiles.confusion;},g=>{g.hypotheses.opposing[p.id].volatiles.confusion.remainingActions=4;},g=>{g.hypotheses.opposing[p.id].volatiles.confusion.remainingActions=0;},g=>{g.observed.boards[0].sides[1].pokemon[0].volatiles.confusion.remainingActions={min:3,max:1};},g=>{delete g.observed.boards[0].sides[1].pokemon[0].volatiles.confusion;}]){const bad=structuredClone(f);patch(bad);assert.throws(()=>buildObservedPosition(bad),/confusion|unobserved volatile/u);}
  const mixed=structuredClone(f);mixed.observed.boards[0].sides[1].pokemon[0].volatiles.encore={name:'Encore',move:'Focus Blast',remainingTurns:{min:1,max:2}};Object.assign(mixed.hypotheses.opposing[p.id],{volatiles:{confusion:{remainingActions:2},encore:{move:'Focus Blast',remainingTurns:2}}});mixed.hypotheses.opposing[p.id].lifecycle.lastMove='Focus Blast';assert.deepEqual(Object.keys(buildObservedPosition(mixed).position.sides[1].pokemon.find(a=>a.id===p.id).volatiles),['encore','confusion']);
});
test('Unburden requires an explicit native volatile flag and cannot contradict a bound known activation',()=>{
  const f=currentFixture(),p=f.observed.boards[0].sides[1].pokemon[0],h=f.hypotheses.opposing[p.id];
  const changed={species:'Sneasler',nature:'Adamant',ability:'Unburden',item:'Grassy Seed',moves:['Close Combat','Dire Claw','Rock Slide','Protect']};
  for(const sheet of [f.opposingSheet,f.observed.opponentSheets.p2])Object.assign(sheet.find(set=>set.species===p.species),structuredClone(changed));
  Object.assign(p,{species:'Sneasler',ability:'Unburden',item:'',itemKnown:true,abilitySuppressed:false,unburdenVolatile:true});Object.assign(h,{ability:'Unburden',item:'',pp:[1,1,1,1]});h.lifecycle.unburdenVolatile=true;
  assert.equal(buildObservedPosition(f).position.sides[1].pokemon.find(actor=>actor.id===p.id).lifecycle.unburdenVolatile,true);
  h.lifecycle.unburdenVolatile=false;assert.throws(()=>buildObservedPosition(f),/conflicts with known native history/u);
  delete h.lifecycle.unburdenVolatile;assert.throws(()=>buildObservedPosition(f),/Unburden volatile history is unknown/u);
  h.lifecycle.unburdenVolatile=true;p.abilitySuppressed=true;assert.throws(()=>buildObservedPosition(f),/suppression/u);
});
test('current Mega history and unique own request mapping cannot silently default',()=>{
  const input=currentFixture();delete input.hypotheses.sideMegaUsed;assert.throws(()=>buildObservedPosition(input),/Mega-use history/);
  const duplicate=currentFixture();duplicate.observed.boards[0].sides[0].pokemon[2].requestIndex=1;assert.throws(()=>buildObservedPosition(duplicate),/duplicated\/ambiguous/);
  const fainted=currentFixture();fainted.observed.boards[0].sides[0].pokemon[0].hp.current=0;assert.throws(()=>buildObservedPosition(fainted),/zero HP/);
  const history=currentFixture();delete history.hypotheses.own.own0.lifecycle.activeMoveActions;assert.throws(()=>buildObservedPosition(history),/activeMoveActions/);
});

function ownLoneFixture(){
  const input=currentFixture(),side=input.observed.boards[0].sides[0],legal=input.observed.actions[0].legalActions;
  for(const active of legal.active)for(const move of active.moves)move.pp=1;
  for(const value of [...Object.values(input.hypotheses.own),...Object.values(input.hypotheses.opposing),...input.hypotheses.reserves])value.pp=[1,1,1,1];
  for(const p of side.pokemon)if(p.id!=='own0'){
    p.fainted=true;p.hp={current:0,max:null,precision:'server-own-exact'};legal.pokemon[p.requestIndex-1].condition='0 fnt';
  }
  return input;
}
test('current own lone survivor retains exact fainted active identity only when the private request proves no replacement',async()=>{
  const input=ownLoneFixture(),before=structuredClone(input),built=buildObservedPosition(input),ours=built.position.sides[0];
  assert.deepEqual(ours.active,['own0','own1']);assert.equal(ours.pokemon.find(p=>p.id==='own1').hp,0);assert.deepEqual(input,before);
  // Native engine alone owns pass enforcement and continued resolution.
  const {simulateNativeTurn}=await import('./turn-simulator.mjs'),authored={id:'own-lone',ourActions:[{type:'move',slot:1,target:1},{type:'pass'}],opposingActions:[{type:'move',slot:4},{type:'move',slot:1,target:1}],gate:{kind:'delivery',requiredActionsBy:['own0']}};
  const sample=simulateNativeTurn({position:built.position,branches:[authored],seeds:[[1,2,3,4]],hypotheses:built.assumptions}).samples[0];assert.equal(sample.accepted.p1.canonical,'move 1 1, pass');assert.equal(sample.start.sides[0].pokemon.find(p=>p.id==='own1').fainted,true);
  const invalid=structuredClone(authored);invalid.ourActions[1]={type:'move',slot:4};assert.throws(()=>simulateNativeTurn({position:built.position,branches:[invalid],seeds:[[1,2,3,4]],hypotheses:built.assumptions}),/explicitly authored pass/u);
});
test('own fainted-slot admission never hides healthy, unknown, forced, conflicting or ambiguous private replacements',()=>{
  for(const change of [
    f=>{const p=f.observed.boards[0].sides[0].pokemon[2];p.fainted=false;p.hp.current=1;f.observed.actions[0].legalActions.pokemon[2].condition='1/197';},
    f=>f.observed.boards[0].sides[0].unrevealedSelected=1,
    f=>f.observed.boards[0].sides[0].pokemon[1].fainted=false,
    f=>f.observed.actions[0].legalActions.pokemon[1].condition='1/227',
    f=>f.observed.actions[0].legalActions.pokemon[2].condition='1/197',
    f=>f.observed.actions[0].legalActions.pokemon[1].active=false,
    f=>f.observed.actions[0].legalActions.forceSwitch=[false,true],
    f=>f.observed.boards[0].sides[0].pokemon[0].hp.current=0,
    f=>f.observed.boards[0].sides[0].pokemon[0].requestIndex=2,
  ]){const input=ownLoneFixture();change(input);assert.throws(()=>buildObservedPosition(input));}
  const opening=fixture();opening.observed.boards[0].sides[0].pokemon[1].fainted=true;opening.observed.boards[0].sides[0].pokemon[1].hp.current=0;assert.throws(()=>buildObservedPosition(opening),/fainted|zero HP|replacement/u);
});
test('observed-high HP remains a current observed-foe hypothesis and cannot invent reserve HP',()=>{
  const input=currentFixture();input.observed.boards[0].sides[1].pokemon[0].hp.current=44;input.hypotheses.opposing.foe0.hp='observed-high';
  const built=buildObservedPosition(input),foe=built.position.sides[1].pokemon.find(p=>p.id==='foe0');
  assert.equal(foe.hp,'observed-high');assert.equal(foe.observedHp.current,44);
  assert.ok(built.assumptions.some(value=>value.includes('upper native-renderer-compatible')&&value.includes('low-HP mechanics')));
  input.hypotheses.reserves[0].hp='observed-high';assert.throws(()=>buildObservedPosition(input),/unseen reserves/);
  const opening=fixture();opening.hypotheses.opposing.foe0.hp='observed-high';assert.throws(()=>buildObservedPosition(opening),/opening HP/);
});
test('native health renderer rejects a numeric candidate outside the observed display bucket',async()=>{
  const input=currentFixture();
  for(const active of input.observed.actions[0].legalActions.active)for(const move of active.moves)move.pp=1;
  for(const value of [...Object.values(input.hypotheses.own),...Object.values(input.hypotheses.opposing),...input.hypotheses.reserves])value.pp=[1,1,1,1];
  const {simulateNativeTurn}=await import('./turn-simulator.mjs');
  const run=position=>simulateNativeTurn({position,hypotheses:['Explicit current-state test candidates, not revealed opposing investments'],seeds:[[1,2,3,4]],branches:[{id:'health-bucket',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{targetId:'foe0',beforeActionsOf:['foe0'],requiredActionsBy:['own0','own1']}}]});
  assert.equal(run(buildObservedPosition(input).position).samples.length,1);
  input.hypotheses.opposing.foe0.hp=1;
  assert.throws(()=>run(buildObservedPosition(input).position),/HP.*observ|health.*observ|observ.*HP|display/i);
});
test('own live switch index binds its recipient when active request indices are not one and two',async()=>{
  const input=fixture(),legal=input.observed.actions[0].legalActions,board=input.observed.boards[0];
  legal.pokemon=[legal.pokemon[2],legal.pokemon[3],legal.pokemon[0],legal.pokemon[1]];
  for(const p of board.sides[0].pokemon)p.requestIndex={own0:3,own1:4,own2:1,own3:2}[p.id];
  const built=buildObservedPosition(input),bound=bindObservedActions([{type:'switch',slot:1},{type:'move',slot:4}],built);
  assert.equal(bound[0].pokemonId,built.position.sides[0].pokemon.find(p=>p.id==='own2').controlPokemonId);
  const {simulateNativeTurn}=await import('./turn-simulator.mjs');
  const result=simulateNativeTurn({position:built.position,hypotheses:built.assumptions,seeds:[[1,2,3,4]],branches:[{id:'reordered-switch',ourActions:bound,opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:4,target:2}],gate:{targetId:'foe0',beforeActionsOf:['foe0'],requiredActionsBy:[]}}]});
  assert.ok(result.samples[0].events.some(event=>event.type==='switch'&&event.actorId==='own2'));
  assert.equal(result.samples[0].accepted.p1.actions[0].slot,3);
  assert.throws(()=>bindObservedActions([{type:'switch',slot:9},{type:'move',slot:4}],built),/unavailable/);
});
test('synthetic bulky target survives both delivered hits after retaliation without private cache data',async()=>{
  const input=fixture();
  input.hypotheses.opposing.foe0={label:'Explicit synthetic bulky special candidate, not a revealed opposing spread',statPoints:points({hp:32,spa:32,spd:2}),hp:'full'};
  const result=buildObservedPosition(input);assert.deepEqual(result.position.sides[0].active,['own0','own1']);
  assert.deepEqual(result.position.sides[1].pokemon.find(p=>p.id==='foe0').moves,['Zap Cannon','Focus Blast','Fake Out','Protect']);
  assert.equal(result.position.sides[0].pokemon.find(p=>p.id==='own1').item,'Grassy Seed');
  const {simulateNativeTurn}=await import('./turn-simulator.mjs');
  const simulated=simulateNativeTurn({position:result.position,hypotheses:result.assumptions,seeds:[[1,2,3,4]],branches:[{
    id:'synthetic-opening-delivery',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],
    opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],
    gate:{targetId:'foe0',beforeActionsOf:['foe0'],requiredActionsBy:['own0','own1']},
  }]});
  const sample=simulated.samples[0],attacks=sample.events.filter(event=>event.type==='move');
  assert.deepEqual(attacks.map(event=>event.actorId),['own0','foe0','foe1','own1']);
  assert.equal(sample.gate.targetKOBeforeRetaliation,false);
  assert.equal(sample.gate.passed,false);
  assert.equal(sample.events.filter(event=>event.type==='-damage'&&event.actorId==='foe0').length,2);
  assert.equal(sample.events.some(event=>event.type==='-crit'),false);
  assert.ok(sample.final.sides.find(side=>side.id==='p2').pokemon.find(p=>p.id==='foe0').hp>0,'declared normal candidate survives both delivered hits; no exact replay HP equivalence asserted');
});


function observedRetainedPpInput(){
  const input=currentFixture(),oldBoard=input.observed.boards[0],legal=input.observed.actions[0].legalActions;
  const client=new ShowdownClient({now:()=>10});client.connected=true;client.authenticated=true;client.epoch=3;
  const room=input.expected.room,feed=lines=>client.receive(`>${room}\n${lines}`),party=structuredClone(legal.pokemon);
  feed('|gen|9\n|gametype|doubles\n|start\n'+party.filter(p=>p.active).map((p,index)=>`|switch|p1${'ab'[index]}: ${p.ident.slice(4)}|${p.details}|${p.condition}`).join('\n')+'\n|turn|1');
  const first={rqid:4,side:{id:'p1',pokemon:party},active:structuredClone(legal.active)};
  first.active[0].moves.forEach((move,index)=>move.pp=7+index);feed('|request|'+JSON.stringify(first));
  feed(`|switch|p1a: ${party[2].ident.slice(4)}|${party[2].details}|${party[2].condition}`);
  const next={rqid:5,side:{id:'p1',pokemon:[party[2],party[1],party[0],party[3]]},active:[structuredClone(legal.active[0]),structuredClone(legal.active[1])]};
  next.side.pokemon.forEach((p,index)=>p.active=index<2);
  next.active[0].moves=next.side.pokemon[0].moves.map(move=>({move,pp:12,disabled:false}));
  feed('|request|'+JSON.stringify(next));
  const fresh=compactTurnBoard(client.battleSnapshot(room),{request:next});
  oldBoard.sides[0]=fresh.sides[0];oldBoard.ownPpObservation=fresh.ownPpObservation;oldBoard.request=fresh.request;
  input.expected.rqid=5;input.observed.actions[0].rqid=5;
  input.observed.actions[0].legalActions={...legal,pokemon:next.side.pokemon,active:next.active};
  input.hypotheses.own={};
  for(const p of fresh.sides[0].pokemon)input.hypotheses.own[p.id]={label:'Explicit lifecycle remains a hypothesis.',lifecycle:{activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false},boosts:{atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0},pp:[12,12,12,12]};
  const reserve=fresh.sides[0].pokemon.find(p=>p.species==='Archaludon');delete input.hypotheses.own[reserve.id].pp;
  return {input,reserve};
}

test('current builder uses exact retained private reserve PP from real client clean-switch observations',()=>{
  const {input,reserve}=observedRetainedPpInput(),before=structuredClone(input),built=buildObservedPosition(input);
  assert.deepEqual(built.position.sides[0].pokemon.find(p=>p.id===reserve.id).pp,[7,8,9,10]);assert.deepEqual(input,before);
  assert.equal(built.provenance.retainedOwnPp[0].actorId,reserve.id);assert.equal(built.provenance.retainedOwnPp[0].epoch,3);
  input.hypotheses.own[reserve.id].pp=[12,12,12,12];assert.throws(()=>buildObservedPosition(input),/PP hypothesis conflicts with retained private request/);
});

test('current builder refuses retained PP identity move order epoch and continuity conflicts and never fills lifecycle',()=>{
  for(const mutate of [
    (i,p)=>{p.ownPpSnapshot.actorId='different';},(i,p)=>{p.ownPpSnapshot.epoch++;},
    (i,p)=>{p.ownPpSnapshot.moves.reverse();},(i,p)=>{p.ownPpSnapshot.ident='p1: Other';},
    i=>{i.observed.boards[0].ownPpObservation.continuous=false;},
  ]){const {input,reserve}=observedRetainedPpInput();mutate(input,reserve);assert.throws(()=>buildObservedPosition(input),/Observed reserve PP/);}
  const {input,reserve}=observedRetainedPpInput();delete input.hypotheses.own[reserve.id].lifecycle;assert.throws(()=>buildObservedPosition(input),/lifecycle/);
  const old=currentFixture();delete old.hypotheses.own.own2.pp;assert.throws(()=>buildObservedPosition(old),/reserve PP is unknown/);
});


test('current Mega-use positives supply true while absent history and conflicting false remain refused',()=>{
  const input=currentFixture();delete input.hypotheses.sideMegaUsed;
  for(const side of input.observed.boards[0].sides)side.pokemon[0].mega=true;
  const before=structuredClone(input),built=buildObservedPosition(input);
  assert.deepEqual(built.position.sides.map(side=>side.megaUsed),[true,true]);assert.deepEqual(input,before);
  assert(built.provenance.megaUse.every(row=>row.source==='observed-mega-event'&&row.value===true));
  input.hypotheses.sideMegaUsed={p1:false,p2:true};assert.throws(()=>buildObservedPosition(input),/false conflicts/);
  const unknown=currentFixture();unknown.observed.boards[0].sides[1].pokemon[0].mega=true;delete unknown.hypotheses.sideMegaUsed;
  assert.throws(()=>buildObservedPosition(unknown),/Mega-use history for p1/);
  unknown.hypotheses.sideMegaUsed={p1:false};
  const partial=buildObservedPosition(unknown);assert.deepEqual(partial.position.sides.map(side=>side.megaUsed),[false,true]);
  const complete=structuredClone(unknown);complete.hypotheses.sideMegaUsed.p2=true;assert.deepEqual(buildObservedPosition(complete).position,partial.position,'omitting the already observed true flag does not change native input');
  unknown.observed.boards[0].sides[1].pokemon[0].mega=null;assert.throws(()=>buildObservedPosition(unknown),/Mega-use history for p2/);
  unknown.hypotheses.sideMegaUsed={};assert.throws(()=>buildObservedPosition(unknown),/Mega-use history for p1/);
  const legacy=currentFixture(),legacyBuilt=buildObservedPosition(legacy);assert.deepEqual(legacyBuilt.position.sides.map(side=>side.megaUsed),[false,false]);assert(legacyBuilt.provenance.megaUse.every(row=>row.source==='authored-hypothesis'));
});

test('a current Mega form does not contradict an explicit unspent resource without an actual Mega-use event',()=>{
  const input=currentFixture(),actor=input.observed.boards[0].sides[1].pokemon[0];
  actor.species='Raichu-Mega-Y';actor.ability='No Guard';actor.mega=null;
  input.hypotheses.opposing[actor.id].ability='No Guard';input.hypotheses.sideMegaUsed.p2=false;
  const built=buildObservedPosition(input);assert.equal(built.position.sides[1].megaUsed,false);
  assert.equal(built.provenance.megaUse[1].source,'authored-hypothesis');
  actor.mega=true;assert.throws(()=>buildObservedPosition(input),/false conflicts/u);
});
