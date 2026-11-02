import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactContextPayload,restoreContextPayload} from './context-compaction.mjs';
import {createCodexSessionContext,rehydrateCodexSessionContext} from './codex-session-context.mjs';
import {loadMaintainedMatchupGuidance} from './matchup-guidance.mjs';
import {ISOLATED_POLICY_SOURCE} from './decision-context.mjs';

const scope={parentId:'game-bestof3-fixture',teamId:'fixture-team'};
const schema={type:'object',properties:{choice:{type:'string'}},required:['choice'],additionalProperties:false};
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function source(turn=1){return {
  parentId:scope.parentId,teamId:scope.teamId,kind:'turn',
  guidance:{skill:'fixture',hash:'guidance-source'},
  ownTeam:[{species:'FixtureOne',moves:['Move One','Move Two'],details:'registered data '.repeat(60)}],
  opponentSheet:[{species:'FixtureTwo',moves:['Move Three'],details:'registered sheet '.repeat(60)}],
  teamGuidance:{lesson:'Retain a future answer. '.repeat(30),unknown:null},
  board:{turn,hp:[100,50],weather:turn===1?'rain':null},actors:[{slot:1,hp:100-turn,active:true}],
  legalOptions:{'1':[{ref:`move-${turn}`,move:'Move One',target:1},{ref:`switch-${turn}`,switch:3}]},
  recipientEffects:{redirect:false},resources:{rainTurns:4-turn},observedOrderConstraints:[{before:1,after:2,investment:'unknown'}],
  recentEvents:[{turn:turn-1,event:'an observed action'}],uncertainty:{speed:'unknown'},
  tacticalEvidence:{rows:[{result:{min:10,max:20},receipt:'fixture-receipt'}]},
  materialContracts:{requires:['paired-check'],fallback:{ref:`move-${turn}`}},
  strategicMemory:{facts:{lastExecuted:'observed action'},claims:{plan:`current plan ${turn}`}},
  unknownFutureField:{mustSurvive:false,number:0,text:'',absentDistinct:null},
};}
function request(turn=1,overrides={}){return {instructions:'Use current facts; never invent numeric evidence. '.repeat(25),input:JSON.stringify(source(turn)),schema:structuredClone(schema),scope,...overrides};}
function assertRoundTrip(packet,original,retained=null){
  const decoded=rehydrateCodexSessionContext(packet,retained);
  assert.equal(decoded.instructions,original.instructions);
  assert.deepEqual(JSON.parse(decoded.input),restoreContextPayload(JSON.parse(original.input)));
  assert.deepEqual(decoded.schema,original.schema);return decoded;
}

test('initial frame is complete, scoped, content-addressed, and round-trips exactly',()=>{
  const session=createCodexSessionContext(),original=request(),packet=session.prepare(original),frame=JSON.parse(packet.input);
  assert.equal(frame.sequence,1);assert.equal(frame.base,null);
  assert.deepEqual(packet.metadata.staticSent,['guidance','ownTeam','opponentSheet','teamGuidance']);
  assert.deepEqual(packet.metadata.staticRefs,[]);assert.equal(packet.metadata.resumeRequired,false);
  assert.equal(packet.metadata.fullBytes,Buffer.byteLength(original.instructions)+Buffer.byteLength(original.input)+Buffer.byteLength(JSON.stringify(schema)));
  assert.equal(packet.metadata.deliveredBytes,Buffer.byteLength(packet.instructions)+Buffer.byteLength(packet.input)+Buffer.byteLength(JSON.stringify(packet.schema)));
  assert.equal(packet.metadata.savedBytes,packet.metadata.fullBytes-packet.metadata.deliveredBytes);
  assert.equal(frame.source.inputSha256,sha(original.input));assertRoundTrip(packet,original);
  assert.equal(packet.commit().committed,true);
});

test('later frames reference only successful static content and resend every current dynamic field',()=>{
  const session=createCodexSessionContext(),firstRequest=request(),first=session.prepare(firstRequest),decodedFirst=assertRoundTrip(first,firstRequest);
  first.commit();const current=request(2),second=session.prepare(current),frame=JSON.parse(second.input);
  assert.equal(second.metadata.sequence,2);assert.equal(second.metadata.instructionReference,true);
  assert.equal(second.metadata.resumeRequired,true);assert.equal(second.metadata.savedBytes>0,true);
  assert.deepEqual(second.metadata.staticRefs,['guidance','ownTeam','opponentSheet','teamGuidance']);
  for(const key of ['board','actors','legalOptions','recipientEffects','resources','observedOrderConstraints','recentEvents','uncertainty','tacticalEvidence','materialContracts','strategicMemory','unknownFutureField']){
    assert.deepEqual(frame.current[key],JSON.parse(current.input)[key],key);
  }
  assertRoundTrip(second,current,decodedFirst.retained);second.commit();
});

