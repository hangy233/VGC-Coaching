import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture,currentFixture} from '../simulation/observed-position.fixtures.mjs';
import {digest} from '../planning/identity.mjs';
import {translateOfflineObservedSimulation} from '../observability/offline-observed-simulation.mjs';
import {connectOfflineNumericClient} from '../observability/numeric-client.mjs';
import {unpackToolResult} from '../showdown/operator-client.mjs';
import {publishedSheetDigest} from '../simulation/observed-position.mjs';
import {createModelToolObservedQualificationAdapter,hasModelToolObservedQualificationReceipt} from './model-tool-observed-qualification.mjs';

const workspace=fileURLToPath(new URL('../',import.meta.url)),sha=value=>createHash('sha256').update(value).digest('hex'),copy=structuredClone;
const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');
const pair=[{type:'move',slot:1,target:1},{type:'move',slot:4}];
async function saved(t,{current=false}={}){
  const input=(current?currentFixture:fixture)(),state=copy(input.observed),directory=await mkdtemp(join(workspace,'cache','model-observed-qual-test-'));
  const registered=Teams.import(input.teamText);assert.equal(new TeamValidator('gen9championsvgc2026regmc').validateTeam(registered),null);input.teamText=Teams.export(registered);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  // A complete synthetic native-reader fixture, retained byte-for-byte for these
  // tests. It is never attributed to an actual played battle or provider pass.
  state.teamSha256=input.expected.teamId;state.connected=true;state.authenticated=true;state.stopped=false;
  state.boards[0].opponentSheets={p2:copy(input.opposingSheet)};state.actions[0].parentId='game-bestof3-gen9championsvgc2026regmcbo3-122';
  state.rooms=[{id:input.expected.room,parentId:state.actions[0].parentId,ended:false}];
  state.controlPolicy={pending:[{room:input.expected.room,rqid:input.expected.rqid,token:input.expected.token,cutoffAt:1000,attempted:false}]};
  const contentUtf8=JSON.stringify({payload:{result:{next:{state:{result:state}}}}}),bytes=gzipSync(JSON.stringify({entries:[{id:'synthetic-native-fixture',contentUtf8}]})),archive=join(directory,'source.json.gz');await writeFile(archive,bytes);
  const provenance={kind:'retained-native-source',entryId:'synthetic-native-fixture',archive:relative(workspace,archive).replaceAll('\\','/'),archiveSha256:sha(bytes),entrySha256:sha(contentUtf8),sourceStateSha256:digest(state)};
  const args={request:{kind:'observed',source:{sessionId:state.sessionId,...input.expected},hypotheses:copy(input.hypotheses),branches:[{id:'authored-delivery',ourActions:copy(pair),opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:1,target:2}],gate:{kind:'delivery',requiredActionsBy:['own1'],survive:['own1']}}],seeds:[[1,2,3,4],[5,6,7,8]]},evidenceContext:{teamId:state.teamSha256,roomId:input.expected.room.replace(/-[a-z0-9]+pw$/u,''),turn:state.boards[0].turn}};
  const options={workspace,state,ownTeamText:input.teamText,opponentSheet:input.opposingSheet,provenance};
  return {input,state,options,args,archive};
}
function syntheticResult(input){const request=input.request;return {structuredContent:{engine:{gen:0,format:'gen9championsvgc2026regmc'},source:{kind:'explicit-offline-snapshot',liveFreshness:false},submittedBranches:copy(request.branches),
  samples:request.branches.flatMap(branch=>request.seeds.map(seed=>({branchId:branch.id,seed:copy(seed),accepted:{[request.position.ownSide]:{accepted:true}},gate:{passed:false,cleanSample:false},boundary:'next-turn',pendingActions:[],noPendingContinuation:true,start:copy(request.position)})))}};}

