import test from 'node:test';
import assert from 'node:assert/strict';
import {compactContextPayload,restoreContextPayload} from './context-compaction.mjs';

const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};
const text=(prefix,length)=>`${prefix}:`+'0123456789abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(length/36)).slice(0,length);

test('exact trusted skill bundle remains readable and is never table-encoded or pruned',()=>{
  const matchupSkill={version:'fixture',sha256:'f'.repeat(64),files:Array.from({length:10},(_,index)=>({path:`reference-${index}.md`,sha256:'a'.repeat(64),content:('Exact skill file text with public https://example.org/source and newlines.\n').repeat(30)}))};
  const payload={...largeFixture(),matchupSkill};
  const result=compactContextPayload(payload,{maxBytes:512000,targetBytes:24000});
  assert(result.fits);assert.deepEqual(result.payload.matchupSkill,matchupSkill);
  assert(!(result.payload.contextEncoding?.operations??[]).some(path=>path.includes('matchupSkill')));
  assert.deepEqual(restoreContextPayload(result.payload).matchupSkill,matchupSkill);
});

function largeFixture() {
  const permanentData={allQualifiers:{itemKnown:false,investment:'unknown',survival:null,negativeEvidence:false},novelConditions:Array.from({length:12},(_,index)=>({condition:`novel-${index}`,scope:'supplied-complete-sheet',interpretation:text('condition interpretation',130),active:false,known:null})),unknownFutureField:{nested:['first','second',null,false]}};
  const actors=Array.from({length:24},(_,index)=>({id:`actor-${index}`,own:index<12,slot:index%2+1,completeCurrentForm:'supplied-form',hp:{current:73,max:100,precision:'server-display'},status:null,fainted:false,itemKnown:false,permanentData:clone(permanentData),moves:Array.from({length:4},(_,move)=>({slot:move+1,name:`Move-${move}`,unknownInvestment:'unknown',fullSuppliedDetails:text('move',160)}))}));
  const sheet=Array.from({length:12},(_,index)=>({species:`Species-${index}`,ability:'Published ability',item:'Published item',moves:['Move-A','Move-B','Move-C','Protect'],fullSheet:clone(permanentData),investments:'unknown',publishedDoesNotRevealSelection:true}));
  return {
    board:{weather:null,terrain:null,fullNovelBoardField:{raw:'keep me',falseQualifier:false}},actors,opponentSheet:sheet,ownTeam:clone(sheet),
    legalOptions:{kind:'turn',columns:['ref','label'],slots:[1,2].map(activeSlot=>({activeSlot,options:Array.from({length:48},(_,index)=>[`f_${String(activeSlot*100+index).padStart(16,'0')}`,`Complete legal option ${index}`])}))},
    referenceMenu:{allChoices:Array.from({length:12},(_,index)=>({ref:`reference-${index}`,label:'readable shape'}))},
    optionRefs:Array.from({length:8},(_,index)=>({ref:`external-ref-${index}`,action:{type:'move',slot:1,target:2}})),
    recipientEffects:{blocked:[{actorId:'actor-1',targetId:'actor-12',reason:'current immunity',unknown:false}]},
    resources:Array.from({length:10},(_,index)=>({kind:`resource-${index}`,actors:['actor-1','actor-2'],scope:'selected-own-team',unique:false,qualification:'unknown'})),
    observedOrderConstraints:Array.from({length:8},(_,index)=>({id:`current-order-${index}`,faster:'actor-1',slower:'actor-12',conditions:clone(permanentData),guaranteed:false})),
    recentEvents:['CURRENT FIRST','CURRENT SECOND'],
    strategicMemory:{facts:{confirmedReveals:[{actor:'actor-12',known:false,item:null,raw:'must survive'}],observedOrderConstraints:[{raw:'past supplied constraint',confidence:'unknown'}],recentEvents:['archived first','archived second']},claims:{currentPlan:{objective:'Retain the complete answer.',preserveIds:['actor-3']},lastGameAdaptations:['old claim']}},
    novelProtectedField:{unknownValue:null,negative:false,ordered:[3,1,2]},
  };
}

