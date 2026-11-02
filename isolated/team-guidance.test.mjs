import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareTeamGuidance,verifyTeamGuidance,presentTeamGuidance,TEAM_GUIDANCE_LIMITS} from './team-guidance.mjs';
import {compactContextPayload,restoreContextPayload} from './context-compaction.mjs';

const TEAM='a'.repeat(64),OTHER='b'.repeat(64),SKILL='c'.repeat(64),EVIDENCE='d'.repeat(64);
const PARENT='game-bestof3-gen9championsvgc2026regmcbo3-12345';
const CHILDREN=['battle-gen9championsvgc2026regmcbo3-12346','battle-gen9championsvgc2026regmcbo3-12347'];
const copy=value=>structuredClone(value);
function fixture(){
  const result={outcome:'loss',completed:true,source:'stored-official-parent-result'};
  const metadata={teamId:TEAM,parentId:PARENT,complete:true,blockers:[],revision:2,reviewedAt:'2026-10-31T17:00:00.000Z',evidenceRevision:EVIDENCE,expectedChildIds:CHILDREN,officialResult:result};
  const checkpoint={schemaVersion:2,status:'review-complete',...metadata,teamSha256:TEAM,children:CHILDREN.map(id=>({id,outcome:'loss'})),
    metricsEvidence:{teamId:TEAM,cachedSheetMatch:true},
    adoption:{syncVerified:true,changedInstructionsRead:true,sourceSha256:SKILL,installedSha256:SKILL},
    decisionReview:[{knownBefore:'Old Raichu Speed178; old chosen reserves were Foo and Bar.',executed:'Old raw board must never become current facts.'}],
    reusableOutcome:{kind:'lesson',reason:'Resolve the changed exposure before crediting a preserved attacker.',counterexample:'A purposeful trade with delivered partner progress and a usable finish remains valid.'},
    positiveEvidence:[{observation:'Old actual move order and selected opponent reserves.',whyPreserve:'Protect plus delivered partner progress can earn the next useful entry.'}],
    validation:[
      {check:'Private pattern card: Fire delivery',result:'Application missed repeatedly; proposed answer remains untested.',evidence:`${PARENT}G1T2. Trigger: revealed Fire coverage after Mega. Plan: compare current and selected forms, both foes and the first usable attack. Countercase: an already established mitigating field or a delivered priority trade. Status: proposed.`},
      {check:'Private pattern card: Weather transition',result:'Reset partially executed; not demonstrated finish.',evidence:'Trigger: weather overwrite or expiration. Plan: retain the reset for an actual surviving beneficiary and first action. Countercase: a spent setter can trade for a checked finish.'},
      {check:'Private pattern card: Copying priority protection',result:'Fresh opportunity remains untested.',evidence:'Plan: resolve the possible entry copy before crediting priority denial; countercase eligible stay-in denial.'},
      {check:'Irrelevant historical facts',result:'Enemy Speed178, selected reservesFooBar.',evidence:'This is not a plan card and must not be copied.'}
    ]};
  return {teamId:TEAM,skillSha256:SKILL,reviewStatus:{...metadata,required:true,exists:true},reviewGet:{...metadata,exists:true,checkpointFile:`cache/champions-mc-reviews/${PARENT}.json`,checkpoint}};
}

test('loads complete reviewed exact-team cards, positive counterbalance and mechanical source receipt without current opponent facts',()=>{
  const input=fixture(),bundle=prepareTeamGuidance(input);
  assert.equal(bundle.context.available,true);
  assert.equal(bundle.context.cards[0].kind,'prior-plan');
  assert.match(bundle.context.cards[0].id,/^lesson-[a-f0-9]{16}$/u);
  assert.equal(bundle.context.cards[0].status,'application-missed');
  assert.match(bundle.context.cards[0].priorFinding,/missed repeatedly/u);
  assert.equal(bundle.context.cards[1].kind,'positive-pattern');
  assert.match(bundle.context.cards[1].plan,/partner progress/u);
  assert.match(bundle.context.globalLimits,/purposeful trade/u);
  assert.equal(bundle.receipt.source.parentId,PARENT);
  assert.equal(bundle.receipt.source.revision,2);
  assert.equal(bundle.receipt.version,2);
  assert.equal(bundle.receipt.hashAlgorithm,'sha256-canonical-json-v1');
  assert.equal(bundle.receipt.contextHashScope,'canonical-json-values');
  assert.equal(bundle.receipt.source.hashScope,'JSON.stringify(checkpoint)');
  assert.equal(bundle.receipt.contextBytes,Buffer.byteLength(JSON.stringify(bundle.context)));
  assert.equal(verifyTeamGuidance(bundle,{teamId:TEAM,skillSha256:SKILL,reviewGet:input.reviewGet}),true);
  const visible=JSON.stringify(bundle.context);
  assert.doesNotMatch(visible,/Speed178|Foo|Bar|selected reserves|Old raw board/u);
  assert.doesNotMatch(visible,new RegExp(PARENT,'u'));
  assert.equal(Object.isFrozen(bundle.context.cards),true);
  assert.equal(Object.hasOwn(bundle.context,'facts'),false);
});

