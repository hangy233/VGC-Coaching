import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeSimulation,simulationToolSchema,registerSimulationTools} from './mcp-tools.mjs';
import {fixture} from './observed-position.fixtures.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {serveLocalSession,callLocalSession} from '../showdown/local-bridge.mjs';
import {AgentSession} from '../showdown/agent-session.mjs';
const {Teams,Dex}=createRequire(import.meta.url)('pokemon-showdown');
function sourceFixture(){
  const f=fixture(),room=canonicalEvidenceRoom(f.expected.room)+'-private123pw';f.expected.room=room;f.observed.actions[0].room=room;f.observed.boards[0].room=room;f.observed.boards[0].opponentSheets=f.observed.opponentSheets;
  const source={...f.expected,sessionId:f.observed.sessionId},calls=[],receipts=[];
  const args={request:{kind:'observed',source,hypotheses:f.hypotheses,seeds:[[1,2,3,4]],branches:[{id:'actual-pair',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{targetId:'foe0',beforeActionsOf:['foe0'],requiredActionsBy:['own0','own1']}}]},evidenceContext:{teamId:source.teamId,roomId:canonicalEvidenceRoom(room),turn:1}};
  const full={sessionId:source.sessionId,teamSha256:source.teamId,rooms:[{id:room,sheets:{}}]};
  const options={workspace:'isolated-fixture',loadTeam:async()=>({team:Teams.import(f.teamText)}),call:async(_path,command)=>{calls.push(command);return {ok:true,result:structuredClone(command.op==='status'?full:f.observed)};},recordEvidence:async entry=>{receipts.push(entry);return {id:'fixture',...args.evidenceContext,tool:'simulate_turn'};}};
  return {f,full,args,options,calls,receipts};
}

test('observed simulation uses valid unique commands through the real local bridge and session read boundary',async()=>{
  const f=sourceFixture(),workspace=await mkdtemp(join(tmpdir(),'vgc-simulation-source-'));
  const descriptorPath=join(workspace,'cache','showdown-session.json'),commands=[];
  let stale=false,turnReads=0;
  // Preserve the production command-ID gate and read dispatch. The snapshots
  // are offline observations; there is no Showdown login or live battle here.
  const source={turnSnapshot(){
    const value=structuredClone(f.f.observed);
    if(stale&&++turnReads===2)value.actions[0].token='e'.repeat(64);
    return value;
  },snapshot:()=>structuredClone(f.full)};
  const session={id:f.args.request.source.sessionId,execute(command){
    commands.push(structuredClone(command));
    assert.ok(['turn-status','status'].includes(command.op));
    return AgentSession.prototype.execute.call(source,command);
  }};
  const bridge=await serveLocalSession(session,{descriptorPath});
  try{
    const missing=await callLocalSession(descriptorPath,{op:'turn-status'});
    assert.equal(missing.ok,false);assert.match(missing.error,/unique command id/);
    commands.length=0;
    const {call,...options}=f.options;
    const result=await executeSimulation(f.args,{...options,workspace});
    assert.equal(result.samples[0].gate.passed,false);
    assert.equal(f.receipts.length,1);
    // Initial board/status reads are independent and may arrive in either
    // order through the real bridge. Reconciliation must remain the last read.
    assert.deepEqual(commands.slice(0,2).map(command=>command.op).sort(),['status','turn-status']);
    assert.equal(commands[2]?.op,'turn-status');assert.equal(commands.length,3);
    assert.ok(commands.every(command=>/^[A-Za-z0-9_-]{1,80}$/.test(command.id)));
    assert.equal(new Set(commands.map(command=>command.id)).size,3);
    stale=true;turnReads=0;let runs=0;
    await assert.rejects(executeSimulation(f.args,{...options,workspace,run:async()=>{runs++;return {};}}),/stale or reserved/);
    assert.equal(runs,0);assert.equal(f.receipts.length,1);
  }finally{
    await bridge.close();await rm(workspace,{recursive:true,force:true});
  }
});
test('observed MCP wrapper loads team/sheet and binds exact private source through native simulation without mutations',async()=>{
  const f=sourceFixture(),result=await executeSimulation(f.args,f.options);assert.equal(result.source.room,f.args.request.source.room);assert.equal(result.source.teamId,f.args.evidenceContext.teamId);assert.equal(result.samples[0].gate.passed,false);assert.deepEqual(f.calls.map(call=>call.op),['turn-status','status','turn-status']);assert.equal(f.receipts.length,1);assert.equal(f.receipts[0].context.roomId,canonicalEvidenceRoom(result.source.room));assert.deepEqual(f.receipts[0].result.samples,result.samples);assert.equal(f.receipts[0].input.normalized.position.mode,'opening');
});
test('observed wrapper rejects wrong metadata, stale/reserved source and changed final reconciliation before engine',async()=>{
  for(const change of [f=>{f.f.observed.sessionId='other';},f=>{f.f.observed.actions[0].token='d'.repeat(64);},f=>{f.f.observed.actions[0].submissionStatus='sent';},f=>{f.f.observed.controlPolicy={pending:[{token:f.args.request.source.token,attempted:true}]};},f=>{f.full.teamSha256='f'.repeat(64);},f=>{f.args.evidenceContext.roomId='battle-gen9championsvgc2026regmcbo3-999';}]){const f=sourceFixture();change(f);let runs=0;await assert.rejects(executeSimulation(f.args,{...f.options,run:async()=>{runs++;return {};}}));assert.equal(runs,0);assert.equal(f.receipts.length,0);assert.ok(f.calls.every(command=>['turn-status','status'].includes(command.op)));}
  const f=sourceFixture(),call=f.options.call;let reads=0,runs=0;f.options.call=async(...args)=>{if(args[1].op==='turn-status'&&++reads===2)f.f.observed.actions[0].token='e'.repeat(64);return call(...args);};await assert.rejects(executeSimulation(f.args,{...f.options,run:async()=>{runs++;return {};}}),/stale or reserved/);assert.equal(runs,0);
});
test('observed wrapper refuses bounded missing source and malformed schemas instead of inventing state',async()=>{
  const f=sourceFixture();await assert.rejects(executeSimulation(f.args,{...f.options,call:()=>new Promise(()=>{})}),/source read expired/);assert.equal(f.receipts.length,0);
  const invalid=structuredClone(f.args);invalid.request.hypotheses.magicState={};assert.equal(simulationToolSchema.safeParse(invalid).success,false);
  invalid.request.hypotheses=f.args.request.hypotheses;invalid.request.branches[0].opposingActions.pop();assert.equal(simulationToolSchema.safeParse(invalid).success,false);
  const tools=new Map();registerSimulationTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},f.options);assert.equal(tools.get('simulate_turn').config.annotations.readOnlyHint,true);
});

