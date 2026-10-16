import test from 'node:test';
import assert from 'node:assert/strict';
import {battlePreflight} from '../workflow/preflight.mjs';

const TEAM='a'.repeat(64),OLD='b'.repeat(64),PARENT='game-bestof3-gen9championsvgc2026regmcbo3-123';
function dependencies(changes={}){
  const status={sessionId:'fixture',connected:true,authenticated:true,stopped:false,teamSha256:TEAM,authorizedSets:2,searchesSent:1,search:{searching:[],games:{}},actions:[],rooms:[],capabilities:{operations:['start','choose','ready','metrics-sync']},metrics:{enabled:true,state:'ready',lastError:null},...changes};
  return {workspace:process.cwd(),teamId:TEAM,call:async(_path,command)=>{assert.equal(command.op,'status');return {ok:true,result:status};},skillReader:async()=>({synchronized:true}),reviewReader:async()=>({complete:true,required:false}),historyReader:async()=>[],healthReader:async()=>({teams:[{teamId:TEAM,snapshot:{status:'verified'},missingReplays:[],missingOrInvalidEvidence:[],sourceDiagnostics:[]}],pendingCleanupTeams:[]})};
}
test('preflight is observational and reports unknown or unavailable prerequisites without granting anything',async()=>{
  let result=await battlePreflight(dependencies());assert.equal(result.ready,true);assert.equal(result.session.remainingSets,1);assert.match(result.authorization,/grants no search/);
  for(const change of [{authenticated:false},{searchPending:true},{awaitingSet:true},{switchingTeam:true},{savingReplays:true},{search:null},{authorizedSets:1},{capabilities:{}},{metrics:{enabled:true,state:'error',lastError:{message:'Persistence failed'}}}]){
    result=await battlePreflight(dependencies(change));assert.equal(result.ready,false,JSON.stringify(change));assert(result.blockers.length);
  }
  result=await battlePreflight({...dependencies(),call:async()=>{throw new Error('Unavailable');}});assert.equal(result.ready,false);assert.equal(result.session,null);
  result=await battlePreflight({...dependencies(),skillReader:async()=>({synchronized:false})});assert.equal(result.ready,false);
  result=await battlePreflight({...dependencies(),reviewReader:async()=>({complete:false})});assert.equal(result.ready,false);
});
test('preflight requires a verified exact snapshot even when health fails and reviews the previous team after a switch',async()=>{
  for(const healthReader of [async()=>({teams:[]}),async()=>{throw new Error('Unknown team');}]){
    const result=await battlePreflight({...dependencies(),healthReader});assert.equal(result.ready,false);assert(result.checks.some(check=>check.name==='team-snapshot'&&!check.passed));
  }
  const target='fixture-target',reviewed=[];
  const result=await battlePreflight({...dependencies({rooms:[{id:PARENT,teamId:OLD,ended:true}]}),skillOptions:{target},reviewReader:async args=>{reviewed.push(args);return {complete:true,parentId:PARENT};}});
  assert(reviewed.some(args=>args.teamId===OLD&&args.parentId===PARENT&&args.skillOptions.target===target));assert.equal(result.reviewTeamId,OLD);assert.equal(result.ready,true);
});

test('an explicitly requested older review cannot hide a newer ended owned parent',async()=>{
  const newer='game-bestof3-gen9championsvgc2026regmcbo3-124',calls=[];
  const result=await battlePreflight({...dependencies({rooms:[{id:PARENT,teamId:TEAM,ended:true},{id:newer,teamId:TEAM,ended:true}]}),parentId:PARENT,reviewReader:async args=>{
    calls.push(args);return {complete:args.parentId!==newer,parentId:args.parentId||PARENT,blockers:args.parentId===newer?['Newest owned set lacks its review.']:[]};
  }});
  assert(calls.some(args=>args.parentId===newer));assert(calls.some(args=>args.parentId===PARENT));
  assert.equal(result.ready,false);assert.equal(result.parentId,newer);assert.equal(result.requestedParentId,PARENT);
  assert(result.blockers.some(message=>message.includes(newer)));
});

test('an older explicit parent cannot bypass the current team’s newest stored review',async()=>{
  const newer='game-bestof3-gen9championsvgc2026regmcbo3-125';let queriedLatest=false;
  const result=await battlePreflight({...dependencies(),parentId:PARENT,reviewReader:async args=>{
    if(!args.parentId){queriedLatest=true;return {complete:false,parentId:newer,blockers:['Newest stored set lacks its review.']};}
    return {complete:true,parentId:args.parentId};
  }});
  assert.equal(queriedLatest,true);assert.equal(result.ready,false);assert(result.blockers.some(message=>message.includes(newer)));
});

test('restart with team B still checks the latest locally stored parent from team A',async()=>{
  const calls=[],history=[{teamId:OLD,parentId:PARENT,metadata:{endedAt:'2026-10-15T20:00:00.000Z'}}];
  const result=await battlePreflight({...dependencies({rooms:[]}),historyReader:async args=>{assert.equal(args.includeArchived,true);return history;},reviewReader:async args=>{
    calls.push(args);return args.teamId===OLD?{complete:false,parentId:PARENT,blockers:['Previous team’s set remains unreviewed.']}:{complete:true,required:false};
  }});
  assert(calls.some(args=>args.teamId===OLD&&args.parentId===PARENT));assert.equal(result.ready,false);assert.equal(result.reviewTeamId,OLD);
  assert.equal(result.historyCoverage.source,'all-local-retained-metrics-parents');assert.match(result.historyCoverage.accountScope,/no account match/);assert.match(result.historyCoverage.externalCoverage,/unverified/);
});