test('the full maintained matchup skill is delivered once and retained across changed direct instructions',()=>{
  const skill=loadMaintainedMatchupGuidance(ISOLATED_POLICY_SOURCE),session=createCodexSessionContext();
  const firstSource={...source(1),matchupSkill:skill},firstRequest=request(1,{instructions:'First-choice JSON protocol; use matchupSkill.files.',input:JSON.stringify(firstSource)});
  const first=session.prepare(firstRequest),firstFrame=JSON.parse(first.input),retained=assertRoundTrip(first,firstRequest).retained;
  assert.equal(sha(firstFrame.static.values.matchupSkill.value),sha(skill));assert(first.metadata.staticSent.includes('matchupSkill'));first.commit();
  const nextSource={...source(2),matchupSkill:skill},nextRequest=request(2,{instructions:'Updated direct JSON protocol; use matchupSkill.files.',input:JSON.stringify(nextSource)});
  const second=session.prepare(nextRequest),frame=JSON.parse(second.input);
  assert(second.metadata.staticRefs.includes('matchupSkill'));assert(!Object.hasOwn(frame.static.values,'matchupSkill'));
  assert(!second.input.includes(skill.files.find(file=>file.path==='SKILL.md').content));
  assert.deepEqual(JSON.parse(assertRoundTrip(second,nextRequest,retained).input).matchupSkill,skill);
  assert(second.metadata.savedBytes>Buffer.byteLength(JSON.stringify(skill))-1024);second.commit();
  session.reset();const fresh=session.prepare(nextRequest);
  assert(fresh.metadata.staticSent.includes('matchupSkill'));assert.equal(sha(JSON.parse(fresh.input).static.values.matchupSkill.value),sha(skill));
});

test('prepare never establishes references until its successful commit',()=>{
  const session=createCodexSessionContext(),one=session.prepare(request()),two=session.prepare(request(2));
  assert.equal(JSON.parse(one.input).sequence,1);assert.equal(JSON.parse(two.input).sequence,1);
  assert.deepEqual(two.metadata.staticRefs,[]);one.commit();
  assert.throws(()=>two.commit(),{code:'CODEX_SESSION_CONTEXT_STALE'});
  assert.throws(()=>one.commit(),{code:'CODEX_SESSION_CONTEXT_STALE'});
});

test('generation failure invalidates base and stale commit rather than retaining unconfirmed content',()=>{
  const session=createCodexSessionContext(),first=session.prepare(request());first.commit();
  const failed=session.prepare(request(2));failed.invalidate();
  assert.throws(()=>failed.commit(),{code:'CODEX_SESSION_CONTEXT_STALE'});
  const next=session.prepare(request(3));assert.equal(next.metadata.sequence,1);assert.equal(next.metadata.instructionReference,false);assert.deepEqual(next.metadata.staticRefs,[]);
});

