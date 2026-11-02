// Synthetic offline native histories. Unrelated state is captured from the
// reference engine to isolate public last-move assembly/hydration; this is not
// reconstruction of a private live position or model/MCP qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createChoiceStateHistory,assembleChoiceState} from './choice-state.mjs';
import {applyKnownNativeHistory} from './history-state.mjs';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {choiceFixtureTeams,choiceFixtureSet as set,choiceFixtureRegistration,choiceFixtureSheet} from './choice-fixture.mjs';

const {Battle,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',seed=[1,2,3,4];
const room='battle-gen9championsvgc2026regmcbo3-981723',sessionId='synthetic-instruct-history',token='c'.repeat(64),epoch=1;
const choose=(battle,p1,p2)=>{assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);};
const move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});

function fixture(unsafeTaunt){
  const {p1,p2}=choiceFixtureTeams();
  p1[0]=set('amph','Ampharos','Plus','Magnet',['Magnetic Flux','Charge','Thunderbolt','Protect']);
  p1[1]=set('guru','Oranguru','Inner Focus','Sitrus Berry',['Instruct','Taunt','Calm Mind','Protect']);
  // No offensive actions are required to establish or test the history.
  p2[0]=set('foe-fari','Farigiraf','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect']);
  p2[1]=set('rai','Raichu','Lightning Rod','Raichunite Y',['Thunderbolt','Helping Hand','Fake Out','Protect']);
  for(const party of [p1,p2])assert.equal(new TeamValidator(FORMAT).validateTeam(structuredClone(party)),null,'genuine legal native fixture');
  const {teamText,teamId}=choiceFixtureRegistration(p1),sheet=choiceFixtureSheet(p2);
  const history=createChoiceStateHistory({sessionId,room,teamId,epoch,teamText,opposingSheet:sheet}),state=createBattleState();
  const battle=new Battle({formatid:FORMAT,seed,p1:{name:'Reference owner',team:p1},p2:{name:'Reference foe',team:p2}});
  let sequence=0,lastLine=0,rqid=0,request;const lines=[];
  const meta=()=>({sequence:++sequence,epoch,connected:true,observedAt:100000+sequence});
  function receive(){
    const ownLines=extractChannelMessages(battle.log.join('\n'),[1])[1];
    for(const line of ownLines.slice(lastLine)){const m=meta();history.observeLine(line,m);reduceBattleLine(state,line,{...m,now:m.observedAt});lines.push(line);}lastLine=ownLines.length;
    if(battle.p1.activeRequest){request=structuredClone({...battle.p1.activeRequest,rqid:++rqid});const m=meta();history.observeRequest(request,m);reduceBattleRequest(state,request,{...m,now:m.observedAt});}
  }
  receive();choose(battle,'team 1234','team 1234');receive();
  const first=battle.log.length;
  choose(battle,`move 1, ${unsafeTaunt?'move 2 1':'move 3'}`,'move 2 -2, move 2 -1');receive();
  assert(battle.log.slice(first).some(line=>line.includes('|Magnetic Flux|')));
  if(unsafeTaunt)assert(battle.log.slice(first).some(line=>line.includes('|-start|p2a: foe-fari|move: Taunt')),'actual native Taunt establishes legacy unsafe history');
  // Remove the Taunt volatile through a real switch, then observe a later
  // ordinary Flux. The old aggregate history flag cannot recover here.
  choose(battle,'move 1, move 4','switch 3, move 2 -1');receive();
  assert.equal(battle.p1.active[0].lastMove.id,'magneticflux');
  assert.equal(battle.p2.pokemon.find(p=>p.name==='foe-fari').volatiles.taunt,undefined);
  const board={...compactTurnBoard(battleStateSnapshot(state),{request,events:lines}),room};
  const source={observed:{sessionId,teamSha256:teamId,revision:sequence,connected:true,authenticated:true,actions:[{kind:'turn',room,rqid:request.rqid,token,actionable:true,legalActions:{teamPreview:false,forceSwitch:request.forceSwitch??null,active:request.active,pokemon:request.side.pokemon}}],boards:[board],opponentSheets:{p2:structuredClone(sheet)}},expected:{room,rqid:request.rqid,token,teamId},opposingSheet:sheet};
  return {battle,board,assembly:assembleChoiceState(history.capture(source))};
}

