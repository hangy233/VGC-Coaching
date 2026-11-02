// Genuine native Mega history over synthetic legal teams. The source bridge is
// injected in memory: no authenticated client, SDK, network or live authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createChoiceStateHistory,assembleChoiceState} from './choice-state.mjs';
import {executeSimulationChoices} from './choice-simulation.mjs';
import {registerSimulationTools} from './mcp-tools.mjs';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {choiceFixtureTeams,choiceFixtureSet as set,choiceFixtureRegistration,choiceFixtureSheet} from './choice-fixture.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {digest} from '../planning/identity.mjs';
import {createPlanningToolClient} from '../planning/tool-client.mjs';
import {createResearchBudgetToolClient} from '../planning/research-budget.mjs';
const {Battle,Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',room='battle-gen9championsvgc2026regmcbo3-981725',sessionId='synthetic-registered-predecessor',token='e'.repeat(64),epoch=1;
const copy=structuredClone,move=(slot,target)=>({type:'move',slot,...(target===undefined?{}:{target})});

function fixture(){
  const {p1,p2}=choiceFixtureTeams();
  p2[0]=set('eternal','Floette-Eternal','Flower Veil','Floettite',['Moonblast','Calm Mind','Protect','Energy Ball']);
  p2[1]=set('partner','Raichu','Lightning Rod','Magnet',['Thunderbolt','Helping Hand','Fake Out','Protect']);
  for(const team of [p1,p2])assert.equal(new TeamValidator(FORMAT).validateTeam(copy(team)),null);
  const {teamText,teamId}=choiceFixtureRegistration(p1),sheet=choiceFixtureSheet(p2),state=createBattleState();
  const history=createChoiceStateHistory({sessionId,room,teamId,epoch,teamText,opposingSheet:sheet});
  const battle=new Battle({formatid:FORMAT,seed:[1,2,3,4],p1:{name:'Synthetic owner',team:p1},p2:{name:'Synthetic foe',team:p2}});
  let sequence=0,lastLine=0,rqid=0,request;const lines=[];
  const meta=()=>({sequence:++sequence,epoch,connected:true,observedAt:100000+sequence});
  const receive=()=>{const native=extractChannelMessages(battle.log.join('\n'),[1])[1];for(const line of native.slice(lastLine)){const m=meta();history.observeLine(line,m);reduceBattleLine(state,line,{...m,now:m.observedAt});lines.push(line);}lastLine=native.length;if(battle.p1.activeRequest){request=copy({...battle.p1.activeRequest,rqid:++rqid});const m=meta();history.observeRequest(request,m);reduceBattleRequest(state,request,{...m,now:m.observedAt});}};
  const choose=(a,b)=>{assert.equal(battle.choose('p1',a),true,battle.p1.choice.error);assert.equal(battle.choose('p2',b),true,battle.p2.choice.error);receive();};
  receive();choose('team 1234','team 1234');choose('move 4, move 2 -1','move 3 mega, move 4');
  assert.equal(battle.p2.active[0].species.name,'Floette-Mega');
  assert(battle.log.some(line=>line.startsWith('|detailschange|p2a: eternal|Floette-Mega')));
  assert(battle.log.some(line=>line.startsWith('|-mega|p2a: eternal|Floette|Floettite')));
  const board={...compactTurnBoard(battleStateSnapshot(state),{request,events:lines}),room};
  const observed={sessionId,teamSha256:teamId,revision:sequence,connected:true,authenticated:true,actions:[{kind:'turn',room,rqid:request.rqid,token,actionable:true,legalActions:{teamPreview:false,forceSwitch:null,active:request.active,pokemon:request.side.pokemon}}],boards:[board],opponentSheets:{p2:copy(sheet)}};
  const source={sessionId,teamId,room,rqid:request.rqid,token},assembly=assembleChoiceState(history.capture({observed,expected:{teamId,room,rqid:request.rqid,token},opposingSheet:sheet}));
  const context={kind:'owned-simulation-context-v1',source,observed,opposingSheet:sheet,assembly,semanticSha256:digest({observed,assembly}),liveFreshness:true,choiceAuthority:false,frozenAt:Date.now()};
  return {battle,board,source,context,teamText,choose};
}
const normalize=(lines,names)=>extractChannelMessages(lines.join('\n'),[-1])[-1].map(line=>/^\|t:\|\d+$/u.test(line)?'|t:|<epoch>':line.replace(/(p[12][ab]?: )([^|]+)/gu,(_all,prefix,name)=>prefix+(names.get(name)??name)));

test('genuine Eternal-to-Mega Floette source reaches the native facade with unchanged authored actions',async()=>{
  const f=fixture();
  try{
    const registered=f.context.opposingSheet.find(p=>p.species==='Floette-Eternal'),current=f.board.sides[1].pokemon.find(p=>p.species==='Floette-Mega');
    assert(registered);assert(current);assert.equal(current.mega,true);assert.equal(current.ability,'Fairy Aura');
    assert.equal(f.context.assembly.coverage.completeHistory,true);
    const args={source:f.source,ourActions:[move(4),move(2,-1)],opposingActions:[move(2),move(4)],evidenceContext:{teamId:f.source.teamId,roomId:canonicalEvidenceRoom(room),turn:f.board.turn}},before=copy(args),calls=[],evidence=[];
    const native=createResearchBudgetToolClient(createPlanningToolClient({registerTool(){}}),{workspace:'synthetic-registered-predecessor-only',descriptorExists:()=>false});
    registerSimulationTools(native,{run:simulateNativeTurn});
    const result=await executeSimulationChoices(args,{workspace:'synthetic-registered-predecessor-only',loadTeam:async()=>({team:Teams.import(f.teamText)}),
      call:async()=>({ok:true,result:copy(f.context)}),
      callTool:async(name,input,options)=>{assert.equal(name,'simulate_turn','live-style cache-only inference dispatches no extra numerics');calls.push(copy(input));return native.callTool(name,input,options);},
      recordEvidence:async record=>{evidence.push(copy(record));return {tool:'simulate_choices',teamId:f.source.teamId,sha256:digest(record)};}});
    assert.equal(result.kind,'native-choice-outcome-v1',result.reason);assert.deepEqual(args,before);assert.equal(calls.length,1);assert.equal(evidence.length,1);
    const position=calls[0].request.position,mega=position.sides[1].pokemon.find(p=>p.id===current.id);
    assert.equal(mega.species,'Floette-Mega');assert.deepEqual(mega.moves,registered.moves);assert.equal(mega.ability,'Fairy Aura');assert.equal(mega.item,'Floettite');
    const sample=evidence[0].result.nativeResults[0].samples[0],simNames=new Map(sample.start.sides.flatMap(side=>side.pokemon.map((p,index)=>[`sim-${side.id}-${index}`,p.id]))),refNames=new Map(f.board.sides.flatMap(side=>side.pokemon.map(p=>[p.nickname,p.id])));
    // Equal native-constructor continuation RNG; no manually calculated stats,
    // damage or order. Unseen opposing reserves remain facade hypotheses.
    const teams=Object.fromEntries(position.sides.map(side=>[side.id,side.pokemon.map(p=>({name:p.id,species:p.species,ability:p.ability,item:p.item,moves:p.moves,nature:p.nature,evs:p.statPoints,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},level:50}))]));
    const constructor=new Battle({formatid:FORMAT,seed:calls[0].request.seeds[0],p1:{name:'Seed owner',team:teams.p1},p2:{name:'Seed foe',team:teams.p2}});f.battle.prng.setSeed(constructor.prng.getSeed());constructor.destroy();
    const logStart=f.battle.log.length;
    f.choose(validateChoice(f.battle.p1.activeRequest,args.ourActions).choice,validateChoice(f.battle.p2.activeRequest,args.opposingActions).choice);
    assert.deepEqual(normalize(sample.events.map(e=>e.raw),simNames),normalize(f.battle.log.slice(logStart),refNames),'native continuation events match after the actual Mega transformation');
    const final=sample.final.sides[1].pokemon.find(p=>p.id===current.id),reference=f.battle.p2.active[0];
    assert.deepEqual(final.boosts,{...reference.boosts});assert.deepEqual(final.pp,reference.moveSlots.map(m=>m.pp));
    assert(sample.events.some(e=>e.type==='move'&&e.actorId===current.id&&e.move==='Calm Mind'));
    assert.equal(result.source.choiceAuthority,false);assert.equal(result.coverage.tacticalGoalEvaluated,false);
  }finally{f.battle.destroy();}
});
