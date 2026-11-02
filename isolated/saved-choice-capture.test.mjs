import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {executeSimulationChoices} from '../simulation/choice-simulation.mjs';
import {registerSimulationTools} from '../simulation/mcp-tools.mjs';
import {simulateNativeTurn} from '../simulation/turn-simulator.mjs';
import {digest} from '../planning/identity.mjs';
import {readCalculation} from '../workflow/calculations.mjs';
import {packCalculationPayload} from '../workflow/calculation-archive.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {canonicalEvidenceRoom} from '../showdown/evidence-room.mjs';
import {verifyPrivateChoiceCapture,replayPrivateChoiceCapture,matchesRetainedChoiceRequest} from './saved-compact-replay.mjs';
const {Teams,Dex,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown'),dex=Dex.mod('champions');
const sha=x=>createHash('sha256').update(x).digest('hex'),copy=structuredClone,objectSha=x=>sha(JSON.stringify(x));
const pp=moves=>moves.map(name=>{const m=dex.moves.get(name);return dex.data.Scripts.calculatePP.call({gen:9},m,m.noPPBoosts||m.id==='trumpcard'?0:3);});
async function fixture({unsupportedAlternative=false,historicalClock=false,nonLexicalActorIds=false}={}){
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-capture-replay-')),f=currentFixture(),own=Teams.import(f.teamText);new TeamValidator('gen9championsvgc2026regmc').validateTeam(own);const teamId=sha(Teams.pack(own));
  const source={sessionId:f.observed.sessionId,...f.expected,teamId},board=f.observed.boards[0];board.turn=2;f.observed.teamSha256=teamId;
  if(historicalClock)board.clock={source:'synthetic-native-like-countdown',deadlineAt:Date.now()+30000};
  if(nonLexicalActorIds){const ids={foe0:'foe7',foe1:'foe10'};for(const p of board.sides[1].pokemon)p.id=ids[p.id];for(const active of board.sides[1].active)active.pokemon=ids[active.pokemon];f.hypotheses.opposing=Object.fromEntries(Object.entries(f.hypotheses.opposing).map(([id,value])=>[ids[id],value]));}
  if(unsupportedAlternative)for(const sheet of [f.opposingSheet,f.observed.opponentSheets.p2])sheet.find(row=>row.species==='Raichu').moves[3]='Protect';
  for(const [i,active]of f.observed.actions[0].legalActions.active.entries()){const values=pp(own.find(p=>p.species===board.sides[0].pokemon[i].species).moves);active.moves.forEach((m,j)=>m.pp=values[j]);}
  for(const p of board.sides[0].pokemon)f.hypotheses.own[p.id].pp=pp(own.find(s=>s.species===p.species).moves);
  for(const p of board.sides[1].pokemon){f.hypotheses.opposing[p.id].pp=pp(f.opposingSheet.find(s=>s.species===p.species).moves);delete f.hypotheses.opposing[p.id].statPoints;delete f.hypotheses.opposing[p.id].hp;}f.hypotheses.reserves=[];
  const assembly={kind:'mechanical-choice-state-v1',schemaVersion:1,binding:{...source,sourceSha256:'b'.repeat(64),observedSha256:objectSha(f.observed),assembledObservedSha256:objectSha(f.observed)},hypotheses:f.hypotheses,observedOverrides:[],unknowns:[],provenance:[],coverage:{completeHistory:true,auditedHistory:true,unsupportedCurrentState:false},facts:{actors:[],reserveEligibility:f.opposingSheet.filter(s=>!board.sides[1].pokemon.some(p=>p.species===s.species)).map(s=>({species:s.species,eligible:true,conditionalOn:'selected-unrevealed-and-never-entered',notSelectionEvidence:true,hp:'full',status:'',boosts:{atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0},pp:pp(s.moves),lifecycle:{activeTurns:0,activeMoveActions:0,protectCounter:0,choiceLock:false,lastMove:false},volatiles:{},ability:s.ability,item:s.item,abilitySuppressed:false}))}};
  const context={kind:'owned-simulation-context-v1',semanticSha256:'f'.repeat(64),source,observed:f.observed,opposingSheet:f.opposingSheet,assembly,liveFreshness:true,choiceAuthority:false,frozenAt:1000};
  const args={source,analysis:'current',ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:1,target:1}],opposingActions:[{type:'move',slot:2,target:1,mega:true},{type:'move',slot:1,target:2}],evidenceContext:{teamId,roomId:canonicalEvidenceRoom(source.room),turn:2}};
  if(unsupportedAlternative)args.alternatives=[{id:'unsupported-wave',ourActions:copy(args.ourActions),opposingActions:[{type:'move',slot:4,target:1},copy(args.opposingActions[1])]}];
  const native=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>native.set(name,handler)},{run:simulateNativeTurn});let retained;
  const result=await executeSimulationChoices(args,{researchPolicy:'offline-multi',workspace,loadTeam:async()=>({team:own}),call:async()=>({ok:true,result:copy(context)}),callTool:(name,input,extra)=>native.get(name)(input,extra),recordEvidence:async entry=>{retained=copy(entry);return{offlineSyntheticFixture:true};}});
  assert.equal(result.kind,'native-choice-simulation-v1',result.reason);assert.equal(retained.input.normalized.length,3);
  retained.input.sourceCapture.contextJson=JSON.stringify(context);
  const store=async(entry=retained)=>{
    const id=randomUUID(),directory=join(workspace,'cache/team-metrics/calculations');await mkdir(directory,{recursive:true});
    const document={schemaVersion:1,kind:'mcp-calculation-evidence',id,teamId,roomId:canonicalEvidenceRoom(source.room),turn:2,tool:'simulate_choices',createdAt:new Date().toISOString(),provenance:'actual-mcp-tool',...packCalculationPayload({tool:'simulate_choices',input:entry.input,result:entry.result})};
    const text=JSON.stringify(document)+'\n';await writeFile(join(directory,teamId+'--'+id+'.json'),text);
    const record=await readCalculation({workspace,teamId,id}),expected={teamId,id,roomId:canonicalEvidenceRoom(source.room),turn:2,sha256:sha(text)};return{record,expected};
  };
  return{workspace,retained,store,cleanup:()=>rm(workspace,{recursive:true,force:true})};
}