test('compact advice is a separately bound partial view with whole first issue and positive countercase, never a replacement load receipt',()=>{
  const input=fixture(),bundle=prepareTeamGuidance(input),before=copy(bundle),view=presentTeamGuidance(bundle,{compact:true});
  assert.equal(view.kind,'partial-prior-exact-team-advice');assert.equal(view.sourceLoadRef,bundle.receipt.id);
  assert.equal(Object.hasOwn(view,'loadRef'),false);assert.notEqual(view.presentationSha256,bundle.receipt.contextSha256);
  assert.deepEqual(view.cards,[bundle.context.cards[0],bundle.context.cards[1]]);assert.equal(view.cards[1].kind,'positive-pattern');
  assert.equal(view.globalLimits,bundle.context.globalLimits);
  assert.deepEqual(view.presentation.omittedIds,bundle.context.cards.slice(2).map(card=>card.id));assert.equal(view.presentation.omittedCount,bundle.context.cards.length-2);
  assert(view.presentation.omittedPaths.includes('constraints'));assert.match(view.presentation.scope,/unknown/);
  assert.equal(verifyTeamGuidance(bundle,{teamId:TEAM,skillSha256:SKILL}),true);assert.deepEqual(bundle,before);
  assert.equal(verifyTeamGuidance({...bundle,context:view},{teamId:TEAM,skillSha256:SKILL}),false);
  assert.deepEqual(presentTeamGuidance(bundle),bundle.context);
  const small={...bundle.context,cards:bundle.context.cards.slice(0,2)};assert.deepEqual(presentTeamGuidance(small,{compact:true}),small);
  const reordered={...bundle.context,cards:[bundle.context.cards[0],bundle.context.cards[2],bundle.context.cards[1],bundle.context.cards[3]]};
  assert.equal(presentTeamGuidance(reordered,{compact:true}).cards[1].kind,'positive-pattern');
});

test('uses only the caller-validated newest exact-team checkpoint, never arbitrary historical reports',()=>{
  const input=fixture();
  input.reviewGet.checkpoint.extraHistory=[{teamId:OTHER,opponentSpeed:999,plan:'poisoned unrelated version'}];
  const bundle=prepareTeamGuidance(input);
  assert.doesNotMatch(JSON.stringify(bundle.context),/poisoned|999/u);
  assert.throws(()=>prepareTeamGuidance({...input,teamId:OTHER}),/review-status-team-mismatch/u);
  input.reviewGet.checkpoint.teamSha256=OTHER;
  assert.throws(()=>prepareTeamGuidance(input),/checkpoint-team-mismatch/u);
});

test('rejects unreviewed and current evidence-revision mismatches',()=>{
  const input=fixture();input.reviewStatus.complete=false;
  assert.throws(()=>prepareTeamGuidance(input),/review-not-current/u);
  const next=fixture();next.reviewGet.complete=false;
  assert.throws(()=>prepareTeamGuidance(next),/review-not-validated/u);
  const changed=fixture();changed.reviewGet.checkpoint.evidenceRevision='e'.repeat(64);
  assert.throws(()=>prepareTeamGuidance(changed),/checkpoint-evidence-mismatch/u);
});

test('rejects stale or unsynchronized adopted guidance instead of calling old advice currently adopted',()=>{
  for(const mutate of [
    input=>{input.reviewGet.checkpoint.adoption.sourceSha256='f'.repeat(64);},
    input=>{input.reviewGet.checkpoint.adoption.installedSha256='f'.repeat(64);},
    input=>{input.reviewGet.checkpoint.adoption.syncVerified=false;},
    input=>{input.reviewGet.checkpoint.adoption.changedInstructionsRead=false;},
  ]){const input=fixture();mutate(input);assert.throws(()=>prepareTeamGuidance(input),/stale-guidance-adoption/u);}
});

