import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPlanningToolClient,loadedPlanningRuntimeVersion,PLANNING_RUNTIME_FILES} from './tool-client.mjs';

test('calculator runtime cache identity includes the exact observed-position adapter source',()=>{
  assert(Object.isFrozen(PLANNING_RUNTIME_FILES));assert(PLANNING_RUNTIME_FILES.includes('../simulation/observed-position.mjs'));
  const sha=value=>createHash('sha256').update(value).digest('hex'),pins=PLANNING_RUNTIME_FILES.map(file=>[file,sha(readFileSync(new URL(file,import.meta.url)))]),version=loadedPlanningRuntimeVersion();
  assert.match(version,/^[a-f0-9]{64}$/u);assert.equal(version,sha(JSON.stringify(pins)));assert.equal(createPlanningToolClient({}).runtimeVersion,version);
  const changed=pins.map(([file,hash])=>[file,file==='../simulation/observed-position.mjs'?'0'.repeat(64):hash]);
  assert.notEqual(sha(JSON.stringify(changed)),version,'An adapter-only source change invalidates calculator/spread caches.');
});
test('planning invokes the exact registered validated handler and never battle tools',async()=>{
  let captured,calls=0;
  const client=createPlanningToolClient({registerTool:(name,options,handler)=>{captured=handler;},tool:()=>{}});
  const handler=async args=>{calls++;return {structuredContent:{generation:args.gen}};};
  client.registerTool('calculate_speed',{inputSchema:z.strictObject({gen:z.literal(0)})},handler);
  assert.equal(captured,handler);
  assert.deepEqual(await client.callTool('calculate_speed',{gen:0}),{structuredContent:{generation:0}});
  await assert.rejects(client.callTool('calculate_speed',{}),/explicit native/);
  await assert.rejects(client.callTool('calculate_speed',{gen:0,unknown:true}));
  await assert.rejects(client.callTool('battle_choose',{gen:0}));
  assert.equal(calls,1);
});
