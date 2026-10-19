import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';

const room='battle-gen9championsvgc2026regmcbo3-7', parent='game-bestof3-gen9championsvgc2026regmcbo3-7';
function fixture({autoReady=true,authorizedSets=1,...replayOptions}={}) {
  let time=1000;const packed='Species|item|ability|move',sent=[];
  const client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>time});
  client.connected=true;client.authenticated=true;client.epoch=1;
  client.ws={send:text=>sent.push(text),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  const session=new AgentSession(client,{username:'TofuRotom',packed,authorizedSets,autoReady,now:()=>time,controllerRequired:false,...replayOptions});
  const request=(extra={})=>client.receive(`>${room}\n|request|${JSON.stringify({rqid:1,active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}],side:{id:'p2',name:'TofuRotom',pokemon:[{ident:'p2: A',details:'Politoed, L50',active:true,condition:'100/100'},{ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'}]},...extra})}`);
  return {client,session,sent,request,tick:value=>{time=value;},start:async()=>{
    const result=await session.execute({id:'start',op:'start',confirmed:true});
    client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'TofuRotom vs Opponent'}})}`);
    client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);return result;
  }};
}

test('metrics IPC exposes safe status and flushes local observations without blocking battle actions',async()=>{
  const f=fixture();let finishSync,flushes=0;
  const state={enabled:true,teamId:f.client.expectedTeamHash,state:'pending',pending:1,lastSavedAt:null,lastError:null,stableReport:null};
  const recorder={status:()=>({...state}),flush:async options=>{
    assert.deepEqual(options,{savePending:true});flushes++;
    await new Promise(resolve=>{finishSync=resolve;});
    return {...state,state:'ready',pending:0,stableReport:{teamId:state.teamId,path:'synthetic-report.html'}};
  }};
  try{
    assert.equal(f.session.snapshot().metrics.enabled,false);
    assert.match((await f.session.execute({id:'disabled-sync',op:'metrics-sync'})).error,/unavailable/);
    f.session.attachMetricsRecorder(recorder);
    const syncing=f.session.execute({id:'flush-once',op:'metrics-sync'});await Promise.resolve();await Promise.resolve();
    assert.equal(f.session.snapshot().metrics.state,'pending');
    const status=await f.session.execute({id:'read-metrics',op:'metrics-status'});
    assert.equal(status.ok,true);assert.equal(status.result.teamId,state.teamId);
    // A slow derived report never serializes deadline-sensitive commands.
    assert.equal((await f.start()).ok,true);f.request();
    const action=f.session.snapshot().actions[0];
    assert.equal((await f.session.execute({id:'choose-during-sync',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]})).ok,true);
    finishSync();const reply=await syncing;
    assert.equal(reply.ok,true);assert.equal(reply.result.state,'ready');
    assert.deepEqual(await f.session.execute({id:'flush-once',op:'metrics-sync'}),reply);assert.equal(flushes,1);
    assert(!f.sent.some(line=>/metrics|report/.test(line)));
  }finally{finishSync?.();f.session.dispose();}
});

test('metrics sync cannot claim success for failed recording or a mismatched team',async()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.session.attachMetricsRecorder({status:()=>({teamId:'a'.repeat(64)}),flush(){}}),/differs from the approved/);
    f.session.attachMetricsRecorder({status:()=>({enabled:true,teamId:f.client.expectedTeamHash,state:'error'}),flush:async()=>({state:'error'})});
    const reply=await f.session.execute({id:'failed-sync',op:'metrics-sync'});
    assert.equal(reply.ok,false);assert.match(reply.error,/persistence is not confirmed/);
    assert.equal(f.sent.length,0);
  }finally{f.session.dispose();}
});
test('one authorized search, fixed team, explicit control and idempotent commands',async()=>{
  const f=fixture();assert.equal((await f.session.execute({id:'no',op:'start'})).ok,false);
  assert((await f.start()).ok);assert((await f.start()).ok);
  f.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":{}}');
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.match((await f.session.execute({id:'again',op:'start',confirmed:true})).error,/set limit/);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,1);f.session.dispose();
});
test('an exhausted idle session can explicitly authorize another set without queuing or signing in again',async()=>{
  const f=fixture();await f.start();
  f.client.receive(`>${parent}\n|win|TofuRotom`);
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.equal((await f.session.execute({id:'exhausted',op:'start',confirmed:true})).ok,false);
  const before=f.session.snapshot(),sent=f.sent.length;
  const grant={id:'extend-once',op:'authorize-sets',confirmed:true,additionalSets:1};
  const result=await f.session.execute(grant);
  assert.deepEqual(result.result,{authorizedSets:2,searchesSent:1,remainingSets:1,queued:false});
  assert.deepEqual(await f.session.execute(grant),result);
  const after=f.session.snapshot();
  assert.equal(after.authorizedSets,2);assert.equal(f.sent.length,sent);
  assert.equal(after.sessionId,before.sessionId);assert.equal(after.username,before.username);
  assert.equal(after.teamSha256,before.teamSha256);assert.equal(after.authenticated,true);
  assert((await f.session.execute({id:'next-set',op:'start',confirmed:true})).ok);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,2);
  assert.equal(f.sent.filter(text=>text.includes('/utm ')).length,1);f.session.dispose();
});
test('additional set authorization rejects missing confirmation, invalid counts, active/pending matches and disconnects',async()=>{
  const f=fixture();
  const grant={op:'authorize-sets',confirmed:true,additionalSets:1};let number=0;
  const execute=extra=>f.session.execute({id:'grant-'+(++number),...grant,...extra});
  assert.equal((await execute({confirmed:false})).ok,false);
  assert.match((await execute({})).error,/confirm an idle session/);
  f.client.receive('|updatesearch|{"searching":[],"games":null}');
  for(const additionalSets of [0,-1,1.5,101,'1',undefined])assert.match((await execute({additionalSets})).error,/Additional sets/);
  await f.start();assert.match((await execute({})).error,/confirm an idle session/);
  f.client.ws.close();assert.match((await execute({})).error,/disconnected or stopped/);
  assert.equal(f.session.authorizedSets,1);f.session.dispose();
  const pending=fixture();await pending.session.execute({id:'pending-start',op:'start',confirmed:true});
  pending.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":null}');
  pending.client.receive('|updatesearch|{"searching":[],"games":null}');
  assert.equal(pending.client.searchPending,false);assert.equal(pending.session.awaitingSet,true);
  assert.match((await pending.session.execute({id:'pending-grant',...grant})).error,/confirm an idle session/);
  assert.equal(pending.session.authorizedSets,1);pending.session.dispose();
});
test('additional authorization respects the cumulative 100-set maximum and wakes state waits',async()=>{
  const f=fixture({authorizedSets:99});f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const waiting=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000});
  assert((await f.session.execute({id:'reach-max',op:'authorize-sets',confirmed:true,additionalSets:1})).ok);
  assert.equal((await waiting).authorizedSets,100);
  assert.match((await f.session.execute({id:'over-max',op:'authorize-sets',confirmed:true,additionalSets:1})).error,/cannot exceed 100/);
  assert.equal(f.sent.length,0);f.session.dispose();
});
test('current token selects paired actions; stale/duplicate and post-result tokens fail',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  const command={id:'choose',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]};
  assert((await f.session.execute(command)).ok);assert((await f.session.execute(command)).ok);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({...command,id:'duplicate'})).ok,false);
  f.request({rqid:2});const next=f.session.snapshot().actions[0];assert.notEqual(next.token,action.token);
  f.client.receive(`>${room}\n|win|Other`);
  assert.equal((await f.session.execute({...command,id:'ended',token:next.token})).ok,false);
  assert.equal(f.sent.filter(text=>text.includes('/choose ')).length,1);f.session.dispose();
});
test('observed own clock limits decisions; opponent countdown is not ours',async()=>{
  const f=fixture();await f.start();f.request();
  f.client.receive(`>${room}\n|inactive|Opponent has 5 seconds left.`);
  assert.equal(f.session.snapshot().actions[0].clock.source,'unavailable');
  f.client.receive(`>${room}\n|inactive|Time left: 10 sec this turn | 420 sec total`);
  const action=f.session.snapshot().actions[0];assert.equal(action.clock.deadlineAt,11000);
  f.tick(10500);
  assert.match((await f.session.execute({id:'late',op:'choose',confirmed:true,token:action.token,actions:[]})).error,/countdown/);
  f.session.dispose();
});
test('server acknowledgments and actual resolution evidence stay distinct',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  await f.session.execute({id:'choice',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
  assert.equal(f.client.state(room).lastAction.status,'sent');
  f.client.receive(`>${room}\n|sentchoice|move 1, move 1`);assert.equal(f.client.state(room).lastAction.status,'accepted');
  f.client.receive(`>${room}\n|move|p1a: Foe|Protect|p1a: Foe`);assert.equal(f.client.state(room).lastAction.evidence.length,0);
  f.client.receive(`>${room}\n|move|p2a: A|Protect|p2a: A`);assert.equal(f.client.state(room).lastAction.evidence.length,1);
  f.client.receive(`>${room}\n|win|TofuRotom`);const decision=f.client.state(room).lastAction;
  assert.equal(decision.status,'execution-observed');assert.equal(decision.evidence.length,1);assert.equal(decision.boundary,'battle-ended');f.session.dispose();
});
test('automatic ready is scoped, prompt driven, idempotent, and never searches again',async()=>{
  const f=fixture();
  const prompt=()=>f.client.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  prompt();assert.equal(f.sent.length,0);await f.start();
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'TofuRotom vs Opponent',[room]:'TofuRotom vs Opponent'}})}`);
  prompt();prompt();assert.equal(f.sent.filter(text=>text.includes('/confirmready')).length,1);
  f.client.receive(`>${room}\n|c|~|/uhtml controls,<button disabled>Ready</button>`);
  prompt();assert.equal(f.sent.filter(text=>text.includes('/confirmready')).length,2);
  assert.equal(f.sent.filter(text=>text.includes('/search ')).length,1);f.session.dispose();
});
test('manual readiness returns urgent token, waits wake on updates and clean listeners',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();
  const revision=f.session.revision,pending=f.session.wait({afterRevision:revision,timeoutMs:1000});
  f.client.receive(`>${room}\n|turn|2`);assert((await pending).revision>revision);
  assert.equal(f.session.listenerCount('change'),0);
  const abort=new AbortController();const wait=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000,signal:abort.signal});abort.abort();await wait;assert.equal(f.session.listenerCount('change'),0);f.session.dispose();
});
test('disconnect wakes waits and blocks action reuse',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  const pending=f.session.wait({afterRevision:f.session.revision,timeoutMs:1000});f.client.ws.close();
  assert((await pending).stopped);assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'x',op:'choose',confirmed:true,token:action.token,actions:[]})).ok,false);f.session.dispose();
});
test('clock follows equal-timestamp timer receipt order through a trusted alias merge',async()=>{
  const privateRoom=`${room}-fixturetimerpw`;
  for(const latest of ['inactive','inactiveoff']){
    const f=fixture({autoReady:false});
    try{
      await f.start();f.request();
      const countdown='|inactive|Time left: 30 sec this turn | 300 sec total',off='|inactiveoff|Battle timer is now OFF.';
      f.client.receive(`>${privateRoom}\n${latest==='inactive'?off:countdown}`);
      f.client.receive(`>${room}\n${latest==='inactive'?countdown:off}`);
      f.client.receive(`>${room}\n|noinit|rename|${privateRoom}|Private battle`);
      const clock=f.session.snapshot().rooms.find(entry=>entry.id===privateRoom).clock;
      assert.equal(clock.source,latest==='inactive'?'server-timer-observation':'server-timer-disabled');
      assert.equal(clock.deadlineAt,latest==='inactive'?31000:null);
      assert.equal(clock.bankDeadlineAt,latest==='inactive'?301000:null);
    }finally{f.session.dispose();}
  }
});

