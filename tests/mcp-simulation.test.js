import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openingFixture,currentFixture} from '../simulation/fixtures.mjs';
import {registerTeamFromText} from '../metrics/import.mjs';
import {fixture as observedFixture} from '../simulation/observed-position.fixtures.mjs';
import {serveLocalSession} from '../showdown/local-bridge.mjs';
import {AgentSession} from '../showdown/agent-session.mjs';
import {createOwnedSimulationFixture} from '../simulation/owned-choice-fixture.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const decode=result=>result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);

test('compact MCP uses real owned history across IPC and archives native samples while the author supplies only choices',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-compact-native-')),f=await createOwnedSimulationFixture({itemless:true});
  let bridge,client;try{
    const {teamId}=await registerTeamFromText({workspace,teamText:Teams.export(Teams.unpack(f.session.packed)),name:'Synthetic owned compact source'});
    const source=f.source();assert.equal(source.teamId,teamId);
    const commands=[],execute=f.session.execute.bind(f.session);
    f.session.execute=(command,options)=>{commands.push(structuredClone(command));return execute(command,options);};
    bridge=await serveLocalSession(f.session,{descriptorPath:join(workspace,'cache','showdown-session.json')});
    client=new Client({name:'compact-native-history-test',version:'1'},{capabilities:{}});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/simulation-mcp-server.mjs',import.meta.url)),workspace]}));
    const pair=[{type:'move',slot:4},{type:'move',slot:4}],before=f.sent.length,started=Date.now();
    const reply=await client.callTool({name:'simulate_choices',arguments:{source,ourActions:pair,opposingActions:pair,evidenceContext:{teamId,roomId:source.room,turn:1}}});
    assert.equal(reply.isError,undefined,JSON.stringify(reply));const result=decode(reply);
    assert.equal(result.kind,'native-choice-outcome-v1');assert.equal(result.coverage.worlds,1);assert.equal(result.coverage.tacticalGoalEvaluated,false);
    assert.equal(result.coverage.samples,1);assert.equal(result.worlds,undefined);assert(result.outcome.final.sides.length===2);assert.equal(f.sent.length,before);
    assert.deepEqual(commands.filter(command=>command.op==='simulation-context').map(command=>command.op),['simulation-context','simulation-context','simulation-context']);
    assert.deepEqual(commands.filter(command=>command.op!=='simulation-context').map(command=>command.op),['research-reserve','research-settle']);
    const retained=decode(await client.callTool({name:'battle_calculation_evidence',arguments:{teamId,id:result.calculationRef.id}}));
    assert.equal(retained.tool,'simulate_choices');assert.equal(retained.input.assembly.coverage.completeHistory,true);
    assert.equal(retained.input.assembly.coverage.auditedHistory,true);assert.equal(retained.result.nativeResults.length,1);
    const history=retained.input.assembly.facts.nativeHistory;
    assert.equal(history.kind,'source-bound-native-history-v1');assert.equal(history.completeHistory,true);
    assert.equal(history.sides.p1.totalFainted,0);assert.equal(history.sides.p2.totalFainted,0);
    for(const world of retained.input.normalized){
      assert(world.provenance.nativeHistory.known.length>0,'Native counters are assembled by the script, not authored by the model');
      assert(world.core.position.sides.every(side=>side.nativeState.totalFainted===0));
      for(const side of world.core.position.sides)for(const p of side.pokemon)if(history.pokemon[p.id]?.timesAttacked!==undefined)assert.equal(p.nativeState.timesAttacked,history.pokemon[p.id].timesAttacked);
    }
    assert.deepEqual(retained.input.request.ourActions,pair);assert.equal(retained.result.source.choiceAuthority,false);
    console.log(JSON.stringify({kind:'compact-native-MCP-IPC',elapsedMs:Date.now()-started,worlds:1,liveBattleCalls:0,source:'synthetic-pinned-native-history'}));
  }finally{await client?.close();await bridge?.close();f.close();await rm(workspace,{recursive:true,force:true});}
});
test('actual maintained MCP registers native paired simulation and retains exact retrievable team-owned evidence',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-native-simulation-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const fixture=openingFixture(),sets=[...fixture.position.sides[0].pokemon,...fixture.position.sides[1].pokemon.slice(0,2)].map(p=>({...p,level:50,evs:p.statPoints}));
  const {teamId}=await registerTeamFromText({workspace,teamText:Teams.export(sets),name:'Isolated simulator fixture'});
  const client=new Client({name:'native-simulator-tests',version:'1'},{capabilities:{}});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/simulation-mcp-server.mjs',import.meta.url)),workspace]}));
  const entry=(await client.listTools()).tools.find(tool=>tool.name==='simulate_turn');assert.ok(entry);assert.equal(entry.annotations.readOnlyHint,true);assert.equal(entry.inputSchema.additionalProperties,false);
  const evidenceContext={teamId,roomId:'battle-gen9championsvgc2026regmcbo3-123',turn:1},args={request:{kind:'explicit',...fixture},evidenceContext};
  const actual=await client.callTool({name:'simulate_turn',arguments:args});assert.equal(actual.isError,undefined,JSON.stringify(actual));const result=decode(actual);
  assert.equal(result.engine.gen,0);assert.equal(result.engine.format,'gen9championsvgc2026regmc');assert.deepEqual(result.samples[0].events.filter(e=>e.type==='move').map(e=>e.actorId),['arch','raichu','rilla','fari']);assert.equal(result.samples[0].gate.passed,false);assert.equal(result.source.liveFreshness,false);
  for(const file of ['mcp-tools.mjs','observed-position.mjs','turn-worker.mjs','turn-simulator.mjs'])assert.match(result.loadedManifest.modules['simulation/'+file],/^[a-f0-9]{64}$/);
  const retained=decode(await client.callTool({name:'battle_calculation_evidence',arguments:{teamId,id:result.calculationRef.id}}));assert.equal(retained.tool,'simulate_turn');assert.deepEqual(retained.input.normalized,fixture);assert.deepEqual(retained.result.samples,result.samples);assert.equal(retained.roomId,evidenceContext.roomId);
  const broad=currentFixture();broad.position.sides[0].pokemon[0].moves[0]='Hyper Beam';broad.position.sides[0].pokemon[0].pp[0]=1;
  broad.position.sides[0].pokemon[1].nativeState={volatiles:{taunt:{state:{duration:2},sourceId:'raichu'}}};
  broad.position.sides[1].pokemon[0].ability='Static';broad.position.sides[1].pokemon[0].status='slp';
  broad.position.sides[1].pokemon[1].moves[3]='Protect';broad.position.sides[1].pokemon[1].pp[3]=1;
  broad.branches[0].ourActions=[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}];
  broad.branches[0].opposingActions=[{type:'move',slot:4},{type:'move',slot:4}];
  const broadReply=await client.callTool({name:'simulate_turn',arguments:{request:{kind:'explicit',...broad}}});assert.equal(broadReply.isError,undefined,JSON.stringify(broadReply));
  const broadSample=decode(broadReply).samples[0];assert(broadSample.events.some(e=>e.type==='move'&&e.move==='Hyper Beam'));
  assert.equal(broadSample.start.sides[1].pokemon[0].ability,'Static');assert.equal(broadSample.start.sides[1].pokemon[0].status,'slp');
  assert.equal(broadSample.start.sides[0].pokemon[1].volatiles.taunt.remainingTurns,2);assert.equal(broadSample.stateCoverage.complete,false);assert.equal(broadSample.gate.passed,false);
  for(const context of [{...evidenceContext,turn:2},{...evidenceContext,roomId:'game-bestof3-gen9championsvgc2026regmcbo3-123'},{...evidenceContext,roomId:evidenceContext.roomId+'-privatepw'}])assert.equal((await client.callTool({name:'simulate_turn',arguments:{...args,evidenceContext:context}})).isError,true);
  const omitted=structuredClone(args);omitted.request.branches[0].opposingActions.pop();assert.equal((await client.callTool({name:'simulate_turn',arguments:omitted})).isError,true);
});

