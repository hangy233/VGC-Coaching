import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {currentFixture,points} from '../simulation/observed-position.fixtures.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
import {observedHypothesesSchema} from '../simulation/schemas.mjs';
import {registerTeamFromText} from '../metrics/import.mjs';
import {serveLocalSession} from './local-bridge.mjs';
import {AgentSession} from './agent-session.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const decode=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
const fixtureServer=fileURLToPath(new URL('../tests/fixtures/simulation-mcp-server.mjs',import.meta.url));

// This is an explicit synthetic current position, not a reconstructed ladder
// turn. The actual MCP/native engine, rather than a guessed Speed or damage
// threshold, establishes the action order and sound-move denial below.
function pairedFixture(){
  const f=currentFixture(),board=f.observed.boards[0],foe=board.sides.find(side=>side.id==='p2').pokemon[0];
  Object.assign(foe,{species:'Incineroar',ability:'Intimidate',abilitySuppressed:false,item:'Sitrus Berry',itemKnown:true});
  Object.assign(f.hypotheses.opposing.foe0,{label:'Explicit synthetic physical Speed investment; not an inferred opponent spread',
    statPoints:points({hp:2,atk:32,spe:32}),ability:'Intimidate',item:'Sitrus Berry'});
  // Incineroar is now an active member, so the explicitly hypothesized fourth
  // selection must be a distinct registered species, not a duplicate reserve.
  Object.assign(f.hypotheses.reserves[1],{species:'Basculegion',label:'Explicit synthetic fourth selection',statPoints:points({hp:2,atk:32,spe:32})});
  // Current-mode PP is exact authored state. A shared value of twelve from the
  // generic fixture exceeds the native maximum of some registered moves.
  for(const hypothesis of [...Object.values(f.hypotheses.own),...Object.values(f.hypotheses.opposing),...f.hypotheses.reserves])hypothesis.pp=[1,1,1,1];
  for(const active of f.observed.actions[0].legalActions.active)for(const move of active.moves)move.pp=1;
  const own=board.sides.find(side=>side.id==='p1');own.selectionKnowledge='current-own-request';
  for(const pokemon of own.pokemon)pokemon.selection='selected';
  return f;
}