async function savedWithPreview(t,{current=false,changePreview,duplicate=false,embeddedConflict=false}={}){
  const f=await saved(t,{current}),original=copy(f.state),board=original.boards[0],side=board.ownSide,foe=side==='p1'?'p2':'p1';
  delete board.opponentSheets;
  if(embeddedConflict){board.opponentSheets={[foe]:copy(f.input.opposingSheet)};board.opponentSheets[foe][0].moves[0]='Protect';}
  const preview=copy(original),action=preview.actions[0],previewBoard=preview.boards[0],sets=Teams.import(f.options.ownTeamText);
  action.kind='preview';action.rqid=1;action.revision=1;action.token='e'.repeat(64);
  action.legalActions={teamPreview:true,maxChosenTeamSize:4,pokemon:sets.map(set=>({ident:`${side}: ${set.species}`,details:`${set.species}, L50`,
    moves:set.moves.map(move=>move.toLowerCase().replace(/[^a-z0-9]/gu,'')),ability:set.ability,item:set.item}))};
  previewBoard.turn=0;previewBoard.parentId=action.parentId;previewBoard.request={rqid:1,teamPreview:true,wait:false};
  previewBoard.opponentSheets={[foe]:copy(f.input.opposingSheet)};
  changePreview?.(preview);
  const contentUtf8=JSON.stringify({payload:{result:{next:{state:{result:original}}}}});
  const previewText=JSON.stringify({payload:{result:{next:{state:{result:preview}}}}});
  const previewEntry={id:'secondary-native-preview',contentUtf8:previewText,originalFileSha256:sha(previewText)};
  const entries=[{id:'synthetic-native-fixture',contentUtf8},previewEntry,...(duplicate?[copy(previewEntry)]:[])];
  const bytes=gzipSync(JSON.stringify({teamId:original.teamSha256,entries}));await writeFile(f.archive,bytes);
  const provenance={...f.options.provenance,archiveSha256:sha(bytes),entrySha256:sha(contentUtf8),sourceStateSha256:digest(original),
    sheetContext:{sourceEntryId:previewEntry.id,sourceEntrySha256:sha(previewText),kind:'recorded-same-BO3-preview-registration',insertedIntoRawState:false}};
  return {...f,state:original,preview,previewEntry,options:{...f.options,state:original,provenance}};
}

test('same-archive native preview registration enters only a separate reconstruction view',async t=>{
  const f=await savedWithPreview(t),before=copy(f.state),args=copy(f.args),adapter=await createModelToolObservedQualificationAdapter(f.options);
  assert.equal(f.state.boards[0].opponentSheets,undefined);assert.deepEqual(f.state,before);
  const status=adapter.status();assert.equal(status.frozenSourceSha256,digest(before));
  assert.equal(status.registrationSource.kind,'verified-same-bo3-native-preview-registration');
  assert.equal(status.registrationSource.entryId,f.previewEntry.id);assert.equal(status.registrationSource.entrySha256,sha(f.previewEntry.contentUtf8));
  assert.equal(status.registrationSource.sourceStateSha256,digest(f.preview));assert.equal(status.registrationSource.sameSessionVerified,true);
  assert.equal(status.registrationSource.sameTeamVerified,true);assert.equal(status.registrationSource.sameBo3Verified,true);
  let sent;const result=await adapter.execute({name:'simulate_turn',args,deadlineAt:Date.now()+5000,callNative:async request=>{sent=copy(request.arguments);return syntheticResult(request.arguments);}});
  assert.equal(hasModelToolObservedQualificationReceipt(adapter,result),true);
  assert.deepEqual(f.state,before);assert.deepEqual(args,f.args);assert.equal(f.state.boards[0].opponentSheets,undefined);
  assert.deepEqual(sent.request.branches,f.args.request.branches);assert.deepEqual(sent.request.seeds,f.args.request.seeds);
  assert.equal(adapter.receipt(result).frozenSourceSha256,digest(before));
  assert.deepEqual(adapter.receipt(result).registrationSource,status.registrationSource);
  assert.equal(adapter.receipt(result).reconstructionViewSha256,status.reconstructionViewSha256);
});