test('novel repeated actors and complete sheets losslessly fit below 32k with complete readable choices',()=>{
  const source=largeFixture(),before=clone(source);freeze(source);
  assert(bytes(source)>96000);
  const result=compactContextPayload(source,{maxBytes:32000,targetBytes:24000,instructionBytes:1200,schemaBytes:800});
  assert.equal(result.fits,true);
  assert(result.metadata.finalBytes<=32000);
  assert(result.metadata.finalBytes<result.metadata.originalBytes);
  assert.equal(result.metadata.originalBytes,bytes(source)+2000);
  assert.equal(result.metadata.finalBytes,bytes(result.payload)+2000);
  assert.equal(result.metadata.lossless,true);
  assert.equal(result.metadata.losslessRoundtripVerified,true);
  assert.deepEqual(result.metadata.omittedHistory,[]);
  assert(result.payload.contextEncoding.operations.length>0);
  assert.deepEqual(result.payload.legalOptions,source.legalOptions);
  assert.deepEqual(result.payload.optionRefs,source.optionRefs);
  assert.deepEqual(restoreContextPayload(JSON.parse(JSON.stringify(result.payload))),source);
  assert.deepEqual(source,before);
  assert.deepEqual(compactContextPayload(source,{maxBytes:32000,targetBytes:24000,instructionBytes:1200,schemaBytes:800}),result);
});

test('missing/null/false/unknown and hostile ordinary marker or prototype keys are retained',()=>{
  const hostile=JSON.parse('{"__proto__":{"polluted":"ordinary data"},"constructor":{"prototype":{"polluted":false}},"kind":"lossless-columnar-context","version":1,"operations":[["fake"]]}');
  const source={rows:Array.from({length:40},(_,index)=>({id:index,full:text('qualifiers',200),flag:false,unknown:'unknown',marker:clone(hostile),...(index%3===0?{optional:null}:index%3===1?{optional:false}:{})})),contextEncoding:{kind:'ordinary-root-marker',value:clone(hostile)},legalOptions:{all:[clone(hostile),clone(hostile)]}};
  const before=clone(source),result=compactContextPayload(source,{maxBytes:32000,targetBytes:0});
  assert.equal(result.metadata.losslessRoundtripVerified,true);
  const restored=restoreContextPayload(clone(result.payload));
  assert.deepEqual(restored,source);
  assert.equal(Object.hasOwn(restored.rows[2],'optional'),false);
  assert.equal(restored.rows[0].optional,null);
  assert.equal(restored.rows[1].optional,false);
  assert.equal(Object.hasOwn(restored.rows[0].marker,'__proto__'),true);
  assert.equal(Object.getPrototypeOf(restored.rows[0].marker),Object.prototype);
  assert.equal(Object.prototype.polluted,undefined);
  assert.deepEqual(source,before);
});

test('children are encoded before parent arrays and restored only through declared paths',()=>{
  const source={groups:Array.from({length:20},(_,index)=>({id:index,rows:Array.from({length:20},(_,row)=>({id:row,description:text('repeated nested statement',180),falseQualifier:false})),other:'same'})),ordinary:{defaults:{a:false},columns:['b'],rows:[[null]],absent:[[0,0]]}};
  const result=compactContextPayload(source,{targetBytes:0,maxBytes:32000});
  assert.equal(result.fits,true);
  const operations=result.payload.contextEncoding.operations;
  assert(operations.some(path=>path.length===3&&path[0]==='groups'&&path[2]==='rows'));
  assert.deepEqual(operations.at(-1),['groups']);
  assert.deepEqual(restoreContextPayload(clone(result.payload)),source);
});

function historyFixture({claims=3,events=8}={}) {
  return {currentProtected:text('immutable current board',2200),recentEvents:[text('CURRENT event',700)],legalOptions:{slots:[{activeSlot:1,options:[['f_0000000000000001','first legal']]},{activeSlot:2,options:[['f_0000000000000002','second legal']]}]},actors:[{id:'own',hp:{current:10,max:100},unknown:'unknown'}],opponentSheet:[{species:'complete',moves:['A','B','C','D']}],recipientEffects:{blocked:[]},resources:[{kind:'weather',unique:false}],observedOrderConstraints:[{raw:'current qualifier',known:false}],strategicMemory:{facts:{confirmedReveals:[{raw:text('confirmed reveal',130),known:false}],observedOrderConstraints:[{raw:'full archived constraint',known:null}],recentEvents:Array.from({length:events},(_,index)=>text(`archive-${index}`,1000))},claims:{currentPlan:{objective:'A protected current plan',preserveIds:['own']},lastGameAdaptations:Array.from({length:claims},(_,index)=>text(`old-agent-claim-${index}`,2000))}},contextCoverage:{priorUnknownField:{raw:'protected'}}};
}

