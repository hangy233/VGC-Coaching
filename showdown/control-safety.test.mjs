import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';

const parent='game-bestof3-gen9championsvgc2026regmcbo3-2699553708',room='battle-gen9championsvgc2026regmcbo3-2699559550';
const pair=[{type:'move',slot:1},{type:'move',slot:1}];
function clock(){
  let time=1000,next=0;const timers=new Map();
  return {now:()=>time,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{at:time+ms,fn});return id;},clearTimer:id=>timers.delete(id),advance(ms){const end=time+ms;let count=0;for(;;){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;if(++count>100)throw new Error('Timer loop');time=due[1].at;timers.delete(due[0]);due[1].fn();}time=end;},timers};
}
async function fixture({forfeitIfStuck=true,enabled=true}={}){
  const timer=clock(),packed='Species|item|ability|move',sent=[],client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:timer.now});
  client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';client.searchState={searching:[],games:{}};
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'TofuRotom',packed,authorizedSets:2,now:timer.now,monotonicNow:timer.now,controlTimers:{setTimer:timer.setTimer,clearTimer:timer.clearTimer}});
  let id=0;
  const raw=command=>session.execute({id:`cmd-${++id}`,confirmed:true,...command});
  const claimed=await raw({op:'control-claim',controllerId:'operator'});assert.equal(claimed.ok,true);
  const lease=claimed.result.controllerLease;
  const execute=command=>raw({controllerLease:lease,...command});
  const configured=await execute({op:'set-control-policy',enabled,forfeitIfStuck});assert.equal(configured.ok,true,configured.error);
  const start=()=>execute({op:'start'});
  const own=()=>{client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'TofuRotom vs Opponent'}})}`);client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);};
  const request=(extra={})=>client.receive(`>${room}\n|request|${JSON.stringify({rqid:31,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p2',name:'TofuRotom',pokemon:[{ident:'p2: Farigiraf',details:'Farigiraf, L50',active:true,condition:'17/227'},{ident:'p2: Golisopod',details:'Golisopod-Mega, L50',active:true,condition:'83/182'},{ident:'p2: Rillaboom',details:'Rillaboom, L50',active:false,condition:'0 fnt'},{ident:'p2: Hydreigon',details:'Hydreigon, L50',active:false,condition:'88/168'}]},...extra})}`);
  return {timer,client,session,sent,lease,raw,execute,start,own,request};
}
test('production requires a lease and enabled policy before any search; status never leaks lease',async()=>{
  const f=await fixture({enabled:false});try{
    assert.equal((await f.raw({op:'start'})).ok,false);
    assert.match((await f.start()).error,/Enable.*policy/);
    for(const result of [f.session.snapshot(),f.session.turnSnapshot(),f.session.readControlTrace()])assert(!JSON.stringify(result).includes(f.lease));
    assert.equal((await f.execute({op:'set-control-policy',enabled:true,forfeitIfStuck:true,safetyMarginMs:999})).ok,false);
    assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
});
test('S6 rqid31: staged pair submits during operator silence, acknowledgment prevents containment',async()=>{
  const f=await fixture();try{
    assert.equal((await f.start()).ok,true);f.own();f.request();const action=f.session.actions()[0];
    assert.equal((await f.execute({op:'stage-fallback',token:action.token,actions:pair})).ok,true);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);
    f.timer.advance(20000);assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);
    assert.equal(f.session.actions().length,0);assert.equal(f.session.actions({includePending:true})[0].submissionStatus,'sent');
    f.client.receive(`>${room}\n|sentchoice|move 1, move 1`);f.timer.advance(10000);
    assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
    assert(f.session.controlTrace.some(entry=>entry.type==='fallback-sent'));
    assert(f.session.controlTrace.some(entry=>entry.type==='accepted'));
  }finally{f.session.dispose();}
});
test('fresh-request planning silence recovers before a verified server emergency permits containment',async()=>{
  for(const rqid of [6,31]){
    const f=await fixture();try{
      await f.start();f.own();f.request({rqid});f.client.receive(`>${room}\n|inactive|Time left: 55 sec this turn | 300 sec total`);f.timer.advance(20000);
      assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);
      assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);assert.equal(f.session.supervisor.status().pending[0].recovering,true);
      f.timer.advance(30000);
      assert.deepEqual(f.sent.filter(line=>line.includes('/forfeit')),[`${parent}|/forfeit`]);
      assert.equal(f.session.supervisor.status().halted,true);
      f.client.receive(`>${room}\n|win|Opponent\n>${parent}\n|win|Opponent`);f.client.receive('|updatesearch|{"searching":[],"games":null}');
      assert.match((await f.start()).error,/halted/);
      assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);
    }finally{f.session.dispose();}
  }
});
test('S6 rqid33: sole living reserve resolves by identity to slot4 with a legal forced pass',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();
    const current=structuredClone(f.client.state(room).request);delete current.active;current.rqid=33;current.forceSwitch=[true,true];current.side.pokemon[0].condition='0 fnt';current.side.pokemon[1].condition='0 fnt';f.request(current);
    const action=f.session.actions()[0],reserve=action.legalActions.replacements.find(value=>value.name==='Hydreigon');
    assert.equal(reserve.slot,4);assert(action.legalActions.replacementPairs.some(value=>value[0].slot===4&&value[1].type==='pass'));
    const result=await f.execute({op:'choose',token:action.token,actions:[{type:'switch',pokemonId:reserve.pokemonId},{type:'pass'}]});assert.equal(result.ok,true,result.error);
    assert(f.sent.includes(`${room}|/choose switch 4, pass|33`));
  }finally{f.session.dispose();}
});
test('takeover revokes the old lease while missing-plan recovery still permits a fresh staged pair',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();const action=f.session.actions()[0];await f.execute({op:'stage-fallback',token:action.token,actions:pair});f.timer.advance(5000);
    assert.equal((await f.raw({op:'control-claim',controllerId:'recovery',takeover:true,expectedGeneration:0})).ok,false);
    const takeover=await f.raw({op:'control-claim',controllerId:'recovery',takeover:true,expectedGeneration:1});assert.equal(takeover.ok,true);
    assert.equal((await f.execute({op:'choose',token:action.token,actions:pair})).ok,false);
    assert.equal(f.session.supervisor.status().pending[0].hasFallback,false);
    f.timer.advance(15000);assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);assert.equal(f.session.supervisor.status().halted,true);
    assert.equal((await f.raw({op:'stage-fallback',controllerLease:takeover.result.controllerLease,token:action.token,actions:pair})).ok,true);f.timer.advance(0);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
  }finally{f.session.dispose();}
});
test('uncertain socket write halts future search without forfeiting a possibly delivered choice',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();const action=f.session.actions()[0],send=f.client.ws.send;
    f.client.ws.send=line=>{send(line);if(line.includes('/choose'))throw new Error('Synthetic uncertain socket write');};
    const command={id:'uncertain-once',op:'choose',token:action.token,actions:pair};assert.equal((await f.execute(command)).ok,false);assert.equal((await f.execute(command)).ok,false);
    assert.equal(f.session.actions({includePending:true})[0].submissionStatus,'uncertain');f.timer.advance(5000);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);assert.equal(f.session.supervisor.status().halted,true);
    assert(f.session.controlTrace.some(entry=>entry.type==='watchdog-uncertain'));
    f.client.ws.send=send;f.request({rqid:33});const fresh=f.session.actions()[0];
    assert.equal((await f.execute({op:'stage-fallback',token:fresh.token,actions:pair})).ok,true);
    assert.equal((await f.execute({op:'choose',token:fresh.token,actions:pair})).ok,true);
    f.timer.advance(90000);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
  }finally{f.session.dispose();}
});
test('ordinary Showdown preview send can wait for the opponent without a live acknowledgment',async()=>{
  const f=await fixture();try{
    await f.start();f.own();const side={id:'p2',name:'TofuRotom',pokemon:['Farigiraf','Golisopod','Rillaboom','Hydreigon'].map(name=>({ident:`p2: ${name}`,details:`${name}, L50`,condition:'100/100',active:false}))};
    f.request({rqid:3,active:undefined,teamPreview:true,maxChosenTeamSize:4,side});
    const action=f.session.actions()[0],choice=[{type:'team',order:[4,1,2,3]}];f.timer.advance(12000);
    await f.execute({op:'stage-fallback',token:action.token,actions:choice});assert.equal((await f.execute({op:'choose',token:action.token,actions:choice})).ok,true);
    // The real server's ordinary choose() stores a choice without sending
    // |sentchoice|; that acknowledgment is part of its onConnect() resync.
    f.timer.advance(95000);
    assert.equal(f.client.state(room).lastAction.status,'sent');assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);assert.equal(f.session.supervisor.status().halted,false);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);
  }finally{f.session.dispose();}
});
test('observed resolution without sentchoice retires pending submission, including denied action',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();const action=f.session.actions()[0];await f.execute({op:'choose',token:action.token,actions:pair});
    f.client.receive(`>${room}\n|cant|p2a: Farigiraf|flinch`);
    assert.equal(f.client.state(room).lastAction.status,'resolution-observed');assert.equal(f.session.actions({includePending:true}).length,0);
    f.timer.advance(30000);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
  }finally{f.session.dispose();}
});
test('short total bank overrides turn clock and fresh request invalidates old fallback',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();let action=f.session.actions()[0];await f.execute({op:'stage-fallback',token:action.token,actions:pair});
    f.request({rqid:33});f.client.receive(`>${room}\n|inactive|Time left: 60 sec this turn | 8 sec total`);action=f.session.actions()[0];assert.equal(action.clock.bankRemainingMs,8000);
    f.timer.advance(3000);assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,1);
  }finally{f.session.dispose();}
});