test('rejects changed revision, parent, expected children, official result and snapshot identity',()=>{
  const cases=[
    ['checkpoint-revision-mismatch',input=>{input.reviewGet.revision=3;}],
    ['checkpoint-parent-mismatch',input=>{input.reviewGet.parentId=PARENT+'0';}],
    ['checkpoint-child-mismatch',input=>{input.reviewGet.expectedChildIds=CHILDREN.slice(0,1);}],
    ['checkpoint-result-mismatch',input=>{input.reviewGet.checkpoint.officialResult.completed=false;}],
    ['checkpoint-team-mismatch',input=>{input.reviewGet.checkpoint.metricsEvidence.cachedSheetMatch=false;}],
    ['noncanonical-checkpoint',input=>{input.reviewGet.checkpointFile='cache/arbitrary-report.json';}],
  ];for(const [code,mutate]of cases){const input=fixture();mutate(input);assert.throws(()=>prepareTeamGuidance(input),new RegExp(code,'u'));}
});

test('detects mutated model context, receipt, and source after preparation',()=>{
  const input=fixture(),bundle=prepareTeamGuidance(input),context=copy(bundle),receipt=copy(bundle);
  context.context.cards[0].plan='Changed after the reviewed load';
  assert.equal(verifyTeamGuidance(context,{teamId:TEAM,skillSha256:SKILL}),false);
  receipt.receipt.source.revision=5;
  assert.equal(verifyTeamGuidance(receipt,{teamId:TEAM,skillSha256:SKILL}),false);
  const changed=copy(input.reviewGet);changed.checkpoint.validation[0].evidence='Changed source';
  assert.equal(verifyTeamGuidance(bundle,{teamId:TEAM,skillSha256:SKILL,reviewGet:changed}),false);
  assert.equal(verifyTeamGuidance(bundle,{teamId:OTHER,skillSha256:SKILL}),false);
});

test('a bounded context omits complete cards with counts instead of truncating a plan or limit',()=>{
  const input=fixture();
  for(let index=0;index<20;index++)input.reviewGet.checkpoint.validation.push({check:`Private pattern card: additional ${index}`,result:'Proposed only.',evidence:`Trigger: branch ${index}. Plan: ${'Complete careful plan. '.repeat(20)} Countercase: remain willing to trade for a real finish.`});
  const bundle=prepareTeamGuidance({...input,maxBytes:1800});
  assert.ok(bundle.receipt.contextBytes<=1800);
  assert.ok(bundle.context.coverage.omittedCards>0);
  assert.equal(bundle.context.coverage.includedCards,bundle.context.cards.length);
  assert.ok(bundle.context.cards.some(card=>card.kind==='positive-pattern'));
  assert.match(bundle.context.globalLimits,/usable finish remains valid/u);
  assert.ok(bundle.context.cards.every(card=>!card.plan.endsWith('...')));
});

test('overlarge complete guidance is refused rather than overriding an explicit cap',()=>{
  const input=fixture();input.reviewGet.checkpoint.reusableOutcome.counterexample='Required limit '.repeat(200);
  assert.throws(()=>prepareTeamGuidance({...input,maxBytes:1024}),/protected-guidance-exceeds-budget/u);
  assert.throws(()=>prepareTeamGuidance({...fixture(),maxBytes:TEAM_GUIDANCE_LIMITS.maxBytes+1}),/invalid-guidance-budget/u);
});

test('returns explicit no-prior guidance only for the service no-prior result',()=>{
  const bundle=prepareTeamGuidance({teamId:TEAM,skillSha256:SKILL,reviewStatus:{teamId:TEAM,required:false,complete:true,exists:false,parentId:null}});
  assert.equal(bundle.context.available,false);assert.deepEqual(bundle.context.cards,[]);
  assert.equal(verifyTeamGuidance(bundle,{teamId:TEAM,skillSha256:SKILL}),true);
  assert.throws(()=>prepareTeamGuidance({teamId:TEAM,skillSha256:SKILL,reviewStatus:{teamId:TEAM,required:false,complete:true,exists:true,parentId:PARENT}}),/invalid-no-prior-review/u);
});

test('an explicit reviewed no-change without pattern advice does not invent team roles or numeric facts',()=>{
  const input=fixture();input.reviewGet.checkpoint.validation=[];input.reviewGet.checkpoint.positiveEvidence=[];input.reviewGet.checkpoint.reusableOutcome={kind:'no-change',reason:'No supported new lesson.'};
  const bundle=prepareTeamGuidance(input);
  assert.equal(bundle.context.available,true);assert.deepEqual(bundle.context.cards,[]);
  assert.equal(bundle.context.coverage.candidateCards,0);
});

