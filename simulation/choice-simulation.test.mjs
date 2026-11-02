import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {executeSimulationChoices,registerSimulationChoicesTool} from './choice-simulation.mjs';
import {simulationChoicesAuthorSchema} from './choice-schemas.mjs';
import {registerSimulationTools} from './mcp-tools.mjs';
import {simulateNativeTurn} from './turn-simulator.mjs';
import {currentFixture} from './observed-position.fixtures.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {packCalculationPayload,unpackCalculationPayload} from '../workflow/calculation-archive.mjs';

const {Teams,Dex}=createRequire(import.meta.url)('pokemon-showdown'),dex=Dex.mod('champions');
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value),key=value=>value.toLowerCase().replace(/[^a-z0-9]/gu,'');
const pp=moves=>moves.map(name=>{const m=dex.moves.get(name);return dex.data.Scripts.calculatePP.call({gen:9},m,m.noPPBoosts||m.id==='trumpcard'?0:3);});
const life={activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false};
const boosts={atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0};

function fixture(){
  const f=currentFixture(),source={sessionId:f.observed.sessionId,...f.expected},board=f.observed.boards[0],own=Teams.import(f.teamText);
  board.turn=2;f.observed.teamSha256=source.teamId;
  for(const [i,active]of f.observed.actions[0].legalActions.active.entries()){
    const set=own.find(p=>p.species===board.sides[0].pokemon[i].species),values=pp(set.moves);
    active.moves.forEach((move,j)=>move.pp=values[j]);f.hypotheses.own[board.sides[0].pokemon[i].id].pp=values;
  }
  for(const actor of board.sides[0].pokemon){const set=own.find(p=>p.species===actor.species);f.hypotheses.own[actor.id].pp=pp(set.moves);}
  for(const actor of board.sides[1].pokemon){const set=f.opposingSheet.find(p=>p.species===actor.species);f.hypotheses.opposing[actor.id].pp=pp(set.moves);delete f.hypotheses.opposing[actor.id].statPoints;delete f.hypotheses.opposing[actor.id].hp;}
  f.hypotheses.reserves=[];
  const observedHash=sha(f.observed),assembly={kind:'mechanical-choice-state-v1',schemaVersion:1,binding:{...source,sourceSha256:'b'.repeat(64),observedSha256:observedHash,assembledObservedSha256:observedHash,historySha256:'c'.repeat(64),sequence:20},hypotheses:f.hypotheses,observedOverrides:[],unknowns:[],provenance:[],coverage:{completeHistory:true,auditedHistory:true,unsupportedCurrentState:false},facts:{actors:[],field:board.field,reserveEligibility:f.opposingSheet.filter(set=>!board.sides[1].pokemon.some(p=>p.species===set.species)).map(set=>({species:set.species,eligible:true,conditionalOn:'selected-unrevealed-and-never-entered',notSelectionEvidence:true,hp:'full',status:'',boosts:copy(boosts),pp:pp(set.moves),lifecycle:copy(life),volatiles:{},ability:set.ability,item:set.item,abilitySuppressed:false,origin:'audited-complete-native-history-never-entered'}))}};
  const context={kind:'owned-simulation-context-v1',semanticSha256:'f'.repeat(64),source,observed:f.observed,opposingSheet:f.opposingSheet,assembly,liveFreshness:true,choiceAuthority:false,frozenAt:Date.now()},reads=[],calls=[],evidence=[];
  const args={source,ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],evidenceContext:{teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn:2}};
  const native=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>native.set(name,handler)},{run:simulateNativeTurn});
  const options={researchPolicy:'offline-multi',workspace:'offline-synthetic-only',loadTeam:async()=>({team:own}),call:async(_file,command)=>{reads.push(copy(command));return {ok:true,result:copy(context)};},callTool:async(name,input,extra)=>{calls.push({name,input:copy(input),extra});return native.get(name)(input,extra);},recordEvidence:async entry=>{evidence.push(copy(entry));return {tool:'simulate_choices',teamId:source.teamId,sha256:'d'.repeat(64)};}};
  return {f,context,args,options,reads,calls,evidence,rehash:()=>{context.assembly.binding.observedSha256=sha(context.observed);context.assembly.binding.assembledObservedSha256=sha(context.observed);}};
}

test('compact author contract allows only pairs and rejects state, seeds, gates and source injection',()=>{
  const {source,evidenceContext,...author}=fixture().args;assert.equal(simulationChoicesAuthorSchema.safeParse(author).success,true);
  for(const key of ['position','hypotheses','seeds','gate','source','analysis','numericPolicy'])assert.equal(simulationChoicesAuthorSchema.safeParse({...author,[key]:{}}).success,false);
  for(const action of [{type:'switch',slot:3,species:'Politoed'},{type:'move',slot:5},{type:'switch'}])assert.equal(simulationChoicesAuthorSchema.safeParse({...author,ourActions:[action,{type:'pass'}]}).success,false);
});

