// Pure post-loop retention tests; no model, native SDK, authentication or battle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../planning/identity.mjs';
import {preparePonderAnalysis,prepareUnvalidatedPonderDiagnostic,PONDER_EVIDENCE_LIMITS} from './ponder-evidence.mjs';
import {createModelTraceStore} from './runner.mjs';

const TEAM='a'.repeat(64),PARENT='game-bestof3-gen9championsvgc2026regmcbo3-901',ROOM='battle-gen9championsvgc2026regmcbo3-902';
const RUN='11111111-1111-4111-8111-111111111111',FREEZE='22222222-2222-4222-8222-222222222222';
const source={sessionId:'private-fixture-session',teamId:TEAM,parentId:PARENT,gameId:ROOM,sourceSha256:'b'.repeat(64)};
const frozenSource={sessionId:source.sessionId,teamId:TEAM,room:ROOM,rqid:5,token:'private-fixture-request-token'};
function analysis({compact=false}={}){
  const name=compact?'simulate_choices':'calculate_speed';
  const authoredArguments=compact?{ourActions:[{type:'pass'},{type:'pass'}],opposingActions:[{type:'pass'},{type:'pass'}]}:{pokemon:{name:'Fixture'}};
  const input=compact?{...authoredArguments,source:structuredClone(frozenSource),analysis:'frozen',freezeId:FREEZE,evidenceContext:{teamId:TEAM,roomId:ROOM,turn:1}}:{...authoredArguments,gen:0};
  const nativeResult={content:[{type:'text',text:JSON.stringify({speed:101,token:frozenSource.token,apiKey:'a-private-fake-key',password:'a-private-password',echo:'a-private-password',nested:{sessionId:source.sessionId},url:'https://private.invalid/path'})}],isError:false};
  const modelResult={content:[{type:'text',text:JSON.stringify({speed:101})}],isError:false};
  const record={name,source:structuredClone(source),frozenSource:structuredClone(frozenSource),sourceSha256:source.sourceSha256,factsSha256:'c'.repeat(64),turn:1,freezeId:FREEZE,analysis:'frozen',evidenceScope:'frozen-pre-submission-only',liveFreshness:false,choiceAuthority:false,startedAt:1000,deadlineAt:2000,settledAt:1100,inputSha256:digest(input),authoredArgumentsSha256:digest(authoredArguments),nativeResultSha256:digest(nativeResult),modelResultSha256:digest(modelResult),timely:true,outcome:'returned',authoredArguments,input,nativeResult,modelResult};
  return {version:1,frozenOnly:true,noCurrentAuthority:true,actualSDKReceiptsNotMinted:true,capturedAt:1200,settlement:{runtimeStopped:true,shadowModelPending:false,shadowClosePending:false,shadowPreflightPending:false,providerCleanupPending:false,nativeCallsPending:0},journal:{kind:'private-frozen-ponder-journal',records:[record],bytes:Buffer.byteLength(JSON.stringify(record)),maxBytes:PONDER_EVIDENCE_LIMITS.maxBytes,droppedByBound:0,complete:true}};
}
const rebudget=value=>{value.journal.bytes=value.journal.records.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row)),0);return value;};
const rangeAnalysis=()=>{const value=analysis(),row=value.journal.records[0];row.name='calculate_damage_range';row.authoredArguments={move:'Tackle'};row.input={...row.authoredArguments,gen:0};row.nativeResult={structuredContent:{kind:'champions-damage-range-v1',gen:0,status:'partial-candidate-envelope',coverage:{exhaustive:false},damageRange:{min:10,max:20,scope:'evaluated-legal-witnesses-only'}}};row.modelResult=structuredClone(row.nativeResult);row.inputSha256=digest(row.input);row.authoredArgumentsSha256=digest(row.authoredArguments);row.nativeResultSha256=digest(row.nativeResult);row.modelResultSha256=digest(row.modelResult);return rebudget(value);};
const binding={teamId:TEAM,parentId:PARENT};
async function workspace(t){const root=fileURLToPath(new URL('../cache/isolated-test-fixtures/',import.meta.url));await mkdir(root,{recursive:true});const path=await mkdtemp(join(root,'ponder-evidence-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('retains bounded frozen source/input/result evidence in the existing exact parent/team trace',async t=>{
  const root=await workspace(t),original=analysis({compact:true}),before=structuredClone(original),trace=createModelTraceStore({workspace:root,teamId:TEAM,runId:RUN});
  const receipt=await trace.append({phase:'ponder-analysis',binding,analysis:original});
  assert.equal(receipt.path,`cache/bo3-runs/${PARENT}/isolated-model-trace.json`);
  const document=JSON.parse(await readFile(join(root,receipt.path),'utf8')),saved=document.entries[0];
  assert.equal(document.teamId,TEAM);assert.equal(document.parentId,PARENT);assert.equal(saved.phase,'ponder-analysis');assert.deepEqual(saved.binding,binding);
  assert.equal(saved.analysis.frozenOnly,true);assert.equal(saved.analysis.noCurrentAuthority,true);assert.equal(saved.analysis.actualSDKReceiptsNotMinted,true);assert.equal(saved.analysis.completeAtCapture,true);
  const record=saved.analysis.journal.records[0];assert.equal(record.inputSha256,original.journal.records[0].inputSha256);assert.equal(record.nativeResultSha256,original.journal.records[0].nativeResultSha256);assert.equal(record.storedInputSha256,digest(record.input));assert.equal(record.storedNativeResultSha256,digest(record.nativeResult));assert.notEqual(record.storedInputSha256,record.inputSha256);
  assert.equal(JSON.parse(record.nativeResult.content[0].text).speed,101);assert.deepEqual(original,before);
  const text=JSON.stringify(saved);for(const secret of [frozenSource.token,source.sessionId,FREEZE,'a-private-fake-key','a-private-password','https://private.invalid'])assert(!text.includes(secret),secret);
});

test('rejects wrong team/parent, compact private source/evidence drift and original hash drift',()=>{
  const mutations=[value=>{value.journal.records[0].source.teamId='d'.repeat(64);},value=>{value.journal.records[0].source.parentId=PARENT+'1';},value=>{value.journal.records[0].input.source.rqid++;value.journal.records[0].inputSha256=digest(value.journal.records[0].input);},value=>{value.journal.records[0].input.evidenceContext.turn++;value.journal.records[0].inputSha256=digest(value.journal.records[0].input);},value=>{value.journal.records[0].nativeResult.content[0].text='changed';},value=>{value.journal.records[0].inputSha256='e'.repeat(64);}];
  for(const mutate of mutations){const value=analysis({compact:true});mutate(value);rebudget(value);assert.throws(()=>preparePonderAnalysis(value,binding),{code:'PONDER_EVIDENCE_INVALID'});}
});

test('cannot promote frozen results into current authority or claim complete unsettled retention',()=>{
  for(const field of ['frozenOnly','noCurrentAuthority','actualSDKReceiptsNotMinted']){const value=analysis();value[field]=false;assert.throws(()=>preparePonderAnalysis(value,binding));}
  const pending=analysis();pending.settlement.shadowModelPending=true;const result=preparePonderAnalysis(pending,binding);assert.equal(result.completeAtCapture,false);assert.equal(result.snapshotMayHaveLaterSettlements,true);
  const nativePending=analysis();nativePending.settlement.nativeCallsPending=1;assert.equal(preparePonderAnalysis(nativePending,binding).completeAtCapture,false);
  const dropped=analysis();dropped.journal.droppedByBound=1;dropped.journal.complete=false;assert.equal(preparePonderAnalysis(dropped,binding).completeAtCapture,false);
});

test('bounds whole records, journal bytes and trace capacity without truncation',async t=>{
  const value=analysis();value.journal.records=Array.from({length:65},()=>structuredClone(value.journal.records[0]));rebudget(value);assert.throws(()=>preparePonderAnalysis(value,binding));
  const wrongBytes=analysis();wrongBytes.journal.bytes++;assert.throws(()=>preparePonderAnalysis(wrongBytes,binding));
  const oversized=analysis();oversized.journal.records[0].nativeResult.padding='x'.repeat(PONDER_EVIDENCE_LIMITS.maxBytes);oversized.journal.records[0].nativeResultSha256=digest(oversized.journal.records[0].nativeResult);rebudget(oversized);assert.throws(()=>preparePonderAnalysis(oversized,binding));
  const root=await workspace(t),trace=createModelTraceStore({workspace:root,teamId:TEAM,runId:RUN,maxBytes:1000});await assert.rejects(trace.append({phase:'ponder-analysis',binding,analysis:analysis()}),{code:'trace'});assert.equal(trace.status().appended,0);assert.equal(trace.status().failed,true);await assert.rejects(stat(join(root,'cache','bo3-runs',PARENT,'isolated-model-trace.json')),{code:'ENOENT'});
});

test('unavailable/canceled tools retain actual late returns separately and never invent missing results',()=>{
  const value=analysis(),row=value.journal.records[0];row.outcome='unavailable';row.code='PONDER_DEADLINE';row.timely=false;row.settledAt=2200;value.capturedAt=2300;delete row.modelResult;delete row.modelResultSha256;rebudget(value);
  const saved=preparePonderAnalysis(value,binding);assert.equal(saved.journal.records[0].outcome,'unavailable');assert.equal(saved.journal.records[0].code,'PONDER_DEADLINE');assert.equal(Object.hasOwn(saved.journal.records[0],'modelResult'),false);assert.equal(saved.actualSDKReceiptsNotMinted,true);
  row.outcome='returned';delete row.code;rebudget(value);assert.throws(()=>preparePonderAnalysis(value,binding));
});

test('invalid phase metadata cannot smuggle other trace/context/action authority',async t=>{
  const root=await workspace(t),trace=createModelTraceStore({workspace:root,teamId:TEAM,runId:RUN});await assert.rejects(trace.append({phase:'ponder-analysis',binding,analysis:analysis(),decision:{actions:[]}}),{code:'trace'});assert.equal(trace.status().appended,0);
});

test('frozen gen0 range receipts retain numerical scope without current or paired authority',()=>{
  const value=rangeAnalysis(),saved=preparePonderAnalysis(value,binding),row=saved.journal.records[0];
  assert.equal(row.name,'calculate_damage_range');assert.equal(row.input.gen,0);assert.equal(row.nativeResult.structuredContent.gen,0);assert.equal(row.nativeResult.structuredContent.coverage.exhaustive,false);assert.equal(row.liveFreshness,false);assert.equal(row.choiceAuthority,false);assert.equal(saved.actualSDKReceiptsNotMinted,true);
  for(const change of [v=>{v.journal.records[0].authoredArguments.gen=9;v.journal.records[0].input.gen=9;v.journal.records[0].inputSha256=digest(v.journal.records[0].input);v.journal.records[0].authoredArgumentsSha256=digest(v.journal.records[0].authoredArguments);},v=>{v.journal.records[0].nativeResult.structuredContent.damageRange.max++;},v=>{v.journal.records[0].settledAt=2000;v.capturedAt=2100;}]){const bad=rangeAnalysis();change(bad);rebudget(bad);assert.throws(()=>preparePonderAnalysis(bad,binding));}
  const unavailable=rangeAnalysis(),record=unavailable.journal.records[0];record.outcome='unavailable';record.code='PONDER_NATIVE_UNVERIFIED';record.timely=false;delete record.modelResult;delete record.modelResultSha256;const retained=preparePonderAnalysis(rebudget(unavailable),binding);assert.equal(retained.journal.records[0].outcome,'unavailable');assert.equal(Object.hasOwn(retained.journal.records[0],'modelResult'),false);
});

test('unavailable native numeric and DOMException codes preserve their type without claiming a return',()=>{
  for(const code of [-32000,20,'ERR_ABORTED','-32600']){
    const value=analysis(),row=value.journal.records[0];row.outcome='unavailable';row.code=code;delete row.nativeResult;delete row.nativeResultSha256;delete row.modelResult;delete row.modelResultSha256;delete row.timely;rebudget(value);
    const saved=preparePonderAnalysis(value,binding);assert.equal(saved.journal.records[0].code,code);assert.equal(saved.journal.records[0].outcome,'unavailable');assert.equal(Object.hasOwn(saved.journal.records[0],'nativeResult'),false);assert.equal(saved.actualSDKReceiptsNotMinted,true);
  }
  const bad=analysis();bad.journal.records[0].outcome='unavailable';bad.journal.records[0].code={not:'an error code'};rebudget(bad);assert.throws(()=>preparePonderAnalysis(bad,binding));
});

test('a prior successful write cannot mislabel a later validation failure, whose safe source is retained as unvalidated only',async t=>{
  const root=await workspace(t),trace=createModelTraceStore({workspace:root,teamId:TEAM,runId:RUN});
  const receipt=await trace.append({phase:'ponder-analysis',binding,analysis:analysis()});
  const original=await readFile(join(root,receipt.path),'utf8'),invalid=analysis();invalid.journal.records[0].inputSha256='f'.repeat(64);
  await assert.rejects(trace.append({phase:'ponder-analysis',binding,analysis:invalid}),{code:'trace'});
  const status=trace.status();assert.equal(status.appended,1);assert.equal(status.failed,true);assert.equal(status.lastFailureCode,'TRACE_VALIDATION');assert.equal(status.lastFailureStage,'validation');
  assert.equal(await readFile(join(root,receipt.path),'utf8'),original,'failed append cannot alter validated evidence');
  assert.equal(status.failureDiagnostic.preserved,true);assert.equal(status.failureDiagnostic.validated,false);assert.equal(status.failureDiagnostic.choiceAuthority,false);
  const saved=JSON.parse(await readFile(join(root,status.failureDiagnostic.path),'utf8'));assert.equal(saved.kind,'unvalidated-ponder-archive-diagnostic');assert.equal(saved.validationPassed,false);assert.equal(saved.materialEvidenceVerified,false);assert.equal(saved.failure.stage,'validation');assert.equal(saved.source.journal.records[0].inputSha256,'f'.repeat(64));
  const text=JSON.stringify(saved);for(const secret of [frozenSource.token,source.sessionId,FREEZE,'a-private-fake-key','a-private-password','https://private.invalid'])assert(!text.includes(secret),secret);
  await assert.rejects(trace.append({phase:'ponder-analysis',binding,analysis:analysis()}),{code:'trace'});assert.equal(trace.status().lastFailureStage,'validation');assert.equal(trace.status().appended,1);
});

test('diagnostic source retention is bounded and never treats invalid/deep/oversized source as a valid receipt',()=>{
  const options={...binding,runId:RUN,stage:'validation',code:'PONDER_EVIDENCE_INVALID'};
  const good=prepareUnvalidatedPonderDiagnostic(analysis(),options);assert.equal(good.sourceRepresentation,'secret-redacted-unvalidated');assert.equal(good.validationPassed,false);assert.equal(good.actualSDKReceiptsNotMinted,true);
  const huge={data:'x'.repeat(PONDER_EVIDENCE_LIMITS.maxBytes+65536)};const omitted=prepareUnvalidatedPonderDiagnostic(huge,options);assert.equal(omitted.sourceRepresentation,'omitted');assert.equal(omitted.source,undefined);assert(Buffer.byteLength(JSON.stringify(omitted))<2000);
  const cycle={};cycle.self=cycle;assert.equal(prepareUnvalidatedPonderDiagnostic(cycle,options).sourceRepresentation,'omitted');
});