test('secondary preview registration refuses wrong archive, entry, team, session, BO3, side or native registration',async t=>{
  for(const changePreview of [
    preview=>{preview.sessionId='another-client';},preview=>{preview.teamSha256='f'.repeat(64);},
    preview=>{preview.actions[0].parentId='game-bestof3-gen9championsvgc2026regmcbo3-999';preview.boards[0].parentId=preview.actions[0].parentId;},
    preview=>{preview.boards[0].ownSide='p2';},preview=>{preview.actions[0].kind='turn';},
    preview=>{preview.actions[0].legalActions.pokemon.pop();},preview=>{preview.actions[0].legalActions.pokemon[0].moves[0]='invalid';},
    preview=>{preview.actions[0].legalActions.pokemon[0].ability='invalid';},preview=>{preview.actions[0].legalActions.pokemon[0].item='invalid';},
    preview=>{preview.boards[0].opponentSheets.p2[0].moves[0]='Protect';},
  ]){const f=await savedWithPreview(t,{changePreview});await assert.rejects(createModelToolObservedQualificationAdapter(f.options),{code:'MODEL_TOOL_OBSERVED_QUALIFICATION'});}
  const duplicate=await savedWithPreview(t,{duplicate:true});await assert.rejects(createModelToolObservedQualificationAdapter(duplicate.options),/ambiguous/u);
  const f=await savedWithPreview(t);
  for(const change of [
    options=>{options.provenance.sheetContext.sourceEntryId='missing';},options=>{options.provenance.sheetContext.sourceEntrySha256='f'.repeat(64);},
    options=>{options.provenance.sheetContext.archive='another.json.gz';},options=>{options.provenance.sheetContext.archiveSha256='f'.repeat(64);},
    options=>{options.provenance.sheetContext.insertedIntoRawState=true;},
  ]){const options=copy(f.options);change(options);await assert.rejects(createModelToolObservedQualificationAdapter(options),{code:'MODEL_TOOL_OBSERVED_QUALIFICATION'});}
});

test('embedded registration conflicts cannot be overridden by a valid secondary preview',async t=>{
  const f=await savedWithPreview(t,{embeddedConflict:true});
  await assert.rejects(createModelToolObservedQualificationAdapter(f.options),/embedded frozen opposing sheet conflicts/u);
});

test('secondary registration supplies no missing lifecycle or investments',async t=>{
  const f=await savedWithPreview(t,{current:true}),adapter=await createModelToolObservedQualificationAdapter(f.options);let calls=0;
  for(const change of [args=>{delete args.request.hypotheses.own.own2.lifecycle;},args=>{delete args.request.hypotheses.opposing.foe0.statPoints;}]){
    const args=copy(f.args);change(args);
    await assert.rejects(adapter.execute({name:'simulate_turn',args,deadlineAt:Date.now()+5000,callNative:async()=>{calls++;throw Error('No native execution allowed');}}));
  }
  assert.equal(calls,0);assert.equal(adapter.status().executed,0);
});

const realSavedRequests=(process.env.VGC_TEST_SAVED_REQUESTS??'');
test('actual frozen T1 prepares from its verified preview without changing raw source or issuing a call',
  {skip:existsSync(realSavedRequests)?false:'Private exact saved request bundle unavailable'},async()=>{
    const data=JSON.parse(await readFile(realSavedRequests,'utf8')),row=data.requests.find(item=>item.caseId==='actual-g2-t1-material'),before=copy(row.state);
    assert.equal(row.state.boards[0].opponentSheets,undefined);
    const adapter=await createModelToolObservedQualificationAdapter({workspace,state:row.state,ownTeamText:row.ownTeamText,opponentSheet:row.opponentSheet,provenance:row.provenance});
    assert.equal(adapter.status().registrationSource.kind,'verified-same-bo3-native-preview-registration');
    assert.equal(adapter.status().registrationSource.entryId,'actual-g2-preview');assert.equal(adapter.status().executed,0);
    assert.equal(adapter.status().frozenSourceSha256,digest(row.state));assert.deepEqual(row.state,before);
    assert.equal(row.state.boards[0].opponentSheets,undefined);assert.equal(adapter.status().nativeSdkVerified,false);
  });

