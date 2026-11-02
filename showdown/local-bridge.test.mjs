import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {serveLocalSession,callLocalSession} from './local-bridge.mjs';

test('local RPC controls one persistent session, protects access and cleans descriptor',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-bridge-')),descriptorPath=join(directory,'session.json');
  let calls=0;const session={id:'fixture-session',execute:async command=>{calls++;return {id:command.id,ok:true,result:{sameObject:true}};}};
  const bridge=await serveLocalSession(session,{descriptorPath});
  try {
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    assert.equal(descriptor.version,1);assert.equal(descriptor.sessionId,session.id);
    assert(!JSON.stringify(descriptor).includes('password'));assert(!JSON.stringify(descriptor).includes('assertion'));
    assert((await callLocalSession(descriptorPath,{id:'one',op:'status'})).result.sameObject);
    assert((await callLocalSession(descriptorPath,{id:'two',op:'status'})).result.sameObject);
    const denied=await new Promise((resolve,reject)=>{
      const socket=net.createConnection(descriptor.address);socket.on('error',reject);
      socket.on('connect',()=>socket.write(JSON.stringify({capability:'é'.repeat(64),command:{id:'bad',op:'status'}})+'\n'));
      socket.once('data',data=>{socket.destroy();resolve(JSON.parse(data.toString()));});
    });
    assert.equal(denied.ok,false);assert.equal(calls,2);
    const malformed=await new Promise((resolve,reject)=>{
      const socket=net.createConnection(descriptor.address);socket.on('error',reject);
      socket.on('connect',()=>socket.write('null\n'));
      socket.once('data',data=>{socket.destroy();resolve(JSON.parse(data.toString()));});
    });
    assert.equal(malformed.ok,false);
    assert((await callLocalSession(descriptorPath,{id:'still-live',op:'status'})).ok);
    await assert.rejects(serveLocalSession(session,{descriptorPath}),/descriptor already exists/);
  }finally{await bridge.close();await assert.rejects(readFile(descriptorPath),/ENOENT/);await rm(directory,{recursive:true,force:true});}
});
test('cached ID collision cannot shut down the bridge without actually stopping the session',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-collision-')),descriptorPath=join(directory,'session.json');
  const session={id:'collision-session',stopped:false,execute:async command=>({id:command.id,ok:true,result:{status:'sent-not-acknowledged'}})};
  const bridge=await serveLocalSession(session,{descriptorPath});
  try {
    await callLocalSession(descriptorPath,{id:'same-id',op:'stop'});
    await new Promise(resolve=>setTimeout(resolve,40));
    assert((await callLocalSession(descriptorPath,{id:'next',op:'status'})).ok);
  }finally{await bridge.close();await rm(directory,{recursive:true,force:true});}
});
test('missing session fails without connecting or exposing authentication',async()=>{
  await assert.rejects(callLocalSession(join(tmpdir(),'nonexistent-vgc-'+Date.now()+'.json'),{id:'x',op:'status'}),/sign in in your terminal/);
});

for(const kind of ['abort','timeout'])test(`bounded local read ${kind} closes its socket, cancels the server read and never replays`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-bounded-bridge-')),descriptorPath=join(directory,'session.json');
  const commands=[];let dispatched,closed;
  const started=new Promise(resolve=>{dispatched=resolve;}),socketClosed=new Promise(resolve=>{closed=resolve;});
  const session={id:'bounded-'+kind,execute:async(command,{signal})=>{
    commands.push(command.id);
    if(command.op==='status')return {ok:true,result:{read:'normal'}};
    dispatched();
    return await new Promise(resolve=>signal.addEventListener('abort',()=>{closed();resolve({ok:false,error:'Read cancelled after socket close'});},{once:true}));
  }};
  const bridge=await serveLocalSession(session,{descriptorPath});
  const controller=new AbortController();
  try {
    const pending=callLocalSession(descriptorPath,{id:kind,op:'turn-status'},{timeoutMs:kind==='timeout'?100:1000,signal:controller.signal});
    const rejected=assert.rejects(pending,error=>{
      assert.equal(error.name,kind==='timeout'?'TimeoutError':'AbortError');assert.match(error.message,/Do not replay an uncertain action/);return true;
    });
    await started;if(kind==='abort')controller.abort();await rejected;
    let timer;
    try {await Promise.race([socketClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cancelled read left a connected server socket')),1000);})]);}
    finally {clearTimeout(timer);}
    assert.deepEqual(commands,[kind],'Cancellation never retries or replaces an uncertain operation');
    assert.equal((await callLocalSession(descriptorPath,{id:'normal',op:'status'},{timeoutMs:1000})).result.read,'normal');
    assert.deepEqual(commands,[kind,'normal']);
  }finally{controller.abort();await bridge.close();await rm(directory,{recursive:true,force:true});}
});

test('pre-abort and descriptor-read abort preserve cancellation rather than suggesting authentication',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vgc-read-abort-')),descriptorPath=join(directory,'session.json');
  let commands=0;const bridge=await serveLocalSession({id:'read-abort',execute:async()=>{commands++;return {ok:true};}},{descriptorPath});
  try {
    const before=new AbortController();before.abort();
    await assert.rejects(callLocalSession(descriptorPath,{id:'before',op:'status'},{signal:before.signal}),{name:'AbortError'});
    const during=new AbortController(),pending=callLocalSession(descriptorPath,{id:'during',op:'status'},{signal:during.signal});during.abort();
    await assert.rejects(pending,error=>{assert.equal(error.name,'AbortError');assert.doesNotMatch(error.message,/sign in/);return true;});
    assert.equal(commands,0,'An abort before descriptor read completion cannot send a command');
    assert.equal((await callLocalSession(descriptorPath,{id:'normal',op:'status'},{timeoutMs:1000})).ok,true);
  }finally{await bridge.close();await rm(directory,{recursive:true,force:true});}
});

test('optional call bounds are validated before descriptor reads and retain the default normal path',async()=>{
  const missing=join(tmpdir(),'bounded-nonexistent-'+Date.now()+'.json');
  for(const timeoutMs of [0,-1,35001,Infinity,NaN,'100'])await assert.rejects(callLocalSession(missing,{op:'status'},{timeoutMs}),/timeoutMs must be positive/);
  await assert.rejects(callLocalSession(missing,{op:'status'},{signal:{aborted:false}}),/must be an AbortSignal/);
});