test('only oldest archived claims then raw events are trimmed, disclosed, and stopped at the hard cap',()=>{
  const source=historyFixture(),before=clone(source);freeze(source);
  const maxBytes=bytes(source)-7600,result=compactContextPayload(source,{maxBytes,targetBytes:0});
  assert.equal(result.fits,true);
  const restored=restoreContextPayload(result.payload),omitted=result.metadata.omittedHistory;
  assert.equal(omitted[0].path,'strategicMemory.claims.lastGameAdaptations');
  assert.equal(omitted[0].count,3);
  assert.equal(omitted[1].path,'strategicMemory.facts.recentEvents');
  assert(omitted[1].count>0&&omitted[1].count<=8);
  assert.deepEqual(restored.strategicMemory.claims.lastGameAdaptations,source.strategicMemory.claims.lastGameAdaptations.slice(3));
  assert.deepEqual(restored.strategicMemory.facts.recentEvents,source.strategicMemory.facts.recentEvents.slice(omitted[1].count));
  assert.deepEqual(restored.contextCoverage.priorUnknownField,source.contextCoverage.priorUnknownField);
  assert.deepEqual(restored.contextCoverage.boundedContextCompaction.omittedHistory,omitted);
  assert.match(restored.contextCoverage.boundedContextCompaction.historyCoverage,/unknown coverage, never negative evidence/u);
  for(const key of ['actors','opponentSheet','recentEvents','legalOptions','recipientEffects','resources','observedOrderConstraints','currentProtected'])assert.deepEqual(restored[key],source[key],key);
  for(const key of ['confirmedReveals','observedOrderConstraints'])assert.deepEqual(restored.strategicMemory.facts[key],source.strategicMemory.facts[key],key);
  assert.deepEqual(restored.strategicMemory.claims.currentPlan,source.strategicMemory.claims.currentPlan);
  assert.equal(result.metadata.lossless,false);
  assert.equal(result.metadata.compactionStages.length,1+omitted.reduce((sum,row)=>sum+row.count,0));
  assert(result.metadata.compactionStages.at(-2).afterBytes>maxBytes,'Stop immediately once the hard cap is met');
  assert.deepEqual(source,before);
});

test('soft target never removes optional history and absent containers are not invented',()=>{
  const source=historyFixture(),result=compactContextPayload(source,{maxBytes:50000,targetBytes:100});
  assert.equal(result.fits,true);
  assert.equal(result.metadata.targetExceeded,true);
  assert.deepEqual(result.metadata.omittedHistory,[]);
  assert.deepEqual(restoreContextPayload(result.payload),source);
  const absent={protected:text('unique board',1500)},small=compactContextPayload(absent,{maxBytes:100,targetBytes:0});
  assert.equal(small.fits,false);
  assert.deepEqual(small.payload,absent);
  assert.equal(Object.hasOwn(small.payload,'strategicMemory'),false);
  assert.equal(Object.hasOwn(small.payload,'contextCoverage'),false);
});

test('the lower hard cap and total instruction/schema overhead are authoritative',()=>{
  const source={protected:text('full unique supplied field',1500)},result=compactContextPayload(source,{maxBytes:1000,targetBytes:24000,instructionBytes:200,schemaBytes:100});
  assert.equal(result.fits,false);
  assert.equal(result.metadata.hardCapBytes,1000);
  assert.equal(result.metadata.hardCapExceeded,true);
  assert.equal(result.metadata.targetExceeded,false);
  assert.equal(result.metadata.finalBytes,bytes(source)+300);
  assert.equal(result.metadata.compactionStages[0].stage,'lossless');
  assert.deepEqual(result.payload,source);
});

test('an immutable unique protected field fails safely after at most three plus eight archive removals',()=>{
  const source={...historyFixture({claims:7,events:12}),uniqueProtected:text('cannot drop this supplied unknown field',50000)},result=compactContextPayload(source,{maxBytes:4000});
  assert.equal(result.fits,false);
  assert.deepEqual(result.metadata.omittedHistory.map(({path,count})=>({path,count})),[{path:'strategicMemory.claims.lastGameAdaptations',count:3},{path:'strategicMemory.facts.recentEvents',count:8}]);
  assert.equal(result.metadata.compactionStages.length,12);
  const restored=restoreContextPayload(result.payload);
  assert.equal(restored.uniqueProtected,source.uniqueProtected);
  assert.deepEqual(restored.strategicMemory.claims.lastGameAdaptations,source.strategicMemory.claims.lastGameAdaptations.slice(3));
  assert.deepEqual(restored.strategicMemory.facts.recentEvents,source.strategicMemory.facts.recentEvents.slice(8));
});

test('small inputs are unchanged and ambiguous existing coverage facts are never overwritten',()=>{
  const source={board:{known:false,unknown:null},legalOptions:{allChoices:[1,2,3]}},result=compactContextPayload(source);
  assert.equal(result.fits,true);assert.deepEqual(result.payload,source);assert.deepEqual(result.metadata.compactionStages,[]);
  const blocked={...historyFixture(),contextCoverage:'supplied coverage fact'},attempt=compactContextPayload(blocked,{maxBytes:100});
  assert.equal(attempt.fits,false);
  assert.deepEqual(attempt.metadata.omittedHistory,[]);
  assert.deepEqual(restoreContextPayload(attempt.payload),blocked);
  assert.match(attempt.metadata.reason,/protected value prevents archive disclosure/u);
});

