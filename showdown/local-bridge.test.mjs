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
