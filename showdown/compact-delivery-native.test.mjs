import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture as observedFixture} from '../simulation/observed-position.fixtures.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
import {observedHypothesesSchema} from '../simulation/schemas.mjs';
import {registerTeamFromText} from '../metrics/import.mjs';
import {serveLocalSession} from './local-bridge.mjs';
import {AgentSession} from './agent-session.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const decode=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
const fixtureServer=fileURLToPath(new URL('../tests/fixtures/simulation-mcp-server.mjs',import.meta.url));

// The sole attacker, its complete pair, both opposing actions and all unknown
// opposing investments come from explicit synthetic fixtures. No live client,
// calculator fallback, model-selected response or spread inference is used.
test('authored MCP delivery checks distinguish lost Armor Tail from preserved Armor Tail',async t=>{
  const cacheRoot=fileURLToPath(new URL('../cache/',import.meta.url));await mkdir(cacheRoot,{recursive:true});
  const workspace=await mkdtemp(join(cacheRoot,'vgc-compact-delivery-native-')),f=observedFixture();
  t.after(()=>{assert.equal(dirname(resolve(workspace)),resolve(cacheRoot));assert.ok(resolve(workspace).startsWith(join(resolve(cacheRoot),'vgc-compact-delivery-native-')));return rm(workspace,{recursive:true,force:true});});
  // This fixture tests native MCP delivery, not immutable snapshot publication.
  // Preseed its isolated export; registration still validates its legality/hash.
  const teamsDirectory=join(workspace,'cache','team-metrics','teams');await mkdir(teamsDirectory,{recursive:true});
  await writeFile(join(teamsDirectory,f.expected.teamId+'.txt'),f.teamText,{flag:'wx'});
  const {teamId}=await registerTeamFromText({workspace,teamText:f.teamText,name:'Isolated compact delivery fixture'});
  assert.equal(teamId,f.expected.teamId);
  const state={...structuredClone(f.observed),connected:true,authenticated:true,stopped:false},identity={sessionId:f.observed.sessionId,teamId};
  // The simulation fixture already contains exactly the four current request
  // members and their requestIndex. Supply the compact planning presentation
  // of that known selection; no hidden roster or opposing state is inferred.
  const ownSide=state.boards[0].sides.find(side=>side.id===state.boards[0].ownSide);
  ownSide.selectionKnowledge='current-own-request';
  for(const pokemon of ownSide.pokemon)pokemon.selection='selected';
  const commands=[],source={
    turnSnapshot:()=>structuredClone(state),
    snapshot:()=>({sessionId:identity.sessionId,teamSha256:teamId,rooms:[{id:f.expected.room,sheets:{p2:Teams.pack(f.opposingSheet.map(set=>({...set,level:50})))}}]}),
  };
  const session={id:identity.sessionId,execute(command){
    commands.push(structuredClone(command));
    assert.ok(['turn-status','status'].includes(command.op),'Native research must only read the offline existing source');
    return AgentSession.prototype.execute.call(source,command);
  }};
  const descriptorPath=join(workspace,'cache','showdown-session.json');
  const bridge=await serveLocalSession(session,{descriptorPath});
  const client=new Client({name:'compact-delivery-native-regression',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[fixtureServer,workspace]});
  let serverPid;
  try{
    await client.connect(transport);serverPid=transport.pid;assert.ok(Number.isInteger(serverPid));
    const entry=(await client.listTools()).tools.find(tool=>tool.name==='battle_check_plan');
    assert.ok(entry);assert.equal(entry.annotations.readOnlyHint,true);assert.equal(entry.inputSchema.additionalProperties,false);
    const command={room:f.expected.room,rqid:f.expected.rqid,token:f.expected.token,budgetMs:3500,
      actions:[{type:'move',slot:1,target:2},{type:'switch',slot:3}],
      delivery:{dependency:{actorId:'own0',role:'sole-progress'},hypotheses:structuredClone(f.hypotheses),
        branches:[{id:'authored-double-fake-out',opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:4,target:1}]}],
        seeds:[[1,2,3,4],[5,6,7,8]]}};
    const ownBefore=structuredClone(command.actions),stateBefore=structuredClone(state),hypothesesBefore=structuredClone(f.hypotheses);
    const normalizedHypotheses=observedHypothesesSchema.parse(hypothesesBefore);
    const callFor=actions=>({name:'battle_check_plan',args:{request:{kind:'observed',source:{sessionId:identity.sessionId,teamId,
      room:command.room,rqid:command.rqid,token:command.token,opposingSheetSha256:publishedSheetDigest(f.opposingSheet)},
      hypotheses:structuredClone(normalizedHypotheses),branches:[{...structuredClone(command.delivery.branches[0]),ourActions:structuredClone(actions),
        gate:{kind:'delivery',requiredActionsBy:['own0']}}],seeds:structuredClone(command.delivery.seeds)},budgetMs:3500}});
    const call=callFor(command.actions),authored=structuredClone(call.args);

    const check=async(call,expectedStatus)=>{
      const started=commands.length,reply=await client.callTool({name:call.name,arguments:call.args});
      assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=decode(reply);
      assert.equal(result.coverage.checkedCandidates,1,JSON.stringify(result));
      assert.equal(result.coverage.suppliedOpposingBranchesOnly,true);assert.equal(result.coverage.sampleOnly,true);
      assert.equal(result.checkedCandidates[0].status,expectedStatus,JSON.stringify(result));
      assert.deepEqual(result.hypotheses,normalizedHypotheses);assert.deepEqual(result.seeds,command.delivery.seeds);
      for(const field of ['chosenAction','chosenActions','selectedCandidate','selection','sent'])assert.equal(Object.hasOwn(result,field),false);
      const reads=commands.slice(started);assert.equal(reads.length,3);
      assert.deepEqual(reads.slice(0,2).map(value=>value.op).sort(),['status','turn-status']);assert.equal(reads[2].op,'turn-status');
      const candidate=result.checkedCandidates[0],ref=candidate.calculationRef;
      assert.ok(ref?.id);assert.deepEqual(candidate.ourActions,call.args.request.branches[0].ourActions);
      assert.deepEqual(candidate.seeds,command.delivery.seeds);assert.equal(candidate.source.opposingSheetSha256,publishedSheetDigest(f.opposingSheet));
      const retainedReply=await client.callTool({name:'battle_calculation_evidence',arguments:{teamId,id:ref.id}});
      assert.equal(retainedReply.isError,undefined,JSON.stringify(retainedReply));const retained=decode(retainedReply);
      assert.equal(retained.tool,'simulate_turn');assert.deepEqual(retained.input.request,call.args.request);
      assert.equal(retained.result.engine.gen,0);assert.equal(retained.result.engine.format,'gen9championsvgc2026regmc');
      assert.deepEqual(retained.result.submittedBranches,call.args.request.branches);
      assert.equal(retained.result.samples.length,2);assert.deepEqual(retained.result.samples.map(sample=>sample.seed),command.delivery.seeds);
      assert.ok(retained.result.samples.every(sample=>sample.accepted.p1.accepted===true));
      assert.match(retained.result.loadedManifest.modules['simulation/turn-worker.mjs'],/^[a-f0-9]{64}$/);
      return {result,retained};
    };
    const failure=await check(call,'sampled-failure');
    for(const sample of failure.retained.result.samples){
      const required=sample.gate.requiredActions.find(goal=>goal.id==='own0');assert.equal(required.status,'failed');
      assert.ok(required.denials.some(event=>event.type==='cant'),'Native engine must show actual denied action, not a guessed damage threshold');
      assert.ok(sample.events.some(event=>event.type==='switch'&&event.actorId==='own2'));
    }
    assert.ok(failure.result.uncoveredRequiredActors.some(value=>value.actorId==='own0'&&value.status==='failed'));

    const protectedCall=callFor([{type:'move',slot:1,target:2},{type:'move',slot:4}]);
    assert.deepEqual(protectedCall.args.request.hypotheses,call.args.request.hypotheses);
    assert.deepEqual(protectedCall.args.request.branches[0].opposingActions,call.args.request.branches[0].opposingActions);
    const countercase=await check(protectedCall,'sampled-pass');
    for(const sample of countercase.retained.result.samples){
      const required=sample.gate.requiredActions.find(goal=>goal.id==='own0');assert.equal(required.status,'passed');assert.equal(required.nativeMoveResult,true);
      assert.equal(required.attemptedMove,'Dragon Pulse');assert.equal(required.denials.length,0);
    }
    assert.deepEqual(call.args,authored);assert.deepEqual(command.actions,ownBefore);assert.deepEqual(state,stateBefore);assert.deepEqual(f.hypotheses,hypothesesBefore);
    assert.ok(commands.every(value=>['turn-status','status'].includes(value.op)));
    assert.equal(new Set(commands.map(value=>value.id)).size,commands.length);
  }finally{
    const closed=await Promise.allSettled([client.close(),bridge.close()]);
    for(const result of closed)assert.equal(result.status,'fulfilled',result.reason?.message);
    assert.equal(transport.pid,null);
    if(serverPid)assert.throws(()=>process.kill(serverPid,0),error=>error.code==='ESRCH','Owned SDK fixture server must be absent after awaited close');
    await assert.rejects(readFile(descriptorPath),error=>error.code==='ENOENT');
  }
});