test('native facade builds source-bound worlds and invokes registered native simulation without action or control mutation',async t=>{
  const f=fixture(),before=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.deepEqual(f.args,before);
  assert.equal(result.coverage.worlds,3);assert.equal(result.coverage.tacticalGoalEvaluated,false);assert.equal(result.coverage.sdkQualificationClaimed,false);
  assert.equal(result.source.liveFreshness,true);assert.equal(result.source.choiceAuthority,false);
  assert.deepEqual(f.reads.map(r=>r.op),['simulation-context','simulation-context','simulation-context']);
  assert.equal(new Set(f.reads.map(r=>r.id)).size,3);assert.deepEqual(f.calls.map(c=>c.name),['simulate_turn','simulate_turn','simulate_turn']);
  assert(f.calls.every(c=>c.input.request.kind==='explicit'&&!c.input.evidenceContext&&c.extra.signal instanceof AbortSignal));
  assert.deepEqual(f.calls.map(c=>c.input.request.position.sides[1].pokemon.find(p=>p.observedHp).hp),['observed-high','observed-low','observed-high']);
  assert.deepEqual(result.worlds.map(w=>w.profiles.find(p=>p.id==='foe0').family),['special-speed','physical-bulk','special-bulk']);
  assert(result.worlds.some(w=>w.assumptions.some(a=>a.includes('remaining turns'))));
  assert(result.worlds.every(w=>w.samples.every(s=>!Object.hasOwn(s,'gate')&&s.events.length&&s.actionOutcomes.length===4)));
  assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].tool,'simulate_choices');assert.equal(f.evidence[0].result.nativeResults.length,3);
  assert.equal(f.evidence[0].input.normalized.length,3);assert.equal(f.evidence[0].result.nativeResults[0].samples[0].gate.kind,'delivery');
  assert(!Object.hasOwn(result,'summary'));assert(!JSON.stringify(result).includes('allGatesPassed'));
  const payload={input:f.evidence[0].input,result:f.evidence[0].result},packed=packCalculationPayload({tool:'simulate_choices',...payload});
  assert.deepEqual(unpackCalculationPayload({tool:'simulate_choices',...packed}),payload);
  t.diagnostic(`Actual native facade evidence: ${Buffer.byteLength(JSON.stringify(payload))} raw bytes; ${Buffer.byteLength(JSON.stringify(packed))} stored bytes.`);
});

test('missing native state coverage cannot be promoted to complete reconstruction',async()=>{
  const f=fixture(),call=f.options.callTool;
  f.options.callTool=async(...args)=>{
    const reply=await call(...args);
    for(const sample of reply.structuredContent.samples)delete sample.stateCoverage;
    reply.content=[{type:'text',text:JSON.stringify(reply.structuredContent)}];
    return reply;
  };
  const result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  assert.equal(result.coverage.completeBranchCoverage,true);
  assert.equal(result.coverage.completeStateReconstruction,false);
  assert.equal(result.coverage.stateCoverageUnavailableSamples,3);
});

test('native and owned switch identities are bound, including authored unseen opponent selection',async()=>{
  const f=fixture();f.args.ourActions=[{type:'switch',species:'Politoed'},{type:'move',slot:3}];f.args.opposingActions=[{type:'switch',species:'Volcarona'},{type:'move',slot:4,target:1}];
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  for(const call of f.calls){const branch=call.input.request.branches[0];assert.match(branch.ourActions[0].pokemonId,/^pokemon-/u);assert.match(branch.opposingActions[0].pokemonId,/^hypothetical-/u);const reserve=call.input.request.position.sides[1].pokemon.find(p=>p.id===branch.opposingActions[0].pokemonId);assert.equal(reserve.species,'Volcarona');}
  assert(result.worlds.every(w=>w.assumptions.some(a=>a.includes('Volcarona')&&a.includes('authored-switch-selection-hypothesis'))));
});

test('unknown nature stays explicitly hypothetical while published known natures remain fixed',async()=>{
  const f=fixture();for(const name of ['Raichu','Rillaboom'])for(const sheet of [f.context.opposingSheet,f.context.observed.opponentSheets.p2])sheet.find(p=>p.species===name).nature=null;f.rehash();
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  assert.deepEqual(result.worlds.map(w=>w.profiles.find(p=>p.id==='foe0').nature),['Timid','Bold','Calm']);
  assert(result.worlds.every(w=>w.profiles.find(p=>p.id==='foe0').natureSource==='explicit-representative-hypothesis'));
  assert(result.worlds.every(w=>w.profiles.filter(p=>!['foe0','foe1'].includes(p.id)).every(p=>p.natureSource==='published-known')));
  assert.equal(f.context.opposingSheet.find(p=>p.species==='Raichu').nature,null);
});

test('fuzzy spread domains keep whole legal assignments and return native sampled damage/HP ranges',async()=>{
  const f=fixture(),points=patch=>({hp:0,atk:0,def:0,spa:0,spd:0,spe:0,...patch}),nature=f.context.opposingSheet.find(p=>p.species==='Raichu').nature;
  f.args.spreadRanges=[{pokemonId:'foe0',domain:{kind:'candidates',label:'Two unobserved legal allocations',candidates:[
    {nature,statPoints:points({hp:32,spa:32,spd:2})},
    {nature,statPoints:points({hp:32,spd:2,spe:32})},
  ]}}];
  const before=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.deepEqual(f.args,before);
  assert.equal(result.spreadRangeCoverage[0].legalCount,'2');assert.equal(result.spreadRangeCoverage[0].returned,2);
  const supplied=f.args.spreadRanges[0].domain.candidates;
  for(const call of f.calls){const actor=call.input.request.position.sides[1].pokemon.find(p=>p.id==='foe0');assert(supplied.some(c=>JSON.stringify(c.statPoints)===JSON.stringify(actor.statPoints)));}
  assert.equal(result.turnRanges.sampleCount,3);assert.equal(result.turnRanges.exhaustive,false);assert.equal(result.turnRanges.koProbability,false);
  assert(result.turnRanges.actors.some(row=>row.damageTaken.min<row.damageTaken.max));
  assert(result.turnRanges.actors.every(row=>row.observations.length===3&&row.observations.every(o=>o.worldId&&o.seed)));
  assert.equal(f.evidence[0].input.sourceCapture.contextSha256.length,64);
});

test('ranged points and unknown natures are hypotheses; duplicates, own actor IDs and published-nature conflicts refuse',async()=>{
  const domain={kind:'ranges',label:'Unobserved full legal point domain',natures:['Timid'],statPoints:Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(s=>[s,{min:0,max:32}])),total:{min:66,max:66}};
  const f=fixture();f.args.spreadRanges=[{pokemonId:'foe0',domain}];const result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.spreadRangeCoverage[0].exhaustive,false);assert(BigInt(result.spreadRangeCoverage[0].legalCount)>3n);
  for(const change of [g=>g.args.spreadRanges.push(copy(g.args.spreadRanges[0])),g=>g.args.spreadRanges[0].pokemonId='own0',g=>g.args.spreadRanges[0].domain.natures=['Adamant']]){
    const g=fixture();g.args.spreadRanges=[{pokemonId:'foe0',domain:copy(domain)}];change(g);const refused=await executeSimulationChoices(g.args,g.options);assert.equal(refused.kind,'simulation-choices-unavailable');assert.equal(g.calls.length,0);assert.equal(refused.samples,undefined);
  }
});

