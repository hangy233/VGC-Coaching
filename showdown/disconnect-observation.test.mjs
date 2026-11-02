import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {sanitizeControlTrace} from '../metrics/retention.mjs';

class OfflineSocket extends EventTarget {
  constructor(){super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(){}
  closed(code,wasClean,reason){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code,wasClean,reason}));}
  close(){this.closed(1000,true,'Synthetic secret reason must not be retained');}
}

test('disconnect diagnostics retain typed observations without any raw close reason',async()=>{
  const logs=[],client=new ShowdownClient({WebSocketImpl:OfflineSocket,log:value=>logs.push(value)});let observed;
  client.on('disconnected',value=>{observed=value;});await client.connect();
  client.ws.closed(1006,false,'synthetic-sensitive-close-reason');
  assert.equal(observed.closeCode,1006);assert.equal(observed.closeWasClean,false);assert.equal(observed.localCloseRequested,false);assert.equal(observed.reasonCode,'ws-close-abnormal');
  assert.equal(observed.reasonTextRetained,false);assert.equal(client.transportStatus().lastDisconnect.closeCode,1006);
  assert.equal(JSON.stringify({logs,observed,transport:client.transportStatus()}).includes('synthetic-sensitive-close-reason'),false);
  await client.connect();assert.equal(client.transportStatus().lastDisconnect,undefined);
  client.close();assert.equal(observed.localCloseRequested,true);assert.equal(observed.closeCode,1000);assert.equal(observed.reasonCode,'ws-close-normal');
  assert.equal(JSON.stringify(logs).includes('Synthetic secret reason'),false);
});

test('missing or invalid close fields stay unknown rather than becoming fabricated network causes',async()=>{
  const client=new ShowdownClient({WebSocketImpl:OfflineSocket});await client.connect();client.ws.closed(999,false,'Any value');
  assert.equal(client.transportStatus().lastDisconnect.closeCode,null);assert.equal(client.transportStatus().lastDisconnect.reasonCode,'ws-close-unclassified');
});

test('owned live disconnect is retained in sanitized control evidence with no raw reason',async()=>{
  const packed='Species|item|ability|move',client=new ShowdownClient({WebSocketImpl:OfflineSocket,expectedTeamHash:createHash('sha256').update(packed).digest('hex')});
  await client.connect();client.authenticated=true;
  const session=new AgentSession(client,{username:'Fixture',packed,controllerRequired:false});
  const child='battle-gen9championsvgc2026regmcbo3-12';session.ownedRooms.add(child);client.state(child);
  try{
    client.ws.closed(1011,false,'synthetic-sensitive-close-reason');
    const row=session.controlTrace.find(value=>value.type==='disconnected');assert.equal(row.closeCode,1011);assert.equal(row.controlFailure,true);
    const retained=sanitizeControlTrace({...row,event:'control-trace'});assert.equal(retained.closeWasClean,false);assert.equal(retained.localCloseRequested,false);assert.equal(retained.reasonTextRetained,false);assert.equal(retained.reasonCode,'ws-close-server-error');
    assert.equal(JSON.stringify(retained).includes('synthetic-sensitive-close-reason'),false);
  }finally{session.dispose();}
});
