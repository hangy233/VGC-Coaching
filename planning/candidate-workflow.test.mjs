import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {registerPlanningTools} from './mcp-tools.mjs';
import {createTurnBrief} from './service.mjs';
import {planningFixture} from './fixtures.mjs';
import {projectDecisionView} from './decision-view.mjs';

const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const copy=structuredClone;
function fixture(){
  const data=planningFixture(),teamId='a'.repeat(64),token='b'.repeat(64),room='battle-gen9championsvgc2026regmcbo3-9101';
  const request={kind:'observed',sessionId:'candidate-workflow-fixture',teamId,room,rqid:2,token};
  const board={...data.board,room,request:{rqid:2},opponentSheets:{p2:data.opponentSheet}};
  const state={sessionId:request.sessionId,teamSha256:teamId,connected:true,authenticated:true,stopped:false,
    actions:[{kind:'turn',actionable:true,room,rqid:2,token,legalActions:data.legalActions}],boards:[board],rooms:[],controlPolicy:{pending:[]}};
  let numericalCalls=0;
  const callTool=Object.assign(async()=>{numericalCalls++;throw new Error('Preparation must not invoke a numerical tool');},{runtimeVersion:'candidate-workflow-fixture-runtime'});
  const options={workspace:process.cwd(),callTool,loadTeam:async()=>({teamId,team:data.ownTeam}),
    call:async(_path,command)=>({ok:true,result:command.op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:copy(state)})};
  const handlers=new Map();registerPlanningTools({registerTool(name,_config,handler){handlers.set(name,handler);}},options);
  const rawInvoke=(name,args,extra)=>handlers.get(name)(args,extra);
  const invoke=async(name,args,extra)=>{
    const reply=await rawInvoke(name,args,extra);assert.equal(reply.isError,undefined,reply.content?.[0]?.text);return reply.structuredContent;
  };
  const input={request,maxCalls:0,maxCandidates:6,budgetMs:1000,view:'full',objective:{preserve:['p1-dragon']}};
  return {data,state,request,options,input,invoke,rawInvoke,get numericalCalls(){return numericalCalls;}};
}

test('actual registered brief prepares real independent check IDs without executing a calculator',async()=>{
  const f=fixture(),report=await f.invoke('battle_turn_brief',f.input);
  assert.equal(f.numericalCalls,0);assert.equal(report.coverage.numerics.attemptedCalls,0);
  assert.equal(report.candidateEvidence.kind,'candidate-evidence-comparison-v1');
  assert(report.candidateEvidence.candidates.length>0&&report.candidateEvidence.candidates.length<=3);
  assert(report.candidates.every(candidate=>candidate.heuristic===true&&candidate.qualitativeAlignment.deliveryVerified===false));
  const research=report.candidateResearch;
  assert(['prepared','partial'].includes(research.status));assert.match(research.catalogId,/^catalog-[a-f0-9]{24}$/);
  assert.equal(research.source.boardHash,report.source.boardHash);assert(research.questions.length<=4);
  const ready=research.candidates.find(row=>row.ids?.length);
  assert(ready,'A known own-actor Speed question should have a real prepared ID');
  const order=research.questions.find(row=>row.focus.kind==='move-order'&&row.status==='ready');
  assert(order);assert.deepEqual(order.orderCoverage.requestedActorIds,report.actors.filter(actor=>[1,2].includes(actor.slot)).map(actor=>actor.id));
  assert.equal(order.orderCoverage.status,'partial');
  assert(!order.actorIds.includes('p2-chomp'),'Unknown opposing investment is not an eligible Speed input');
  assert(research.candidates.filter(row=>row.questionRefs.includes(order.ref)&&row.ids?.includes(order.id)).every(row=>row.status==='partial'));
  const resolved=await f.invoke('battle_resolve_checks',{catalogId:research.catalogId,ids:ready.ids,actions:ready.actions});
  assert.equal(resolved.status,'resolved');assert.equal(f.numericalCalls,0);
  assert.equal(resolved.inputBinding.source.boardHash,report.source.boardHash);
  assert.equal(report.actors.find(actor=>actor.id==='p2-chomp').statPoints,null);
  for(const row of report.candidateEvidence.candidates){
    assert.equal(row.payoff.status,'unavailable');assert(row.payoff.targetRemoval.every(value=>value.status==='unavailable'));
    assert.equal(row.continuation.status,'unavailable');
  }
});

test('tight budgets skip preparation and changed sources never expose prepared references as current',async()=>{
  const f=fixture();let preparations=0;
  const short=await createTurnBrief({...f.input,budgetMs:100},{...f.options,prepareChecks:async()=>{preparations++;throw Error('Must skip');}});
  assert.equal(preparations,0);assert.equal(short.coverage.numerics.attemptedCalls,0);
  assert.equal(short.candidateResearch.catalogId,undefined);assert.equal(f.numericalCalls,0);
  const changed=await createTurnBrief(f.input,{...f.options,prepareChecks:async()=>{
    preparations++;f.state.actions=[];return {kind:'champions-research-menu',source:{},status:'unavailable'};
  }});
  assert.equal(preparations,1);assert.equal(changed.status,'stale-source');assert.deepEqual(changed.candidates,[]);
  assert.equal(changed.candidateResearch,undefined);assert.equal(changed.candidateEvidence.status,'unavailable');
});

test('decision display stays bounded without promoting unsupported comparison claims',async()=>{
  const f=fixture(),report=await f.invoke('battle_turn_brief',f.input);
  const view=projectDecisionView(report,{legalActions:f.data.legalActions,maxBytes:4096});
  assert(Buffer.byteLength(JSON.stringify(view))<=4096);assert(view.candidates.length>0);
  assert(view.candidates.every(candidate=>candidate.delivery==='unchecked'));
  const changed=copy(report);changed.candidateEvidence.candidates[0].payoff.status='supported';
  const refused=projectDecisionView(changed,{legalActions:f.data.legalActions});
  assert.equal(refused.candidateEvidence,undefined);assert(refused.candidates.every(candidate=>candidate.evidence===undefined));
});

test('registered cancellation and cancellation during final source validation expose no current references',async()=>{
  const first=fixture(),already=new AbortController();already.abort();
  const refused=await first.rawInvoke('battle_turn_brief',first.input,{signal:already.signal});
  assert.equal(refused.isError,true);assert.match(refused.content[0].text,/cancelled/);assert.equal(first.numericalCalls,0);
  const second=fixture(),controller=new AbortController(),originalCall=second.options.call;let turnReads=0;
  await assert.rejects(createTurnBrief(second.input,{...second.options,signal:controller.signal,
    prepareChecks:async()=>({kind:'champions-research-menu',status:'full-menu-required'}),
    call:async(path,command)=>{const result=await originalCall(path,command);if(command.op==='turn-status'&&++turnReads===2)controller.abort();return result;}
  }),/cancelled/);
  assert.equal(second.numericalCalls,0);
});