test('conditional lifecycle simulation does not manufacture durable evidence when its writer fails',async()=>{
  const f=fixture();delete f.context.assembly.hypotheses.own.own0.lifecycle;f.options.recordEvidence=async()=>{throw Error('private writer unavailable');};
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(result.researchOutcome,'unavailable');assert.equal(result.stage,'evidence');assert.match(result.reason,/private writer unavailable/u);assert.equal(f.calls.length,3);assert.equal(result.calculationRef,undefined);assert.equal(result.worlds,undefined);
});

test('native explicit no-item sheet value survives strict reconstruction and actual resolution',async()=>{
  const f=fixture();for(const sheet of [f.context.opposingSheet,f.context.observed.opponentSheets.p2])sheet.find(p=>p.species==='Raichu').item='';
  f.context.assembly.hypotheses.opposing.foe0.item='';f.args.opposingActions[0]={type:'move',slot:4};f.rehash();
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  for(const world of result.worlds)assert.equal(world.initialState.sides[1].pokemon.find(p=>p.id==='foe0').item,'');
  assert(f.evidence[0].input.normalized.every(world=>world.core.position.sides[1].pokemon.find(p=>p.id==='foe0').item===''));
});

test('exact Toxic Spikes layers stay fixed while incomplete layer state is explicitly conditional',async()=>{
  for(const layers of [1,2]){
    const f=fixture();f.context.observed.boards[0].sides[0].conditions.toxicspikes={name:'Toxic Spikes',layers,duration:null,remainingTurns:null};f.rehash();
    const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.coverage.completeBranchCoverage,true);
    for(const call of f.calls)assert.deepEqual(call.input.request.position.sides[0].conditions.toxicspikes,{layers});
    for(const world of result.worlds)assert.deepEqual(world.initialState.sides[0].conditions.toxicspikes,{layers});
  }
  for(const layers of [undefined,null,0,3,1.5]){
    const f=fixture();f.context.observed.boards[0].sides[0].conditions.toxicspikes={name:'Toxic Spikes',layers,duration:null,remainingTurns:null};f.rehash();
    const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(f.calls.length,3);assert.equal(result.coverage.completeStateReconstruction,false);
    assert(result.worlds.every(world=>[...world.stateAssumptions,...world.samples.flatMap(sample=>sample.stateCoverage.assumptions)].some(row=>row.path.includes('toxicspikes')&&(row.path.endsWith('.layers')||/layer/iu.test(row.reason))&&/unknown|invalid|hypothes|unavailable/iu.test(row.reason))),`Toxic Spikes layers ${layers} need a field-specific public assumption`);
    assert(result.worlds.every(world=>world.samples.every(sample=>sample.stateCoverage.complete===false)));
  }
});

test('unseen reserve candidates retain native abilities without filtering either fillers or authored switches',async()=>{
  const f=fixture(),old=f.context.opposingSheet.find(p=>p.species==='Basculegion');
  const change={species:'Gholdengo',nature:'Timid',ability:'Good as Gold',item:old.item,moves:['Make It Rain','Shadow Ball','Thunderbolt','Protect']};
  for(const sheet of [f.context.opposingSheet,f.context.observed.opponentSheets.p2])Object.assign(sheet.find(p=>p.species==='Basculegion'),copy(change));
  const proof=f.context.assembly.facts.reserveEligibility.find(p=>p.species==='Basculegion');Object.assign(proof,{species:change.species,ability:change.ability,item:change.item,pp:pp(change.moves)});f.rehash();
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert(result.worlds.every(w=>!w.assumptions.some(a=>a.includes('excludes Gholdengo'))));
  assert(f.calls.every(c=>c.input.request.position.sides[1].pokemon.some(p=>p.species==='Gholdengo'&&p.ability==='Good as Gold')));
  f.args.opposingActions[0]={type:'switch',species:'Gholdengo'};f.calls.length=0;
  const before=copy(f.args),authored=await executeSimulationChoices(f.args,f.options);assert.equal(authored.kind,'native-choice-simulation-v1',authored.reason);assert.deepEqual(f.args,before);assert.equal(f.calls.length,3);
  for(const call of f.calls){const branch=call.input.request.branches[0],entrant=call.input.request.position.sides[1].pokemon.find(p=>p.id===branch.opposingActions[0].pokemonId);assert.equal(entrant.species,'Gholdengo');assert.equal(entrant.ability,'Good as Gold');}
});

test('alternative model-authored pairs share one strict world start and deterministic source seeds',async()=>{
  const f=fixture();f.args.alternatives=[{id:'switch-room',ourActions:[{type:'switch',slot:3},{type:'move',slot:3}],opposingActions:[{type:'move',slot:3,target:2},{type:'move',slot:1,target:1}]}];
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.coverage.samples,6);
  for(const world of result.worlds){assert(world.initialState.sides.length===2);assert.deepEqual(world.samples.map(s=>s.branchId),['primary','switch-room']);assert(world.samples.every(s=>!s.start&&!s.gate));assert.deepEqual(world.samples[0].seed,world.samples[1].seed);}
  const g=fixture(),second=await executeSimulationChoices(g.args,g.options);assert.deepEqual(result.worlds.map(w=>w.samples[0].seed),second.worlds.map(w=>w.samples[0].seed));
});