test('clock keeps timestamp fallback for timer observations without receipt metadata',()=>{
  const f=fixture({autoReady:false});
  try{
    const state={receivedAt:1000,timers:[{at:1000,type:'inactiveoff',text:'Timer off'},{at:1001,type:'inactive',text:'Time left: 30 sec this turn'}]};
    assert.equal(f.session.clock(state,'turn').source,'server-timer-observation');
    state.timers[0].at=1001;
    assert.equal(f.session.clock(state,'turn').source,'server-timer-disabled');
  }finally{f.session.dispose();}
});

test('one authorized parent grants no control or readiness to unrelated battles',async()=>{
  const f=fixture();await f.start();f.request();
  const other='battle-gen9ou-99',another='game-bestof3-gen9championsvgc2026regmcbo3-99';
  f.client.receive(`>${other}\n|request|${JSON.stringify({rqid:1,teamPreview:true,side:{name:'TofuRotom',id:'p2',pokemon:[]}})}`);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'owned',[another]:'unrelated',[other]:'unrelated'}})}`);
  f.client.receive(`>${another}\n|html|<button value="/msgroom ${another},/confirmready">Ready</button>`);
  const snapshot=f.session.snapshot();assert.equal(snapshot.actions.length,1);assert.equal(snapshot.actions[0].room,room);
  assert(!snapshot.rooms.some(entry=>entry.id===other || entry.id===another));assert(!f.sent.some(line=>line.includes('/confirmready')));f.session.dispose();
});
test('a uniquely acquired private parent is joined once and its linked preview becomes actionable',async()=>{
  const f=fixture({autoReady:false});
  const privateParent='game-bestof3-gen9championsvgc2026regmcbo3-42-fixtureprivatepw';
  const privateChild='battle-gen9championsvgc2026regmcbo3-43-fixturechildpw';
  assert((await f.session.execute({id:'private-start',op:'start',confirmed:true})).ok);
  // The request can arrive before parent history; it alone must not grant scope.
  f.client.receive(`>${privateChild}\n|request|${JSON.stringify({rqid:5,teamPreview:true,side:{id:'p2',name:'TofuRotom',pokemon:[]}})}`);
  assert.equal(f.session.snapshot().actions.length,0);
  const searchUpdate=`|updatesearch|${JSON.stringify({searching:[],games:{[privateParent]:'TofuRotom vs Opponent',[privateChild]:'TofuRotom vs Opponent'}})}`;
  f.client.receive(searchUpdate);f.client.receive(searchUpdate);f.session.snapshot();
  assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${privateParent}`]);
  assert.equal(f.session.snapshot().actions.length,0);
  f.client.receive(`>${privateParent}\n|uhtml|game1|<a href="/${privateChild}">Game 1</a>`);
  const action=f.session.snapshot().actions[0];
  assert.equal(action.room,privateChild);assert.equal(action.kind,'preview');
  assert.equal(f.session.roomParents.get(privateChild),privateParent);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);f.session.dispose();
});
test('an acquired public parent follows a trusted private rename with racing history, preview and search updates',async()=>{
  for(const updateBeforeRename of [false,true]){
    const f=fixture({autoReady:false});await f.start();f.request();
    const oldToken=f.session.snapshot().actions[0].token;
    const privateParent=`${parent}-fixtureparentpw`,privateChild='battle-gen9championsvgc2026regmcbo3-8-fixturechildpw';
    const update=`|updatesearch|${JSON.stringify({searching:[],games:{[privateParent]:'TofuRotom vs Opponent',[privateChild]:'TofuRotom vs Opponent'}})}`;
    f.client.receive(`>${privateParent}\n|uhtml|game1|<a href="/${privateChild}">Game 1</a>`);
    f.client.receive(`>${privateChild}\n|request|${JSON.stringify({rqid:5,teamPreview:true,side:{id:'p2',name:'TofuRotom',pokemon:[]}})}`);
    assert(!f.session.snapshot().actions.some(action=>action.room===privateChild));
    if(updateBeforeRename)f.client.receive(update);
    f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private best of three`);
    if(!updateBeforeRename)f.client.receive(update);
    const state=f.session.snapshot();
    assert(f.session.ownedParents.has(privateParent));assert(!f.session.ownedParents.has(parent));
    assert.equal(f.session.roomParents.get(privateChild),privateParent);
    assert(state.actions.some(action=>action.room===privateChild && action.kind==='preview'));
    assert(state.rooms.some(entry=>entry.id===privateParent && entry.children.includes(privateChild)));
    assert.deepEqual(Object.keys(state.search.games).sort(),[privateParent,privateChild].sort());
    assert.equal((await f.session.execute({id:'stale-parent-token',op:'choose',confirmed:true,token:oldToken,actions:[]})).ok,false);
    // The server moves existing connections; a rename does not trigger a second join.
    assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${parent}`]);
    f.client.receive(`>${privateParent}\n|noinit|rename|${parent}|Public best of three`);
    assert(f.session.ownedParents.has(parent));assert.equal(f.session.roomParents.get(privateChild),parent);
    f.session.dispose();
  }
});
test('renamed child tokens expire and already sent choices never become actionable again',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();
  const old=f.session.snapshot().actions[0],privateChild=`${room}-fixturechildpw`;
  f.client.receive(`>${room}\n|noinit|rename|${privateChild}|Private battle`);
  const current=f.session.snapshot().actions[0];assert.equal(current.room,privateChild);assert.notEqual(current.token,old.token);
  const command={op:'choose',confirmed:true,actions:[{type:'move',slot:1},{type:'move',slot:1}]};
  assert.equal((await f.session.execute({id:'old-token',...command,token:old.token})).ok,false);
  assert((await f.session.execute({id:'current-token',...command,token:current.token})).ok);
  f.client.receive(`>${privateChild}\n|noinit|rename|${room}|Public battle`);
  f.request();assert.equal(f.session.snapshot().actions.length,0);
  assert.equal(f.sent.filter(line=>line.includes('/choose ')).length,1);f.session.dispose();
});
test('parent readiness is not resubmitted after privacy renames or repeated aliased prompts',async()=>{
  const f=fixture();await f.start();const privateParent=`${parent}-fixtureparentpw`;
  const prompt=id=>f.client.receive(`>${room}\n|c|~|/uhtml controls,<button value="/msgroom ${id},/confirmready">Ready</button>`);
  prompt(parent);f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private set`);prompt(privateParent);prompt(parent);
  assert.equal(f.sent.filter(line=>line.includes('/confirmready')).length,1);f.session.dispose();
});
test('untrusted aliases and a different numeric or format identity cannot move session ownership',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();const before=f.session.snapshot().actions[0];
  for(const target of ['game-bestof3-gen9championsvgc2026regmcbo3-99-privatepw','game-bestof3-gen9ou-7-privatepw'])f.client.receive(`>${parent}\n|noinit|rename|${target}|Unrelated`);
  f.client.receive(`>${parent}\n|c|Opponent|noinit|rename|${parent}-fakepw|Fake`);
  assert.deepEqual([...f.session.ownedParents],[parent]);assert.equal(f.session.snapshot().actions[0].token,before.token);f.session.dispose();
});
test('parent observation never joins ambiguous/unrelated sets and recovers acquired unjoined parents',async()=>{
  const f=fixture({autoReady:false});
  await f.session.execute({id:'ambiguous-start',op:'start',confirmed:true});
  const other='game-bestof3-gen9championsvgc2026regmcbo3-99-unrelatedpw';
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'first',[other]:'second','battle-gen9ou-3':'unrelated'}})}`);
  assert.equal(f.sent.filter(line=>line.startsWith('|/join ')).length,0);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'unique'}})}`);
  assert.deepEqual(f.sent.filter(line=>line.startsWith('|/join ')),[`|/join ${parent}`]);
  // Model a prior implementation that acquired the parent without observing it.
  f.client.sent.delete(`join:${f.client.epoch}:${parent}`);f.sent.length=0;
  f.session.captureRooms();f.session.captureRooms();
  assert.deepEqual(f.sent,[`|/join ${parent}`]);
  f.client.state(parent).ended=true;f.client.sent.delete(`join:${f.client.epoch}:${parent}`);f.sent.length=0;
  f.session.captureRooms();assert.equal(f.sent.length,0);f.session.dispose();
});
test('incidental called moves do not count as the submitted choice; cant is not execution',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  await f.session.execute({id:'protect',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]});
  f.client.receive(`>${room}\n|move|p2a: A|Quiver Dance|p2a: A|[from] ability: Dancer\n|move|p2a: A|Protect|p2a: A|[from] move: Instruct`);
  assert.equal(f.client.state(room).lastAction.evidence.length,0);
  f.client.receive(`>${room}\n|cant|p2a: A|frz|Protect`);
  const decision=f.client.state(room).lastAction;assert.equal(decision.status,'resolution-observed');assert.equal(decision.evidence[0].executed,false);f.session.dispose();
});
test('parent-set completion invalidates child choices even before the child result arrives',async()=>{
  const f=fixture();await f.start();f.request();const action=f.session.snapshot().actions[0];
  f.client.receive(`>${parent}\n|win|TofuRotom`);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'after-set',op:'choose',confirmed:true,token:action.token,actions:[]})).ok,false);f.session.dispose();
});
test('confirmed whole-BO3 forfeit needs no turn token, suppresses actions/readiness and awaits official completion',async()=>{
  const f=fixture({authorizedSets:2});await f.start();f.request();const action=f.session.snapshot().actions[0];
  const command={id:'forfeit-once',op:'forfeit',confirmed:true,room:parent};
  assert.equal((await f.session.execute({...command,id:'unconfirmed',confirmed:false})).ok,false);
  const revision=f.session.revision,waiting=f.session.wait({afterRevision:revision,timeoutMs:1000});
  const reply=await f.session.execute(command);assert.deepEqual(reply.result,{room:parent,status:'sent-not-acknowledged'});
  assert((await waiting).revision>revision);assert.deepEqual(await f.session.execute(command),reply);
  assert.equal((await f.session.execute({...command,id:'duplicate-forfeit'})).ok,false);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,1);
  assert.equal(f.client.connected,true);assert.equal(f.client.authenticated,true);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'stale-after-forfeit',op:'choose',confirmed:true,token:action.token,actions:[{type:'move',slot:1},{type:'move',slot:1}]})).ok,false);
  f.request({rqid:2});f.client.receive(`>${room}\n|html|<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  assert.equal(f.session.snapshot().actions.length,0);assert.equal(f.sent.filter(line=>line.includes('/confirmready')).length,0);
  f.client.receive(`>${room}\n|win|Opponent`);let state=f.session.snapshot();
  assert.equal(state.rooms.find(r=>r.id===parent).ended,false);assert.equal(state.search.games[parent],'TofuRotom vs Opponent');
  f.client.receive(`>${parent}\n|win|Opponent`);f.client.receive('|updatesearch|{"searching":[],"games":null}');
  state=f.session.snapshot();assert.equal(state.rooms.find(r=>r.id===parent).result.winner,'Opponent');assert.equal(state.search.games,null);
  assert.equal(state.authenticated,true);assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);
  assert((await f.session.execute({id:'explicit-after-forfeit',op:'start',confirmed:true})).ok);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,2);f.session.dispose();
});
test('forfeit rejects unowned, child, ended, inactive, disconnected and untrusted-alias targets',async()=>{
  const f=fixture({autoReady:false}),other='game-bestof3-gen9championsvgc2026regmcbo3-99';let id=0;
  const attempt=(target=parent,extra={})=>f.session.execute({id:'forfeit-guard-'+(++id),op:'forfeit',confirmed:true,room:target,...extra});
  assert.match((await attempt()).error,/not owned/);await f.start();
  assert.match((await attempt(room)).error,/parent room/);
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'owned',[other]:'unrelated'}})}`);
  assert.match((await attempt(other)).error,/not owned/);
  f.client.receive(`>${parent}\n|c|Opponent|noinit|rename|${parent}-fakepw|Fake`);
  assert.match((await attempt(`${parent}-fakepw`)).error,/not owned/);
  f.client.state(parent).ended=true;assert.match((await attempt()).error,/not live/);f.client.state(parent).ended=false;
  f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.match((await attempt()).error,/not live/);
  f.client.ws.close();assert.match((await attempt()).error,/disconnected/);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);f.session.dispose();
});

test('enable timer uses the current owned child while active or waiting and never emits battle choices',async()=>{
  for(const waiting of [false,true]){
    const f=fixture({autoReady:false});
    try{
      await f.start();f.request(waiting?{wait:true}:{});
      const before=f.sent.length,command={id:'enable-owned-timer',op:'set-timer',room,confirmed:true};
      const result=await f.session.execute(command);
      assert.equal(result.ok,true,result.error);assert.equal(result.result.status,'sent-not-acknowledged');
      assert.equal(result.result.serverObservation,null);
      assert.deepEqual(f.sent.slice(before),[`${room}|/timer on`]);
      assert.deepEqual(await f.session.execute(command),result);
      assert.equal((await f.session.execute({...command,id:'different-timer-request'})).ok,false);
      assert.match((await f.session.execute({...command,room:parent})).error,/different arguments/);
      assert.equal(f.session.searchesSent,1);assert.equal(f.session.authorizedSets,1);
      assert(f.session.capabilities().operations.includes('set-timer'));assert.equal(f.session.capabilities().features.ownedBattleTimer,true);
      f.client.receive(`>${room}\n|inactive|Battle timer is ON.`);
      for(const state of [f.session.snapshot().rooms.find(r=>r.id===room),f.session.turnSnapshot().boards.find(r=>r.room===room)]){
        assert.equal(state.timer.request.status,'sent-not-acknowledged');
        assert.equal(state.timer.serverObservation.type,'inactive');assert.equal(state.timer.serverObservation.afterRequest,true);
      }
    }finally{f.session.dispose();}
  }
});

test('timer operation rejects unowned, unlinked, stale, ambiguous, ended, inactive and disconnected targets',async()=>{
  const f=fixture({autoReady:false}),other='battle-gen9championsvgc2026regmcbo3-99';let id=0;
  const attempt=(target=room,extra={})=>f.session.execute({id:'timer-guard-'+(++id),op:'set-timer',confirmed:true,room:target,...extra});
  try{
    assert.match((await attempt()).error,/not linked/);await f.start();f.request();
    assert.match((await attempt(parent)).error,/child battle room/);
    assert.match((await attempt(other)).error,/not linked/);assert(!f.client.rooms.has(other));
    assert.match((await attempt(room,{confirmed:false})).error,/confirmation/);
    assert.match((await attempt(room,{enabled:false})).error,/Only enabling/);
    f.client.receive(`>${room}\n|c|Opponent|noinit|rename|${room}-fakepw|Fake`);
    assert.match((await attempt(`${room}-fakepw`)).error,/not linked/);
    f.client.state(parent).children=[];assert.match((await attempt()).error,/not linked/);f.client.state(parent).children=[room];
    f.client.state(room).epoch=0;assert.match((await attempt()).error,/current live/);f.client.state(room).epoch=1;
    f.request({side:{name:'AnotherPlayer'}});assert.match((await attempt()).error,/another player/);f.request();
    f.client.receive(`>${parent}\n|uhtml|game2|<a href="/${other}">Game 2</a>`);
    f.client.receive(`>${other}\n|request|${JSON.stringify({wait:true})}`);
    assert.match((await attempt()).error,/unambiguous/);f.client.state(other).ended=true;
    f.client.state(room).ended=true;assert.match((await attempt()).error,/current live/);f.client.state(room).ended=false;
    f.client.state(parent).ended=true;assert.match((await attempt()).error,/not live/);f.client.state(parent).ended=false;
    f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.match((await attempt()).error,/not live/);
    f.client.ws.close();assert.match((await attempt()).error,/disconnected/);
    assert.equal(f.sent.filter(line=>line.includes('/timer')).length,0);
  }finally{f.session.dispose();}
});

test('timer requires the current lease and preserves staged fallback, safety halt and search allowance',async()=>{
  const f=fixture({autoReady:false,controlTimers:{setTimer:()=>1,clearTimer:()=>{}}});
  try{
    await f.start();f.request();
    const claim=await f.session.execute({id:'claim-for-timer',op:'control-claim',confirmed:true,controllerId:'timer-fixture'});
    const controllerLease=claim.result.controllerLease;
    f.session.supervisor.configure({enabled:true});
    f.session.supervisor.stage(f.session.actions()[0].token,[{type:'move',slot:1},{type:'move',slot:1}]);
    f.session.supervisor.halt('fixture-safety-halt');
    const before=f.session.supervisor.status(),sent=f.sent.length;
    const command={id:'leased-timer',op:'set-timer',confirmed:true,room,controllerLease};
    assert.match((await f.session.execute({...command,id:'missing-timer-lease',controllerLease:undefined})).error,/controller lease/);
    assert.equal((await f.session.execute(command)).ok,true);
    assert.deepEqual(f.session.supervisor.status(),before);assert.deepEqual(f.sent.slice(sent),[`${room}|/timer on`]);
    assert.equal(f.session.searchesSent,1);assert.equal(f.session.authorizedSets,1);
    await f.session.execute({id:'takeover-timer',op:'control-claim',confirmed:true,controllerId:'new-controller',takeover:true,expectedGeneration:1});
    assert.match((await f.session.execute(command)).error,/controller lease/);
  }finally{f.session.dispose();}
});

test('trusted timer aliases and uncertain sends stay reserved without suppressing owned choices',async()=>{
  const f=fixture({autoReady:false}),privateChild=`${room}-fixturetimerpw`;
  try{
    await f.start();f.request();
    f.client.receive(`>${room}\n|noinit|rename|${privateChild}|Private battle`);
    const write=f.client.ws.send;f.client.ws.send=line=>{write(line);if(line.endsWith('|/timer on'))throw new Error('Synthetic uncertain timer write');};
    const command={id:'uncertain-owned-timer',op:'set-timer',confirmed:true,room};
    const result=await f.session.execute(command);assert.equal(result.ok,false);
    assert.deepEqual(await f.session.execute(command),result);
    assert.equal(f.session.snapshot().rooms.find(r=>r.id===privateChild).timer.request.status,'send-uncertain');
    assert.equal(f.session.actions().length,1);
    f.client.receive(`>${privateChild}\n|noinit|rename|${room}|Public battle`);
    assert.match((await f.session.execute({...command,id:'timer-no-retry',room:privateChild})).error,/Duplicate or uncertain/);
    assert.deepEqual(f.sent.filter(line=>line.includes('/timer')),[`${privateChild}|/timer on`]);
    const forfeited=await f.session.execute({id:'forfeit-after-timer',op:'forfeit',confirmed:true,room:parent});assert.equal(forfeited.ok,true);
    assert.match((await f.session.execute({...command,id:'timer-after-forfeit'})).error,/BO3 forfeit/);
  }finally{f.session.dispose();}
});
test('forfeit follows only trusted owned parent aliases and stays reserved through rename or uncertain I/O',async()=>{
  const f=fixture({autoReady:false});await f.start();f.request();const privateParent=`${parent}-fixtureparentpw`;
  f.client.receive(`>${parent}\n|noinit|rename|${privateParent}|Private set`);
  const reply=await f.session.execute({id:'trusted-alias-forfeit',op:'forfeit',room:parent,confirmed:true});
  assert.equal(reply.result.room,privateParent);assert(f.sent.includes(`${privateParent}|/forfeit`));
  f.client.receive(`>${privateParent}\n|noinit|rename|${parent}|Public set`);
  assert.equal(f.session.snapshot().actions.length,0);
  assert.equal((await f.session.execute({id:'after-forfeit-rename',op:'forfeit',room:privateParent,confirmed:true})).ok,false);
  assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,1);f.session.dispose();
  const uncertain=fixture();await uncertain.start();uncertain.request();
  const send=uncertain.client.ws.send;uncertain.client.ws.send=line=>{send(line);if(line.endsWith('|/forfeit'))throw new Error('Synthetic uncertain socket write');};
  assert.equal((await uncertain.session.execute({id:'uncertain-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
  assert.equal(uncertain.client.state(parent).forfeitPending.status,'sent-not-acknowledged');assert.equal(uncertain.session.snapshot().actions.length,0);
  uncertain.client.receive(`>${room}\n|html|<button value="/msgroom ${parent},/confirmready">Ready</button>`);
  assert.equal(uncertain.sent.filter(line=>line.includes('/confirmready')).length,0);
  assert.equal((await uncertain.session.execute({id:'never-retry-forfeit',op:'forfeit',room:parent,confirmed:true})).ok,false);
  assert.equal(uncertain.sent.filter(line=>line.includes('/forfeit')).length,1);assert.equal(uncertain.client.connected,true);uncertain.session.dispose();
});
test('a match racing cancellation remains controllable after a transient idle update',async()=>{
  const f=fixture();assert((await f.session.execute({id:'search',op:'start',confirmed:true})).ok);
  f.client.receive('|updatesearch|{"searching":["gen9championsvgc2026regmcbo3"],"games":null}');
  assert((await f.session.execute({id:'cancel',op:'cancel-search',confirmed:true})).ok);
  assert(f.sent.some(line=>line==='|/cancelsearch gen9championsvgc2026regmcbo3'));
  f.client.receive('|updatesearch|{"searching":[],"games":null}');assert.equal(f.session.snapshot().cancellation.status,'idle-observed');
  f.client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'TofuRotom vs Opponent'}})}`);
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);f.request();
  const snapshot=f.session.snapshot();assert.equal(snapshot.actions[0].room,room);assert.equal(snapshot.cancellation.status,'match-observed');f.session.dispose();
});