test('production MCP advertises actual simulate_turn alongside numerical calculators without control calls',async t=>{
  const client=new Client({name:'native-simulator-production-registration',version:'1'},{capabilities:{}});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))]}));
  const names=(await client.listTools()).tools.map(tool=>tool.name);for(const name of ['simulate_turn','calculate_damage','calculate_speed'])assert.ok(names.includes(name));
  const result=decode(await client.callTool({name:'simulate_turn',arguments:{request:{kind:'explicit',...openingFixture()}}}));assert.equal(result.samples[0].gate.targetKOBeforeRetaliation,false);assert.equal(result.calculationRef,undefined);
  const current=currentFixture();current.position.sides[1].pokemon[0].hp='observed-high';current.position.sides[1].pokemon[0].observedHp={current:11,max:100,precision:'server-display'};const hp=await client.callTool({name:'simulate_turn',arguments:{request:{kind:'explicit',...current}}});assert.equal(hp.isError,undefined);const candidate=decode(hp).samples[0].hpHypotheses[0];assert.equal(candidate.selectedHp,candidate.maxCompatibleHp);assert.ok(candidate.compatibleCount>0);assert.match(candidate.limitation,/not globally conservative or safe/);
});

test('a read-only observed snapshot cannot bypass native per-turn research authority',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-native-observed-')),f=observedFixture();
  const {teamId}=await registerTeamFromText({workspace,teamText:f.teamText,name:'Isolated observed simulation'});
  assert.equal(teamId,f.expected.teamId);
  const commands=[],source={
    turnSnapshot:()=>structuredClone(f.observed),
    snapshot:()=>({sessionId:f.observed.sessionId,teamSha256:teamId,rooms:[{id:f.expected.room,sheets:{p2:Teams.pack(f.opposingSheet.map(set=>({...set,level:50})))}}]}),
  };
  const session={id:f.observed.sessionId,execute(command){
    commands.push(structuredClone(command));
    assert.ok(['turn-status','status'].includes(command.op),'Simulation must only read the offline source');
    return AgentSession.prototype.execute.call(source,command);
  }};
  const bridge=await serveLocalSession(session,{descriptorPath:join(workspace,'cache','showdown-session.json')});
  const client=new Client({name:'observed-native-simulator-tests',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/simulation-mcp-server.mjs',import.meta.url)),workspace]}));
    const roomId=f.expected.room.replace(/-[a-z0-9]+pw$/u,'');
    const args={request:{kind:'observed',source:{...f.expected,sessionId:f.observed.sessionId},hypotheses:f.hypotheses,seeds:[[1,2,3,4]],branches:[{
      id:'actual-observed-pair',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],gate:{targetId:'foe0',beforeActionsOf:['foe0'],requiredActionsBy:['own0','own1']},
    }]},evidenceContext:{teamId,roomId,turn:1}};
    const reply=await client.callTool({name:'simulate_turn',arguments:args});
    assert.equal(reply.isError,true);const result=decode(reply);
    assert.equal(result.kind,'research-budget-unavailable');assert.equal(result.choiceAuthority,false);
    assert.match(result.reason,/host-bound researchContext/u);
    assert.deepEqual(commands.map(command=>command.op),['status']);
    assert.equal(result.calculationRef,undefined,'no native calculation or receipt was fabricated');
  }finally{
    await client.close();await bridge.close();await rm(workspace,{recursive:true,force:true});
  }
});