test('strict observed adapter verifies archive and binds unchanged authored hypotheses, pairs, gates and seeds',async t=>{
  const f=await saved(t,{current:true}),before=copy(f.args),adapter=await createModelToolObservedQualificationAdapter(f.options);let forwarded;
  const result=await adapter.execute({name:'simulate_turn',args:f.args,deadlineAt:Date.now()+5000,callNative:async request=>{forwarded=copy(request);return syntheticResult(request.arguments);}});
  assert.deepEqual(f.args,before);assert.equal(forwarded.name,'simulate_turn');assert.equal(forwarded.arguments.request.kind,'explicit');assert.equal(forwarded.arguments.evidenceContext,undefined);
  assert.deepEqual(forwarded.arguments.request.branches,f.args.request.branches);assert.deepEqual(forwarded.arguments.request.seeds,f.args.request.seeds);
  assert.equal(hasModelToolObservedQualificationReceipt(adapter,result),true);assert.equal(hasModelToolObservedQualificationReceipt(adapter,copy(result)),false);
  const receipt=adapter.receipt(result);assert.equal(receipt.provenanceVerified,true);assert.equal(receipt.readinessVerified,true);assert.equal(receipt.nativeSdkVerified,false);assert.equal(receipt.liveFreshness,false);
  assert.equal(receipt.sourceKind,'retained-native-source');assert.equal(receipt.frozenSourceSha256,digest(f.state));assert.equal(receipt.nativeInputSha256,digest(forwarded.arguments));assert.equal(receipt.nativeResultSha256,digest(result));assert.equal(receipt.evidenceWritten,false);
  assert.equal(adapter.receipt(copy(result)),null);assert.equal(hasModelToolObservedQualificationReceipt({},result),false);
  assert.deepEqual(f.state.controlPolicy.pending[0].cutoffAt,1000);assert.equal(adapter.status().journal[0].strippedInput.evidenceContext,undefined);
  result.structuredContent.samples[0].gate.passed=true;assert.equal(hasModelToolObservedQualificationReceipt(adapter,result),false);assert.equal(adapter.receipt(result),null);
});

test('changed archives, entries, team, state or registration cannot mint an observed adapter',async t=>{
  const f=await saved(t);
  for(const change of [options=>{options.provenance.archiveSha256='a'.repeat(64);},options=>{options.provenance.entrySha256='a'.repeat(64);},options=>{options.provenance.sourceStateSha256='a'.repeat(64);},options=>{options.state.boards[0].turn=2;},options=>{options.ownTeamText+='\n- Protect';},options=>{options.opponentSheet[0].moves[0]='Protect';},options=>{options.state.actions[0].legalActions.active[0].moves[0].pp=1;},options=>{options.state.actions[0].submissionStatus='uncertain';},options=>{options.state.controlPolicy.pending[0].attempted=true;},options=>{delete options.provenance;}]){
    const options=copy(f.options);change(options);await assert.rejects(createModelToolObservedQualificationAdapter(options));
  }
  await writeFile(f.archive,gzipSync(JSON.stringify({entries:[]})));await assert.rejects(createModelToolObservedQualificationAdapter(f.options),/hash changed/u);
});

test('missing embedded registration refuses with an explicit source diagnostic instead of hashing undefined',async t=>{
  const f=await saved(t),options=copy(f.options);delete options.state.boards[0].opponentSheets;
  await assert.rejects(createModelToolObservedQualificationAdapter(options),error=>error.code==='MODEL_TOOL_OBSERVED_QUALIFICATION'&&/opposing sheet/u.test(error.message));
});

