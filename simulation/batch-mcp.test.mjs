import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixture} from './observed-position.fixtures.mjs';
import {openingFixture} from './fixtures.mjs';
import {executeSimulationBatch,registerSimulationTools,simulationBatchToolSchema} from './mcp-tools.mjs';
import {simulateNativeTurnBatch} from './turn-simulator.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
function sourceFixture(){
  const f=fixture(),source={...f.expected,sessionId:f.observed.sessionId};f.observed.boards[0].opponentSheets=f.observed.opponentSheets;
  const branch={id:'paired-actions',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{kind:'delivery',requiredActionsBy:['own0']}};
  const args={request:{kind:'observed',source,hypotheses:f.hypotheses,cases:[{id:'attack',branches:[branch],seeds:[[1,2,3,4]]},{id:'protect',branches:[{...structuredClone(branch),ourActions:[{type:'switch',slot:3},{type:'move',slot:4}]}],seeds:[[1,2,3,4]]}]},evidenceContext:{teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room)}};
  const full={sessionId:source.sessionId,teamSha256:source.teamId,rooms:[{id:source.room,sheets:{}}]},reads=[],receipts=[];let loads=0;
  const options={workspace:'offline-batch-fixture',loadTeam:async()=>{loads++;return {team:Teams.import(f.teamText)};},call:async(_path,command)=>{reads.push(command.op);return {ok:true,result:structuredClone(command.op==='status'?full:f.observed)};},recordEvidence:async entry=>{receipts.push(entry);return {id:'batch-evidence',...entry.context,tool:entry.tool};}};
  return {f,args,options,reads,receipts,loads:()=>loads};
}
test('batch MCP normalizes one observed source/team and retains one exact team-owned batch record',async()=>{
  const f=sourceFixture(),before=structuredClone(f.args),result=await executeSimulationBatch(f.args,f.options);
  assert.deepEqual(f.args,before);assert.equal(f.loads(),1);assert.deepEqual(f.reads,['turn-status','status','turn-status','turn-status']);
  assert.equal(f.receipts.length,1);assert.equal(f.receipts[0].tool,'simulate_turn_batch');assert.equal(f.receipts[0].input.normalized.cases.length,2);
  assert.equal(result.cases.length,2);for(const [index,entry] of result.cases.entries()){
    assert.equal(entry.id,f.args.request.cases[index].id);assert.equal(entry.result.source.token,f.args.request.source.token);
    assert.deepEqual(entry.result.submittedBranches,f.args.request.cases[index].branches);assert.equal(entry.result.samples.length,1);
    assert.equal(entry.result.calculationRef.id,result.calculationRef.id);assert.equal(entry.result.calculationRef.caseId,entry.id);
  }
});
test('initial source/status/team reads overlap while final source reconciliation stays ordered after engine',async()=>{
  const f=sourceFixture(),started=new Set();let engine=false;
  const waitForAll=async()=>{await new Promise(resolve=>setImmediate(resolve));assert.equal(started.size,3);};
  const result=await executeSimulationBatch(f.args,{...f.options,loadTeam:async()=>{started.add('team');await waitForAll();return {team:Teams.import(f.f.teamText)};},call:async(path,command)=>{if(!started.has(command.op)&&started.size<3){started.add(command.op);await waitForAll();}if(engine)assert.equal(command.op,'turn-status');return f.options.call(path,command);},run:async core=>{engine=true;return simulateNativeTurnBatch(core);}});
  assert.equal(result.cases.length,2);assert.equal(engine,true);
});
test('changed source after batch engine, disabled moves and duplicate cases cannot become evidence',async()=>{
  const f=sourceFixture(),call=f.options.call;let reads=0,engine=0;
  await assert.rejects(executeSimulationBatch(f.args,{...f.options,call:async(...args)=>{if(args[1].op==='turn-status'&&++reads===3)f.f.observed.actions[0].token='e'.repeat(64);return call(...args);},run:async core=>{engine++;return simulateNativeTurnBatch(core);}}),/stale or reserved/);
  assert.equal(engine,1);assert.equal(f.receipts.length,0);
  const disabled=sourceFixture();disabled.f.observed.actions[0].legalActions.active[0].moves[0].disabled=true;
  await assert.rejects(executeSimulationBatch(disabled.args,{...disabled.options,run:async()=>{assert.fail('disabled pair reached engine');}}),/Move unavailable/);assert.equal(disabled.receipts.length,0);
  const duplicate=sourceFixture();duplicate.args.request.cases[1].id=duplicate.args.request.cases[0].id;
  await assert.rejects(executeSimulationBatch(duplicate.args,duplicate.options),/case IDs/);assert.equal(duplicate.loads(),0);
});
test('MCP batch bounds and cancellation reject without control or partial evidence',async()=>{
  const f=sourceFixture(),abort=new AbortController();abort.abort();await assert.rejects(executeSimulationBatch(f.args,{...f.options,signal:abort.signal}),/cancelled/);assert.equal(f.loads(),0);assert.equal(f.receipts.length,0);
  const pending=new AbortController(),running=executeSimulationBatch(f.args,{...f.options,signal:pending.signal,call:()=>new Promise(()=>{})});pending.abort();await assert.rejects(running,/cancelled/);assert.equal(f.receipts.length,0);
  const tools=new Map();registerSimulationTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})});
  const tool=tools.get('simulate_turn_batch');assert.equal(tool.config.annotations.readOnlyHint,true);assert.equal(tool.config.annotations.destructiveHint,false);
  const fixture=openingFixture(),request={kind:'explicit',position:fixture.position,hypotheses:fixture.hypotheses,cases:[{id:'one',branches:fixture.branches,seeds:fixture.seeds}]};
  assert.equal(simulationBatchToolSchema.safeParse({request}).success,true);
  request.cases.push(...Array.from({length:3},(_,index)=>({...request.cases[0],id:String(index)})));assert.equal(simulationBatchToolSchema.safeParse({request}).success,false);
});

test('actual MCP transport advertises and executes the registered native batch tool',async t=>{
  const client=new Client({name:'offline-simulation-batch-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../tests/fixtures/simulation-mcp-server.mjs',import.meta.url)),process.cwd()],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  const entry=(await client.listTools()).tools.find(tool=>tool.name==='simulate_turn_batch');assert.ok(entry);assert.equal(entry.annotations.readOnlyHint,true);assert.equal(entry.inputSchema.additionalProperties,false);
  const fixture=openingFixture(),args={request:{kind:'explicit',position:fixture.position,hypotheses:fixture.hypotheses,cases:[{id:'first',branches:fixture.branches,seeds:fixture.seeds},{id:'second',branches:fixture.branches,seeds:[[3,2,3,4]]}]}};
  const reply=await client.callTool({name:'simulate_turn_batch',arguments:args});assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=reply.structuredContent??JSON.parse(reply.content[0].text);
  assert.deepEqual(result.cases.map(entry=>entry.id),['first','second']);assert.equal(result.batch.workerConcurrency,1);assert.ok(result.cases.every(entry=>entry.result.engine.gen===0&&entry.result.samples.length===1));assert.equal(result.calculationRef,undefined);
  args.request.cases[1].branches=structuredClone(args.request.cases[1].branches);args.request.cases[1].branches[0].opposingActions.pop();assert.equal((await client.callTool({name:'simulate_turn_batch',arguments:args})).isError,true);
});