test('capture verification binds original ledger, complete context, packed team and source/assembly hashes',async()=>{
  const f=await fixture();try{
    const {record,expected}=await f.store(),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,record,expected});assert.equal(verified.normalizedWorlds,3);assert.equal(verified.qualification,false);
    const incoming=copy(record);incoming.input.sourceCapture.contextSha256='a'.repeat(64);await assert.rejects(verifyPrivateChoiceCapture({workspace:f.workspace,record:incoming,expected}),/incoming read differs/u);
    for(const change of [x=>x.input.sourceCapture.contextSha256='a'.repeat(64),x=>x.input.sourceCapture.ownTeamSha256='a'.repeat(64),x=>x.input.sourceCapture.contextJson+=' ',x=>{const c=JSON.parse(x.input.sourceCapture.contextJson);c.source.rqid++;x.input.sourceCapture.contextJson=JSON.stringify(c);},x=>{x.input.sourceCapture.context.source.rqid++;x.input.sourceCapture.contextSha256=digest(x.input.sourceCapture.context);},x=>{x.input.sourceCapture.context.assembly.binding.observedSha256='a'.repeat(64);x.input.sourceCapture.contextSha256=digest(x.input.sourceCapture.context);}]){
      const altered=copy(f.retained);change(altered);const row=await f.store(altered);await assert.rejects(verifyPrivateChoiceCapture({workspace:f.workspace,...row}));
    }
    await assert.rejects(replayPrivateChoiceCapture({verified:copy(verified)}),/Original verified/u);
  }finally{await f.cleanup();}
});

test('compressed capture preserves ordered native JSON without rebasing original observed hashes',async()=>{
  const f=await fixture();try{const entry=copy(f.retained);entry.result.syntheticPadding='x'.repeat(600000);const row=await f.store(entry);
    const raw=JSON.parse(await readFile(join(f.workspace,row.record.path),'utf8'));assert.equal(raw.payloadArchive.encoding,'gzip-base64-json-v1');
    assert.notEqual(objectSha(row.record.input.sourceCapture.context.observed),row.record.input.sourceCapture.context.assembly.binding.observedSha256);
    const verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});assert.equal(verified.normalizedWorlds,3);
    const legacy=copy(entry);delete legacy.input.sourceCapture.contextJson;const older=await f.store(legacy);await assert.rejects(verifyPrivateChoiceCapture({workspace:f.workspace,...older}),/source\/assembly hash differs/u);
  }finally{await f.cleanup();}
});

