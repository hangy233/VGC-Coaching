// Genuine synthetic local native history shared by scalar integration tests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createChoiceStateHistory,assembleChoiceState} from './choice-state.mjs';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {choiceFixtureTeams,choiceFixtureRegistration,choiceFixtureSheet} from './choice-fixture.mjs';
const {Battle,Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const copy=value=>JSON.parse(JSON.stringify(value));
export const spreadFixtureRoom='battle-gen9championsvgc2026regmcbo3-818',spreadFixtureSession='synthetic-spread-history';
export function createNativeSpreadHistory(){
  const room=spreadFixtureRoom,sessionId=spreadFixtureSession,token='a'.repeat(64),epoch=1;
  const teams=choiceFixtureTeams();teams.p1[1].nature='Sassy';
  const {teamText,teamId}=choiceFixtureRegistration(teams.p1),sheet=choiceFixtureSheet(teams.p2),ownTeam=Teams.import(teamText);new TeamValidator('gen9championsvgc2026regmc').validateTeam(ownTeam);
  const tracker=createChoiceStateHistory({sessionId,room,teamId,epoch,teamText,opposingSheet:sheet}),state=createBattleState(),battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Owner',team:teams.p1},p2:{name:'Foe',team:teams.p2}});
  let sequence=0,last=0,rqid=0,request;const lines=[];
  const meta=()=>({sequence:++sequence,epoch,connected:true,observedAt:10000+sequence});
  const receive=()=>{
    const native=extractChannelMessages(battle.log.join('\n'),[1])[1];
    for(const line of native.slice(last)){const m=meta();tracker.observeLine(line,m);reduceBattleLine(state,line,{...m,now:m.observedAt});lines.push(line);}last=native.length;
    if(battle.p1.activeRequest){request=copy({...battle.p1.activeRequest,rqid:++rqid});const m=meta();tracker.observeRequest(request,m);reduceBattleRequest(state,request,{...m,now:m.observedAt});}
  };
  const choose=(p1,p2)=>{assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);receive();};
  receive();choose('team 1234','team 1234');choose('move 3 2, move 1 2','move 4, move 1 1');
  const board={...compactTurnBoard(battleStateSnapshot(state),{request,events:lines}),room};
  const source={observed:{sessionId,teamSha256:teamId,revision:sequence,actions:[{kind:'turn',room,rqid:request.rqid,token,actionable:true,legalActions:{teamPreview:!!request.teamPreview,forceSwitch:request.forceSwitch??null,active:request.active??[],pokemon:request.side.pokemon}}],boards:[board],opponentSheets:{p2:copy(sheet)}},expected:{room,rqid:request.rqid,token,teamId},opposingSheet:copy(sheet)};
  const assembly=assembleChoiceState(tracker.capture(source)),journal=tracker.journalSnapshot(),currentActors=assembly.facts.actors.map(p=>({...p,historyId:p.id}));
  return {battle,tracker,assembly,journal,sheet,input:{journal,binding:assembly.binding,currentActors,ownTeam:copy(ownTeam)}};
}
