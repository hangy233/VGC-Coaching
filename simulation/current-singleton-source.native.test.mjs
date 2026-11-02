// Actual native requests in deterministic synthetic games, not a historical
// capture, live client, reconstruction world or model qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createChoiceStateHistory,assembleChoiceState} from './choice-state.mjs';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from '../showdown/battle-state.mjs';
import {compactTurnBoard} from '../showdown/turn-board.mjs';
import {choiceFixtureTeams,choiceFixtureSet as set,choiceFixtureRegistration,choiceFixtureSheet} from './choice-fixture.mjs';

const {Battle,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
const FORMAT='gen9championsvgc2026regmc',room='battle-gen9championsvgc2026regmcbo3-981724',sessionId='synthetic-singleton-source',token='d'.repeat(64),epoch=1;
const copy=structuredClone;

function fixture(kind,nativeSeed=[1,2,3,4]){
  const {p1,p2}=choiceFixtureTeams();
  if(kind==='recharge'){
    p1[4]=p1[3];
    p1[3]=set('beam','Sylveon','Pixilate','Fairy Feather',['Hyper Beam','Hyper Voice','Helping Hand','Protect']);
    p2[1].item='Focus Sash';
  }
  for(const party of [p1,p2])assert.equal(new TeamValidator(FORMAT).validateTeam(copy(party)),null,'native legal complete six');
  const {teamText,teamId}=choiceFixtureRegistration(p1),sheet=choiceFixtureSheet(p2);
  const tracker=createChoiceStateHistory({sessionId,room,teamId,epoch,teamText,opposingSheet:sheet}),state=createBattleState();
  const battle=new Battle({formatid:FORMAT,seed:nativeSeed,p1:{name:'Synthetic owner',team:p1},p2:{name:'Synthetic foe',team:p2}});
  let sequence=0,lastLine=0,rqid=0,request;const lines=[];
  const meta=()=>({sequence:++sequence,epoch,connected:true,observedAt:200000+sequence});
  function receive(){
    const native=extractChannelMessages(battle.log.join('\n'),[1])[1];
    for(const line of native.slice(lastLine)){const m=meta();tracker.observeLine(line,m);reduceBattleLine(state,line,{...m,now:m.observedAt});lines.push(line);}lastLine=native.length;
    if(battle.p1.activeRequest){request=copy({...battle.p1.activeRequest,rqid:++rqid});const m=meta();tracker.observeRequest(request,m);reduceBattleRequest(state,request,{...m,now:m.observedAt});}
  }
  function choose(p1,p2){assert.equal(battle.choose('p1',p1),true,battle.p1.choice.error);assert.equal(battle.choose('p2',p2),true,battle.p2.choice.error);receive();}
  function source(){const board={...compactTurnBoard(battleStateSnapshot(state),{request,events:lines}),room};return {observed:{sessionId,teamSha256:teamId,revision:sequence,connected:true,authenticated:true,actions:[{kind:'turn',room,rqid:request.rqid,token,actionable:true,legalActions:{teamPreview:!!request.teamPreview,forceSwitch:request.forceSwitch??null,active:request.active??[],pokemon:request.side.pokemon}}],boards:[board],opponentSheets:{p2:copy(sheet)}},expected:{room,rqid:request.rqid,token,teamId},opposingSheet:copy(sheet)};}
  receive();choose('team 4312','team 1234');
  assert.equal(battle.field.weather,'','Electro Shot must really charge outside rain');
  choose(kind==='recharge'?'move 1 2, move 4':'move 4 2, move 4','move 4, move 2 -1');
  return {battle,tracker,source,request};
}

for(const kind of ['electroshot','recharge'])test(`source capture accepts the genuine native ${kind} singleton and refuses fresh menu drift`,()=>{
  let f;
  // Hyper Beam can genuinely miss. Select a deterministic native history that
  // actually produced recharge, never synthesize the volatile/request row.
  for(let n=1;n<=16;n++){
    const candidate=fixture(kind,[n,2,3,4]);
    if(candidate.battle.requestState==='move'&&candidate.request.active?.[0]?.moves?.length===1&&candidate.request.active[0].moves[0].id===kind){f=candidate;break;}
    candidate.battle.destroy();
  }
  assert(f,`native ${kind} must genuinely expose its forced next-turn menu`);
  try{
    const source=f.source(),legal=source.observed.actions[0].legalActions;
    assert.equal(legal.active[0].moves.length,1);
    assert.equal(legal.active[1].moves.length,4,'the partner retains its ordinary complete menu');
    assert.equal(legal.pokemon.length,4);
    assert(legal.pokemon.every(p=>p.moves.length===4),'selected party move identities remain complete despite the active lock');
    assert.equal(legal.active[0].moves[0].id,kind);
    assert.equal(Object.hasOwn(legal.active[0].moves[0],'pp'),false,'native locked row really omits PP');
    assert.equal(Object.hasOwn(legal.active[0].moves[0],'target'),false,'native locked row really omits chosen-target metadata');
    const receipt=f.tracker.capture(source),assembly=assembleChoiceState(receipt);
    assert.equal(assembly.binding.rqid,source.expected.rqid);
    assert.equal(assembly.facts.nativeHistory.completeHistory,true);

    const rejects=(label,mutate)=>{const changed=copy(source);mutate(changed.observed.actions[0].legalActions);assert.throws(()=>f.tracker.capture(changed),/private .*source changed/u,label);};
    rejects('changed singleton identity',l=>l.active[0].moves[0].id='protect');
    rejects('empty active menu',l=>l.active[0].moves=[]);
    rejects('extra singleton row',l=>l.active[0].moves.push(copy(l.active[0].moves[0])));
    for(const [key,value]of Object.entries({pp:0,maxpp:1,disabled:false,target:'normal'})){
      rejects(`singleton ${key} presence`,l=>{l.active[0].moves[0][key]=value;});
    }
    const normal=legal.active[1].moves[0];
    for(const key of ['pp','maxpp','disabled','target']){
      assert(Object.hasOwn(normal,key),`ordinary native row supplies ${key}`);
      rejects(`ordinary ${key} omission`,l=>{delete l.active[1].moves[0][key];});
      rejects(`ordinary ${key} value`,l=>{l.active[1].moves[0][key]=typeof normal[key]==='boolean'?!normal[key]:typeof normal[key]==='number'?normal[key]+1:'self';});
    }
    rejects('party still requires four move identities',l=>{l.pokemon[0].moves.pop();});
    assert.doesNotThrow(()=>assembleChoiceState(f.tracker.capture(source)),'refused mutations do not poison the unchanged fresh source');
  }finally{f.battle.destroy();}
});