test('native observations may omit the private team hash but a present mismatch still fails all joined ownership checks',async()=>{
  const f=await fixture();try{
    for(const mismatch of [false,true]){
      const entry=copy(f.retained),capture=entry.input.sourceCapture,c=JSON.parse(capture.contextJson);delete c.observed.teamSha256;
      if(mismatch)c.observed.teamSha256='e'.repeat(64);
      c.assembly.binding.observedSha256=objectSha(c.observed);c.assembly.binding.assembledObservedSha256=objectSha(c.observed);
      capture.context=c;capture.contextJson=JSON.stringify(c);capture.contextSha256=digest(c);entry.input.assembly=copy(c.assembly);
      const row=await f.store(entry);
      if(mismatch)await assert.rejects(verifyPrivateChoiceCapture({workspace:f.workspace,...row}),/observed session\/team differs/u);
      else {const verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});assert.equal(verified.teamId,row.expected.teamId);assert.equal(Object.hasOwn(row.record.input.sourceCapture.context.observed,'teamSha256'),false);}
    }
  }finally{await f.cleanup();}
});

test('declared pre-IPC digests stay opaque while retained facts and legality bind to the independent original operator receipt',async()=>{
  const f=await fixture();try{
    const original=await f.store(),first=await verifyPrivateChoiceCapture({workspace:f.workspace,...original}),sourceSha256=first.operatorSourceSha256;
    const entry=copy(f.retained),capture=entry.input.sourceCapture,c=JSON.parse(capture.contextJson);c.boardHash='1'.repeat(64);c.legalHash='2'.repeat(64);
    capture.context=c;capture.contextJson=JSON.stringify(c);capture.contextSha256=digest(c);
    const row=await f.store(entry),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,record:row.record,expected:{...row.expected,sourceSha256}});
    assert.equal(verified.operatorSourceSha256,sourceSha256);assert.equal(verified.declaredNativeHashes.boardSha256,c.boardHash);assert.notEqual(verified.retainedProjectionHashes.boardSha256,c.boardHash);
    assert.equal(row.record.input.sourceCapture.context.boardHash,c.boardHash);
    for(const change of [context=>context.observed.boards[0].sides[0].pokemon[0].hp.current--,context=>context.observed.actions[0].legalActions.active[0].moves[0].target='allAdjacent']){
      const altered=copy(entry),captured=altered.input.sourceCapture,context=JSON.parse(captured.contextJson);change(context);
      context.assembly.binding.observedSha256=objectSha(context.observed);context.assembly.binding.assembledObservedSha256=objectSha(context.observed);
      captured.context=context;captured.contextJson=JSON.stringify(context);captured.contextSha256=digest(context);altered.input.assembly=copy(context.assembly);
      const changed=await f.store(altered);await assert.rejects(verifyPrivateChoiceCapture({workspace:f.workspace,record:changed.record,expected:{...changed.expected,sourceSha256}}),/operator source hash differs/u);
    }
  }finally{await f.cleanup();}
});

test('unavailable capture without normalized worlds remains diagnostic-only with no numeric dispatch',async()=>{
  const f=await fixture();try{const e=copy(f.retained);e.input.normalized=[];e.result={kind:'simulation-choices-unavailable',researchOutcome:'unavailable',reason:'Synthetic missing history'};
    const row=await f.store(e),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});let calls=0;
    const result=await replayPrivateChoiceCapture({verified,callNative:async()=>{calls++;}});assert.equal(result.status,'readiness-diagnostic-only');assert.equal(calls,0);assert.equal(result.normalizationReconstructed,false);
  }finally{await f.cleanup();}
});

test('tampered normalized core or provenance cannot count as reproduced reconstruction',async()=>{
  const f=await fixture();try{for(const change of [e=>e.input.normalized[0].core.seeds[0][0]++,e=>e.input.normalized[0].provenance={syntheticTamper:true}]){
    const entry=copy(f.retained);change(entry);const row=await f.store(entry),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});
    const tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:simulateNativeTurn});
    const result=await replayPrivateChoiceCapture({verified,callNative:q=>tools.get(q.name)(q.arguments,{})});assert.equal(result.status,'refused');assert.equal(result.normalizationReconstructed,false);
  }}finally{await f.cleanup();}
});

