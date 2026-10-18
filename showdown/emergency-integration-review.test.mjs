import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';

const parent='game-bestof3-gen9championsvgc2026regmcbo3-990001',room='battle-gen9championsvgc2026regmcbo3-990002';
function fakeClock(){
  let now=1000,next=0;const timers=new Map();
  return {now:()=>now,setTimer:(callback,delay)=>{const id=++next;timers.set(id,{callback,at:now+delay});return id;},clearTimer:id=>timers.delete(id),advance(ms){const end=now+ms;let ticks=0;for(;;){const nextTimer=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!nextTimer)break;if(++ticks>100)throw Error('Timer loop');now=nextTimer[1].at;timers.delete(nextTimer[0]);nextTimer[1].callback();}now=end;}};
}
async function fixture(emergencyDefaultChoice){
  const clock=fakeClock(),sent=[],packed='Species|item|ability|move',client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex'),now:clock.now});
  client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';client.searchState={searching:[],games:{}};
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'Fixture',packed,now:clock.now,monotonicNow:clock.now,controlTimers:{setTimer:clock.setTimer,clearTimer:clock.clearTimer}});
  let id=0;const raw=command=>session.execute({id:`review-${++id}`,confirmed:true,...command});
  const claim=await raw({op:'control-claim',controllerId:'review-fixture'}),lease=claim.result.controllerLease;
  const execute=command=>raw({controllerLease:lease,...command});
  assert.equal((await execute({op:'set-control-policy',enabled:true,forfeitIfStuck:true,emergencyDefaultChoice})).ok,true);
  assert.equal((await execute({op:'start'})).ok,true);
  client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Fixture vs Opponent'}})}`);
  client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  client.receive(`>${room}\n|player|p1|Opponent\n|player|p2|Fixture\n|switch|p1a: Gone|Pikachu, L50|100/100\n|switch|p1b: Remaining|Charizard-Mega-Y, L50|48/100\n|faint|p1a: Gone`);
  const request=(rqid=1)=>client.receive(`>${room}\n|request|${JSON.stringify({rqid,active:[{canMegaEvo:true,moves:[{move:'Iron Head',target:'normal',pp:10}]},{moves:[{move:'Weather Ball',target:'normal',pp:10}]}],side:{id:'p2',name:'Fixture',pokemon:[{ident:'p2: Golisopod',details:'Golisopod, L50',active:true,condition:'78/182'},{ident:'p2: Politoed',details:'Politoed, L50',active:true,condition:'175/197'}]}})}`);
  return {clock,sent,client,session,execute,request};
}

test('emergency integration targets the surviving second foe after the first foe fainted',async()=>{
  const f=await fixture(true);try{
    f.request();f.clock.advance(20000);
    assert.deepEqual(f.sent.filter(line=>line.includes('/choose')),[`${room}|/choose move 1 2, move 1 2|1`]);
    assert(!f.sent.some(line=>line.includes('mega')));
    f.clock.advance(120000);assert.equal(f.sent.filter(line=>line.includes('/choose')).length,1);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
  }finally{f.session.dispose();}
});

test('stuck-forfeit permission alone does not enable an emergency default',async()=>{
  const f=await fixture(false);try{
    f.request();f.client.receive(`>${room}\n|inactive|Time left: 55 sec this turn | 300 sec total`);f.clock.advance(20000);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);assert.equal(f.sent.filter(line=>line.includes('/forfeit')).length,0);
    assert.equal(f.session.supervisor.status().pending[0].recovering,true);
    f.clock.advance(30000);assert.deepEqual(f.sent.filter(line=>line.includes('/forfeit')),[`${parent}|/forfeit`]);
  }finally{f.session.dispose();}
});

test('a released controller cannot generate defaults, while a new owner can protect the next request',async()=>{
  const f=await fixture(true);try{
    f.request();assert.equal((await f.execute({op:'control-release'})).ok,true);f.clock.advance(20000);
    assert.equal(f.sent.filter(line=>line.includes('/choose')).length,0);
    const claim=await f.session.execute({id:'review-new-owner',confirmed:true,op:'control-claim',controllerId:'next-fixture'});assert.equal(claim.ok,true);
    f.request(2);f.clock.advance(20000);
    assert.deepEqual(f.sent.filter(line=>line.includes('/choose')),[`${room}|/choose move 1 2, move 1 2|2`]);
  }finally{f.session.dispose();}
});
