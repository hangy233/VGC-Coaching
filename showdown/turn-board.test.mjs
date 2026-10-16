import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AgentSession} from './agent-session.mjs';
import {ShowdownClient} from './client.mjs';

const parent='game-bestof3-gen9championsvgc2026regmcbo3-51',room='battle-gen9championsvgc2026regmcbo3-52';
const own=(species,active=false,condition='100/100')=>({ident:`p2: ${species}`,details:`${species}, L50`,condition,active,item:'',ability:'Pressure'});
const six=[own('Golisopod',true),own('Hydreigon',true),own('Rillaboom'),own('Politoed'),own('Farigiraf'),own('Sylveon')];
const moves=[{move:'Leech Life',id:'leechlife',pp:16,maxpp:16,target:'normal',disabled:false},{move:'Protect',id:'protect',pp:16,maxpp:16,target:'self',disabled:false}];
async function fixture(){
  let time=1000;
  const packed='Species|item|ability|move',sent=[],client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';client.ws={send:line=>sent.push(line)};
  const session=new AgentSession(client,{username:'TofuRotom',packed,now:()=>time,controllerRequired:false});
  await session.execute({id:'start',op:'start',confirmed:true});
  client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Fixture'}})}`);
  client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  const receive=lines=>client.receive(`>${room}\n${lines}`);
  const request=(rqid,pokemon,extra={})=>receive(`|request|${JSON.stringify({rqid,side:{id:'p2',name:'TofuRotom',pokemon},...extra})}`);
  const preview=()=>{receive('|gen|9\n|gametype|doubles\n|teamsize|p1|4\n|teamsize|p2|4');request(1,six,{teamPreview:true,maxChosenTeamSize:4});};
  const party=()=>[own('Golisopod',true,'156/182 brn'),own('Farigiraf',true,'17/227'),own('Rillaboom',false,'70/200'),own('Politoed',false,'57/197')];
  const turn=()=>{receive('|start\n|switch|p1a: Rotom|Rotom-Wash, L50|60/100\n|switch|p1b: Incineroar|Incineroar, L50|44/100\n|switch|p2a: Golisopod|Golisopod, L50|156/182 brn\n|switch|p2b: Farigiraf|Farigiraf, L50|17/227\n|turn|1');request(2,party(),{active:[{moves,canMegaEvo:'Golisopod-Mega'},{moves,trapped:false}]});};
  return {client,session,sent,receive,request,preview,party,turn,tick:ms=>{time+=ms;}};
}

test('one compact turn read preserves fresh legal actions from preview through a named forced replacement',async()=>{
  const f=await fixture();try{
    f.preview();
    f.receive('|teamsize|p1|6\n|teamsize|p2|6');
    f.receive(`|showteam|p1|${['Rotom-Wash','Incineroar','Tyranitar','Excadrill','Sinistcha','Corviknight'].map(species=>`${species}||SitrusBerry|Levitate|Thunderbolt,WillOWisp,LightScreen,HydroPump|Bold|||||50|`).join(']')}`);
    const preview=f.session.turnSnapshot();
    assert.equal(preview.actions[0].kind,'preview');
    assert.equal(preview.boards[0].sides.find(s=>s.id==='p2').pokemon.length,6);
    assert.equal(preview.boards[0].sides.find(s=>s.id==='p2').selectionKnowledge,'preview-only');
    for(const side of preview.boards[0].sides){assert.equal(side.selectedTeamSize,null);assert.equal(side.unrevealedSelected,null);}
    assert.equal(preview.boards[0].opponentSheets.p1.length,6);
    assert.deepEqual(preview.boards[0].opponentSheets.p1[0].moves,['Thunderbolt','Will-O-Wisp','Light Screen','Hydro Pump']);
    for(const set of preview.boards[0].opponentSheets.p1){assert.equal(set.evs,undefined);assert.equal(set.ivs,undefined);assert.equal(set.level,50);}
    assert.equal(f.session.capabilities().features.compactTurnBoard,true);
    assert.equal(f.session.capabilities().features.deadlinePlanningRecovery,true);
    assert.equal((await f.session.execute({id:'preview-send',op:'choose',confirmed:true,token:preview.actions[0].token,actions:[{type:'team',order:[1,5,3,4]}]})).ok,true);
    assert.equal(f.session.turnSnapshot().boards[0].opponentSheets,undefined);
    f.receive('|teamsize|p1|4\n|teamsize|p2|4');f.turn();f.tick(500);
    const view=(await f.session.execute({id:'compact-read',op:'turn-status'})).result;
    const action=view.actions[0],board=view.boards[0],ours=board.sides.find(s=>s.id==='p2'),opponent=board.sides.find(s=>s.id==='p1');
    assert.equal(board.room,room);assert.equal(board.parentId,parent);assert.equal(board.requestAgeMs,500);
    assert.equal(board.opponentSheets,undefined);
    assert.equal(action.token,f.session.actions()[0].token);
    assert.deepEqual(action.legalActions.active[0],{moves,canMegaEvo:'Golisopod-Mega'});
    assert.deepEqual(ours.pokemon.map(p=>p.species),['Golisopod','Rillaboom','Politoed','Farigiraf']);
    assert.equal(ours.selectedTeamSize,4);assert.equal(ours.unrevealedSelected,0);
    assert.equal(ours.selectionKnowledge,'current-own-request');
    assert.equal(ours.reserves.length,2);assert.equal(opponent.pokemon.length,2);
    assert.equal(opponent.reserves.length,0);assert.equal(opponent.unrevealedSelected,2);
    assert.equal(opponent.selectionKnowledge,'observed-opponents-only');
    assert.equal(ours.pokemon.find(p=>p.species==='Golisopod').hp.precision,'server-own-exact');
    assert.equal(opponent.pokemon[0].hp.precision,'server-display');
    const forced=f.party();forced[0].condition='0 fnt';forced[1].condition='0 fnt';forced[2].condition='0 fnt';
    f.request(3,forced,{forceSwitch:[true,true]});
    const replacement=f.session.turnSnapshot(),next=replacement.actions[0];
    assert.equal(next.kind,'switch');assert.notEqual(next.token,action.token);
    assert.equal(replacement.boards[0].sides.find(s=>s.id==='p2').pokemon.length,4);
    const reserve=next.legalActions.replacements.find(p=>p.name==='Politoed');
    assert.equal(reserve.slot,4);assert.match(reserve.pokemonId,/^pokemon-/);
    assert(next.legalActions.replacementPairs.some(pair=>pair[0].slot===4&&pair[1].type==='pass'));
    const reply=await f.session.execute({id:'named-switch',op:'choose',confirmed:true,token:next.token,actions:[{type:'switch',pokemonId:reserve.pokemonId},{type:'pass'}]});
    assert.equal(reply.ok,true,reply.error);assert(f.sent.includes(`${room}|/choose switch 4, pass|3`));
  }finally{f.session.dispose();}
});