function oraclePosition(f){
  const b=f.battle,ids=new Map();
  for(const side of b.sides)for(const p of side.pokemon){const source=f.board.sides.find(s=>s.id===side.id).pokemon.find(row=>row.nickname===p.name);ids.set(p,source?.id??`synthetic-hidden-${side.id}-${p.name}`);}
  const field={};for(const key of ['weather','terrain'])if(b.field[key])field[key]={id:b.field[key],remainingTurns:b.field[key+'State'].duration};
  const position={mode:'current',turn:b.turn,ownSide:'p1',field,nativeState:{lastMove:b.lastMove?.id??false},sides:b.sides.map(side=>({id:side.id,active:side.active.map(p=>ids.get(p)),megaUsed:false,conditions:{},nativeState:{totalFainted:side.totalFainted},pokemon:side.pokemon.map(p=>({
    id:ids.get(p),species:p.species.name,ability:p.getAbility().name,item:p.item,nature:p.set.nature,statPoints:{...p.set.evs},moves:p.moveSlots.map(m=>m.move),hp:p.hp,status:p.status,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp),
    lifecycle:{activeTurns:p.activeTurns,activeMoveActions:p.activeMoveActions,protectCounter:p.volatiles.stall?.counter??0,choiceLock:p.volatiles.choicelock?.move??false,lastMove:p.name==='amph'?false:p.lastMove?.name??false},volatiles:{},
    nativeState:{baseAbility:p.baseAbility,timesAttacked:p.timesAttacked,...(p.lastMoveTargetLoc===undefined?{}:{lastMoveTargetLoc:p.lastMoveTargetLoc}),...(p.moveLastTurnResult===undefined?{}:{moveLastTurnResult:p.moveLastTurnResult})},
  }))}))};
  const amphId=ids.get(b.p1.active[0]);
  position.stateAssumptions=[{path:`p1.${amphId}.lifecycle.lastMove`,reason:'Missing legacy lifecycle fragment uses a false initial-state hypothesis.',selected:false},{path:'fixture.other-native-fields',reason:'Other fields are synthetic native-oracle inputs, not claims of public reconstruction.'}];
  return {position,ids,amphId};
}
function normalized(lines,names){return extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>/^\|t:\|\d+$/u.test(line)?'|t:|<epoch>':line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)));}
function finalView(sides){return sides.map(side=>({id:side.id,active:side.active,pokemon:side.pokemon.map(p=>({id:p.id,hp:p.hp,boosts:p.boosts,pp:p.pp}))}));}

for(const unsafeTaunt of [false,true])test(`observed Magnetic Flux supports native Instruct continuation ${unsafeTaunt?'after unrelated unsafe Taunt':'with ordinary history'}`,()=>{
  const f=fixture(unsafeTaunt);
  try{
    const {position,ids,amphId}=oraclePosition(f),before=structuredClone(position);
    if(unsafeTaunt){assert.equal(f.assembly.coverage.auditedHistory,false);assert.equal(f.assembly.hypotheses.own[amphId].lifecycle,undefined,'legacy aggregate lifecycle is genuinely unavailable');}
    assert.equal(f.assembly.facts.nativeHistory.pokemon[amphId].lastMove,'Magnetic Flux','last move is independently assembled from actual native receives');
    const built=applyKnownNativeHistory({position,provenance:{approximate:true}},f.assembly);
    assert.deepEqual(position,before,'history hydration does not mutate its source');
    assert.equal(built.position.sides[0].pokemon.find(p=>p.id===amphId).lifecycle.lastMove,'Magnetic Flux');
    assert.equal(built.position.stateAssumptions.some(a=>a.path===`p1.${amphId}.lifecycle.lastMove`),false);
    assert(built.position.stateAssumptions.some(a=>a.path==='fixture.other-native-fields'),'unrelated assumptions remain');
    const branch={id:'instruct-last-move',ourActions:[move(2),move(1,-1)],opposingActions:[move(4),move(2,-1)],gate:{kind:'delivery',requiredActionsBy:[amphId]}};
    const input={position:built.position,branches:[branch],seeds:[seed],hypotheses:['Synthetic native oracle fields isolate independently observed last-move history.']};
    const sample=simulateNativeTurn(input).samples[0];
    // Reseed the reference to the same native-constructor continuation RNG.
    const teams=Object.fromEntries(built.position.sides.map(side=>[side.id,side.pokemon.map(p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
    const constructor=new Battle({formatid:FORMAT,seed,p1:{name:'Seed owner',team:teams.p1},p2:{name:'Seed foe',team:teams.p2}});
    f.battle.prng.setSeed(constructor.prng.getSeed());constructor.destroy();
    const logStart=f.battle.log.length;
    choose(f.battle,validateChoice(f.battle.p1.activeRequest,branch.ourActions).choice,validateChoice(f.battle.p2.activeRequest,branch.opposingActions).choice);
    const simNames=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id]))),refNames=new Map([...ids].map(([p,id])=>[p.name,id]));
    assert.deepEqual(normalized(sample.events.map(e=>e.raw),simNames),normalized(f.battle.log.slice(logStart),refNames),'actual repeated native move and all continuation events match');
    const moves=sample.events.filter(e=>e.type==='move'&&e.actorId===amphId).map(e=>e.move);
    assert.deepEqual(moves,['Magnetic Flux','Charge'],'Instruct repeats the prior move before the authored new move, not after it');
    assert.deepEqual(finalView(sample.final.sides),finalView(f.battle.sides.map(side=>({id:side.id,active:side.active.map(p=>ids.get(p)),pokemon:side.pokemon.map(p=>({id:ids.get(p),hp:p.hp,boosts:{...p.boosts},pp:p.moveSlots.map(m=>m.pp)}))}))),'every actor HP/boost/PP matches independent native continuation');
    assert.equal(sample.gate.passed,false,'synthetic oracle assumptions establish no unqualified material proof');
  }finally{f.battle.destroy();}
});