test('observed missing lifecycle reaches native resolution with explicit conditional provenance and unchanged pairs',async()=>{
  const f=sourceFixture(),tools=new Map(),dex=Dex.forFormat('gen9championsvgc2026regmc');
  f.args.request.hypotheses={...f.args.request.hypotheses,mode:'current',own:{}};
  for(const active of f.f.observed.actions[0].legalActions.active)for(const entry of active.moves){const native=dex.moves.get(entry.move);entry.pp=dex.data.Scripts.calculatePP.call({gen:9},native,native.noPPBoosts||native.id==='trumpcard'?0:3);}
  const before=structuredClone(f.args);
  registerSimulationTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},f.options);
  const result=await tools.get('simulate_turn').handler(f.args);
  assert.notEqual(result.isError,true,result.content[0].text);assert.equal(f.receipts.length,1);assert.deepEqual(f.args,before);
  const actual=result.structuredContent;assert.equal(actual.source.approximate,true);assert.equal(actual.source.completeStateReconstruction,false);assert.deepEqual(actual.submittedBranches,before.request.branches);
  assert(actual.samples[0].events.length>0);assert.equal(actual.samples[0].accepted.p1.accepted,true);assert.equal(actual.samples[0].stateCoverage.complete,false);assert.equal(actual.samples[0].gate.passed,false);
  assert(actual.samples[0].stateCoverage.assumptions.some(row=>row.path.includes('lifecycle')));assert.equal(f.receipts[0].input.normalized.position.mode,'current');
  assert.match(actual.loadedManifest.modules['simulation/approximate-position.mjs'],/^[a-f0-9]{64}$/u);
});

test('standalone observed hypotheses cannot override an actually disabled own move',async()=>{
  const f=sourceFixture();
  f.f.observed.actions[0].legalActions.active[0].moves[0].disabled=true;
  let runs=0;
  await assert.rejects(executeSimulation(f.args,{...f.options,run:async()=>{runs++;return {};}}),/Move unavailable/);
  assert.equal(runs,0);assert.equal(f.receipts.length,0);
  f.f.observed.actions[0].legalActions.active[0].moves[0].disabled=false;
  const normal=await executeSimulation(f.args,f.options);
  assert.equal(normal.samples[0].accepted.p1.accepted,true);assert.equal(f.receipts.length,1);
});
test('actual observed wrapper preserves authored switch binding after a failed removal sample',async()=>{
  const f=sourceFixture(),pair=[{type:'switch',slot:3},{type:'move',slot:3}];
  f.args.request.branches[0].ourActions=pair;f.args.request.branches[0].gate.requiredActionsBy=['own1'];
  const authored=structuredClone(f.args),actual=await executeSimulation(f.args,f.options);
  assert.deepEqual(f.args,authored);assert.equal(f.receipts.length,1);
  assert.deepEqual(actual.submittedBranches[0].ourActions,pair);
  assert.match(actual.testedBranches[0].ourActions[0].pokemonId,/^pokemon-/);
  assert.equal(actual.samples[0].accepted.p1.actions[0].slot,3);assert.equal(actual.samples[0].gate.passed,false);
});
