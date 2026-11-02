import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTimingRecorder,timingSpan} from '../observability/timing.mjs';
import {registerTeamFromText} from '../metrics/import.mjs';
import {acquireMetricsBattleLock} from '../metrics/catalog.mjs';
import {recordCalculation,readCalculation} from '../workflow/calculations.mjs';
import {runTurnSimulation} from './turn-simulator.mjs';
import {openingFixture} from './fixtures.mjs';
import {registerSimulationTools,timingToolContext,wrapTimedTool} from './mcp-tools.mjs';

const teamId='a'.repeat(64),roomId='battle-gen9championsvgc2026regmcbo3-1002';
const recorder=()=>createTimingRecorder({component:'timing-server-test'});
const ends=(capture,name)=>capture.snapshot().filter(event=>event.name===name&&event.event==='span.end');

test('tool metadata carries only timing correlation and timing remains opt in',async()=>{
  const traceId=randomUUID(),parentSpanId=randomUUID(),capture=recorder();
  const extra={_meta:{'vgc/timing':{traceId,parentSpanId,teamId,roomId,rqid:3,turn:2,requestKey:'b'.repeat(64),token:'never-retain-this-secret',capabilities:{secret:true}},other:'also-not-retained'}};
  assert.deepEqual(timingToolContext(extra),{traceId,parentSpanId,teamId,requestKey:'b'.repeat(64),roomId,rqid:3,turn:2});
  const result=await wrapTimedTool(capture,'calculate_speed',async()=>timingSpan('calculator.engine').run(()=>({content:[]})))({},extra);
  assert.deepEqual(result,{content:[]});assert.equal(ends(capture,'mcp.tool').length,1);
  assert.ok(capture.snapshot().every(event=>event.traceId===traceId&&event.teamId===teamId));
  assert.doesNotMatch(JSON.stringify(capture.snapshot()),/never-retain|capabilities|also-not-retained/);
  const before=capture.snapshot().length;
  await wrapTimedTool(undefined,'calculate_speed',async()=>({content:[]}))({},extra);
  assert.equal(capture.snapshot().length,before);
  const failed=await wrapTimedTool(capture,'simulate_turn',async()=>({isError:true,content:[]}))({},extra);
  assert.equal(failed.isError,true);assert.equal(ends(capture,'mcp.tool').at(-1).status,'error');
  const exported=await wrapTimedTool(undefined,'simulate_turn',async()=>({content:[]}))({}, {_meta:{'vgc/timing':{returnEvents:true,traceId,teamId,token:'never-export'}}});
  assert.ok(exported._meta['vgc/timing-events'].length>0);
  assert.ok(exported._meta['vgc/timing-events'].length<=512);
  assert.ok(exported._meta['vgc/timing-events'].some(event=>event.name==='mcp.tool'&&event.event==='span.end'));
  assert.doesNotMatch(JSON.stringify(exported._meta),/never-export/);
  const retainedOnly=await wrapTimedTool(capture,'simulate_turn',async()=>({content:[]}))({}, {_meta:{'vgc/timing':{returnEvents:true}}});
  assert.equal(retainedOnly._meta,undefined,'a configured sink does not duplicate events into the MCP result');
});

test('native worker timings preserve worker clock domain and separate validation, reconstruction and resolution',async()=>{
  const capture=recorder();
  const result=await capture.run({teamId,roomId,turn:1},()=>runTurnSimulation(openingFixture()));
  assert.equal(result.engine.gen,0);assert.equal(result.samples.length,1);
  for(const name of ['simulation.worker_roundtrip','simulation.worker_startup','simulation.worker_core','simulation.validation','simulation.reconstruction','simulation.native_engine','simulation.outcome_processing'])assert.ok(ends(capture,name).length,name);
  const native=ends(capture,'simulation.native_engine')[0],roundtrip=ends(capture,'simulation.worker_roundtrip')[0];
  assert.notEqual(native.clockDomain,roundtrip.clockDomain);
  assert.equal(native.component,'simulation-worker');assert.equal(native.traceId,roundtrip.traceId);
  assert.ok(native.durationMs>=0);assert.ok(roundtrip.durationMs>=0);
  assert.ok(capture.snapshot().some(event=>event.name==='simulation.worker_core_end'));
  const identities=capture.snapshot().map(event=>`${event.processInstanceId}/${event.sequence}`);
  assert.equal(new Set(identities).size,identities.length,'worker records are imported exactly once');
});