const completedLog=(winner='TofuRotom')=>'|player|p1|Opponent\n|player|p2|TofuRotom\n|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C (Bo3)\n|start\n|turn|2\n|win|'+winner;
const finishSet=f=>{f.client.receive(`>${room}\n${completedLog()}\n>${parent}\n|win|TofuRotom`);f.client.receive('|updatesearch|{"searching":[],"games":null}');};
const replayJSON=(id,log=completedLog())=>new Response(JSON.stringify({id,formatid:'gen9championsvgc2026regmcbo3',log}),{headers:{'content-type':'application/json'}});

test('completed owned BO3 saves sequential child replays once, verifies full identities and keeps login',async()=>{
  const downloads=[],f=fixture({authorizedSets:2,replayFetchImpl:async(url,options)=>{downloads.push({url,options});return replayJSON(new URL(url).pathname.slice(1).replace(/\.json$/,'').replace(/-accesspw$/,''));}});
  await f.start();
  const second='battle-gen9championsvgc2026regmcbo3-8-accesspw',third='battle-gen9championsvgc2026regmcbo3-9';
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${second}">Game 2</a><a href="/${third}">Game 3</a>`);
  for(const child of [second,third])f.client.receive(`>${child}\n${completedLog()}`);
  finishSet(f);
  const verified=[];f.client.on('replay-verified',event=>verified.push(event));
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line.endsWith('|/savereplay'))queueMicrotask(()=>f.client.receive(`|popup||html|<a href="https://replay.pokemonshowdown.com/${line.split('|')[0].slice(7)}">Replay</a>`));};
  const command={id:'save-completed-set',op:'save-replays',confirmed:true,room:parent},reply=await f.session.execute(command);
  assert.equal(reply.ok,true);assert.equal(reply.result.complete,true);assert.equal(reply.result.parentId,parent);assert.equal(reply.result.replays.length,3);assert.deepEqual(reply.result.failures,[]);
  assert.equal(reply.result.replays[1].url,`https://replay.pokemonshowdown.com/${second.slice(7)}`);assert(reply.result.replays.every(record=>record.verified && record.verifiedAt));
  assert.equal(verified.length,3);assert.equal(downloads.length,3);assert(downloads.every(({options})=>options.method==='GET' && options.redirect==='error' && options.credentials==='omit'));
  assert.deepEqual(await f.session.execute(command),reply);assert.deepEqual((await f.session.execute({...command,id:'verify-existing-set'})).result,reply.result);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,3);assert.equal(downloads.length,3);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);assert(f.client.authenticated && f.client.connected);f.session.dispose();
});

