import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient,FORMAT} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
const packed='Fixture|private-item|private-ability|private-move';
const message='The server will be restarting soon. Best-of-3 battles cannot be started at this time.';
function fixture(){
  const sent=[],client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:()=>1000});
  Object.assign(client,{connected:true,authenticated:true,epoch:1,ws:{send:frame=>sent.push(frame)},searchState:{searching:[],games:null},formats:'|'+FORMAT});
  client.authorize('upload-team',{confirmed:true});client.uploadTeam(packed);
  const session=new AgentSession(client,{username:'Fixture',packed,authorizedSets:2,controllerRequired:false,autoReady:false});
  return {client,session,sent};
}
test('explicit global maintenance rejection releases only the pending search and retains allowance consumption',async()=>{
  const {client,session,sent}=fixture();
  try{
    await session.execute({id:'first',op:'start',confirmed:true});
    assert.equal(session.searchesSent,1);assert.equal(client.searchPending,true);assert.equal(session.awaitingSet,true);
    client.receive('|popup|'+message);
    assert.equal(client.searchPending,false);assert.equal(session.awaitingSet,false);assert.equal(client.searchGeneration,1);
    assert.equal(session.searchesSent,1);assert.equal(session.authorizedSets,2);
    assert.equal(session.snapshot().notices.at(-1).reasonCode,'server-maintenance');
    assert.equal(sent.filter(x=>x.includes('/search ')).length,1);
    assert.equal(session.ownedParents.size,0);
    // Rejection permits an explicitly authorized later retry; it never sends one.
    const retry=await session.execute({id:'second',op:'start',confirmed:true});
    assert.equal(retry.ok,true);assert.equal(session.searchesSent,2);
    assert.equal(sent.filter(x=>x.includes('/search ')).length,2);
  }finally{session.dispose();}
});
test('uncorroborated, room-scoped, unauthenticated and active-game notices preserve uncertain searches',()=>{
  for(const variant of ['generic','near-match','room','unauthenticated','active-game','unknown-idle','queued','active-request','active-ready','active-started']){
    const {client,session}=fixture();
    try{
      client.searchPending=true;session.awaitingSet=true;
      if(variant==='unauthenticated')client.authenticated=false;
      if(variant==='active-game')client.searchState.games={'game-bestof3-gen9championsvgc2026regmcbo3-123':'Fixture'};
      if(variant==='unknown-idle')client.searchState=null;
      if(variant==='queued')client.searchState.searching=[FORMAT];
      if(variant==='active-request'){const active=client.state('battle-gen9championsvgc2026regmcbo3-123');active.epoch=client.epoch;active.request={rqid:1,wait:false};}
      if(variant==='active-ready')client.state('game-bestof3-gen9championsvgc2026regmcbo3-123').readyPrompt={epoch:client.epoch};
      if(variant==='active-started')client.receive('>battle-gen9championsvgc2026regmcbo3-123\n|start');
      const prefix=variant==='room'?'>battle-gen9championsvgc2026regmcbo3-123\n':'';
      client.receive(prefix+'|popup|'+(variant==='generic'?'Please try later.':variant==='near-match'?message+' Added text.':message));
      assert.equal(client.searchPending,true,variant);assert.equal(session.awaitingSet,true,variant);assert.equal(client.searchGeneration,0,variant);
    }finally{session.dispose();}
  }
});
test('stale readiness and started-room observations do not block a current explicit rejection',()=>{
  const {client,session}=fixture();
  try{
    client.searchPending=true;session.awaitingSet=true;
    const old=client.state('game-bestof3-gen9championsvgc2026regmcbo3-123');
    old.readyPrompt={epoch:0};old.startedObserved=true;old.startedObservedEpoch=0;
    client.receive('|popup|'+message);
    assert.equal(client.searchPending,false);assert.equal(session.awaitingSet,false);assert.equal(client.searchGeneration,1);
  }finally{session.dispose();}
});
test('full-restart rejection is counted once even when a later idle update arrives',()=>{
  const {client,session,sent}=fixture();
  try{
    client.searchPending=true;client.searchObservedActive=true;session.awaitingSet=true;
    const notice='|popup|The server is restarting. Battles will be available again in a few minutes.';
    client.receive(notice);client.receive(notice);
    client.receive('|updatesearch|{"searching":[],"games":null}');
    assert.equal(client.searchGeneration,1);assert.equal(client.searchPending,false);assert.equal(session.awaitingSet,false);
    assert.equal(session.snapshot().notices.filter(n=>n.kind==='search-rejected').length,1);
    assert.equal(sent.filter(x=>/\/(?:search|forfeit|trn) /.test(x)).length,0);
  }finally{session.dispose();}
});