test('actual registered offline SDK reconstructs the same complete capture; explicit-world-only mode remains narrower',async()=>{
  const f=await fixture(),connection=await connectOfflineNumericClient();try{const row=await f.store(),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});
    const result=await replayPrivateChoiceCapture({verified,caseBudgetMs:10000,callNative:(...args)=>connection.client.callTool(...args)});
    assert.equal(result.status,'reconstructed-native-return',result.reason);assert.equal(result.normalizationReconstructed,true);assert.equal(result.nativeCalls.filter(c=>c.name==='simulate_turn').length,3);assert.equal(result.qualification,false);assert.equal(result.liveFreshness,false);
    const explicit=await replayPrivateChoiceCapture({verified,mode:'normalized-worlds-only',caseBudgetMs:10000,callNative:(...args)=>connection.client.callTool(...args)});assert.equal(explicit.status,'native-worlds-returned');assert.equal(explicit.normalizationReconstructed,false);
    assert.equal(digest(row.record),digest(await readCalculation({workspace:f.workspace,teamId:row.expected.teamId,id:row.expected.id})));
  }finally{await connection.close();await f.cleanup();}
});

test('retained request comparison permits only an unchanged original single-branch subset',async()=>{
  const f=await fixture({unsupportedAlternative:true});try{
    const normalized=f.retained.input.normalized,core=normalized[0].core,full={kind:'explicit',...copy(core)},single={...copy(full),branches:[copy(core.branches[0])]};
    assert.equal(matchesRetainedChoiceRequest(full,normalized),true);assert.equal(matchesRetainedChoiceRequest(single,normalized),false);assert.equal(matchesRetainedChoiceRequest(single,normalized,{allowSingleBranch:true}),true);
    for(const change of [r=>r.position.turn++,r=>r.seeds[0][0]++,r=>r.hypotheses.push('invented assumption'),r=>r.branches[0].id='new-branch',r=>r.branches[0].ourActions[0].target=2,r=>r.branches[0].opposingActions[0].target=2,r=>r.kind='observed',r=>r.extra='new-state']){
      const tampered=copy(single);change(tampered);assert.equal(matchesRetainedChoiceRequest(tampered,normalized,{allowSingleBranch:true}),false);
    }
    const omitted={...copy(full),branches:[]};assert.equal(matchesRetainedChoiceRequest(omitted,normalized,{allowSingleBranch:true}),false);
  }finally{await f.cleanup();}
});

test('verified partial capture replays actual isolated branches and reports unavailable alternatives without qualification',async()=>{
  const f=await fixture({unsupportedAlternative:true});try{
    const row=await f.store(),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row}),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:simulateNativeTurn});
    const result=await replayPrivateChoiceCapture({verified,callNative:q=>tools.get(q.name)(q.arguments,{})});
    assert.equal(result.status,'reconstructed-native-return',result.reason);assert.equal(result.normalizationReconstructed,true);assert.equal(result.researchOutcome,'partial');assert.equal(result.coverage.completeBranchCoverage,false);assert.equal(result.coverage.samples,3);assert.equal(result.coverage.unavailableBranchSamples,3);
    assert.equal(result.nativeCalls.length,9);assert.equal(result.nativeCalls.filter(call=>call.isError).length,6);assert.equal(result.qualification,false);assert.equal(result.liveFreshness,false);
    assert(result.worldBranchResults.every(world=>world.branchResults[0].status==='returned'&&world.branchResults[1].status==='unavailable'));
    assert.equal(digest(row.record),digest(await readCalculation({workspace:f.workspace,teamId:row.expected.teamId,id:row.expected.id})));
    const explicit=await replayPrivateChoiceCapture({verified,mode:'normalized-worlds-only',callNative:q=>tools.get(q.name)(q.arguments,{})});assert.equal(explicit.status,'native-refused');assert.equal(explicit.nativeCalls.length,3);assert.equal(explicit.normalizationReconstructed,false);
  }finally{await f.cleanup();}
});