test('refusal before worker, native validation failure and timeout retain distinct outcomes',async()=>{
  const invalid=recorder();let created=0;
  await assert.rejects(invalid.run({teamId},()=>runTurnSimulation({},{workerFactory:()=>{created++;}})));
  assert.equal(created,0);assert.equal(ends(invalid,'simulation.worker_roundtrip').length,0);
  assert.equal(ends(invalid,'simulation.validation')[0].status,'error');
  assert.ok(invalid.snapshot().some(event=>event.name==='simulation.outcome'&&event.outcome==='refused-before-worker'&&event.workerCreated===false));
  const failed=recorder(),bad=openingFixture();bad.position.sides[0].pokemon[0].nature='DefinitelyInvalid';
  await assert.rejects(failed.run({teamId},()=>runTurnSimulation(bad)),/Unknown native/);
  assert.equal(ends(failed,'simulation.worker_roundtrip')[0].status,'error');
  assert.equal(ends(failed,'simulation.native_engine').length,0);
  assert.ok(ends(failed,'simulation.validation').some(event=>event.component==='simulation-worker'&&event.status==='error'));
  assert.ok(failed.snapshot().some(event=>event.name==='simulation.worker_core_end'&&event.outcome==='refused-before-engine'));
  const timeout=recorder();let terminated=0;
  const workerFactory=()=>{
    const worker=Object.assign(new EventEmitter(),{terminate(){terminated++;}});
    queueMicrotask(()=>{worker.emit('message',{type:'vgc-timing',phase:'ready'});worker.emit('message',{type:'vgc-timing',phase:'core-begin'});});
    return worker;
  };
  await assert.rejects(timeout.run({teamId},()=>runTurnSimulation(openingFixture(),{workerFactory,timeoutMs:15})),/deadline exhausted/);
  assert.equal(terminated,1);assert.equal(ends(timeout,'simulation.worker_startup')[0].status,'ok');
  assert.equal(ends(timeout,'simulation.worker_roundtrip')[0].status,'timeout');
  assert.ok(timeout.snapshot().some(event=>event.name==='simulation.worker_outcome'&&event.outcome==='timeout'&&event.coreStarted===true));
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(timeout.run({teamId},()=>runTurnSimulation(openingFixture(),{workerFactory,signal:aborted.signal})),/cancelled/);
  assert.equal(terminated,1,'pre-abort never constructs a worker');
});

test('MCP simulation retains strict request schema and measures output serialization',async()=>{
  const capture=recorder(),tools=new Map();
  registerSimulationTools({registerTool:(name,configuration,handler)=>tools.set(name,{configuration,handler})},{timingRecorder:capture,run:async()=>({engine:{gen:0},samples:[]})});
  const tool=tools.get('simulate_turn'),args={request:{kind:'explicit',...openingFixture()}};
  assert.equal(tool.configuration.inputSchema.safeParse({...args,timing:{token:'forbidden'}}).success,false);
  const result=await tool.handler(args,{_meta:{'vgc/timing':{teamId}}});
  assert.equal(result.structuredContent.engine.gen,0);assert.equal(ends(capture,'simulation.serialization').length,1);
  assert.equal(ends(capture,'mcp.tool')[0].status,'ok');
});

test('actual evidence capture separates team load, lock wait, serialization, durable write and read',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-timing-evidence-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const teamText=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([species,ability])=>`${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
  const registered=await registerTeamFromText({workspace,teamText}),capture=recorder();
  const release=await acquireMetricsBattleLock({workspace,teamId:registered.teamId,roomId:'calculation-evidence'});
  const write=capture.run({teamId:registered.teamId,roomId},()=>recordCalculation({workspace,tool:'calculate_speed',input:{testFixture:true},result:{fixture:'stored-actual-call-envelope'},context:{teamId:registered.teamId,roomId}}));
  // Release the real local evidence lock while the writer is awaiting it.
  setTimeout(release,20);
  const reference=await write;
  const loaded=await capture.run({teamId:registered.teamId,roomId},()=>readCalculation({workspace,teamId:registered.teamId,id:reference.id}));
  assert.equal(loaded.sha256,reference.sha256);
  for(const name of ['calculation_evidence.team_load','calculation_evidence.lock_wait','calculation_evidence.serialize','calculation_evidence.write','calculation_evidence.read'])assert.equal(ends(capture,name).length,1,name);
  assert.ok(ends(capture,'calculation_evidence.lock_wait')[0].durationMs>0);
  assert.doesNotMatch(JSON.stringify(capture.snapshot()),/stored-actual-call-envelope|testFixture/);
  const refused=recorder();
  await assert.rejects(refused.run({},()=>recordCalculation({workspace,tool:'calculate_speed',context:{teamId:'bad',roomId}})),/exact team/);
  assert.equal(ends(refused,'calculation_evidence.write').length,0);
});
