import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture} from './observed-position.fixtures.mjs';
import {buildObservedPosition} from './observed-position.mjs';

test('actual MCP distinguishes native deterministic Stamina from a sampled Flash Cannon secondary',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-stamina-cleanliness-'));
  t.after(()=>{assert.ok(resolve(workspace).startsWith(resolve(join(tmpdir(),'vgc-stamina-cleanliness-'))));return rm(workspace,{recursive:true,force:true});});
  const f=fixture(),built=buildObservedPosition({observed:f.observed,teamText:f.teamText,opposingSheet:f.opposingSheet,hypotheses:f.hypotheses,expected:f.expected});
  const args={request:{kind:'explicit',position:built.position,hypotheses:built.assumptions,seeds:[[1,2,3,4],[5,6,7,8]],branches:[{id:'original-stamina-pressure',ourActions:[{type:'move',slot:1,target:2},{type:'move',slot:4}],opposingActions:[{type:'move',slot:4},{type:'move',slot:1,target:1}],gate:{kind:'delivery',requiredActionsBy:['own0']}}]}};
  const client=new Client({name:'stamina-cleanliness-native-regression',version:'1'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../tests/fixtures/simulation-mcp-server.mjs',import.meta.url)),workspace]});let pid,closed;
  try{
    await client.connect(transport);pid=transport.pid;
    const child=transport._process;assert.equal(child.pid,pid);closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    const tool=(await client.listTools()).tools.find(tool=>tool.name==='simulate_turn');assert.equal(tool.annotations.readOnlyHint,true);
    const call=async input=>{const reply=await client.callTool({name:'simulate_turn',arguments:input});assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);assert.equal(result.engine.gen,0);assert.equal(result.engine.format,'gen9championsvgc2026regmc');assert.equal(result.source.kind,'explicit-offline-snapshot');assert.equal(result.source.liveFreshness,false);assert.equal(result.calculationRef,undefined);assert.deepEqual(result.submittedBranches,input.request.branches);assert.equal(result.loadedManifest.modules['simulation/turn-simulator.mjs'],createHash('sha256').update(await readFile(new URL('./turn-simulator.mjs',import.meta.url))).digest('hex'));return result;};
    const result=await call(args);assert.equal(result.samples.length,2);
    for(const sample of result.samples){
      const activation=sample.events.find(event=>event.type==='-ability'&&event.actorId==='own0'&&event.raw.endsWith('|Stamina|boost'));
      const boost=sample.events.find(event=>event.type==='-boost'&&event.actorId==='own0'&&event.raw.endsWith('|def|1'));
      assert.ok(activation&&boost);assert.equal(boost.index,activation.index+1);assert.equal(boost.raw.includes('[from]'),false,'The actual pinned native output uses adjacent ability provenance');
      assert.deepEqual(sample.stochastic.potentialSecondaryEvents,[]);assert.equal(sample.gate.passed,true);assert.equal(sample.gate.cleanSample,true);assert.equal(sample.noPendingContinuation,true);
    }
    const secondary=structuredClone(args);secondary.request.branches[0].ourActions[0]={type:'move',slot:2,target:2};secondary.request.seeds=[[4,2,3,4]];
    const changed=await call(secondary),sample=changed.samples[0];assert.equal(sample.gate.passed,true);assert.equal(sample.gate.cleanSample,false);
    assert.ok(sample.events.some(event=>event.type==='-ability'&&event.raw.endsWith('|Stamina|boost')));assert.ok(sample.events.some(event=>event.type==='-boost'&&event.actorId==='own0'&&event.raw.endsWith('|def|1')));
    const actualDrop=sample.events.find(event=>event.type==='-unboost'&&event.actorId==='foe1'&&event.raw.endsWith('|spd|1'));assert.ok(actualDrop);assert.deepEqual(sample.stochastic.potentialSecondaryEvents,[actualDrop]);
  }finally{await client.close();assert.equal(transport.pid,null);if(closed)assert.deepEqual(await closed,{code:0,signal:null});if(pid)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');}
});