test('save replay guards require confirmation, owned official completed parent and authoritative idle',async()=>{
  const f=fixture();let id=0;const attempt=(target=parent,extra={})=>f.session.execute({id:'save-guard-'+(++id),op:'save-replays',confirmed:true,room:target,...extra});
  assert.match((await attempt()).error,/not owned/);await f.start();
  assert.match((await attempt(room)).error,/parent room/);assert.match((await attempt(parent,{confirmed:false})).error,/confirmation/);
  assert.match((await attempt()).error,/result is not confirmed/);f.client.receive(`>${parent}\n|win|TofuRotom`);
  assert.match((await attempt()).error,/idle session/);f.client.receive('|updatesearch|{"searching":[],"games":null}');
  const unfinished=await attempt();assert.equal(unfinished.ok,true);assert.equal(unfinished.result.complete,false);assert.match(unfinished.result.failures[0].error,/no official finished result/);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,0);f.session.dispose();
});

test('late popup after timeout can be verified with a new command without resending an upload',async()=>{
  const f=fixture({replayBudgetMs:25,replayFetchImpl:async()=>replayJSON(room.slice(7))});await f.start();finishSet(f);
  const command={id:'save-timeout',op:'save-replays',confirmed:true,room:parent};
  const failed=await f.session.execute(command);assert.equal(failed.ok,true);assert.equal(failed.result.complete,false);assert.equal(f.client.pendingReplay,null);
  assert.deepEqual(await f.session.execute(command),failed);assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);
  f.client.receive(`|popup|https://replay.pokemonshowdown.com/${room.slice(7)}`);
  const recovered=await f.session.execute({...command,id:'verify-late-response'});assert.equal(recovered.result.complete,true);
  assert.equal(f.sent.filter(line=>line.endsWith('|/savereplay')).length,1);assert.equal(f.client.listenerCount('replay-url'),1);f.session.dispose();
});