test('authored delivery goals use actual MCP to distinguish a delivered attack from a denied sound partner',async t=>{
  const cacheRoot=fileURLToPath(new URL('../cache/',import.meta.url));await mkdir(cacheRoot,{recursive:true});
  const workspace=await mkdtemp(join(cacheRoot,'vgc-paired-progress-native-')),f=pairedFixture();
  t.after(()=>{
    const target=resolve(workspace),temporaryRoot=resolve(cacheRoot);
    assert.equal(dirname(target),temporaryRoot);assert.ok(target.startsWith(join(temporaryRoot,'vgc-paired-progress-native-')));
    return rm(target,{recursive:true,force:true});
  });
  // This fixture tests native MCP delivery, not immutable snapshot publication.
  // Preseed its isolated export; registration still validates its legality/hash.
  const teamsDirectory=join(workspace,'cache','team-metrics','teams');await mkdir(teamsDirectory,{recursive:true});
  await writeFile(join(teamsDirectory,f.expected.teamId+'.txt'),f.teamText,{flag:'wx'});
  const {teamId}=await registerTeamFromText({workspace,teamText:f.teamText,name:'Isolated paired progress native fixture'});
  assert.equal(teamId,f.expected.teamId);
  const state={...structuredClone(f.observed),teamSha256:teamId,connected:true,authenticated:true,stopped:false};
  const identity={sessionId:state.sessionId,teamId},commands=[];
  const source={turnSnapshot:()=>structuredClone(state),snapshot:()=>({sessionId:identity.sessionId,teamSha256:teamId,
    rooms:[{id:f.expected.room,sheets:{p2:Teams.pack(f.opposingSheet.map(set=>({...set,level:50})))}}]})};
  const descriptorPath=join(workspace,'cache','showdown-session.json');
  const bridge=await serveLocalSession({id:identity.sessionId,execute(command){
    commands.push(structuredClone(command));
    assert.ok(['turn-status','status'].includes(command.op),'Actual native research may only read the isolated current source');
    return AgentSession.prototype.execute.call(source,command);
  }},{descriptorPath});
  const client=new Client({name:'paired-progress-native-regression',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[fixtureServer,workspace]});let serverPid;
  const actions=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:2}];
  const branches=[
    {id:'sound-partner-denied',opposingActions:[{type:'move',slot:2,target:2},{type:'move',slot:4,target:1}]},
    {id:'sound-partner-not-targeted',opposingActions:[{type:'move',slot:2,target:1},{type:'move',slot:4,target:1}]},
  ];
  const seeds=[[1,2,3,4],[5,6,7,8]],normalizedHypotheses=observedHypothesesSchema.parse(f.hypotheses);
  const stateBefore=structuredClone(state),fixtureBefore=structuredClone(f),actionsBefore=structuredClone(actions),branchesBefore=structuredClone(branches);
  try{
    await client.connect(transport);serverPid=transport.pid;assert.ok(Number.isInteger(serverPid));
    const tool=(await client.listTools()).tools.find(tool=>tool.name==='battle_check_plan');
    assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.additionalProperties,false);
    const checks=[];
    for(const branch of branches)for(const actorId of ['own0','own1']){
      const call={name:'battle_check_plan',args:{request:{kind:'observed',source:{...f.expected,sessionId:identity.sessionId,teamId,
        opposingSheetSha256:publishedSheetDigest(f.opposingSheet)},hypotheses:structuredClone(normalizedHypotheses),
        branches:[{...structuredClone(branch),ourActions:structuredClone(actions),gate:{kind:'delivery',requiredActionsBy:[actorId]}}],seeds:structuredClone(seeds)},budgetMs:3500}};
      const authored=structuredClone(call.args);
      const beforeReads=commands.length,reply=await client.callTool({name:call.name,arguments:call.args});
      assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=decode(reply);
      assert.equal(result.coverage.checkedCandidates,1,JSON.stringify(result));assert.equal(result.coverage.sampleOnly,true);
      assert.equal(result.coverage.suppliedOpposingBranchesOnly,true);assert.deepEqual(result.hypotheses,normalizedHypotheses);
      const candidate=result.checkedCandidates[0];assert.equal(candidate.status,actorId==='own1'&&branch.id==='sound-partner-denied'?'sampled-failure':'sampled-pass',JSON.stringify(candidate));
      assert.deepEqual(candidate.ourActions,actions);assert.deepEqual(candidate.seeds,seeds);
      assert.deepEqual(commands.slice(beforeReads).map(command=>command.op).sort(),['status','turn-status','turn-status']);
      for(const field of ['chosenAction','chosenActions','selectedCandidate','selection','sent'])assert.equal(Object.hasOwn(result,field),false);
      const evidenceReply=await client.callTool({name:'battle_calculation_evidence',arguments:{teamId,id:candidate.calculationRef.id}});
      assert.equal(evidenceReply.isError,undefined,JSON.stringify(evidenceReply));const evidence=decode(evidenceReply);
      assert.equal(evidence.tool,'simulate_turn');assert.deepEqual(evidence.input.request,call.args.request);
      assert.equal(evidence.result.engine.gen,0);assert.equal(evidence.result.engine.format,'gen9championsvgc2026regmc');
      assert.deepEqual(evidence.result.submittedBranches,call.args.request.branches);assert.equal(evidence.result.samples.length,seeds.length);
      assert.match(evidence.result.loadedManifest.modules['simulation/turn-worker.mjs'],/^[a-f0-9]{64}$/);
      for(const sample of evidence.result.samples){
        assert.equal(sample.accepted.p1.accepted,true);assert.equal(sample.accepted.p2.accepted,true);
        assert.equal(sample.boundary,'next-turn');assert.equal(sample.noPendingContinuation,true);assert.deepEqual(sample.pendingActions,[]);
        assert.ok(!sample.events.some(event=>event.type==='faint'),'A knockout or replacement must not stand in for sound denial');
        const own0=sample.actionOutcomes.find(action=>action.id==='own0'),own1=sample.actionOutcomes.find(action=>action.id==='own1');
        assert.equal(own0.attemptedMove,'Dragon Pulse');assert.equal(own0.resolution.nativeMoveResult,true);
        assert.equal(own0.faintedBeforeAction,false);assert.equal(own0.pendingAtBoundary,false);
        const selected=sample.gate.requiredActions.find(goal=>goal.id===actorId);
        if(sample.branchId==='sound-partner-denied'){
          assert.equal(own1.resolution.nativeMoveResult,false);
          assert.ok(own1.denied.some(event=>event.type==='cant'&&event.raw.includes('Throat Chop')),JSON.stringify(own1));
          const throat=sample.events.find(event=>event.type==='move'&&event.actorId==='foe0'&&event.move==='Throat Chop');
          const stopped=sample.events.find(event=>event.type==='cant'&&event.actorId==='own1'&&event.raw.includes('Throat Chop'));
          assert.ok(throat&&stopped&&throat.index<stopped.index,'Actual native sequence must place Throat Chop before the denied sound action');
          assert.equal(selected.status,actorId==='own1'?'failed':'passed');
        }else{
          assert.equal(sample.branchId,'sound-partner-not-targeted');assert.equal(own1.attemptedMove,'Psychic Noise');
          assert.equal(own1.resolution.nativeMoveResult,true);assert.equal(own1.denied.length,0);assert.equal(selected.status,'passed');
        }
      }
      checks.push({actorId,branchId:branch.id,result,evidence});assert.deepEqual(call.args,authored);
    }
    assert.ok(checks[1].result.uncoveredRequiredActors.every(row=>row.actorId==='own1'&&row.branchId==='sound-partner-denied'&&row.status==='failed'));
    assert.equal(checks[1].result.uncoveredRequiredActors.length,seeds.length);
    // Changing only the explicitly chosen dependency changes the gate, not the
    // board, hypotheses, complete own pair or opposing paired actions.
    const first=checks[0].evidence.input.request,second=checks[1].evidence.input.request;
    assert.deepEqual(first.branches.map(({gate,...branch})=>branch),second.branches.map(({gate,...branch})=>branch));
    assert.deepEqual(first.hypotheses,second.hypotheses);assert.deepEqual(first.source,second.source);
    assert.deepEqual(state,stateBefore);assert.deepEqual(f,fixtureBefore);assert.deepEqual(actions,actionsBefore);assert.deepEqual(branches,branchesBefore);
    assert.ok(commands.every(command=>['turn-status','status'].includes(command.op)));assert.equal(new Set(commands.map(command=>command.id)).size,commands.length);
  }finally{
    for(const settled of await Promise.allSettled([client.close(),bridge.close()]))assert.equal(settled.status,'fulfilled',settled.reason?.message);
    assert.equal(transport.pid,null);
    if(serverPid)assert.throws(()=>process.kill(serverPid,0),error=>error.code==='ESRCH','Owned SDK fixture server must exit after awaited close');
    await assert.rejects(readFile(descriptorPath),error=>error.code==='ENOENT');
  }
});