test('compact boards retain critical new state, duration uncertainty and bounded events without sheets or preview ghosts',async()=>{
  const f=await fixture();try{
    f.preview();
    f.receive(`|showteam|p1|PRIVATE-SHEET-${'long historical sheet '.repeat(500)}`);
    f.turn();
    f.receive('|-boost|p1a: Rotom|spa|2\n|-status|p2a: Golisopod|brn\n|-start|p2a: Golisopod|Disable|Leech Life\n|-enditem|p1a: Rotom|Sitrus Berry|[eat]\n|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Golisopod\n|-fieldstart|move: Trick Room|[of] p2b: Farigiraf\n|upkeep\n|turn|2');
    const view=f.session.turnSnapshot(),board=view.boards[0],rotom=board.sides.find(s=>s.id==='p1').pokemon[0],goli=board.sides.find(s=>s.id==='p2').pokemon.find(p=>p.species==='Golisopod');
    assert.equal(rotom.boosts.spa,2);assert.equal(rotom.item,null);assert.equal(rotom.itemKnown,true);
    assert.equal(rotom.itemHistory[0].item,'Sitrus Berry');assert.equal(goli.status,'brn');assert(goli.volatiles.disable);
    assert.equal(board.field.weather.name,'RainDance');assert.equal(board.field.conditions.trickroom.remainingTurns.min,4);
    assert(board.recentEvents.lines.some(line=>line.startsWith('|-weather|')));
    assert(board.recentEvents.lines.some(line=>line.includes('Sitrus Berry')));
    assert(!JSON.stringify(view).includes('PRIVATE-SHEET-'));assert.equal(board.sheets,undefined);
    // Unknown values stay unknown, rather than turning into zero investments or
    // a claim that no opposing reserves exist.
    const unseen=f.client.state(room).battle.sides.p1;unseen.teamSize=null;
    assert.equal(f.session.turnSnapshot().boards[0].sides.find(s=>s.id==='p1').unrevealedSelected,null);
    f.receive(Array.from({length:60},(_,i)=>`|-damage|p1a: Rotom|${99-i}/100`).join('\n'));
    const bounded=f.session.turnSnapshot().boards[0].recentEvents;
    assert.equal(bounded.lines.length,40);assert.equal(bounded.truncated,true);assert(bounded.available>40);
    assert.equal(bounded.omitted,bounded.available-40);assert.match(bounded.warning,/truncated/);
    assert(f.client.state(room).battleLog.length>bounded.lines.length);
  }finally{f.session.dispose();}
});

test('turn view keeps state while a successful send waits and excludes unowned or completed rooms',async()=>{
  const f=await fixture();try{
    f.preview();f.turn();const action=f.session.turnSnapshot().actions[0];
    const reply=await f.session.execute({id:'sent-pair',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:2},{type:'move',slot:2}]});
    assert.equal(reply.ok,true,reply.error);
    const waiting=f.session.turnSnapshot();assert.equal(waiting.actions.length,0);assert.equal(waiting.boards.length,1);assert.equal(waiting.choices[0].status,'sent');
    f.client.receive('>battle-gen9championsvgc2026regmcbo3-99\n|turn|1');
    assert.equal(f.session.turnSnapshot().boards.length,1);
    f.client.receive(`>${parent}\n|win|Opponent`);assert.equal(f.session.turnSnapshot().boards.length,0);
  }finally{f.session.dispose();}
});