test('historical countdown treatment preserves original provenance and verifies a distinct clock-only source digest',async()=>{
  const f=await fixture({historicalClock:true});try{
    const row=await f.store(),before=digest(row.record),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row}),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:simulateNativeTurn});
    const result=await replayPrivateChoiceCapture({verified,callNative:q=>tools.get(q.name)(q.arguments,{})});
    assert.equal(result.status,'reconstructed-native-return',result.reason);assert.equal(result.normalizationReconstructed,true);assert.equal(result.provenanceSourceRebase.length,3);
    for(const proof of result.provenanceSourceRebase){assert.equal(proof.originalSourceSha256,row.record.input.normalized.find(world=>world.id===proof.worldId).provenance.sourceSha256);assert.notEqual(proof.originalSourceSha256,proof.offlineSourceSha256);}
    assert.match(result.normalizationComparison,/not asserted equal/u);assert.equal(result.liveFreshness,false);assert.equal(result.qualification,false);
    assert.equal(digest(row.record),before);assert.equal(digest(await readCalculation({workspace:f.workspace,teamId:row.expected.teamId,id:row.expected.id})),before);
    for(const change of [e=>e.input.normalized[0].core.position.sides[0].pokemon[0].hp--,e=>e.input.normalized[0].provenance.revision++,e=>e.input.normalized[0].core.hypotheses.push('unrecorded state'),e=>e.input.normalized[0].provenance.sourceSha256='e'.repeat(64)]){
      const altered=copy(f.retained);change(altered);const stored=await f.store(altered),proof=await verifyPrivateChoiceCapture({workspace:f.workspace,...stored}),dispatched=[];
      const refused=await replayPrivateChoiceCapture({verified:proof,callNative:q=>{dispatched.push(q);return tools.get(q.name)(q.arguments,{});}});assert.equal(refused.status,'refused');assert.equal(refused.normalizationReconstructed,false);
      assert(dispatched.length<=2);assert(dispatched.every(q=>digest(q.arguments.request.seeds)!==digest(altered.input.normalized[0].core.seeds)),'The altered original world must never be dispatched.');
    }
  }finally{await f.cleanup();}
});

test('original offline deadline equality stops queued native dispatches and never adopts a late source replay',async()=>{
  const f=await fixture({historicalClock:true});try{
    const row=await f.store(),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row}),tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:simulateNativeTurn});
    for(const mode of ['reconstruct','normalized-worlds-only']){
      let clock=1000,dispatched=0;const cutoff=1100,result=await replayPrivateChoiceCapture({verified,mode,now:()=>clock,deadlineAt:cutoff,caseBudgetMs:1000,callNative:async q=>{dispatched++;clock=cutoff;return tools.get(q.name)(q.arguments,{});}});
      assert.equal(result.status,'deadline-unavailable',mode);assert.equal(result.normalizationReconstructed,false);assert.equal(dispatched,1,mode);assert.equal(result.nativeCalls.length,1);assert.equal(result.nativeCalls[0].resultSha256,undefined);assert.equal(result.qualification,false);
    }
  }finally{await f.cleanup();}
});

test('canonical archive object order does not replace the original ordered hypothesis labels or permit label drift',async()=>{
  const f=await fixture({historicalClock:true,nonLexicalActorIds:true});try{
    const entry=copy(f.retained);entry.result.syntheticPadding='x'.repeat(600000);const row=await f.store(entry),verified=await verifyPrivateChoiceCapture({workspace:f.workspace,...row});
    assert.deepEqual(Object.keys(row.record.input.normalized[0].hypotheses.opposing),['foe10','foe7']);
    const originalLabels=row.record.input.normalized[0].core.hypotheses;assert(originalLabels.findIndex(label=>label.startsWith('foe7:'))<originalLabels.findIndex(label=>label.startsWith('foe10:')));
    const tools=new Map();registerSimulationTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{run:simulateNativeTurn});
    const replay=await replayPrivateChoiceCapture({verified,callNative:q=>tools.get(q.name)(q.arguments,{})});assert.equal(replay.status,'reconstructed-native-return',replay.reason);assert.equal(replay.normalizationReconstructed,true);
    const altered=copy(entry);altered.input.normalized[0].core.hypotheses.reverse();const changed=await f.store(altered),proof=await verifyPrivateChoiceCapture({workspace:f.workspace,...changed}),dispatched=[];
    const refused=await replayPrivateChoiceCapture({verified:proof,callNative:q=>{dispatched.push(q);return tools.get(q.name)(q.arguments,{});}});assert.equal(refused.status,'refused');assert.equal(refused.normalizationReconstructed,false);
    assert(dispatched.length<=2);assert(dispatched.every(q=>digest(q.arguments.request.seeds)!==digest(altered.input.normalized[0].core.seeds)),'An original label-array reorder cannot dispatch the altered world or become an adopted partial replay.');
    assert.deepEqual(row.record.input.normalized[0].core.hypotheses,originalLabels);
  }finally{await f.cleanup();}
});