test('bounded verification tolerates uncooperative fetch and blocks another search while preserving',async()=>{
  const f=fixture({authorizedSets:2,replayBudgetMs:40,replayFetchImpl:()=>new Promise(()=>{})});await f.start();finishSet(f);
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line.endsWith('|/savereplay'))queueMicrotask(()=>f.client.receive(`|popup|https://replay.pokemonshowdown.com/${room.slice(7)}`));};
  const started=Date.now(),saving=f.session.execute({id:'save-hanging-fetch',op:'save-replays',confirmed:true,room:parent});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.session.snapshot().savingReplays,true);
  assert.match((await f.session.execute({id:'no-concurrent-search',op:'start',confirmed:true})).error,/replay preservation/);
  const reply=await saving;assert.equal(reply.result.complete,false);assert(Date.now()-started<1000);assert.equal(f.session.snapshot().savingReplays,false);
  assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);f.session.dispose();
});

test('uncertain socket send stays reserved while remaining finished children can succeed',async()=>{
  const second='battle-gen9championsvgc2026regmcbo3-8',f=fixture({replayFetchImpl:async()=>replayJSON(second.slice(7))});await f.start();
  f.client.receive(`>${parent}\n|uhtml|game|<a href="/${second}">Game 2</a>\n>${second}\n${completedLog()}`);finishSet(f);
  const send=f.client.ws.send;f.client.ws.send=line=>{send(line);if(line===`${room}|/savereplay`)throw new Error('Synthetic uncertain socket write');if(line===`${second}|/savereplay`)queueMicrotask(()=>f.client.receive(`|popup|https://replay.pokemonshowdown.com/${second.slice(7)}`));};
  const reply=await f.session.execute({id:'save-uncertain',op:'save-replays',confirmed:true,room:parent});
  assert.equal(reply.result.complete,false);assert.equal(reply.result.replays[0].roomId,second);assert.equal(reply.result.failures[0].roomId,room);assert.equal(f.client.replayRequests.get(room).status,'send-uncertain');
  assert.equal(f.sent.filter(line=>line===`${room}|/savereplay`).length,1);f.session.dispose();
});