test('control trace retains explicit deadline basis without leaking arbitrary payloads',async()=>{
  const f=await fixture();try{
    f.session.recordControlTrace({type:'watchdog-deadline-armed',room,rqid:2,revision:1,clockSource:'observed-server-clock',observedClockSource:'server-timer-observation',deadlineBasis:'verified-server-bank',planningDeadlineAt:31000,cutoffAt:31000,emergencyAt:50000,hardDeadlineAt:55000,turnDeadlineAt:60000,bankDeadlineAt:55000,unknownCutoffAt:31000,clockObservedAt:1000,timerDisabledAt:32000,recoveryStartedAt:31000,clockFreshForRequest:true,emergencyEligible:true,controlFailure:true,forfeited:false,retried:false,secret:'not-retained'});
    const entry=f.session.readControlTrace().entries.at(-1);
    assert.equal(entry.deadlineBasis,'verified-server-bank');assert.equal(entry.bankDeadlineAt,55000);
    assert.equal(entry.planningDeadlineAt,31000);assert.equal(entry.clockFreshForRequest,true);
    assert.equal(entry.timerDisabledAt,32000);
    assert.equal(entry.forfeited,false);assert.equal(entry.retried,false);assert.equal(entry.secret,undefined);
  }finally{f.session.dispose();}
});

test('compact turn status omits the supervisor history while retaining current deadline and recovery facts',async()=>{
  const f=await fixture();try{
    f.session.supervisor.configure({enabled:true,forfeitIfStuck:true});f.preview();f.turn();
    f.receive(`|showteam|p1|HISTORICAL-SHEET-${'large sheet '.repeat(1000)}`);
    for(let index=0;index<100;index++)f.session.supervisor.trace('historical-diagnostic',{diagnosticPayload:'HISTORY-MARKER'.repeat(100),index});
    assert.equal(f.session.supervisor.status().recentEvents.length,100);
    const view=f.session.turnSnapshot(),serialized=JSON.stringify(view);
    assert.equal(view.controlPolicy.recentEvents,undefined);assert(!serialized.includes('HISTORY-MARKER'));
    assert(!serialized.includes('HISTORICAL-SHEET'));assert.equal(view.controlPolicy.pending.length,1);
    assert.equal(view.controlPolicy.pending[0].rqid,2);assert(Number.isFinite(view.controlPolicy.pending[0].cutoffAt));
    assert.equal(view.actions[0].rqid,2);assert.equal(view.boards[0].turn,1);
    assert(Buffer.byteLength(serialized)<16000,'Compact output must not grow with retained diagnostic history or full sheets');
  }finally{f.session.dispose();}
});

test('actual timer-off protocol revokes a current countdown without inventing timer-off for a later request',async()=>{
  const f=await fixture();try{
    f.session.supervisor.configure({enabled:true,forfeitIfStuck:true,planningMs:1000,unknownClockMs:1000,safetyMarginMs:5000});
    f.preview();f.turn();
    assert.equal(f.session.turnSnapshot().actions[0].clock.source,'unavailable');
    f.receive('|inactive|Time left: 55 sec this turn | 80 sec total');
    const before=f.session.turnSnapshot().actions[0].clock;
    assert.equal(before.source,'server-timer-observation');assert.equal(before.bankDeadlineAt,81000);
    f.tick(1000);f.session.supervisor.onTimer();
    assert.equal(f.sent.some(line=>line.includes('/forfeit')),false);
    f.tick(1000);f.receive('|inactiveoff|Battle timer is OFF.');
    const disabled=f.session.turnSnapshot().actions[0].clock;
    assert.deepEqual(disabled,{source:'server-timer-disabled',observedAt:3000,deadlineAt:null,remainingMs:null,bankDeadlineAt:null,bankRemainingMs:null});
    const pending=f.session.supervisor.status().pending[0];
    assert.equal(pending.hardDeadlineAt,null);assert.equal(pending.emergencyAt,null);assert.equal(pending.timerDisabledAt,3000);
    f.tick(60000);f.session.supervisor.onTimer();
    assert.equal(f.sent.some(line=>line.includes('/forfeit')),false,'Old real countdown must not survive explicit timer-off');
    f.request(3,f.party(),{active:[{moves},{moves}]});
    assert.equal(f.session.turnSnapshot().actions[0].clock.source,'unavailable','Previous-request timer-off is not fresh clock evidence');
    f.tick(1);f.receive('|inactive|Time left: 55 sec this turn | 80 sec total');
    assert.equal(f.session.turnSnapshot().actions[0].clock.source,'server-timer-observation');
  }finally{f.session.dispose();}
});