test('scope changes refuse until explicit reset and conflicting source identities never inherit',()=>{
  const session=createCodexSessionContext(),first=session.prepare(request());first.commit();
  assert.throws(()=>session.prepare(request(2,{scope:{...scope,parentId:'other-parent'},input:JSON.stringify({...source(2),parentId:'other-parent'})})),{code:'CODEX_SESSION_SCOPE_CHANGED'});
  assert.throws(()=>session.prepare(request(2,{scope:{...scope,teamId:'other-team'}})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  session.reset();const next=session.prepare(request(2,{scope:{...scope,parentId:'other-parent'},input:JSON.stringify({...source(2),parentId:'other-parent'})}));
  assert.equal(next.metadata.sequence,1);assert.deepEqual(next.metadata.staticRefs,[]);
});

test('optional client session identity is retained and cannot cross a resumed scope',()=>{
  const session=createCodexSessionContext(),selectedScope={...scope,sessionId:'client-one'},first=session.prepare(request(1,{scope:selectedScope}));
  first.commit();
  assert.throws(()=>session.prepare(request(2,{scope:{...selectedScope,sessionId:'client-two'}})),{code:'CODEX_SESSION_SCOPE_CHANGED'});
  const second=session.prepare(request(2,{scope:selectedScope}));assert.equal(second.metadata.scope.sessionId,'client-one');
});

test('changed static values, changed instructions and current schema are sent verbatim',()=>{
  const session=createCodexSessionContext(),original=request(),first=session.prepare(original),decoded=assertRoundTrip(first,original);first.commit();
  const currentSource=source(2);currentSource.teamGuidance={lesson:'New exact advice',unknown:false};currentSource.opponentSheet=null;
  const nextRequest=request(2,{instructions:'A different exact task.',input:JSON.stringify(currentSource),schema:{...schema,description:'current only'}});
  const next=session.prepare(nextRequest),frame=JSON.parse(next.input);
  assert.deepEqual(next.metadata.staticSent,['opponentSheet','teamGuidance']);assert.deepEqual(next.metadata.staticRefs,['guidance','ownTeam']);
  assert.equal(next.metadata.instructionReference,false);assert.equal(frame.instructions.mode,'replace');
  assertRoundTrip(next,nextRequest,decoded.retained);
});

test('deleted fields stay absent; later static reappearance is not a stale inherited reference',()=>{
  const session=createCodexSessionContext(),r1=request(),p1=session.prepare(r1),d1=assertRoundTrip(p1,r1);p1.commit();
  const s2=source(2);delete s2.teamGuidance;delete s2.materialContracts;delete s2.unknownFutureField;
  const r2=request(2,{input:JSON.stringify(s2)}),p2=session.prepare(r2),d2=assertRoundTrip(p2,r2,d1.retained);
  assert.deepEqual(p2.metadata.removedStaticFields,['teamGuidance']);p2.commit();
  const r3=request(3),p3=session.prepare(r3);assert.equal(p3.metadata.staticSent.includes('teamGuidance'),true);assertRoundTrip(p3,r3,d2.retained);
});

test('lossless columnar encoded source is decoded before static extraction without dropping facts',()=>{
  const session=createCodexSessionContext(),s=source();s.actors=Array.from({length:30},(_,i)=>({id:i,ability:'Unknown',move:'Repeated Move',active:i<2,hp:i}));
  const encoded=compactContextPayload(s,{maxBytes:96000,targetBytes:0}).payload;
  assert.equal(encoded.contextEncoding?.kind,'lossless-columnar-context');
  const r=request(1,{input:JSON.stringify(encoded)}),p=session.prepare(r),d=assertRoundTrip(p,r);
  assert.deepEqual(JSON.parse(d.input),s);assert.equal(JSON.parse(p.input).current.contextEncoding,undefined);
});

test('missing, tampered, cross-scope and wrong sequence retained bases are rejected',()=>{
  const session=createCodexSessionContext(),r1=request(),p1=session.prepare(r1),d1=assertRoundTrip(p1,r1);p1.commit();
  const p2=session.prepare(request(2));
  assert.throws(()=>rehydrateCodexSessionContext(p2),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  for(const mutate of [r=>r.scope.parentId='other',r=>r.sequence=999,r=>r.sourceHash='bad',r=>r.staticValues.ownTeam.value.push({species:'corrupt'})]){
    const retained=JSON.parse(JSON.stringify(d1.retained));mutate(retained);
    assert.throws(()=>rehydrateCodexSessionContext(p2,retained),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  }
  const corrupt=JSON.parse(p2.input);corrupt.current.board.turn=900;
  assert.throws(()=>rehydrateCodexSessionContext({...p2,input:JSON.stringify(corrupt)},d1.retained),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  assert.throws(()=>rehydrateCodexSessionContext(p1,d1.retained),{code:'CODEX_SESSION_CONTEXT_INVALID'});
});

test('preparation clones its inputs and failed validation does not change the committed base',()=>{
  const session=createCodexSessionContext(),r1=request(),p1=session.prepare(r1),d1=assertRoundTrip(p1,r1);p1.commit();
  assert.throws(()=>session.prepare(request(2,{input:'null'})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  const r2=request(2),p2=session.prepare(r2);r2.schema.description='external mutation';
  assert.equal(p2.schema.description,undefined);assertRoundTrip(p2,{...r2,schema},d1.retained);
});

test('unsafe or malformed JSON inputs do not execute getters or silently coerce values',()=>{
  const session=createCodexSessionContext();let getterRead=false;
  const hostile={get board(){getterRead=true;throw new Error('must not run');}};
  assert.throws(()=>session.prepare(request(1,{input:hostile})),{code:'CODEX_SESSION_CONTEXT_INVALID'});assert.equal(getterRead,false);
  for(const input of ['[1,2]','"scalar"','{bad',undefined,42])assert.throws(()=>session.prepare(request(1,{input})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
  assert.throws(()=>session.prepare(request(1,{scope:undefined})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
});

test('large exact research contracts are referenced while fresh state and changed output schemas remain complete',()=>{
  const session=createCodexSessionContext(),contracts={delivery:{nativeCommandSchema:{description:'Complete native research rule. '.repeat(1800),source:'source-free'}}};
  const firstRequest=request(1,{input:JSON.stringify({...source(1),teamGuidance:contracts,guidance:{requires:'useful complete independent pair'}})});
  const first=session.prepare(firstRequest),d1=assertRoundTrip(first,firstRequest);first.commit();
  const nextRequest=request(2,{input:JSON.stringify({...source(2),teamGuidance:contracts,guidance:{requires:'useful complete independent pair'}}),schema:{...schema,description:'Complete fresh schema required for turn2'}});
  const next=session.prepare(nextRequest),frame=JSON.parse(next.input);
  assert(next.metadata.staticRefs.includes('teamGuidance'));assert(next.metadata.staticRefs.includes('guidance'));
  assert(!Object.hasOwn(frame.current,'teamGuidance'));assert.equal(frame.current.board.turn,2);
  assert.deepEqual(frame.current.legalOptions,source(2).legalOptions);assert.deepEqual(next.schema,nextRequest.schema);
  assert(next.metadata.savedInputBytes>45000);assertRoundTrip(next,nextRequest,d1.retained);
});

test('changed or removed reviewed team guidance never inherits obsolete retained values',()=>{
  const session=createCodexSessionContext(),r1=request(1,{input:JSON.stringify({...source(1),teamGuidance:{version:1,delivery:{required:['old']}}})});
  const p1=session.prepare(r1),d1=assertRoundTrip(p1,r1);p1.commit();
  const r2=request(2,{input:JSON.stringify({...source(2),teamGuidance:{version:2,delivery:{required:['new']}}})});
  const p2=session.prepare(r2),d2=assertRoundTrip(p2,r2,d1.retained);
  assert(p2.metadata.staticSent.includes('teamGuidance'));assert(!p2.metadata.staticRefs.includes('teamGuidance'));p2.commit();
  const lastSource=source(3);delete lastSource.teamGuidance;const r3=request(3,{input:JSON.stringify(lastSource)}),p3=session.prepare(r3);assert(p3.metadata.removedStaticFields.includes('teamGuidance'));
  assert.equal(JSON.parse(assertRoundTrip(p3,r3,d2.retained).input).teamGuidance,undefined);
});

test('explicit8MiB source capacity accepts larger metadata without changing current facts',()=>{
  const session=createCodexSessionContext(),large=request(1,{input:JSON.stringify({...source(1),currentMetadata:'x'.repeat(2*1024*1024)})});
  const packet=session.prepare(large);assertRoundTrip(packet,large);assert.equal(JSON.parse(packet.input).current.currentMetadata.length,2*1024*1024);
  assert.throws(()=>session.prepare(request(2,{input:JSON.stringify({metadata:'x'.repeat(8*1024*1024)})})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
});

test('game identity prevents cross-child references within the same BO3 and preserves explicit last-game summary',()=>{
  const session=createCodexSessionContext(),game1={...scope,gameId:'battle-game-one'},game2={...scope,gameId:'battle-game-two'};
  const first=session.prepare(request(1,{scope:game1}));first.commit();
  assert.throws(()=>session.prepare(request(2,{scope:game2})),{code:'CODEX_SESSION_SCOPE_CHANGED'});
  session.reset();const source2={...source(2),strategicMemory:{facts:{lastGameObserved:'confirmed actual event'},claims:{lastGameAdaptations:['preserve weather setter']}}};
  const original=request(2,{scope:game2,input:JSON.stringify(source2)}),second=session.prepare(original),frame=JSON.parse(second.input);
  assert.equal(frame.scope.gameId,'battle-game-two');assert.equal(frame.base,null);assert.deepEqual(second.metadata.staticRefs,[]);
  assert.deepEqual(JSON.parse(assertRoundTrip(second,original).input).strategicMemory,source2.strategicMemory);
  assert.throws(()=>session.prepare(request(3,{scope:game2,input:JSON.stringify({...source2,gameId:'battle-game-one'})})),{code:'CODEX_SESSION_CONTEXT_INVALID'});
});