test('all supported three-branch worlds use only three calls and losslessly archive every original native reply',async()=>{
  const f=fixture();f.args.alternatives=['same-authored-a','same-authored-b'].map(id=>({id,ourActions:copy(f.args.ourActions),opposingActions:copy(f.args.opposingActions)}));
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.coverage.completeBranchCoverage,true);assert.equal(result.coverage.samples,9);assert.equal(f.calls.length,3);assert.equal(f.reads.length,3);
  assert(result.worlds.every(world=>world.branchResults.every(branch=>branch.status==='returned')));
  const record=f.evidence[0],payload={input:record.input,result:record.result},packed=packCalculationPayload({tool:'simulate_choices',...payload});
  assert(packed.payloadArchive);assert(Buffer.byteLength(JSON.stringify(packed))<508*1024);assert.deepEqual(unpackCalculationPayload({tool:'simulate_choices',...packed}),payload);
  assert.equal(record.input.nativeCalls.length,3);assert(record.input.nativeCalls.every(call=>call.result.structuredContent.samples.length===3));
});

test('real registered worker-backed native resolution retains bounded compact source provenance offline',async()=>{
  const f=fixture(),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{});
  f.options.callTool=(name,input,extra)=>tools.get(name)(input,extra);
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.engine.format,'gen9championsvgc2026regmc');assert.equal(f.evidence.length,1);assert(result.worlds.every(w=>w.samples.length===1));
});

test('clickable pairs with Taunt, Substitute, copied ability and sleep reach registered native workers as conditional state',{timeout:15000},async()=>{
  const f=fixture(),board=f.context.observed.boards[0],legal=f.context.observed.actions[0].legalActions;
  const archaludon=board.sides[0].pokemon[0],farigiraf=board.sides[0].pokemon[1],rillaboom=board.sides[1].pokemon[1];
  archaludon.ability='Prankster';legal.pokemon[0].ability='Prankster';
  archaludon.status='slp';legal.pokemon[0].condition='165/165 slp';
  farigiraf.volatiles.taunt={name:'Taunt',remainingTurns:{min:1,max:3}};
  rillaboom.volatiles.substitute={name:'Substitute'};
  f.context.assembly.coverage.unsupportedCurrentState=true;f.rehash();
  const before=copy(f.args),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{});
  f.options.callTool=async(name,input,extra)=>{f.calls.push({name,input:copy(input),extra});return tools.get(name)(input,extra);};
  const result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.deepEqual(f.args,before);assert.equal(f.calls.length,3);
  assert.equal(result.coverage.completeBranchCoverage,true);assert.equal(result.coverage.completeStateReconstruction,false);assert.equal(result.coverage.approximateSamples,3);
  for(const call of f.calls){
    const position=call.input.request.position,own=position.sides.find(side=>side.id===position.ownSide),foe=position.sides.find(side=>side.id!==position.ownSide);
    assert.equal(own.pokemon.find(p=>p.id==='own0').ability,'Prankster');assert.equal(own.pokemon.find(p=>p.id==='own0').status,'slp');
    assert(own.pokemon.find(p=>p.id==='own1').nativeState.volatiles.taunt);assert(foe.pokemon.find(p=>p.id==='foe1').nativeState.volatiles.substitute);
    const bound=call.input.request.branches[0].ourActions;
    assert.deepEqual(bound.map(({sourceMoveId,...action})=>action),before.ourActions);
    assert.deepEqual(bound.map(action=>action.sourceMoveId),['dragonpulse','psychicnoise']);
    assert.deepEqual(call.input.request.branches[0].opposingActions,before.opposingActions);
    assert(position.stateAssumptions.length>0);
  }
  for(const world of result.worlds){
    const initial=world.initialState.sides.flatMap(side=>side.pokemon);
    assert.equal(initial.find(p=>p.id==='own0').ability,'Prankster');assert.equal(initial.find(p=>p.id==='own0').status,'slp');
    assert(initial.find(p=>p.id==='own1').volatiles.taunt);assert(initial.find(p=>p.id==='foe1').volatiles.substitute);
    assert(world.stateAssumptions.some(row=>row.path.includes('statusState')));assert(world.stateAssumptions.some(row=>row.path.includes('substitute')));
    assert(world.samples.every(sample=>sample.stateCoverage.complete===false&&sample.stateCoverage.approximate===true&&sample.stateCoverage.assumptions.length>0));
  }
  assert(f.evidence[0].result.nativeResults.every(reply=>reply.samples.every(sample=>sample.gate.passed===false)));
  assert.equal(result.coverage.sdkQualificationClaimed,false);assert.equal(result.source.choiceAuthority,false);
});

test('a clickable native status move no longer fails a capability admission policy',async()=>{
  const f=fixture();for(const sheet of [f.context.opposingSheet,f.context.observed.opponentSheets.p2])sheet.find(row=>row.species==='Raichu').moves[1]='Thunder Wave';
  f.context.assembly.hypotheses.opposing.foe0.pp=pp(f.context.opposingSheet.find(row=>row.species==='Raichu').moves);f.rehash();
  const before=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.deepEqual(f.args,before);assert.equal(result.coverage.completeBranchCoverage,true);assert.equal(f.calls.length,3);
  assert(result.worlds.every(world=>world.samples[0].events.some(event=>event.type==='move'&&event.move==='Thunder Wave')));
});

test('registered native execution errors preserve their safe reason and scope without sampled evidence',async()=>{
  const f=fixture(),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:()=>{throw Error('Synthetic native worker execution error');}});
  f.options.callTool=async(name,input,extra)=>{f.calls.push({name,input:copy(input),extra});return tools.get(name)(input,extra);};
  const result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(result.stage,'engine');assert.match(result.reason,/Synthetic native worker execution error/u);assert.equal(result.nativeRefusals.length,3);
  assert.deepEqual(result.nativeRefusals.map(row=>row.worldId),['world-1','world-2','world-3']);for(const refusal of result.nativeRefusals){assert.deepEqual(refusal.branchIds,['primary']);assert.match(refusal.reason,/Synthetic native worker execution error/u);assert.equal(refusal.reasonSource,'native-mcp-return');assert.match(refusal.branchAttribution,/individual failing branch not established/u);assert.match(refusal.nativeResponseSha256,/^[a-f0-9]{64}$/u);}
  assert.equal(f.calls.length,3);assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].result.researchOutcome,'unavailable');assert.equal(f.evidence[0].input.normalized.length,3);assert(f.evidence[0].input.sourceCapture.context);assert.equal(result.samples,undefined);assert.equal(result.choiceAuthority,false);
});