test('malformed manifests, unsafe paths, dictionary indexes and absent coordinates are rejected',()=>{
  const source={rows:Array.from({length:20},(_,id)=>({id,shared:text('default',120),flag:id%2===0,missing:id%3===0?null:false}))};
  const valid=compactContextPayload(source,{targetBytes:0,maxBytes:32000}).payload;
  assert(valid.contextEncoding);
  for(const path of [['__proto__'],['constructor','prototype'],['rows',-1],['rows',0.5],[],['missing']]){
    const malformed=clone(valid);malformed.contextEncoding.operations=[path];
    assert.throws(()=>restoreContextPayload(malformed),{code:'ISOLATED_CONTEXT_ENCODING_INVALID'});
  }
  const duplicate=clone(valid);duplicate.contextEncoding.operations.push(duplicate.contextEncoding.operations[0]);
  assert.throws(()=>restoreContextPayload(duplicate),/Duplicate context encoding path/u);
  const unknown=clone(valid);unknown.contextEncoding.unrecognized='discard me';
  assert.throws(()=>restoreContextPayload(unknown),/Unsupported context encoding manifest/u);
  const badCell=clone(valid);badCell.rows.dictionaries={'0':['only']};badCell.rows.rows[0][0]=100;
  assert.throws(()=>restoreContextPayload(badCell),/Invalid context dictionary index/u);
  const badAbsent=clone(valid);badAbsent.rows.absent=[[9999,0]];
  assert.throws(()=>restoreContextPayload(badAbsent),/Invalid absent context coordinate/u);
  assert.equal(Object.prototype.polluted,undefined);
});

test('unencodable or overbound input fails without invoking accessors or mutating source',()=>{
  let invoked=false;const accessor={};Object.defineProperty(accessor,'secret',{get(){invoked=true;return 'no';},enumerable:true});
  for(const source of [accessor,{text:'x'.repeat(8*1024*1024+1)},{value:Infinity},{value:-0},{value:undefined},{value:1n}]){
    const result=compactContextPayload(source,{maxBytes:32000});
    assert.equal(result.fits,false);assert.equal(result.payload,source);assert.equal(result.metadata.losslessRoundtripVerified,false);
  }
  assert.equal(invoked,false);
  const cycle={};cycle.self=cycle;assert.equal(compactContextPayload(cycle).fits,false);
  const deep={};let cursor=deep;for(let index=0;index<42;index++){cursor.next={};cursor=cursor.next;}
  assert.equal(compactContextPayload(deep).fits,false);
});

test('8MiB input capacity preserves large text and arrays beyond the former preparation limits',()=>{
  const source={currentText:'x'.repeat(2*1024*1024),rows:Array.from({length:5000},(_,index)=>index),unknown:null};
  const compacted=compactContextPayload(source,{maxBytes:8*1024*1024,targetBytes:8*1024*1024});
  assert.equal(compacted.fits,true);assert.deepEqual(restoreContextPayload(compacted.payload),source);
  assert.throws(()=>restoreContextPayload({text:'x'.repeat(8*1024*1024+1)}),{code:'ISOLATED_CONTEXT_ENCODING_INVALID'});
});

test('an existing reserved transport manifest must be restored before recompaction',()=>{
  const source={rows:Array.from({length:30},(_,id)=>({id,shared:text('repeated',200)}))};
  const encoded=compactContextPayload(source,{targetBytes:0}).payload;
  const attempt=compactContextPayload(encoded);
  assert.equal(attempt.fits,false);
  assert.equal(attempt.payload,encoded);
  assert.match(attempt.metadata.reason,/must be restored before compaction/u);
  assert.deepEqual(restoreContextPayload(encoded),source);
  assert.equal(compactContextPayload(restoreContextPayload(encoded)).fits,true);
});

test('encoding operations and candidate evaluations remain deterministic and bounded',()=>{
  const source=Object.fromEntries(Array.from({length:300},(_,index)=>[`novel-${index}`,Array.from({length:6},(_,row)=>({id:row,details:text('shared repeated data',200),known:false}))]));
  const result=compactContextPayload(source,{targetBytes:0,maxBytes:1000000});
  assert.equal(result.fits,true);
  assert(result.payload.contextEncoding.operations.length<=256);
  assert(result.metadata.compactionStages.every(stage=>stage.evaluations<=4096));
  assert.deepEqual(restoreContextPayload(clone(result.payload)),source);
  assert.deepEqual(compactContextPayload(source,{targetBytes:0,maxBytes:1000000}),result);
});