test('actual timer protocol replaces a provisional unknown budget and preserves rescue after planning misses',async()=>{
  const f=await fixture();try{
    assert.equal((await f.execute({op:'set-control-policy',enabled:true,forfeitIfStuck:true,planningMs:30000,unknownClockMs:20000})).ok,true);
    await f.start();f.own();f.request();const action=f.session.actions()[0];assert.equal(action.clock.source,'unavailable');assert.equal(f.session.supervisor.status().pending[0].cutoffAt,21000);
    f.timer.advance(4000);f.client.receive(`>${room}\n|inactive|Time left: 90 sec this turn | 300 sec total`);
    const known=f.session.supervisor.status().pending[0];assert.equal(known.cutoffAt,31000);assert.equal(known.hardDeadlineAt,95000);assert.equal(known.clockObservedAt,5000);assert.equal(known.emergencyAt,90000);
    f.timer.advance(16000);assert.equal(f.session.supervisor.status().halted,false);f.timer.advance(10000);assert.equal(f.session.supervisor.status().halted,true);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
    f.timer.advance(10000);assert.equal((await f.execute({op:'stage-fallback',token:action.token,actions:pair})).ok,true);f.timer.advance(0);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);f.timer.advance(100000);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
    const recovery=f.session.readControlTrace().entries.find(event=>event.type==='watchdog-planning-recovery');assert.equal(recovery.planningDeadlineAt,31000);assert.equal(recovery.emergencyAt,90000);assert.equal(recovery.clockObservedAt,5000);assert.equal(recovery.controlFailure,true);
  }finally{f.session.dispose();}
});
test('command IDs cannot collide with different actions or reveal another command result',async()=>{
  const f=await fixture();try{
    await f.start();f.own();f.request();const action=f.session.actions()[0];
    const command={id:'same',op:'choose',token:action.token,actions:pair};assert.equal((await f.execute(command)).ok,true);
    assert.match((await f.execute({...command,actions:[{type:'switch',slot:3},{type:'pass'}]})).error,/different arguments/);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);
  }finally{f.session.dispose();}
});
test('release result is recoverable after lease revocation without granting another mutation',async()=>{
  const f=await fixture();try{
    const command={id:'release-once',op:'control-release'};
    const first=await f.execute(command);assert.equal(first.ok,true);
    assert.deepEqual(await f.execute(command),first);
    assert.equal((await f.start()).ok,false);assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
});
test('takeover during an awaited team switch prevents the old owner from committing it',async()=>{
  const f=await fixture();let finish;try{
    const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
    const text=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
    const team=Teams.import(text),teamId=createHash('sha256').update(Teams.pack(team)).digest('hex');
    const previousId=f.client.expectedTeamHash;
    f.session.recorderFactory=async()=>{await new Promise(resolve=>{finish=resolve;});return {status:()=>({teamId,state:'ready'}),flush:async()=>({teamId,state:'ready'}),close:async()=>{}};};
    const switching=f.execute({op:'switch-team',teamText:text,teamId});await Promise.resolve();await Promise.resolve();assert.equal(typeof finish,'function');
    assert.equal((await f.raw({op:'control-claim',controllerId:'recovery',takeover:true,expectedGeneration:1})).ok,true);
    finish();const result=await switching;assert.equal(result.ok,false);assert.match(result.error,/controller lease/);assert.equal(f.client.expectedTeamHash,previousId);assert.equal(f.sent.length,0);
  }finally{finish?.();f.session.dispose();}
});
