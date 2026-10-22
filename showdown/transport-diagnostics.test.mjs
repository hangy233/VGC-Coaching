import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';

const packed='Fixture|private-item|private-ability|private-move';
const teamHash=createHash('sha256').update(packed).digest('hex');
const room='battle-gen9championsvgc2026regmcbo3-123';
function fixture(){
  let time=1000;const sent=[],audit=[];
  const client=new ShowdownClient({expectedTeamHash:teamHash,now:()=>time,log:entry=>audit.push(entry)});
  client.connected=client.authenticated=true;client.epoch=1;client.ws={send:frame=>sent.push(frame)};
  return {client,sent,audit,tick:value=>{time=value;}};
}

test('global error is bounded server notice without clearing a search reservation',()=>{
  const {client,tick}=fixture(),notices=[],errors=[];
  client.on('server-notice',notice=>notices.push(notice));client.on('server-error',error=>errors.push(error));
  client.searchPending=true;tick(1234);
  client.receive('|error|The battle server is not accepting searches.');
  assert.deepEqual(notices,[{type:'error',scope:'global',text:'The battle server is not accepting searches.',textSuppressed:false,truncated:false}]);
  assert.equal(errors.length,0);assert.equal(client.rooms.size,0);assert.equal(client.searchPending,true);
  assert.equal(client.transportStatus().incomingFrames,1);assert.equal(client.transportStatus().lastIncomingAt,1234);
});

test('room error keeps its existing revision, rejection and server-error behavior',()=>{
  const {client}=fixture(),notices=[],errors=[],statuses=[];
  client.on('server-notice',notice=>notices.push(notice));client.on('server-error',error=>errors.push(error));client.on('action-status',status=>statuses.push(status));
  const state=client.state(room);state.epoch=1;state.lastAction={status:'sent'};
  client.receive(`>${room}\n|error|[Invalid choice] stale rqid`);
  assert.equal(state.revision,1);assert.equal(state.epoch,-1);assert.equal(state.lastError,'[Invalid choice] stale rqid');
  assert.equal(state.lastAction.status,'rejected');
  assert.deepEqual(errors,[{room,text:'[Invalid choice] stale rqid',revision:1}]);
  assert.deepEqual(statuses,[{room,status:'rejected'}]);assert.deepEqual(notices,[]);
});

test('only post-auth sanitized notices enter bounded session status and wake observers',()=>{
  const {client,sent,tick}=fixture();
  const session=new AgentSession(client,{username:'Fixture',packed,controllerRequired:false,autoReady:false,now:()=>2000});
  let changes=0;session.on('change',()=>changes++);
  try{
    client.authenticated=false;client.receive('|error|Login failed.');client.receive('|popup|Before login.');
    assert.equal(session.snapshot().notices.length,0);assert.equal(changes,0);
    client.authenticated=true;client.searchPending=true;session.awaitingSet=true;tick(2100);
    client.receive('|error|Search was rejected.');client.receive('|popup|Please try later.');
    assert.equal(changes,2);assert.equal(session.snapshot().notices.at(-2).type,'error');
    assert.equal(session.snapshot().notices.at(-1).text,'Please try later.');
    const secrets=[
      'password=fixture-secret-password',
      'assertion fixture-secret-assertion',
      '/trn Fixture,0,fixture-auth-response',
      'https://replay.pokemonshowdown.com/fixture-privatepw',
      'controllerLease '+ 'a'.repeat(64),
      'readReceipt 12345678-1234-1234-1234-123456789abc',
      packed,
    ];
    for(const secret of secrets){
      client.receive('|error|'+secret);client.receive('|popup|'+secret);
      assert.equal(session.snapshot().notices.at(-1).text,null);
      assert.equal(session.snapshot().notices.at(-1).textSuppressed,true);
    }
    // Defense in depth also covers a malformed/direct event producer.
    client.emit('server-notice',{type:'popup',text:'assertion fixture-direct-secret'});
    const encoded=JSON.stringify(session.snapshot().notices);
    for(const secret of ['fixture-secret-password','fixture-secret-assertion','fixture-auth-response','fixture-privatepw','fixture-direct-secret',packed,'a'.repeat(64),'12345678-1234-1234-1234-123456789abc'])assert(!encoded.includes(secret));
    for(let index=0;index<25;index++)client.receive('|error|Notice '+index);
    assert.equal(session.snapshot().notices.length,20);assert.equal(session.snapshot().notices[0].text,'Notice 5');
    assert.equal(client.searchPending,true);assert.equal(session.awaitingSet,true);assert.equal(sent.length,0);
  }finally{session.dispose();}
});

test('notice text strips controls and retains strict truncation through session status',()=>{
  const {client}=fixture(),session=new AgentSession(client,{username:'Fixture',packed,controllerRequired:false,autoReady:false});
  try{
    client.receive('|error|\u001b[31mServer\u001b[0m\u0000\t unavailable');
    assert.equal(session.snapshot().notices.at(-1).text,'Server unavailable');
    client.receive('|popup|'+('short '.repeat(150)));
    const notice=session.snapshot().notices.at(-1);assert.equal(notice.text.length,512);assert.equal(notice.truncated,true);
    assert(!/[\p{Cc}\p{Cf}]/u.test(JSON.stringify(notice)));
  }finally{session.dispose();}
});