function nativeErrorAlternative(f){
  // Thunder Wave is clickable and admitted. Inject an explicit SDK execution
  // failure solely to test branch isolation independently of move policy.
  for(const sheet of [f.context.opposingSheet,f.context.observed.opponentSheets.p2])sheet.find(row=>row.species==='Raichu').moves[3]='Thunder Wave';
  f.context.assembly.hypotheses.opposing.foe0.pp=pp(f.context.opposingSheet.find(row=>row.species==='Raichu').moves);f.rehash();
  const alternative={id:'native-error-wave',ourActions:copy(f.args.ourActions),opposingActions:copy(f.args.opposingActions)};
  alternative.opposingActions[0]={type:'move',slot:4,target:1};f.args.alternatives=[alternative];
  const call=f.options.callTool;
  f.options.callTool=async(name,input,extra)=>{
    if(input.request.branches.some(branch=>branch.opposingActions[0].type==='move'&&branch.opposingActions[0].slot===4)){
      f.calls.push({name,input:copy(input),extra});return {isError:true,content:[{type:'text',text:JSON.stringify({reason:'Synthetic native execution error for branch isolation'})}]};
    }
    return call(name,input,extra);
  };
}

test('a refused alternative leaves actual primary and supported alternative samples with explicit missing branch coverage',async t=>{
  const f=fixture();nativeErrorAlternative(f);f.args.alternatives.push({id:'supported',ourActions:copy(f.args.ourActions),opposingActions:copy(f.args.opposingActions)});
  const authored=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.researchOutcome,'partial');assert.deepEqual(f.args,authored);
  assert.equal(result.coverage.completeBranchCoverage,false);assert.equal(result.coverage.requestedSamples,9);assert.equal(result.coverage.samples,6);assert.equal(result.coverage.unavailableBranchSamples,3);
  assert.equal(result.coverage.tacticalGoalEvaluated,false);assert.equal(result.coverage.sdkQualificationClaimed,false);
  assert.deepEqual(result.branches.map(row=>row.id),['primary','native-error-wave','supported']);
  for(const world of result.worlds){
    assert.deepEqual(world.samples.map(row=>row.branchId),['primary','supported']);assert.deepEqual(world.branchResults.map(row=>[row.branchId,row.status]),[['primary','returned'],['native-error-wave','unavailable'],['supported','returned']]);
    assert.match(world.branchResults[1].reason,/Synthetic native execution error/u);assert(world.samples.every(row=>row.events.length&&row.actionOutcomes.length===4&&!row.gate));
  }
  assert.deepEqual(result.coverage.branchCoverage[1],{branchId:'native-error-wave',returnedWorlds:[],unavailableWorlds:['world-1','world-2','world-3']});
  assert.equal(result.turnRanges.sampleCount,6);assert(result.turnRanges.actors.every(row=>row.branchId!=='native-error-wave'));
  assert.equal(f.calls.length,12);assert.equal(f.reads.length,4);assert.equal(result.nativeRefusals.length,6);
  assert.equal(f.evidence.length,1);const record=f.evidence[0];assert.equal(record.input.nativeCalls.length,12);
  for(const [i,call]of record.input.nativeCalls.entries()){
    assert.equal(call.input.request.branches.length,i<3?3:1);assert.equal(call.mode,i<3?'complete-authored-world':'isolated-authored-branch');assert(call.result&&Number.isFinite(call.settledAt));
    const world=record.input.normalized.find(row=>row.id===call.worldId),original=world.core;
    assert.deepEqual(call.input.request.position,original.position);assert.deepEqual(call.input.request.seeds,original.seeds);assert.deepEqual(call.input.request.hypotheses,original.hypotheses);
    for(const branch of call.input.request.branches)assert.deepEqual(branch,original.branches.find(row=>row.id===branch.id));
  }
  assert(record.input.nativeCalls.slice(0,3).every(row=>row.result.isError));
  assert.equal(record.input.nativeCalls.filter(row=>row.mode==='isolated-authored-branch'&&!row.result.isError).length,6);
  const payload={input:record.input,result:record.result},packed=packCalculationPayload({tool:'simulate_choices',...payload});assert.deepEqual(unpackCalculationPayload({tool:'simulate_choices',...packed}),payload);
  t.diagnostic(`Mixed native results and synthetic error evidence: ${Buffer.byteLength(JSON.stringify(payload))} raw bytes; ${Buffer.byteLength(JSON.stringify(packed))} stored bytes.`);
});

test('one failed native primary never hides a returned alternative and all-error branches never produce samples',async()=>{
  const f=fixture();nativeErrorAlternative(f);[f.args.opposingActions,f.args.alternatives[0].opposingActions]=[f.args.alternatives[0].opposingActions,f.args.opposingActions];
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.researchOutcome,'partial');
  assert(result.worlds.every(world=>world.samples.length===1&&world.samples[0].branchId==='native-error-wave'&&world.branchResults[0].status==='unavailable'));
  assert.equal(result.coverage.branchCoverage[0].returnedWorlds.length,0);assert.equal(result.coverage.branchCoverage[1].returnedWorlds.length,3);
  const g=fixture();nativeErrorAlternative(g);g.args.opposingActions=copy(g.args.alternatives[0].opposingActions);
  const unavailable=await executeSimulationChoices(g.args,g.options);assert.equal(unavailable.kind,'simulation-choices-unavailable');assert.equal(unavailable.researchOutcome,'unavailable');assert.equal(unavailable.worlds,undefined);assert.equal(g.calls.length,9);assert.equal(g.evidence[0].input.nativeCalls.length,9);
});