test('source hashes bind the complete checkpoint while advice avoids raw before/after battle observations',()=>{
  const input=fixture(),first=prepareTeamGuidance(input);
  const changed=fixture();changed.reviewGet.checkpoint.decisionReview[0].knownBefore='Different historical observation';
  const second=prepareTeamGuidance(changed);
  assert.notEqual(first.receipt.source.checkpointSha256,second.receipt.source.checkpointSha256);
  assert.deepEqual(first.context.cards.map(({id,...card})=>card),second.context.cards.map(({id,...card})=>card));
  assert.notEqual(first.context.cards[0].id,second.context.cards[0].id);
  assert.notEqual(first.context.loadRef,second.context.loadRef);
});

test('reports an unstructured private card rather than inventing its actionable plan',()=>{
  const input=fixture();input.reviewGet.checkpoint.validation.push({check:'Private pattern card: a historical account only',result:'Still unknown.',evidence:'The opponent had Speed178 and selected Foo. No structured proposal exists.'});
  const bundle=prepareTeamGuidance(input);
  assert.equal(bundle.context.coverage.unstructuredReviewCards,1);
  assert.doesNotMatch(JSON.stringify(bundle.context.cards),/historical account only|Speed178|selected Foo/u);
});

test('complete lossless compact and restore preserves the version-2 receipt despite shared-default key reordering',()=>{
  const input=fixture(),bundle=prepareTeamGuidance(input);
  const source={teamGuidance:bundle.context,actors:Array.from({length:12},(_,index)=>({id:'actor-'+index,kind:'complete-current-actor',facts:'Repeated complete current metadata remains protected and is restored without omissions.'}))};
  const compacted=compactContextPayload(source,{maxBytes:16000,targetBytes:0});
  assert.equal(compacted.fits,true);assert.equal(compacted.metadata.lossless,true);
  assert(compacted.metadata.compactionStages.some(stage=>stage.adopted));
  const restored=restoreContextPayload(JSON.parse(JSON.stringify(compacted.payload)));
  assert.deepEqual(restored,source);
  assert.notDeepEqual(Object.keys(restored.teamGuidance.cards[0]),Object.keys(bundle.context.cards[0]));
  const received={context:restored.teamGuidance,receipt:copy(bundle.receipt)};
  assert.equal(verifyTeamGuidance(received,{teamId:TEAM,skillSha256:SKILL,reviewGet:input.reviewGet}),true);
  received.context.cards[0].plan+=' Changed material advice.';
  assert.equal(verifyTeamGuidance(received,{teamId:TEAM,skillSha256:SKILL}),false);
});

test('version-2 context and receipt tolerate only object key order changes, preserving source checkpoint identity',()=>{
  const input=fixture(),bundle=prepareTeamGuidance(input);
  const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverse(item)])):value;
  const reordered=reverse(bundle);
  assert.equal(verifyTeamGuidance(reordered,{teamId:TEAM,skillSha256:SKILL,reviewGet:input.reviewGet}),true);
  reordered.context.cards.reverse();
  assert.equal(verifyTeamGuidance(reordered,{teamId:TEAM,skillSha256:SKILL}),false);
  const changed=copy(bundle);changed.receipt.hashAlgorithm='sha256-unspecified';
  assert.equal(verifyTeamGuidance(changed,{teamId:TEAM,skillSha256:SKILL}),false);
});

test('original version-1 in-memory receipts retain their explicitly order-sensitive validation',()=>{
  const bundle=prepareTeamGuidance(fixture()),jsonHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const {hashAlgorithm,contextHashScope,...body}=copy(bundle.receipt);body.version=1;
  body.id=jsonHash({teamId:TEAM,skillSha256:SKILL,source:body.source,maxBytes:body.maxBytes});
  const context=copy(bundle.context);context.loadRef=body.id;
  body.contextSha256=jsonHash(context);delete body.sha256;
  const legacy={context,receipt:{...body,sha256:jsonHash(body)}};
  assert.equal(verifyTeamGuidance(legacy,{teamId:TEAM,skillSha256:SKILL}),true);
  const changed=copy(legacy);changed.context.cards[0].plan+=' Altered.';
  assert.equal(verifyTeamGuidance(changed,{teamId:TEAM,skillSha256:SKILL}),false);
});