test('unknown or tied local chronology remains explicit and unreadable history blocks readiness',async()=>{
  const newer='game-bestof3-gen9championsvgc2026regmcbo3-126';
  const result=await battlePreflight({...dependencies(),historyReader:async()=>[
    {teamId:OLD,parentId:PARENT,metadata:{}},
    {teamId:TEAM,parentId:newer,metadata:{endedAt:'2026-10-15T21:00:00.000Z'}},
  ],reviewReader:async args=>({complete:args.teamId!==OLD,parentId:args.parentId||null,blockers:args.teamId===OLD?['Undated local parent has no review.']:[]})});
  assert.equal(result.historyCoverage.candidates.length,2);assert.equal(result.ready,false);assert.match(result.historyCoverage.chronology,/do not prove actual battle order/);
  for(const historyReader of [async()=>{throw new Error('Storage unavailable');},async()=>null]){
    const unavailable=await battlePreflight({...dependencies(),historyReader});assert.equal(unavailable.ready,false);assert.equal(unavailable.historyCoverage.readable,false);
  }
});

test('immutable saved-ID source bindings are healthy while changed or unreadable bindings warn',async()=>{
  for(const binding of ['saved-id-only','matches-exact-team','changed-team-fingerprint','invalid-or-unreadable']){
    const result=await battlePreflight({...dependencies(),healthReader:async()=>({teams:[{teamId:TEAM,snapshot:{status:'verified'},sourceDiagnostics:[{status:'available',teamSnapshotCheck:binding}]}]})});
    assert.equal(result.warnings.some(message=>/remembered team source/u.test(message)),!['saved-id-only','matches-exact-team'].includes(binding),binding);
  }
});

test('preflight exposes incomplete authorized replay preservation even after server idle',async()=>{
  for(const replayPolicy of [{enabled:true,capable:true,active:true,pendingParents:[PARENT]},{enabled:false,capable:true,active:false,pendingParents:[PARENT]},{enabled:true,capable:false,active:false,pendingParents:[]}]){
    const result=await battlePreflight(dependencies({replayPolicy}));assert.equal(result.ready,false);assert.deepEqual(result.session.replayPolicy,replayPolicy);
  }
  const result=await battlePreflight(dependencies({replayPolicy:{enabled:true,capable:true,active:false,pendingParents:[]}}));assert.equal(result.ready,true);
});

test('production safety capabilities require one owner and enabled non-halted deadline protection',async()=>{
  const protectedSession={capabilities:{operations:['start','choose','ready','metrics-sync','control-claim','control-release','set-control-policy','stage-fallback','turn-status','control-trace'],features:{controllerLease:true,deadlineSupervisor:true,deadlinePlanningRecovery:true,compactTurnBoard:true}},controller:{required:true,owner:'batch-operator',generation:3,claimedAt:1000},controlPolicy:{enabled:true,forfeitIfStuck:false,planningMs:20000,safetyMarginMs:5000,unknownClockMs:20000,halted:false,haltReason:null,disposed:false}};
  const ready=await battlePreflight(dependencies(protectedSession));assert.equal(ready.ready,true);assert.deepEqual(ready.session.controller,protectedSession.controller);assert.deepEqual(ready.session.controlPolicy,protectedSession.controlPolicy);
  for(const change of [
    {controller:null},
    {controller:{...protectedSession.controller,owner:null}},
    {controller:{...protectedSession.controller,owner:''}},
    {controller:{...protectedSession.controller,required:false}},
    {controlPolicy:null},
    {controlPolicy:{...protectedSession.controlPolicy,enabled:false}},
    {controlPolicy:{...protectedSession.controlPolicy,halted:true,haltReason:'planning-timeout-without-fallback'}},
    {controlPolicy:{enabled:true}},
    {controlPolicy:{...protectedSession.controlPolicy,disposed:true}},
    {capabilities:{...protectedSession.capabilities,features:{controllerLease:true}}},
    {capabilities:{...protectedSession.capabilities,features:{...protectedSession.capabilities.features,deadlinePlanningRecovery:false}}},
    {capabilities:{...protectedSession.capabilities,features:{...protectedSession.capabilities.features,compactTurnBoard:false}}},
    {capabilities:{...protectedSession.capabilities,operations:['start','choose','ready','metrics-sync']}},
  ]){
    const result=await battlePreflight(dependencies({...protectedSession,...change}));assert.equal(result.ready,false,JSON.stringify(change));assert(result.blockers.some(message=>/controller|deadline|fallback|compact/iu.test(message)));
  }
});

test('legacy capability warnings stay explicit and preflight summaries never expose controller leases',async()=>{
  const old=await battlePreflight(dependencies());assert.equal(old.ready,true);assert.equal(old.session.controller,null);assert.equal(old.session.controlPolicy,null);
  assert(old.warnings.some(message=>/does not advertise enforced exclusive controller leases/u.test(message)));assert(old.warnings.some(message=>/no advertised deadline watchdog/u.test(message)));
  const opaque='d'.repeat(64);
  const result=await battlePreflight(dependencies({controller:{required:false,owner:'legacy',generation:1,claimedAt:1000,controllerLease:opaque},controlPolicy:{enabled:false,halted:false,controllerLease:opaque,pending:[{controllerLease:opaque}],recentEvents:[{controllerLease:opaque}]}}));
  assert.equal(result.ready,true);assert.equal(JSON.stringify(result).includes(opaque),false);assert.equal(result.session.controller.owner,'legacy');assert.equal(result.session.controlPolicy.enabled,false);
});