test('source changes before branch isolation prevent extra native calls and preserve the original full refusals',async()=>{
  const f=fixture();nativeErrorAlternative(f);const call=f.options.call;let reads=0;
  f.options.call=async(...args)=>{if(++reads===3)f.context.semanticSha256='e'.repeat(64);return call(...args);};
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.match(result.reason,/facts changed/u);assert.equal(f.calls.length,3);
  assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].input.nativeCalls.length,3);assert.equal(f.evidence[0].result.researchOutcome,'unavailable');
});

test('branch isolation shares the original deadline and cancellation stops queued branch dispatches',async()=>{
  for(const mode of ['cancel','equality']){
    const f=fixture();nativeErrorAlternative(f);const call=f.options.callTool,controller=new AbortController();let count=0,clock=Date.now();const cutoff=clock+1000;
    f.options.signal=controller.signal;f.options.now=()=>clock;f.options.deadlineAt=cutoff;
    f.options.callTool=(...args)=>{if(++count===4){if(mode==='cancel')controller.abort();else clock=cutoff;}return call(...args);};
    const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable',mode);assert.equal(f.calls.length,4,mode);assert.equal(f.evidence.length,0,mode);assert.equal(result.worlds,undefined);
  }
});

test('post-isolation send reservation invalidates all public samples while private diagnostics retain actual call history',async()=>{
  const f=fixture();nativeErrorAlternative(f);const call=f.options.call;let reads=0;
  f.options.call=async(...args)=>{if(++reads===4)f.context.observed.actions[0].submissionStatus='sent';return call(...args);};
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.match(result.reason,/stale or reserved/u);assert.equal(f.calls.length,9);assert.equal(result.worlds,undefined);
  assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].input.nativeCalls.length,9);assert.equal(f.evidence[0].result.researchOutcome,'unavailable');assert.equal(f.evidence[0].result.nativeResults,undefined);
});

test('native refusal text remains bounded untrusted diagnostics and redacts private fields, echoes, URLs and long content',async()=>{
  const f=fixture(),token=f.args.source.token;f.options.callTool=async()=>({isError:true,content:[{type:'text',text:JSON.stringify({reason:`Unsupported selected move; ${token} https://private.invalid/watch C:\\private\\file ${'x'.repeat(20000)}`,password:'private-password',echo:'private-password'})}]});
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(result.nativeRefusals.length,3);assert(result.reason.length<=500);assert(result.nativeRefusals.every(row=>row.reason.length<=320));assert(Buffer.byteLength(JSON.stringify(result))<3000);
  for(const secret of [token,'private-password','https://private.invalid','C:\\private\\file'])assert(!JSON.stringify(result).includes(secret),secret);assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].result.kind,'simulation-choices-unavailable');
});

test('missing lifecycle and reserve freshness allow conditional native worlds',async()=>{
  for(const change of [f=>delete f.context.assembly.hypotheses.own.own0.lifecycle,f=>f.context.assembly.facts.reserveEligibility=[]]){
    const f=fixture();change(f);const before=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
    assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.deepEqual(f.args,before);assert.equal(f.calls.length,3);
    assert.equal(result.coverage.sdkQualificationClaimed,false);assert.equal(result.coverage.tacticalGoalEvaluated,false);
    assert(result.worlds.every(world=>Array.isArray(world.stateAssumptions)&&world.samples.every(sample=>sample.stateCoverage)));
  }
});

test('an unsupported-state summary flag alone does not force approximation of complete strict facts',async()=>{
  const f=fixture();f.context.assembly.coverage.unsupportedCurrentState=true;
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(f.calls.length,3);
  assert(f.evidence[0].input.normalized.every(world=>world.provenance.approximate!==true));assert(result.worlds.every(world=>world.stateAssumptions.length===0));
});

test('known source, private HP, locked team, sheet and clickable-menu contradictions still refuse',async()=>{
  for(const [label,change]of [['disabled move',f=>f.context.observed.actions[0].legalActions.active[0].moves[0].disabled=true],['changed binding',f=>f.context.assembly.binding.observedSha256='e'.repeat(64)],['wrong locked team',f=>{f.options.loadTeam=async()=>({team:[]});}],['changed source sheet',f=>{f.context.opposingSheet[0].moves[0]='Protect';}],['conflicting private HP',f=>{f.context.observed.boards[0].sides[0].pokemon[0].hp.current--;f.rehash();}]]){
    const f=fixture();change(f);const before=copy(f.args),result=await executeSimulationChoices(f.args,f.options);
    assert.equal(result.kind,'simulation-choices-unavailable',label);assert.equal(result.retry,false);assert.equal(result.copyRepair,false);assert.equal(f.calls.length,0,label);assert.deepEqual(f.args,before);assert.equal(f.reads.length,1);
  }
});

test('stale, sent and uncertain current sources fail before research; post-engine change never becomes evidence',async()=>{
  for(const change of [f=>f.context.observed.actions[0].submissionStatus='uncertain',f=>f.context.observed.actions[0].actionable=false,f=>f.context.observed.controlPolicy={pending:[{token:f.args.source.token,attempted:true}]},f=>f.context.source.sessionId='other']){
    const f=fixture();change(f);const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(f.calls.length,0);
  }
  const f=fixture(),call=f.options.call;let reads=0;f.options.call=async(...args)=>{if(++reads===3)f.context.observed.actions[0].submissionStatus='sent';return call(...args);};
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(f.calls.length,3);assert.equal(f.evidence.length,1);assert.equal(f.evidence[0].result.researchOutcome,'unavailable');assert.equal(f.evidence[0].result.nativeResults,undefined);
});

test('frozen simulation reads only exact frozen source and never claims current freshness or authority',async()=>{
  const f=fixture(),freezeId='2aaace99-e69b-4d5a-a6fd-9a9a62cc7321';Object.assign(f.args,{analysis:'frozen',freezeId});Object.assign(f.context,{freezeId,liveFreshness:false});
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.source.liveFreshness,false);assert.equal(result.source.choiceAuthority,false);assert.equal(result.source.kind,'owned-frozen-pre-choice-analysis');assert(f.reads.every(r=>r.mode==='frozen'&&r.freezeId===freezeId));
  f.options.call=async()=>({ok:false,error:'Frozen simulation source expired'});const expired=await executeSimulationChoices(f.args,f.options);assert.equal(expired.kind,'simulation-choices-unavailable');assert.match(expired.reason,/expired/u);
});