test('missing model lifecycle, investments, pairs, source or evidence metadata refuses before SDK',async t=>{
  const f=await saved(t,{current:true}),adapter=await createModelToolObservedQualificationAdapter(f.options);let calls=0;
  for(const change of [args=>{delete args.request.hypotheses.own.own2.lifecycle;},args=>{delete args.request.hypotheses.opposing.foe0.statPoints;},args=>{args.request.hypotheses.reserves=[];},args=>{args.request.source.token='e'.repeat(64);},args=>{args.request.branches[0].ourActions[0].slot=99;},args=>{args.evidenceContext.turn++;},args=>{args.request.kind='explicit';}]){
    const args=copy(f.args);change(args);await assert.rejects(adapter.execute({name:'simulate_turn',args,deadlineAt:Date.now()+5000,callNative:async()=>{calls++;throw Error('No call allowed');}}));
  }
  assert.equal(calls,0);assert.equal(adapter.status().executed,0);
});

test('late, cancelled, altered or incomplete native evidence is never branded',async t=>{
  const f=await saved(t);let time=1000;const adapter=await createModelToolObservedQualificationAdapter({...f.options,now:()=>time});
  const expired=new AbortController();expired.abort();await assert.rejects(adapter.execute({name:'simulate_turn',args:f.args,deadlineAt:2000,signal:expired.signal,callNative:async()=>{throw Error('No dispatch');}}));
  for(const change of [value=>{value.structuredContent.samples=[];},value=>{value.structuredContent.samples[1]=copy(value.structuredContent.samples[0]);},value=>{value.structuredContent.submittedBranches[0].opposingActions[0].slot=4;},value=>{value.structuredContent.source.liveFreshness=true;},value=>{value.structuredContent.calculationRef={id:'not-live'};},value=>{time=2000;}]){
    time=1000;let result;await assert.rejects(adapter.execute({name:'simulate_turn',args:f.args,deadlineAt:2000,callNative:async request=>{result=syntheticResult(request.arguments);change(result);return result;}}));assert.equal(hasModelToolObservedQualificationReceipt(adapter,result),false);
  }
});

test('constructed source cannot use symbolic or unverified native starting HP',async t=>{
  const f=await saved(t),options={...f.options,provenance:{constructedOpening:true,savedBoardUsed:false,ownHp:'symbolic-full-opening-builder-only',source:f.options.provenance}};
  await assert.rejects(createModelToolObservedQualificationAdapter(options),/unsupported frozen/u);
  options.provenance.ownHp='actual-native-bootstrap-start';await assert.rejects(createModelToolObservedQualificationAdapter(options),/bootstrap evidence/u);
});

test('actual owned local MCP executes the exact translated observed model pair and yields branded reconstruction evidence', {timeout:30000},async t=>{
  const f=await saved(t),adapter=await createModelToolObservedQualificationAdapter(f.options),connection=await connectOfflineNumericClient();let sent;
  try{
    const result=await adapter.execute({name:'simulate_turn',args:f.args,deadlineAt:Date.now()+10000,callNative:async(...args)=>{sent=copy(args[0]);return connection.client.callTool(...args);}}),value=unpackToolResult(result);
    assert.equal(hasModelToolObservedQualificationReceipt(adapter,result),true);assert.equal(value.engine.gen,0);assert.equal(value.source.kind,'explicit-offline-snapshot');assert.equal(value.samples.length,2);
    const stripped=copy(f.args);delete stripped.evidenceContext;const frozen=copy(f.state);frozen.controlPolicy.pending=[];
    const expected=translateOfflineObservedSimulation('simulate_turn',stripped,{observed:frozen,teamText:f.options.ownTeamText,opposingSheet:f.options.opponentSheet});
    assert.deepEqual(sent.arguments,expected.input);assert.equal(adapter.receipt(result).nativeInputSha256,digest(sent.arguments));assert.equal(adapter.receipt(result).nativeResultSha256,digest(result));
    assert.equal(value.calculationRef,undefined);assert.equal(adapter.status().nativeSdkVerified,false,'SDK ownership remains an independent harness receipt');
  }finally{await connection.close();}
});