test('split sensitive markers are suppressed before client listeners and session storage',()=>{
  const {client}=fixture(),notices=[];
  client.on('server-notice',notice=>notices.push(notice));
  const session=new AgentSession(client,{username:'Fixture',packed,controllerRequired:false,autoReady:false});
  try{
    for(const marker of ['ass\u001b[31mertion fixture-short-secret','pass\u200bword fixture-format-secret','capabi\u0000lity fixture-control-secret']){
      client.receive('|error|'+marker);client.receive('|popup|'+marker);
    }
    for(const notice of notices){assert.equal(notice.text,null);assert.equal(notice.textSuppressed,true);}
    const encoded=JSON.stringify({notices,session:session.snapshot().notices});
    for(const secret of ['fixture-short-secret','fixture-format-secret','fixture-control-secret'])assert(!encoded.includes(secret));
  }finally{session.dispose();}
});

test('transport metadata counts frames, uses injected clocks and omits payloads',async()=>{
  const {client,tick,audit}=fixture();
  assert.deepEqual(client.transportStatus(),{incomingFrames:0,lastIncomingAt:null,outgoingAttempts:0,lastOutgoingAt:null,lastOutgoingAction:null});
  tick(1100);client.receive('|challstr|1|fixture-private-challenge\n|formats|private-format-frame');
  assert.equal(client.transportStatus().incomingFrames,1);
  client.broker={login:async()=> 'fixture-private-assertion-response'};
  tick(1200);await client.authenticate('Fixture',{approved:true});
  assert.equal(client.transportStatus().lastOutgoingAction,'authenticate');
  tick(1300);client.joinRoom(room);
  assert.equal(client.transportStatus().lastOutgoingAction,'join-room');
  tick(1400);client.authorize('upload-team',{confirmed:true});client.uploadTeam(packed);
  assert.deepEqual(client.transportStatus(),{incomingFrames:1,lastIncomingAt:1100,outgoingAttempts:3,lastOutgoingAt:1400,lastOutgoingAction:'upload-team'});
  const copy=client.transportStatus();copy.lastOutgoingAction='private-command';assert.equal(client.transportStatus().lastOutgoingAction,'upload-team');
  const session=new AgentSession(client,{username:'Fixture',packed,controllerRequired:false,autoReady:false});
  try{
    assert.deepEqual(session.snapshot().transport,client.transportStatus());
    assert.deepEqual(session.turnSnapshot().transport,client.transportStatus());
    const metadata=JSON.stringify({transport:client.snapshot().transport,audit});
    for(const secret of ['fixture-private-challenge','private-format-frame','fixture-private-assertion-response',packed,'/trn','/utm'])assert(!metadata.includes(secret));
    // Unrecognized caller labels cannot become arbitrary diagnostic text.
    tick(1500);client.authorize('private-action',{confirmed:true});client.send('private-action','','/private-command','private-key');
    assert.equal(client.transportStatus().lastOutgoingAction,'other');
  }finally{session.dispose();}
});

test('write-attempt metadata preserves uncertainty reservation and rejected retries do not update it',()=>{
  const {client,tick}=fixture();client.ws.send=()=>{throw new Error('fixture transport failure');};
  tick(1800);client.authorize('search',{confirmed:true});
  assert.throws(()=>client.send('search','','/search fixture','same-reservation'),/fixture transport failure/);
  assert.deepEqual(client.transportStatus(),{incomingFrames:0,lastIncomingAt:null,outgoingAttempts:1,lastOutgoingAt:1800,lastOutgoingAction:'search'});
  assert(client.sent.has('same-reservation'));
  tick(1900);client.authorize('search',{confirmed:true});
  assert.throws(()=>client.send('search','','/search fixture','same-reservation'),/Duplicate or uncertain/);
  assert.equal(client.transportStatus().lastOutgoingAt,1800);assert.equal(client.transportStatus().outgoingAttempts,1);
});

test('normal connect starts a fresh metadata epoch without retaining prior frame or auth text',async()=>{
  let time=1000;
  class FixtureSocket extends EventTarget{
    constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const client=new ShowdownClient({WebSocketImpl:FixtureSocket,now:()=>time});
  await client.connect();client.receive('|challstr|1|fixture-auth-data');
  assert.equal(client.transportStatus().incomingFrames,1);client.close();time=2000;
  await client.connect();
  assert.deepEqual(client.transportStatus(),{incomingFrames:0,lastIncomingAt:null,outgoingAttempts:0,lastOutgoingAt:null,lastOutgoingAction:null});
  client.receive('unrecognized-frame');assert.equal(client.transportStatus().lastIncomingAt,2000);client.close();
});