test('benign source age/timer receipt changes preserve semantic freshness; material or incomplete-history changes refuse',async()=>{
  const f=fixture(),read=f.options.call;let count=0;
  f.options.call=async(...args)=>{if(++count>1){f.context.observed.observedAt=Date.now();f.context.observed.boards[0].requestAgeMs=count*10;f.context.assembly.binding.historySha256=sha(count);f.context.assembly.binding.sequence++;}return read(...args);};
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  for(const change of [g=>g.context.observed.boards[0].sides[1].pokemon[0].hp.current--,g=>g.context.assembly.coverage.auditedHistory=false]){
    const g=fixture(),original=g.options.call;let n=0;g.options.call=async(...args)=>{if(++n===2){change(g);g.context.semanticSha256='e'.repeat(64);}return original(...args);};const changed=await executeSimulationChoices(g.args,g.options);assert.equal(changed.kind,'simulation-choices-unavailable');assert.match(changed.reason,/facts changed/u);assert.equal(g.calls.length,0);
  }
});

test('original deadline and cancellation reach native callback and bounded late result is never evidence',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();assert.equal((await executeSimulationChoices(f.args,{...f.options,signal:controller.signal})).kind,'simulation-choices-unavailable');assert.equal(f.calls.length,0);
  const g=fixture();g.context.observed.timing={requests:[{token:g.args.source.token,cutoffAt:Date.now()-1}]};const expired=await executeSimulationChoices(g.args,g.options);assert.equal(expired.kind,'simulation-choices-unavailable');assert.equal(g.calls.length,0);
  const h=fixture();let cancelled=0;h.options.callTool=async(_name,_args,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(Error('cancelled worker'));},{once:true}));
  const late=await executeSimulationChoices(h.args,{...h.options,deadlineAt:Date.now()+150});assert.equal(late.kind,'simulation-choices-unavailable');assert.equal(cancelled,3);assert.equal(h.evidence.length,0);
});

test('cancellation at the microtask boundary stops queued native world dispatches',async()=>{
  const f=fixture(),controller=new AbortController();let calls=0;
  f.options.callTool=async()=>{calls++;controller.abort();throw Error('first callback aborted');};
  const result=await executeSimulationChoices(f.args,{...f.options,signal:controller.signal});
  assert.equal(calls,1);assert.equal(result.kind,'simulation-choices-unavailable');assert.equal(f.evidence.length,0);assert.equal(result.turnRanges,undefined);
});

test('source stalls are bounded and unavailable wrapper remains concise',async()=>{
  const f=fixture(),tools=new Map();registerSimulationChoicesTool({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},{...f.options,call:()=>new Promise(()=>{})});
  const started=Date.now(),result=await tools.get('simulate_choices').handler(f.args);assert.equal(result.isError,true);assert.equal(result.structuredContent.kind,'simulation-choices-unavailable');assert.match(result.structuredContent.reason,/expired/u);assert(Date.now()-started<1500);assert.equal(f.evidence.length,0);assert.equal(tools.get('simulate_choices').config.annotations.readOnlyHint,true);assert(result.content[0].text.length<1000);
});

test('compact pivot continuations name unseen entrants and bind stable own switch identities without selecting a replacement',async()=>{
  const f=fixture(),sheet=f.context.opposingSheet.find(p=>p.species==='Raichu');
  sheet.moves[0]='Volt Switch';f.context.observed.opponentSheets.p2=copy(f.context.opposingSheet);
  f.context.assembly.hypotheses.opposing.foe0.pp=pp(sheet.moves);
  f.args.ourActions=[{type:'switch',slot:3},{type:'switch',slot:4}];
  f.args.opposingActions=[{type:'move',slot:1,target:1},{type:'move',slot:4,target:2}];
  f.args.continuations=[{opposingActions:[{type:'switch',species:'Incineroar'},{type:'pass'}]}];f.rehash();
  const result=await executeSimulationChoices(f.args,f.options);
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(result.coverage.completeBranchCoverage,true);
  assert.deepEqual(result.branches[0].continuations,f.args.continuations);
  for(const world of result.worlds){const sample=world.samples[0];
    assert.equal(sample.turnComplete,true);assert.equal(sample.noPendingContinuation,true);assert.equal(sample.replacementRequest,null);
    assert.equal(sample.replacementDecisions.length,1);assert.equal(sample.unusedContinuations,0);
    const entrant=sample.final.sides[1].pokemon.find(p=>p.species==='Incineroar');assert.equal(entrant.active,true);
    assert(sample.events.some(e=>e.type==='switch'&&e.actorId===entrant.id));
  }
  assert(f.evidence[0].input.normalized.every(w=>w.core.branches[0].ourActions.every(a=>a.pokemonId&&!a.slot)));
});

test('compact confusion counter endpoints remain labeled hypotheses and reach native MCP without inventing an exact observed duration',async()=>{
  const f=fixture(),actor=f.context.observed.boards[0].sides[0].pokemon[0];
  actor.volatiles.confusion={name:'confusion',remainingActions:{min:1,max:3}};f.rehash();
  const result=await executeSimulationChoices(f.args,f.options);assert.equal(result.kind,'native-choice-simulation-v1',result.reason);
  assert.equal(result.coverage.completeBranchCoverage,true);
  assert.deepEqual(f.evidence[0].input.normalized.map(w=>w.core.position.sides[0].pokemon.find(p=>p.id==='own0').volatiles.confusion.remainingActions),[1,3,1]);
  assert(result.worlds.every(w=>w.assumptions.some(a=>a.includes('confusion counter')&&a.includes('not an observed exact'))));
  assert.deepEqual(actor.volatiles.confusion.remainingActions,{min:1,max:3});
  const invalid=fixture();invalid.args.continuations=[{ourActions:[{type:'move',slot:4},{type:'pass'}]}];
  assert.equal((await executeSimulationChoices(invalid.args,invalid.options)).kind,'simulation-choices-unavailable');assert.equal(invalid.calls.length,0);
});

test('production facade returns exactly one native trajectory and retains full raw detail privately',async()=>{
  const f=fixture(),native=f.options.callTool;
  f.options.callTool=Object.assign((name,args,extra)=>{const {researchContext,...nativeArgs}=args;assert.deepEqual(researchContext,{source:f.args.source,analysis:'current'});return native(name,nativeArgs,extra);},{runtimeVersion:'owned-registered-fixture-runtime'});
  const result=await executeSimulationChoices(f.args,{...f.options,researchPolicy:'single-outcome'});
  assert.equal(result.kind,'native-choice-outcome-v1',result.reason);assert.equal(f.calls.length,1);
  assert.deepEqual([result.coverage.worlds,result.coverage.branches,result.coverage.samples,result.coverage.requestedSamples],[1,1,1,1]);
  assert.equal(result.coverage.koProbability,false);assert.equal(result.coverage.exhaustive,false);
  assert(result.outcome.final.sides.length===2&&result.outcome.events.length&&result.outcome.actionOutcomes.length===4);
  assert.equal(result.worlds,undefined);assert.equal(result.turnRanges,undefined);
  const retained=f.evidence[0];assert.equal(retained.input.researchPolicy,'single-outcome');assert.equal(retained.result.nativeResults.length,1);
  assert.equal(result.inference.policy,'cache-only');assert.equal(result.inference.modelFirst,true);assert.equal(result.inference.newNumericCalls,0);
  assert(Object.values(retained.input.candidatePools).every(pool=>pool.provenance.runtimeVersion==='owned-registered-fixture-runtime'),'the private bound dispatcher preserves the actual runtime cache pin');
  assert.equal(retained.result.detailedResult.worlds.length,1);
  const sample=retained.result.nativeResults[0].samples[0];assert.deepEqual(result.outcome.final,sample.final);assert.deepEqual(result.outcome.events,sample.events);assert.deepEqual(result.outcome.pendingActions,sample.pendingActions);assert.deepEqual(result.stateCoverage.assumptions,sample.stateCoverage.assumptions);
  assert.equal(f.evidence[0].input.normalized[0].core.branches.length,1);assert.equal(f.evidence[0].input.normalized[0].core.seeds.length,1);
});

test('production facade never expands alternatives or retries a refused single trajectory',async()=>{
  const f=fixture();f.args.alternatives=[{ourActions:f.args.ourActions,opposingActions:f.args.opposingActions}];
  const invalid=await executeSimulationChoices(f.args,{...f.options,researchPolicy:'single-outcome'});assert.equal(invalid.kind,'simulation-choices-unavailable');assert.equal(f.calls.length,0);
  assert.equal(simulationChoicesAuthorSchema.safeParse({ourActions:f.args.ourActions,opposingActions:f.args.opposingActions,alternatives:[]}).success,false);
  const g=fixture();let calls=0;g.options.callTool=async()=>{calls++;return {isError:true,content:[{type:'text',text:'native one-trajectory refusal'}]};};
  const refusal=await executeSimulationChoices(g.args,{...g.options,researchPolicy:'single-outcome'});assert.equal(refusal.kind,'simulation-choices-unavailable');assert.equal(calls,1);assert.match(refusal.reason,/one-trajectory refusal/u);
});

test('portable current and frozen sources defer usable automatic history checks without numeric dispatch',async()=>{
  for(const analysis of ['current','frozen']){
    const f=fixture(),actor=f.context.observed.boards[0].sides[1].pokemon[0],published=f.context.opposingSheet.find(p=>p.species===actor.species);
    const snapshot=(label,species,ability,item)=>({label,species,ability,item,status:'',boosts:{atk:0,def:0,spa:0,spd:0,spe:0},tailwind:false,abilitySuppressed:false,itemSuppressed:false});
    f.context.assembly.facts.spreadObservations={[actor.id]:[{id:'synthetic-supported-order',kind:'move-order',sourceSha256:f.context.assembly.binding.sourceSha256,currentForme:actor.species,candidateIndex:0,beforeIndex:0,
      verification:{identityVerified:true,bothExecuted:true,samePriority:true,forcedOrder:false,conditionsKnown:true,abilityItemKnown:true},
      input:{gen:0,pokemon:[snapshot('candidate',actor.species,published.ability,published.item),{...snapshot('known-other','Farigiraf','Armor Tail',''),nature:'Modest',statPoints:{hp:32,atk:0,def:2,spa:32,spd:0,spe:0}}],field:{weather:'',terrain:'',trickRoom:false,magicRoom:false,weatherSuppressed:false}}}]};
    if(analysis==='frozen'){const freezeId='40ba505b-55a1-4ca1-a0e2-3b5657318f13';Object.assign(f.args,{analysis,freezeId});Object.assign(f.context,{freezeId,liveFreshness:false});}
    const native=f.options.callTool;f.options.callTool=(name,args,extra)=>{assert.equal(name,'simulate_turn','usable automatic observations must not dispatch numerical work');const {researchContext,...input}=args;return native(name,input,extra);};
    const result=await executeSimulationChoices(f.args,{...f.options,researchPolicy:'single-outcome'}),pool=f.evidence[0].input.candidatePools[actor.id];
    assert.equal(result.kind,'native-choice-outcome-v1',result.reason);assert.equal(pool.coverage.usableObservations,1);assert.equal(pool.coverage.attemptedCalls,0);assert(pool.coverage.deferredCalls>0);assert.equal(pool.rejected.length,0);assert(pool.candidates.every(candidate=>candidate.checks.every(check=>check.status==='unavailable')));assert.equal(result.inference.newNumericCalls,0);assert.equal(f.calls.length,1);
  }
});
